import { effectiveAdmins, grantFor, isLockedOut, type AccessLists, type Grant } from "./access.js";
import { EVERYONE, SYSTEM, validatePrincipalName, validateReplicaName } from "./acl.js";
import { Acl, type AclHost, type AclWrite } from "./acl-document.js";
import { arrange, conflictRowId, latestCount, writerClock, writerKeyIndex } from "./conflict.js";
import { Conflict, type ConflictHost, type ConflictRow, type Resolution } from "./conflict-object.js";
import { DEFAULT_POLICY, compareRank, isKnownPolicy, policyNamed, type ConflictPolicy } from "./conflict-policy.js";
import { Document, type DocumentHost, type WriteResult } from "./document.js";
import { DocumentSet } from "./document-set.js";
import type { ChangeEntry, ChangeOp, DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
import { decodeContent, encodeContent } from "./field-types.js";
import { ACCESS_STRUCTURE_LEVEL, NEW_DATABASE_LEVEL, PURGE_LEVEL, SUPPORTED_LEVELS, VERSION, isLevel } from "./engine.js";
import {
  compareCreated,
  encodeCursor,
  isAfter,
  matchesWhere,
  parseFindFilter,
  parseFindOptions,
  type FindFilter,
  type FindOptions,
  type FindPosition,
  type ParsedFindFilter,
  type ParsedFindOptions,
} from "./find-filter.js";
import { HELLO_PROTOCOL, MAX_TIPS, parseHello, syncLevel, type LogTip, type PeerCheck, type SyncHello } from "./handshake.js";
import { newId } from "./ids.js";
import type { JsonObject } from "./json.js";
import { isAuthorizedVersion, rulesFor, type PrincipalRules } from "./principals.js";
import {
  DAY_MS,
  maxMerge,
  mergeRegistrationContent,
  mergeSettingsContent,
  mergeSystemVersions,
  noteCheckpoint,
  purgeCandidate,
  trimCheckpoints,
  uncovered,
  type Checkpoints,
  type SeqMap,
} from "./purge.js";
import {
  BATCH_FORMAT,
  DEFAULT_EXPORT_LIMIT,
  LEVEL_1_BATCH_FORMAT,
  PURGE_BATCH_FORMAT,
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
import { TICKET_FORMAT, frozenJson, parseTicket, type ParsedTicket, type ReplicaTicket } from "./ticket.js";
import type { LiveDocumentsNarrowing, StorageAdapter, StoredSuspect } from "./storage/adapter.js";
import { Suspect, classify, suspectKey, type RecoverResult, type SuspectHost } from "./recovery.js";
import {
  FILLED_IN_LISTS,
  PURGE_AFTER_DAYS_RANGE,
  aclContent,
  aclDocId,
  databaseDocId,
  isPurgeAfterDays,
  readAclDoc,
  readDatabaseLevel,
  readSettings,
  registrationDocId,
  settingsDocId,
  type AclDocContent,
  type DatabaseDocContent,
  type RegistrationContent,
} from "./system-docs.js";
import { ENGINE_UNICODE_VERSION, compareUnicodeVersions, isUnicodeVersion } from "./unicode/version.js";
import { conflictVersion, entryIdentity } from "./version.js";
import { compare, countFor, increment, merge, type VectorClock } from "./vector-clock.js";

const INSTANCE_ID_KEY = "instanceId";
const DATABASE_ID_KEY = "databaseId";
const CONFLICT_POLICY_KEY = "conflictPolicy";
// What a peer said in its last sync hello, keyed by its instance ID.
const PEER_HELLO_PREFIX = "peerHello:";
// Level 4 and above, local to this replica: see purge.ts.
const KNOWLEDGE_KEY = "knowledge";
const HORIZONS_KEY = "horizons";
const CHECKPOINTS_KEY = "checkpoints";
// Why this replica is stale, as { source, required }; empty when it isn't.
const STALE_KEY = "stale";
// Permanent states (0.8.0): this storage is a backup; a hello showed its log
// went back; it holds its own registration as retired. Each makes it take no
// writes and no sync, ever.
const BACKUP_KEY = "backup";
const REWOUND_KEY = "rewound";
const RETIRED_KEY = "retired";

// A page of find reads at most this many candidates per document asked for,
// so a filter that matches little can't make one page read everything.
const PAGE_SCAN_FACTOR = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What this session's principal may do in the database, from its ACL. A
 * snapshot: it doesn't change if the ACL changes later. All false for a
 * principal the database doesn't admit, or one in noAccess.
 */
export interface DatabaseAccess {
  /** In any list of the ACL and not in noAccess: may open the database. */
  readonly visible: boolean;
  /** In the database's readers: may read documents whose own readers allow it. */
  readonly read: boolean;
  /** In the database's writers: may edit documents whose own writers and readers allow it, if also a reader. */
  readonly write: boolean;
  readonly create: boolean;
  readonly admin: boolean;
}

/** A replica this replica knows about, from Database.replicas. */
export interface ReplicaInfo {
  readonly instanceId: string;
  /** The replica's display label, if it was given one. Not unique. */
  readonly name?: string;
  /** When the replica was created. */
  readonly createdAt: Date;
  /**
   * The highest database level the replica's engine supports, if known: for
   * this replica, its own engine's. For another, in a database at level 2 or
   * higher,
   * what that replica recorded in its registration when it last opened the
   * database; otherwise what it said in its last sync hello to this replica
   * (see Database.checkPeer). Undefined if unknown, as for a replica this one
   * has never checked, or one on 0.2.0 or earlier.
   */
  readonly maxLevel?: number;
  /**
   * Level 4 and above, for replicas other than this one: how far into that
   * replica's change log this replica is known to hold everything, directly
   * or through other replicas. 0 if nothing yet.
   */
  readonly knownThrough?: number;
  /**
   * "retired" once an admin retired the replica (see retireReplica), as far
   * as this replica knows: a retirement reaches it through sync. Otherwise
   * "active".
   */
  readonly status: "active" | "retired";
  /**
   * The replica that introduced this one: the replica whose ticket made it,
   * or, for a replica adopted from a backup, the replica the backup was of.
   * Undefined for the database's first replica.
   */
  readonly introducedBy?: string;
}

/** What Database.purge did. */
export interface PurgeResult {
  /** Tombstones removed. */
  readonly tombstones: number;
  /** Change entries removed: the tombstones' own, and entries superseded by a later entry for the same document. */
  readonly entries: number;
  /** This replica's purge horizon afterwards: how far into its change log it may lack purged tombstones. */
  readonly horizon: number;
}

/** A database's settings, from Database.getSettings. */
export interface DatabaseSettings {
  /**
   * How many days a tombstone is kept on a replica, counted from when that
   * replica recorded it, before purge may remove it. 1 to 3650, 90 by default.
   */
  readonly purgeAfterDays: number;
}

/** From Database.syncState. */
export interface SyncState {
  /**
   * Whether this replica is stale: a pull found it can't show it holds
   * everything below another replica's purge horizons. A stale replica takes
   * no writes (READ_ONLY) until a pull brings it up to date.
   */
  readonly stale: boolean;
  /** The replica whose pull found it stale, while stale. */
  readonly staleSource?: string;
  /** This replica's own purge horizon, 0 if it has never purged. */
  readonly purgedThrough: number;
  /** For a backup: the instance ID of the replica it is a backup of. A backup takes no writes and doesn't sync. */
  readonly backupOf?: string;
  /** A hello showed this replica's change log went back: it was restored or copied. Permanent: it takes no writes and doesn't sync. */
  readonly rewound: boolean;
  /** This replica holds its own registration as retired. Permanent: it takes no writes and doesn't sync. */
  readonly retired: boolean;
}

interface OpenedState {
  databaseId: string;
  instanceId: string;
  unicodeVersion: string;
  conflictPolicy: string;
  level: number;
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

/** A stored knowledge or horizons map, or an empty one. Throws INVALID_DATABASE if malformed. */
function readLocalSeqMap(adapter: StorageAdapter, key: string): SeqMap {
  const stored = adapter.getLocal(key);
  if (stored === undefined || stored === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((seq) => Number.isSafeInteger(seq) && (seq as number) >= 0)
  ) {
    throw new CromDBError("INVALID_DATABASE", `The stored ${key} is malformed`);
  }
  return parsed as SeqMap;
}

function readCheckpoints(adapter: StorageAdapter): Checkpoints {
  const stored = adapter.getLocal(CHECKPOINTS_KEY);
  if (stored === undefined || stored === "") {
    return { closed: [] };
  }
  try {
    return JSON.parse(stored) as Checkpoints;
  } catch {
    throw new CromDBError("INVALID_DATABASE", "The stored checkpoints are malformed");
  }
}

/**
 * At level 4 and above, records when the change log reached its current end,
 * for purge's tombstone ages. Does nothing if the log hasn't grown since the
 * last call, so it can be called after any write.
 */
function noteLog(adapter: StorageAdapter, level: number, now: Date): void {
  if (level < PURGE_LEVEL) {
    return;
  }
  const checkpoints = readCheckpoints(adapter);
  const seq = adapter.lastSeq();
  if (checkpoints.open?.seq === seq) {
    return;
  }
  adapter.setLocal(CHECKPOINTS_KEY, JSON.stringify(noteCheckpoint(checkpoints, seq, now.getTime())));
}

/** What a backup's mark says: whose backup it is, and that replica's change log position then. */
interface BackupMark {
  readonly of: string;
  readonly lastSeq: number;
  readonly at: string;
  readonly engine: string;
}

/** The permanent states a storage may be in; each is undefined when it isn't. */
interface Blocks {
  readonly backup?: BackupMark;
  readonly rewound?: { readonly detectedBy: string; readonly knownOfMe: number; readonly lastSeq: number; readonly at: string };
  readonly retired?: { readonly at: string };
}

function readLocalJson<T>(adapter: StorageAdapter, key: string, what: string): T | undefined {
  const stored = adapter.getLocal(key);
  if (stored === undefined || stored === "") {
    return undefined;
  }
  try {
    return JSON.parse(stored) as T;
  } catch {
    throw new CromDBError("INVALID_DATABASE", `The stored ${what} is malformed`);
  }
}

function readBlocks(adapter: StorageAdapter): Blocks {
  const backup = readLocalJson<BackupMark>(adapter, BACKUP_KEY, "backup mark");
  const rewound = readLocalJson<NonNullable<Blocks["rewound"]>>(adapter, REWOUND_KEY, "rewound state");
  const retired = readLocalJson<NonNullable<Blocks["retired"]>>(adapter, RETIRED_KEY, "retired state");
  return { ...(backup === undefined ? {} : { backup }), ...(rewound === undefined ? {} : { rewound }), ...(retired === undefined ? {} : { retired }) };
}

function isBlocked(blocks: Blocks): boolean {
  return blocks.backup !== undefined || blocks.rewound !== undefined || blocks.retired !== undefined;
}

/**
 * A batch carries a write this replica made that it doesn't hold, so it went
 * back. applyChanges marks it rewound outside the refused transaction.
 */
class OwnWriteMissing extends CromDBError {
  constructor(message: string) {
    super("REWIND_DETECTED", message);
  }
}

/** A storage adapter, as far as can be checked: an object with the methods every adapter has. */
function isAdapter(value: unknown): value is StorageAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    ["getDocument", "putDocument", "allDocuments", "appendChange", "getLocal", "setLocal", "isEmpty", "transaction"].every(
      (name) => typeof (value as Record<string, unknown>)[name] === "function",
    )
  );
}

/** What a pull refused as stale records, or undefined if this replica isn't stale. */
interface StaleState {
  readonly source: string;
  readonly required: SeqMap;
  readonly at: string;
}

function readStale(adapter: StorageAdapter): StaleState | undefined {
  const stored = adapter.getLocal(STALE_KEY);
  if (stored === undefined || stored === "") {
    return undefined;
  }
  try {
    return JSON.parse(stored) as StaleState;
  } catch {
    throw new CromDBError("INVALID_DATABASE", "The stored stale state is malformed");
  }
}

/** The STALE_REPLICA error for a puller that can't show it holds what the source purged. */
function pullerStale(source: string, missing: readonly [string, number, number][]): CromDBError {
  const [replica, known, horizon] = missing[0] as [string, number, number];
  return new CromDBError(
    "STALE_REPLICA",
    `This replica is stale: replica ${JSON.stringify(source)} may have purged deletions this replica can't show it has, since ` +
      `it holds replica ${JSON.stringify(replica)}'s changes only up to ${known} and the purge reaches ${horizon}. ` +
      "This doesn't prove a deletion is missing, only that it can't be shown present. Until it is, this replica takes no writes; " +
      "a pull from a replica that hasn't purged that far can bring it up to date, or make a new replica from a ticket",
  );
}

/** The STALE_REPLICA error for a source that can't show it holds what this replica purged. */
function sourceStale(source: string, missing: readonly [string, number, number][]): CromDBError {
  const [replica, known, horizon] = missing[0] as [string, number, number];
  return new CromDBError(
    "STALE_REPLICA",
    `Replica ${JSON.stringify(source)} is stale: this replica may have purged deletions it can't show it has, since ` +
      `it holds replica ${JSON.stringify(replica)}'s changes only up to ${known} and this replica's purge reaches ${horizon}. ` +
      "Its documents could bring purged ones back, so none are taken. This doesn't prove a deletion is missing there, only that " +
      "it can't be shown present; it must first pull from this replica, or be replaced by a new replica made from a ticket",
  );
}

/** Creates a database at NEW_DATABASE_LEVEL, with principal alone in its admins, creators, writers and readers. */
function initialize(
  adapter: StorageAdapter,
  principal: string,
  timestamp: string,
  unicodeVersion: string,
  replicaName: string | undefined,
): OpenedState {
  const level = NEW_DATABASE_LEVEL;
  const databaseId = newId();
  const instanceId = newId();
  adapter.setLocal(DATABASE_ID_KEY, databaseId);
  adapter.setLocal(INSTANCE_ID_KEY, instanceId);
  adapter.setLocal(CONFLICT_POLICY_KEY, DEFAULT_POLICY);
  adapter.markLevel?.(level);

  const databaseContent: DatabaseDocContent = { databaseId, createdAt: timestamp, createdOn: instanceId, unicodeVersion, level };
  const acl: AclDocContent = { admins: [principal], creators: [principal], writers: [principal], readers: [principal], noAccess: [] };
  const registrationContent: RegistrationContent = {
    instanceId,
    status: "active",
    introducedBy: null,
    introducedAt: timestamp,
    ...(replicaName === undefined ? {} : { name: replicaName }),
    maxLevel: SUPPORTED_LEVELS.max,
  };

  const systemDocs: [string, JsonObject][] = [
    [databaseDocId(databaseId), { ...databaseContent }],
    [aclDocId(databaseId), aclContent(acl, level)],
    [registrationDocId(databaseId, instanceId), { ...registrationContent }],
  ];
  for (const [id, content] of systemDocs) {
    writeDocument(
      adapter,
      instanceId,
      SYSTEM,
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
  return { databaseId, instanceId, unicodeVersion, conflictPolicy: DEFAULT_POLICY, level };
}

/**
 * Makes the empty adapter the replica a checked ticket describes: its local
 * state and the ticket's four system documents, each with a change entry, as
 * createReplica copies documents. No sync position is set, so the first pull
 * from the introducer starts at 0. The caller's transaction makes it
 * all-or-nothing.
 */
function setUpFromTicket(session: Session, adapter: StorageAdapter, ticket: ParsedTicket): void {
  if (!adapter.isEmpty()) {
    throw new CromDBError("INVALID_DATABASE", "The target for a new replica must be empty");
  }
  checkSessionKind(session, ticket.level);
  if (session.kind === "named") {
    validatePrincipalName(session.principal, ticket.unicodeVersion);
  }
  // The pull that fills the replica needs an admin, so only an admin can make it.
  if (!rulesFor(ticket.level, ticket.unicodeVersion).canAccess(session.principal, ticket.admins)) {
    throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(session.principal)} cannot make a replica of this database; only admins can`);
  }
  adapter.setLocal(DATABASE_ID_KEY, ticket.databaseId);
  adapter.setLocal(INSTANCE_ID_KEY, ticket.instanceId);
  adapter.setLocal(CONFLICT_POLICY_KEY, ticket.conflictPolicy);
  if (ticket.level >= 2) {
    adapter.markLevel?.(ticket.level);
  }
  for (const envelope of ticket.documents) {
    adapter.putDocument(envelope);
    adapter.appendChange(replicatedChange(envelope));
  }
}

/** ACCESS_DENIED for a session the database doesn't admit, or one in noAccess. */
function noAccess(principal: string): CromDBError {
  return new CromDBError("ACCESS_DENIED", `${JSON.stringify(principal)} has no access to this database`);
}

/** Whether value is a list with exactly the entries of expected, in order. */
function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
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

/** Throws UPGRADE_REQUIRED if this engine can't handle the database level. */
function checkLevel(level: number): void {
  if (level > SUPPORTED_LEVELS.max) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `The database is at level ${level}, but this engine supports levels up to ${SUPPORTED_LEVELS.max}`,
    );
  }
}

/** Checks an existing database can be opened by this engine and returns its Unicode version and level. */
function checkExisting(
  adapter: StorageAdapter,
  databaseId: string,
  instanceId: string,
  engineVersion: string,
): { unicodeVersion: string; level: number } {
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
  const level = readDatabaseLevel(content);
  checkLevel(level);
  return { unicodeVersion, level };
}

/** What describeDatabase returns. */
export interface DatabaseDescription {
  readonly databaseId: string;
  readonly instanceId: string;
  readonly level: number;
}

/**
 * The database in an adapter, read without opening it: its ID, this
 * replica's instance ID and its level, or undefined if the adapter is empty.
 * Needs no session and checks no access, since anyone holding the storage
 * can read these, and writes nothing. For code that must know what a
 * storage holds before it knows who will use it, such as a driver choosing
 * by level. Throws INVALID_DATABASE if the stored state is inconsistent,
 * and UPGRADE_REQUIRED for a database this engine can't handle, as
 * Session.openDatabase does.
 */
export function describeDatabase(adapter: StorageAdapter): DatabaseDescription | undefined {
  return adapter.transaction(() => {
    const databaseId = adapter.getLocal(DATABASE_ID_KEY);
    const instanceId = adapter.getLocal(INSTANCE_ID_KEY);
    if (databaseId === undefined && instanceId === undefined && adapter.isEmpty()) {
      return undefined;
    }
    if (databaseId === undefined || instanceId === undefined) {
      throw new CromDBError("INVALID_DATABASE", "Local state has only one of the database ID and instance ID");
    }
    const { level } = checkExisting(adapter, databaseId, instanceId, ENGINE_UNICODE_VERSION);
    checkConflictPolicy(adapter);
    return Object.freeze({ databaseId, instanceId, level });
  });
}

/** Throws INVALID_PRINCIPAL unless the session identifies its user the way a database at this level does. */
function checkSessionKind(session: Session, level: number): void {
  if (session.kind === "anonymous") {
    return;
  }
  if (level === 1 && session.kind !== "named") {
    throw new CromDBError(
      "INVALID_PRINCIPAL",
      "This database is at level 1 and identifies users by name: open it with Session.named. Raising a database to level 2 is not available yet.",
    );
  }
  if (level >= 2 && session.kind !== "id") {
    throw new CromDBError("INVALID_PRINCIPAL", `This database is at level ${level} and identifies users by ID: open it with Session.withId`);
  }
}

/**
 * Makes a backup a writable replica with a new instance ID: registers it,
 * retires the backed-up replica's ID, records that it holds that replica's
 * log as far as the backup did, and clears the mark. In the caller's
 * transaction.
 */
function adoptBackup(adapter: StorageAdapter, state: OpenedState, acl: AclDocContent, timestamp: string): OpenedState {
  const blocks = readBlocks(adapter);
  const mark = blocks.backup;
  if (mark === undefined) {
    throw new CromDBError("NOT_SUPPORTED", "This storage isn't a backup; only a backup can be adopted");
  }
  if (blocks.rewound !== undefined || blocks.retired !== undefined) {
    throw new CromDBError("NOT_SUPPORTED", "This backup is also marked rewound or retired, and can't be adopted");
  }
  if (state.level < PURGE_LEVEL) {
    throw new CromDBError("NOT_SUPPORTED", `Adopting needs a database at level ${PURGE_LEVEL} or higher; this one is at level ${state.level}`);
  }
  const rules = rulesFor(state.level, state.unicodeVersion);
  const admins = effectiveAdmins(rules, acl);
  const instanceId = newId();
  const old = adapter.getDocument(registrationDocId(state.databaseId, mark.of));
  const oldName = old !== undefined && Object.hasOwn(old.content, "name") ? old.content["name"] : undefined;
  const id = registrationDocId(state.databaseId, instanceId);
  const content: RegistrationContent = {
    instanceId,
    status: "active",
    introducedBy: mark.of,
    introducedAt: timestamp,
    ...(typeof oldName === "string" ? { name: oldName } : {}),
  };
  writeDocument(
    adapter,
    instanceId,
    SYSTEM,
    timestamp,
    undefined,
    { id, parentId: id, kind: "system", deleted: false, readers: admins, writers: admins, content: { ...content }, fieldTypes: {} },
    "put",
  );
  if (old !== undefined && old.kind === "system" && old.content["status"] !== "retired") {
    writeDocument(
      adapter,
      instanceId,
      SYSTEM,
      timestamp,
      old,
      { id: old.id, parentId: old.parentId, kind: "system", deleted: false, readers: admins, writers: admins, content: { ...old.content, status: "retired" }, fieldTypes: {} },
      "put",
    );
  }
  adapter.setLocal(INSTANCE_ID_KEY, instanceId);
  const knowledge = readLocalSeqMap(adapter, KNOWLEDGE_KEY);
  adapter.setLocal(KNOWLEDGE_KEY, JSON.stringify(maxMerge(knowledge, { [mark.of]: mark.lastSeq }, instanceId)));
  adapter.setLocal(BACKUP_KEY, "");
  adapter.markBackup?.(false);
  return { ...state, instanceId };
}

/**
 * In a database at level 2 or higher, records in this replica's own
 * registration the highest level its engine supports, if the registration
 * doesn't already say so: on the first open of a new replica, and after an
 * upgrade or a rollback. A system write, whatever the session.
 */
function recordMaxLevel(adapter: StorageAdapter, state: OpenedState, timestamp: string): void {
  const id = registrationDocId(state.databaseId, state.instanceId);
  const stored = adapter.getDocument(id);
  if (stored === undefined || stored.kind !== "system" || stored.deleted) {
    throw new CromDBError("INVALID_DATABASE", "This replica's registration is missing");
  }
  const current = Object.hasOwn(stored.content, "maxLevel") ? stored.content["maxLevel"] : undefined;
  if (current === SUPPORTED_LEVELS.max) {
    return;
  }
  writeDocument(
    adapter,
    state.instanceId,
    SYSTEM,
    timestamp,
    stored,
    {
      id,
      parentId: stored.parentId,
      kind: "system",
      deleted: false,
      readers: stored.readers,
      writers: stored.writers,
      content: { ...stored.content, maxLevel: SUPPORTED_LEVELS.max },
      fieldTypes: {},
    },
    "put",
  );
}

/**
 * Opened through Session.openDatabase. Several Database objects can share one
 * adapter, one per user: each reads the stored state on every call, so it
 * sees the others' writes, ACL changes and synced changes at once, and checks
 * its own session's access.
 *
 * In a level-3 database the ACL sets the most anyone may do: readers may
 * read, writers may edit, creators may create, and admins may manage the
 * database, each as far as a document's own readers and writers allow.
 * Every call but myAccess, and the calls of the Documents, Conflicts and
 * Acls it returns, is refused with ACCESS_DENIED once the database no longer
 * admits the session.
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
  // The database's level as this object last read it, and how principals are
  // checked and compared at that level: by name at level 1, by ID at level 2
  // and above. Read again at the start of each call, since raiseLevel on any
  // Database of the same storage can raise it.
  #level: number;
  #rules: PrincipalRules;
  readonly #host: DocumentHost;
  readonly #aclHost: AclHost;
  readonly #conflictHost: ConflictHost;
  readonly #suspectHost: SuspectHost;

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
    this.#level = state.level;
    this.#rules = rulesFor(state.level, state.unicodeVersion);
    this.databaseId = state.databaseId;
    this.instanceId = state.instanceId;
    this.#adapter = adapter;
    this.#now = now;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const database = this;
    this.#host = {
      get level() {
        return database.#level;
      },
      access: (readers, writers) => this.#documentAccess(readers, writers),
      save: (id, loadedClock, content, readers, writers) => this.#save(id, loadedClock, content, readers, writers),
      delete: (id, loadedClock) => this.#delete(id, loadedClock),
      children: <C extends Record<string, unknown>>(id: string) => this.find<C>({ parentId: id }),
      conflict: <C extends Record<string, unknown>>(primaryId: string, ifVersion: string | undefined) => this.#conflict<C>(primaryId, ifVersion),
    };
    this.#aclHost = {
      get level() {
        return database.#level;
      },
      save: (loadedClock, lists) => this.#saveAcl(loadedClock, lists),
    };
    this.#conflictHost = {
      get level() {
        return database.#level;
      },
      resolve: (primaryId, rows, included, resolution) => this.#resolve(primaryId, rows, included, resolution),
    };
    this.#suspectHost = {
      accept: (key, options) => this.#acceptSuspect(key, options),
      discard: (key) => this.#discardSuspect(key),
    };
  }

  /** @internal Use Session.openDatabase. */
  static open(
    session: Session,
    adapter: StorageAdapter,
    now: () => Date,
    engineVersion: string,
    replicaName?: unknown,
    replicaOf?: unknown,
    adopt?: unknown,
  ): Database {
    if (replicaOf !== undefined && replicaName !== undefined) {
      throw new TypeError("replicaName and replicaOf can't be given together: a replica made from a ticket is named by registerReplica");
    }
    if (adopt !== undefined && typeof adopt !== "boolean") {
      throw new TypeError(`adopt must be a boolean, got ${typeof adopt}`);
    }
    if (adopt === true && (replicaOf !== undefined || replicaName !== undefined)) {
      throw new TypeError("adopt opens an existing backup; replicaName and replicaOf can't be given with it");
    }
    // Checked in full before anything is written.
    const ticket = replicaOf === undefined ? undefined : parseTicket(replicaOf, engineVersion);
    const state = adapter.transaction(() => {
      if (ticket !== undefined) {
        setUpFromTicket(session, adapter, ticket);
      }
      let opened = Database.#openOrInitialize(session, adapter, now, engineVersion, replicaName);
      checkSessionKind(session, opened.level);
      // The session's name was checked against the engine's version; the
      // database's version may be lower.
      if (session.kind === "named") {
        validatePrincipalName(session.principal, opened.unicodeVersion);
      }
      const lists = readAclDoc(adapter.getDocument(aclDocId(opened.databaseId)), opened.level);
      const grant = grantFor(rulesFor(opened.level, opened.unicodeVersion), session.principal, lists);
      if (!grant.visible) {
        throw noAccess(session.principal);
      }
      if (adopt === true) {
        if (!grant.admin) {
          throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(session.principal)} cannot adopt this backup; only admins can`);
        }
        opened = adoptBackup(adapter, opened, lists, now().toISOString());
      }
      // A backup, or a copy that went back or was retired, is only read:
      // opening it writes nothing, not even its engine's level.
      if (!isBlocked(readBlocks(adapter))) {
        if (opened.level >= 2) {
          recordMaxLevel(adapter, opened, now().toISOString());
        }
        noteLog(adapter, opened.level, now());
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
    replicaName: unknown,
  ): OpenedState {
    const storedDatabaseId = adapter.getLocal(DATABASE_ID_KEY);
    const storedInstanceId = adapter.getLocal(INSTANCE_ID_KEY);

    if (replicaName !== undefined && (storedDatabaseId !== undefined || storedInstanceId !== undefined)) {
      throw new TypeError("replicaName names a new database's first replica; this database already exists");
    }
    if (storedDatabaseId !== undefined && storedInstanceId !== undefined) {
      const { unicodeVersion, level } = checkExisting(adapter, storedDatabaseId, storedInstanceId, engineVersion);
      const conflictPolicy = checkConflictPolicy(adapter);
      return { databaseId: storedDatabaseId, instanceId: storedInstanceId, unicodeVersion, conflictPolicy, level };
    }
    if (storedDatabaseId !== undefined || storedInstanceId !== undefined) {
      throw new CromDBError("INVALID_DATABASE", "Local state has only one of the database ID and instance ID");
    }
    if (session.kind === "anonymous") {
      throw new CromDBError("ACCESS_DENIED", "An anonymous session cannot create a database");
    }
    if (session.kind !== "id") {
      throw new CromDBError(
        "INVALID_PRINCIPAL",
        `New databases are at level ${NEW_DATABASE_LEVEL}, which identifies users by ID: use Session.withId`,
      );
    }
    const name = replicaName === undefined ? undefined : validateReplicaName(replicaName, engineVersion);
    return initialize(adapter, session.principal, now().toISOString(), engineVersion, name);
  }

  /**
   * The database's level, read fresh each time: 1 for a database made by
   * 0.3.0 or earlier, which identifies users by name, and 2 for one made by
   * this engine, which identifies them by ID. A level is never lowered. See
   * SUPPORTED_LEVELS.
   */
  get level(): number {
    return this.#readLevel();
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
    const doc = this.#adapter.transaction(() => {
      const { grant } = this.#requireVisible();
      const envelope = this.#adapter.getDocument(id);
      if (this.#isReadableDocument(envelope, grant)) {
        return this.#toDocument<T>(envelope, envelope.conflictOf !== undefined);
      }
      if (this.#isDeletedInConflict(envelope, grant)) {
        return this.#toDocument<T>(envelope, true);
      }
      return undefined;
    });
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
   *
   * With limit (1 to 1000), the set is one page: the first limit documents
   * after the position after, or from the start without it. Pass the page's
   * next as after for the following page. A page can hold fewer than limit
   * documents, even none, and still have a next, when many documents in a
   * row don't match; only an undefined next means the end. count is the
   * number of documents in the page.
   *
   * Pages are positions in the order, not a snapshot: each page is read
   * when it is asked for. A document present and matching for the whole
   * pass is seen exactly once. A document created on this replica during the
   * pass has a later createdAt, so it appears on a later page. One deleted
   * or no longer matching doesn't appear on later pages. A document arriving
   * by sync with an earlier createdAt than the pass has reached is missed by
   * that pass.
   *
   * next is opaque. It works on any replica of the database and after a
   * restart, but only with the same filter.
   *
   * Throws TypeError for an unknown filter or option key, an unsupported
   * value, limit out of range, after without limit, or a cursor that isn't
   * one from find with this filter.
   */
  async find<T extends Record<string, unknown>>(filter?: FindFilter, options?: FindOptions): Promise<DocumentSet<T>> {
    const parsed = parseFindFilter(filter);
    const paging = parseFindOptions(options, parsed);
    const { ids, next } = this.#adapter.transaction(() => {
      const { grant } = this.#requireVisible();
      const matches = this.#findMatcher(parsed, grant);
      return paging === undefined ? { ids: this.#findAll(parsed, matches), next: undefined } : this.#findPage(parsed, paging, matches);
    });
    // A document deleted since, but still in conflict, is yielded only to an
    // inConflict: true set, which may hold deleted documents.
    const inConflict = parsed.inConflict;
    return new DocumentSet<T>(
      ids,
      async (id) => {
        const doc = await this.get<T>(id);
        return doc?.deleted === true && inConflict !== true ? undefined : doc;
      },
      next,
    );
  }

  /** The adapter narrowing for a filter, if it has one. */
  #narrowing(filter: ParsedFindFilter): LiveDocumentsNarrowing | undefined {
    if (filter.parentId !== undefined) {
      return { parentId: filter.parentId };
    }
    return filter.topLevel === true ? { topLevel: true } : undefined;
  }

  /** Whether a candidate belongs in find's results for the filter. Use within one transaction. */
  #findMatcher(filter: ParsedFindFilter, grant: Grant): (envelope: DocumentEnvelope) => boolean {
    const { parentId, topLevel, orphaned, inConflict, where } = filter;
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
    return (envelope) =>
      (this.#isReadableDocument(envelope, grant) || this.#isDeletedInConflict(envelope, grant)) &&
      (parentId === undefined || (envelope.parentId === parentId && envelope.id !== parentId)) &&
      (topLevel === undefined || (envelope.parentId === envelope.id) === topLevel) &&
      (orphaned === undefined || isOrphaned(envelope) === orphaned) &&
      matchesWhere(envelope, where) &&
      (inConflict === undefined || this.#isInConflict(envelope) === inConflict);
  }

  #findAll(filter: ParsedFindFilter, matches: (envelope: DocumentEnvelope) => boolean): string[] {
    const narrow = this.#narrowing(filter);
    const candidates = filter.inConflict === true ? this.#adapter.primaryDocuments(narrow) : this.#adapter.liveDocuments(narrow);
    return candidates
      .filter(matches)
      .sort(compareCreated)
      .map((envelope) => envelope.id);
  }

  /**
   * One page: reads candidates in find order after the position, in chunks,
   * until the page is full, the candidates run out, or it has read
   * PAGE_SCAN_FACTOR times limit of them.
   */
  #findPage(
    filter: ParsedFindFilter,
    paging: ParsedFindOptions,
    matches: (envelope: DocumentEnvelope) => boolean,
  ): { ids: string[]; next: string | undefined } {
    const readAfter = this.#candidatesAfter(filter);
    const cap = paging.limit * PAGE_SCAN_FACTOR;
    const ids: string[] = [];
    let position = paging.after;
    let scanned = 0;
    let exhausted = false;
    while (ids.length < paging.limit && scanned < cap && !exhausted) {
      const asked = Math.min(paging.limit, cap - scanned);
      const chunk = readAfter(position, asked);
      let used = 0;
      for (const envelope of chunk) {
        used++;
        scanned++;
        position = { createdAt: envelope.createdAt, id: envelope.id };
        if (matches(envelope)) {
          ids.push(envelope.id);
          if (ids.length === paging.limit) {
            break;
          }
        }
      }
      // A short chunk read to its end means there are no more candidates.
      exhausted = chunk.length < asked && used === chunk.length;
    }
    const next = exhausted || position === undefined ? undefined : encodeCursor(position, paging);
    return { ids, next };
  }

  /** Reads find candidates after a position, through the adapter's documentsAfter or by sorting them all. */
  #candidatesAfter(filter: ParsedFindFilter): (after: FindPosition | undefined, limit: number) => DocumentEnvelope[] {
    const narrow = this.#narrowing(filter);
    const includeDeleted = filter.inConflict === true;
    const adapter = this.#adapter;
    if (adapter.documentsAfter !== undefined) {
      return (after, limit) => adapter.documentsAfter?.(narrow, includeDeleted, after, limit) ?? [];
    }
    let sorted: DocumentEnvelope[] | undefined;
    return (after, limit) => {
      sorted ??= (includeDeleted ? adapter.primaryDocuments(narrow) : adapter.liveDocuments(narrow)).sort(compareCreated);
      const start = after === undefined ? 0 : sorted.findIndex((envelope) => isAfter(envelope, after));
      return start === -1 ? [] : sorted.slice(start, start + limit);
    };
  }

  /**
   * Needs the database's creators. The creator is always one of the writers:
   * if writers doesn't admit them, they are added to it. readers is kept as
   * given, so a creator can write a document they can't read back, as one
   * who isn't in the database's readers can't. readers and writers default
   * to ["*"]: every signed-in user the database's own lists admit.
   */
  async create<T extends Record<string, unknown>>(
    content: T,
    options: { readers?: string[]; writers?: string[]; parentId?: string } = {},
  ): Promise<Document<T>> {
    const principal = this.session.principal;
    const envelope = this.#adapter.transaction(() => {
      const { grant } = this.#requireVisible();
      if (!grant.create) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(principal)} cannot create documents in this database`);
      }
      this.#requireWritable();

      const readers = this.#rules.accessList(options.readers ?? [EVERYONE], "readers");
      let writers = this.#rules.accessList(options.writers ?? [EVERYONE], "writers");
      // A version whose writer isn't in its own writers is unauthorized on
      // every other replica.
      if (!this.#rules.canAccess(principal, writers)) {
        writers = [...writers, principal];
      }

      const id = newId();
      let parentId = id;
      if (options.parentId !== undefined) {
        const parent = this.#adapter.getDocument(options.parentId);
        if (!this.#isReadableDocument(parent, grant) || parent.conflictOf !== undefined) {
          throw new CromDBError("NOT_FOUND", `Parent document ${JSON.stringify(options.parentId)} not found`);
        }
        parentId = parent.id;
      }

      const encoded = encodeContent(content);
      const written = writeDocument(
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
      this.#noteLog();
      return written;
    });
    return this.#toDocument<T>(envelope, false);
  }

  /**
   * Only admins can read the ACL. Others learn what they can do through
   * myAccess.
   *
   * With ifVersion, an Acl.version from earlier: throws STALE_DOCUMENT if the
   * ACL is now at another version, as get does for documents. The Acl
   * returned is at that version, so its save refuses with STALE_DOCUMENT if
   * the ACL changes before it runs.
   */
  async getAcl(options: { ifVersion?: string } = {}): Promise<Acl> {
    const ifVersion = options.ifVersion;
    if (ifVersion !== undefined && typeof ifVersion !== "string") {
      throw new TypeError(`ifVersion must be a string, got ${typeof ifVersion}`);
    }
    const loaded = this.#adapter.transaction(() => {
      const access = this.#requireVisible();
      if (!access.grant.admin) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot read the ACL of this database`);
      }
      return access.loaded;
    });
    const acl = new Acl(this.#aclHost, loaded);
    if (ifVersion !== undefined && acl.version !== ifVersion) {
      throw new CromDBError("STALE_DOCUMENT", "The database ACL is not at the version given");
    }
    return acl;
  }

  /**
   * Reads the ACL fresh. For UI decisions only: every call is still checked
   * when it happens. Anonymous is never an admin. Never refused: a session
   * the database no longer admits gets all false, as does one in noAccess.
   */
  async myAccess(): Promise<DatabaseAccess> {
    const { grant } = this.#access();
    return Object.freeze({ visible: grant.visible, read: grant.read, write: grant.write, create: grant.create, admin: grant.admin });
  }

  /**
   * Makes the empty target adapter a new replica of this database: registers
   * it here, then copies every document as it is. Open the target afterward
   * with Session.openDatabase. Admin only.
   *
   * name is an optional display label for the new replica, travelling with
   * its registration: 1 to 100 characters, stored in NFKC form, with no
   * control, format or unassigned characters and no leading or trailing
   * space; TypeError otherwise. Names needn't be unique. Once any replica is
   * named, every replica must run 0.2.0 or later: a 0.1.x replica refuses
   * batches carrying a named registration with INVALID_BATCH.
   *
   * The new replica is at this database's level. Its registration doesn't
   * record its engine's maxLevel: the new replica does that itself when it is
   * first opened.
   *
   * The registration is written first, on its own. If a later step fails it
   * stays (a replica that never came up) and the target is left empty: the
   * whole copy runs in one target transaction, with this replica's
   * transaction nested inside it so this side commits first.
   */
  async createReplica(target: StorageAdapter, options: { name?: string } = {}): Promise<void> {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("createReplica takes options { name? }");
    }
    const name = options.name === undefined ? undefined : validateReplicaName(options.name, this.#unicodeVersion);
    this.#requireAdmin("create a replica of this database");
    if (target === this.#adapter || !target.isEmpty()) {
      throw new CromDBError("INVALID_DATABASE", "The target for a new replica must be empty");
    }
    const replicaId = newId();
    const timestamp = this.#now().toISOString();

    this.#adapter.transaction(() => {
      const { acl } = this.#requireAdmin("create a replica of this database");
      this.#requireWritable();
      this.#writeRegistration(acl, replicaId, name, timestamp);
    });

    target.transaction(() => {
      if (!target.isEmpty()) {
        throw new CromDBError("INVALID_DATABASE", "The target for a new replica must be empty");
      }
      this.#adapter.transaction(() => {
        const level = this.#readLevel();
        if (level >= 2) {
          target.markLevel?.(level);
        }
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
        if (level >= PURGE_LEVEL) {
          // The copy holds everything this replica held, and lacks what it lacks.
          target.setLocal(KNOWLEDGE_KEY, JSON.stringify(maxMerge(this.#knowledge(), { [this.instanceId]: sourceSeq }, replicaId)));
          target.setLocal(HORIZONS_KEY, JSON.stringify(this.#horizons()));
          this.#adapter.setLocal(KNOWLEDGE_KEY, JSON.stringify(maxMerge(this.#knowledge(), { [replicaId]: target.lastSeq() })));
          noteLog(target, level, this.#now());
          noteLog(this.#adapter, level, this.#now());
        }
      });
    });
  }

  /**
   * Registers a new replica of this database, to be made on another machine,
   * and returns its ticket: plain JSON, to send over any transport. There,
   * Session.openDatabase with { replicaOf: ticket } makes an empty adapter
   * that replica, and its first sync, with this replica, brings every
   * document. Admin only. name is as for createReplica.
   *
   * The registration is written now, as createReplica writes it, and
   * replicates like any other. If the ticket is never used, it stays: a
   * replica that never came up, which costs one small system document.
   *
   * A ticket is single-use: treat it like a database file. Opened on two
   * adapters, it makes two replicas with one instance ID, which sync detects
   * only sometimes (REWIND_DETECTED). The ticket holds the ACL and
   * registrations, which any batch also carries; it gives no access to
   * documents, since a pull from this replica needs an admin here.
   */
  async registerReplica(options: { name?: string } = {}): Promise<ReplicaTicket> {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("registerReplica takes options { name? }");
    }
    const name = options.name === undefined ? undefined : validateReplicaName(options.name, this.#unicodeVersion);
    const replicaId = newId();
    const timestamp = this.#now().toISOString();
    return this.#adapter.transaction(() => {
      const { acl } = this.#requireAdmin("register a replica of this database");
      this.#requireWritable();
      this.#writeRegistration(acl, replicaId, name, timestamp);
      this.#noteLog();
      const documents = [
        databaseDocId(this.databaseId),
        aclDocId(this.databaseId),
        registrationDocId(this.databaseId, this.instanceId),
        registrationDocId(this.databaseId, replicaId),
      ].map((id) => {
        const envelope = this.#adapter.getDocument(id);
        if (envelope === undefined || envelope.kind !== "system") {
          throw new CromDBError("INVALID_DATABASE", `System document ${JSON.stringify(id)} is missing`);
        }
        return envelope;
      });
      const ticket: ReplicaTicket = {
        ticket: TICKET_FORMAT,
        databaseId: this.databaseId,
        instanceId: replicaId,
        introducedBy: this.instanceId,
        level: this.#readLevel(),
        conflictPolicy: this.#conflictPolicy,
        unicodeVersion: this.#unicodeVersion,
        engine: VERSION,
        documents,
      };
      return frozenJson(ticket);
    });
  }

  /** Writes the registration of a new replica introduced by this one. Call inside a transaction, after the admin check. */
  #writeRegistration(acl: AclDocContent, replicaId: string, name: string | undefined, timestamp: string): void {
    const registrationId = registrationDocId(this.databaseId, replicaId);
    const content: RegistrationContent = {
      instanceId: replicaId,
      status: "active",
      introducedBy: this.instanceId,
      introducedAt: timestamp,
      ...(name === undefined ? {} : { name }),
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
        readers: effectiveAdmins(this.#rules, acl),
        writers: effectiveAdmins(this.#rules, acl),
        content: { ...content },
        fieldTypes: {},
      },
      "put",
    );
  }

  /**
   * Every replica this replica knows about, itself included, ordered by
   * createdAt and then instanceId. A replica learns of others through sync.
   * Anyone the database admits can list them: instance IDs are already in
   * every document's updatedOn.
   */
  async replicas(): Promise<readonly ReplicaInfo[]> {
    const { registrations, maxLevels, knowledge } = this.#adapter.transaction(() => {
      this.#requireVisible();
      const found = this.#adapter.allDocuments().filter((envelope) => {
        const instanceId = envelope.kind === "system" && Object.hasOwn(envelope.content, "instanceId") ? envelope.content["instanceId"] : undefined;
        return typeof instanceId === "string" && envelope.id === registrationDocId(this.databaseId, instanceId);
      });
      const levels = new Map<string, number | undefined>();
      for (const { content } of found) {
        const instanceId = content["instanceId"] as string;
        const registered = Object.hasOwn(content, "maxLevel") ? content["maxLevel"] : undefined;
        levels.set(
          instanceId,
          instanceId === this.instanceId ? SUPPORTED_LEVELS.max : isLevel(registered) ? registered : this.#peerMaxLevel(instanceId),
        );
      }
      return { registrations: found, maxLevels: levels, knowledge: this.#level >= PURGE_LEVEL ? this.#knowledge() : undefined };
    });
    const replicas = registrations.map(({ content }): Omit<ReplicaInfo, "createdAt"> & { createdAt: string } => {
      const instanceId = content["instanceId"] as string;
      const introducedAt = Object.hasOwn(content, "introducedAt") ? content["introducedAt"] : undefined;
      const name = Object.hasOwn(content, "name") ? content["name"] : undefined;
      const status = Object.hasOwn(content, "status") ? content["status"] : undefined;
      const introducedBy = Object.hasOwn(content, "introducedBy") ? content["introducedBy"] : undefined;
      if (
        typeof introducedAt !== "string" ||
        (name !== undefined && typeof name !== "string") ||
        (status !== "active" && status !== "retired") ||
        (introducedBy !== null && typeof introducedBy !== "string")
      ) {
        throw new CromDBError("INVALID_DATABASE", `The registration of replica ${JSON.stringify(instanceId)} is malformed`);
      }
      const maxLevel = maxLevels.get(instanceId);
      const knownThrough = knowledge === undefined || instanceId === this.instanceId ? undefined : (knowledge[instanceId] ?? 0);
      return {
        instanceId,
        ...(name === undefined ? {} : { name }),
        createdAt: introducedAt,
        ...(maxLevel === undefined ? {} : { maxLevel }),
        ...(knownThrough === undefined ? {} : { knownThrough }),
        status,
        ...(introducedBy === null ? {} : { introducedBy }),
      };
    });
    const order = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    replicas.sort((x, y) => order(x.createdAt, y.createdAt) || order(x.instanceId, y.instanceId));
    return Object.freeze(replicas.map((replica) => Object.freeze({ ...replica, createdAt: new Date(replica.createdAt) })));
  }

  /**
   * This replica's half of the sync handshake: what it is, for the replica it
   * is about to sync with, which passes it to its own checkPeer. Plain JSON,
   * to send over any transport. Admin only.
   */
  async syncHello(): Promise<SyncHello> {
    return this.#adapter.transaction(() => {
      this.#requireAdmin("say hello for sync");
      this.#requireSyncable();
      const level = this.#readLevel();
      return Object.freeze({
        protocol: HELLO_PROTOCOL,
        databaseId: this.databaseId,
        instanceId: this.instanceId,
        engine: VERSION,
        level,
        levels: Object.freeze({ min: SUPPORTED_LEVELS.min, max: SUPPORTED_LEVELS.max }),
        conflictPolicy: this.#conflictPolicy,
        unicodeVersion: this.#unicodeVersion,
        ...(level >= PURGE_LEVEL
          ? {
              lastSeq: this.#adapter.lastSeq(),
              knowledge: Object.freeze({ ...this.#knowledge() }),
              horizons: Object.freeze({ ...this.#horizons() }),
              ...this.#tips(),
            }
          : {}),
      });
    });
  }

  /**
   * Checks the hello of a replica this one is about to sync with, so a
   * mismatch shows up before any batch moves, and records the highest level
   * the peer supports (shown as maxLevel by replicas; local to this replica,
   * never replicated). Admin only. pullFrom and sync do this themselves; an
   * app carrying batches over its own transport calls it with the hello the
   * other side's syncHello gave. The replica that applies the batches is the
   * one that needs to check; a replica that only exports to the other needn't.
   *
   * undefined stands for a peer with no handshake, such as one on 0.2.0 or
   * earlier (for example, an HTTP peer that answered 404): it is taken to
   * support level 1 only, and nothing is recorded.
   *
   * Throws:
   *   INVALID_HANDSHAKE   the hello is malformed
   *   SYNC_MISMATCH       the hello is from another database, from this
   *                       replica, from a replica this one doesn't know or
   *                       that isn't active, or with another conflict policy
   *                       or Unicode version
   *   UPGRADE_REQUIRED    one of the two engines can't handle the level they
   *                       would sync at, or the peer has the database at a
   *                       higher level than this replica; the message says
   *                       which replica must be upgraded
   *
   * Replicas sync only at the same level, so a peer with the database at a
   * lower level is SYNC_MISMATCH.
   */
  async checkPeer(hello: SyncHello | undefined): Promise<PeerCheck> {
    const peer = hello === undefined ? undefined : parseHello(hello);
    const checked = this.#adapter.transaction((): { level: number; stale?: [string, number, number][]; rewound?: number } => {
      this.#requireAdmin("check a peer for sync");
      this.#requireSyncable();
      const ours = { level: this.#readLevel(), max: SUPPORTED_LEVELS.max };
      if (peer === undefined) {
        return Object.freeze({ level: syncLevel(ours, { level: 1, max: 1, name: "the peer, which has no handshake," }) });
      }
      const mismatch = (what: string, theirs: string, mine: string): CromDBError =>
        new CromDBError("SYNC_MISMATCH", `The peer has ${what} ${JSON.stringify(theirs)}, but this replica has ${JSON.stringify(mine)}`);
      if (peer.databaseId !== this.databaseId) {
        throw mismatch("database ID", peer.databaseId, this.databaseId);
      }
      if (peer.instanceId === this.instanceId) {
        throw new CromDBError("SYNC_MISMATCH", `The peer is this replica (${JSON.stringify(peer.instanceId)})`);
      }
      this.#requireActiveReplica(peer.instanceId, "The peer is");
      if (peer.conflictPolicy !== this.#conflictPolicy) {
        throw mismatch("conflict policy", peer.conflictPolicy, this.#conflictPolicy);
      }
      if (peer.unicodeVersion !== this.#unicodeVersion) {
        throw mismatch("Unicode version", peer.unicodeVersion, this.#unicodeVersion);
      }
      const level = syncLevel(ours, { level: peer.level, max: peer.levels.max, name: `replica ${JSON.stringify(peer.instanceId)}` });
      if (level >= PURGE_LEVEL && peer.lastSeq !== undefined) {
        // The peer knows more of this replica's log than it has: this
        // replica went back (restored, or copied).
        const knownOfMe = peer.knowledge?.[this.instanceId] ?? 0;
        if (knownOfMe > this.#adapter.lastSeq()) {
          return { level, rewound: knownOfMe };
        }
        // The peer saw an entry of this replica's log at a position where
        // this replica now has another, or none: it went back, then wrote or
        // pulled past where it was.
        for (const tip of peer.tips?.[this.instanceId] ?? []) {
          if (tip.seq > this.#adapter.lastSeq()) {
            return { level, rewound: tip.seq };
          }
          // An entry that is gone was removed by purge: nothing to compare.
          const mine = this.#entryAt(tip.seq);
          if (mine !== undefined && entryIdentity(mine.docId, mine.vectorClock, mine.timestamp) !== tip.entry) {
            return { level, rewound: tip.seq };
          }
        }
        // The peer's newest entry is at a position where it showed this
        // replica another before.
        const seen = this.#peerTips(peer.instanceId);
        if (peer.tip !== undefined && seen.some((tip) => tip.seq === peer.tip?.seq && tip.entry !== peer.tip.entry)) {
          throw this.#peerRewound(peer.instanceId, peer.tip.seq, peer.lastSeq);
        }
        // This replica holds more of the peer's log than the peer has.
        const held = this.#heldOf(peer.instanceId);
        if (held > peer.lastSeq) {
          throw this.#peerRewound(peer.instanceId, held, peer.lastSeq);
        }
      }
      // Check (i), early: see applyChanges.
      if (level >= PURGE_LEVEL && peer.horizons !== undefined) {
        const missing = uncovered(this.#knowledge(), peer.horizons, [this.instanceId]);
        if (missing.length > 0 && this.#hasDocuments()) {
          return { level, stale: missing };
        }
      }
      this.#adapter.setLocal(
        PEER_HELLO_PREFIX + peer.instanceId,
        JSON.stringify({
          maxLevel: peer.levels.max,
          engine: peer.engine,
          checkedAt: this.#now().toISOString(),
          ...(peer.tip === undefined ? {} : { tips: this.#withTip(this.#peerTips(peer.instanceId), peer.tip) }),
        }),
      );
      return { level };
    });
    if (checked.rewound !== undefined && peer !== undefined) {
      throw this.#markRewound(peer.instanceId, checked.rewound);
    }
    if (checked.stale !== undefined && peer !== undefined) {
      this.#markStale(peer.instanceId, peer.horizons ?? {});
      throw pullerStale(peer.instanceId, checked.stale);
    }
    return Object.freeze({ level: checked.level });
  }

  /** Records that this replica is stale, outside the refused call's transaction so it stays. */
  #markStale(source: string, required: SeqMap): void {
    this.#adapter.transaction(() => {
      this.#adapter.setLocal(STALE_KEY, JSON.stringify({ source, required, at: this.#now().toISOString() }));
    });
  }

  /**
   * The documents changed after position since in this replica's change log,
   * each once, as its current version. limit caps the number of documents.
   * Admin only: a batch holds every document, whoever its readers are, so an
   * admin who syncs gets every document even if the database's readers
   * leave them out.
   *
   * A level-1 database sends format 1, as 0.2.0 and 0.3.0 do. A database at
   * level 2 or higher sends format 2, which adds the level and this engine's
   * version.
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
      this.#requireSyncable();
      const { docIds, toSeq, hasMore } = selectChanges(this.#adapter.changesSince(since), since, limit);
      // A conflict row no longer needed is removed; whatever replaced it has
      // its own change entry.
      let documents = docIds.flatMap((id) => {
        const envelope = this.#adapter.getDocument(id);
        return envelope === undefined ? [] : [envelope];
      });
      const level = this.#rules.level;
      if (level >= PURGE_LEVEL) {
        // Every version of a document travels together, so a replica that
        // purged the document gets them all at once (see applyChanges).
        const grouped = new Map<string, DocumentEnvelope>();
        for (const envelope of documents) {
          const primaryId = envelope.conflictOf ?? envelope.id;
          const primary = envelope.kind === "document" ? this.#adapter.getDocument(primaryId) : undefined;
          for (const version of primary === undefined ? [envelope] : [primary, ...this.#adapter.conflictRows(primaryId)]) {
            grouped.set(version.id, version);
          }
        }
        documents = [...grouped.values()];
      }
      return {
        // A level-1 database sends format 1, exactly as 0.2.0 and 0.3.0 do.
        ...(level === 1
          ? { format: LEVEL_1_BATCH_FORMAT }
          : level < PURGE_LEVEL
            ? { format: BATCH_FORMAT, level, engine: VERSION }
            : { format: PURGE_BATCH_FORMAT, level, engine: VERSION, knowledge: this.#knowledge(), horizons: this.#horizons() }),
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
   * The batch must be at this replica's level: one from a replica at a higher
   * level is refused with UPGRADE_REQUIRED, and one at a lower level with
   * SYNC_MISMATCH, before anything is applied. So is a system document or
   * field this engine doesn't know, with UPGRADE_REQUIRED.
   *
   * The batch must come from a replica this one knows about, or it is
   * refused with SYNC_MISMATCH. A new replica can always sync with the one it
   * was copied from, and with the others once they have learned of it
   * through sync.
   */
  async applyChanges(batch: unknown): Promise<ApplyResult> {
    type Stale = { readonly stale: [string, number, number][]; readonly source: string; readonly required: SeqMap };
    type Rewound = { readonly rewound: number; readonly source: string };
    let source: string | undefined;
    const apply = (): ApplyResult | Stale | Rewound => {
      this.#requireAdmin("apply changes");
      this.#requireSyncable();
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

      const context = { databaseId: this.databaseId, unicodeVersion: this.#unicodeVersion, rules: this.#rules };
      const envelopes = documents.map((document) => validateEnvelope(document, context));
      const ids = new Set<string>();
      for (const envelope of envelopes) {
        if (ids.has(envelope.id)) {
          throw new CromDBError("INVALID_BATCH", `The batch has document ${JSON.stringify(envelope.id)} more than once`);
        }
        ids.add(envelope.id);
      }

      source = header.sourceInstanceId;
      const purging = header.level >= PURGE_LEVEL;
      if (purging) {
        // As checkPeer's: either log went back.
        const knownOfMe = header.knowledge[this.instanceId] ?? 0;
        if (knownOfMe > this.#adapter.lastSeq()) {
          return { rewound: knownOfMe, source };
        }
        const held = this.#heldOf(source);
        if (held > header.sourceLastSeq) {
          throw this.#peerRewound(source, held, header.sourceLastSeq);
        }
        // Check (i): this replica must hold everything below the source's
        // purge horizons, or it may keep documents whose deletions the source
        // has forgotten and so can't send. A replica holding no documents has
        // nothing to keep.
        const missing = uncovered(this.#knowledge(), header.horizons, [this.instanceId]);
        if (missing.length > 0 && this.#hasDocuments()) {
          return { stale: missing, source, required: header.horizons };
        }
        // Check (ii): the source must hold everything below this replica's
        // purge horizons, or its documents may include ones purged here.
        if (envelopes.some((envelope) => envelope.kind === "document")) {
          const sourceMissing = uncovered(header.knowledge, this.#horizons(), [source]);
          if (sourceMissing.length > 0) {
            throw sourceStale(source, sourceMissing);
          }
        }
      }

      let applied = 0;
      let skipped = 0;
      const ordered = [
        ...envelopes.filter((envelope) => envelope.kind === "system"),
        ...envelopes.filter((envelope) => envelope.kind === "document" && envelope.conflictOf === undefined),
        ...envelopes.filter((envelope) => envelope.conflictOf !== undefined),
      ];
      // A replica that has purged may get back versions of a document it
      // purged, carrying its own counters; that isn't a rewind. Every version
      // of a document comes in one batch at level 4 (see exportChanges), so
      // a document not here when the batch starts can't be checked, but its
      // versions all arrive before this replica could write to it again.
      const purged = (this.#horizons()[this.instanceId] ?? 0) > 0;
      const absent = new Set(
        purged ? ordered.map((envelope) => envelope.conflictOf ?? envelope.id).filter((id) => this.#adapter.getDocument(id) === undefined) : [],
      );
      for (const incoming of ordered) {
        if (this.#applyDocument(incoming, incoming.kind === "document" && absent.has(incoming.conflictOf ?? incoming.id))) {
          applied++;
        } else {
          skipped++;
        }
      }
      this.#adapter.setLocal(positionKey, formatPeerPosition(header.toSeq, this.#now().toISOString()));
      if (purging) {
        let knowledge = maxMerge(this.#knowledge(), { [source]: header.toSeq }, this.instanceId);
        // Only the last batch of a pull shows this replica now holds
        // everything the source held when it made the batch.
        if (!header.hasMore) {
          knowledge = maxMerge(maxMerge(knowledge, header.knowledge, this.instanceId), { [source]: header.sourceLastSeq });
        }
        this.#adapter.setLocal(KNOWLEDGE_KEY, JSON.stringify(knowledge));
        // What the source may lack, this replica now may lack too.
        this.#adapter.setLocal(HORIZONS_KEY, JSON.stringify(maxMerge(this.#horizons(), header.horizons)));
        this.#clearStaleIfCovered();
        this.#noteLog();
      }
      // A replica that receives its own registration retired stops for good.
      const own = this.#adapter.getDocument(registrationDocId(this.databaseId, this.instanceId));
      if (own !== undefined && own.content["status"] === "retired" && readBlocks(this.#adapter).retired === undefined) {
        this.#adapter.setLocal(RETIRED_KEY, JSON.stringify({ at: own.updatedAt }));
      }
      return { applied, skipped, toSeq: header.toSeq, hasMore: header.hasMore };
    };
    let outcome: ApplyResult | Stale | Rewound;
    try {
      outcome = this.#adapter.transaction(apply);
    } catch (error) {
      if (error instanceof OwnWriteMissing && source !== undefined) {
        this.#markRewound(source, 0);
        throw new CromDBError("REWIND_DETECTED", `${error.message}. It takes no more writes and doesn't sync: make a new replica from a ticket and recover from this one`);
      }
      throw error;
    }
    if ("rewound" in outcome) {
      throw this.#markRewound(outcome.source, outcome.rewound);
    }
    if ("stale" in outcome) {
      this.#markStale(outcome.source, outcome.required);
      throw pullerStale(outcome.source, outcome.stale);
    }
    return outcome;
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

  /**
   * Checks source's hello (see checkPeer), then pulls batches from it until
   * it has no more. Both sessions must be admins.
   */
  async pullFrom(source: Database): Promise<PullResult> {
    await this.checkPeer(await source.syncHello());
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

  /** The stored ACL and this session's grant under it. Never throws for access. */
  #access(): { loaded: AclWrite; grant: Grant } {
    this.#refreshLevel();
    const loaded = this.#loadAcl();
    return { loaded, grant: grantFor(this.#rules, this.session.principal, loaded.acl) };
  }

  /**
   * As #access, but throws ACCESS_DENIED unless the database admits this
   * session: every call but myAccess starts here, so being removed or locked
   * out takes effect on the next call.
   */
  #requireVisible(): { loaded: AclWrite; grant: Grant } {
    const access = this.#access();
    if (!access.grant.visible) {
      throw noAccess(this.session.principal);
    }
    return access;
  }

  /** Reads the level again, in case raiseLevel raised it through another Database. */
  #refreshLevel(): void {
    const level = this.#readLevel();
    if (level !== this.#level) {
      this.#level = level;
      this.#rules = rulesFor(level, this.#unicodeVersion);
    }
  }

  /**
   * Throws READ_ONLY if this replica takes no writes: a backup, a copy whose
   * log went back, a retired replica (all for good), or a stale one (until a
   * pull brings it up to date).
   */
  #requireWritable(): void {
    this.#requireNotBlocked();
    const stale = readStale(this.#adapter);
    if (stale !== undefined) {
      throw new CromDBError(
        "READ_ONLY",
        `This replica is stale and takes no writes: replica ${JSON.stringify(stale.source)} may have purged deletions it can't show it has. ` +
          "A pull from a replica that hasn't purged that far can bring it up to date, or make a new replica from a ticket",
      );
    }
  }

  /** Throws READ_ONLY for a backup, or a replica rewound or retired. */
  #requireNotBlocked(): void {
    const { backup, rewound, retired } = readBlocks(this.#adapter);
    if (backup !== undefined) {
      throw new CromDBError(
        "READ_ONLY",
        `This is a backup of replica ${JSON.stringify(backup.of)}, made at its position ${backup.lastSeq}, and takes no writes. Adopt it (openDatabase with { adopt: true }) if it is the only copy left, or recover from it into a new replica`,
      );
    }
    if (rewound !== undefined) {
      throw new CromDBError(
        "READ_ONLY",
        `This replica's change log went back (found syncing with replica ${JSON.stringify(rewound.detectedBy)}): it was restored or copied, and takes no writes. Make a new replica from a ticket and recover from this one`,
      );
    }
    if (retired !== undefined) {
      throw new CromDBError(
        "READ_ONLY",
        "This replica has been retired and takes no writes. Make a new replica from a ticket, and recover from this one if it holds anything the others don't",
      );
    }
  }

  /** Throws for a replica that doesn't sync: a backup or retired replica (SYNC_MISMATCH), one whose log went back (REWIND_DETECTED). */
  #requireSyncable(): void {
    const { backup, rewound, retired } = readBlocks(this.#adapter);
    if (backup !== undefined) {
      throw new CromDBError(
        "SYNC_MISMATCH",
        `This is a backup of replica ${JSON.stringify(backup.of)}, made at its position ${backup.lastSeq}, and doesn't sync. Adopt it if it is the only copy left, or recover from it into a new replica`,
      );
    }
    if (rewound !== undefined) {
      throw new CromDBError(
        "REWIND_DETECTED",
        `This replica's change log went back (found syncing with replica ${JSON.stringify(rewound.detectedBy)}): it was restored or copied, and doesn't sync. Make a new replica from a ticket and recover from this one`,
      );
    }
    if (retired !== undefined) {
      throw new CromDBError("SYNC_MISMATCH", "This replica has been retired and doesn't sync. Make a new replica from a ticket");
    }
  }

  /** Records that this replica's log went back, outside the refused call's transaction so it stays. */
  #markRewound(detectedBy: string, knownOfMe: number): CromDBError {
    const lastSeq = this.#adapter.lastSeq();
    this.#adapter.transaction(() => {
      this.#adapter.setLocal(REWOUND_KEY, JSON.stringify({ detectedBy, knownOfMe, lastSeq, at: this.#now().toISOString() }));
    });
    return new CromDBError(
      "REWIND_DETECTED",
      `Replica ${JSON.stringify(detectedBy)} knows this replica's change log as far as ${knownOfMe}, but it has only ${lastSeq}: this replica was restored from an old copy, or copied. It takes no more writes and doesn't sync. Make a new replica from a ticket and recover from this one`,
    );
  }

  /** REWIND_DETECTED for a peer whose log is behind what this replica already holds of it. */
  #peerRewound(peer: string, held: number, theirs: number): CromDBError {
    return new CromDBError(
      "REWIND_DETECTED",
      `This replica holds replica ${JSON.stringify(peer)}'s change log as far as ${held}, but it has only ${theirs}: it was likely restored or copied from an old file. Retire it, and make a new replica from a ticket`,
    );
  }

  /** Records the change log's end for purge (level 4 and above). Call after writing. */
  #noteLog(): void {
    noteLog(this.#adapter, this.#level, this.#now());
  }

  /** The change entry at seq, if it is still there. */
  #entryAt(seq: number): ChangeEntry | undefined {
    if (this.#adapter.changeAt !== undefined) {
      return this.#adapter.changeAt(seq);
    }
    const [first] = this.#adapter.changesSince(seq - 1);
    return first?.seq === seq ? first : undefined;
  }

  /** The tips of peer's hellos this replica checked, oldest first. */
  #peerTips(peer: string): LogTip[] {
    const stored = this.#adapter.getLocal(PEER_HELLO_PREFIX + peer);
    const tips = stored === undefined || stored === "" ? undefined : (JSON.parse(stored) as { tips?: LogTip[] }).tips;
    return Array.isArray(tips) ? tips : [];
  }

  /** tips with tip added as the newest, once, keeping the latest MAX_TIPS. */
  #withTip(tips: readonly LogTip[], tip: LogTip): LogTip[] {
    const kept = tips.filter((old) => old.seq !== tip.seq);
    return [...kept, { seq: tip.seq, entry: tip.entry }].slice(-MAX_TIPS);
  }

  /** This replica's tip, and the tips of the peers whose hellos it checked, for its own hello. */
  #tips(): { tip?: LogTip; tips: Readonly<Record<string, readonly LogTip[]>> } {
    const lastSeq = this.#adapter.lastSeq();
    const newest = lastSeq === 0 ? undefined : this.#entryAt(lastSeq);
    const tips: Record<string, readonly LogTip[]> = {};
    for (const registration of this.#registrations()) {
      const id = registration.content["instanceId"] as string;
      if (id === this.instanceId) {
        continue;
      }
      const seen = this.#peerTips(id);
      if (seen.length > 0) {
        tips[id] = Object.freeze(seen.map((tip) => Object.freeze({ seq: tip.seq, entry: tip.entry })));
      }
    }
    return {
      ...(newest === undefined ? {} : { tip: Object.freeze({ seq: lastSeq, entry: entryIdentity(newest.docId, newest.vectorClock, newest.timestamp) }) }),
      tips: Object.freeze(tips),
    };
  }

  /** How far this replica holds peer's log: its knowledge of it, or its sync position, whichever is further. */
  #heldOf(peer: string): number {
    return Math.max(this.#knowledge()[peer] ?? 0, parsePeerPosition(this.#adapter.getLocal(peerKey(peer)), peer));
  }

  /** For each other replica, how far into its change log this replica holds everything. */
  #knowledge(): SeqMap {
    return readLocalSeqMap(this.#adapter, KNOWLEDGE_KEY);
  }

  #horizons(): SeqMap {
    return readLocalSeqMap(this.#adapter, HORIZONS_KEY);
  }

  /** Whether this replica holds any document of kind "document", deleted or not. */
  #hasDocuments(): boolean {
    return this.#adapter.primaryDocuments().length > 0;
  }

  /** Clears the stale state once this replica's knowledge covers what was required. */
  #clearStaleIfCovered(): void {
    const stale = readStale(this.#adapter);
    if (stale !== undefined && uncovered(this.#knowledge(), stale.required, [this.instanceId]).length === 0) {
      this.#adapter.setLocal(STALE_KEY, "");
    }
  }

  /** The ACL, if this session is an admin. Throws ACCESS_DENIED otherwise. */
  #requireAdmin(action: string): AclWrite {
    const { loaded, grant } = this.#requireVisible();
    if (!grant.admin) {
      throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot ${action}; only admins can`);
    }
    return loaded;
  }

  /** What Document.myAccess reports for a document with these stored lists. Never throws for access. */
  #documentAccess(readers: readonly string[], writers: readonly string[]): { read: boolean; write: boolean } {
    const { grant } = this.#adapter.transaction(() => this.#access());
    return {
      read: grant.read && this.#rules.canAccess(this.session.principal, readers),
      write: grant.write && this.#rules.canAccess(this.session.principal, writers),
    };
  }

  /** Checks a batch fits this replica and comes from a replica it knows. */
  /**
   * Removes tombstones this replica recorded more than purgeAfterDays ago
   * (see getSettings), except those in a conflict, with their change
   * entries, and removes change entries superseded by a later entry for the
   * same document. Raises this replica's purge horizon to the newest entry
   * removed with a tombstone. Admin only, level 4 and above (NOT_SUPPORTED
   * below; raise a database with raiseLevel). Runs only when called: the
   * engine has no timers.
   *
   * A replica that hasn't pulled this replica's changes as far as the
   * horizon, directly or through others, is then refused as stale
   * (STALE_REPLICA) by pulls between the two, since it can't show it holds
   * the purged deletions. A replica that keeps pulling within purgeAfterDays
   * never is.
   *
   * The storage adapter needs changesFor and removeChanges (NOT_SUPPORTED
   * otherwise). The space freed stays in the storage until its compact().
   */
  async purge(): Promise<PurgeResult> {
    return this.#adapter.transaction(() => {
      this.#requireAdmin("purge the database");
      this.#requireNotBlocked();
      if (this.#level < PURGE_LEVEL) {
        throw new CromDBError(
          "NOT_SUPPORTED",
          `Purge needs a database at level ${PURGE_LEVEL} or higher; this one is at level ${this.#level}. A database with no other replicas can be raised with raiseLevel`,
        );
      }
      const adapter = this.#adapter;
      const changesFor = adapter.changesFor?.bind(adapter);
      const removeChanges = adapter.removeChanges?.bind(adapter);
      if (changesFor === undefined || removeChanges === undefined) {
        throw new CromDBError("NOT_SUPPORTED", "This storage adapter can't remove change entries (changesFor and removeChanges), which purge needs");
      }
      const { purgeAfterDays } = readSettings(adapter.getDocument(settingsDocId(this.databaseId)));
      const cutoff = this.#now().getTime() - purgeAfterDays * DAY_MS;
      const checkpoints = readCheckpoints(adapter);
      const candidate = purgeCandidate(checkpoints, cutoff);
      const horizons = this.#horizons();
      let horizon = horizons[this.instanceId] ?? 0;
      let tombstones = 0;
      let entries = 0;
      for (const primary of adapter.primaryDocuments()) {
        if (!primary.deleted || this.#isInConflict(primary)) {
          continue;
        }
        const seqs = changesFor(primary.id).map((entry) => entry.seq);
        if (!seqs.every((seq) => seq <= candidate)) {
          continue;
        }
        adapter.removeDocument(primary.id);
        removeChanges(seqs);
        tombstones++;
        entries += seqs.length;
        horizon = Math.max(horizon, ...seqs);
      }
      // A puller gets each document once, as its current version, for its
      // latest entry, so earlier entries for the same document send nothing.
      const stored = new Set(adapter.allDocuments().map((envelope) => envelope.id));
      const all = adapter.changesSince(0);
      const latest = new Map<string, number>();
      for (const entry of all) {
        if (stored.has(entry.docId)) {
          latest.set(entry.docId, entry.seq);
        }
      }
      const superseded = all.filter((entry) => latest.get(entry.docId) !== entry.seq).map((entry) => entry.seq);
      removeChanges(superseded);
      entries += superseded.length;
      if (horizon > 0) {
        adapter.setLocal(HORIZONS_KEY, JSON.stringify({ ...horizons, [this.instanceId]: horizon }));
      }
      adapter.setLocal(CHECKPOINTS_KEY, JSON.stringify(trimCheckpoints(checkpoints, cutoff)));
      return Object.freeze({ tombstones, entries, horizon });
    });
  }

  /** The database's settings, defaults included. Anyone the database admits can read them. */
  async getSettings(): Promise<DatabaseSettings> {
    return this.#adapter.transaction(() => {
      this.#requireVisible();
      return Object.freeze({ ...readSettings(this.#adapter.getDocument(settingsDocId(this.databaseId))) });
    });
  }

  /**
   * Saves the database's settings. Admin only, level 4 and above
   * (NOT_SUPPORTED below). TypeError for purgeAfterDays outside 1 to 3650.
   * The settings replicate; if two admins save them on two replicas before
   * those sync, the larger purgeAfterDays wins on every replica. Each
   * replica uses the new value from its next purge after the change reaches
   * it. Raising it never brings back what was purged.
   */
  async saveSettings(settings: DatabaseSettings): Promise<void> {
    if (typeof settings !== "object" || settings === null || !isPurgeAfterDays(settings.purgeAfterDays)) {
      throw new TypeError(`purgeAfterDays must be a whole number of days from ${PURGE_AFTER_DAYS_RANGE.min} to ${PURGE_AFTER_DAYS_RANGE.max}`);
    }
    const purgeAfterDays = settings.purgeAfterDays;
    this.#adapter.transaction(() => {
      const { acl } = this.#requireAdmin("change the database settings");
      if (this.#level < PURGE_LEVEL) {
        throw new CromDBError("NOT_SUPPORTED", `Settings need a database at level ${PURGE_LEVEL} or higher; this one is at level ${this.#level}`);
      }
      this.#requireWritable();
      const id = settingsDocId(this.databaseId);
      const admins = effectiveAdmins(this.#rules, acl);
      writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        this.#now().toISOString(),
        this.#adapter.getDocument(id),
        { id, parentId: id, kind: "system", deleted: false, readers: admins, writers: admins, content: { purgeAfterDays }, fieldTypes: {} },
        "put",
      );
      this.#noteLog();
    });
  }

  /**
   * Raises a level-3 database to level 4, which adds purge and settings
   * (see SUPPORTED_LEVELS), and returns the new level. Admin only. Only while
   * this is the database's one replica: NOT_SUPPORTED if it has registered
   * any other, and for a database at level 1 or 2. A database already at
   * level 4 is left as it is. Every Database of this storage uses the new
   * level from its next call; document and ACL versions change with the
   * level, so versions read before don't match afterwards. CromDB 0.6.0 and
   * earlier can't open the database afterwards.
   */
  async raiseLevel(): Promise<number> {
    return this.#adapter.transaction(() => {
      this.#requireAdmin("raise the database level");
      this.#requireNotBlocked();
      const level = this.#level;
      if (level >= PURGE_LEVEL) {
        return level;
      }
      if (level < ACCESS_STRUCTURE_LEVEL) {
        throw new CromDBError("NOT_SUPPORTED", `A database at level ${level} can't be raised; only level ${ACCESS_STRUCTURE_LEVEL} can, to ${PURGE_LEVEL}`);
      }
      if (this.#registrations().some((registration) => registration.content["instanceId"] !== this.instanceId)) {
        throw new CromDBError("NOT_SUPPORTED", "This database has other replicas; raising a database that has replicas is not available yet");
      }
      const id = databaseDocId(this.databaseId);
      const stored = this.#adapter.getDocument(id);
      if (stored === undefined || stored.kind !== "system") {
        throw new CromDBError("INVALID_DATABASE", "The database document is missing");
      }
      writeDocument(
        this.#adapter,
        this.instanceId,
        SYSTEM,
        this.#now().toISOString(),
        stored,
        { ...stored, content: { ...stored.content, level: PURGE_LEVEL } },
        "put",
      );
      this.#adapter.markLevel?.(PURGE_LEVEL);
      this.#refreshLevel();
      this.#noteLog();
      return PURGE_LEVEL;
    });
  }

  /** Whether this replica is stale, and its purge horizon. Anyone the database admits can read it. */
  async syncState(): Promise<SyncState> {
    return this.#adapter.transaction(() => {
      this.#requireVisible();
      const stale = readStale(this.#adapter);
      const blocks = readBlocks(this.#adapter);
      return Object.freeze({
        stale: stale !== undefined,
        ...(stale === undefined ? {} : { staleSource: stale.source }),
        purgedThrough: this.#horizons()[this.instanceId] ?? 0,
        ...(blocks.backup === undefined ? {} : { backupOf: blocks.backup.of }),
        rewound: blocks.rewound !== undefined,
        retired: blocks.retired !== undefined,
      });
    });
  }

  /**
   * Retires the replica with this instance ID: every replica that learns of
   * it, through sync, refuses that replica's hello and batches from then on,
   * and the replica itself, once it pulls its own registration, takes no
   * writes and no sync again. If two admins write the registration at once,
   * retired wins on every replica. It can't be undone; registrations are
   * never purged. Admin only, level 4 and above (NOT_SUPPORTED below).
   * NOT_FOUND for an instance ID this replica holds no registration of;
   * NOT_SUPPORTED for this replica itself (retire it from another one).
   * Retiring one already retired does nothing.
   *
   * Retire a replica only once the replicas it introduced have synced with
   * others: until they have, only it can vouch for them.
   */
  async retireReplica(instanceId: string): Promise<void> {
    if (typeof instanceId !== "string") {
      throw new TypeError(`retireReplica takes an instance ID, got ${typeof instanceId}`);
    }
    this.#adapter.transaction(() => {
      const { acl } = this.#requireAdmin("retire a replica");
      if (this.#level < PURGE_LEVEL) {
        throw new CromDBError("NOT_SUPPORTED", `Retiring a replica needs a database at level ${PURGE_LEVEL} or higher; this one is at level ${this.#level}`);
      }
      this.#requireWritable();
      if (instanceId === this.instanceId) {
        throw new CromDBError("NOT_SUPPORTED", "A replica can't retire itself; retire it from another replica");
      }
      const stored = this.#adapter.getDocument(registrationDocId(this.databaseId, instanceId));
      if (stored === undefined || stored.kind !== "system" || stored.content["instanceId"] !== instanceId) {
        throw new CromDBError("NOT_FOUND", `This replica holds no registration of replica ${JSON.stringify(instanceId)}`);
      }
      if (stored.content["status"] === "retired") {
        return;
      }
      const admins = effectiveAdmins(this.#rules, acl);
      writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        this.#now().toISOString(),
        stored,
        { id: stored.id, parentId: stored.parentId, kind: "system", deleted: false, readers: admins, writers: admins, content: { ...stored.content, status: "retired" }, fieldTypes: {} },
        "put",
      );
      this.#noteLog();
    });
  }

  /**
   * Copies this replica into target, an empty storage adapter, as a backup:
   * every stored row, this replica's own local state (its IDs, conflict
   * policy, what it knows of other replicas, purge horizons, and whether it
   * is stale), and a mark saying whose backup it is and how far its change
   * log went. Read in one transaction, so the copy is consistent. Admin
   * only, level 4 and above.
   *
   * A backup can be opened and read, but takes no writes (READ_ONLY) and
   * doesn't sync (SYNC_MISMATCH). Use it one of two ways: adopt it
   * (openDatabase with { adopt: true }) when it is the only copy left, or
   * recover from it into a new replica made from a ticket. The adapter's
   * markBackup makes the file one CromDB 0.7.0 and earlier refuse to open.
   * Its change log is made again, so its purge times start from now.
   */
  async backup(target: StorageAdapter): Promise<void> {
    if (!isAdapter(target)) {
      throw new TypeError("backup takes a storage adapter");
    }
    if (target === this.#adapter || !target.isEmpty()) {
      throw new CromDBError("INVALID_DATABASE", "The target for a backup must be empty");
    }
    const copy = this.#adapter.transaction(() => {
      this.#requireAdmin("back up the database");
      if (this.#level < PURGE_LEVEL) {
        throw new CromDBError("NOT_SUPPORTED", `A backup needs a database at level ${PURGE_LEVEL} or higher; this one is at level ${this.#level}`);
      }
      this.#requireNotBlocked();
      const local = [DATABASE_ID_KEY, INSTANCE_ID_KEY, CONFLICT_POLICY_KEY, HORIZONS_KEY, STALE_KEY].map((key) => [key, this.#adapter.getLocal(key)] as const);
      return { rows: this.#adapter.allDocuments(), local, knowledge: this.#knowledgeOfAll(), lastSeq: this.#adapter.lastSeq(), level: this.#level };
    });
    const now = this.#now();
    target.transaction(() => {
      if (!target.isEmpty()) {
        throw new CromDBError("INVALID_DATABASE", "The target for a backup must be empty");
      }
      for (const [key, value] of copy.local) {
        if (value !== undefined) {
          target.setLocal(key, value);
        }
      }
      target.markLevel?.(copy.level);
      for (const row of copy.rows) {
        target.putDocument(row);
        target.appendChange(replicatedChange(row));
      }
      target.setLocal(KNOWLEDGE_KEY, JSON.stringify(copy.knowledge));
      const seq = target.lastSeq();
      if (seq > 0) {
        target.setLocal(CHECKPOINTS_KEY, JSON.stringify(noteCheckpoint({ closed: [] }, seq, now.getTime())));
      }
      const mark: BackupMark = { of: this.instanceId, lastSeq: copy.lastSeq, at: now.toISOString(), engine: VERSION };
      target.setLocal(BACKUP_KEY, JSON.stringify(mark));
      target.markBackup?.(true);
    });
  }

  /** For each other replica, how far this replica holds its log: knowledge, or sync position, whichever is further. */
  #knowledgeOfAll(): SeqMap {
    const result: Record<string, number> = { ...this.#knowledge() };
    for (const registration of this.#registrations()) {
      const id = registration.content["instanceId"] as string;
      if (id !== this.instanceId) {
        const held = this.#heldOf(id);
        if (held > 0) {
          result[id] = held;
        }
      }
    }
    return result;
  }

  /**
   * Compares every document version on old, another copy of this database
   * (a replica's file that went back, or got stuck stale, or was retired; or
   * a backup), with what this replica holds, and keeps each version only old
   * has as a suspect, in this replica's local quarantine: never replicated,
   * never purged, there until a person accepts or discards it (see suspects).
   * Nothing is written to any document, and old is only read.
   *
   * Only user documents are compared: changes to the ACL, settings or
   * registrations made only on old are not recovered. Recovering again from
   * the same copy finds only versions it hasn't compared before, so nothing
   * discarded comes back. Admin only, both at level 4 or higher; old must hold
   * this database, and not be a copy of this replica (SYNC_MISMATCH). The
   * adapter needs the suspect methods (NOT_SUPPORTED otherwise).
   *
   * The usual order: make a new replica from a ticket, pull it up to date,
   * recover from the old copy, retire the old copy's instance ID, then go
   * through the suspects.
   */
  async recover(old: StorageAdapter): Promise<RecoverResult> {
    if (!isAdapter(old)) {
      throw new TypeError("recover takes a storage adapter");
    }
    if (old === this.#adapter) {
      throw new CromDBError("SYNC_MISMATCH", "recover takes another copy of this database, not this replica's own storage");
    }
    const description = describeDatabase(old);
    const rows = old.transaction(() => old.allDocuments());
    const recoveredAt = this.#now().toISOString();
    return this.#adapter.transaction(() => {
      this.#requireAdmin("recover from another copy");
      this.#requireNotBlocked();
      const putSuspect = this.#adapter.putSuspect?.bind(this.#adapter);
      const getSuspect = this.#adapter.getSuspect?.bind(this.#adapter);
      if (putSuspect === undefined || getSuspect === undefined || this.#adapter.suspects === undefined) {
        throw new CromDBError("NOT_SUPPORTED", "This storage adapter can't keep suspects (putSuspect, getSuspect and suspects), which recover needs");
      }
      if (this.#level < PURGE_LEVEL) {
        throw new CromDBError("NOT_SUPPORTED", `Recovering needs a database at level ${PURGE_LEVEL} or higher; this one is at level ${this.#level}`);
      }
      if (description === undefined || description.databaseId !== this.databaseId) {
        throw new CromDBError("SYNC_MISMATCH", "The old copy doesn't hold this database");
      }
      if (description.instanceId === this.instanceId) {
        throw new CromDBError("SYNC_MISMATCH", "The old copy is a copy of this replica itself; recover into a new replica");
      }
      if (description.level !== this.#level) {
        throw new CromDBError("NOT_SUPPORTED", `The old copy is at level ${description.level}, and this replica at level ${this.#level}`);
      }
      const byPrimary = new Map<string, DocumentEnvelope[]>();
      for (const row of rows) {
        if (row.kind !== "document") {
          continue;
        }
        const primaryId = row.conflictOf ?? row.id;
        const versions = byPrimary.get(primaryId) ?? [];
        if (row.conflictOf === undefined) {
          versions.unshift(row);
        } else {
          versions.push(row);
        }
        byPrimary.set(primaryId, versions);
      }
      let suspects = 0;
      let known = 0;
      let seen = 0;
      for (const primaryId of [...byPrimary.keys()].sort()) {
        const versions = byPrimary.get(primaryId) ?? [];
        const primary = versions.find((row) => row.conflictOf === undefined);
        const parentId = primary?.parentId ?? versions[0]?.parentId ?? primaryId;
        for (const { version, reason } of classify(versions, this.#versionsHere(primaryId))) {
          const key = suspectKey(primaryId, version);
          if (getSuspect(key) !== undefined) {
            seen++;
            continue;
          }
          const { conflictOf: _conflictOf, ...rest } = version;
          putSuspect({
            key,
            primaryId,
            state: reason === "known" ? "known" : "pending",
            reason,
            from: description.instanceId,
            recoveredAt,
            version: reason === "known" ? null : { ...rest, id: primaryId, parentId },
          });
          if (reason === "known") {
            known++;
          } else {
            suspects++;
          }
        }
      }
      return Object.freeze({ suspects, known, seen });
    });
  }

  /**
   * The pending suspects recover kept, ordered by key, at most limit (100 by
   * default) after the key after. Admin only: a suspect can hold any
   * document. See Suspect for accepting and discarding them.
   */
  async suspects<T extends Record<string, unknown> = Record<string, unknown>>(options: { limit?: number; after?: string } = {}): Promise<readonly Suspect<T>[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive whole number");
    }
    if (options.after !== undefined && typeof options.after !== "string") {
      throw new TypeError("after must be a suspect's key");
    }
    return this.#adapter.transaction(() => {
      this.#requireAdmin("read suspects");
      const list = this.#adapter.suspects?.bind(this.#adapter);
      if (list === undefined) {
        return [];
      }
      return list("pending", options.after, limit).map((stored) => {
        const version = stored.version as DocumentEnvelope;
        return new Suspect<T>(this.#suspectHost, stored, this.#toDocument<T>(version, true), this.#currentVersion(stored.primaryId));
      });
    });
  }

  /**
   * The pending suspect with this key, from Suspect.key, or undefined if
   * there is none: never recovered, or already accepted, discarded or
   * decided with another suspect of its document. Admin only, as suspects
   * is.
   */
  async suspect<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<Suspect<T> | undefined> {
    if (typeof key !== "string") {
      throw new TypeError(`suspect takes a suspect's key, got ${typeof key}`);
    }
    return this.#adapter.transaction(() => {
      this.#requireAdmin("read suspects");
      const stored = this.#adapter.getSuspect?.(key);
      if (stored === undefined || stored.state !== "pending" || stored.version === null) {
        return undefined;
      }
      const version = stored.version as DocumentEnvelope;
      return new Suspect<T>(this.#suspectHost, stored, this.#toDocument<T>(version, true), this.#currentVersion(stored.primaryId));
    });
  }

  /** Every version of the document stored here: its primary row and conflict rows. */
  #versionsHere(primaryId: string): DocumentEnvelope[] {
    const primary = this.#adapter.getDocument(primaryId);
    const rows = this.#adapter.conflictRows(primaryId);
    return primary === undefined || primary.kind !== "document" ? rows : [primary, ...rows];
  }

  /** One version string for everything stored here of the document, or undefined if nothing is. */
  #currentVersion(primaryId: string): string | undefined {
    const versions = this.#versionsHere(primaryId);
    return versions.length === 0 ? undefined : conflictVersion(versions.map(({ id, vectorClock }) => ({ id, vectorClock })), this.#level);
  }

  #suspectRecord(key: string): StoredSuspect {
    const stored = this.#adapter.getSuspect?.(key);
    if (stored === undefined || stored.state !== "pending" || stored.version === null) {
      throw new CromDBError("NOT_FOUND", `No pending suspect ${JSON.stringify(key)}`);
    }
    return stored;
  }

  #decideOthers(stored: StoredSuspect): void {
    const list = this.#adapter.suspects?.bind(this.#adapter);
    if (list === undefined) {
      return;
    }
    for (const other of list("pending", `${stored.primaryId}|`, Number.MAX_SAFE_INTEGER)) {
      if (other.primaryId !== stored.primaryId) {
        break;
      }
      if (other.key !== stored.key) {
        this.#adapter.putSuspect?.({ ...other, state: "superseded" });
      }
    }
  }

  #discardSuspect(key: string): void {
    this.#adapter.transaction(() => {
      this.#requireAdmin("discard a suspect");
      const stored = this.#suspectRecord(key);
      this.#adapter.putSuspect?.({ ...stored, state: "discarded" });
    });
  }

  #acceptSuspect(key: string, options: { ifVersion?: string; content?: Record<string, unknown>; readers?: unknown; writers?: unknown }): WriteResult {
    if (options.ifVersion !== undefined && typeof options.ifVersion !== "string") {
      throw new TypeError("ifVersion must be a string");
    }
    return this.#adapter.transaction(() => {
      this.#requireAdmin("accept a suspect");
      const stored = this.#suspectRecord(key);
      const version = stored.version as DocumentEnvelope;
      this.#requireWritable();
      const { grant } = this.#requireVisible();
      const primaryId = stored.primaryId;
      const here = this.#versionsHere(primaryId);
      const current = this.#currentVersion(primaryId);
      if (current !== options.ifVersion) {
        if (options.ifVersion === undefined) {
          throw new TypeError(`Accepting this suspect needs ifVersion: the suspect's current (${current})`);
        }
        throw new CromDBError("STALE_DOCUMENT", `Document ${JSON.stringify(primaryId)} has changed here since the suspect was read`);
      }
      if (options.content !== undefined && version.deleted) {
        throw new TypeError("acceptWithContent isn't for a deletion; use accept");
      }
      const stamped = this.#adapter.getDocument(primaryId);
      const primary = stamped !== undefined && stamped.kind === "document" ? stamped : undefined;
      const timestamp = this.#now().toISOString();
      if (here.length === 0 && version.deleted) {
        // A deletion of a document this replica doesn't have: nothing to write.
        this.#adapter.putSuspect?.({ ...stored, state: "accepted" });
        this.#decideOthers(stored);
        return Object.freeze({ editedThroughConflict: false });
      }
      // The access the same write would need here: a save of what is stored,
      // or a create of a document this replica doesn't have.
      if (primary !== undefined) {
        this.#checkCanWrite(primary, grant);
      } else if (!grant.create) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot create documents in this database`);
      }
      let body: EnvelopeBody;
      if (version.deleted) {
        body = {
          id: primaryId,
          parentId: primary?.parentId ?? version.parentId,
          kind: "document",
          deleted: true,
          deletedAt: timestamp,
          readers: primary?.readers ?? version.readers,
          writers: primary?.writers ?? version.writers,
          content: {},
          fieldTypes: {},
        };
      } else {
        const content = options.content === undefined ? { content: version.content, fieldTypes: version.fieldTypes } : encodeContent(options.content);
        const readers = this.#rules.accessList(options.readers ?? version.readers, "readers");
        const writers = this.#rules.accessList(options.writers ?? version.writers, "writers");
        this.#checkStaysWriter(writers);
        body = {
          id: primaryId,
          parentId: primary?.parentId ?? version.parentId,
          kind: "document",
          deleted: false,
          readers,
          writers,
          content: content.content,
          fieldTypes: content.fieldTypes,
        };
      }
      const clocks = here.map((row) => row.vectorClock);
      const base = clocks.reduce<VectorClock>((clock, next) => merge(clock, next), version.vectorClock);
      writeDocument(
        this.#adapter,
        this.instanceId,
        this.session.principal,
        timestamp,
        primary ?? { ...version, createdAt: version.createdAt, createdBy: version.createdBy },
        body,
        body.deleted ? "delete" : "put",
        writerClock(this.instanceId, base, clocks),
      );
      this.#arrange(primaryId, body.parentId);
      this.#noteLog();
      this.#adapter.putSuspect?.({ ...stored, state: "accepted" });
      this.#decideOthers(stored);
      return this.#writeResult(primaryId);
    });
  }

  /** Every registration stored here. */
  #registrations(): DocumentEnvelope[] {
    return this.#adapter.allDocuments().filter((envelope) => {
      const instanceId = envelope.kind === "system" && Object.hasOwn(envelope.content, "instanceId") ? envelope.content["instanceId"] : undefined;
      return typeof instanceId === "string" && envelope.id === registrationDocId(this.databaseId, instanceId);
    });
  }

  #checkBatchHeader(header: BatchHeader): void {
    const mismatch = (what: string, theirs: string, ours: string): CromDBError =>
      new CromDBError("SYNC_MISMATCH", `The batch has ${what} ${JSON.stringify(theirs)}, but this replica has ${JSON.stringify(ours)}`);
    if (header.databaseId !== this.databaseId) {
      throw mismatch("database ID", header.databaseId, this.databaseId);
    }
    const level = this.#rules.level;
    if (header.level > level) {
      throw new CromDBError(
        "UPGRADE_REQUIRED",
        `The batch is from a replica with this database at level ${header.level}, but this replica is at level ${level}, and raising a database needs a later engine; this replica must be upgraded`,
      );
    }
    if (header.level < level) {
      throw new CromDBError("SYNC_MISMATCH", `The batch is from a replica with this database at level ${header.level}, but this replica is at level ${level}`);
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
    this.#requireActiveReplica(source, "The batch comes from");
  }

  /** Throws SYNC_MISMATCH unless this replica holds an active registration for instanceId. */
  #requireActiveReplica(instanceId: string, subject: string): void {
    const registration = this.#adapter.getDocument(registrationDocId(this.databaseId, instanceId));
    const content = registration?.content;
    if (
      registration === undefined ||
      registration.kind !== "system" ||
      registration.deleted ||
      content === undefined ||
      !Object.hasOwn(content, "instanceId") ||
      content["instanceId"] !== instanceId
    ) {
      throw new CromDBError("SYNC_MISMATCH", `${subject} replica ${JSON.stringify(instanceId)}, which this replica does not know`);
    }
    if (!Object.hasOwn(content, "status") || content["status"] !== "active") {
      throw new CromDBError("SYNC_MISMATCH", `${subject} replica ${JSON.stringify(instanceId)}, which is not active`);
    }
  }

  /** The database level, from the stored database document. */
  #readLevel(): number {
    const envelope = this.#adapter.getDocument(databaseDocId(this.databaseId));
    if (envelope === undefined || envelope.kind !== "system") {
      throw new CromDBError("INVALID_DATABASE", "The database document is missing");
    }
    return readDatabaseLevel(envelope.content);
  }

  /** The highest level a peer said it supports in its last hello, if it has sent one. */
  #peerMaxLevel(instanceId: string): number | undefined {
    const stored = this.#adapter.getLocal(PEER_HELLO_PREFIX + instanceId);
    if (stored === undefined) {
      return undefined;
    }
    let maxLevel: unknown;
    try {
      const parsed: unknown = JSON.parse(stored);
      maxLevel = typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "maxLevel") ? (parsed as { maxLevel: unknown }).maxLevel : undefined;
    } catch {
      maxLevel = undefined;
    }
    if (!Number.isSafeInteger(maxLevel) || (maxLevel as number) < 1) {
      throw new CromDBError("INVALID_DATABASE", `The stored hello of replica ${JSON.stringify(instanceId)} is malformed`);
    }
    return maxLevel as number;
  }

  /**
   * Adds one validated incoming version. Returns false if skipped. forgotten:
   * the document may have been purged here (see applyChanges), so its
   * versions can carry counters of this replica's that it no longer has.
   */
  #applyDocument(incoming: DocumentEnvelope, forgotten: boolean): boolean {
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
    if (!forgotten) {
      this.#checkRewind(what, incoming, versions);
    }
    return this.#arrange(primaryId, stored?.parentId ?? incoming.parentId, incoming);
  }

  /**
   * System documents have one version. At level 4 and above, concurrent
   * versions of the settings and of a registration merge (see purge.ts);
   * for any other system document they are not supported yet.
   */
  #applySystemDocument(incoming: DocumentEnvelope, stored: DocumentEnvelope | undefined, what: string): boolean {
    this.#checkRewind(what, incoming, stored === undefined ? [] : [stored]);
    let version = incoming;
    if (stored !== undefined) {
      const order = compare(incoming.vectorClock, stored.vectorClock);
      if (order === "equal" || order === "before") {
        return false;
      }
      if (order === "concurrent") {
        const content = this.#mergeRule(incoming);
        if (content === undefined) {
          throw new CromDBError("NOT_SUPPORTED", `System ${what.toLowerCase()} was edited on both replicas; concurrent system document versions are not supported yet`);
        }
        if (!isAuthorizedVersion(incoming, this.#rules)) {
          throw new CromDBError(
            "NOT_SUPPORTED",
            `System ${what.toLowerCase()} was written by ${JSON.stringify(incoming.updatedBy)}, who is not in its writers; unauthorized system document versions are not supported yet`,
          );
        }
        version = mergeSystemVersions(stored, incoming, content);
      }
    }
    if (!isAuthorizedVersion(version, this.#rules)) {
      throw new CromDBError(
        "NOT_SUPPORTED",
        `System ${what.toLowerCase()} was written by ${JSON.stringify(incoming.updatedBy)}, who is not in its writers; unauthorized system document versions are not supported yet`,
      );
    }
    this.#putRow(version);
    return true;
  }

  /** How concurrent versions of this system document merge, or undefined if they don't. */
  #mergeRule(envelope: DocumentEnvelope): ((a: DocumentEnvelope, b: DocumentEnvelope) => DocumentEnvelope["content"]) | undefined {
    if (this.#rules.level < PURGE_LEVEL) {
      return undefined;
    }
    if (envelope.id === settingsDocId(this.databaseId)) {
      return mergeSettingsContent;
    }
    const instanceId = Object.hasOwn(envelope.content, "instanceId") ? envelope.content["instanceId"] : undefined;
    if (typeof instanceId === "string" && envelope.id === registrationDocId(this.databaseId, instanceId)) {
      return mergeRegistrationContent;
    }
    return undefined;
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
        throw new OwnWriteMissing(
          `${what} arrives with this replica's counter ${JSON.stringify(key)} at ${theirs}, but this replica has only reached ${ours}: another replica holds a write of this one that it doesn't have, so it was restored or copied`,
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
    const { primary, others } = arrange(incoming === undefined ? stored : [...stored, incoming], this.#policy, this.#rules);

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
    return this.#adapter.conflictRows(primary.id).length > 0 || !isAuthorizedVersion(primary, this.#rules);
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
      const { grant } = this.#requireVisible();
      if (!grant.read) {
        return undefined;
      }
      const rows = this.#adapter.conflictRows(primaryId).sort((a, b) => compareRank(this.#policy, this.#rules, a, b));
      if (rows.length === 0 && isAuthorizedVersion(primary, this.#rules)) {
        return undefined;
      }
      const all = [primary, ...rows];
      const versions = all
        .filter((version) => this.#rules.canAccess(this.session.principal, version.readers))
        .map((version) => ({
          rowId: version.id,
          version: {
            document: this.#toDocument<T>(version, true),
            isPrimary: version === primary,
            authorized: isAuthorizedVersion(version, this.#rules),
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
      this.#checkCanWrite(primary, this.#requireVisible().grant);
      this.#requireWritable();

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
        const readers = this.#rules.accessList(resolution.readers ?? primary.readers, "readers");
        const writers = this.#rules.accessList(resolution.writers ?? primary.writers, "writers");
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
      this.#noteLog();
      return this.#writeResult(primaryId);
    });
  }

  /** The stored ACL document and its lists. Throws INVALID_DATABASE if missing or malformed. */
  #loadAcl(): AclWrite {
    const envelope = this.#adapter.getDocument(aclDocId(this.databaseId));
    const acl = readAclDoc(envelope, this.#rules.level);
    return { envelope: envelope as DocumentEnvelope, acl };
  }

  /**
   * Checked against the stored ACL, not the new one, so nobody can add
   * themselves in the write being checked. The admin must also be in the new
   * admins and outside the new noAccess, so every save leaves at least one
   * admin who can sign in. Written as the admin, with the ACL document's
   * readers and writers set to the new admins outside noAccess. Below level
   * 3, readers, writers and noAccess can't change.
   */
  #saveAcl(loadedClock: VectorClock, lists: { readonly [type in keyof AccessLists]: unknown }): AclWrite {
    return this.#adapter.transaction(() => {
      const stored = this.#loadAcl();
      if (compare(stored.envelope.vectorClock, loadedClock) !== "equal") {
        throw new CromDBError("STALE_DOCUMENT", "The database ACL was saved since it was loaded");
      }
      const grant = grantFor(this.#rules, this.session.principal, stored.acl);
      if (!grant.visible) {
        throw noAccess(this.session.principal);
      }
      if (!grant.admin) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot edit the ACL of this database`);
      }
      this.#requireWritable();
      const level = this.#rules.level;
      const structured = level >= ACCESS_STRUCTURE_LEVEL;
      if (!structured) {
        for (const key of ["writers", "readers", "noAccess"] as const) {
          if (!sameList(lists[key], FILLED_IN_LISTS[key])) {
            throw new CromDBError(
              "NOT_SUPPORTED",
              `${key} can be changed only in a database at level ${ACCESS_STRUCTURE_LEVEL} or higher; this one is at level ${level}`,
            );
          }
        }
      }
      const valid: AclDocContent = {
        admins: this.#rules.accessList(lists.admins, "admins", "database"),
        creators: this.#rules.accessList(lists.creators, "creators", "database"),
        writers: structured ? this.#rules.accessList(lists.writers, "writers", "database") : [...FILLED_IN_LISTS.writers],
        readers: structured ? this.#rules.accessList(lists.readers, "readers", "database") : [...FILLED_IN_LISTS.readers],
        noAccess: structured ? this.#rules.accessList(lists.noAccess, "noAccess", "database") : [...FILLED_IN_LISTS.noAccess],
      };
      if (!this.#rules.canAccess(this.session.principal, valid.admins)) {
        throw new CromDBError(
          "ACCESS_DENIED",
          `${JSON.stringify(this.session.principal)} cannot remove themselves from admins; another admin must do it`,
        );
      }
      if (isLockedOut(this.#rules, this.session.principal, valid)) {
        throw new CromDBError("ACCESS_DENIED", `${JSON.stringify(this.session.principal)} cannot lock themselves out; another admin must do it`);
      }
      const admins = effectiveAdmins(this.#rules, valid);
      if (admins.length === 0) {
        throw new CromDBError("INVALID_ACCESS_LIST", "At least one admin must be outside noAccess");
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
          readers: admins,
          writers: admins,
          content: aclContent(valid, level),
          fieldTypes: {},
        },
        "put",
      );
      this.#noteLog();
      return { envelope, acl: valid };
    });
  }

  /** A live document, or conflict version, that the database's readers and its own let this session read. */
  #isReadableDocument(envelope: DocumentEnvelope | undefined, grant: Grant): envelope is DocumentEnvelope {
    return (
      envelope !== undefined &&
      envelope.kind === "document" &&
      !envelope.deleted &&
      grant.read &&
      this.#rules.canAccess(this.session.principal, envelope.readers)
    );
  }

  /** A deleted primary still in conflict, which this session can read. */
  #isDeletedInConflict(envelope: DocumentEnvelope | undefined, grant: Grant): envelope is DocumentEnvelope {
    return (
      envelope !== undefined &&
      envelope.kind === "document" &&
      envelope.deleted &&
      envelope.conflictOf === undefined &&
      grant.read &&
      this.#rules.canAccess(this.session.principal, envelope.readers) &&
      this.#isInConflict(envelope)
    );
  }

  /**
   * Checked against the stored lists, not the new ones, so nobody can add
   * themselves in the write being checked. Needs the database's writers and
   * the document's. Writing needs reading too: a creator left out of readers
   * can't keep writing through the object create returned.
   */
  #checkCanWrite(stored: DocumentEnvelope, grant: Grant): void {
    const principal = JSON.stringify(this.session.principal);
    if (!grant.write || !this.#rules.canAccess(this.session.principal, stored.writers)) {
      throw new CromDBError("ACCESS_DENIED", `${principal} cannot write document ${JSON.stringify(stored.id)}`);
    }
    if (!grant.read || !this.#rules.canAccess(this.session.principal, stored.readers)) {
      throw new CromDBError("ACCESS_DENIED", `${principal} cannot write document ${JSON.stringify(stored.id)}, which they can't read`);
    }
  }

  /**
   * A version whose writer isn't in its own writers is unauthorized on every
   * other replica, so a writer can't write themselves out.
   */
  #checkStaysWriter(writers: readonly string[]): void {
    if (!this.#rules.canAccess(this.session.principal, writers)) {
      throw new CromDBError(
        "ACCESS_DENIED",
        `${JSON.stringify(this.session.principal)} cannot remove themselves from writers; another writer must do it`,
      );
    }
  }

  /** Steps shared by save and delete: the stored document, unchanged since load, writable by this principal. */
  #loadForWrite(id: string, loadedClock: VectorClock): DocumentEnvelope {
    const { grant } = this.#requireVisible();
    this.#requireWritable();
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
    this.#checkCanWrite(stored, grant);
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
      const validReaders = this.#rules.accessList(readers, "readers");
      const validWriters = this.#rules.accessList(writers, "writers");
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
      this.#noteLog();
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
      this.#noteLog();
      return { envelope, result: this.#writeResult(stored.id) };
    });
  }
}
