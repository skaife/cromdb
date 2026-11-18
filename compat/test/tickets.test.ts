// Replicas made from a ticket by the current build, syncing both ways with
// replicas on earlier releases from npm: 0.2.0 and 0.3.0 at level 1, 0.4.0
// at level 2. To them a replica made from a ticket is like any other. Only
// JSON text passes between replicas, as between two processes.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release020 from "cromdb-0.2.0";
import * as release030 from "cromdb-0.3.0";
import * as release040 from "cromdb-0.4.0";

// What every engine's Database has in common for sync and checks.
interface Replica {
  readonly instanceId: string;
  syncPosition(sourceInstanceId: string): Promise<number>;
  exportChanges(options: { since: number }): Promise<unknown>;
  applyChanges(batch: unknown): Promise<{ applied: number; hasMore: boolean }>;
  find(): Promise<AsyncIterable<{ readonly id: string; readonly version: string; readonly content: Record<string, unknown> }>>;
  create(content: Record<string, unknown>): Promise<unknown>;
  replicas(): Promise<readonly { readonly instanceId: string; readonly name?: string }[]>;
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function pull(target: Replica, source: Replica): Promise<void> {
  for (;;) {
    const since = json(await target.syncPosition(source.instanceId));
    const result = await target.applyChanges(json(await source.exportChanges({ since })));
    if (!result.hasMore) {
      return;
    }
  }
}

async function exchange(a: Replica, b: Replica): Promise<void> {
  await pull(b, a);
  await pull(a, b);
}

async function snapshot(db: Replica): Promise<Map<string, { version: string; content: unknown }>> {
  const result = new Map<string, { version: string; content: unknown }>();
  for await (const doc of await db.find()) {
    result.set(doc.id, { version: doc.version, content: json(doc.content) });
  }
  return result;
}

/** The replicas' names, sorted: replicas made in the same millisecond are listed in random order. */
async function names(db: Replica): Promise<string[]> {
  return (await db.replicas()).map((replica) => replica.name ?? "").sort();
}

/** PRAGMA user_version of a closed SQLite file: bytes 60 to 63 of its header, big-endian. */
function userVersion(file: string): number {
  return readFileSync(file).readUInt32BE(60);
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-compat-tickets-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Level1Release = typeof release030;
const LEVEL_1: [string, Level1Release][] = [
  ["0.2.0", release020 as unknown as Level1Release],
  ["0.3.0", release030],
];

for (const [release, old] of LEVEL_1) {
  describe(`a ticket-made replica of a level-1 database and ${release}`, () => {
    it("syncs both ways, and its file opens in the old release", async () => {
      const fileA = join(dir, `${release}-a.cromdb`);
      const fileB = join(dir, `${release}-b.cromdb`);
      const fileC = join(dir, `${release}-c.cromdb`);

      // A on the old release; B, a replica of it, on the current build.
      const adapterA = old.SqliteAdapter.open(fileA);
      const a = await old.Session.named("alice").openDatabase(adapterA, { replicaName: `A on ${release}` });
      const acl = await a.getAcl();
      acl.creators = ["*"];
      await acl.save();
      const madeByOld = old.SqliteAdapter.open(fileB);
      await a.createReplica(madeByOld, { name: "B" });
      madeByOld.close();
      const adapterB = current.SqliteAdapter.open(fileB);
      const b = await current.Session.named("alice").openDatabase(adapterB);
      await a.create({ title: `From A on ${release}` });
      await exchange(a, b);

      // C, made on the current build from B's ticket, sent as JSON text.
      const ticket = json(await b.registerReplica({ name: "C from a ticket" }));
      assert.equal(ticket.level, 1);
      const adapterC = current.SqliteAdapter.open(fileC);
      const c = await current.Session.named("alice").openDatabase(adapterC, { replicaOf: ticket });
      assert.equal(c.level, 1);
      await pull(c, b);
      await c.create({ title: "From C" });
      await exchange(b, c);
      await exchange(a, b); // A learns of C through B
      await exchange(a, c);
      await a.create({ title: `Again from A on ${release}` });
      await exchange(a, c);
      await exchange(b, c);
      assert.equal((await snapshot(a)).size, 3);
      assert.deepEqual(await snapshot(c), await snapshot(a));
      assert.deepEqual(await snapshot(b), await snapshot(a));
      assert.deepEqual(await names(a), [`A on ${release}`, "B", "C from a ticket"]);

      // C's file is still format 1: the old release opens it, syncs and writes.
      adapterC.close();
      assert.equal(userVersion(fileC), 1);
      const cOldAdapter = old.SqliteAdapter.open(fileC);
      const cOld = await old.Session.named("alice").openDatabase(cOldAdapter);
      await cOld.create({ title: `C written on ${release}` });
      await exchange(a, cOld);
      assert.deepEqual(await snapshot(cOld), await snapshot(a));

      cOldAdapter.close();
      adapterB.close();
      adapterA.close();
    });
  });
}

describe("a ticket-made replica of a level-2 database and 0.4.0", () => {
  it("syncs both ways with 0.4.0 replicas, which also open its file and copy it", async () => {
    const fileA = join(dir, "040-a.cromdb");
    const fileB = join(dir, "040-b.cromdb");
    const fileC = join(dir, "040-c.cromdb");
    const fileD = join(dir, "040-d.cromdb");
    const alice040 = release040.Session.withId("alice");
    const alice = current.Session.withId("alice");

    // A on 0.4.0; B, a replica of it, on the current build.
    const adapterA = release040.SqliteAdapter.open(fileA);
    const a = await alice040.openDatabase(adapterA, { replicaName: "A on 0.4.0" });
    const acl = await a.getAcl();
    acl.creators = ["*"];
    await acl.save();
    const madeByOld = release040.SqliteAdapter.open(fileB);
    await a.createReplica(madeByOld, { name: "B" });
    madeByOld.close();
    const adapterB = current.SqliteAdapter.open(fileB);
    const b = await alice.openDatabase(adapterB);
    await a.create({ title: "From A on 0.4.0" });
    await exchange(a, b);

    // C from B's ticket on the current build.
    const adapterC = current.SqliteAdapter.open(fileC);
    const c = await alice.openDatabase(adapterC, { replicaOf: json(await b.registerReplica({ name: "C from a ticket" })) });
    await pull(c, b);
    await c.create({ title: "From C" });
    await exchange(b, c);
    await exchange(a, b);
    await exchange(a, c);
    await a.create({ title: "Again from A on 0.4.0" });
    await exchange(a, c);
    await exchange(b, c);
    assert.equal((await snapshot(a)).size, 3);
    assert.deepEqual(await snapshot(c), await snapshot(a));
    assert.deepEqual(await snapshot(b), await snapshot(a));
    assert.deepEqual(await names(a), ["A on 0.4.0", "B", "C from a ticket"]);
    const own = (await a.replicas()).find((replica) => replica.instanceId === c.instanceId);
    assert.equal(own?.maxLevel, current.SUPPORTED_LEVELS.max);

    // C copies itself into D with createReplica; 0.4.0 opens D and syncs.
    const target = current.SqliteAdapter.open(fileD);
    await c.createReplica(target, { name: "D on 0.4.0" });
    target.close();
    const adapterD = release040.SqliteAdapter.open(fileD);
    const d = await alice040.openDatabase(adapterD);
    await d.create({ title: "From D on 0.4.0" });
    await exchange(c, d);
    await exchange(a, c);
    await exchange(a, d);
    assert.deepEqual(await snapshot(d), await snapshot(a));

    // C's file, rolled back to 0.4.0: it opens, syncs and takes writes.
    adapterC.close();
    assert.equal(userVersion(fileC), 2);
    const cOldAdapter = release040.SqliteAdapter.open(fileC);
    const cOld = await alice040.openDatabase(cOldAdapter);
    await cOld.create({ title: "C written on 0.4.0" });
    await exchange(a, cOld);
    await exchange(b, cOld);
    assert.deepEqual(await snapshot(cOld), await snapshot(a));
    assert.deepEqual(await snapshot(b), await snapshot(a));

    cOldAdapter.close();
    adapterD.close();
    adapterB.close();
    adapterA.close();
  });

  it("0.4.0 has no tickets: its Database has no registerReplica", async () => {
    const db = await release040.Session.withId("alice").openDatabase(release040.SqliteAdapter.open(":memory:"));
    assert.equal("registerReplica" in db, false);
  });
});
