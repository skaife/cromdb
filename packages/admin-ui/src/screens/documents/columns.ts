// What the documents view shows per row: a title, any extra columns the
// person added (kept per database in the browser), and how a value looks in
// a cell.

import { readStored, writeStored } from "../../app/storage.ts";
import type { Schemas } from "../../api/schema.ts";
import { escapeSegment, formatDate } from "./fields.ts";

type Document = Schemas["Document"];

const key = (databaseId: string) => `columns.${databaseId}`;

export function loadColumns(databaseId: string): string[] {
  const text = readStored(key(databaseId));
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && item !== ""))] : [];
  } catch {
    return [];
  }
}

export function saveColumns(databaseId: string, columns: readonly string[]): void {
  writeStored(key(databaseId), columns.length === 0 ? undefined : JSON.stringify(columns));
}

const isDate = (document: Document, field: string) => Object.hasOwn(document.fieldTypes, `/${escapeSegment(field)}`);

/** The "title" field if it is text, else the first text field that isn't a date, else nothing (the ID is shown). */
export function titleOf(document: Document): string | undefined {
  const { content } = document;
  const title = Object.hasOwn(content, "title") ? content["title"] : undefined;
  if (typeof title === "string" && title.trim() !== "" && !isDate(document, "title")) return title;
  for (const field of Object.keys(content)) {
    const value = content[field];
    if (typeof value === "string" && value.trim() !== "" && !isDate(document, field)) return value;
  }
  return undefined;
}

export interface Cell {
  readonly text: string;
  /** Shown greyed: no such field, or an empty value. */
  readonly muted?: boolean;
}

const LONG = 60;

/** A top-level field's value as a cell shows it. */
export function cellOf(document: Document, field: string): Cell {
  const { content } = document;
  if (!Object.hasOwn(content, field)) return { text: "", muted: true };
  const value = content[field];
  if (value === null) return { text: "empty", muted: true };
  if (typeof value === "string") return { text: isDate(document, field) ? formatDate(value) : value };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value) };
  const json = JSON.stringify(value);
  return { text: json.length > LONG ? `${json.slice(0, LONG)}…` : json };
}
