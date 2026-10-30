import type { DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
import { fold } from "./unicode/fold.js";
import type { GeneralCategory } from "./unicode/general-category.js";
import { ageOf, generalCategoryOf } from "./unicode/properties.js";
import { compareUnicodeVersions } from "./unicode/version.js";

export const SYSTEM = "system";
export const ANONYMOUS = "anonymous";
export const EVERYONE = "*";

// Names are stored in NFKC form as written and compared by canonical form,
// so "Scott Skaife" and "scott skaife" are the same principal.
export function canonicalName(s: string): string {
  return fold(s.normalize("NFKC")).normalize("NFKC");
}

// Refused anywhere in a name: control, format (zero-width space, soft hyphen),
// lone surrogate, private use, unassigned or noncharacter, and line and
// paragraph separators. Space separators other than U+0020 are refused too.
const FORBIDDEN_CATEGORIES: ReadonlySet<GeneralCategory> = new Set(["Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"]);

/** Returns why a code point can't be in a name (checked on the NFKC form), or undefined. */
function categoryProblem(codePoint: number): string | undefined {
  const category = generalCategoryOf(codePoint);
  if (category !== undefined && FORBIDDEN_CATEGORIES.has(category)) {
    return "contains a control, format, surrogate, private use, unassigned, or line separator character";
  }
  if (category === "Zs" && codePoint !== 0x20) {
    return "contains a space character other than U+0020";
  }
  return undefined;
}

function isAssignedIn(codePoint: number, unicodeVersion: string): boolean {
  const age = ageOf(codePoint);
  return age !== undefined && compareUnicodeVersions(age, unicodeVersion) <= 0;
}

/**
 * Returns why the name is invalid, or undefined. Every code point of the name
 * as given, and of its NFKC form, must be assigned in the given version, so
 * the answer doesn't depend on the Unicode version of Node's normalize().
 */
function principalNameProblem(name: string, normalized: string, unicodeVersion: string): string | undefined {
  if (normalized === "") {
    return "is empty";
  }
  for (const char of normalized) {
    const problem = categoryProblem(char.codePointAt(0) as number);
    if (problem !== undefined) {
      return problem;
    }
  }
  for (const text of [name, normalized]) {
    for (const char of text) {
      if (!isAssignedIn(char.codePointAt(0) as number, unicodeVersion)) {
        return `contains a character not assigned in Unicode ${unicodeVersion}`;
      }
    }
  }
  if (normalized.startsWith(" ") || normalized.endsWith(" ")) {
    return "has leading or trailing space";
  }
  if (normalized.includes("  ")) {
    return "has two spaces in a row";
  }
  const canonical = canonicalName(normalized);
  if (canonical === EVERYONE || canonical === SYSTEM || canonical === ANONYMOUS) {
    return "is reserved";
  }
  if (normalized.startsWith("[")) {
    return 'starts with "[", which is reserved for roles';
  }
  return undefined;
}

/**
 * For a named (app) principal. Every character must be assigned in the given
 * Unicode version. Returns the NFKC form of the name.
 */
export function validatePrincipalName(name: unknown, unicodeVersion: string): string {
  if (typeof name !== "string") {
    throw new CromDBError("INVALID_PRINCIPAL", `Principal name must be a string, got ${typeof name}`);
  }
  const normalized = name.normalize("NFKC");
  const problem = principalNameProblem(name, normalized, unicodeVersion);
  if (problem !== undefined) {
    throw new CromDBError("INVALID_PRINCIPAL", `Principal name ${JSON.stringify(name)} ${problem}`);
  }
  return normalized;
}

export const MAX_REPLICA_NAME_LENGTH = 100;

/**
 * Returns why a replica name is invalid, or undefined. normalized is its NFKC
 * form. A name is a display label, not a principal: 1 to 100 code points,
 * the characters a principal name refuses refused here too, and no leading
 * or trailing space.
 */
export function replicaNameProblem(name: string, normalized: string, unicodeVersion: string): string | undefined {
  const length = [...normalized].length;
  if (length === 0 || length > MAX_REPLICA_NAME_LENGTH) {
    return `must be 1 to ${MAX_REPLICA_NAME_LENGTH} characters`;
  }
  for (const char of normalized) {
    const problem = categoryProblem(char.codePointAt(0) as number);
    if (problem !== undefined) {
      return problem;
    }
  }
  for (const text of [name, normalized]) {
    for (const char of text) {
      if (!isAssignedIn(char.codePointAt(0) as number, unicodeVersion)) {
        return `contains a character not assigned in Unicode ${unicodeVersion}`;
      }
    }
  }
  if (normalized.startsWith(" ") || normalized.endsWith(" ")) {
    return "has leading or trailing space";
  }
  return undefined;
}

/** For a name given to createReplica or openDatabase. Returns its NFKC form; TypeError if invalid. */
export function validateReplicaName(name: unknown, unicodeVersion: string): string {
  if (typeof name !== "string") {
    throw new TypeError(`A replica name must be a string, got ${typeof name}`);
  }
  const normalized = name.normalize("NFKC");
  const problem = replicaNameProblem(name, normalized, unicodeVersion);
  if (problem !== undefined) {
    throw new TypeError(`Replica name ${JSON.stringify(name)} ${problem}`);
  }
  return normalized;
}

export type AccessListField ="readers" | "writers" | "creators" | "admins";

/**
 * Returns a copy with every entry in NFKC form. creators may be empty, which
 * stops anyone creating documents. admins must name principals: "*" and
 * "anonymous" are refused there.
 */
export function validateAccessList(list: unknown, field: AccessListField, unicodeVersion: string): readonly string[] {
  const allowEmpty = field === "creators";
  const allowSpecial = field !== "admins";
  if (!Array.isArray(list) || (!allowEmpty && list.length === 0)) {
    const requirement = allowEmpty ? "an array" : "an array with at least one entry";
    throw new CromDBError("INVALID_ACCESS_LIST", `${field} must be ${requirement}`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of list as unknown[]) {
    if (typeof entry !== "string") {
      throw new CromDBError("INVALID_ACCESS_LIST", `${field} entries must be strings, got ${typeof entry}`);
    }
    const normalized = entry.normalize("NFKC");
    const canonical = canonicalName(normalized);
    if (canonical === EVERYONE || canonical === ANONYMOUS) {
      if (!allowSpecial) {
        throw new CromDBError("INVALID_ACCESS_LIST", `${field} entry ${JSON.stringify(entry)} is not allowed; ${field} must be named principals`);
      }
    } else {
      const problem = principalNameProblem(entry, normalized, unicodeVersion);
      if (problem !== undefined) {
        throw new CromDBError("INVALID_ACCESS_LIST", `${field} entry ${JSON.stringify(entry)} ${problem}`);
      }
    }
    if (seen.has(canonical)) {
      throw new CromDBError("INVALID_ACCESS_LIST", `${field} lists ${JSON.stringify(entry)} more than once`);
    }
    seen.add(canonical);
    result.push(normalized);
  }
  return result;
}

/**
 * The special entries form a ladder: "anonymous" admits everyone, named or
 * not (anyone can be anonymous by not signing in); "*" admits every named
 * principal; a name admits that principal. Never called for system writes,
 * which skip access checks.
 */
export function canAccess(principal: string, list: readonly string[]): boolean {
  const canonicalPrincipal = canonicalName(principal);
  const canonicalEntries = list.map(canonicalName);
  if (canonicalEntries.includes(ANONYMOUS)) {
    return true;
  }
  if (canonicalPrincipal === ANONYMOUS) {
    return false;
  }
  return canonicalEntries.includes(EVERYONE) || canonicalEntries.includes(canonicalPrincipal);
}

/**
 * A version is authorized if whoever wrote it was in its own writers. The
 * engine's own "system" writes are allowed on system documents only.
 */
export function isAuthorizedVersion(envelope: DocumentEnvelope): boolean {
  if (envelope.updatedBy === SYSTEM) {
    return envelope.kind === "system";
  }
  return canAccess(envelope.updatedBy, envelope.writers);
}
