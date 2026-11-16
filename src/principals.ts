import { SYSTEM, canAccess as canAccessByName, validateAccessList, validatePrincipalName, type AccessListField } from "./acl.js";
import type { DocumentEnvelope } from "./envelope.js";

// How a database identifies people. A Database picks one set of rules when it
// is opened, and everything that checks or compares principals goes through
// it. Level 1 uses names, compared without case after NFKC.

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
