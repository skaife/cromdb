// Who does what in the demo. There is no real login: each replica has one
// person, who writes notes, and one service principal, which syncs.

import { join } from "node:path";

export const DEMO_ADMIN = "Demo Admin";

export const REPLICA_NAMES = ["A", "B", "C"] as const;
export type ReplicaName = (typeof REPLICA_NAMES)[number];

const PEOPLE: Record<ReplicaName, string> = {
  A: "Alice Anderson",
  B: "Bob Baker",
  C: "Carol Carter",
};

export const DEFAULT_PORTS: Record<ReplicaName, number> = { A: 4001, B: 4002, C: 4003 };

export function isReplicaName(value: string): value is ReplicaName {
  return (REPLICA_NAMES as readonly string[]).includes(value);
}

/** The person who writes notes on this replica. */
export function personFor(name: ReplicaName): string {
  return PEOPLE[name];
}

/** The principal this replica syncs as. An admin, so it never writes notes. */
export function serviceFor(name: ReplicaName): string {
  return `Replica ${name} service`;
}

/** Where the database files live unless --dir or --data says otherwise. */
export const DEFAULT_DATA_DIR = join(import.meta.dirname, "..", "data");

export function dataFileName(name: ReplicaName): string {
  return `${name.toLowerCase()}.db`;
}
