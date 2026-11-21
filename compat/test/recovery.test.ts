// cromdb 0.7.0 (from npm) and the current build, which adds retirement,
// rewinds caught at hello, backups and recovering suspects at the same level,
// 4. They sync both ways. 0.7.0 refuses to open a backup, so it can never
// write under the backed-up replica's ID; it honors a retired registration,
// opens a file that holds suspects, and ignores what a hello adds. The
// current build catches a 0.7.0 replica restored from an old file. Only JSON
// text passes between replicas, as between processes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release070 from "cromdb-0.7.0";

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

const alice = current.Session.withId("alice");
const alice070 = release070.Session.withId("alice");

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-compat-070-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** a on the current build, b on 0.7.0 made from a's ticket, synced both ways. */
async function mixed() {
  const a = await alice.openDatabase(current.SqliteAdapter.open(":memory:"));
  const ticket = json(await a.registerReplica({ name: "b on 0.7.0" }));
  const bAdapter = release070.SqliteAdapter.open(":memory:");
  const b = await alice070.openDatabase(bAdapter, { replicaOf: ticket as unknown as release070.ReplicaTicket });
  await pull(b, a);
  await pull(a, b);
  return { a, b, bAdapter };
}

describe("0.7.0 and the current build", () => {
  it("are 0.7.0 and a later build, both at level 4", () => {
    assert.equal(release070.VERSION, "0.7.0");
    assert.deepEqual(release070.SUPPORTED_LEVELS, { min: 1, max: 4 });
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 4 });
  });

  it("sync both ways, the current build's hello and batches accepted by 0.7.0", async () => {
    const { a, b } = await mixed();
    const fromA = await a.create({ title: "from the current build" });
    const fromB = await b.create({ title: "from 0.7.0" });
    await pull(b, a);
    await pull(a, b);
    assert.deepEqual(await snapshot(b), await snapshot(a));
    assert.ok((await snapshot(a)).has(fromB.id) && (await snapshot(b)).has(fromA.id));
    const hello = json(await a.syncHello()) as unknown as Record<string, unknown>;
    assert.ok("tip" in hello && "tips" in hello);
  });

  it("0.7.0 refuses to open a backup file, so it can't write under the backed-up replica's ID", async () => {
    const source = current.SqliteAdapter.open(join(dir, "source.cromdb"));
    const a = await alice.openDatabase(source);
    await a.create({ x: 1 });
    const path = join(dir, "backup.cromdb");
    const target = current.SqliteAdapter.open(path);
    await a.backup(target);
    target.close();
    assert.throws(() => release070.SqliteAdapter.open(path), /Unsupported database format version 3/);
    // The current build opens it, read-only.
    const backup = current.SqliteAdapter.open(path);
    const db = await alice.openDatabase(backup);
    await assert.rejects(db.create({ y: 1 }), { code: "READ_ONLY" });
    backup.close();
    source.close();
  });

  it("0.7.0 opens an adopted backup, an ordinary level-4 file again, and syncs with it", async () => {
    const source = current.SqliteAdapter.open(":memory:");
    const a = await alice.openDatabase(source);
    const doc = await a.create({ x: 1 });
    const path = join(dir, "adopted.cromdb");
    const target = current.SqliteAdapter.open(path);
    await a.backup(target);
    const adopted = await alice.openDatabase(target, { adopt: true });
    const ticket = json(await adopted.registerReplica());
    target.close();
    const old = release070.SqliteAdapter.open(path);
    const reopened = await alice070.openDatabase(old);
    assert.equal(reopened.instanceId, adopted.instanceId);
    const b = await alice070.openDatabase(release070.SqliteAdapter.open(":memory:"), { replicaOf: ticket as unknown as release070.ReplicaTicket });
    await pull(b, reopened);
    assert.ok((await snapshot(b)).has(doc.id));
    old.close();
  });

  it("0.7.0 honors a retirement the current build made, refusing the retired replica", async () => {
    const { a, b } = await mixed();
    const c = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), { replicaOf: json(await a.registerReplica()) });
    await pull(c, a);
    await pull(b, a);
    await pull(b, c);
    await a.retireReplica(c.instanceId);
    await pull(b, a);
    await assert.rejects(pull(b, c), { code: "SYNC_MISMATCH", message: /not active/ });
    // c learns it is retired from 0.7.0 too, and stops.
    await pull(c, b);
    assert.equal((await c.syncState()).retired, true);
  });

  it("an accepted suspect syncs to 0.7.0 as an ordinary write", async () => {
    const { a, b } = await mixed();
    // a's file is copied; a then writes d, which only that copy's later
    // state... here: d exists only on a copy of a's storage that a new replica
    // recovers from.
    const oldAdapter = current.SqliteAdapter.open(":memory:");
    const oldDb = await alice.openDatabase(oldAdapter, { replicaOf: json(await a.registerReplica()) });
    await pull(oldDb, a);
    const only = await oldDb.create({ only: "on the old copy" });
    const n = await alice.openDatabase(current.SqliteAdapter.open(":memory:"), { replicaOf: json(await a.registerReplica()) });
    await pull(n, a);
    assert.equal((await n.recover(oldAdapter)).suspects, 1);
    const [suspect] = await n.suspects();
    assert.ok(suspect !== undefined && suspect.reason === "absent");
    await suspect.accept();
    await a.retireReplica(oldDb.instanceId);
    await pull(a, n);
    await pull(b, a);
    const onB = await b.get<{ only: string }>(only.id);
    assert.equal(onB?.content.only, "on the old copy");
  });

  it("0.7.0 opens a file that holds suspects, and syncs it", async () => {
    const { a, b } = await mixed();
    const oldAdapter = current.SqliteAdapter.open(":memory:");
    const oldDb = await alice.openDatabase(oldAdapter, { replicaOf: json(await a.registerReplica()) });
    await pull(oldDb, a);
    await oldDb.create({ only: "old" });
    const path = join(dir, "with-suspects.cromdb");
    const nAdapter = current.SqliteAdapter.open(path);
    const n = await alice.openDatabase(nAdapter, { replicaOf: json(await a.registerReplica()) });
    await pull(n, a);
    await n.recover(oldAdapter);
    nAdapter.close();
    const reopened = await alice070.openDatabase(release070.SqliteAdapter.open(path));
    await pull(reopened, a);
    await pull(b, a);
    await pull(a, reopened);
    assert.deepEqual(await snapshot(reopened), await snapshot(a));
  });

  it("the current build catches a 0.7.0 replica restored from an old file, from its hello", async () => {
    const { a, b, bAdapter } = await mixed();
    void bAdapter;
    const path = join(dir, "070.cromdb");
    const fileAdapter = release070.SqliteAdapter.open(path);
    const old = await alice070.openDatabase(fileAdapter, { replicaOf: json(await a.registerReplica()) as unknown as release070.ReplicaTicket });
    await pull(old, a);
    await pull(a, old);
    fileAdapter.close();
    const copyPath = join(dir, "070-copy.cromdb");
    (await import("node:fs")).copyFileSync(path, copyPath);
    const live = await alice070.openDatabase(release070.SqliteAdapter.open(path));
    await live.create({ later: true });
    await pull(a, live);
    const restored = await alice070.openDatabase(release070.SqliteAdapter.open(copyPath));
    await assert.rejects(pull(a, restored), { code: "REWIND_DETECTED" });
    void b;
  });
});
