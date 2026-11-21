// The documents view's filter, kept in the address so a filtered view can be
// linked and survives a reload: field = value conditions (top-level fields,
// exact values, all must hold), In conflict, Top-level only, Orphans, and the
// children of one document. The engine ANDs them all.
//
// In the address: ?field=status&type=text&value=open, repeated per condition
// in order, then conflict=1, top=1, orphans=1 and parent=<document ID>.

import type { Schemas } from "../../api/schema.ts";
import { formatDate, parseDate } from "./fields.ts";

export type ConditionType = "text" | "number" | "boolean" | "empty" | "date";

export const CONDITION_TYPES: readonly { readonly type: ConditionType; readonly label: string }[] = [
  { type: "text", label: "text" },
  { type: "number", label: "number" },
  { type: "boolean", label: "true/false" },
  { type: "empty", label: "empty" },
  { type: "date", label: "date" },
];

export interface Condition {
  readonly field: string;
  readonly type: ConditionType;
  readonly value: string;
}

export interface Filter {
  readonly conditions: readonly Condition[];
  readonly inConflict: boolean;
  readonly topLevel: boolean;
  readonly orphaned: boolean;
  /** Only the children of this document. */
  readonly parentId: string | undefined;
}

export const NO_FILTER: Filter = { conditions: [], inConflict: false, topLevel: false, orphaned: false, parentId: undefined };

const isConditionType = (text: string): text is ConditionType => CONDITION_TYPES.some((entry) => entry.type === text);

export function filterFromSearch(search: URLSearchParams): Filter {
  const fields = search.getAll("field");
  const types = search.getAll("type");
  const values = search.getAll("value");
  const conditions = fields.map((field, index) => {
    const type = types[index] ?? "text";
    return { field, type: isConditionType(type) ? type : "text", value: values[index] ?? "" };
  });
  const parent = search.get("parent");
  return {
    conditions,
    inConflict: search.get("conflict") === "1",
    topLevel: search.get("top") === "1",
    orphaned: search.get("orphans") === "1",
    parentId: parent === null || parent === "" ? undefined : parent,
  };
}

export function filterToSearch(filter: Filter): URLSearchParams {
  const search = new URLSearchParams();
  for (const condition of filter.conditions) {
    search.append("field", condition.field);
    search.append("type", condition.type);
    search.append("value", condition.type === "empty" ? "" : condition.value);
  }
  if (filter.inConflict) search.set("conflict", "1");
  if (filter.topLevel) search.set("top", "1");
  if (filter.orphaned) search.set("orphans", "1");
  if (filter.parentId !== undefined) search.set("parent", filter.parentId);
  return search;
}

export function isFiltered(filter: Filter): boolean {
  return filter.conditions.length > 0 || filter.inConflict || filter.topLevel || filter.orphaned || filter.parentId !== undefined;
}

type FindFilter = NonNullable<Schemas["FindRequest"]["filter"]>;

export type Checked = { readonly ok: true; readonly filter: FindFilter | undefined } | { readonly ok: false; readonly problems: ReadonlyMap<number, string> };

/** The filter as find takes it, or what is wrong with each condition (by index). */
export function toFindFilter(filter: Filter): Checked {
  const problems = new Map<number, string>();
  const where: Record<string, string | number | boolean | null> = {};
  const whereTypes: Record<string, "datetime"> = {};
  filter.conditions.forEach((condition, index) => {
    const { field, value } = condition;
    if (field === "") {
      problems.set(index, "Name the field.");
      return;
    }
    if (Object.hasOwn(where, field)) {
      problems.set(index, `${field} is in the filter already.`);
      return;
    }
    switch (condition.type) {
      case "text":
        where[field] = value;
        return;
      case "number": {
        const number = Number(value.trim());
        if (value.trim() === "" || !Number.isFinite(number)) {
          problems.set(index, "Give a number.");
          return;
        }
        where[field] = number;
        return;
      }
      case "boolean":
        if (value !== "true" && value !== "false") {
          problems.set(index, "Choose true or false.");
          return;
        }
        where[field] = value === "true";
        return;
      case "empty":
        where[field] = null;
        return;
      case "date": {
        const iso = parseDate(value);
        if (iso === undefined) {
          problems.set(index, "Give a date as YYYY-MM-DD HH:MM.");
          return;
        }
        where[field] = iso;
        whereTypes[field] = "datetime";
        return;
      }
    }
  });
  if (problems.size > 0) return { ok: false, problems };
  const find: FindFilter = {
    ...(filter.conditions.length > 0 ? { where } : {}),
    ...(Object.keys(whereTypes).length > 0 ? { whereTypes } : {}),
    ...(filter.inConflict ? { inConflict: true } : {}),
    ...(filter.topLevel ? { topLevel: true } : {}),
    ...(filter.orphaned ? { orphaned: true } : {}),
    ...(filter.parentId === undefined ? {} : { parentId: filter.parentId }),
  };
  return { ok: true, filter: Object.keys(find).length === 0 ? undefined : find };
}

/** One phrase per part of the filter, for the line above the list. */
export function describeFilter(filter: Filter): string[] {
  const parts = filter.conditions.map((condition) => {
    switch (condition.type) {
      case "text":
        return `${condition.field} = "${condition.value}"`;
      case "empty":
        return `${condition.field} is empty`;
      case "date": {
        const iso = parseDate(condition.value);
        return `${condition.field} = ${iso === undefined ? condition.value : formatDate(iso)}`;
      }
      default:
        return `${condition.field} = ${condition.value}`;
    }
  });
  if (filter.inConflict) parts.push("in conflict");
  if (filter.topLevel) parts.push("top level only");
  if (filter.orphaned) parts.push("orphans");
  return parts;
}
