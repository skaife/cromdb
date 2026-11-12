// Makes the 0.2.0 fixture in test/fixtures/0.2.0/: two replicas of one
// database, written by the real cromdb 0.2.0 from npm, with named replicas, a
// parent and child, a datetime field, a document only bob can read, a delete,
// and a conflict. expected.json records what 0.2.0 shows for each, versions
// included, so a later engine's test can check it reads the same.
//
// Run with "npm run fixture" in compat/, or pass another output directory.
// The IDs are random, so each run makes a different (equally valid) fixture.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Session, SqliteAdapter, VERSION, type Database } from "cromdb-0.2.0";

const DEFAULT_DIR = resolve(import.meta.dirname, "../../test/fixtures/0.2.0");

/** Moves every change from source to target, as JSON text, until there are none. */
async function pull(target: Database, source: Database): Promise<void> {
  for (;;) {
    const batch: unknown = JSON.parse(JSON.stringify(await source.exportChanges({ since: await target.syncPosition(source.instanceId) })));
    if (!(await target.applyChanges(batch)).hasMore) {
      return;
    }
  }
}

async function exchange(a: Database, b: Database): Promise<void> {
  await pull(b, a);
  await pull(a, b);
}

export async function makeFixture(dir: string): Promise<void> {
  if (VERSION !== "0.2.0") {
    throw new Error(`Expected cromdb 0.2.0, got ${VERSION}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of ["lisbon.cromdb", "osaka.cromdb", "expected.json"]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(dir, name + suffix), { force: true });
    }
  }

  let time = Date.parse("2026-11-01T09:00:00.000Z");
  const now = (): Date => new Date((time += 1000));

  const lisbonAdapter = SqliteAdapter.open(join(dir, "lisbon.cromdb"));
  const osakaAdapter = SqliteAdapter.open(join(dir, "osaka.cromdb"));
  const alice = Session.named("Alice");
  const lisbon = await alice.openDatabase(lisbonAdapter, { now, replicaName: "Lisbon" });
  const acl = await lisbon.getAcl();
  acl.creators = ["*"];
  await acl.save();
  await lisbon.createReplica(osakaAdapter, { name: "Osaka" });
  const osaka = await alice.openDatabase(osakaAdapter, { now });
  const bobOnLisbon = await Session.named("bob").openDatabase(lisbonAdapter, { now });

  const groceries = await lisbon.create({ title: "Groceries", items: ["milk", "eggs"], due: new Date("2026-11-20T18:00:00.000Z") });
  const child = await lisbon.create({ title: "Shop list", done: false }, { parentId: groceries.id });
  const secret = await bobOnLisbon.create({ title: "Bob's note" }, { readers: ["bob"], writers: ["bob"] });
  const gone = await lisbon.create({ title: "Old idea" });
  const shared = await lisbon.create({ title: "Plan", status: "draft" });
  await exchange(lisbon, osaka);

  await gone.delete();
  const onLisbon = await lisbon.get<{ title: string; status: string }>(shared.id);
  const onOsaka = await osaka.get<{ title: string; status: string }>(shared.id);
  if (onLisbon === undefined || onOsaka === undefined) {
    throw new Error("shared document missing");
  }
  onLisbon.content.status = "approved";
  await onLisbon.save();
  onOsaka.content.status = "rejected";
  await onOsaka.save();
  await exchange(lisbon, osaka);

  const conflict = await (await lisbon.get(shared.id))?.conflict();
  const conflictOnOsaka = await (await osaka.get(shared.id))?.conflict();
  if (conflict === undefined || conflictOnOsaka === undefined || conflict.version !== conflictOnOsaka.version) {
    throw new Error("expected the same conflict on both replicas");
  }

  const documents = [];
  for (const doc of [groceries, child, shared]) {
    const loaded = await lisbon.get(doc.id);
    if (loaded === undefined) {
      throw new Error("document missing");
    }
    documents.push({ id: loaded.id, parentId: loaded.parentId, version: loaded.version, content: loaded.content });
  }
  const expected = {
    madeBy: `cromdb ${VERSION}`,
    databaseId: lisbon.databaseId,
    replicas: (await lisbon.replicas()).map(({ instanceId, name }) => ({ instanceId, name })),
    files: { lisbon: lisbon.instanceId, osaka: osaka.instanceId },
    documents,
    bobOnly: { id: secret.id, version: secret.version },
    deleted: gone.id,
    conflict: {
      id: shared.id,
      version: conflict.version,
      versions: conflict.versions.map((version) => ({
        isPrimary: version.isPrimary,
        version: version.document.version,
        status: version.document.content["status"],
      })),
    },
  };

  lisbonAdapter.close();
  osakaAdapter.close();
  for (const name of ["lisbon.cromdb", "osaka.cromdb"]) {
    if (existsSync(join(dir, `${name}-wal`))) {
      throw new Error(`${name} was left with a WAL file`);
    }
  }
  // Dates are written as ISO strings.
  writeFileSync(join(dir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
}

if (import.meta.main) {
  const dir = process.argv[2] === undefined ? DEFAULT_DIR : resolve(process.argv[2]);
  await makeFixture(dir);
  console.log(`Wrote the 0.2.0 fixture to ${dir}`);
}
