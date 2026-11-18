import { DriverError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** A JSON Pointer to where a value is, for messages: "" is the whole input. */
function pointer(path: readonly (string | number)[]): string {
  return path.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function describe(path: readonly (string | number)[]): string {
  return path.length === 0 ? "the input" : `input at "${pointer(path)}"`;
}

function invalid(path: readonly (string | number)[], problem: string): DriverError {
  return new DriverError("INVALID_INPUT", `${describe(path)} ${problem}`, { path: pointer(path) });
}

function check(value: unknown, path: (string | number)[], seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(path, `is ${String(value)}, which JSON can't hold`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw invalid(path, `is ${value === undefined ? "undefined" : `a ${typeof value}`}, which JSON can't hold`);
  }
  if (seen.has(value)) {
    throw invalid(path, "refers back to itself");
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw invalid(path, "is not a plain object or array");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalid(path, "has symbol keys");
  }
  seen.add(value);
  const keys = Object.getOwnPropertyNames(value);
  if (isArray) {
    // Every own name but "length" must be an index, and every index present.
    const length = (value as unknown[]).length;
    if (keys.length !== length + 1) {
      throw invalid(path, "is an array with holes or extra properties");
    }
  }
  for (const key of keys) {
    if (isArray && key === "length") {
      continue;
    }
    if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw invalid(path, "is an array with holes or extra properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined) {
      throw invalid([...path, key], "is a getter or setter");
    }
    if (!descriptor.enumerable) {
      throw invalid([...path, key], "is not enumerable");
    }
    check(descriptor.value, [...path, isArray ? Number(key) : key], seen);
  }
  seen.delete(value);
}

/**
 * Throws INVALID_INPUT unless value is plain JSON: plain objects and arrays,
 * strings, finite numbers, booleans and null. No undefined, Date, class
 * instance, function, symbol key, getter, hole or cycle. -0 is allowed (JSON
 * writes it as 0).
 */
export function checkPlainJson(value: unknown): asserts value is JsonValue {
  check(value, [], new Set());
}

/** Whether value is plain JSON, as checkPlainJson decides. */
export function isPlainJson(value: unknown): value is JsonValue {
  try {
    checkPlainJson(value);
    return true;
  } catch {
    return false;
  }
}

/** A fresh deep copy of plain JSON, so neither side can change the other's. */
export function copyJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
