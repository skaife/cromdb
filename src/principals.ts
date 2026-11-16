import { ANONYMOUS, EVERYONE, SYSTEM, canAccess as canAccessByName, validateAccessList, validatePrincipalName, type AccessListField } from "./acl.js";
import type { DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";

// How a database identifies people. Level 1 uses names, compared without
// case after NFKC; level 2 and above use IDs, compared exactly. A Database
// picks one set of rules when it is opened, from the database's level, and
// everything that checks or compares principals goes through it.

/** @internal */
export interface PrincipalRules {
  readonly level: number;
  /** Checks a principal for a session or a stored field and returns its stored form. Throws INVALID_PRINCIPAL. */
  principal(value: unknown): string;
  /** Checks an access list and returns a copy in stored form. Throws INVALID_ACCESS_LIST. */
  accessList(list: unknown, field: AccessListField): readonly string[];
  /**
   * The special entries form a ladder: "anonymous" admits everyone, signed in
   * or not; "*" admits every signed-in principal; any other entry admits that
   * principal. Never called for system writes, which skip access checks.
   */
  canAccess(principal: string, list: readonly string[]): boolean;
}

/** @internal Level 1: names, as in 0.3.0 and earlier, checked against the database's Unicode version. */
export function nameRules(unicodeVersion: string): PrincipalRules {
  return Object.freeze({
    level: 1,
    principal: (value: unknown) => validatePrincipalName(value, unicodeVersion),
    accessList: (list: unknown, field: AccessListField) => validateAccessList(list, field, unicodeVersion),
    canAccess: canAccessByName,
  });
}

export const MAX_ID_LENGTH = 512;

/**
 * Returns why a string can't be an ID, or undefined. An ID is 1 to 512
 * characters from U+0021 to U+007E: letters, digits and ASCII punctuation,
 * with no spaces. "*" and anything starting with "[" are reserved, and so are
 * "system" and "anonymous" in any case, so history can't show a principal
 * that looks like the engine or like nobody.
 */
function idProblem(id: string): string | undefined {
  if (id.length === 0 || id.length > MAX_ID_LENGTH) {
    return `must be 1 to ${MAX_ID_LENGTH} characters`;
  }
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return "may only contain characters U+0021 to U+007E (ASCII letters, digits and punctuation, no spaces)";
    }
  }
  const lower = id.toLowerCase();
  if (id === EVERYONE || lower === SYSTEM || lower === ANONYMOUS) {
    return "is reserved";
  }
  if (id.startsWith("[")) {
    return 'starts with "[", which is reserved for roles';
  }
  return undefined;
}

/** @internal For Session.withId and stored fields at level 2. Returns the ID unchanged. */
export function validatePrincipalId(id: unknown): string {
  if (typeof id !== "string") {
    throw new CromDBError("INVALID_PRINCIPAL", `Principal ID must be a string, got ${typeof id}`);
  }
  const problem = idProblem(id);
  if (problem !== undefined) {
    throw new CromDBError("INVALID_PRINCIPAL", `Principal ID ${JSON.stringify(id)} ${problem}`);
  }
  return id;
}

function validateIdList(list: unknown, field: AccessListField): readonly string[] {
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
    if (entry === EVERYONE || entry === ANONYMOUS) {
      if (!allowSpecial) {
        throw new CromDBError("INVALID_ACCESS_LIST", `${field} entry ${JSON.stringify(entry)} is not allowed; ${field} must be principal IDs`);
      }
    } else {
      const problem = idProblem(entry);
      if (problem !== undefined) {
        throw new CromDBError("INVALID_ACCESS_LIST", `${field} entry ${JSON.stringify(entry)} ${problem}`);
      }
    }
    if (seen.has(entry)) {
      throw new CromDBError("INVALID_ACCESS_LIST", `${field} lists ${JSON.stringify(entry)} more than once`);
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function canAccessById(principal: string, list: readonly string[]): boolean {
  if (list.includes(ANONYMOUS)) {
    return true;
  }
  if (principal === ANONYMOUS) {
    return false;
  }
  return list.includes(EVERYONE) || list.includes(principal);
}

/** @internal Level 2 and above: IDs, stored as given and compared exactly. */
export function idRules(level: number): PrincipalRules {
  return Object.freeze({
    level,
    principal: validatePrincipalId,
    accessList: validateIdList,
    canAccess: canAccessById,
  });
}

/** @internal The rules for a database at this level. */
export function rulesFor(level: number, unicodeVersion: string): PrincipalRules {
  return level === 1 ? nameRules(unicodeVersion) : idRules(level);
}

/**
 * @internal A version is authorized if whoever wrote it was in its own
 * writers. The engine's own "system" writes are allowed on system documents
 * only.
 */
export function isAuthorizedVersion(envelope: DocumentEnvelope, rules: PrincipalRules): boolean {
  if (envelope.updatedBy === SYSTEM) {
    return envelope.kind === "system";
  }
  return rules.canAccess(envelope.updatedBy, envelope.writers);
}
