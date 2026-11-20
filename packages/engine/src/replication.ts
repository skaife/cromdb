import { ANONYMOUS, SYSTEM, replicaNameProblem, type AccessListField, type AccessListScope } from "./acl.js";
import { conflictRowId, writerKeyIndex } from "./conflict.js";
import type { Database } from "./database.js";
import type { ChangeEntry, DocumentEnvelope, DocumentKind } from "./envelope.js";
import { ACCESS_STRUCTURE_LEVEL, SUPPORTED_LEVELS, isLevel } from "./engine.js";
import { CromDBError } from "./errors.js";
import { decodeContent, isPlainObject, type FieldTypes } from "./field-types.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { PrincipalRules } from "./principals.js";
import { aclDocId, aclKeys, databaseDocId, registrationDocId } from "./system-docs.js";
import { isUnicodeVersion } from "./unicode/version.js";
import { countFor, type VectorClock } from "./vector-clock.js";

// Batches are plain JSON data, so how they travel between replicas is up to
// the caller. Everything here is pure; Database does the reads and writes.

/** The batch format of a level-1 database, as 0.2.0 and 0.3.0 send it. */
export const LEVEL_1_BATCH_FORMAT = 1;
/** The batch format of a database at level 2 or higher: format 1 plus level and engine. */
export const BATCH_FORMAT = 2;
export const DEFAULT_EXPORT_LIMIT = 500;

/** Changed documents from one replica, each as its current version. */
export interface ChangeBatch {
  /** 1 for a database at level 1, 2 for one at level 2 or higher. */
  readonly format: 1 | 2;
  /** Format 2 only: the database's level on the sender, 2 or higher. */
  readonly level?: number;
  /** Format 2 only: the sender's CromDB version, for messages only. */
  readonly engine?: string;
  readonly databaseId: string;
  readonly sourceInstanceId: string;
  readonly conflictPolicy: string;
  readonly unicodeVersion: string;
  /** The source's change-log position this batch starts after. */
  readonly since: number;
  /** The position to ask for next. */
  readonly toSeq: number;
  readonly hasMore: boolean;
  /** The source's highest change-log position when the batch was made. */
  readonly sourceLastSeq: number;
  readonly documents: readonly DocumentEnvelope[];
}

export interface ApplyResult {
  readonly applied: number;
  readonly skipped: number;
  readonly toSeq: number;
  readonly hasMore: boolean;
}

export interface PullResult {
  readonly applied: number;
  readonly skipped: number;
  readonly batches: number;
}

/** A checked batch header. level is 1 for a format-1 batch. */
export type BatchHeader = Omit<ChangeBatch, "documents" | "level"> & { readonly level: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which documents go in the next batch. entries are the change-log entries
 * after since, in ascending order. Stops before the entry that would make
 * more than limit distinct documents. toSeq is the last entry taken, or since
 * if none.
 */
export function selectChanges(
  entries: readonly ChangeEntry[],
  since: number,
  limit: number,
): { docIds: string[]; toSeq: number; hasMore: boolean } {
  const docIds: string[] = [];
  const seen = new Set<string>();
  let toSeq = since;
  let index = 0;
  for (; index < entries.length; index++) {
    const entry = entries[index] as ChangeEntry;
    if (!seen.has(entry.docId)) {
      if (docIds.length === limit) {
        break;
      }
      seen.add(entry.docId);
      docIds.push(entry.docId);
    }
    toSeq = entry.seq;
  }
  return { docIds, toSeq, hasMore: index < entries.length };
}

/** The change entry recorded for a document copied or applied from another replica. */
export function replicatedChange(envelope: DocumentEnvelope): Omit<ChangeEntry, "seq"> {
  return {
    docId: envelope.id,
    vectorClock: envelope.vectorClock,
    op: envelope.deleted ? "delete" : "put",
    instanceId: envelope.updatedOn,
    updatedBy: envelope.updatedBy,
    timestamp: envelope.updatedAt,
    suspect: false,
    suspectReason: null,
  };
}

// Peer positions: how far this replica has applied each peer's change log.

export function peerKey(instanceId: string): string {
  return `peer:${instanceId}`;
}

export function formatPeerPosition(lastSeq: number, lastSyncedAt: string): string {
  return JSON.stringify({ lastSeq, lastSyncedAt });
}

/** The stored lastSeq, or 0 if there is none. Throws INVALID_DATABASE if malformed. */
export function parsePeerPosition(stored: string | undefined, instanceId: string): number {
  if (stored === undefined) {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  const lastSeq =
    typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "lastSeq")
      ? (parsed as { lastSeq: unknown }).lastSeq
      : undefined;
  if (!isSeq(lastSeq)) {
    throw new CromDBError("INVALID_DATABASE", `The stored position for replica ${JSON.stringify(instanceId)} is malformed`);
  }
  return lastSeq;
}

/** Copies one replica's batches into another until there are no more. Both sessions must be admins. */
export async function sync(a: Database, b: Database): Promise<void> {
  await b.pullFrom(a);
  await a.pullFrom(b);
}

// Validation of incoming batches. Input is untrusted: only own data
// properties of plain objects and arrays are read, and everything returned is
// a fresh copy, so nothing the caller holds is stored or kept.

function invalid(message: string): CromDBError {
  return new CromDBError("INVALID_BATCH", message);
}

function isSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The own data properties of a plain object, which must all be in allowed.
 * Throws for anything else, including symbol keys and getters.
 */
/** @internal Also used for tickets. Throws INVALID_BATCH. */
export function readObject(value: unknown, what: string, allowed?: ReadonlySet<string>): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !isPlainObject(value)) {
    throw invalid(`${what} must be a plain object`);
  }
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw invalid(`${what} has a symbol key`);
    }
    if (allowed !== undefined && !allowed.has(key)) {
      throw invalid(`${what} has unknown field ${JSON.stringify(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
    if (!("value" in descriptor)) {
      throw invalid(`${what} field ${JSON.stringify(key)} is not a data property`);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

/** @internal Also used for tickets. Throws INVALID_BATCH. */
export function readArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalid(`${what} must be an array`);
  }
  const keys = Reflect.ownKeys(value);
  // An array's own keys are its indexes plus "length".
  if (keys.length !== value.length + 1) {
    throw invalid(`${what} has holes or extra properties`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalid(`${what} item ${index} is missing or not a data property`);
    }
    items.push(descriptor.value);
  }
  return items;
}

/** @internal Also used for tickets. Throws INVALID_BATCH. */
export function requireField<T>(fields: Map<string, unknown>, key: string, what: string, check: (value: unknown) => value is T, expected: string): T {
  const value = fields.get(key);
  if (!fields.has(key) || !check(value)) {
    throw invalid(`${what} field ${JSON.stringify(key)} must be ${expected}`);
  }
  return value;
}

function copyJson(value: unknown, what: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(`${what} is not a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return readArray(value, what).map((item, index) => copyJson(item, `${what}/${index}`));
  }
  return copyJsonObject(value, what);
}

function copyJsonObject(value: unknown, what: string): JsonObject {
  const fields = readObject(value, what);
  return Object.fromEntries([...fields].map(([key, item]) => [key, copyJson(item, `${what}/${key}`)]));
}

const HEADER_FIELDS: ReadonlySet<string> = new Set([
  "format",
  "databaseId",
  "sourceInstanceId",
  "conflictPolicy",
  "unicodeVersion",
  "since",
  "toSeq",
  "hasMore",
  "sourceLastSeq",
  "documents",
]);

const FORMAT_2_HEADER_FIELDS: ReadonlySet<string> = new Set([...HEADER_FIELDS, "level", "engine"]);

/**
 * Checks the batch's shape and types. The documents are checked one by one
 * with validateEnvelope. The format is read first, so a batch in a later
 * format is UPGRADE_REQUIRED whatever fields it has, and a level this engine
 * doesn't support is UPGRADE_REQUIRED before any document is read.
 */
export function parseBatch(batch: unknown): { header: BatchHeader; documents: unknown[] } {
  const fields = readObject(batch, "The batch");
  const format = fields.get("format");
  if (Number.isSafeInteger(format) && (format as number) > BATCH_FORMAT) {
    throw new CromDBError(
      "UPGRADE_REQUIRED",
      `Batch format ${String(format)} is not supported (expected ${LEVEL_1_BATCH_FORMAT} or ${BATCH_FORMAT}); this replica must be upgraded`,
    );
  }
  if (format !== LEVEL_1_BATCH_FORMAT && format !== BATCH_FORMAT) {
    throw invalid(`Batch format ${JSON.stringify(format)} is not supported (expected ${LEVEL_1_BATCH_FORMAT} or ${BATCH_FORMAT})`);
  }
  const allowed = format === BATCH_FORMAT ? FORMAT_2_HEADER_FIELDS : HEADER_FIELDS;
  for (const key of fields.keys()) {
    if (!allowed.has(key)) {
      throw invalid(`The batch has unknown field ${JSON.stringify(key)}`);
    }
  }
  let level = 1;
  let engine: string | undefined;
  if (format === BATCH_FORMAT) {
    level = requireField(fields, "level", "The batch", isLevel, "a positive integer");
    if (level < 2) {
      throw invalid(`A format ${BATCH_FORMAT} batch must have level 2 or higher, got ${level}`);
    }
    if (level > SUPPORTED_LEVELS.max) {
      throw new CromDBError(
        "UPGRADE_REQUIRED",
        `The batch is from a database at level ${level}, but this engine supports levels up to ${SUPPORTED_LEVELS.max}; this replica must be upgraded`,
      );
    }
    engine = requireField(fields, "engine", "The batch", (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 100, "a string of 1 to 100 characters");
  }
  const what = "The batch";
  const header: BatchHeader = {
    format,
    level,
    ...(engine === undefined ? {} : { engine }),
    databaseId: requireField(fields, "databaseId", what, isNonEmptyString, "a non-empty string"),
    sourceInstanceId: requireField(fields, "sourceInstanceId", what, isNonEmptyString, "a non-empty string"),
    conflictPolicy: requireField(fields, "conflictPolicy", what, isNonEmptyString, "a non-empty string"),
    unicodeVersion: requireField(fields, "unicodeVersion", what, isNonEmptyString, "a non-empty string"),
    since: requireField(fields, "since", what, isSeq, "a non-negative integer"),
    toSeq: requireField(fields, "toSeq", what, isSeq, "a non-negative integer"),
    hasMore: requireField(fields, "hasMore", what, (value): value is boolean => typeof value === "boolean", "a boolean"),
    sourceLastSeq: requireField(fields, "sourceLastSeq", what, isSeq, "a non-negative integer"),
  };
  if (header.toSeq < header.since) {
    throw invalid(`The batch's toSeq ${header.toSeq} is before its since ${header.since}`);
  }
  if (!fields.has("documents")) {
    throw invalid('The batch field "documents" must be an array');
  }
  const documents = readArray(fields.get("documents"), 'The batch field "documents"');
  // A source asked for changes past its end answers with an empty batch at
  // since. That is how a receiver learns the source went backwards, so it is
  // the one batch allowed to have toSeq above sourceLastSeq.
  const pastTheEnd = header.toSeq === header.since && !header.hasMore && documents.length === 0;
  if (header.toSeq > header.sourceLastSeq && !pastTheEnd) {
    throw invalid(`The batch's toSeq ${header.toSeq} is after its sourceLastSeq ${header.sourceLastSeq}`);
  }
  return { header, documents };
}

const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "parentId",
  "kind",
  "vectorClock",
  "deleted",
  "deletedAt",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "updatedOn",
  "readers",
  "writers",
  "content",
  "fieldTypes",
  "conflictOf",
]);

export interface EnvelopeContext {
  readonly databaseId: string;
  readonly unicodeVersion: string;
  /** The receiving database's principal rules; its level is the database's level. */
  readonly rules: PrincipalRules;
}

/** A writer key: an instance ID, or an instance ID, "/", and a positive integer without leading zeros. */
function isClockKey(key: string): boolean {
  const slash = key.indexOf("/");
  if (slash === -1) {
    return isUuid(key);
  }
  const instanceId = key.slice(0, slash);
  return isUuid(instanceId) && writerKeyIndex(instanceId, key) !== undefined;
}

function readClock(value: unknown, what: string): VectorClock {
  const fields = readObject(value, what);
  const entries: [string, number][] = [];
  for (const [key, count] of fields) {
    if (!isClockKey(key) || !isSeq(count)) {
      throw invalid(
        `${what} entry ${JSON.stringify(key)} must have a key that is an instance ID, or an instance ID, "/" and a positive integer, and a non-negative integer count`,
      );
    }
    entries.push([key, count]);
  }
  return Object.fromEntries(entries);
}

// At level 1 the stored form of a name is its NFKC form; an ID is stored as
// given, so only names can fail the stored-form check.

function readPrincipal(value: unknown, what: string, allowSystem: boolean, rules: PrincipalRules): string {
  if (value === ANONYMOUS || (allowSystem && value === SYSTEM)) {
    return value;
  }
  let stored: string | undefined;
  try {
    stored = rules.principal(value);
  } catch (error) {
    throw invalid(`${what} is not a valid principal: ${(error as Error).message}`);
  }
  if (stored !== value) {
    throw invalid(`${what} is not in NFKC form`);
  }
  return stored;
}

/** As the rules' accessList, and the list must already be in the stored form. */
function readAccessList(value: unknown, what: string, field: AccessListField, rules: PrincipalRules, scope: AccessListScope = "document"): readonly string[] {
  const items = readArray(value, what);
  let stored: readonly string[];
  try {
    stored = rules.accessList(items, field, scope);
  } catch (error) {
    throw invalid(`${what}: ${(error as Error).message}`);
  }
  if (stored.some((entry, index) => entry !== items[index])) {
    throw invalid(`${what} is not in NFKC form`);
  }
  return stored;
}

function readFieldTypes(value: unknown, what: string): FieldTypes {
  const fields = readObject(value, what);
  for (const [pointer, fieldType] of fields) {
    if (fieldType !== "datetime") {
      throw invalid(`${what} entry ${JSON.stringify(pointer)} has unknown field type ${JSON.stringify(fieldType)}`);
    }
  }
  return Object.fromEntries([...fields].map(([pointer]) => [pointer, "datetime"]));
}

function tooNew(message: string): CromDBError {
  return new CromDBError("UPGRADE_REQUIRED", `${message}; this replica must be upgraded`);
}

/**
 * Throws UPGRADE_REQUIRED for a field this engine doesn't know: a later
 * engine may add fields to system documents, and an engine that can't read
 * them must not apply them.
 */
function checkKnownFields(fields: Map<string, unknown>, known: readonly string[], what: string): void {
  for (const key of fields.keys()) {
    if (!known.includes(key)) {
      throw tooNew(`${what} has field ${JSON.stringify(key)}, which this engine does not know`);
    }
  }
}

/**
 * Checks system document content against what the engine writes, so a batch
 * can't leave this replica with an unreadable ACL or database document. A
 * system document or field this engine doesn't know, and a database document
 * at a level above this replica's, are UPGRADE_REQUIRED; a database document
 * at a lower level is SYNC_MISMATCH.
 */
function checkSystemContent(id: string, content: JsonObject, context: EnvelopeContext, what: string): void {
  const { databaseId, unicodeVersion, rules } = context;
  const fields = readObject(content, `${what} content`);
  if (id === databaseDocId(databaseId)) {
    checkKnownFields(fields, ["databaseId", "createdAt", "createdOn", "unicodeVersion", "level"], what);
    if (fields.get("databaseId") !== databaseId) {
      throw invalid(`${what} is for database ${JSON.stringify(fields.get("databaseId"))}, not ${JSON.stringify(databaseId)}`);
    }
    requireField(fields, "createdAt", `${what} content`, isIsoTimestamp, "an ISO timestamp");
    requireField(fields, "createdOn", `${what} content`, isUuid, "a UUID");
    const version = requireField(fields, "unicodeVersion", `${what} content`, isUnicodeVersion, "a Unicode version");
    if (version !== unicodeVersion) {
      throw invalid(`${what} has unicodeVersion ${JSON.stringify(version)}, not ${JSON.stringify(unicodeVersion)}`);
    }
    const level = fields.has("level") ? requireField(fields, "level", `${what} content`, isLevel, "a positive integer") : 1;
    if (level > SUPPORTED_LEVELS.max) {
      throw tooNew(`${what} raises the database to level ${level}, but this engine supports levels up to ${SUPPORTED_LEVELS.max}`);
    }
    if (level > rules.level) {
      throw tooNew(`${what} raises the database to level ${level}, but this replica is at level ${rules.level}, and raising a database needs a later engine`);
    }
    if (level < rules.level) {
      throw new CromDBError("SYNC_MISMATCH", `${what} has the database at level ${level}, but this replica is at level ${rules.level}`);
    }
    return;
  }
  if (id === aclDocId(databaseId)) {
    const keys = aclKeys(rules.level);
    checkKnownFields(fields, keys, what);
    const lists = Object.fromEntries(
      keys.map((key) => [key, readAccessList(fields.get(key), `${what} ${key}`, key as AccessListField, rules, "database")]),
    ) as Record<string, readonly string[]>;
    if (rules.level >= ACCESS_STRUCTURE_LEVEL) {
      const noAccess = lists["noAccess"] ?? [];
      if (!(lists["admins"] ?? []).some((admin) => !rules.canAccess(admin, noAccess))) {
        throw invalid(`${what} has no admin outside noAccess`);
      }
    }
    return;
  }
  const instanceId = fields.get("instanceId");
  if (!isUuid(instanceId) || id !== registrationDocId(databaseId, instanceId)) {
    throw tooNew(`${what} is a system document this engine does not know`);
  }
  checkKnownFields(fields, ["instanceId", "status", "introducedBy", "introducedAt", "name", ...(rules.level >= 2 ? ["maxLevel"] : [])], what);
  requireField(fields, "status", `${what} content`, (value): value is string => value === "active" || value === "retired", '"active" or "retired"');
  requireField(fields, "introducedBy", `${what} content`, (value): value is string | null => value === null || isUuid(value), "a UUID or null");
  requireField(fields, "introducedAt", `${what} content`, isIsoTimestamp, "an ISO timestamp");
  if (fields.has("name")) {
    const name = fields.get("name");
    const problem =
      typeof name !== "string"
        ? "is not a string"
        : name.normalize("NFKC") !== name
          ? "is not in NFKC form"
          : replicaNameProblem(name, name, unicodeVersion);
    if (problem !== undefined) {
      throw invalid(`${what} replica name ${problem}`);
    }
  }
  if (fields.has("maxLevel")) {
    requireField(fields, "maxLevel", `${what} content`, isLevel, "a positive integer");
  }
}

/**
 * Checks an incoming envelope fully and returns a fresh copy. Throws
 * INVALID_BATCH if anything is malformed. A conflict document must have the
 * ID its primary's ID and its clock give. carrier names what brought it, for
 * messages: "batch" or "ticket".
 */
export function validateEnvelope(value: unknown, context: EnvelopeContext, carrier: "batch" | "ticket" = "batch"): DocumentEnvelope {
  const fields = readObject(value, `A ${carrier} document`, ENVELOPE_FIELDS);
  const id = requireField(fields, "id", `A ${carrier} document`, isNonEmptyString, "a non-empty string");
  const what = `${carrier === "batch" ? "Batch" : "Ticket"} document ${JSON.stringify(id)}`;

  const kind = requireField(fields, "kind", what, (v): v is DocumentKind => v === "document" || v === "system", '"document" or "system"');
  const parentId = requireField(fields, "parentId", what, isNonEmptyString, "a non-empty string");
  const deleted = requireField(fields, "deleted", what, (v): v is boolean => typeof v === "boolean", "a boolean");
  let deletedAt: string | undefined;
  if (deleted) {
    deletedAt = requireField(fields, "deletedAt", what, isIsoTimestamp, "an ISO timestamp when deleted is true");
  } else if (fields.has("deletedAt")) {
    throw invalid(`${what} has deletedAt but is not deleted`);
  }
  const createdAt = requireField(fields, "createdAt", what, isIsoTimestamp, "an ISO timestamp");
  const updatedAt = requireField(fields, "updatedAt", what, isIsoTimestamp, "an ISO timestamp");
  const isSystem = kind === "system";
  const createdBy = readPrincipal(fields.get("createdBy"), `${what} createdBy`, isSystem, context.rules);
  const updatedBy = readPrincipal(fields.get("updatedBy"), `${what} updatedBy`, isSystem, context.rules);
  const updatedOn = requireField(fields, "updatedOn", what, isUuid, "a UUID");

  if (!fields.has("vectorClock")) {
    throw invalid(`${what} field "vectorClock" is missing`);
  }
  const vectorClock = readClock(fields.get("vectorClock"), `${what} vectorClock`);
  // The write path always bumps one of the writing replica's keys.
  if (!Object.keys(vectorClock).some((key) => writerKeyIndex(updatedOn, key) !== undefined && countFor(vectorClock, key) > 0)) {
    throw invalid(`${what} vectorClock has no entry for updatedOn ${JSON.stringify(updatedOn)} or one of its "/n" keys`);
  }

  // System documents carry lists of principals, as admins do.
  const readers = readAccessList(fields.get("readers"), `${what} readers`, isSystem ? "admins" : "readers", context.rules);
  const writers = readAccessList(fields.get("writers"), `${what} writers`, isSystem ? "admins" : "writers", context.rules);

  if (!fields.has("content") || !fields.has("fieldTypes")) {
    throw invalid(`${what} must have content and fieldTypes`);
  }
  const content = copyJsonObject(fields.get("content"), `${what} content`);
  const fieldTypes = readFieldTypes(fields.get("fieldTypes"), `${what} fieldTypes`);
  try {
    decodeContent(content, fieldTypes);
  } catch (error) {
    throw invalid(`${what} content does not decode: ${(error as Error).message}`);
  }

  if (isSystem) {
    if (parentId !== id || deleted || Object.keys(fieldTypes).length > 0) {
      throw invalid(`${what} is a system document, which must be top-level, not deleted, and have no field types`);
    }
    checkSystemContent(id, content, context, what);
  } else if (id === databaseDocId(context.databaseId) || id === aclDocId(context.databaseId)) {
    throw invalid(`${what} has a system document ID but kind "document"`);
  } else if (!isUuid(id)) {
    // Conflict row IDs are derived from the document's ID, which needs a UUID.
    throw invalid(`${what} has kind "document", whose ID must be a UUID`);
  }

  let conflictOf: string | undefined;
  if (fields.has("conflictOf")) {
    conflictOf = requireField(fields, "conflictOf", what, isUuid, "a UUID");
    if (isSystem || conflictOf === id || parentId !== conflictOf || id !== conflictRowId(conflictOf, vectorClock)) {
      throw invalid(
        `${what} is not a conflict document of ${JSON.stringify(conflictOf)}: it must be kind "document", with parentId equal to conflictOf and the ID derived from conflictOf and its clock`,
      );
    }
  }

  return {
    id,
    parentId,
    kind,
    vectorClock,
    deleted,
    ...(deletedAt === undefined ? {} : { deletedAt }),
    createdAt,
    createdBy,
    updatedAt,
    updatedBy,
    updatedOn,
    readers,
    writers,
    content,
    fieldTypes,
    ...(conflictOf === undefined ? {} : { conflictOf }),
  };
}
