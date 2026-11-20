import { ACCESS_TYPES, type AccessLists } from "./access.js";
import { ANONYMOUS } from "./acl.js";
import type { DocumentEnvelope } from "./envelope.js";
import { ACCESS_STRUCTURE_LEVEL, isLevel } from "./engine.js";
import { CromDBError } from "./errors.js";
import type { JsonObject } from "./json.js";
import { derivedId } from "./ids.js";

// Every replica must agree on system document IDs, so they are derived from
// the database ID, never random.

export function databaseDocId(databaseId: string): string {
  return databaseId;
}

export function aclDocId(databaseId: string): string {
  return derivedId(databaseId, "acl");
}

export function registrationDocId(databaseId: string, instanceId: string): string {
  return derivedId(databaseId, `replica:${instanceId}`);
}

// createdOn is the instance ID of the creating replica. Written once, never
// changed. unicodeVersion ("17.0") is the Unicode version names in this
// database are checked against; it may be raised later, never lowered.
// level is the database level, absent for level 1: an engine without levels
// (0.2.0 and earlier) refuses a database document with a field it doesn't
// know, so level 1 is never written. Databases 0.4.0 and 0.5.0 create are at
// level 2, and this engine's at level 3, written explicitly.
export interface DatabaseDocContent {
  readonly databaseId: string;
  readonly createdAt: string; // ISO
  readonly createdOn: string;
  readonly unicodeVersion: string;
  readonly level?: number;
}

// At level 3 and above, the ACL holds a list for every access type. Below
// level 3 it holds only creators and admins, and the other lists read as
// below: everyone may open the database, and each document's own lists
// decide, as before level 3.
export type AclDocContent = AccessLists;

/** @internal The lists a database below level 3 reads as having. */
export const FILLED_IN_LISTS: { readonly readers: readonly string[]; readonly writers: readonly string[]; readonly noAccess: readonly string[] } =
  Object.freeze({ readers: Object.freeze([ANONYMOUS]), writers: Object.freeze([ANONYMOUS]), noAccess: Object.freeze([]) });

/** @internal The keys the ACL document holds at a level. */
export function aclKeys(level: number): readonly string[] {
  return level >= ACCESS_STRUCTURE_LEVEL ? ACCESS_TYPES : ["creators", "admins"];
}

/** @internal The stored content of an ACL document at a level. */
export function aclContent(lists: AclDocContent, level: number): JsonObject {
  return Object.fromEntries(aclKeys(level).map((key) => [key, [...lists[key as keyof AclDocContent]]]));
}

// introducedBy is null for the founding replica. name is a display label,
// present only when the replica was given one: a 0.1.x replica refuses a
// registration that has it. maxLevel is the highest level the replica's
// engine supports, written by the replica itself, only in a database at
// level 2 or higher (0.2.0 and 0.3.0 refuse a registration with it).
export interface RegistrationContent {
  readonly instanceId: string;
  readonly status: "active" | "retired";
  readonly introducedBy: string | null;
  readonly introducedAt: string; // ISO
  readonly name?: string;
  readonly maxLevel?: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Reads the ACL from its stored document, in a database at level. Throws
 * INVALID_DATABASE if it is missing or malformed, or at level 3 and above if
 * it lacks a list or has a key that isn't an access type.
 */
export function readAclDoc(envelope: DocumentEnvelope | undefined, level: number): AclDocContent {
  if (envelope === undefined || envelope.kind !== "system" || envelope.deleted) {
    throw new CromDBError("INVALID_DATABASE", "The database ACL document is missing");
  }
  const { content } = envelope;
  const keys = aclKeys(level);
  const lists = new Map<string, string[]>();
  for (const key of keys) {
    const list = Object.hasOwn(content, key) ? content[key] : undefined;
    if (!isStringArray(list)) {
      throw new CromDBError("INVALID_DATABASE", "The database ACL document is malformed");
    }
    lists.set(key, [...list]);
  }
  if (level >= ACCESS_STRUCTURE_LEVEL && Object.keys(content).some((key) => !keys.includes(key))) {
    throw new CromDBError("INVALID_DATABASE", "The database ACL document has a key that isn't an access type");
  }
  const get = (key: string): string[] => lists.get(key) ?? [];
  if (level < ACCESS_STRUCTURE_LEVEL) {
    return {
      admins: get("admins"),
      creators: get("creators"),
      writers: [...FILLED_IN_LISTS.writers],
      readers: [...FILLED_IN_LISTS.readers],
      noAccess: [...FILLED_IN_LISTS.noAccess],
    };
  }
  return { admins: get("admins"), creators: get("creators"), writers: get("writers"), readers: get("readers"), noAccess: get("noAccess") };
}

/** The level in database document content, 1 if absent. Throws INVALID_DATABASE if malformed. */
export function readDatabaseLevel(content: JsonObject): number {
  if (!Object.hasOwn(content, "level")) {
    return 1;
  }
  const level = content["level"];
  if (!isLevel(level)) {
    throw new CromDBError("INVALID_DATABASE", `The database document has level ${JSON.stringify(level)}, which is not a positive integer`);
  }
  return level;
}
