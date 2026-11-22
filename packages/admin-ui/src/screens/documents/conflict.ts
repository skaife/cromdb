// A conflict as a table: one column per version the person can read, one
// row per field found in any of them, and which rows differ among the
// versions that keep the document (one that deletes it has its own row).
// Values compare as JSON with object keys in any order, and a date differs
// from the same text that isn't marked a date.

import type { Schemas } from "../../api/schema.ts";
import { escapeSegment, formatDate } from "./fields.ts";

type Version = Schemas["ConflictVersion"];

export interface ConflictCell {
  readonly text: string;
  /** Greyed: no such field, empty, or a deleted version. */
  readonly muted?: boolean;
  /** Shown in monospace: JSON. */
  readonly json?: boolean;
}

export interface ConflictRow {
  readonly field: string;
  readonly cells: readonly ConflictCell[];
  readonly differs: boolean;
}

/** JSON with every object's keys sorted, so key order doesn't count as a difference. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const isDate = (document: Version["document"], field: string) => Object.hasOwn(document.fieldTypes, `/${escapeSegment(field)}`);

/** Dates inside a field's value, which count toward whether it differs. */
function nestedDates(document: Version["document"], field: string): string {
  const prefix = `/${escapeSegment(field)}/`;
  return Object.keys(document.fieldTypes)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .join("|");
}

/** What a version holds for a field, for comparing: absent, or value plus which parts are dates. */
function key(version: Version, field: string): string {
  const { content } = version.document;
  if (version.deleted || !Object.hasOwn(content, field)) return "absent";
  return `${canonical(content[field])}#${isDate(version.document, field) ? "date" : ""}#${nestedDates(version.document, field)}`;
}

function cell(version: Version, field: string): ConflictCell {
  const { content } = version.document;
  if (version.deleted) return { text: "", muted: true };
  if (!Object.hasOwn(content, field)) return { text: "(no field)", muted: true };
  const value = content[field];
  if (value === null) return { text: "(empty)", muted: true };
  if (typeof value === "string") return { text: isDate(version.document, field) ? formatDate(value) : value };
  if (typeof value === "number" || typeof value === "boolean") return { text: String(value) };
  return { text: JSON.stringify(value), json: true };
}

/** Every field in any version: the primary's in its order, then the others' new ones in theirs. */
export function conflictFields(versions: readonly Version[]): string[] {
  const seen = new Set<string>();
  const ordered = [...versions].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  for (const version of ordered) {
    if (version.deleted) continue;
    for (const field of Object.keys(version.document.content)) seen.add(field);
  }
  return [...seen];
}

/** A row differs when the versions that keep the document disagree on it; a deleting version has its own row. */
export function conflictRows(versions: readonly Version[]): ConflictRow[] {
  const kept = versions.filter((version) => !version.deleted);
  return conflictFields(versions).map((field) => {
    const keys = kept.map((version) => key(version, field));
    return { field, cells: versions.map((version) => cell(version, field)), differs: new Set(keys).size > 1 };
  });
}

/** Whether two lists name the same principals, in any order. */
export function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return canonical([...a].sort()) === canonical([...b].sort());
}

/** The primary first, then the others in the order the server gave (by rank). */
export function orderVersions(versions: readonly Version[]): Version[] {
  return [...versions].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}
