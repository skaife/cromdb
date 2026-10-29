// Two-way sync with a peer over HTTP: the same loop as
// examples/custom-transport.ts, with fetch as the transport.

import type { ApplyResult, Database } from "cromdb";
import { HttpError, readErrorBody } from "./errors.ts";

export interface Peer {
  readonly name: string;
  readonly url: string;
}

export interface Transfer {
  readonly applied: number;
  readonly skipped: number;
  readonly batches: number;
}

export interface SyncResult {
  readonly peer: string;
  /** Changes from the peer, applied here. */
  readonly pulled: Transfer;
  /** Changes from here, applied on the peer. */
  readonly pushed: Transfer;
}

// A peer that doesn't answer within this is reported unreachable.
const TIMEOUT_MS = 3000;

/** Why a request got no answer: a timeout, or the network error fetch wraps (e.g. ECONNREFUSED). */
function reasonFor(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return `no answer within ${TIMEOUT_MS} ms`;
  }
  const { cause } = error;
  if (cause instanceof Error) {
    return "code" in cause && typeof cause.code === "string" ? cause.code : cause.message;
  }
  return error.message;
}

/** Sends one request to the peer and returns its JSON answer. Peer errors become HttpErrors. */
async function call(peer: Peer, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  let answer: unknown;
  try {
    response = await fetch(new URL(path, peer.url), {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    answer = await response.json();
  } catch (error) {
    throw new HttpError(502, "PEER_UNREACHABLE", `Replica ${peer.name} at ${peer.url} is unreachable: ${reasonFor(error)}`, peer.name);
  }
  if (!response.ok) {
    const error = readErrorBody(answer);
    if (error?.code === "OFFLINE") {
      throw new HttpError(502, "PEER_OFFLINE", `Replica ${peer.name} is offline`, peer.name);
    }
    throw new HttpError(
      502,
      error?.code ?? "PEER_ERROR",
      `Replica ${peer.name} answered ${response.status}: ${error?.message ?? ""}`,
      peer.name,
    );
  }
  return answer;
}

/** The peer's instance ID, and how far it has applied the changes of replica sourceInstanceId. */
async function peerPosition(peer: Peer, sourceInstanceId: string): Promise<{ instanceId: string; position: number }> {
  const answer = await call(peer, `/sync/position?source=${encodeURIComponent(sourceInstanceId)}`);
  if (
    typeof answer !== "object" ||
    answer === null ||
    !("instanceId" in answer) ||
    typeof answer.instanceId !== "string" ||
    !("position" in answer) ||
    typeof answer.position !== "number"
  ) {
    throw new HttpError(502, "PEER_ERROR", `Replica ${peer.name} sent a malformed position`, peer.name);
  }
  return { instanceId: answer.instanceId, position: answer.position };
}

/** Pulls the peer's changes into db, then pushes db's changes to the peer. db's session must be an admin. */
export async function syncWith(db: Database, peer: Peer): Promise<SyncResult> {
  const { instanceId: peerInstanceId } = await peerPosition(peer, db.instanceId);

  const pulled = { applied: 0, skipped: 0, batches: 0 };
  for (;;) {
    const since = await db.syncPosition(peerInstanceId);
    const batch = await call(peer, `/sync/changes?since=${since}`);
    const result = await db.applyChanges(batch);
    pulled.batches++;
    pulled.applied += result.applied;
    pulled.skipped += result.skipped;
    if (!result.hasMore) {
      break;
    }
  }

  const pushed = { applied: 0, skipped: 0, batches: 0 };
  for (;;) {
    const { position } = await peerPosition(peer, db.instanceId);
    const batch = await db.exportChanges({ since: position });
    // The peer checks the batch with applyChanges and answers its ApplyResult.
    const result = (await call(peer, "/sync/changes", batch)) as ApplyResult;
    pushed.batches++;
    pushed.applied += result.applied;
    pushed.skipped += result.skipped;
    if (result.hasMore !== true) {
      break;
    }
  }

  return { peer: peer.name, pulled, pushed };
}
