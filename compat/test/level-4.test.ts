// cromdb 0.6.0 (from npm) and the current build. The current build creates
// level-4 databases, which purge: 0.6.0 doesn't make the checks that keep a
// purged document from coming back, so it must refuse them everywhere they
// can reach it: the file, a batch, a hello and a ticket. A level-3 database
// made by 0.6.0 keeps working with both, syncing both ways, and is never
// purged; while it has no other replica, the current build can raise it to
// level 4, after which 0.6.0 refuses it. Only JSON text passes between
// replicas, as between processes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release060 from "cromdb-0.6.0";

interface Replica {
  readonly instanceId: string;
  syncPosition(sourceInstanceId: string): Promise<number>;
  exportChanges(options: { since: number }): Promise<unknown>;
  applyChanges(batch: unknown): Promise<{ applied: number; hasMore: boolean }>;
  find(): Promise<AsyncIterable<{ readonly id: string; readonly version: string; readonly content: Record<string, unknown> }>>;
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

const UPGRADE = /level 4, but this engine supports levels up to 3|this replica must be upgraded/;

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-compat-060-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("0.6.0 and the current build", () => {
  it("is 0.6.0 against a build that supports level 4", () => {
    assert.equal(release060.VERSION, "0.6.0");
    assert.deepEqual(release060.SUPPORTED_LEVELS, { min: 1, max: 3 });
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 4 });
  });

  it("0.6.0 refuses to open a level-4 database file with UPGRADE_REQUIRED, changing nothing", async () => {
    const file = join(dir, "level-4.cromdb");
    const adapter = current.SqliteAdapter.open(file);
    const db = await current.Session.withId("alice").openDatabase(adapter);
    await db.create({ x: 1 });
    const seq = adapter.lastSeq();
    adapter.close();

    const old = release060.SqliteAdapter.open(file);
    await assert.rejects(release060.Session.withId("alice").openDatabase(old), {
      code: "UPGRADE_REQUIRED",
      message: "The database is at level 4, but this engine supports levels up to 3",
    });
    assert.equal(old.lastSeq(), seq);
    old.close();
  });

  it("0.6.0 refuses a level-4 batch, hello and ticket with UPGRADE_REQUIRED, applying nothing", async () => {
    // A level-3 database on 0.6.0 with a second replica, so a batch and a
    // hello can claim to come from a replica 0.6.0 knows.
    const alice060 = release060.Session.withId("alice");
    const a = await alice060.openDatabase(release060.SqliteAdapter.open(":memory:"));
    const peerAdapter = release060.SqliteAdapter.open(":memory:");
    await a.createReplica(peerAdapter);
    const peer = await alice060.openDatabase(peerAdapter);
    await a.create({ x: 1 });
    const before = (await snapshot(a)).size;

    const later = await current.Session.withId("alice").openDatabase(current.SqliteAdapter.open(":memory:"));
    await later.create({ y: 1 });
    const batch = json(await later.exportChanges({})) as unknown as Record<string, unknown>;
    assert.deepEqual([batch["format"], batch["level"]], [3, 4]);
    await assert.rejects(a.applyChanges({ ...batch, databaseId: a.databaseId, sourceInstanceId: peer.instanceId }), {
      code: "UPGRADE_REQUIRED",
      message: /Batch format 3 is not supported|this replica must be upgraded/,
    });
    assert.equal((await snapshot(a)).size, before);

    const hello = { ...(json(await later.syncHello()) as unknown as release060.SyncHello), databaseId: a.databaseId, instanceId: peer.instanceId };
    await assert.rejects(a.checkPeer(hello), { code: "UPGRADE_REQUIRED", message: UPGRADE });

    const ticket = json(await later.registerReplica()) as unknown as release060.ReplicaTicket;
    const target = release060.SqliteAdapter.open(":memory:");
    await assert.rejects(alice060.openDatabase(target, { replicaOf: ticket }), { code: "UPGRADE_REQUIRED", message: UPGRADE });
    assert.equal(target.isEmpty(), true);
  });
});

describe("a level-3 database made by 0.6.0", () => {
  it("syncs both ways between 0.6.0 and the current build, which opens each other's files, keeping level 3 and never purging", async () => {
    const fileA = join(dir, "060-a.cromdb");
    const fileB = join(dir, "060-b.cromdb");
    const alice060 = release060.Session.withId("alice");
    const alice = current.Session.withId("alice");

    const adapterA = release060.SqliteAdapter.open(fileA);
    const a = await alice060.openDatabase(adapterA, { replicaName: "A on 0.6.0" });
    const madeByOld = release060.SqliteAdapter.open(fileB);
    await a.createReplica(madeByOld, { name: "B" });
    madeByOld.close();
    const adapterB = current.SqliteAdapter.open(fileB);
    const b = await alice.openDatabase(adapterB);
    assert.equal(b.level, 3);
    const doc = await a.create({ title: "From A on 0.6.0" });
    await exchange(a, b);
    await b.create({ title: "From B on the current build" });
    const onB = await b.get<{ title: string }>(doc.id);
    assert.ok(onB !== undefined);
    await onB.delete();
    await exchange(a, b);
    assert.deepEqual(await snapshot(b), await snapshot(a));
    assert.equal((await snapshot(a)).size, 1);

    // The current build doesn't purge, keep settings or raise a database below level 4 with replicas.
    await assert.rejects(b.purge(), { code: "NOT_SUPPORTED" });
    await assert.rejects(b.saveSettings({ purgeAfterDays: 5 }), { code: "NOT_SUPPORTED" });
    await assert.rejects(b.raiseLevel(), { code: "NOT_SUPPORTED", message: /other replicas/ });
    for (const key of ["knowledge", "horizons", "checkpoints", "stale"]) {
      assert.equal(adapterB.getLocal(key), undefined);
    }
    assert.equal(b.level, 3);

    // B's file, opened by 0.6.0: it opens, syncs and takes writes.
    adapterB.close();
    const bOldAdapter = release060.SqliteAdapter.open(fileB);
    const bOld = await alice060.openDatabase(bOldAdapter);
    await bOld.create({ title: "B written on 0.6.0" });
    await exchange(a, bOld);
    assert.deepEqual(await snapshot(bOld), await snapshot(a));
    bOldAdapter.close();
    adapterA.close();
  });

  it("is raised to level 4 by the current build while it has no other replica, after which 0.6.0 refuses it", async () => {
    const file = join(dir, "060-solo.cromdb");
    const old = release060.SqliteAdapter.open(file);
    const made = await release060.Session.withId("alice").openDatabase(old);
    await made.create({ title: "kept" });
    old.close();

    const adapter = current.SqliteAdapter.open(file);
    const db = await current.Session.withId("alice").openDatabase(adapter);
    assert.equal(db.level, 3);
    assert.equal(await db.raiseLevel(), 4);
    await db.saveSettings({ purgeAfterDays: 1 });
    assert.equal((await snapshot(db)).size, 1);
    adapter.close();

    const again = release060.SqliteAdapter.open(file);
    await assert.rejects(release060.Session.withId("alice").openDatabase(again), {
      code: "UPGRADE_REQUIRED",
      message: "The database is at level 4, but this engine supports levels up to 3",
    });
    again.close();
  });
});
