import type { JsonObject, JsonValue } from "./json.js";

export type FieldType = "datetime";
export type FieldTypes = Readonly<Record<string, FieldType>>;

// FieldTypes keys are JSON Pointers (RFC 6901) into content, such as "/due"
// or "/items/0/shippedAt". Content keys are arbitrary user strings, so objects
// are always built with Object.fromEntries and read through own keys only.

export function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function describe(pointer: string): string {
  return pointer === "" ? "content root" : `"${pointer}"`;
}

export function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeName(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return typeof value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const name: unknown =
    typeof prototype === "object" && prototype !== null && Object.hasOwn(prototype, "constructor")
      ? (prototype as { constructor: unknown }).constructor
      : undefined;
  return typeof name === "function" && name.name !== "" ? name.name : "object";
}

function encodeValue(value: unknown, pointer: string, dates: string[]): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot encode value at ${describe(pointer)}: ${value} is not a finite number`);
    }
    // JSON cannot represent -0; store it as 0 rather than let JSON do it later.
    return value === 0 ? 0 : value;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`Cannot encode value at ${describe(pointer)}: invalid Date`);
    }
    dates.push(pointer);
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new TypeError(
        `Cannot encode value at ${describe(pointer)}: array has holes or non-index properties`,
      );
    }
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const itemPointer = `${pointer}/${index}`;
      const item: unknown = value[index];
      if (item === undefined) {
        throw new TypeError(`Cannot encode value at ${describe(itemPointer)}: undefined array element`);
      }
      items.push(encodeValue(item, itemPointer, dates));
    }
    return items;
  }

  if (typeof value === "object" && isPlainObject(value)) {
    return encodeObject(value as Record<string, unknown>, pointer, dates);
  }

  throw new TypeError(`Cannot encode value at ${describe(pointer)}: unsupported type ${typeName(value)}`);
}

function encodeObject(value: Record<string, unknown>, pointer: string, dates: string[]): JsonObject {
  const entries: [string, JsonValue][] = [];
  for (const key of Object.keys(value)) {
    const property: unknown = value[key];
    if (property !== undefined) {
      entries.push([key, encodeValue(property, `${pointer}/${escapeSegment(key)}`, dates)]);
    }
  }
  return Object.fromEntries(entries);
}

export function encodeContent(content: Record<string, unknown>): {
  content: JsonObject;
  fieldTypes: FieldTypes;
} {
  if (typeof content !== "object" || content === null || Array.isArray(content) || !isPlainObject(content)) {
    throw new TypeError(`Cannot encode content root: expected a plain object, got ${typeName(content)}`);
  }

  const dates: string[] = [];
  const encoded = encodeObject(content, "", dates);
  const fieldTypes: FieldTypes = Object.fromEntries(dates.map((pointer) => [pointer, "datetime"]));
  return { content: encoded, fieldTypes };
}

function decodeValue(value: JsonValue, pointer: string, datetimes: Set<string>): unknown {
  if (datetimes.has(pointer)) {
    datetimes.delete(pointer);
    // Only the exact toISOString() form is accepted. Other formats can parse
    // differently depending on the machine's time zone.
    const date = typeof value === "string" ? new Date(value) : undefined;
    if (date === undefined || Number.isNaN(date.getTime()) || date.toISOString() !== value) {
      throw new TypeError(`Cannot decode value at ${describe(pointer)}: not a valid datetime string`);
    }
    return date;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => decodeValue(item, `${pointer}/${index}`, datetimes));
  }

  if (typeof value === "object" && value !== null) {
    return decodeObject(value, pointer, datetimes);
  }

  return value;
}

function decodeObject(value: JsonObject, pointer: string, datetimes: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value).map((key) => {
      const property = value[key] as JsonValue;
      return [key, decodeValue(property, `${pointer}/${escapeSegment(key)}`, datetimes)];
    }),
  );
}

export function decodeContent(content: JsonObject, fieldTypes: FieldTypes): Record<string, unknown> {
  const datetimes = new Set<string>();
  for (const pointer of Object.keys(fieldTypes)) {
    const fieldType: unknown = fieldTypes[pointer];
    if (fieldType !== "datetime") {
      throw new TypeError(`Cannot decode value at ${describe(pointer)}: unknown field type ${String(fieldType)}`);
    }
    datetimes.add(pointer);
  }

  // Each pointer is matched against the canonical pointers produced while
  // walking content, so only canonical array indexes ever resolve.
  const decoded = decodeObject(content, "", datetimes);

  const [unresolved] = datetimes;
  if (unresolved !== undefined) {
    throw new TypeError(`Cannot decode value at ${describe(unresolved)}: pointer does not resolve`);
  }
  return decoded;
}
