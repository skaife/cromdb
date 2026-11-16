// Replicas on cromdb 0.2.0 (from npm) and on the current build, syncing both
// ways with only JSON text passing between them, as two processes would.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as current from "cromdb";
import * as old from "cromdb-0.2.0";
import { makeFixture } from "../scripts/make-fixture.ts";

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

describe("0.2.0 and the current build", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "cromdb-compat-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is the current build against 0.2.0", () => {
    assert.equal(old.VERSION, "0.2.0");
    assert.notEqual(current.VERSION, "0.2.0");
    assert.deepEqual(current.SUPPORTED_LEVELS, { min: 1, max: 2 });
  });

  it("sync both ways, with conflicts made and resolved across versions, and files that open in either", async () => {
    const fileA = join(dir, "a.cromdb");
    const fileB = join(dir, "b.cromdb");
    const fileC = join(dir, "c.cromdb");

    // A database made by 0.2.0, and a replica of it in a file made by 0.2.0.
    const adapterA = old.SqliteAdapter.open(fileA);
    const a = await old.Session.named("alice").openDatabase(adapterA, { replicaName: "A on 0.2.0" });
    const acl = await a.getAcl();
    acl.creators = ["*"];
    await acl.save();
    const madeByOld = old.SqliteAdapter.open(fileB);
    await a.createReplica(madeByOld, { name: "B on the current build" });
    madeByOld.close();

    // The current build opens it, at level 1, by name only. A 0.2.0 peer
    // has no handshake.
    let adapterB = current.SqliteAdapter.open(fileB);
    await assert.rejects(current.Session.withId("alice").openDatabase(adapterB), { code: "INVALID_PRINCIPAL" });
    let b: Replica & current.Database = await current.Session.named("alice").openDatabase(adapterB);
    assert.equal(b.level, 1);
    assert.deepEqual(await b.checkPeer(undefined), { level: 1 });

    // Documents from each side, synced both ways.
    const plan = await a.create({ title: "Plan", status: "draft" });
    const other = await a.create({ title: "Plan", status: "draft" });
    const fromB = await b.create({ title: "From the current build" });
    await exchange(a, b);
    assert.equal((await snapshot(a)).size, 3);
    assert.deepEqual(await snapshot(a), await snapshot(b));

    // A conflict across versions, resolved on 0.2.0.
    await conflictBetween(a, b, plan.id);
    await resolveOn(a, plan.id, "resolved on 0.2.0");
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

    // A delete on 0.2.0 of a document the current build made.
    await (await a.get(fromB.id))?.delete();
    await exchange(a, b);
    assert.equal(await b.get(fromB.id), undefined);

    // A replica made by the current build, opened by 0.2.0.
    const madeByCurrent = current.SqliteAdapter.open(fileC);
    await b.createReplica(madeByCurrent, { name: "C made by the current build" });
    madeByCurrent.close();
    const adapterC = old.SqliteAdapter.open(fileC);
    const c = await old.Session.named("alice").openDatabase(adapterC);
    await c.create({ title: "From C on 0.2.0" });
    await exchange(b, c);
    await exchange(a, b); // A learns of C through B
    await exchange(a, c);
    assert.deepEqual(await snapshot(a), await snapshot(c));
    assert.deepEqual(await snapshot(b), await snapshot(c));

    // B's file, opened by the current build (which added its paging index),
    // back on 0.2.0: it opens, syncs, and takes writes.
    adapterB.close();
    const rolledBack = old.SqliteAdapter.open(fileB);
    const bOld = await old.Session.named("alice").openDatabase(rolledBack);
    await bOld.create({ title: "Written after rolling back" });
    await exchange(a, bOld);
    await exchange(bOld, c);
    assert.deepEqual(await snapshot(bOld), await snapshot(a));
    rolledBack.close();

    // And forward again: the index 0.2.0 kept up to date pages correctly.
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
      ["A on 0.2.0", "B on the current build", "C made by the current build"],
    );

    adapterA.close();
    adapterB.close();
    adapterC.close();
  });

  it("the fixture script still makes a fixture with 0.2.0", async () => {
    const out = join(dir, "fixture");
    await makeFixture(out);
    const expected = JSON.parse(readFileSync(join(out, "expected.json"), "utf8")) as { madeBy: string; conflict: { versions: unknown[] } };
    assert.equal(expected.madeBy, "cromdb 0.2.0");
    assert.equal(expected.conflict.versions.length, 2);
  });
});
