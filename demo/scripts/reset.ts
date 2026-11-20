// (Re)creates the three replica database files, with no notes in them.
//
// Usage: node scripts/reset.ts [--dir <directory>]   (default: demo/data)
//
// The demo makes its replicas in one process, from a database already open
// here (Database.createReplica), so this step is the "clone": it makes a.db,
// then copies it into b.db and c.db. After that the three files are
// independent, and only HTTP connects them. (A replica on another machine
// would be made from a ticket, with Database.registerReplica; the demo
// doesn't need one.)

import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Session, SqliteAdapter, type Database } from "cromdb";
import {
  DEFAULT_DATA_DIR,
  DEMO_ADMIN,
  REPLICA_NAMES,
  dataFileName,
  personFor,
  serviceFor,
} from "../server/identities.ts";

async function reset(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // A database file comes with its write-ahead log files.
  for (const name of REPLICA_NAMES) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, dataFileName(name) + suffix), { force: true });
    }
  }

  const adapters = REPLICA_NAMES.map((name) => SqliteAdapter.open(join(dir, dataFileName(name))));
  try {
    const [a, ...others] = adapters;
    if (a === undefined) {
      throw new Error("no replicas");
    }
    const [first, ...otherNames] = REPLICA_NAMES;
    const db = await Session.withId(DEMO_ADMIN).openDatabase(a, { replicaName: first });
    // A new database admits only its creator. The three people create, read
    // and edit notes; each replica's service syncs, which needs an admin.
    const acl = await db.getAcl();
    acl.admins = [DEMO_ADMIN, ...REPLICA_NAMES.map(serviceFor)];
    acl.creators = REPLICA_NAMES.map(personFor);
    acl.readers = REPLICA_NAMES.map(personFor);
    acl.writers = REPLICA_NAMES.map(personFor);
    await acl.save();
    for (const [index, target] of others.entries()) {
      await db.createReplica(target, { name: otherNames[index] as string });
    }
    // b.db was copied before c.db was registered, and each new replica
    // records its maxLevel in its own registration when first opened. Sync
    // through a.db, so all three files start the same and every replica
    // knows the other two before any of them syncs.
    const copies: Database[] = [];
    for (const target of others) {
      const copy = await Session.withId(DEMO_ADMIN).openDatabase(target);
      await copy.pullFrom(db);
      await db.pullFrom(copy);
      copies.push(copy);
    }
    for (const copy of copies) {
      await copy.pullFrom(db);
    }
  } finally {
    for (const adapter of adapters) {
      adapter.close();
    }
  }
}

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const dir = values.dir ?? DEFAULT_DATA_DIR;
await reset(dir);
console.log(`Created ${REPLICA_NAMES.map(dataFileName).join(", ")} in ${dir}`);
