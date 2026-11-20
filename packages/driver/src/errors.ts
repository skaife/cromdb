import type { JsonValue } from "./json.js";

/** Error codes an engine (cromdb) raises. A driver passes them on unchanged. */
export const ENGINE_ERROR_CODES = [
  "ACCESS_DENIED",
  "STALE_DOCUMENT",
  "NOT_FOUND",
  "INVALID_PRINCIPAL",
  "INVALID_ACCESS_LIST",
  "INVALID_DATABASE",
  "UPGRADE_REQUIRED",
  "SYNC_MISMATCH",
  "INVALID_BATCH",
  "INVALID_HANDSHAKE",
  "INVALID_TICKET",
  "REWIND_DETECTED",
  "READ_ONLY",
  "NOT_SUPPORTED",
  "STORAGE_LOCKED", // the storage is held by another connection or process
] as const;

/** Error codes of the driver interface itself. */
export const DRIVER_ERROR_CODES = [
  "INVALID_INPUT", // input isn't plain JSON, doesn't fit the operation's schema, or the engine refused an argument
  "UNKNOWN_HANDLE", // a handle never opened, or closed
  "ALREADY_OPEN", // storage already open under another handle
  "ALREADY_EXISTS", // database.create on storage that already holds something
  "NO_DATABASE", // database.open on storage that is missing or empty
  "INTERNAL", // anything else: a bug, an I/O error
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];
export type DriverOwnErrorCode = (typeof DRIVER_ERROR_CODES)[number];
export type KnownErrorCode = EngineErrorCode | DriverOwnErrorCode;

const KNOWN: ReadonlySet<string> = new Set<string>([...ENGINE_ERROR_CODES, ...DRIVER_ERROR_CODES]);

/** Whether this interface version lists the code. */
export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN.has(code);
}

export type ErrorDetails = Readonly<Record<string, JsonValue>>;

/**
 * Every error a driver call rejects with. code is a known code, or an engine
 * code this interface doesn't list yet, passed on exactly (details.known is
 * then false). details is plain JSON.
 */
export class DriverError extends Error {
  readonly code: KnownErrorCode | (string & {});
  readonly details: ErrorDetails | undefined;

  constructor(code: KnownErrorCode | (string & {}), message: string, details?: ErrorDetails) {
    super(message);
    this.name = "DriverError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details?: ErrorDetails } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * The DriverError for an error the engine raised with this code and message.
 * A code this interface doesn't list keeps its code and message exactly,
 * with details.known false, so it is never dropped or renamed away.
 */
export function engineError(code: string, message: string): DriverError {
  return isKnownErrorCode(code) ? new DriverError(code, message) : new DriverError(code, message, { known: false });
}
