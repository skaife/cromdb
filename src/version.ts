import { createHash } from "node:crypto";
import { canonicalString, type VectorClock } from "./vector-clock.js";

// Opaque version strings for callers that hold no Document between requests.
// Each is a SHA-256 hash, base64url without padding: 43 ASCII characters, safe
// in a URL and an HTTP header. Only equality is meaningful.

function hash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

/** The version of a document with this clock. Equal clocks give equal versions, on every replica. */
export function documentVersion(clock: VectorClock): string {
  return hash(`document:${canonicalString(clock)}`);
}

/** The version of a set of stored rows, each by its ID and clock, in any order. */
export function conflictVersion(rows: readonly { readonly id: string; readonly vectorClock: VectorClock }[]): string {
  const lines = rows.map((row) => `${row.id}=${canonicalString(row.vectorClock)}`).sort();
  return hash(`conflict:${lines.join("\n")}`);
}
