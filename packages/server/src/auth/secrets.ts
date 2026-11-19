// Random identifiers for cookies, and how the server stores them: only as
// hashes, so a copy of the server database gives no working cookie.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url: a session or login ID. */
export function randomId(): string {
  return randomBytes(32).toString("base64url");
}

/** The SHA-256 of an ID, hex: what is stored and looked up. */
export function hashId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/** Compares two strings in time that doesn't depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
