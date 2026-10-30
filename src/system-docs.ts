import type { DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
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
export interface DatabaseDocContent {
  readonly databaseId: string;
  readonly createdAt: string; // ISO
  readonly createdOn: string;
  readonly unicodeVersion: string;
}

export interface AclDocContent {
  readonly creators: readonly string[];
  readonly admins: readonly string[];
}

// introducedBy is null for the founding replica. name is a display label,
// present only when the replica was given one: a 0.1.x replica refuses a
// registration that has it.
export interface RegistrationContent {
  readonly instanceId: string;
  readonly status: "active" | "retired";
  readonly introducedBy: string | null;
  readonly introducedAt: string; // ISO
  readonly name?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Reads the ACL from its stored document. Throws INVALID_DATABASE if malformed. */
export function readAclDoc(envelope: DocumentEnvelope | undefined): AclDocContent {
  if (envelope === undefined || envelope.kind !== "system" || envelope.deleted) {
    throw new CromDBError("INVALID_DATABASE", "The database ACL document is missing");
  }
  const { content } = envelope;
  const creators = Object.hasOwn(content, "creators") ? content["creators"] : undefined;
  const admins = Object.hasOwn(content, "admins") ? content["admins"] : undefined;
  if (!isStringArray(creators) || !isStringArray(admins)) {
    throw new CromDBError("INVALID_DATABASE", "The database ACL document is malformed");
  }
  return { creators: [...creators], admins: [...admins] };
}
