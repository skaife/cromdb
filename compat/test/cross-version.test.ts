// Replicas on cromdb 0.2.0 and 0.3.0 (from npm) and on the current build,
// syncing both ways with only JSON text passing between them, as two
// processes would. Databases made by those releases are at level 1; the
// current build creates level-4 databases, which they must refuse.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as release020 from "cromdb-0.2.0";
import * as release030 from "cromdb-0.3.0";
import { makeFixture } from "../scripts/make-fixture.ts";

type Release = typeof release030;
const RELEASES: [string, Release][] = [
  ["0.2.0", release020 as unknown as Release],
  ["0.3.0", release030],
];

// What both engines' Database have in common for sync and checks.
interface Replica {
  readonly instanceId: string;
  syncPosition(sourceInstanceId: string): Promise<number>;
  exportChanges(options: { since: number }): Promise<unknown>;
  applyChanges(batch: unknown): Promise<{ applied: number; hasMore: boolean }>;
  get(id: string): Promise<Doc | undefined>;
  find(filter?: { inConflict?: boolean }): Promise<AsyncIterable<Doc> & { count: number }>;
}

interface Doc {
  readonly id: string;
  readonly version: string;
  readonly content: Record<string, unknown>;
  conflict(): Promise<{ readonly version: string; resolveWithContent(options: { content: Record<string, unknown> }): Promise<unknown> } | undefined>;
  save(): Promise<unknown>;
  delete(): Promise<unknown>;
}

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

async function pull(target: Replica, source: Replica): Promise<number> {
  let applied = 0;
  for (;;) {
    const since = json(await target.syncPosition(source.instanceId)) as number;
    const result = await target.applyChanges(json(await source.exportChanges({ since })));
    applied += result.applied;
    if (!result.hasMore) {
      return applied;
    }
  }
}

async function exchange(a: Replica, b: Replica): Promise<void> {
  await pull(b, a);
  await pull(a, b);
}

/** Every document the replica shows, by ID, with its version and content. */
async function snapshot(db: Replica): Promise<Map<string, { version: string; content: unknown }>> {
  const result = new Map<string, { version: string; content: unknown }>();
  for await (const doc of await db.find()) {
    result.set(doc.id, { version: doc.version, content: json(doc.content) });
  }
  return result;
}

async function edit(db: Replica, id: string, change: Record<string, unknown>): Promise<void> {
  const doc = await db.get(id);
  assert.ok(doc, `document ${id} not found`);
  Object.assign(doc.content, change);
  await doc.save();
}

/** Makes a conflict on id between a and b, then checks both show it the same way. */
async function conflictBetween(a: Replica, b: Replica, id: string): Promise<void> {
  await edit(a, id, { status: "edited on a" });
  await edit(b, id, { status: "edited on b" });
  await exchange(a, b);
  const onA = await (await a.get(id))?.conflict();
  const onB = await (await b.get(id))?.conflict();
  assert.ok(onA && onB, "expected a conflict on both replicas");
  assert.equal(onA.version, onB.version);
  assert.equal((await a.find({ inConflict: true })).count, 1);
  assert.deepEqual(await snapshot(a), await snapshot(b));
}

async function resolveOn(db: Replica, id: string, status: string): Promise<void> {
  const conflict = await (await db.get(id))?.conflict();
  assert.ok(conflict);
  await conflict.resolveWithContent({ content: { title: "Plan", status } });
}

for (const [release, old] of RELEASES) {
describe(`${release} and the current build`, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cromdb-compat-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(`is the current build against ${release}`, () => {
    assert.equal(old.VERSION, release);
    assert.notEqual(current.VERSION, release);
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 4 });
  });

  it("sync both ways, with conflicts made and resolved across versions, and files that open in either", async () => {
    const fileA = join(dir, "a.cromdb");
    const fileB = join(dir, "b.cromdb");
    const fileC = join(dir, "c.cromdb");

    // A database made by the old release, and a replica of it in a file made by it.
    const adapterA = old.SqliteAdapter.open(fileA);
    const a = await old.Session.named("alice").openDatabase(adapterA, { replicaName: `A on ${release}` });
    const acl = await a.getAcl();
    acl.creators = ["*"];
    await acl.save();
    const madeByOld = old.SqliteAdapter.open(fileB);
    await a.createReplica(madeByOld, { name: "B on the current build" });
    madeByOld.close();

    // The current build opens it, at level 1, by name only. A 0.2.0 peer has
    // no handshake; a 0.3.0 one has.
    let adapterB = current.SqliteAdapter.open(fileB);
    await assert.rejects(current.Session.withId("alice").openDatabase(adapterB), { code: "INVALID_PRINCIPAL" });
    let b: Replica & current.Database = await current.Session.named("alice").openDatabase(adapterB);
    assert.equal(b.level, 1);
    assert.deepEqual(await b.checkPeer(undefined), { level: 1 });
    if (release !== "0.2.0") {
      assert.deepEqual(await b.checkPeer(json(await a.syncHello()) as current.SyncHello), { level: 1 });
      assert.deepEqual(await a.checkPeer(json(await b.syncHello()) as release030.SyncHello), { level: 1 });
    }

    // Documents from each side, synced both ways.
    const plan = await a.create({ title: "Plan", status: "draft" });
    const other = await a.create({ title: "Plan", status: "draft" });
    const fromB = await b.create({ title: "From the current build" });
    await exchange(a, b);
    assert.equal((await snapshot(a)).size, 3);
    assert.deepEqual(await snapshot(a), await snapshot(b));

    // A conflict across versions, resolved on the old release.
    await conflictBetween(a, b, plan.id);
    await resolveOn(a, plan.id, `resolved on ${release}`);
    await exchange(a, b);
    assert.equal((await b.find({ inConflict: true })).count, 0);
    assert.deepEqual(await snapshot(a), await snapshot(b));

    // Another, resolved on the current build.
    await conflictBetween(a, b, other.id);
    await resolveOn(b, other.id, "resolved on the current build");
    await exchange(a, b);
    assert.equal((await a.find({ inConflict: true })).count, 0);
    assert.equal((await a.get(other.id))?.content["status"], "resolved on the current build");
    assert.deepEqual(await snapshot(a), await snapshot(b));

    // A delete on the old release of a document the current build made.
    await (await a.get(fromB.id))?.delete();
    await exchange(a, b);
    assert.equal(await b.get(fromB.id), undefined);

    // A replica made by the current build, opened by the old release.
    const madeByCurrent = current.SqliteAdapter.open(fileC);
    await b.createReplica(madeByCurrent, { name: "C made by the current build" });
    madeByCurrent.close();
    const adapterC = old.SqliteAdapter.open(fileC);
    const c = await old.Session.named("alice").openDatabase(adapterC);
    await c.create({ title: `From C on ${release}` });
    await exchange(b, c);
    await exchange(a, b); // A learns of C through B
    await exchange(a, c);
    assert.deepEqual(await snapshot(a), await snapshot(c));
    assert.deepEqual(await snapshot(b), await snapshot(c));

    // B's file, opened and written by the current build, back on the old
    // release: still format 1, it opens, syncs, and takes writes.
    adapterB.close();
    for (const file of [fileB, fileC]) {
      assert.equal(userVersion(file), 1);
    }
    const rolledBack = old.SqliteAdapter.open(fileB);
    const bOld = await old.Session.named("alice").openDatabase(rolledBack);
    await bOld.create({ title: "Written after rolling back" });
    await exchange(a, bOld);
    await exchange(bOld, c);
    assert.deepEqual(await snapshot(bOld), await snapshot(a));
    rolledBack.close();

    // And forward again: the index the old release kept up to date pages correctly.
    adapterB = current.SqliteAdapter.open(fileB);
    b = await current.Session.named("alice").openDatabase(adapterB);
    const all = [...(await snapshot(b)).keys()];
    const paged: string[] = [];
    let next: string | undefined;
    do {
      const page = await b.find({}, { limit: 2, after: next });
      for await (const doc of page) {
        paged.push(doc.id);
      }
      next = page.next;
    } while (next !== undefined);
    assert.deepEqual(paged, all);
    assert.equal(paged.length, 4); // five created, one deleted
    assert.deepEqual(
      (await b.replicas()).map((replica) => replica.name),
      [`A on ${release}`, "B on the current build", "C made by the current build"],
    );

    adapterA.close();
    adapterB.close();
    adapterC.close();
  });

  it(`the fixture script still makes a fixture with ${release}`, async () => {
    const out = join(dir, "fixture");
    await makeFixture(release, out);
    const expected = JSON.parse(readFileSync(join(out, "expected.json"), "utf8")) as { madeBy: string; conflict: { versions: unknown[] } };
    assert.equal(expected.madeBy, `cromdb ${release}`);
    assert.equal(expected.conflict.versions.length, 2);
  });

  it("refuses a level-4 database file, marked as format 2, with a plain Error, as it can't be changed", async () => {
    const file = join(dir, "level-4.cromdb");
    const adapter = current.SqliteAdapter.open(file);
    await current.Session.withId("alice").openDatabase(adapter);
    adapter.close();
    assert.equal(userVersion(file), 2);
    assert.throws(() => old.SqliteAdapter.open(file), (error: Error) => {
      assert.ok(!(error instanceof old.CromDBError));
      assert.equal(error.message, `Unsupported database format version 2 in "${file}" (expected 1)`);
      return true;
    });
  });

  it("refuses a later format's batch with INVALID_BATCH, applying nothing", async () => {
    // A batch for the old replica's own database, as if from a later replica of it.
    const o = await old.Session.named("alice").openDatabase(old.SqliteAdapter.open(":memory:"));
    const later = await current.Session.withId("alice").openDatabase(current.SqliteAdapter.open(":memory:"));
    await later.create({ x: 1 });
    const batch = json(await later.exportChanges()) as Record<string, unknown>;
    assert.equal(batch["format"], 3);
    const before = (await o.find()).count;
    await assert.rejects(o.applyChanges({ ...batch, databaseId: o.databaseId, sourceInstanceId: o.instanceId }), {
      code: "INVALID_BATCH",
      message: 'The batch has unknown field "level"',
    });
    assert.equal((await o.find()).count, before);
  });
});
}

/** Copies every document, change and the local state a fresh replica has into an adapter of another engine. */
function copyInto(from: current.SqliteAdapter, to: release030.SqliteAdapter, localKeys: readonly string[]): void {
  for (const envelope of from.allDocuments()) {
    to.putDocument(envelope);
  }
  for (const { seq: _seq, ...entry } of from.changesSince(0)) {
    to.appendChange(entry);
  }
  for (const key of localKeys) {
    to.setLocal(key, from.getLocal(key) as string);
  }
}

describe("data above level 1 outside a marked SQLite file", () => {
  it("0.3.0 refuses to open it, and a later level's hello for its own database, with UPGRADE_REQUIRED", async () => {
    const source = current.SqliteAdapter.open(":memory:");
    const later = await current.Session.withId("alice").openDatabase(source);
    // As through an adapter that doesn't mark files: 0.3.0's SQLite adapter
    // in memory, holding level-4 data.
    const target = release030.SqliteAdapter.open(":memory:");
    copyInto(source, target, ["databaseId", "instanceId", "conflictPolicy"]);
    await assert.rejects(release030.Session.named("alice").openDatabase(target), {
      code: "UPGRADE_REQUIRED",
      message: "The database is at level 4, but this engine supports levels up to 1",
    });

    // A 0.3.0 replica of a level-1 database, given a hello at level 4 for
    // that database from a replica it knows: its handshake asks for an upgrade.
    const old = await release030.Session.named("alice").openDatabase(release030.SqliteAdapter.open(":memory:"));
    const peerAdapter = release030.SqliteAdapter.open(":memory:");
    await old.createReplica(peerAdapter);
    const peer = await release030.Session.named("alice").openDatabase(peerAdapter);
    const hello = { ...(json(await later.syncHello()) as release030.SyncHello), databaseId: old.databaseId, instanceId: peer.instanceId };
    await assert.rejects(old.checkPeer(hello), { code: "UPGRADE_REQUIRED", message: /this replica must be upgraded/ });
  });

  it("0.2.0 opens it and reads IDs as names, which is why the CHANGELOG warns against it", async () => {
    const source = current.SqliteAdapter.open(":memory:");
    const later = await current.Session.withId("alice").openDatabase(source);
    await later.create({ x: 1 }, { readers: ["Alice"], writers: ["Alice"] });
    const target = release020.SqliteAdapter.open(":memory:");
    copyInto(source, target as unknown as release030.SqliteAdapter, ["databaseId", "instanceId", "conflictPolicy"]);
    const old = await release020.Session.named("alice").openDatabase(target);
    // By ID, "alice" can't read a document for "Alice"; 0.2.0 compares
    // without case and lets her.
    assert.equal((await later.find()).count, 0);
    assert.equal((await old.find()).count, 1);
  });
});

/** PRAGMA user_version of a closed SQLite file: bytes 60 to 63 of its header, big-endian. */
function userVersion(file: string): number {
  return readFileSync(file).readUInt32BE(60);
}
