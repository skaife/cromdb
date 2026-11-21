// Makes packages/engine/test/fixtures/<release>/seeds/ with a real earlier
// cromdb from npm: empty databases, each with "alice" as its only admin and
// creator, which the engine's tests copy to get test databases at an earlier
// level (the current engine creates databases at level 4):
//
//   0.5.0  level 2
//   0.6.0  level 3
//   0.7.0  level 4
//
// Run with "node scripts/make-seeds.ts <release>" in compat/, and optionally
// an output directory. The IDs are random, so each run makes different
// (equally valid) seeds.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import * as release050 from "cromdb-0.5.0";
import * as release060 from "cromdb-0.6.0";
import * as release070 from "cromdb-0.7.0";

const SEEDS = ["alice", "other"];

const RELEASES = {
  "0.5.0": { cromdb: release050, level: 2 },
  "0.6.0": { cromdb: release060, level: 3 },
  "0.7.0": { cromdb: release070, level: 4 },
} as const;

type Release = keyof typeof RELEASES;

export async function makeSeeds(release: Release, dir: string): Promise<void> {
  const { cromdb, level } = RELEASES[release];
  mkdirSync(dir, { recursive: true });
  for (const name of SEEDS) {
    const file = join(dir, `${name}.cromdb`);
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(file + suffix, { force: true });
    }
    const adapter = cromdb.SqliteAdapter.open(file);
    const db = await cromdb.Session.withId("alice").openDatabase(adapter, { now: () => new Date("2026-11-20T09:00:00.000Z") });
    if (db.level !== level) {
      throw new Error(`cromdb ${release} made a database at level ${db.level}, not ${level}`);
    }
    adapter.close();
    if (existsSync(`${file}-wal`)) {
      throw new Error(`${file} was left with a WAL file`);
    }
  }
}

if (import.meta.main) {
  const release = process.argv[2];
  if (release === undefined || !Object.hasOwn(RELEASES, release)) {
    console.error(`Usage: node scripts/make-seeds.ts <${Object.keys(RELEASES).join(" | ")}> [dir]`);
    process.exit(2);
  }
  const dir = resolve(process.argv[3] ?? resolve(import.meta.dirname, `../../packages/engine/test/fixtures/${release}/seeds`));
  await makeSeeds(release as Release, dir);
  console.log(`Wrote the ${release} seeds to ${dir}`);
}
