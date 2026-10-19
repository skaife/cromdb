export type CromDBErrorCode =
  | "ACCESS_DENIED" // principal lacks the needed access
  | "STALE_DOCUMENT" // saved since this Document was loaded
  | "NOT_FOUND" // e.g. parentId doesn't resolve
  | "INVALID_PRINCIPAL"
  | "INVALID_ACCESS_LIST"
  | "INVALID_DATABASE" // local state or system docs inconsistent
  | "UPGRADE_REQUIRED" // database needs a newer Unicode version or conflict policy than this engine has
  | "SYNC_MISMATCH" // a batch doesn't fit this replica: other database, policy, version, sender or position
  | "INVALID_BATCH" // a batch or one of its documents is malformed
  | "REWIND_DETECTED" // a batch carries a write stamped with this replica's ID that it never made
  | "NOT_SUPPORTED"; // valid, but not handled yet (conflicts, conflict documents)

export class CromDBError extends Error {
  readonly code: CromDBErrorCode;

  constructor(code: CromDBErrorCode, message: string) {
    super(message);
    this.name = "CromDBError";
    this.code = code;
  }
}
