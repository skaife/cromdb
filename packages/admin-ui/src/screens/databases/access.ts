// What a person's access to a database is called on the Databases list.

import type { Schemas } from "../../api/schema.ts";

export interface AccessBadges {
  /** In order: admin, read, write, create. */
  readonly badges: readonly ("admin" | "read" | "write" | "create")[];
  /** A note for access that reads oddly from the badges alone. */
  readonly note: string | undefined;
}

export function accessBadges(access: Schemas["Access"]): AccessBadges {
  const badges = (["admin", "read", "write", "create"] as const).filter((name) => access[name]);
  let note: string | undefined;
  if (access.create && !access.read) {
    note = "depositor: can add, can't read back";
  } else if (access.admin && !access.read && !access.write && !access.create) {
    note = "manage only: no document access";
  } else if (badges.length === 0) {
    note = "no access to documents";
  }
  return { badges, note };
}
