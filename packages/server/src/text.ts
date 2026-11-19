// Small checks and conversions on text, with no I/O.

/** An email address in the form the server stores and compares: trimmed, NFC, lower case. */
export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}

/**
 * Why a normalized email address can't be used, or undefined. Deliberately
 * loose: one "@", something on each side, a dot in the domain, and no spaces
 * or control characters. The provider verifies the address; this only
 * catches typing mistakes.
 */
export function emailProblem(email: string): string | undefined {
  if (email.length === 0 || email.length > 320) {
    return "must be 1 to 320 characters";
  }
  if (/[\s\p{Cc}]/u.test(email)) {
    return "may not contain spaces or control characters";
  }
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    return 'must have one "@" with something on each side';
  }
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return "must have a domain such as example.com after the @";
  }
  return undefined;
}

/** Why a display text (a server name) can't be used, or undefined. */
export function nameProblem(name: string, max = 100): string | undefined {
  if (name.length === 0 || name.length > max) {
    return `must be 1 to ${max} characters`;
  }
  if (/\p{Cc}/u.test(name)) {
    return "may not contain control characters";
  }
  if (name.trim() !== name) {
    return "may not start or end with spaces";
  }
  return undefined;
}

/** The time as stored: an ISO string in the exact form toISOString writes. */
export function isoTime(date: Date): string {
  return date.toISOString();
}

/** Whether value is an ISO string in the exact form toISOString writes. */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/** Compares two stored times by the instants they name. */
export function compareTimes(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** Compares two strings by UTF-16 code units, the same everywhere. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
