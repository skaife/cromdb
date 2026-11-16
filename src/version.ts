import { createHash } from "node:crypto";
import { canonicalString, type VectorClock } from "./vector-clock.js";

// Opaque version strings for callers that hold no Document between requests.
// Each is a SHA-256 hash, base64url without padding: 43 ASCII characters, safe
// in a URL and an HTTP header. Only equality is meaningful.

function hash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

// At level 2 and above the level is part of what is hashed, so a version
// string from one level never equals one from another. Level 1 keeps the
// form 0.2.0 and 0.3.0 use, so their replicas show the same versions.
function prefix(kind: string, level: number): string {
  return level === 1 ? `${kind}:` : `${kind}:L${level}:`;
}

/** The version of a document with this clock, in a database at this level. Equal clocks give equal versions, on every replica. */
export function documentVersion(clock: VectorClock, level: number): string {
  return hash(`${prefix("document", level)}${canonicalString(clock)}`);
}

/** The version of a set of stored rows, each by its ID and clock, in any order, in a database at this level. */
export function conflictVersion(rows: readonly { readonly id: string; readonly vectorClock: VectorClock }[], level: number): string {
  const lines = rows.map((row) => `${row.id}=${canonicalString(row.vectorClock)}`).sort();
  return hash(`${prefix("conflict", level)}${lines.join("\n")}`);
}
