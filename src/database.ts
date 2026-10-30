import { ANONYMOUS, EVERYONE, canAccess, isAuthorizedVersion, validateAccessList, validatePrincipalName } from "./acl.js";
import { Acl, type AclHost, type AclWrite } from "./acl-document.js";
import { arrange, conflictRowId, latestCount, writerClock, writerKeyIndex } from "./conflict.js";
import { Conflict, type ConflictHost, type ConflictRow, type Resolution } from "./conflict-object.js";
import { DEFAULT_POLICY, compareRank, isKnownPolicy, policyNamed, type ConflictPolicy } from "./conflict-policy.js";
import { Document, type DocumentHost, type WriteResult } from "./document.js";
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
import { compare, countFor, increment, merge, type VectorClock } from "./vector-clock.js";

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
 * The one write path. Takes the new clock (the previous envelope's, with this
 * replica's instance ID incremented, unless given), stamps who, where and
 * when, stores the document, and appends its change entry, all in one
 * transaction. createdAt
 * and createdBy come from the previous envelope, or from this write if there
 * is none, so no caller can change them. Callers check access first; "system"
 * writes skip the checks and are only made by the engine itself, never on
 * behalf of a session.
 */
function writeDocument(
  adapter: StorageAdapter,
  instanceId: string,
  principal: string,
  timestamp: string,
  previous: DocumentEnvelope | undefined,
  body: EnvelopeBody,
  op: ChangeOp,
  vectorClock: VectorClock = increment(previous?.vectorClock ?? {}, instanceId),
): DocumentEnvelope {
  return adapter.transaction(() => {
    const envelope: DocumentEnvelope = {
      ...body,
      vectorClock,
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

/**
 * Opened through Session.openDatabase. Several Database objects can share one
 * adapter, one per user: each reads the stored state on every call, so it
 * sees the others' writes, ACL changes and synced changes at once, and checks
 * its own session's access.
 */
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
  readonly #policy: ConflictPolicy;
  readonly #host: DocumentHost;
  readonly #aclHost: AclHost;
  readonly #conflictHost: ConflictHost;

  private constructor(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    state: OpenedState,
  ) {
    this.session = session;
    this.#unicodeVersion = state.unicodeVersion;
    this.#conflictPolicy = state.conflictPolicy;
    this.#policy = policyNamed(state.conflictPolicy);
    this.databaseId = state.databaseId;
    this.instanceId = state.instanceId;
    this.#adapter = adapter;
    this.#now = now;
    this.#host = {
      principal: session.principal,
      save: (id, loadedClock, content, readers, writers) => this.#save(id, loadedClock, content, readers, writers),
      delete: (id, loadedClock) => this.#delete(id, loadedClock),
      children: <C extends Record<string, unknown>>(id: string) => this.find<C>({ parentId: id }),
      conflict: <C extends Record<string, unknown>>(primaryId: string, ifVersion: string | undefined) => this.#conflict<C>(primaryId, ifVersion),
    };
    this.#aclHost = {
      save: (loadedClock, creators, admins) => this.#saveAcl(loadedClock, creators, admins),
    };
    this.#conflictHost = {
      resolve: (primaryId, rows, included, resolution) => this.#resolve(primaryId, rows, included, resolution),
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

  /**
   * With the ID of a conflict version, returns that version, read-only. A
   * deleted document is returned only while it is in conflict, read-only
   * and with deleted true, so the conflict can still be resolved.
   *
   * With ifVersion, a Document.version from earlier: throws STALE_DOCUMENT if
   * the document is now at another version. For a caller that keeps only the
   * version between requests, as with an HTTP If-Match header: the Document
   * returned is at that version, so its save and delete then refuse with
   * STALE_DOCUMENT if it changes before they run. A document this session
   * can't get is still undefined.
   */
  async get<T extends Record<string, unknown>>(id: string, options: { ifVersion?: string } = {}): Promise<Document<T> | undefined> {
    const ifVersion = options.ifVersion;
    if (ifVersion !== undefined && typeof ifVersion !== "string") {
      throw new TypeError(`ifVersion must be a string, got ${typeof ifVersion}`);
    }
    const envelope = this.#adapter.getDocument(id);
    let doc: Document<T> | undefined;
    if (this.#isReadableDocument(envelope)) {
      doc = this.#toDocument<T>(envelope, envelope.conflictOf !== undefined);
    } else if (this.#isDeletedInConflict(envelope)) {
      doc = this.#toDocument<T>(envelope, true);
    }
    if (doc !== undefined && ifVersion !== undefined && doc.version !== ifVersion) {
      throw new CromDBError("STALE_DOCUMENT", `Document ${JSON.stringify(id)} is not at the version given`);
    }
    return doc;
  }

  /**
   * The documents this session can read that match the filter, in createdAt
   * order, then id. System documents and conflict versions never appear, and
   * deleted documents appear only with inConflict true, while in conflict.
   * Which documents belong is decided now, in one read; see DocumentSet for
   * what iterating sees.
   * Throws TypeError for an unknown filter key or an unsupported value.
   */
  async find<T extends Record<string, unknown>>(filter?: FindFilter): Promise<DocumentSet<T>> {
    const { parentId, topLevel, orphaned, inConflict, where } = parseFindFilter(filter);
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
      const candidates = inConflict === true ? this.#adapter.primaryDocuments(narrow) : this.#adapter.liveDocuments(narrow);
      return candidates
        .filter(
          (envelope) =>
            (this.#isReadableDocument(envelope) || this.#isDeletedInConflict(envelope)) &&
            (parentId === undefined || (envelope.parentId === parentId && envelope.id !== parentId)) &&
            (topLevel === undefined || (envelope.parentId === envelope.id) === topLevel) &&
            (orphaned === undefined || isOrphaned(envelope) === orphaned) &&
            matchesWhere(envelope, where) &&
            (inConflict === undefined || this.#isInConflict(envelope) === inConflict),
        )
        .sort(compareCreated)
        .map((envelope) => envelope.id);
    });
    // A document deleted since, but still in conflict, is yielded only to an
    // inConflict: true set, which may hold deleted documents.
    return new DocumentSet<T>(ids, async (id) => {
      const doc = await this.get<T>(id);
      return doc?.deleted === true && inConflict !== true ? undefined : doc;
    });
  }

  /**
   * The creator is always one of the writers: if writers doesn't admit them,
   * they are added to it. readers is kept as given, so a creator can write a
   * document they can't read back.
   */
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
      let writers = validateAccessList(options.writers ?? [EVERYONE], "writers", this.#unicodeVersion);
      // A version whose writer isn't in its own writers is unauthorized on
      // every other replica.
      if (!canAccess(principal, writers)) {
        writers = [...writers, principal];
      }

      const id = newId();
      let parentId = id;
      if (options.parentId !== undefined) {
        const parent = this.#adapter.getDocument(options.parentId);
        if (!this.#isReadableDocument(parent) || parent.conflictOf !== undefined) {
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
    return this.#toDocument<T>(envelope, false);
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
      // A conflict row no longer needed is removed; whatever replaced it has
      // its own change entry.
      const documents = docIds.flatMap((id) => {
        const envelope = this.#adapter.getDocument(id);
        return envelope === undefined ? [] : [envelope];
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
   * nothing. Each document version joins the versions of its document stored
   * here, which are then arranged again: versions superseded by another are
   * dropped, and concurrent ones are kept as conflict versions. A version
   * dropped on arrival is skipped. Concurrent versions of a system document
   * are not supported yet. Admin only.
   *
   * The batch must come from a replica this one knows about, or it is
   * refused with SYNC_MISMATCH. A new replica can always sync with the one it
   * was copied from, and with the others once they have learned of it
   * through sync.
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
        ...envelopes.filter((envelope) => envelope.kind === "document" && envelope.conflictOf === undefined),
        ...envelopes.filter((envelope) => envelope.conflictOf !== undefined),
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

  /**
   * How far this replica has applied the change log of replica
   * sourceInstanceId: the since to pass to its exportChanges, or 0 if nothing
   * has been pulled from it yet. Admin only.
   */
  async syncPosition(sourceInstanceId: string): Promise<number> {
    if (typeof sourceInstanceId !== "string") {
      throw new TypeError(`sourceInstanceId must be a string, got ${typeof sourceInstanceId}`);
    }
    return this.#adapter.transaction(() => {
      this.#requireAdmin("read the sync position");
      return parsePeerPosition(this.#adapter.getLocal(peerKey(sourceInstanceId)), sourceInstanceId);
    });
  }

  /** Pulls batches from source until it has no more. Both sessions must be admins. */
  async pullFrom(source: Database): Promise<PullResult> {
    let applied = 0;
    let skipped = 0;
    let batches = 0;
    for (;;) {
      const since = await this.syncPosition(source.instanceId);
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

  /** Adds one validated incoming version. Returns false if skipped. */
  #applyDocument(incoming: DocumentEnvelope): boolean {
    const what = `Document ${JSON.stringify(incoming.id)}`;
    const primaryId = incoming.conflictOf ?? incoming.id;
    const stored = this.#adapter.getDocument(primaryId);
    if (stored !== undefined && stored.kind !== incoming.kind) {
      throw new CromDBError("INVALID_BATCH", `${what} arrives as kind ${JSON.stringify(incoming.kind)} but is stored as ${JSON.stringify(stored.kind)}`);
    }
    if (stored?.conflictOf !== undefined) {
      throw new CromDBError("INVALID_BATCH", `${what} arrives as a version of ${JSON.stringify(primaryId)}, which is a conflict document here`);
    }
    if (incoming.conflictOf === undefined && incoming.parentId !== incoming.id) {
      const parent = this.#adapter.getDocument(incoming.parentId);
      if (parent?.kind === "system") {
        throw new CromDBError("INVALID_BATCH", `${what} has a system document as its parent`);
      }
      if (parent?.conflictOf !== undefined) {
        throw new CromDBError("INVALID_BATCH", `${what} has a conflict document as its parent`);
      }
    }
    if (incoming.kind === "system") {
      return this.#applySystemDocument(incoming, stored, what);
    }

    if (stored === undefined) {
      // A replica writes a conflict row only after it holds the primary row,
      // whose change entry comes first, so the primary always arrives first.
      if (incoming.conflictOf !== undefined) {
        throw new CromDBError("INVALID_BATCH", `${what} is a conflict version of ${JSON.stringify(primaryId)}, which this replica doesn't have`);
      }
    } else if (
      (incoming.conflictOf === undefined && incoming.parentId !== stored.parentId) ||
      incoming.createdAt !== stored.createdAt ||
      incoming.createdBy !== stored.createdBy
    ) {
      throw new CromDBError(
        "INVALID_BATCH",
        `${what} is a version of ${JSON.stringify(primaryId)} with a different parentId, createdAt or createdBy than the stored one`,
      );
    }
    const versions = stored === undefined ? [] : [stored, ...this.#adapter.conflictRows(primaryId)];
    this.#checkRewind(what, incoming, versions);
    return this.#arrange(primaryId, stored?.parentId ?? incoming.parentId, incoming);
  }

  /** System documents have one version: a concurrent one is not supported yet. */
  #applySystemDocument(incoming: DocumentEnvelope, stored: DocumentEnvelope | undefined, what: string): boolean {
    this.#checkRewind(what, incoming, stored === undefined ? [] : [stored]);
    if (stored !== undefined) {
      const order = compare(incoming.vectorClock, stored.vectorClock);
      if (order === "equal" || order === "before") {
        return false;
      }
      if (order === "concurrent") {
        throw new CromDBError("NOT_SUPPORTED", `System ${what.toLowerCase()} was edited on both replicas; concurrent system document versions are not supported yet`);
      }
    }
    if (!isAuthorizedVersion(incoming)) {
      throw new CromDBError(
        "NOT_SUPPORTED",
        `System ${what.toLowerCase()} was written by ${JSON.stringify(incoming.updatedBy)}, who is not in its writers; unauthorized system document versions are not supported yet`,
      );
    }
    this.#putRow(incoming);
    return true;
  }

  /**
   * For each of this replica's writer keys in the incoming clock, the count
   * can't be beyond any version of the document stored here.
   */
  #checkRewind(what: string, incoming: DocumentEnvelope, stored: readonly DocumentEnvelope[]): void {
    const clocks = stored.map((version) => version.vectorClock);
    for (const key of Object.keys(incoming.vectorClock)) {
      if (writerKeyIndex(this.instanceId, key) === undefined) {
        continue;
      }
      const theirs = countFor(incoming.vectorClock, key);
      const ours = latestCount(key, clocks);
      if (theirs > ours) {
        throw new CromDBError(
          "REWIND_DETECTED",
          `${what} arrives with this replica's counter ${JSON.stringify(key)} at ${theirs}, but this replica has only reached ${ours}; a copied or restored file may be in use`,
        );
      }
    }
  }

  /** The clocks of every stored version of the document. */
  #storedClocks(primaryId: string): VectorClock[] {
    const primary = this.#adapter.getDocument(primaryId);
    const rows = this.#adapter.conflictRows(primaryId);
    return (primary === undefined ? rows : [primary, ...rows]).map((version) => version.vectorClock);
  }

  /** Stores the row and its change entry, built from the row's own clock and writer. */
  #putRow(row: DocumentEnvelope): void {
    this.#adapter.putDocument(row);
    this.#adapter.appendChange(replicatedChange(row));
  }

  /**
   * Arranges the stored versions of document primaryId, with incoming if
   * given, and writes the rows to match: the primary row (parentId is the
   * document's own), a conflict row for each other version, and removes
   * conflict rows no longer needed. Never bumps a clock. Returns whether
   * anything changed.
   */
  #arrange(primaryId: string, parentId: string, incoming?: DocumentEnvelope): boolean {
    const storedPrimary = this.#adapter.getDocument(primaryId);
    const storedRows = this.#adapter.conflictRows(primaryId);
    const stored = storedPrimary === undefined ? storedRows : [storedPrimary, ...storedRows];
    const { primary, others } = arrange(incoming === undefined ? stored : [...stored, incoming], this.#policy);

    let changed = false;
    if (storedPrimary === undefined || compare(storedPrimary.vectorClock, primary.vectorClock) !== "equal") {
      const { conflictOf: _conflictOf, ...version } = primary;
      this.#putRow({ ...version, id: primaryId, parentId });
      changed = true;
    }
    const kept = new Set<string>();
    for (const other of others) {
      const rowId = conflictRowId(primaryId, other.vectorClock);
      kept.add(rowId);
      if (!storedRows.some((row) => row.id === rowId)) {
        this.#putRow({ ...other, id: rowId, parentId: primaryId, conflictOf: primaryId });
        changed = true;
      }
    }
    for (const row of storedRows) {
      if (!kept.has(row.id)) {
        this.#adapter.removeDocument(row.id);
        changed = true;
      }
    }
    return changed;
  }

  #isInConflict(primary: DocumentEnvelope): boolean {
    return this.#adapter.conflictRows(primary.id).length > 0 || !isAuthorizedVersion(primary);
  }

  #toDocument<T extends Record<string, unknown>>(envelope: DocumentEnvelope, readOnly: boolean): Document<T> {
    return new Document<T>(this.#host, envelope, decodeContent(envelope.content, envelope.fieldTypes) as T, readOnly);
  }

  #conflict<T extends Record<string, unknown>>(primaryId: string, ifVersion: string | undefined): Conflict<T> | undefined {
    const conflict = this.#adapter.transaction(() => {
      const primary = this.#adapter.getDocument(primaryId);
      if (primary === undefined || primary.kind !== "document" || primary.conflictOf !== undefined) {
        return undefined;
      }
      const rows = this.#adapter.conflictRows(primaryId).sort((a, b) => compareRank(this.#policy, a, b));
      if (rows.length === 0 && isAuthorizedVersion(primary)) {
        return undefined;
      }
      const all = [primary, ...rows];
      const versions = all
        .filter((version) => canAccess(this.session.principal, version.readers))
        .map((version) => ({
          rowId: version.id,
          version: {
            document: this.#toDocument<T>(version, true),
            isPrimary: version === primary,
            authorized: isAuthorizedVersion(version),
            deleted: version.deleted,
          },
        }));
      return new Conflict<T>(this.#conflictHost, primaryId, all.map(({ id, vectorClock }) => ({ id, vectorClock })), versions);
    });
    if (ifVersion !== undefined && conflict?.version !== ifVersion) {
      throw new CromDBError("STALE_DOCUMENT", `Document ${JSON.stringify(primaryId)} has had a version added, removed or changed since that conflict was loaded`);
    }
    return conflict;
  }

  /**
   * One new version of the primary row, ahead of every included version, so
   * arranging removes them. Versions not included stay as conflict rows.
   */
  #resolve(primaryId: string, rows: readonly ConflictRow[], included: readonly string[], resolution: Resolution): WriteResult {
    return this.#adapter.transaction(() => {
      const what = `Document ${JSON.stringify(primaryId)}`;
      const primary = this.#adapter.getDocument(primaryId);
      const current = primary === undefined ? [] : [primary, ...this.#adapter.conflictRows(primaryId)];
      const unchanged =
        current.length === rows.length &&
        current.every((row) => rows.some((loaded) => loaded.id === row.id && compare(loaded.vectorClock, row.vectorClock) === "equal"));
      if (primary === undefined || !unchanged) {
        throw new CromDBError("STALE_DOCUMENT", `${what} has had a version added, removed or changed since its conflict was loaded`);
      }
      this.#checkCanWrite(primary);

      const versions = current.filter((row) => included.includes(row.id));
      const baseClock = versions.reduce<VectorClock>((clock, version) => merge(clock, version.vectorClock), {});
      const timestamp = this.#now().toISOString();
      let body: EnvelopeBody;
      if (resolution.kind === "version") {
        const chosen = versions.find((version) => version.id === resolution.rowId);
        if (chosen === undefined || chosen.deleted) {
          throw new TypeError("resolveWith takes a live version of this conflict");
        }
        this.#checkStaysWriter(chosen.writers);
        body = {
          id: primaryId,
          parentId: primary.parentId,
          kind: "document",
          deleted: false,
          readers: chosen.readers,
          writers: chosen.writers,
          content: chosen.content,
          fieldTypes: chosen.fieldTypes,
        };
      } else if (resolution.kind === "content") {
        const readers = validateAccessList(resolution.readers ?? primary.readers, "readers", this.#unicodeVersion);
        const writers = validateAccessList(resolution.writers ?? primary.writers, "writers", this.#unicodeVersion);
        this.#checkStaysWriter(writers);
        const encoded = encodeContent(resolution.content);
        body = {
          id: primaryId,
          parentId: primary.parentId,
          kind: "document",
          deleted: false,
          readers,
          writers,
          content: encoded.content,
          fieldTypes: encoded.fieldTypes,
        };
      } else {
        body = {
          id: primaryId,
          parentId: primary.parentId,
          kind: "document",
          deleted: true,
          deletedAt: timestamp,
          readers: primary.readers,
          writers: primary.writers,
          content: {},
          fieldTypes: {},
        };
      }
      writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        timestamp,
        primary,
        body,
        body.deleted ? "delete" : "put",
        writerClock(this.instanceId, baseClock, current.map((version) => version.vectorClock)),
      );
      this.#arrange(primaryId, primary.parentId);
      return this.#writeResult(primaryId);
    });
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

  /** A deleted primary still in conflict, which this session can read. */
  #isDeletedInConflict(envelope: DocumentEnvelope | undefined): envelope is DocumentEnvelope {
    return (
      envelope !== undefined &&
      envelope.kind === "document" &&
      envelope.deleted &&
      envelope.conflictOf === undefined &&
      canAccess(this.session.principal, envelope.readers) &&
      this.#isInConflict(envelope)
    );
  }

  /**
   * Checked against the stored lists, not the new ones, so nobody can add
   * themselves in the write being checked. Writing needs reading too: a
   * creator left out of readers can't keep writing through the object create
   * returned.
   */
  #checkCanWrite(stored: DocumentEnvelope): void {
    const principal = JSON.stringify(this.session.principal);
    if (!canAccess(this.session.principal, stored.writers)) {
      throw new CromDBError("ACCESS_DENIED", `${principal} cannot write document ${JSON.stringify(stored.id)}`);
    }
    if (!canAccess(this.session.principal, stored.readers)) {
      throw new CromDBError("ACCESS_DENIED", `${principal} cannot write document ${JSON.stringify(stored.id)}, which they can't read`);
    }
  }

  /**
   * A version whose writer isn't in its own writers is unauthorized on every
   * other replica, so a writer can't write themselves out.
   */
  #checkStaysWriter(writers: readonly string[]): void {
    if (!canAccess(this.session.principal, writers)) {
      throw new CromDBError(
        "ACCESS_DENIED",
        `${JSON.stringify(this.session.principal)} cannot remove themselves from writers; another writer must do it`,
      );
    }
  }

  /** Steps shared by save and delete: the stored document, unchanged since load, writable by this principal. */
  #loadForWrite(id: string, loadedClock: VectorClock): DocumentEnvelope {
    const stored = this.#adapter.getDocument(id);
    if (stored === undefined || stored.kind !== "document" || stored.deleted) {
      throw new CromDBError("NOT_FOUND", `Document ${JSON.stringify(id)} not found`);
    }
    if (stored.conflictOf !== undefined) {
      throw new CromDBError("READ_ONLY", `Document ${JSON.stringify(id)} is a version in a conflict and is read-only`);
    }
    if (compare(stored.vectorClock, loadedClock) !== "equal") {
      throw new CromDBError("STALE_DOCUMENT", `Document ${JSON.stringify(id)} was saved since it was loaded`);
    }
    this.#checkCanWrite(stored);
    return stored;
  }

  /**
   * The clock for a save or delete made from the stored primary, with the
   * writer key chosen so the write doesn't count as after a conflict version
   * this replica wrote but the writer never read.
   */
  #clockForWrite(stored: DocumentEnvelope): VectorClock {
    return writerClock(this.instanceId, stored.vectorClock, this.#storedClocks(stored.id));
  }

  /** What a save, delete or resolve reports, read after the write is arranged. */
  #writeResult(id: string): WriteResult {
    const primary = this.#adapter.getDocument(id);
    return Object.freeze({ editedThroughConflict: primary !== undefined && this.#isInConflict(primary) });
  }

  #save(
    id: string,
    loadedClock: VectorClock,
    content: Record<string, unknown>,
    readers: unknown,
    writers: unknown,
  ): { envelope: DocumentEnvelope; result: WriteResult } {
    return this.#adapter.transaction(() => {
      const stored = this.#loadForWrite(id, loadedClock);
      const validReaders = validateAccessList(readers, "readers", this.#unicodeVersion);
      const validWriters = validateAccessList(writers, "writers", this.#unicodeVersion);
      this.#checkStaysWriter(validWriters);
      const encoded = encodeContent(content);
      const vectorClock = this.#clockForWrite(stored);
      const envelope = writeDocument(
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
        vectorClock,
      );
      this.#arrange(stored.id, stored.parentId);
      return { envelope, result: this.#writeResult(stored.id) };
    });
  }

  /** Deleting a document in conflict makes its best live conflict version the primary, if it has one. */
  #delete(id: string, loadedClock: VectorClock): { envelope: DocumentEnvelope; result: WriteResult } {
    return this.#adapter.transaction(() => {
      const stored = this.#loadForWrite(id, loadedClock);
      const timestamp = this.#now().toISOString();
      const vectorClock = this.#clockForWrite(stored);
      const envelope = writeDocument(
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
        vectorClock,
      );
      this.#arrange(stored.id, stored.parentId);
      return { envelope, result: this.#writeResult(stored.id) };
    });
  }
}
