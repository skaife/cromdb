import { isKnownPolicy } from "./conflict-policy.js";
import type { DocumentEnvelope } from "./envelope.js";
import { SUPPORTED_LEVELS, isLevel } from "./engine.js";
import { CromDBError } from "./errors.js";
import { writerKeyIndex } from "./conflict.js";
import { effectiveAdmins } from "./access.js";
import { isAuthorizedVersion, rulesFor } from "./principals.js";
import { isUuid, readArray, readObject, requireField, validateEnvelope } from "./replication.js";
import { aclDocId, databaseDocId, readAclDoc, readDatabaseLevel, registrationDocId } from "./system-docs.js";
import { compareUnicodeVersions, isUnicodeVersion } from "./unicode/version.js";

// A ticket lets a replica be made on another machine: Database.registerReplica
// writes the new replica's registration and returns a ticket, and
// Session.openDatabase with replicaOf turns an empty adapter into that
// replica. The ticket carries the four system documents a replica needs to
// exist, so the new replica is complete at once, and the first pull from the
// introducer brings everything else through the usual checks.

/** The ticket format this engine writes and reads. */
export const TICKET_FORMAT = 1;

/**
 * What Database.registerReplica returns, for Session.openDatabase's replicaOf:
 * plain JSON, to send over any transport. A ticket is single-use: treat it
 * like a database file. Opening it twice, on two adapters, makes two replicas
 * with one identity, which sync can't always detect.
 */
export interface ReplicaTicket {
  /** The ticket format, 1. */
  readonly ticket: number;
  readonly databaseId: string;
  /** The new replica's instance ID. */
  readonly instanceId: string;
  /** The instance ID of the replica that wrote the ticket, the one to pull from first. */
  readonly introducedBy: string;
  readonly level: number;
  readonly conflictPolicy: string;
  readonly unicodeVersion: string;
  /** The CromDB version that wrote the ticket, for messages only. */
  readonly engine: string;
  /** The database document, the ACL, the introducer's registration and the new replica's, in that order. */
  readonly documents: readonly DocumentEnvelope[];
}

/** @internal A checked ticket. */
export interface ParsedTicket {
  readonly databaseId: string;
  readonly instanceId: string;
  readonly introducedBy: string;
  readonly level: number;
  readonly conflictPolicy: string;
  readonly unicodeVersion: string;
  readonly documents: readonly DocumentEnvelope[];
  /** The admins in the ticket's ACL who aren't in its noAccess. */
  readonly admins: readonly string[];
}

const TICKET_FIELDS: ReadonlySet<string> = new Set([
  "ticket",
  "databaseId",
  "instanceId",
  "introducedBy",
  "level",
  "conflictPolicy",
  "unicodeVersion",
  "engine",
  "documents",
]);

function invalidTicket(message: string): CromDBError {
  return new CromDBError("INVALID_TICKET", message);
}

/** Runs a check that reports a malformed ticket as INVALID_BATCH or SYNC_MISMATCH, and reports it as INVALID_TICKET. */
function asTicketError<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof CromDBError && (error.code === "INVALID_BATCH" || error.code === "SYNC_MISMATCH")) {
      throw invalidTicket(`The ticket is malformed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * @internal Checks a ticket in full and returns a fresh copy. Reads nothing
 * and writes nothing. INVALID_TICKET if it is malformed or doesn't hold
 * together; UPGRADE_REQUIRED for a later format, a level above this engine's,
 * an unknown conflict policy, or a later Unicode version than engineUnicode.
 */
export function parseTicket(value: unknown, engineUnicode: string): ParsedTicket {
  const fields = asTicketError(() => readObject(value, "The ticket"));
  const format = fields.get("ticket");
  if (Number.isSafeInteger(format) && (format as number) > TICKET_FORMAT) {
    throw new CromDBError("UPGRADE_REQUIRED", `Ticket format ${String(format)} is not supported (expected ${TICKET_FORMAT}); this replica must be upgraded`);
  }
  if (format !== TICKET_FORMAT) {
    throw invalidTicket(`Ticket format ${JSON.stringify(format)} is not supported (expected ${TICKET_FORMAT})`);
  }
  for (const key of fields.keys()) {
    if (!TICKET_FIELDS.has(key)) {
      throw invalidTicket(`The ticket has unknown field ${JSON.stringify(key)}`);
    }
  }
  const what = "The ticket";
  const header = asTicketError(() => ({
    databaseId: requireField(fields, "databaseId", what, isUuid, "a UUID"),
    instanceId: requireField(fields, "instanceId", what, isUuid, "a UUID"),
    introducedBy: requireField(fields, "introducedBy", what, isUuid, "a UUID"),
    level: requireField(fields, "level", what, isLevel, "a positive integer"),
    conflictPolicy: requireField(fields, "conflictPolicy", what, (v): v is string => typeof v === "string" && v.length > 0, "a non-empty string"),
    unicodeVersion: requireField(fields, "unicodeVersion", what, isUnicodeVersion, "a Unicode version"),
    engine: requireField(fields, "engine", what, (v): v is string => typeof v === "string" && v.length > 0 && v.length <= 100, "a string of 1 to 100 characters"),
    documents: readArray(fields.get("documents"), 'The ticket field "documents"'),
  }));
  const { databaseId, instanceId, introducedBy, level, conflictPolicy, unicodeVersion } = header;
  if (instanceId === introducedBy) {
    throw invalidTicket("The ticket's instanceId and introducedBy are the same replica");
  }
  if (level > SUPPORTED_LEVELS.max) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `The ticket is for a database at level ${level}, but this engine supports levels up to ${SUPPORTED_LEVELS.max}; this replica must be upgraded`,
    );
  }
  if (!isKnownPolicy(conflictPolicy)) {
    throw new CromDBError("UPGRADE_REQUIRED", `The ticket is for a database with conflict policy ${JSON.stringify(conflictPolicy)}, which this engine does not know`);
  }
  if (compareUnicodeVersions(unicodeVersion, engineUnicode) > 0) {
    throw new CromDBError("UPGRADE_REQUIRED", `The ticket is for a database that needs Unicode ${unicodeVersion}, but this engine supports Unicode ${engineUnicode}`);
  }

  const expectedIds = [
    databaseDocId(databaseId),
    aclDocId(databaseId),
    registrationDocId(databaseId, introducedBy),
    registrationDocId(databaseId, instanceId),
  ];
  if (header.documents.length !== expectedIds.length) {
    throw invalidTicket(
      `The ticket must hold ${expectedIds.length} documents (the database document, the ACL, and the registrations of the introducer and the new replica), got ${header.documents.length}`,
    );
  }
  // Each document must be the one that belongs at its place, before its
  // content is read: a document for another database or replica is a ticket
  // that doesn't hold together, not a system document from a later engine.
  header.documents.forEach((document, index) => {
    const id = peekId(document);
    if (id !== expectedIds[index]) {
      throw invalidTicket(`Ticket document ${index} has ID ${JSON.stringify(id)}, but ${JSON.stringify(expectedIds[index])} belongs there`);
    }
  });
  // A database document at another level than the ticket's is a ticket that
  // doesn't hold together, not a database to upgrade for (unless its level is
  // beyond this engine, which validateEnvelope reports as UPGRADE_REQUIRED).
  const documentLevel = peekLevel(header.documents[0]);
  if (documentLevel !== undefined && documentLevel <= SUPPORTED_LEVELS.max && documentLevel !== level) {
    throw invalidTicket(`The ticket's database document is at level ${documentLevel}, not ${level}`);
  }
  const rules = rulesFor(level, unicodeVersion);
  const context = { databaseId, unicodeVersion, rules };
  const documents = header.documents.map((document) => {
    const envelope = asTicketError(() => validateEnvelope(document, context, "ticket"));
    if (envelope.kind !== "system") {
      throw invalidTicket(`Ticket document ${JSON.stringify(envelope.id)} must be a system document`);
    }
    if (!isAuthorizedVersion(envelope, rules)) {
      throw invalidTicket(`Ticket document ${JSON.stringify(envelope.id)} was written by ${JSON.stringify(envelope.updatedBy)}, who is not in its writers`);
    }
    // A replica that doesn't exist yet can't have written anything.
    if (Object.keys(envelope.vectorClock).some((key) => writerKeyIndex(instanceId, key) !== undefined)) {
      throw invalidTicket(`Ticket document ${JSON.stringify(envelope.id)} has a clock entry for the new replica, which has written nothing yet`);
    }
    return envelope;
  });
  const [databaseDoc, aclDoc, introducerRegistration, newRegistration] = documents as [
    DocumentEnvelope,
    DocumentEnvelope,
    DocumentEnvelope,
    DocumentEnvelope,
  ];
  if (readDatabaseLevel(databaseDoc.content) !== level) {
    throw invalidTicket(`The ticket's database document is at level ${readDatabaseLevel(databaseDoc.content)}, not ${level}`);
  }
  if (introducerRegistration.content["status"] !== "active") {
    throw invalidTicket("The ticket's introducer is not an active replica");
  }
  if (newRegistration.content["status"] !== "active" || newRegistration.content["introducedBy"] !== introducedBy) {
    throw invalidTicket("The ticket's registration of the new replica must be active and introduced by the ticket's introducer");
  }
  const admins = effectiveAdmins(rules, readAclDoc(aclDoc, level));
  return { databaseId, instanceId, introducedBy, level, conflictPolicy, unicodeVersion, documents, admins };
}

/** The id of what may be a document, or undefined if it can't be read. */
function peekId(document: unknown): unknown {
  try {
    return readObject(document, "").get("id");
  } catch {
    return undefined;
  }
}

/** The level in what may be a database document, or undefined if it can't be read. */
function peekLevel(document: unknown): number | undefined {
  try {
    const content = readObject(readObject(document, "").get("content"), "");
    const level = content.has("level") ? content.get("level") : 1;
    return isLevel(level) ? level : undefined;
  } catch {
    return undefined;
  }
}

/** @internal A deep-frozen copy of plain JSON. */
export function frozenJson<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (item: unknown): void => {
    if (typeof item === "object" && item !== null) {
      Object.freeze(item);
      for (const child of Object.values(item)) {
        freeze(child);
      }
    }
  };
  freeze(copy);
  return copy;
}
