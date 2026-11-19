// A person in the directory, as stored in a CromDB document. Pure.

import type { FieldTypes, JsonObject, JsonValue } from "@cromdb/driver";
import { isIsoTime } from "../text.js";

export const PERSON_SCHEMA = 1;

export const STATUSES = ["invited", "active", "disabled"] as const;
export type Status = (typeof STATUSES)[number];

/** One way a person logs in: a provider's issuer and that provider's subject for them. */
export interface Login {
  readonly issuer: string;
  readonly subject: string;
  readonly addedAt: string;
}

/**
 * Every field that can change has its own time (the "...At" field), so two
 * servers' edits of one person merge field by field (see merge.ts). Times
 * are ISO strings as toISOString writes them, stored as datetimes.
 */
export interface Person {
  readonly personId: string;
  readonly email: string;
  readonly emailAt: string;
  readonly status: Status;
  readonly statusAt: string;
  /** The person ID that set the status, or "setup" or "console". */
  readonly statusBy: string;
  readonly serverAdmin: boolean;
  readonly serverAdminAt: string;
  readonly displayName: string | null;
  readonly displayNameAt: string;
  readonly logins: readonly Login[];
  /** The person ID that sent the invitation, or "setup" or "console". */
  readonly invitedBy: string;
  readonly invitedAt: string;
  /** When and on which server (its serverId) the document was last written. */
  readonly changedAt: string;
  readonly changedOn: string;
}

function has(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLogin(value: JsonValue): Login | undefined {
  if (!isObject(value)) return undefined;
  const issuer = has(value, "issuer");
  const subject = has(value, "subject");
  const addedAt = has(value, "addedAt");
  return typeof issuer === "string" && typeof subject === "string" && isIsoTime(addedAt) ? { issuer, subject, addedAt } : undefined;
}

/**
 * The person in a directory document's content, or why it isn't one. Schema
 * on read: the engine never checks content, so the server does, here.
 */
export function readPerson(content: JsonObject): { person: Person } | { problem: string } {
  if (has(content, "type") !== "person") {
    return { problem: 'type is not "person"' };
  }
  if (has(content, "schema") !== PERSON_SCHEMA) {
    return { problem: `schema is ${JSON.stringify(has(content, "schema"))}; this server reads schema ${PERSON_SCHEMA}` };
  }
  const text = (key: string) => {
    const value = has(content, key);
    return typeof value === "string" ? value : undefined;
  };
  const time = (key: string) => {
    const value = has(content, key);
    return isIsoTime(value) ? value : undefined;
  };
  const status = text("status");
  const serverAdmin = has(content, "serverAdmin");
  const displayName = has(content, "displayName");
  const loginsValue = has(content, "logins");
  const logins = Array.isArray(loginsValue) ? loginsValue.map(readLogin) : undefined;
  const person = {
    personId: text("personId"),
    email: text("email"),
    emailAt: time("emailAt"),
    status: status !== undefined && (STATUSES as readonly string[]).includes(status) ? (status as Status) : undefined,
    statusAt: time("statusAt"),
    statusBy: text("statusBy"),
    serverAdmin: typeof serverAdmin === "boolean" ? serverAdmin : undefined,
    serverAdminAt: time("serverAdminAt"),
    displayName: displayName === null || typeof displayName === "string" ? displayName : undefined,
    displayNameAt: time("displayNameAt"),
    logins: logins !== undefined && logins.every((login) => login !== undefined) ? (logins as Login[]) : undefined,
    invitedBy: text("invitedBy"),
    invitedAt: time("invitedAt"),
    changedAt: time("changedAt"),
    changedOn: text("changedOn"),
  };
  const bad = Object.entries(person)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  return bad.length > 0 ? { problem: `missing or of the wrong type: ${bad.join(", ")}` } : { person: person as Person };
}

const TIME_FIELDS = ["emailAt", "statusAt", "serverAdminAt", "displayNameAt", "invitedAt", "changedAt"] as const;

/** The document content and fieldTypes for a person. */
export function personContent(person: Person): { content: JsonObject; fieldTypes: FieldTypes } {
  const content: JsonObject = {
    type: "person",
    schema: PERSON_SCHEMA,
    personId: person.personId,
    email: person.email,
    emailAt: person.emailAt,
    status: person.status,
    statusAt: person.statusAt,
    statusBy: person.statusBy,
    serverAdmin: person.serverAdmin,
    serverAdminAt: person.serverAdminAt,
    displayName: person.displayName,
    displayNameAt: person.displayNameAt,
    logins: person.logins.map((login) => ({ issuer: login.issuer, subject: login.subject, addedAt: login.addedAt })),
    invitedBy: person.invitedBy,
    invitedAt: person.invitedAt,
    changedAt: person.changedAt,
    changedOn: person.changedOn,
  };
  const fieldTypes: Record<string, "datetime"> = {};
  for (const key of TIME_FIELDS) {
    fieldTypes[`/${key}`] = "datetime";
  }
  person.logins.forEach((_, index) => {
    fieldTypes[`/logins/${index}/addedAt`] = "datetime";
  });
  return { content, fieldTypes };
}

/** The key that identifies a login across servers. */
export function loginKey(issuer: string, subject: string): string {
  return JSON.stringify([issuer, subject]);
}
