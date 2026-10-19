import { ANONYMOUS, EVERYONE, canAccess, validateAccessList, validatePrincipalName } from "./acl.js";
import { Acl, type AclHost, type AclWrite } from "./acl-document.js";
import { DEFAULT_POLICY, isKnownPolicy } from "./conflict-policy.js";
import { Document, type DocumentHost } from "./document.js";
import { DocumentSet } from "./document-set.js";
import type { ChangeOp, DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
import { decodeContent, encodeContent } from "./field-types.js";
import { compareCreated, matchesWhere, parseFindFilter, type FindFilter } from "./find-filter.js";
import { newId } from "./ids.js";
import type { JsonObject } from "./json.js";
import {
  BATCH_FORMAT,
  DEFAULT_EXPORT_LIMIT,
  formatPeerPosition,
  isAuthorizedVersion,
  parseBatch,
  parsePeerPosition,
  peerKey,
  replicatedChange,
  selectChanges,
  validateEnvelope,
  type ApplyResult,
  type BatchHeader,
  type ChangeBatch,
  type PullResult,
} from "./replication.js";
import type { Session } from "./session.js";
import type { LiveDocumentsNarrowing, StorageAdapter } from "./storage/adapter.js";
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
import { compare, countFor, increment, type VectorClock } from "./vector-clock.js";

const INSTANCE_ID_KEY = "instanceId";
const DATABASE_ID_KEY = "databaseId";
const CONFLICT_POLICY_KEY = "conflictPolicy";

const SYSTEM_PRINCIPAL = "system";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What this session's principal may do in the database. A snapshot: it doesn't
 * change if the ACL changes later.
 */
export interface DatabaseAccess {
  readonly create: boolean;
  readonly admin: boolean;
}

interface OpenedState {
  databaseId: string;
  instanceId: string;
  unicodeVersion: string;
  conflictPolicy: string;
}

// Everything in a new envelope except what the write path fills in.
type EnvelopeBody = Omit<
  DocumentEnvelope,
  "vectorClock" | "createdAt" | "createdBy" | "updatedAt" | "updatedBy" | "updatedOn"
>;

/**
 * The one write path. Bumps this replica's clock entry, stamps who, where and
 * when, stores the document, and appends its change entry, all in one
 * transaction. createdAt and createdBy come from the previous envelope, or
 * from this write if there is none, so no caller can change them. Callers
 * check access first; "system" writes skip the checks and are only made by
 * the engine itself, never on behalf of a session.
 */
function writeDocument(
  adapter: StorageAdapter,
  instanceId: string,
  principal: string,
  timestamp: string,
  previous: DocumentEnvelope | undefined,
  body: EnvelopeBody,
  op: ChangeOp,
): DocumentEnvelope {
  return adapter.transaction(() => {
    const envelope: DocumentEnvelope = {
      ...body,
      vectorClock: increment(previous?.vectorClock ?? {}, instanceId),
      createdAt: previous?.createdAt ?? timestamp,
      createdBy: previous?.createdBy ?? principal,
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
): OpenedState {
  const databaseId = newId();
  const instanceId = newId();
  adapter.setLocal(DATABASE_ID_KEY, databaseId);
  adapter.setLocal(INSTANCE_ID_KEY, instanceId);
  adapter.setLocal(CONFLICT_POLICY_KEY, DEFAULT_POLICY);

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
  return { databaseId, instanceId, unicodeVersion, conflictPolicy: DEFAULT_POLICY };
}

/** Checks the stored conflict policy is one this engine knows. */
function checkConflictPolicy(adapter: StorageAdapter): string {
  const policy = adapter.getLocal(CONFLICT_POLICY_KEY);
  if (typeof policy !== "string") {
    throw new CromDBError("INVALID_DATABASE", "Local state has no conflict policy");
  }
  if (!isKnownPolicy(policy)) {
    throw new CromDBError("UPGRADE_REQUIRED", `The database uses conflict policy ${JSON.stringify(policy)}, which this engine does not know`);
  }
  return policy;
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
  // Local configuration, never replicated. Replicas must match to sync.
  readonly #conflictPolicy: string;
  readonly #host: DocumentHost;
  readonly #aclHost: AclHost;

  private constructor(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    state: OpenedState,
  ) {
    this.session = session;
    this.#unicodeVersion = state.unicodeVersion;
    this.#conflictPolicy = state.conflictPolicy;
    this.databaseId = state.databaseId;
    this.instanceId = state.instanceId;
    this.#adapter = adapter;
    this.#now = now;
    this.#host = {
      principal: session.principal,
      save: (id, loadedClock, content, readers, writers) => this.#save(id, loadedClock, content, readers, writers),
      delete: (id, loadedClock) => this.#delete(id, loadedClock),
      children: <C extends Record<string, unknown>>(id: string) => this.find<C>({ parentId: id }),
    };
    this.#aclHost = {
      save: (loadedClock, creators, admins) => this.#saveAcl(loadedClock, creators, admins),
    };
  }

  /** @internal Use Session.openDatabase. */
  static open(session: Session, adapter: StorageAdapter, now: () => Date, engineVersion: string): Database {
    const state = adapter.transaction(() => {
      const opened = Database.#openOrInitialize(session, adapter, now, engineVersion);
      // The session's name was checked against the engine's version; the
      // database's version may be lower.
      if (session.principal !== ANONYMOUS) {
        validatePrincipalName(session.principal, opened.unicodeVersion);
      }
      return opened;
    });
    return new Database(session, adapter, now, state);
  }

  static #openOrInitialize(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    engineVersion: string,
  ): OpenedState {
    const storedDatabaseId = adapter.getLocal(DATABASE_ID_KEY);
    const storedInstanceId = adapter.getLocal(INSTANCE_ID_KEY);

    if (storedDatabaseId !== undefined && storedInstanceId !== undefined) {
      const unicodeVersion = checkExisting(adapter, storedDatabaseId, storedInstanceId, engineVersion);
      const conflictPolicy = checkConflictPolicy(adapter);
      return { databaseId: storedDatabaseId, instanceId: storedInstanceId, unicodeVersion, conflictPolicy };
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

  /**
   * The documents this session can read that match the filter, in createdAt
   * order, then id. System documents never appear. Which documents belong is
   * decided now, in one read; see DocumentSet for what iterating sees.
   * Throws TypeError for an unknown filter key or an unsupported value.
   */
  async find<T extends Record<string, unknown>>(filter?: FindFilter): Promise<DocumentSet<T>> {
    const { parentId, topLevel, orphaned, where } = parseFindFilter(filter);
    let narrow: LiveDocumentsNarrowing | undefined;
    if (parentId !== undefined) {
      narrow = { parentId };
    } else if (topLevel === true) {
      narrow = { topLevel: true };
    }
    const ids = this.#adapter.transaction(() => {
      // Keyed by parent ID. The parent's readability doesn't matter here.
      const parentGone = new Map<string, boolean>();
      const isOrphaned = (envelope: DocumentEnvelope): boolean => {
        if (envelope.parentId === envelope.id) {
          return false;
        }
        let gone = parentGone.get(envelope.parentId);
        if (gone === undefined) {
          const parent = this.#adapter.getDocument(envelope.parentId);
          gone = parent === undefined || parent.deleted;
          parentGone.set(envelope.parentId, gone);
        }
        return gone;
      };
      return this.#adapter
        .liveDocuments(narrow)
        .filter(
          (envelope) =>
            this.#isReadableDocument(envelope) &&
            (parentId === undefined || (envelope.parentId === parentId && envelope.id !== parentId)) &&
            (topLevel === undefined || (envelope.parentId === envelope.id) === topLevel) &&
            (orphaned === undefined || isOrphaned(envelope) === orphaned) &&
            matchesWhere(envelope, where),
        )
        .sort(compareCreated)
        .map((envelope) => envelope.id);
    });
    return new DocumentSet<T>(ids, (id) => this.get<T>(id));
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

  /** Only admins can read the ACL. Others learn what they can do through myAccess. */
  async getAcl(): Promise<Acl> {
    const loaded = this.#loadAcl();
    if (!canAccess(this.session.principal, loaded.acl.admins)) {
      throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot read the ACL of this database`);
    }
    return new Acl(this.#aclHost, loaded);
  }

  /**
   * Reads the ACL fresh. For UI decisions only: every write is still checked
   * when it happens. Anonymous is never an admin.
   */
  async myAccess(): Promise<DatabaseAccess> {
    const { acl } = this.#loadAcl();
    return Object.freeze({
      create: canAccess(this.session.principal, acl.creators),
      admin: canAccess(this.session.principal, acl.admins),
    });
  }

  /**
   * Makes the empty target adapter a new replica of this database: registers
   * it here, then copies every document as it is. Open the target afterward
   * with Session.openDatabase. Admin only.
   *
   * The registration is written first, on its own. If a later step fails it
   * stays (a replica that never came up) and the target is left empty: the
   * whole copy runs in one target transaction, with this replica's
   * transaction nested inside it so this side commits first.
   */
  async createReplica(target: StorageAdapter): Promise<void> {
    this.#requireAdmin("create a replica of this database");
    if (target === this.#adapter || !target.isEmpty()) {
      throw new CromDBError("INVALID_DATABASE", "The target for a new replica must be empty");
    }
    const replicaId = newId();
    const timestamp = this.#now().toISOString();

    this.#adapter.transaction(() => {
      const { acl } = this.#requireAdmin("create a replica of this database");
      const registrationId = registrationDocId(this.databaseId, replicaId);
      const content: RegistrationContent = {
        instanceId: replicaId,
        status: "active",
        introducedBy: this.instanceId,
        introducedAt: timestamp,
      };
      writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        timestamp,
        undefined,
        {
          id: registrationId,
          parentId: registrationId,
          kind: "system",
          deleted: false,
          readers: acl.admins,
          writers: acl.admins,
          content: { ...content },
          fieldTypes: {},
        },
        "put",
      );
    });

    target.transaction(() => {
      if (!target.isEmpty()) {
        throw new CromDBError("INVALID_DATABASE", "The target for a new replica must be empty");
      }
      this.#adapter.transaction(() => {
        const documents = this.#adapter.allDocuments();
        const sourceSeq = this.#adapter.lastSeq();
        for (const envelope of documents) {
          target.putDocument(envelope);
        }
        target.setLocal(DATABASE_ID_KEY, this.databaseId);
        target.setLocal(INSTANCE_ID_KEY, replicaId);
        target.setLocal(CONFLICT_POLICY_KEY, this.#conflictPolicy);
        for (const envelope of documents) {
          target.appendChange(replicatedChange(envelope));
        }
        // Each side starts past the snapshot, so neither pulls it back.
        target.setLocal(peerKey(this.instanceId), formatPeerPosition(sourceSeq, timestamp));
        this.#adapter.setLocal(peerKey(replicaId), formatPeerPosition(target.lastSeq(), timestamp));
      });
    });
  }

  /**
   * The documents changed after position since in this replica's change log,
   * each once, as its current version. limit caps the number of documents.
   * Admin only: a batch holds every document, whoever its readers are.
   */
  async exportChanges(options: { since?: number; limit?: number } = {}): Promise<ChangeBatch> {
    const since = options.since ?? 0;
    const limit = options.limit ?? DEFAULT_EXPORT_LIMIT;
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new TypeError(`since must be a non-negative integer, got ${String(since)}`);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError(`limit must be a positive integer, got ${String(limit)}`);
    }
    return this.#adapter.transaction(() => {
      this.#requireAdmin("export changes");
      const { docIds, toSeq, hasMore } = selectChanges(this.#adapter.changesSince(since), since, limit);
      const documents = docIds.map((id) => {
        const envelope = this.#adapter.getDocument(id);
        if (envelope === undefined) {
          throw new CromDBError("INVALID_DATABASE", `The change log names document ${JSON.stringify(id)}, which is not stored`);
        }
        return envelope;
      });
      return {
        format: BATCH_FORMAT,
        databaseId: this.databaseId,
        sourceInstanceId: this.instanceId,
        conflictPolicy: this.#conflictPolicy,
        unicodeVersion: this.#unicodeVersion,
        since,
        toSeq,
        hasMore,
        sourceLastSeq: this.#adapter.lastSeq(),
        documents,
      };
    });
  }

  /**
   * Applies a batch exported by another replica of this database, all or
   * nothing. Versions newer than ours replace ours unchanged; equal and older
   * ones are skipped. Admin only.
   */
  async applyChanges(batch: unknown): Promise<ApplyResult> {
    return this.#adapter.transaction(() => {
      this.#requireAdmin("apply changes");
      const { header, documents } = parseBatch(batch);
      this.#checkBatchHeader(header);
      const positionKey = peerKey(header.sourceInstanceId);
      const position = parsePeerPosition(this.#adapter.getLocal(positionKey), header.sourceInstanceId);
      if (position > header.sourceLastSeq) {
        throw new CromDBError(
          "REWIND_DETECTED",
          `The change log of replica ${JSON.stringify(header.sourceInstanceId)} is behind what this replica already pulled from it (ours ${position}, theirs ${header.sourceLastSeq}); it was likely restored or copied from an old file, and a full resync is needed`,
        );
      }
      if (header.since !== position) {
        throw new CromDBError(
          "SYNC_MISMATCH",
          `The batch starts after position ${header.since}, but this replica has applied replica ${JSON.stringify(header.sourceInstanceId)} up to ${position}`,
        );
      }

      const context = { databaseId: this.databaseId, unicodeVersion: this.#unicodeVersion };
      const envelopes = documents.map((document) => validateEnvelope(document, context));
      const ids = new Set<string>();
      for (const envelope of envelopes) {
        if (ids.has(envelope.id)) {
          throw new CromDBError("INVALID_BATCH", `The batch has document ${JSON.stringify(envelope.id)} more than once`);
        }
        ids.add(envelope.id);
      }

      let applied = 0;
      let skipped = 0;
      const ordered = [
        ...envelopes.filter((envelope) => envelope.kind === "system"),
        ...envelopes.filter((envelope) => envelope.kind === "document"),
      ];
      for (const incoming of ordered) {
        if (this.#applyDocument(incoming)) {
          applied++;
        } else {
          skipped++;
        }
      }
      this.#adapter.setLocal(positionKey, formatPeerPosition(header.toSeq, this.#now().toISOString()));
      return { applied, skipped, toSeq: header.toSeq, hasMore: header.hasMore };
    });
  }

  /** Pulls batches from source until it has no more. Both sessions must be admins. */
  async pullFrom(source: Database): Promise<PullResult> {
    let applied = 0;
    let skipped = 0;
    let batches = 0;
    for (;;) {
      const since = this.#adapter.transaction(() =>
        parsePeerPosition(this.#adapter.getLocal(peerKey(source.instanceId)), source.instanceId),
      );
      const result = await this.applyChanges(await source.exportChanges({ since }));
      batches++;
      applied += result.applied;
      skipped += result.skipped;
      if (!result.hasMore) {
        return { applied, skipped, batches };
      }
    }
  }

  /** The ACL, if this session is an admin. Throws ACCESS_DENIED otherwise. */
  #requireAdmin(action: string): AclWrite {
    const loaded = this.#loadAcl();
    if (!canAccess(this.session.principal, loaded.acl.admins)) {
      throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot ${action}; only admins can`);
    }
    return loaded;
  }

  /** Checks a batch fits this replica and comes from a replica it knows. */
  #checkBatchHeader(header: BatchHeader): void {
    const mismatch = (what: string, theirs: string, ours: string): CromDBError =>
      new CromDBError("SYNC_MISMATCH", `The batch has ${what} ${JSON.stringify(theirs)}, but this replica has ${JSON.stringify(ours)}`);
    if (header.databaseId !== this.databaseId) {
      throw mismatch("database ID", header.databaseId, this.databaseId);
    }
    if (header.conflictPolicy !== this.#conflictPolicy) {
      throw mismatch("conflict policy", header.conflictPolicy, this.#conflictPolicy);
    }
    if (header.unicodeVersion !== this.#unicodeVersion) {
      throw mismatch("Unicode version", header.unicodeVersion, this.#unicodeVersion);
    }
    const source = header.sourceInstanceId;
    if (source === this.instanceId) {
      throw new CromDBError("SYNC_MISMATCH", `The batch comes from this replica (${JSON.stringify(source)})`);
    }
    // A batch can't vouch for its own sender: the registration must already
    // be here, from a replica this one knows.
    const registration = this.#adapter.getDocument(registrationDocId(this.databaseId, source));
    const content = registration?.content;
    if (
      registration === undefined ||
      registration.kind !== "system" ||
      registration.deleted ||
      content === undefined ||
      !Object.hasOwn(content, "instanceId") ||
      content["instanceId"] !== source
    ) {
      throw new CromDBError("SYNC_MISMATCH", `The batch comes from replica ${JSON.stringify(source)}, which this replica does not know`);
    }
    if (!Object.hasOwn(content, "status") || content["status"] !== "active") {
      throw new CromDBError("SYNC_MISMATCH", `The batch comes from replica ${JSON.stringify(source)}, which is not active`);
    }
  }

  /** Inserts or replaces one validated incoming version. Returns false if skipped. */
  #applyDocument(incoming: DocumentEnvelope): boolean {
    const what = `Document ${JSON.stringify(incoming.id)}`;
    const stored = this.#adapter.getDocument(incoming.id);
    if (stored !== undefined && stored.kind !== incoming.kind) {
      throw new CromDBError("INVALID_BATCH", `${what} arrives as kind ${JSON.stringify(incoming.kind)} but is stored as ${JSON.stringify(stored.kind)}`);
    }
    if (incoming.parentId !== incoming.id && this.#adapter.getDocument(incoming.parentId)?.kind === "system") {
      throw new CromDBError("INVALID_BATCH", `${what} has a system document as its parent`);
    }

    const theirs = countFor(incoming.vectorClock, this.instanceId);
    const ours = countFor(stored?.vectorClock ?? {}, this.instanceId);
    if (theirs > ours) {
      throw new CromDBError(
        "REWIND_DETECTED",
        `${what} arrives with this replica's counter at ${theirs}, but this replica has only reached ${ours}; a copied or restored file may be in use`,
      );
    }

    if (stored !== undefined) {
      const order = compare(incoming.vectorClock, stored.vectorClock);
      if (order === "equal" || order === "before") {
        return false;
      }
      if (order === "concurrent") {
        throw new CromDBError("NOT_SUPPORTED", `${what} was edited on both replicas; replicating conflicts is not supported yet`);
      }
    }
    if (!isAuthorizedVersion(incoming)) {
      throw new CromDBError(
        "NOT_SUPPORTED",
        `${what} was written by ${JSON.stringify(incoming.updatedBy)}, who is not in its writers; unauthorized versions are not supported yet`,
      );
    }
    this.#adapter.putDocument(incoming);
    this.#adapter.appendChange(replicatedChange(incoming));
    return true;
  }

  /** The stored ACL document and its lists. Throws INVALID_DATABASE if missing or malformed. */
  #loadAcl(): AclWrite {
    const envelope = this.#adapter.getDocument(aclDocId(this.databaseId));
    const acl = readAclDoc(envelope);
    return { envelope: envelope as DocumentEnvelope, acl };
  }

  /**
   * Checked against the stored admins, not the new ones, so nobody can add
   * themselves in the write being checked. The admin must also be in the new
   * admins, so every save leaves at least one admin who can sign in. Written
   * as the admin, with the ACL document's readers and writers set to the new
   * admins.
   */
  #saveAcl(loadedClock: VectorClock, creators: unknown, admins: unknown): AclWrite {
    return this.#adapter.transaction(() => {
      const stored = this.#loadAcl();
      if (compare(stored.envelope.vectorClock, loadedClock) !== "equal") {
        throw new CromDBError("STALE_DOCUMENT", "The database ACL was saved since it was loaded");
      }
      if (!canAccess(this.session.principal, stored.acl.admins)) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot edit the ACL of this database`);
      }
      const validCreators = validateAccessList(creators, "creators", this.#unicodeVersion);
      const validAdmins = validateAccessList(admins, "admins", this.#unicodeVersion);
      if (!canAccess(this.session.principal, validAdmins)) {
        throw new CromDBError(
          "ACCESS_DENIED",
          `${JSON.stringify(this.session.principal)} cannot remove themselves from admins; another admin must do it`,
        );
      }
      const envelope = writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        this.#now().toISOString(),
        stored.envelope,
        {
          id: stored.envelope.id,
          parentId: stored.envelope.parentId,
          kind: "system",
          deleted: false,
          readers: validAdmins,
          writers: validAdmins,
          content: { creators: [...validCreators], admins: [...validAdmins] },
          fieldTypes: {},
        },
        "put",
      );
      return { envelope, acl: { creators: validCreators, admins: validAdmins } };
    });
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
        stored,
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
        stored,
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
