export const VERSION = "0.0.1";

export { Session } from "./session.js";
export type { Database, DatabaseAccess } from "./database.js";
export type { Document, DocumentAccess } from "./document.js";
export type { Acl } from "./acl-document.js";
export { CromDBError, type CromDBErrorCode } from "./errors.js";
export { SqliteAdapter } from "./storage/sqlite-adapter.js";
export type { StorageAdapter } from "./storage/adapter.js";
export type { ChangeEntry, ChangeOp, DocumentEnvelope, DocumentKind } from "./envelope.js";
