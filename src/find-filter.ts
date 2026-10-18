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
  readonly where: readonly WhereCondition[];
}

const FILTER_KEYS: ReadonlySet<string> = new Set(["parentId", "topLevel", "orphaned", "where"]);

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
    return { parentId: undefined, topLevel: undefined, orphaned: undefined, where: [] };
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
