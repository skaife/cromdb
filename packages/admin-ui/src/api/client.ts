// The one way the UI talks to the server: api(operation, input), typed from
// the route table (schema.ts).
//
// Same origin, with the session cookie; no token. The server's CSRF rule is
// Origin (or Sec-Fetch-Site) on anything but GET, which a fetch from this
// page passes as it is. A response's ETag comes back as version, to send as
// ifMatch on the write that changes the same thing. Any answer that isn't
// 2xx throws ApiError with the server's code; 401 also tells the listener
// set by onSessionEnded, so the page can say the session ended.

import { OPERATIONS, type Operations, type Schemas } from "./schema.ts";

export type OperationId = keyof Operations;
type Op<Id extends OperationId> = Operations[Id];
type Success<Id extends OperationId> = Op<Id>["responses"][Extract<keyof Op<Id>["responses"], 200 | 201 | 202 | 204>];

/** What a call takes: only the parts the operation has. */
export type Input<Id extends OperationId> = (Op<Id>["params"] extends Record<string, never> ? { params?: undefined } : { params: Op<Id>["params"] }) &
  (Op<Id>["query"] extends Record<string, never> ? { query?: undefined } : { query?: Op<Id>["query"] }) &
  (Op<Id>["body"] extends undefined ? { body?: undefined } : { body: Op<Id>["body"] }) &
  (Op<Id>["ifMatch"] extends true ? { ifMatch: string } : { ifMatch?: undefined });

export interface Result<T> {
  readonly status: number;
  readonly data: T;
  /** The ETag's version, without quotes, when the server sent one. */
  readonly version: string | undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let sessionEnded: (() => void) | undefined;

/** Who to tell when a call is refused because the session ended (401). */
export function onSessionEnded(listener: (() => void) | undefined): void {
  sessionEnded = listener;
}

/** The path with its parameters filled in, each encoded. */
export function fillPath(path: string, params: Readonly<Record<string, string>> | undefined): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) throw new Error(`No value for {${name}} in ${path}`);
    return encodeURIComponent(value);
  });
}

function queryString(query: Readonly<Record<string, unknown>> | undefined): string {
  if (query === undefined) return "";
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) search.set(name, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

function errorFrom(status: number, body: unknown): ApiError {
  const error = typeof body === "object" && body !== null && Object.hasOwn(body, "error") ? (body as Schemas["Error"]).error : undefined;
  if (error === undefined || typeof error.code !== "string") {
    return new ApiError(status, status >= 500 ? "INTERNAL" : "UNKNOWN", `The server answered ${status}`);
  }
  return new ApiError(status, error.code, error.message, error.details);
}

/** Calls an API operation. Throws ApiError for any answer that isn't 2xx, and for no answer (code NETWORK). */
export async function api<Id extends OperationId>(id: Id, input: Input<Id>, fetchImpl: typeof fetch = fetch): Promise<Result<Success<Id>>> {
  const operation = OPERATIONS[id];
  const { params, query, body, ifMatch } = input as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; ifMatch?: string };
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (ifMatch !== undefined) headers["if-match"] = `"${ifMatch}"`;
  let response: Response;
  try {
    response = await fetchImpl(`${fillPath(operation.path, params)}${queryString(query)}`, {
      method: operation.method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "The server can't be reached. Check the connection and try again.");
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const error = errorFrom(response.status, parsed);
    if (response.status === 401) sessionEnded?.();
    throw error;
  }
  const etag = response.headers.get("etag");
  const match = etag === null ? null : /^"([^"]*)"$/.exec(etag);
  return { status: response.status, data: parsed as Success<Id>, version: match?.[1] };
}
