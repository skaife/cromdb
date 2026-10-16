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

/** Returns a copy with every entry in NFKC form. */
export function validateAccessList(
  list: unknown,
  field: "readers" | "writers",
  unicodeVersion: string,
): readonly string[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new CromDBError("INVALID_ACCESS_LIST", `${field} must be an array with at least one entry`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of list as unknown[]) {
    if (typeof entry !== "string") {
      throw new CromDBError("INVALID_ACCESS_LIST", `${field} entries must be strings, got ${typeof entry}`);
    }
    const normalized = entry.normalize("NFKC");
    const canonical = canonicalName(normalized);
    if (canonical !== EVERYONE && canonical !== ANONYMOUS) {
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

/** Never called for system writes, which skip access checks. */
export function canAccess(principal: string, list: readonly string[]): boolean {
  const canonicalPrincipal = canonicalName(principal);
  const canonicalEntries = list.map(canonicalName);
  if (canonicalPrincipal === ANONYMOUS) {
    return canonicalEntries.includes(ANONYMOUS);
  }
  return canonicalEntries.includes(EVERYONE) || canonicalEntries.includes(canonicalPrincipal);
}
