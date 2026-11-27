// cromdb 0.8.0 (from npm) and the current build, which adds each replica's
// status and introducer to replicas() and looks up one suspect by its key,
// storing and sending nothing new. They sync both ways; each honors the
// other's retirements, opens and adopts the other's backups, opens a file
// holding the other's suspects, and catches the other restored from an old
// file. Only JSON text passes between replicas, as between processes.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release080 from "cromdb-0.8.0";

interface Replica {
  readonly instanceId: string;
  syncPosition(sourceInstanceId: string): Promise<number>;
  syncHello(): Promise<unknown>;
  checkPeer(hello: never): Promise<unknown>;
  exportChanges(options: { since: number }): Promise<unknown>;
  applyChanges(batch: unknown): Promise<{ applied: number; hasMore: boolean }>;
  find(): Promise<AsyncIterable<{ readonly id: string; readonly version: string; readonly content: Record<string, unknown> }>>;
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** target pulls everything from source: hello, then batches. */
async function pull(target: Replica, source: Replica): Promise<void> {
  await target.checkPeer(json(await source.syncHello()) as never);
  for (;;) {
    const since = json(await target.syncPosition(source.instanceId));
    const result = await target.applyChanges(json(await source.exportChanges({ since })));
    if (!result.hasMore) {
      return;
    }
  }
}

async function snapshot(db: Replica): Promise<Map<string, { version: string; content: unknown }>> {
  const result = new Map<string, { version: string; content: unknown }>();
  for await (const doc of await db.find()) {
    result.set(doc.id, { version: doc.version, content: json(doc.content) });
  }
  return result;
}

type Ticket080 = release080.ReplicaTicket;
type TicketCurrent = current.ReplicaTicket;

const alice = current.Session.withId("alice");
const alice080 = release080.Session.withId("alice");

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-compat-080-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** a on the current build, b on 0.8.0 made from a's ticket, synced both ways. */
async function mixed() {
  const a = await alice.openDatabase(current.SqliteAdapter.open(":memory:"));
  const b = await alice080.openDatabase(release080.SqliteAdapter.open(":memory:"), {
    replicaOf: json(await a.registerReplica({ name: "b on 0.8.0" })) as unknown as Ticket080,
  });
  await pull(b, a);
  await pull(a, b);
  return { a, b };
}

/** The status and introducer of each replica, as the current build lists them. */
async function listing(db: current.Database): Promise<Record<string, [string, string | undefined]>> {
  return Object.fromEntries((await db.replicas()).map((replica) => [replica.instanceId, [replica.status, replica.introducedBy]]));
}

describe("0.8.0 and the current build", () => {
  it("are 0.8.0 and a later build, both at level 4", () => {
    assert.equal(release080.VERSION, "0.8.0");
    assert.notEqual(current.VERSION, "0.8.0");
    assert.deepEqual(release080.SUPPORTED_LEVELS, { min: 1, max: 4 });
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 4 });
  });

  it("sync both ways, each side's hello and batches accepted by the other", async () => {
    const { a, b } = await mixed();
    const fromA = await a.create({ title: "from the current build" });
    const fromB = await b.create({ title: "from 0.8.0" });
    await pull(b, a);
    await pull(a, b);
    assert.deepEqual(await snapshot(b), await snapshot(a));
    assert.ok((await snapshot(a)).has(fromB.id) && (await snapshot(b)).has(fromA.id));
  });

  it("the current build lists who introduced a replica made from 0.8.0's ticket", async () => {
    const { a, b } = await mixed();
    const c = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), {
      replicaOf: json(await b.registerReplica()) as unknown as TicketCurrent,
    });
    await pull(c, b);
    await pull(a, b);
    assert.deepEqual(await listing(a), {
      [a.instanceId]: ["active", undefined],
      [b.instanceId]: ["active", a.instanceId],
      [c.instanceId]: ["active", b.instanceId],
    });
  });

  it("the current build shows a retirement 0.8.0 made, and refuses the retired replica", async () => {
    const { a, b } = await mixed();
    const c = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), { replicaOf: json(await a.registerReplica()) });
    await pull(c, a);
    await pull(b, a);
    await b.retireReplica(c.instanceId);
    await pull(a, b);
    assert.deepEqual((await listing(a))[c.instanceId], ["retired", a.instanceId]);
    await assert.rejects(pull(a, c), { code: "SYNC_MISMATCH", message: /not active/ });
    await pull(c, a);
    assert.equal((await c.syncState()).retired, true);
  });

  it("0.8.0 honors a retirement the current build made, refusing the retired replica", async () => {
    const { a, b } = await mixed();
    const c = await alice080.openDatabase(release080.SqliteAdapter.open(":memory:"), {
      replicaOf: json(await b.registerReplica()) as unknown as Ticket080,
    });
    await pull(c, b);
    await pull(a, b);
    await a.retireReplica(c.instanceId);
    await pull(b, a);
    await assert.rejects(pull(b, c), { code: "SYNC_MISMATCH", message: /not active/ });
    await pull(c, b);
    assert.equal((await c.syncState()).retired, true);
  });

  it("each opens and adopts a backup the other made", async () => {
    for (const [make, adopt] of [
      ["current", "0.8.0"],
      ["0.8.0", "current"],
    ] as const) {
      const sourcePath = join(dir, `source-${make}.cromdb`);
      const path = join(dir, `backup-${make}.cromdb`);
      let doc: { id: string };
      let backedUp: string;
      if (make === "current") {
        const source = current.SqliteAdapter.open(sourcePath);
        const db = await alice.openDatabase(source);
        doc = await db.create({ made: make });
        backedUp = db.instanceId;
        const target = current.SqliteAdapter.open(path);
        await db.backup(target);
        target.close();
        source.close();
      } else {
        const source = release080.SqliteAdapter.open(sourcePath);
        const db = await alice080.openDatabase(source);
        doc = await db.create({ made: make });
        backedUp = db.instanceId;
        const target = release080.SqliteAdapter.open(path);
        await db.backup(target);
        target.close();
        source.close();
      }
      if (adopt === "current") {
        const adapter = current.SqliteAdapter.open(path);
        await assert.rejects((await alice.openDatabase(adapter)).create({ y: 1 }), { code: "READ_ONLY" });
        const adopted = await alice.openDatabase(adapter, { adopt: true });
        assert.notEqual(adopted.instanceId, backedUp);
        assert.equal((await adopted.get(doc.id))?.id, doc.id);
        assert.deepEqual((await listing(adopted))[backedUp], ["retired", undefined]);
        assert.deepEqual((await listing(adopted))[adopted.instanceId], ["active", backedUp]);
        adapter.close();
      } else {
        const adapter = release080.SqliteAdapter.open(path);
        await assert.rejects((await alice080.openDatabase(adapter)).create({ y: 1 }), { code: "READ_ONLY" });
        const adopted = await alice080.openDatabase(adapter, { adopt: true });
        assert.notEqual(adopted.instanceId, backedUp);
        assert.equal((await adopted.get(doc.id))?.id, doc.id);
        adapter.close();
        // The current build lists the adoption 0.8.0 made.
        const reopened = current.SqliteAdapter.open(path);
        const db = await alice.openDatabase(reopened);
        assert.deepEqual((await listing(db))[backedUp], ["retired", undefined]);
        assert.deepEqual((await listing(db))[db.instanceId], ["active", backedUp]);
        reopened.close();
      }
    }
  });

  it("the current build looks up, by key, suspects 0.8.0 recovered, and 0.8.0 opens a file with the current build's suspects", async () => {
    const { a, b } = await mixed();
    // 0.8.0 recovers into a file; the current build reads its suspects.
    const oldA = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), { replicaOf: json(await a.registerReplica()) });
    await pull(oldA, a);
    const onlyOld = await oldA.create({ only: "old" });
    const oldPath = join(dir, "old-for-080.cromdb");
    const oldFile = current.SqliteAdapter.open(oldPath);
    await oldA.backup(oldFile);
    oldFile.close();
    const path080 = join(dir, "suspects-080.cromdb");
    const n080File = release080.SqliteAdapter.open(path080);
    const n080 = await alice080.openDatabase(n080File, { replicaOf: json(await b.registerReplica()) as unknown as Ticket080 });
    await pull(n080, b);
    const oldFor080 = release080.SqliteAdapter.open(oldPath);
    assert.equal((await n080.recover(oldFor080)).suspects, 1);
    const [found080] = await n080.suspects();
    oldFor080.close();
    n080File.close();
    const reopened = await alice.openDatabase(current.SqliteAdapter.open(path080));
    const byKey = await reopened.suspect(found080?.key ?? "");
    assert.equal(byKey?.documentId, onlyOld.id);
    assert.equal(byKey?.reason, "absent");
    await byKey?.accept();
    assert.equal(await reopened.suspect(found080?.key ?? ""), undefined);
    // a learns of the replica b introduced, then takes the accepted write.
    await pull(a, b);
    await pull(a, reopened);
    assert.equal((await a.get<{ only: string }>(onlyOld.id))?.content.only, "old");

    // The current build recovers into a file; 0.8.0 opens it and syncs.
    const path = join(dir, "suspects-current.cromdb");
    const nFile = current.SqliteAdapter.open(path);
    const n = await alice.openDatabase(nFile, { replicaOf: json(await a.registerReplica()) });
    const oldB = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), { replicaOf: json(await a.registerReplica()) });
    await pull(oldB, a);
    await pull(n, a);
    await oldB.create({ only: "old b" });
    const oldBFile = current.SqliteAdapter.open(join(dir, "old-b.cromdb"));
    await oldB.backup(oldBFile);
    assert.equal((await n.recover(oldBFile)).suspects, 1);
    oldBFile.close();
    nFile.close();
    const n080Again = await alice080.openDatabase(release080.SqliteAdapter.open(path));
    assert.equal((await n080Again.suspects()).length, 1);
    await pull(n080Again, a);
    await pull(b, a);
    await pull(a, n080Again);
    assert.deepEqual(await snapshot(n080Again), await snapshot(a));
  });

  it("each catches the other restored from an old file, from its hello", async () => {
    const { a, b } = await mixed();
    // A 0.8.0 replica put back from a copy, caught by the current build.
    const path080 = join(dir, "080.cromdb");
    const file080 = release080.SqliteAdapter.open(path080);
    const old080 = await alice080.openDatabase(file080, { replicaOf: json(await a.registerReplica()) as unknown as Ticket080 });
    await pull(old080, a);
    await pull(a, old080);
    file080.close();
    copyFileSync(path080, join(dir, "080-copy.cromdb"));
    const live080 = await alice080.openDatabase(release080.SqliteAdapter.open(path080));
    await live080.create({ later: true });
    await pull(a, live080);
    const restored080 = await alice080.openDatabase(release080.SqliteAdapter.open(join(dir, "080-copy.cromdb")));
    await assert.rejects(pull(a, restored080), { code: "REWIND_DETECTED" });

    // A current-build replica put back from a copy, caught by 0.8.0.
    const path = join(dir, "current.cromdb");
    const file = current.SqliteAdapter.open(path);
    const old = await alice.openDatabase(file, { replicaOf: json(await b.registerReplica()) as unknown as TicketCurrent });
    await pull(old, b);
    await pull(b, old);
    file.close();
    copyFileSync(path, join(dir, "current-copy.cromdb"));
    const live = await alice.openDatabase(current.SqliteAdapter.open(path));
    await live.create({ later: true });
    await pull(b, live);
    const restored = await alice.openDatabase(current.SqliteAdapter.open(join(dir, "current-copy.cromdb")));
    await assert.rejects(pull(b, restored), { code: "REWIND_DETECTED" });
  });
});
