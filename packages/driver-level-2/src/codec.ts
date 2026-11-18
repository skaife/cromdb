// Content on the wire is JSON plus fieldTypes, the engine's stored form: JSON
// Pointers to the fields that hold a datetime, as ISO strings. The engine
// takes and gives content with Date values, and doesn't export its own codec,
// so this is the same rule set, written again.

import { DriverError, type FieldTypes, type JsonObject, type JsonValue } from "@cromdb/driver";

function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function invalid(what: string, pointer: string, problem: string): DriverError {
  return new DriverError("INVALID_INPUT", `${what} at "${pointer}" ${problem}`, { path: pointer });
}

/** The Date for an ISO string, only in the exact form toISOString writes, or undefined. */
export function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : date;
}

function decodeValue(value: JsonValue, pointer: string, datetimes: Set<string>, what: string): unknown {
  if (datetimes.has(pointer)) {
    datetimes.delete(pointer);
    const date = parseTimestamp(value);
    if (date === undefined) {
      throw invalid(what, pointer, "is marked datetime but is not an ISO string as toISOString writes it");
    }
    return date;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => decodeValue(item, `${pointer}/${index}`, datetimes, what));
  }
  if (typeof value === "object" && value !== null) {
    return decodeObject(value, pointer, datetimes, what);
  }
  return value;
}

function decodeObject(value: JsonObject, pointer: string, datetimes: Set<string>, what: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, decodeValue(value[key] as JsonValue, `${pointer}/${escapeSegment(key)}`, datetimes, what)]),
  );
}

/**
 * Content for the engine: each field fieldTypes marks as a datetime becomes a
 * Date. INVALID_INPUT if a marked field isn't an exact ISO string or a
 * pointer doesn't lead to a field (the content root can't be a datetime).
 * what names the input for messages, such as "content".
 */
export function decodeContent(content: JsonObject, fieldTypes: FieldTypes | undefined, what = "content"): Record<string, unknown> {
  const datetimes = new Set(Object.keys(fieldTypes ?? {}));
  const decoded = decodeObject(content, "", datetimes, what);
  const [unresolved] = datetimes;
  if (unresolved !== undefined) {
    throw invalid(what, unresolved, "is marked datetime in fieldTypes but there is no such field");
  }
  return decoded;
}

function encodeValue(value: unknown, pointer: string, dates: string[]): JsonValue {
  if (value instanceof Date) {
    dates.push(pointer);
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => encodeValue(item, `${pointer}/${index}`, dates));
  }
  if (typeof value === "object" && value !== null) {
    return encodeObject(value as Record<string, unknown>, pointer, dates);
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value === 0 ? 0 : value;
  }
  throw new Error(`The engine gave content with a ${typeof value} at "${pointer}"`);
}

function encodeObject(value: Record<string, unknown>, pointer: string, dates: string[]): JsonObject {
  return Object.fromEntries(Object.keys(value).map((key) => [key, encodeValue(value[key], `${pointer}/${escapeSegment(key)}`, dates)]));
}

/** Content from the engine, with Date values, as JSON plus fieldTypes. */
export function encodeContent(content: Record<string, unknown>): { content: JsonObject; fieldTypes: FieldTypes } {
  const dates: string[] = [];
  const encoded = encodeObject(content, "", dates);
  return { content: encoded, fieldTypes: Object.fromEntries(dates.map((pointer) => [pointer, "datetime" as const])) };
}
