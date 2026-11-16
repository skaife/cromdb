// Who does what in the demo. There is no real login: each replica has one
// person, who writes notes, and one service principal, which syncs. CromDB
// stores user IDs; people's names come from this table, as an app's would
// come from its own user records.

import { join } from "node:path";

export const DEMO_ADMIN = "demo-admin";

export const REPLICA_NAMES = ["A", "B", "C"] as const;
export type ReplicaName = (typeof REPLICA_NAMES)[number];

const PEOPLE: Record<ReplicaName, { readonly id: string; readonly name: string }> = {
  A: { id: "alice", name: "Alice Anderson" },
  B: { id: "bob", name: "Bob Baker" },
  C: { id: "carol", name: "Carol Carter" },
};

export const DEFAULT_PORTS: Record<ReplicaName, number> = { A: 4001, B: 4002, C: 4003 };

/** Where the page is served. */
export const DEFAULT_PAGE_PORT = 4000;

export function isReplicaName(value: string): value is ReplicaName {
  return (REPLICA_NAMES as readonly string[]).includes(value);
}

/** The ID of the person who writes notes on this replica. */
export function personFor(name: ReplicaName): string {
  return PEOPLE[name].id;
}

/** The ID this replica syncs as. An admin, so it never writes notes. */
export function serviceFor(name: ReplicaName): string {
  return `replica-${name.toLowerCase()}-service`;
}

/** The name to show for a user ID: a person's name from the table above, or the ID itself. */
export function displayName(id: string): string {
  return Object.values(PEOPLE).find((person) => person.id === id)?.name ?? id;
}

/** Where the database files live unless --dir or --data says otherwise. */
export const DEFAULT_DATA_DIR = join(import.meta.dirname, "..", "data");

export function dataFileName(name: ReplicaName): string {
  return `${name.toLowerCase()}.db`;
}
