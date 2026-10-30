// Calls one replica's /api, on its own port.

import type { ConflictAnswer, Info, Note, ReplicaRef, SyncAnswer } from "./types.ts";

/** An error answer, or NOT_RUNNING when the replica didn't answer at all. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The replica that raised it. */
  readonly replica: string;

  constructor(status: number, code: string, message: string, replica: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.replica = replica;
  }
}

async function call<T>(replica: ReplicaRef, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<T> {
  let response: Response;
  let answer: unknown;
  try {
    response = await fetch(replica.url + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    answer = await response.json();
  } catch {
    throw new ApiError(0, "NOT_RUNNING", `Replica ${replica.name} is not running`, replica.name);
  }
  if (!response.ok) {
    const error = (answer as { error?: { code?: string; message?: string; replica?: string } }).error ?? {};
    throw new ApiError(response.status, error.code ?? "UNKNOWN", error.message ?? "", error.replica ?? replica.name);
  }
  return answer as T;
}

export function api(replica: ReplicaRef) {
  return {
    info: () => call<Info>(replica, "GET", "/api/info"),
    notes: async () => (await call<{ notes: Note[] }>(replica, "GET", "/api/notes")).notes,
    setOnline: (online: boolean) => call<Info>(replica, "POST", "/api/online", { online }),
    create: (title: string, text: string) => call<{ note: Note }>(replica, "POST", "/api/notes", { title, text }),
    save: (id: string, title: string, text: string, version: string) =>
      call<{ note: Note; editedThroughConflict: boolean }>(replica, "PUT", `/api/notes/${encodeURIComponent(id)}`, {
        title,
        text,
        version,
      }),
    remove: (id: string, version: string) =>
      call<{ editedThroughConflict: boolean }>(replica, "DELETE", `/api/notes/${encodeURIComponent(id)}`, { version }),
    conflict: (id: string) => call<ConflictAnswer>(replica, "GET", `/api/notes/${encodeURIComponent(id)}/conflict`),
    resolve: (id: string, choice: { version: string } & ({ with: number } | { content: { title: string; text: string } } | { delete: true })) =>
      call<{ note: Note | null }>(replica, "POST", `/api/notes/${encodeURIComponent(id)}/resolve`, choice),
    // A sync waits up to 3 s for each request to the peer, so allow longer.
    sync: (peer: string) => call<SyncAnswer>(replica, "POST", "/api/sync", { peer }, 15_000),
  };
}
