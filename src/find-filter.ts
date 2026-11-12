import { createHash } from "node:crypto";
import type { DocumentEnvelope } from "./envelope.js";
import { escapeSegment, isPlainObject } from "./field-types.js";
import type { JsonPrimitive } from "./json.js";

/** What Database.find looks for. All given conditions must hold. */
export interface FindFilter {
  /** Children of this document, not the document itself. */
  parentId?: string;
  /** true: only top-level documents (parentId equals id). false: only the rest. */
  topLevel?: boolean;
  /**
   * true: only documents whose parent is missing or deleted. false: only the
   * rest. A top-level document is never orphaned, and a parent the session
   * can't read still counts as present.
   */
  orphaned?: boolean;
  /**
   * true: only documents in conflict (see Document.conflict). false: only the
   * rest. Conflict versions themselves never appear in find.
   */
  inConflict?: boolean;
  /**
   * Top-level content fields that must equal these values. Types must match
   * exactly: a Date matches only a datetime field with the same instant, and
   * a string never matches a datetime field. null matches a field that is
   * present and null, not a missing one.
   */
  where?: Record<string, JsonPrimitive | Date>;
}

/** @internal One "where" entry, with a Date turned into its stored form. */
export interface WhereCondition {
  readonly key: string;
  readonly value: JsonPrimitive;
  readonly datetime: boolean;
}

/** @internal A checked filter. */
export interface ParsedFindFilter {
  readonly parentId: string | undefined;
  readonly topLevel: boolean | undefined;
  readonly orphaned: boolean | undefined;
  readonly inConflict: boolean | undefined;
  readonly where: readonly WhereCondition[];
}

const FILTER_KEYS: ReadonlySet<string> = new Set(["parentId", "topLevel", "orphaned", "inConflict", "where"]);

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value === "object" ? "an object" : String(value);
}

function parseWhereValue(key: string, value: unknown): WhereCondition {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`Invalid find filter: where ${JSON.stringify(key)} is an invalid Date`);
    }
    return { key, value: value.toISOString(), datetime: true };
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { key, value, datetime: false };
  }
  throw new TypeError(
    `Invalid find filter: where ${JSON.stringify(key)} must be a string, finite number, boolean, null or Date, not ${describeValue(value)}`,
  );
}

function optional<V>(filter: Record<string, unknown>, key: string, check: (value: unknown) => value is V, expected: string): V | undefined {
  const value = Object.hasOwn(filter, key) ? filter[key] : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (!check(value)) {
    throw new TypeError(`Invalid find filter: ${key} must be ${expected}`);
  }
  return value;
}

/** @internal Throws TypeError (or RangeError for an invalid Date) for anything find doesn't accept. */
export function parseFindFilter(filter: unknown): ParsedFindFilter {
  if (filter === undefined) {
    return { parentId: undefined, topLevel: undefined, orphaned: undefined, inConflict: undefined, where: [] };
  }
  if (!isPlainObjectValue(filter)) {
    throw new TypeError("Invalid find filter: expected a plain object");
  }
  for (const key of Object.keys(filter)) {
    if (!FILTER_KEYS.has(key)) {
      throw new TypeError(`Invalid find filter: unknown key ${JSON.stringify(key)}`);
    }
  }
  const isString = (value: unknown): value is string => typeof value === "string";
  const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
  const where = optional(filter, "where", isPlainObjectValue, "a plain object");
  return {
    parentId: optional(filter, "parentId", isString, "a string"),
    topLevel: optional(filter, "topLevel", isBoolean, "a boolean"),
    orphaned: optional(filter, "orphaned", isBoolean, "a boolean"),
    inConflict: optional(filter, "inConflict", isBoolean, "a boolean"),
    where: where === undefined ? [] : Object.keys(where).map((key) => parseWhereValue(key, where[key])),
  };
}

/** @internal Whether the stored document meets every "where" condition. */
export function matchesWhere(envelope: DocumentEnvelope, where: readonly WhereCondition[]): boolean {
  const { content, fieldTypes } = envelope;
  return where.every(({ key, value, datetime }) => {
    if (!Object.hasOwn(content, key) || content[key] !== value) {
      return false;
    }
    const pointer = `/${escapeSegment(key)}`;
    return (Object.hasOwn(fieldTypes, pointer) && fieldTypes[pointer] === "datetime") === datetime;
  });
}

/**
 * @internal Find order: createdAt, then id. Plain string comparison, which
 * is chronological for the toISOString form createdAt is written in.
 */
export function compareCreated(a: DocumentEnvelope, b: DocumentEnvelope): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Paging for Database.find. With limit, find returns one page: a
 * DocumentSet of at most limit documents, whose next is the after for the
 * following page.
 */
export interface FindOptions {
  /** Most documents in the page, 1 to 1000. Without it, find returns every match. */
  limit?: number;
  /** The next of the previous page. Only with limit; omit it for the first page. */
  after?: string;
}

/** @internal A position in find order. */
export interface FindPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** @internal Checked paging options. */
export interface ParsedFindOptions {
  readonly limit: number;
  readonly after: FindPosition | undefined;
  /** Identifies the filter, so a cursor is only used with the filter it came from. */
  readonly filterKey: string;
}

export const MAX_FIND_LIMIT = 1000;

const OPTION_KEYS: ReadonlySet<string> = new Set(["limit", "after"]);
const CURSOR_VERSION = 1;

/**
 * A short hash of the checked filter. Absent conditions and where entries in
 * any order give the same key.
 */
function filterKey(filter: ParsedFindFilter): string {
  const where = [...filter.where]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ key, value, datetime }) => [key, value, datetime]);
  const text = JSON.stringify([filter.parentId ?? null, filter.topLevel ?? null, filter.orphaned ?? null, filter.inConflict ?? null, where]);
  return createHash("sha256").update(text, "utf8").digest("base64url").slice(0, 22);
}

/** @internal The cursor for the position after this one, for the same filter. */
export function encodeCursor(position: FindPosition, options: ParsedFindOptions): string {
  const text = JSON.stringify({ v: CURSOR_VERSION, c: position.createdAt, i: position.id, f: options.filterKey });
  return Buffer.from(text, "utf8").toString("base64url");
}

function decodeCursor(cursor: string, key: string): FindPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const field = (name: string): unknown =>
    typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, name) ? (parsed as Record<string, unknown>)[name] : undefined;
  const createdAt = field("c");
  const id = field("i");
  if (field("v") !== CURSOR_VERSION || typeof createdAt !== "string" || typeof id !== "string" || typeof field("f") !== "string") {
    throw new TypeError("Invalid find options: after is not a cursor from find");
  }
  if (field("f") !== key) {
    throw new TypeError("Invalid find options: after is a cursor from find with a different filter");
  }
  return { createdAt, id };
}

/**
 * @internal undefined when find returns every match (no options, or no
 * limit). Throws TypeError for anything else find doesn't accept.
 */
export function parseFindOptions(options: unknown, filter: ParsedFindFilter): ParsedFindOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (!isPlainObjectValue(options)) {
    throw new TypeError("Invalid find options: expected a plain object");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(`Invalid find options: unknown key ${JSON.stringify(key)}`);
    }
  }
  const limit = Object.hasOwn(options, "limit") ? options["limit"] : undefined;
  const after = Object.hasOwn(options, "after") ? options["after"] : undefined;
  if (limit === undefined) {
    if (after !== undefined) {
      throw new TypeError("Invalid find options: after needs limit");
    }
    return undefined;
  }
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_FIND_LIMIT) {
    throw new TypeError(`Invalid find options: limit must be an integer from 1 to ${MAX_FIND_LIMIT}, got ${typeof limit === "string" ? JSON.stringify(limit) : describeValue(limit)}`);
  }
  if (after !== undefined && typeof after !== "string") {
    throw new TypeError("Invalid find options: after must be a string");
  }
  const key = filterKey(filter);
  return { limit: limit as number, after: after === undefined ? undefined : decodeCursor(after, key), filterKey: key };
}

/** @internal Whether the document comes after the position in find order. */
export function isAfter(envelope: DocumentEnvelope, position: FindPosition): boolean {
  return envelope.createdAt > position.createdAt || (envelope.createdAt === position.createdAt && envelope.id > position.id);
}
