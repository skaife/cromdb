import { ANONYMOUS, SYSTEM, canAccess, validateAccessList, validatePrincipalName, type AccessListField } from "./acl.js";
import type { Database } from "./database.js";
import type { ChangeEntry, DocumentEnvelope, DocumentKind } from "./envelope.js";
import { CromDBError } from "./errors.js";
import { decodeContent, isPlainObject, type FieldTypes } from "./field-types.js";
import type { JsonObject, JsonValue } from "./json.js";
import { aclDocId, databaseDocId, registrationDocId } from "./system-docs.js";
import { isUnicodeVersion } from "./unicode/version.js";
import { countFor, type VectorClock } from "./vector-clock.js";

// Batches are plain JSON data, so how they travel between replicas is up to
// the caller. Everything here is pure; Database does the reads and writes.

export const BATCH_FORMAT = 1;
export const DEFAULT_EXPORT_LIMIT = 500;

/** Changed documents from one replica, each as its current version. */
export interface ChangeBatch {
  readonly format: 1;
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

export type BatchHeader = Omit<ChangeBatch, "documents">;

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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The own data properties of a plain object, which must all be in allowed.
 * Throws for anything else, including symbol keys and getters.
 */
function readObject(value: unknown, what: string, allowed?: ReadonlySet<string>): Map<string, unknown> {
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

function readArray(value: unknown, what: string): unknown[] {
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

function requireField<T>(fields: Map<string, unknown>, key: string, what: string, check: (value: unknown) => value is T, expected: string): T {
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

/** Checks the batch's shape and types. The documents are checked one by one with validateEnvelope. */
export function parseBatch(batch: unknown): { header: BatchHeader; documents: unknown[] } {
  const fields = readObject(batch, "The batch", HEADER_FIELDS);
  const format = fields.get("format");
  if (format !== BATCH_FORMAT) {
    throw invalid(`Batch format ${JSON.stringify(format)} is not supported (expected ${BATCH_FORMAT})`);
  }
  const what = "The batch";
  const header: BatchHeader = {
    format: BATCH_FORMAT,
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
}

function readClock(value: unknown, what: string): VectorClock {
  const fields = readObject(value, what);
  const entries: [string, number][] = [];
  for (const [instanceId, count] of fields) {
    if (instanceId.length === 0 || !isSeq(count)) {
      throw invalid(`${what} entry ${JSON.stringify(instanceId)} must have a non-empty key and a non-negative integer count`);
    }
    entries.push([instanceId, count]);
  }
  return Object.fromEntries(entries);
}

function readPrincipal(value: unknown, what: string, allowSystem: boolean, unicodeVersion: string): string {
  if (value === ANONYMOUS || (allowSystem && value === SYSTEM)) {
    return value;
  }
  let normalized: string | undefined;
  try {
    normalized = validatePrincipalName(value, unicodeVersion);
  } catch (error) {
    throw invalid(`${what} is not a valid principal: ${(error as Error).message}`);
  }
  if (normalized !== value) {
    throw invalid(`${what} is not in NFKC form`);
  }
  return normalized;
}

/** As validateAccessList, and the list must already be in the stored (NFKC) form. */
function readAccessList(value: unknown, what: string, field: AccessListField, unicodeVersion: string): readonly string[] {
  const items = readArray(value, what);
  let normalized: readonly string[];
  try {
    normalized = validateAccessList(items, field, unicodeVersion);
  } catch (error) {
    throw invalid(`${what}: ${(error as Error).message}`);
  }
  if (normalized.some((entry, index) => entry !== items[index])) {
    throw invalid(`${what} is not in NFKC form`);
  }
  return normalized;
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

/**
 * Checks system document content against what the engine writes, so a batch
 * can't leave this replica with an unreadable ACL or database document.
 */
function checkSystemContent(id: string, content: JsonObject, context: EnvelopeContext, what: string): void {
  const { databaseId, unicodeVersion } = context;
  if (id === databaseDocId(databaseId)) {
    const fields = readObject(content, `${what} content`, new Set(["databaseId", "createdAt", "createdOn", "unicodeVersion"]));
    if (fields.get("databaseId") !== databaseId) {
      throw invalid(`${what} is for database ${JSON.stringify(fields.get("databaseId"))}, not ${JSON.stringify(databaseId)}`);
    }
    requireField(fields, "createdAt", `${what} content`, isIsoTimestamp, "an ISO timestamp");
    requireField(fields, "createdOn", `${what} content`, isUuid, "a UUID");
    const version = requireField(fields, "unicodeVersion", `${what} content`, isUnicodeVersion, "a Unicode version");
    if (version !== unicodeVersion) {
      throw invalid(`${what} has unicodeVersion ${JSON.stringify(version)}, not ${JSON.stringify(unicodeVersion)}`);
    }
    return;
  }
  if (id === aclDocId(databaseId)) {
    const fields = readObject(content, `${what} content`, new Set(["creators", "admins"]));
    readAccessList(fields.get("creators"), `${what} creators`, "creators", unicodeVersion);
    readAccessList(fields.get("admins"), `${what} admins`, "admins", unicodeVersion);
    return;
  }
  const fields = readObject(content, `${what} content`, new Set(["instanceId", "status", "introducedBy", "introducedAt"]));
  const instanceId = fields.get("instanceId");
  if (!isUuid(instanceId) || id !== registrationDocId(databaseId, instanceId)) {
    throw invalid(`${what} is not a system document of this database`);
  }
  requireField(fields, "status", `${what} content`, (value): value is string => value === "active" || value === "retired", '"active" or "retired"');
  requireField(fields, "introducedBy", `${what} content`, (value): value is string | null => value === null || isUuid(value), "a UUID or null");
  requireField(fields, "introducedAt", `${what} content`, isIsoTimestamp, "an ISO timestamp");
}

/**
 * Checks an incoming envelope fully and returns a fresh copy. Throws
 * INVALID_BATCH if anything is malformed, and NOT_SUPPORTED for a conflict
 * document.
 */
export function validateEnvelope(value: unknown, context: EnvelopeContext): DocumentEnvelope {
  const fields = readObject(value, "A batch document", ENVELOPE_FIELDS);
  const id = requireField(fields, "id", "A batch document", isNonEmptyString, "a non-empty string");
  const what = `Batch document ${JSON.stringify(id)}`;

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
  const createdBy = readPrincipal(fields.get("createdBy"), `${what} createdBy`, isSystem, context.unicodeVersion);
  const updatedBy = readPrincipal(fields.get("updatedBy"), `${what} updatedBy`, isSystem, context.unicodeVersion);
  const updatedOn = requireField(fields, "updatedOn", what, isUuid, "a UUID");

  if (!fields.has("vectorClock")) {
    throw invalid(`${what} field "vectorClock" is missing`);
  }
  const vectorClock = readClock(fields.get("vectorClock"), `${what} vectorClock`);
  // The write path always bumps the writing replica's entry.
  if (countFor(vectorClock, updatedOn) === 0) {
    throw invalid(`${what} vectorClock has no entry for updatedOn ${JSON.stringify(updatedOn)}`);
  }

  // System documents carry lists of named principals, as admins do.
  const readers = readAccessList(fields.get("readers"), `${what} readers`, isSystem ? "admins" : "readers", context.unicodeVersion);
  const writers = readAccessList(fields.get("writers"), `${what} writers`, isSystem ? "admins" : "writers", context.unicodeVersion);

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
  }

  if (fields.has("conflictOf")) {
    throw new CromDBError("NOT_SUPPORTED", `${what} is a conflict document; replicating conflicts is not supported yet`);
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
  };
}
