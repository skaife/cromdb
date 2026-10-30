export const VERSION = "0.1.1";

export { Session } from "./session.js";
export type { Database, DatabaseAccess, ReplicaInfo } from "./database.js";
export type { Document, DocumentAccess, WriteResult } from "./document.js";
export type { Conflict, ConflictVersion } from "./conflict-object.js";
export type { DocumentSet } from "./document-set.js";
export type { FindFilter } from "./find-filter.js";
export type { Acl } from "./acl-document.js";
export { sync, type ApplyResult, type ChangeBatch, type PullResult } from "./replication.js";
export { CromDBError, type CromDBErrorCode } from "./errors.js";
export { SqliteAdapter } from "./storage/sqlite-adapter.js";
export type { StorageAdapter } from "./storage/adapter.js";
export type { ChangeEntry, ChangeOp, DocumentEnvelope, DocumentKind } from "./envelope.js";
export type { VectorClock } from "./vector-clock.js";
