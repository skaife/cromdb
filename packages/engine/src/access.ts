import type { PrincipalRules } from "./principals.js";

// The database ACL is an access structure: a list of principals for each
// access type. The database's lists set the most anyone may do; a
// document's own readers and writers can only narrow that. noAccess
// overrides every other list.

/** The access types in a database ACL, in the order they are stored. */
export const ACCESS_TYPES = ["admins", "creators", "writers", "readers", "noAccess"] as const;

/** One of ACCESS_TYPES. */
export type AccessType = (typeof ACCESS_TYPES)[number];

/** The lists of a database ACL, one per access type. */
export type AccessLists = { readonly [type in AccessType]: readonly string[] };

/** @internal What a principal may do in a database, from its ACL. */
export interface Grant {
  /** In any list and not in noAccess: may open the database and see that it exists. */
  readonly visible: boolean;
  readonly read: boolean;
  readonly write: boolean;
  readonly create: boolean;
  readonly admin: boolean;
}

/** @internal Whether the principal is locked out. noAccess holds no "*" or "anonymous", so this is an exact match. */
export function isLockedOut(rules: PrincipalRules, principal: string, lists: AccessLists): boolean {
  return rules.canAccess(principal, lists.noAccess);
}

/** @internal The grant for principal under lists. */
export function grantFor(rules: PrincipalRules, principal: string, lists: AccessLists): Grant {
  if (isLockedOut(rules, principal, lists)) {
    return Object.freeze({ visible: false, read: false, write: false, create: false, admin: false });
  }
  const read = rules.canAccess(principal, lists.readers);
  const write = rules.canAccess(principal, lists.writers);
  const create = rules.canAccess(principal, lists.creators);
  const admin = rules.canAccess(principal, lists.admins);
  return Object.freeze({ visible: read || write || create || admin, read, write, create, admin });
}

/**
 * @internal The admins who aren't locked out. They are the readers and
 * writers of the ACL document and of registrations, so an admin in noAccess
 * can't write either, here or on another replica.
 */
export function effectiveAdmins(rules: PrincipalRules, lists: AccessLists): readonly string[] {
  return lists.admins.filter((admin) => !rules.canAccess(admin, lists.noAccess));
}
