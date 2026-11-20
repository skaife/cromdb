// Makes packages/engine/test/fixtures/0.5.0/seeds/ with the real cromdb 0.5.0
// from npm: empty level-2 databases, each with "alice" as its only admin and
// creator, which the engine's tests copy to test databases at level 2 (the
// current engine creates databases at level 3).
//
// Run with "node scripts/make-seeds.ts" in compat/, and optionally an output
// directory. The IDs are random, so each run makes different (equally valid)
// seeds.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import * as release050 from "cromdb-0.5.0";

const SEEDS = ["alice", "other"];

export async function makeSeeds(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const name of SEEDS) {
    const file = join(dir, `${name}.cromdb`);
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(file + suffix, { force: true });
    }
    const adapter = release050.SqliteAdapter.open(file);
    const db = await release050.Session.withId("alice").openDatabase(adapter, { now: () => new Date("2026-11-20T09:00:00.000Z") });
    if (db.level !== 2) {
      throw new Error(`cromdb 0.5.0 made a database at level ${db.level}, not 2`);
    }
    adapter.close();
    if (existsSync(`${file}-wal`)) {
      throw new Error(`${file} was left with a WAL file`);
    }
  }
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../../packages/engine/test/fixtures/0.5.0/seeds"));
  await makeSeeds(dir);
  console.log(`Wrote the 0.5.0 seeds to ${dir}`);
}
