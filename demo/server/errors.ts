import { CromDBError, type CromDBErrorCode } from "cromdb";

/**
 * What every error response holds. code is a CromDB error code or one of the
 * demo's own (OFFLINE, PEER_OFFLINE, PEER_UNREACHABLE, ...). replica names
 * the replica where it happened.
 */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly replica: string };
}

/** An error with the HTTP status and code to answer with. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Set when another replica raised it. */
  readonly replica: string | undefined;

  constructor(status: number, code: string, message: string, replica?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.replica = replica;
  }
}

const CROMDB_STATUS: Record<CromDBErrorCode, number> = {
  ACCESS_DENIED: 403,
  STALE_DOCUMENT: 409,
  NOT_FOUND: 404,
  INVALID_PRINCIPAL: 400,
  INVALID_ACCESS_LIST: 400,
  INVALID_DATABASE: 500,
  UPGRADE_REQUIRED: 409,
  SYNC_MISMATCH: 409,
  INVALID_BATCH: 400,
  REWIND_DETECTED: 409,
  READ_ONLY: 409,
  NOT_SUPPORTED: 501,
};

/** The status and body for any error a handler throws, raised on replica here unless it says otherwise. */
export function toErrorResponse(error: unknown, here: string): { status: number; body: ErrorBody } {
  const answer = (status: number, code: string, message: string, replica = here) => ({
    status,
    body: { error: { code, message, replica } },
  });
  if (error instanceof HttpError) {
    return answer(error.status, error.code, error.message, error.replica);
  }
  if (error instanceof CromDBError) {
    return answer(CROMDB_STATUS[error.code], error.code, error.message);
  }
  // CromDB throws TypeError for arguments of the wrong shape.
  if (error instanceof TypeError) {
    return answer(400, "BAD_REQUEST", error.message);
  }
  // Express's JSON parser marks a malformed body with a 4xx status.
  if (error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500) {
    return answer(error.status, "BAD_REQUEST", error.message);
  }
  return answer(500, "INTERNAL", error instanceof Error ? error.message : String(error));
}

export function readErrorBody(value: unknown): ErrorBody["error"] | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const { error } = value;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  const replica = "replica" in error && typeof error.replica === "string" ? error.replica : "";
  return { code, message, replica };
}
