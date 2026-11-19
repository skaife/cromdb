// Errors the API returns: { "error": { "code", "message", "details"? } }.

import { ERROR_STATUS, type ErrorCode } from "./schemas.js";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  get body(): { error: { code: string; message: string; details?: Readonly<Record<string, unknown>> } } {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
}
