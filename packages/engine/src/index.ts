export { SUPPORTED_LEVELS, VERSION } from "./engine.js";

export { Session, type SessionKind } from "./session.js";
export {
  describeDatabase,
  type Database,
  type DatabaseAccess,
  type DatabaseDescription,
  type DatabaseSettings,
  type PurgeResult,
  type ReplicaInfo,
  type SyncState,
} from "./database.js";
export type { Document, DocumentAccess, WriteResult } from "./document.js";
export type { Conflict, ConflictVersion } from "./conflict-object.js";
export type { DocumentSet } from "./document-set.js";
export type { FindFilter, FindOptions } from "./find-filter.js";
export type { PeerCheck, SyncHello } from "./handshake.js";
export type { Acl } from "./acl-document.js";
export { ACCESS_TYPES, type AccessLists, type AccessType } from "./access.js";
export type { ReplicaTicket } from "./ticket.js";
export { sync, type ApplyResult, type ChangeBatch, type PullResult } from "./replication.js";
export { CromDBError, type CromDBErrorCode } from "./errors.js";
export { SqliteAdapter } from "./storage/sqlite-adapter.js";
export type { StorageAdapter } from "./storage/adapter.js";
export type { ChangeEntry, ChangeOp, DocumentEnvelope, DocumentKind } from "./envelope.js";
export type { VectorClock } from "./vector-clock.js";
export type { SeqMap } from "./purge.js";
