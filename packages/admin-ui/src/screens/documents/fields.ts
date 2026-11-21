// A document's content as rows the inspector edits, one per top-level field,
// and back. Each row has a type: text, number, true/false, empty (null), date
// or JSON (anything else, edited as JSON text). A date is a text value the
// document's fieldTypes marks "datetime"; it is shown in the browser's time
// zone. Dates inside a JSON value (fieldTypes such as "/due/start") can't be
// shown as dates in JSON text, so they are kept as they are and shown under
// the field, read-only; a save is refused if the JSON no longer has a date
// where one of them points.
//
// Nothing is guessed: changing a row's type converts its value only when the
// value means the same thing in the new type ("12" to the number 12), and is
// refused otherwise.

export type FieldType = "text" | "number" | "boolean" | "empty" | "date" | "json";

export const FIELD_TYPES: readonly { readonly type: FieldType; readonly label: string }[] = [
  { type: "text", label: "text" },
  { type: "number", label: "number" },
  { type: "boolean", label: "true/false" },
  { type: "empty", label: "empty" },
  { type: "date", label: "date" },
  { type: "json", label: "JSON" },
];

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type FieldTypes = Readonly<Record<string, "datetime">>;

export interface FieldRow {
  /** Stays the same while the row is edited; for React and for messages. */
  readonly key: string;
  readonly name: string;
  /** A row added in the inspector: its name can be edited. */
  readonly added: boolean;
  readonly type: FieldType;
  /** The value as the editor shows it. */
  readonly text: string;
  /** As loaded: a date whose text is unchanged keeps its exact stored value. */
  readonly loaded?: { readonly type: FieldType; readonly text: string; readonly value: Json };
  /** Pointers below this field that fieldTypes marks as dates, relative to the field ("/start"). */
  readonly nestedDates: readonly string[];
}

// ---------------------------------------------------------------------------
// JSON Pointers (RFC 6901)

export function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The value a pointer names inside value ("" is value itself), or undefined. */
export function valueAt(value: Json, pointer: string): Json | undefined {
  if (pointer === "") return value;
  let here: Json | undefined = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = unescapeSegment(raw);
    if (Array.isArray(here)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      here = (here as readonly Json[])[Number(segment)];
    } else if (typeof here === "object" && here !== null) {
      const object: { readonly [key: string]: Json } = here as { readonly [key: string]: Json };
      here = Object.hasOwn(object, segment) ? object[segment] : undefined;
    } else {
      return undefined;
    }
    if (here === undefined) return undefined;
  }
  return here;
}

// ---------------------------------------------------------------------------
// Dates

/** The Date for an ISO string in exactly the form toISOString writes, as the server requires. */
export function exactTimestamp(value: string): Date | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "2026-11-24 17:00" in the browser's time zone; seconds and milliseconds only when there are any. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let text = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getSeconds() !== 0 || date.getMilliseconds() !== 0) text += `:${pad(date.getSeconds())}`;
  if (date.getMilliseconds() !== 0) text += `.${pad(date.getMilliseconds(), 3)}`;
  return text;
}

// Five-digit years: east of UTC, the last hours of 9999 are in 10000 locally.
const LOCAL = /^(\d{4,5})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The stored form (toISOString) of a date typed as local time, "YYYY-MM-DD"
 * with an optional " HH:MM", ":SS" and ".mmm", or as an ISO string with Z or
 * an offset. Undefined for anything else, and for a local time that doesn't
 * exist (Feb 30, or the hour skipped when clocks go forward).
 */
export function parseDate(text: string): string | undefined {
  const trimmed = text.trim();
  const local = LOCAL.exec(trimmed);
  if (local !== null) {
    const [, y = "", mo = "", d = "", h = "0", mi = "0", sec = "0", ms = ""] = local;
    const [year, month, day, hours, minutes, seconds] = [y, mo, d, h, mi, sec].map(Number) as [number, number, number, number, number, number];
    const date = new Date(2000, 0, 1);
    date.setFullYear(year, month - 1, day);
    date.setHours(hours, minutes, seconds, ms === "" ? 0 : Number(ms.padEnd(3, "0")));
    const same =
      date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day && date.getHours() === hours && date.getMinutes() === minutes && date.getSeconds() === seconds;
    return same ? date.toISOString() : undefined;
  }
  if (ZONED.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// One value

const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

export type Parsed = { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly message: string };

/** The value a row stands for, or why it has none. */
export function parseRow(row: FieldRow): Parsed {
  if (row.loaded !== undefined && row.loaded.type === row.type && row.loaded.text === row.text) {
    return { ok: true, value: row.loaded.value };
  }
  switch (row.type) {
    case "text":
      return { ok: true, value: row.text };
    case "number": {
      const text = row.text.trim();
      const value = Number(text);
      return NUMBER.test(text) && Number.isFinite(value) ? { ok: true, value: value === 0 ? 0 : value } : { ok: false, message: "Give a number, such as 12 or -3.5." };
    }
    case "boolean":
      return row.text === "true" || row.text === "false" ? { ok: true, value: row.text === "true" } : { ok: false, message: "Choose true or false." };
    case "empty":
      return { ok: true, value: null };
    case "date": {
      const iso = parseDate(row.text);
      return iso === undefined ? { ok: false, message: "Give a date as YYYY-MM-DD, with a time as HH:MM if you like." } : { ok: true, value: iso };
    }
    case "json":
      try {
        return { ok: true, value: JSON.parse(row.text) as Json };
      } catch {
        return { ok: false, message: "This isn't valid JSON." };
      }
  }
}

/** How a value is shown for editing as a type. */
function textFor(type: FieldType, value: Json): string {
  switch (type) {
    case "text":
      return typeof value === "string" ? value : "";
    case "number":
    case "boolean":
      return String(value);
    case "empty":
      return "";
    case "date":
      return typeof value === "string" ? formatDate(value) : "";
    case "json":
      return JSON.stringify(value);
  }
}

/** The type a value is shown as, without fieldTypes. */
function typeOfValue(value: Json): FieldType {
  if (value === null) return "empty";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

const label = (type: FieldType) => FIELD_TYPES.find((entry) => entry.type === type)?.label ?? type;

function quoted(text: string): string {
  return text.length > 40 ? `"${text.slice(0, 40)}…"` : `"${text}"`;
}

/**
 * The row as another type, or why it can't be: a value converts only when it
 * means the same in the new type. Any value can become empty, and an empty
 * row becomes a blank one of any type, to be filled in.
 */
export function changeType(row: FieldRow, type: FieldType): { readonly ok: true; readonly row: FieldRow } | { readonly ok: false; readonly message: string } {
  if (type === row.type) return { ok: true, row };
  const as = (text: string): { ok: true; row: FieldRow } => ({ ok: true, row: { ...row, type, text } });
  if (type === "empty") return as("");
  if (row.type === "empty") return as(type === "json" ? "null" : "");
  const parsed = parseRow(row);
  if (!parsed.ok) return { ok: false, message: `Fix the value first: ${parsed.message}` };
  const value = parsed.value;
  // Blank text is no value yet: it becomes a blank of any type.
  if (value === "" && row.type === "text" && type !== "json") return as("");
  const what = { text: "text", number: "a number", boolean: "true or false", date: "a date", json: "JSON", empty: "empty" }[type];
  const refused = { ok: false as const, message: `${typeof value === "string" ? quoted(value) : `This ${label(row.type)} value`} can't become ${what}.` };
  switch (type) {
    case "json":
      return as(JSON.stringify(value));
    case "text":
      if (typeof value === "string") return as(value);
      if (typeof value === "number" || typeof value === "boolean") return as(String(value));
      return refused;
    case "number": {
      const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : undefined;
      return text !== undefined && NUMBER.test(text) && Number.isFinite(Number(text)) ? as(text) : refused;
    }
    case "boolean":
      if (typeof value === "boolean") return as(String(value));
      if (value === "true" || value === "false") return as(value);
      return refused;
    case "date": {
      const iso = typeof value === "string" ? parseDate(value) : undefined;
      return iso === undefined ? refused : as(formatDate(iso));
    }
  }
}

// ---------------------------------------------------------------------------
// The whole content

let nextKey = 0;
export function newKey(): string {
  nextKey += 1;
  return `f${nextKey}`;
}

/** One row per top-level field, in the content's order. */
export function contentToRows(content: { readonly [key: string]: unknown }, fieldTypes: FieldTypes): FieldRow[] {
  return Object.keys(content).map((name) => {
    const value = content[name] as Json;
    const pointer = `/${escapeSegment(name)}`;
    const isDate = Object.hasOwn(fieldTypes, pointer) && typeof value === "string";
    const type = isDate ? "date" : typeOfValue(value);
    const text = textFor(type, value);
    const nestedDates = Object.keys(fieldTypes)
      .filter((key) => key.startsWith(`${pointer}/`))
      .map((key) => key.slice(pointer.length))
      .sort();
    return { key: newKey(), name, added: false, type, text, loaded: { type, text, value }, nestedDates };
  });
}

/** A blank row for a field added in the inspector. */
export function blankRow(): FieldRow {
  return { key: newKey(), name: "", added: true, type: "text", text: "", nestedDates: [] };
}

export type Built =
  | { readonly ok: true; readonly content: { [key: string]: Json }; readonly fieldTypes: Record<string, "datetime"> }
  | { readonly ok: false; readonly problems: ReadonlyMap<string, string> };

/** The content and fieldTypes the rows stand for, or what is wrong with each row (by key). */
export function rowsToContent(rows: readonly FieldRow[]): Built {
  const problems = new Map<string, string>();
  const entries: [string, Json][] = [];
  const fieldTypes: Record<string, "datetime"> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    // A field already called "" is kept: JSON allows it. A new one needs a name.
    if (row.name === "" && row.added) {
      problems.set(row.key, "Give the field a name.");
      continue;
    }
    if (seen.has(row.name)) {
      problems.set(row.key, `There is already a field called ${quoted(row.name)}.`);
      continue;
    }
    seen.add(row.name);
    const parsed = parseRow(row);
    if (!parsed.ok) {
      problems.set(row.key, parsed.message);
      continue;
    }
    const pointer = `/${escapeSegment(row.name)}`;
    if (row.type === "date") fieldTypes[pointer] = "datetime";
    const lost = row.nestedDates.find((inner) => {
      const there = valueAt(parsed.value, inner);
      return typeof there !== "string" || exactTimestamp(there) === undefined;
    });
    if (lost !== undefined) {
      problems.set(row.key, `${lost} is a date, and the JSON no longer has one there. Put it back as it was, or remove the field.`);
      continue;
    }
    for (const inner of row.nestedDates) fieldTypes[`${pointer}${inner}`] = "datetime";
    entries.push([row.name, parsed.value]);
  }
  if (problems.size > 0) return { ok: false, problems };
  return { ok: true, content: Object.fromEntries(entries), fieldTypes };
}

/** Whether the rows differ from what was loaded: as text, so a value retyped the same counts as unchanged. */
export function rowsSignature(rows: readonly FieldRow[]): string {
  return JSON.stringify(rows.map((row) => [row.name, row.type, row.text]));
}
