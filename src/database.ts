import { ANONYMOUS, EVERYONE, canAccess, validateAccessList, validatePrincipalName } from "./acl.js";
import { Document, type DocumentHost } from "./document.js";
import type { ChangeOp, DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
import { decodeContent, encodeContent } from "./field-types.js";
import { newId } from "./ids.js";
import type { JsonObject } from "./json.js";
import type { Session } from "./session.js";
import type { StorageAdapter } from "./storage/adapter.js";
import {
  aclDocId,
  databaseDocId,
  readAclDoc,
  registrationDocId,
  type AclDocContent,
  type DatabaseDocContent,
  type RegistrationContent,
} from "./system-docs.js";
import { compareUnicodeVersions, isUnicodeVersion } from "./unicode/version.js";
import { compare, increment, type VectorClock } from "./vector-clock.js";

const INSTANCE_ID_KEY = "instanceId";
const DATABASE_ID_KEY = "databaseId";

const SYSTEM_PRINCIPAL = "system";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Everything in a new envelope except what the write path fills in.
type EnvelopeBody = Omit<DocumentEnvelope, "vectorClock" | "updatedAt" | "updatedBy" | "updatedOn">;

/**
 * The one write path. Bumps this replica's clock entry, stamps who, where and
 * when, stores the document, and appends its change entry, all in one
 * transaction. Callers check access first; "system" writes skip the checks
 * and are only made by the engine itself, never on behalf of a session.
 */
function writeDocument(
  adapter: StorageAdapter,
  instanceId: string,
  principal: string,
  timestamp: string,
  previousClock: VectorClock | undefined,
  body: EnvelopeBody,
  op: ChangeOp,
): DocumentEnvelope {
  return adapter.transaction(() => {
    const envelope: DocumentEnvelope = {
      ...body,
      vectorClock: increment(previousClock ?? {}, instanceId),
      updatedAt: timestamp,
      updatedBy: principal,
      updatedOn: instanceId,
    };
    adapter.putDocument(envelope);
    adapter.appendChange({
      docId: envelope.id,
      vectorClock: envelope.vectorClock,
      op,
      instanceId,
      updatedBy: principal,
      timestamp,
      suspect: false,
      suspectReason: null,
    });
    return envelope;
  });
}

function initialize(
  adapter: StorageAdapter,
  principal: string,
  timestamp: string,
  unicodeVersion: string,
): { databaseId: string; instanceId: string; unicodeVersion: string } {
  const databaseId = newId();
  const instanceId = newId();
  adapter.setLocal(DATABASE_ID_KEY, databaseId);
  adapter.setLocal(INSTANCE_ID_KEY, instanceId);

  const databaseContent: DatabaseDocContent = { databaseId, createdAt: timestamp, createdOn: instanceId, unicodeVersion };
  const aclContent: AclDocContent = { creators: [principal], admins: [principal] };
  const registrationContent: RegistrationContent = {
    instanceId,
    status: "active",
    introducedBy: null,
    introducedAt: timestamp,
  };

  const systemDocs: [string, JsonObject][] = [
    [databaseDocId(databaseId), { ...databaseContent }],
    [aclDocId(databaseId), { creators: [...aclContent.creators], admins: [...aclContent.admins] }],
    [registrationDocId(databaseId, instanceId), { ...registrationContent }],
  ];
  for (const [id, content] of systemDocs) {
    writeDocument(
      adapter,
      instanceId,
      SYSTEM_PRINCIPAL,
      timestamp,
      undefined,
      {
        id,
        parentId: id,
        kind: "system",
        deleted: false,
        readers: [principal],
        writers: [principal],
        content,
        fieldTypes: {},
      },
      "put",
    );
  }
  return { databaseId, instanceId, unicodeVersion };
}

/** Checks an existing database can be opened by this engine and returns its Unicode version. */
function checkExisting(adapter: StorageAdapter, databaseId: string, instanceId: string, engineVersion: string): string {
  if (!UUID_PATTERN.test(databaseId) || !UUID_PATTERN.test(instanceId)) {
    throw new CromDBError("INVALID_DATABASE", "The stored database ID or instance ID is not a UUID");
  }
  const databaseDoc = adapter.getDocument(databaseDocId(databaseId));
  const content = databaseDoc?.content;
  if (
    databaseDoc === undefined ||
    databaseDoc.kind !== "system" ||
    content === undefined ||
    !Object.hasOwn(content, "databaseId") ||
    content["databaseId"] !== databaseId
  ) {
    throw new CromDBError("INVALID_DATABASE", "The database document is missing or does not match the stored database ID");
  }
  const unicodeVersion = Object.hasOwn(content, "unicodeVersion") ? content["unicodeVersion"] : undefined;
  if (!isUnicodeVersion(unicodeVersion)) {
    throw new CromDBError("INVALID_DATABASE", "The database document has no valid unicodeVersion");
  }
  if (compareUnicodeVersions(unicodeVersion, engineVersion) > 0) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `The database needs Unicode ${unicodeVersion}, but this engine supports Unicode ${engineVersion}`,
    );
  }
  return unicodeVersion;
}

/** Opened through Session.openDatabase. */
export class Database {
  readonly databaseId: string;
  readonly instanceId: string;
  readonly session: Session;

  readonly #adapter: StorageAdapter;
  readonly #now: () => Date;
  // Names in this database are checked against this version, not the engine's.
  readonly #unicodeVersion: string;
  readonly #host: DocumentHost;

  private constructor(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    databaseId: string,
    instanceId: string,
    unicodeVersion: string,
  ) {
    this.session = session;
    this.#unicodeVersion = unicodeVersion;
    this.databaseId = databaseId;
    this.instanceId = instanceId;
    this.#adapter = adapter;
    this.#now = now;
    this.#host = {
      save: (id, loadedClock, content, readers, writers) => this.#save(id, loadedClock, content, readers, writers),
      delete: (id, loadedClock) => this.#delete(id, loadedClock),
    };
  }

  /** @internal Use Session.openDatabase. */
  static open(session: Session, adapter: StorageAdapter, now: () => Date, engineVersion: string): Database {
    const { databaseId, instanceId, unicodeVersion } = adapter.transaction(() => {
      const opened = Database.#openOrInitialize(session, adapter, now, engineVersion);
      // The session's name was checked against the engine's version; the
      // database's version may be lower.
      if (session.principal !== ANONYMOUS) {
        validatePrincipalName(session.principal, opened.unicodeVersion);
      }
      return opened;
    });
    return new Database(session, adapter, now, databaseId, instanceId, unicodeVersion);
  }

  static #openOrInitialize(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    engineVersion: string,
  ): { databaseId: string; instanceId: string; unicodeVersion: string } {
    const storedDatabaseId = adapter.getLocal(DATABASE_ID_KEY);
    const storedInstanceId = adapter.getLocal(INSTANCE_ID_KEY);

    if (storedDatabaseId !== undefined && storedInstanceId !== undefined) {
      const unicodeVersion = checkExisting(adapter, storedDatabaseId, storedInstanceId, engineVersion);
      return { databaseId: storedDatabaseId, instanceId: storedInstanceId, unicodeVersion };
    }
    if (storedDatabaseId !== undefined || storedInstanceId !== undefined) {
      throw new CromDBError("INVALID_DATABASE", "Local state has only one of the database ID and instance ID");
    }
    if (session.principal === ANONYMOUS) {
      throw new CromDBError("ACCESS_DENIED", "An anonymous session cannot create a database");
    }
    return initialize(adapter, session.principal, now().toISOString(), engineVersion);
  }

  async get<T extends Record<string, unknown>>(id: string): Promise<Document<T> | undefined> {
    const envelope = this.#adapter.getDocument(id);
    if (!this.#isReadableDocument(envelope)) {
      return undefined;
    }
    return new Document<T>(this.#host, envelope, decodeContent(envelope.content, envelope.fieldTypes) as T);
  }

  async create<T extends Record<string, unknown>>(
    content: T,
    options: { readers?: string[]; writers?: string[]; parentId?: string } = {},
  ): Promise<Document<T>> {
    const principal = this.session.principal;
    const envelope = this.#adapter.transaction(() => {
      const acl = readAclDoc(this.#adapter.getDocument(aclDocId(this.databaseId)));
      if (!canAccess(principal, acl.creators)) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(principal)} cannot create documents in this database`);
      }

      const readers = validateAccessList(options.readers ?? [EVERYONE], "readers", this.#unicodeVersion);
      const writers = validateAccessList(options.writers ?? [EVERYONE], "writers", this.#unicodeVersion);

      const id = newId();
      let parentId = id;
      if (options.parentId !== undefined) {
        const parent = this.#adapter.getDocument(options.parentId);
        if (!this.#isReadableDocument(parent)) {
          throw new CromDBError("NOT_FOUND", `Parent document ${JSON.stringify(options.parentId)} not found`);
        }
        parentId = parent.id;
      }

      const encoded = encodeContent(content);
      return writeDocument(
        this.#adapter,
        this.instanceId,
        principal,
        this.#now().toISOString(),
        undefined,
        {
          id,
          parentId,
          kind: "document",
          deleted: false,
          readers,
          writers,
          content: encoded.content,
          fieldTypes: encoded.fieldTypes,
        },
        "put",
      );
    });
    return new Document<T>(this.#host, envelope, decodeContent(envelope.content, envelope.fieldTypes) as T);
  }

  #isReadableDocument(envelope: DocumentEnvelope | undefined): envelope is DocumentEnvelope {
    return (
      envelope !== undefined &&
      envelope.kind === "document" &&
      !envelope.deleted &&
      canAccess(this.session.principal, envelope.readers)
    );
  }

  /** Steps shared by save and delete: the stored document, unchanged since load, writable by this principal. */
  #loadForWrite(id: string, loadedClock: VectorClock): DocumentEnvelope {
    const stored = this.#adapter.getDocument(id);
    if (stored === undefined || stored.kind !== "document" || stored.deleted) {
      throw new CromDBError("NOT_FOUND", `Document ${JSON.stringify(id)} not found`);
    }
    if (compare(stored.vectorClock, loadedClock) !== "equal") {
      throw new CromDBError("STALE_DOCUMENT", `Document ${JSON.stringify(id)} was saved since it was loaded`);
    }
    // The stored writers, not the new ones, so nobody can add themselves in
    // the write being checked.
    if (!canAccess(this.session.principal, stored.writers)) {
      throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot write document ${JSON.stringify(id)}`);
    }
    return stored;
  }

  #save(
    id: string,
    loadedClock: VectorClock,
    content: Record<string, unknown>,
    readers: unknown,
    writers: unknown,
  ): DocumentEnvelope {
    return this.#adapter.transaction(() => {
      const stored = this.#loadForWrite(id, loadedClock);
      const validReaders = validateAccessList(readers, "readers", this.#unicodeVersion);
      const validWriters = validateAccessList(writers, "writers", this.#unicodeVersion);
      const encoded = encodeContent(content);
      return writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        this.#now().toISOString(),
        stored.vectorClock,
        {
          id: stored.id,
          parentId: stored.parentId,
          kind: "document",
          deleted: false,
          readers: validReaders,
          writers: validWriters,
          content: encoded.content,
          fieldTypes: encoded.fieldTypes,
        },
        "put",
      );
    });
  }

  #delete(id: string, loadedClock: VectorClock): DocumentEnvelope {
    return this.#adapter.transaction(() => {
      const stored = this.#loadForWrite(id, loadedClock);
      const timestamp = this.#now().toISOString();
      return writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        timestamp,
        stored.vectorClock,
        {
          id: stored.id,
          parentId: stored.parentId,
          kind: "document",
          deleted: true,
          deletedAt: timestamp,
          readers: stored.readers,
          writers: stored.writers,
          content: {},
          fieldTypes: {},
        },
        "delete",
      );
    });
  }
}
