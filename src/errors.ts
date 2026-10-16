export type CromDBErrorCode =
  | "ACCESS_DENIED" // principal lacks the needed access
  | "STALE_DOCUMENT" // saved since this Document was loaded
  | "NOT_FOUND" // e.g. parentId doesn't resolve
  | "INVALID_PRINCIPAL"
  | "INVALID_ACCESS_LIST"
  | "INVALID_DATABASE" // local state or system docs inconsistent
  | "UPGRADE_REQUIRED"; // database needs a newer Unicode version than this engine has

export class CromDBError extends Error {
  readonly code: CromDBErrorCode;

  constructor(code: CromDBErrorCode, message: string) {
    super(message);
    this.name = "CromDBError";
    this.code = code;
  }
}
