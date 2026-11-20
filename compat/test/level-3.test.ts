// cromdb 0.5.0 (from npm) and the current build. The current build creates
// level-4 databases, with level 3's ACL, which 0.5.0 can't enforce, so 0.5.0
// must refuse them everywhere they can reach it: the file, a batch, a hello
// and a ticket. A level-2 database made by 0.5.0 keeps working with both, syncing
// both ways. Only JSON text passes between replicas, as between processes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release050 from "cromdb-0.5.0";

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

const UPGRADE = /level 4, but this engine supports levels up to 2|this replica must be upgraded/;

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-compat-050-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("0.5.0 and the current build", () => {
  it("is 0.5.0 against a build that supports levels 3 and 4", () => {
    assert.equal(release050.VERSION, "0.5.0");
    assert.deepEqual(release050.SUPPORTED_LEVELS, { min: 1, max: 2 });
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 4 });
  });

  it("0.5.0 refuses to open a database file the current build made with UPGRADE_REQUIRED, changing nothing", async () => {
    const file = join(dir, "level-4.cromdb");
    const adapter = current.SqliteAdapter.open(file);
    const db = await current.Session.withId("alice").openDatabase(adapter);
    await db.create({ x: 1 });
    const seq = adapter.lastSeq();
    adapter.close();

    const old = release050.SqliteAdapter.open(file);
    await assert.rejects(release050.Session.withId("alice").openDatabase(old), {
      code: "UPGRADE_REQUIRED",
      message: "The database is at level 4, but this engine supports levels up to 2",
    });
    await assert.rejects(release050.Session.anonymous().openDatabase(old), { code: "UPGRADE_REQUIRED" });
    assert.equal(old.lastSeq(), seq);
    old.close();
  });

  it("0.5.0 refuses the current build's batch, hello and ticket with UPGRADE_REQUIRED, applying nothing", async () => {
    // A level-2 database on 0.5.0 with a second replica, so a batch and a
    // hello can claim to come from a replica 0.5.0 knows.
    const alice050 = release050.Session.withId("alice");
    const a = await alice050.openDatabase(release050.SqliteAdapter.open(":memory:"));
    const peerAdapter = release050.SqliteAdapter.open(":memory:");
    await a.createReplica(peerAdapter);
    const peer = await alice050.openDatabase(peerAdapter);
    await a.create({ x: 1 });
    const before = (await snapshot(a)).size;

    const later = await current.Session.withId("alice").openDatabase(current.SqliteAdapter.open(":memory:"));
    await later.create({ y: 1 });
    const batch = json(await later.exportChanges({})) as unknown as Record<string, unknown>;
    assert.equal(batch["level"], 4);
    await assert.rejects(a.applyChanges({ ...batch, databaseId: a.databaseId, sourceInstanceId: peer.instanceId }), {
      code: "UPGRADE_REQUIRED",
      message: UPGRADE,
    });
    assert.equal((await snapshot(a)).size, before);

    const hello = { ...(json(await later.syncHello()) as unknown as release050.SyncHello), databaseId: a.databaseId, instanceId: peer.instanceId };
    await assert.rejects(a.checkPeer(hello), { code: "UPGRADE_REQUIRED", message: UPGRADE });

    const ticket = json(await later.registerReplica()) as unknown as release050.ReplicaTicket;
    const target = release050.SqliteAdapter.open(":memory:");
    await assert.rejects(alice050.openDatabase(target, { replicaOf: ticket }), { code: "UPGRADE_REQUIRED", message: UPGRADE });
    assert.equal(target.isEmpty(), true);
  });
});

describe("a level-2 database made by 0.5.0", () => {
  it("syncs both ways between 0.5.0 and the current build, which opens each other's files, keeping level 2", async () => {
    const fileA = join(dir, "050-a.cromdb");
    const fileB = join(dir, "050-b.cromdb");
    const alice050 = release050.Session.withId("alice");
    const alice = current.Session.withId("alice");

    // A on 0.5.0, with bob as a creator; B, a replica of it, on the current build.
    const adapterA = release050.SqliteAdapter.open(fileA);
    const a = await alice050.openDatabase(adapterA, { replicaName: "A on 0.5.0" });
    const acl = await a.getAcl();
    acl.creators = ["alice", "bob"];
    await acl.save();
    const madeByOld = release050.SqliteAdapter.open(fileB);
    await a.createReplica(madeByOld, { name: "B" });
    madeByOld.close();
    const adapterB = current.SqliteAdapter.open(fileB);
    const b = await alice.openDatabase(adapterB);
    assert.equal(b.level, 2);
    await a.create({ title: "From A on 0.5.0" }, { readers: ["alice"] });
    await exchange(a, b);

    // On the current build: anyone may open it, as on 0.5.0, and the
    // documents' own lists decide.
    const bobOnB = await current.Session.withId("bob").openDatabase(adapterB);
    assert.deepEqual(await bobOnB.myAccess(), { visible: true, read: true, write: true, create: true, admin: false });
    await bobOnB.create({ title: "From bob on B" });
    assert.equal((await snapshot(bobOnB)).size, 1);
    const onB = await b.getAcl();
    assert.deepEqual([onB.readers, onB.writers, onB.noAccess], [["anonymous"], ["anonymous"], []]);
    onB.noAccess = ["bob"];
    await assert.rejects(onB.save(), { code: "NOT_SUPPORTED" });
    onB.noAccess = [];
    onB.creators = ["*"];
    await onB.save();
    await exchange(a, b);
    assert.deepEqual((await a.getAcl()).creators, ["*"]);
    assert.deepEqual(await snapshot(b), await snapshot(a));
    assert.equal((await snapshot(a)).size, 2);

    // B's file, opened by 0.5.0: it opens, syncs and takes writes.
    adapterB.close();
    const bOldAdapter = release050.SqliteAdapter.open(fileB);
    const bOld = await alice050.openDatabase(bOldAdapter);
    await bOld.create({ title: "B written on 0.5.0" });
    await exchange(a, bOld);
    assert.deepEqual(await snapshot(bOld), await snapshot(a));
    bOldAdapter.close();

    // And A's file, opened by the current build, stays at level 2.
    adapterA.close();
    const aNewAdapter = current.SqliteAdapter.open(fileA);
    const aNew = await alice.openDatabase(aNewAdapter);
    assert.equal(aNew.level, 2);
    assert.equal((await snapshot(aNew)).size, 3);
    aNewAdapter.close();
  });
});
