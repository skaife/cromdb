// The Access tab's grid: one row per name in any of the ACL's five lists,
// one box per list, and back to the lists for saving. The engine reads each
// list on its own (noAccess overrides the others) and "*" in a list admits
// everyone who logs in, so the warnings work out what each person really
// gets, "*" included.

import { EVERYONE, SERVER_PRINCIPAL } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";

export const LISTS = ["admins", "creators", "writers", "readers", "noAccess"] as const;
export type ListName = (typeof LISTS)[number];
export type Lists = { readonly [list in ListName]: readonly string[] };

/** The column headings, in list order. */
export const LIST_LABELS: { readonly [list in ListName]: string } = {
  admins: "Admin",
  creators: "Creator",
  writers: "Writer",
  readers: "Reader",
  noAccess: "No access",
};

export interface GridRow {
  readonly id: string;
  readonly in: { readonly [list in ListName]: boolean };
}

/** Whether a box can be changed: never on the server's row; "*" can't be an admin or locked out. */
export function editable(id: string, list: ListName): boolean {
  if (id === SERVER_PRINCIPAL) return false;
  if (id === EVERYONE) return list !== "admins" && list !== "noAccess";
  return true;
}

/** Whether a box means anything at all for this row ("n/a" when not). */
export function applies(id: string, list: ListName): boolean {
  return !(id === EVERYONE && (list === "admins" || list === "noAccess"));
}

/** The lists of an ACL. */
export function listsOf(acl: Schemas["AclLists"]): Lists {
  return { admins: acl.admins, creators: acl.creators, writers: acl.writers, readers: acl.readers, noAccess: acl.noAccess };
}

/** The rows: the server first, then "*", then the person logged in, then everyone else in the order they first appear. */
export function gridRows(lists: Lists, me: string): GridRow[] {
  const ids: string[] = [];
  for (const list of LISTS) for (const id of lists[list]) if (!ids.includes(id)) ids.push(id);
  const rank = (id: string) => (id === SERVER_PRINCIPAL ? 0 : id === EVERYONE ? 1 : id === me ? 2 : 3);
  const ordered = ids.map((id, index) => ({ id, index })).sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index);
  return ordered.map(({ id }) => ({ id, in: rowFlags(lists, id) }));
}

function rowFlags(lists: Lists, id: string): GridRow["in"] {
  return {
    admins: lists.admins.includes(id),
    creators: lists.creators.includes(id),
    writers: lists.writers.includes(id),
    readers: lists.readers.includes(id),
    noAccess: lists.noAccess.includes(id),
  };
}

/** A new row for someone added: a reader, so they can at least see the database. */
export function newRow(id: string): GridRow {
  return { id, in: { admins: false, creators: false, writers: false, readers: true, noAccess: false } };
}

export function setBox(rows: readonly GridRow[], id: string, list: ListName, value: boolean): GridRow[] {
  return rows.map((row) => (row.id === id && editable(id, list) ? { ...row, in: { ...row.in, [list]: value } } : row));
}

/**
 * The lists for saving. A row with no box ticked is left out, which removes
 * that name from the ACL. Names already in a list keep their place in it
 * (from was), and names new to it follow in row order.
 */
export function gridLists(rows: readonly GridRow[], was?: Lists): Lists {
  const pick = (list: ListName) => {
    const ticked = rows.filter((row) => row.in[list]).map((row) => row.id);
    const kept = (was?.[list] ?? []).filter((id) => ticked.includes(id));
    return [...kept, ...ticked.filter((id) => !kept.includes(id))];
  };
  return { admins: pick("admins"), creators: pick("creators"), writers: pick("writers"), readers: pick("readers"), noAccess: pick("noAccess") };
}

/** What someone in this row really gets, counting "*" in each list. */
export function effective(rows: readonly GridRow[], id: string): { readonly [list in ListName]: boolean } {
  const everyone = rows.find((row) => row.id === EVERYONE)?.in;
  const own = rows.find((row) => row.id === id)?.in;
  const has = (list: ListName) => own?.[list] === true || (id !== EVERYONE && list !== "admins" && list !== "noAccess" && everyone?.[list] === true);
  return { admins: has("admins"), creators: has("creators"), writers: has("writers"), readers: has("readers"), noAccess: own?.noAccess === true };
}

/** The note in a row's last column. */
export function rowNote(rows: readonly GridRow[], id: string, me: string): string | undefined {
  if (id === SERVER_PRINCIPAL) return "Needed for sync; can't be removed or locked out";
  const row = rows.find((other) => other.id === id);
  if (row === undefined) return undefined;
  if (!LISTS.some((list) => row.in[list])) return "Removed when you save";
  if (id === EVERYONE) return "Everyone who logs in to this server";
  const access = effective(rows, id);
  if (access.noAccess) return id === me ? "You can't lock yourself out" : "Locked out. The other boxes are kept but have no effect.";
  if (id === me && !access.admins) return "You can't lock yourself out";
  if (access.writers && !access.readers) return "Writer without reader: can't edit anything";
  if (id === me) return "You can't lock yourself out";
  return undefined;
}

/** Why the grid can't be saved, if it can't: the person logged in would no longer be an admin, and couldn't undo it. */
export function saveProblem(rows: readonly GridRow[], me: string): string | undefined {
  const access = effective(rows, me);
  if (access.noAccess) return "You can't lock yourself out: untick No access on your own row.";
  if (!access.admins) return "You can't remove yourself from the admins: you would lose this page and couldn't undo it. Another admin can.";
  return undefined;
}

/** Whether a row is a problem (a warning to show in colour, besides its text). */
export function rowWarns(rows: readonly GridRow[], id: string, me: string): boolean {
  if (id === SERVER_PRINCIPAL || id === EVERYONE) return false;
  const access = effective(rows, id);
  return access.noAccess || (access.writers && !access.readers) || (id === me && saveProblem(rows, me) !== undefined);
}

/** Two sets of lists the same, each list in any order. */
export function sameLists(a: Lists, b: Lists): boolean {
  return LISTS.every((list) => a[list].length === b[list].length && a[list].every((id) => b[list].includes(id)));
}
