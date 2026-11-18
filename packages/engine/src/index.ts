export { SUPPORTED_LEVELS, VERSION } from "./engine.js";

export { Session, type SessionKind } from "./session.js";
export type { Database, DatabaseAccess, ReplicaInfo } from "./database.js";
export type { Document, DocumentAccess, WriteResult } from "./document.js";
export type { Conflict, ConflictVersion } from "./conflict-object.js";
export type { DocumentSet } from "./document-set.js";
export type { FindFilter, FindOptions } from "./find-filter.js";
export type { PeerCheck, SyncHello } from "./handshake.js";
export type { Acl } from "./acl-document.js";
export type { ReplicaTicket } from "./ticket.js";
export { sync, type ApplyResult, type ChangeBatch, type PullResult } from "./replication.js";
export { CromDBError, type CromDBErrorCode } from "./errors.js";
export { SqliteAdapter } from "./storage/sqlite-adapter.js";
export type { StorageAdapter } from "./storage/adapter.js";
export type { ChangeEntry, ChangeOp, DocumentEnvelope, DocumentKind } from "./envelope.js";
export type { VectorClock } from "./vector-clock.js";
