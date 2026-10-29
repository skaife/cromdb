// (Re)creates the three replica database files, with no notes in them.
//
// Usage: node scripts/reset.ts [--dir <directory>]   (default: demo/data)
//
// CromDB can only create a replica in-process, from a database already open
// here (Database.createReplica), so this step is the "clone": it makes a.db,
// then copies it into b.db and c.db. After that the three files are
// independent, and only HTTP connects them. Creating a replica over the
// network is server work for later.

import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Session, SqliteAdapter } from "cromdb";
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
    const db = await Session.named(DEMO_ADMIN).openDatabase(a);
    const acl = await db.getAcl();
    acl.admins = [DEMO_ADMIN, ...REPLICA_NAMES.map(serviceFor)];
    acl.creators = REPLICA_NAMES.map(personFor);
    await acl.save();
    for (const target of others) {
      await db.createReplica(target);
    }
    // b.db was copied before c.db was registered. Bring it up to date, so
    // every replica knows the other two before any of them syncs.
    for (const target of others) {
      await (await Session.named(DEMO_ADMIN).openDatabase(target)).pullFrom(db);
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
