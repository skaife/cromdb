// Recovery, one behaviour at a time: retirement, rewinds caught at hello,
// backups and adoption, recovering suspects, and storage space. The
// randomized checks against the reference model are in recovery-model.test.ts
// and recovery-engine.test.ts.

import BetterSqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import { parseHello } from "../src/handshake.js";
import { DAY_MS, HOUR_MS } from "../src/purge.js";
import { Session } from "../src/session.js";
import type { StorageAdapter } from "../src/storage/adapter.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";
import { registrationDocId } from "../src/system-docs.js";
import { TestAdapter, expectCode } from "./helpers.js";

const alice = Session.withId("alice");
const bob = Session.withId("bob");
const START = Date.parse("2026-03-01T00:00:00.000Z");

let adapters: StorageAdapter[];
let time: number;
const now = (): Date => new Date(time);
let directory: string;

beforeEach(() => {
  adapters = [];
  time = START;
  directory = mkdtempSync(join(tmpdir(), "cromdb-recovery-"));
});

afterEach(() => {
  for (const adapter of adapters) {
    try {
      adapter.close();
    } catch {
      // Already closed.
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

function memory(): TestAdapter {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return adapter;
}

function file(name: string): SqliteAdapter {
  const adapter = SqliteAdapter.open(join(directory, name));
  adapters.push(adapter);
  return adapter;
}

function track<T extends StorageAdapter>(adapter: T): T {
  adapters.push(adapter);
  return adapter;
}

function hours(n: number): void {
  time += n * HOUR_MS;
}

async function open(adapter: StorageAdapter, options: { adopt?: boolean } = {}): Promise<Database> {
  return alice.openDatabase(adapter, { now, ...options });
}

/** a, with b made from a's ticket and pulled up to date; both opened by alice. */
async function pair(): Promise<{ a: Database; b: Database; aAdapter: TestAdapter; bAdapter: TestAdapter }> {
  const aAdapter = memory();
  const a = await open(aAdapter);
  const ticket = await a.registerReplica({ name: "b" });
  const bAdapter = memory();
  const b = await alice.openDatabase(bAdapter, { now, replicaOf: ticket });
  await b.pullFrom(a);
  await a.pullFrom(b);
  return { a, b, aAdapter, bAdapter };
}

/** A new replica of a's database, from a ticket, pulled from a. */
async function fromTicket(a: Database): Promise<{ db: Database; adapter: TestAdapter }> {
  const adapter = memory();
  const db = await alice.openDatabase(adapter, { now, replicaOf: await a.registerReplica() });
  await db.pullFrom(a);
  return { db, adapter };
}

describe("rewinds caught at hello", () => {
  it("marks a copy restored from an old file rewound at its first pull, for good", async () => {
    const { a, b, aAdapter } = await pair();
    const old = track(aAdapter.rawCopy());
    hours(1);
    await a.create({ n: 1 });
    await b.pullFrom(a);
    const restored = await open(old);
    expect(restored.instanceId).toBe(a.instanceId);

    const error = await expectCode(restored.pullFrom(b), "REWIND_DETECTED");
    expect(error.message).toContain("restored from an old copy, or copied");
    expect(await restored.syncState()).toMatchObject({ rewound: true, retired: false });
    await expectCode(restored.create({ n: 2 }), "READ_ONLY");
    await expectCode(restored.syncHello(), "REWIND_DETECTED");
    await expectCode(restored.exportChanges(), "REWIND_DETECTED");
    // Reopened, it is still rewound, and opening it wrote nothing.
    const lastSeq = old.lastSeq();
    const again = await open(old);
    expect(old.lastSeq()).toBe(lastSeq);
    await expectCode(again.create({ n: 3 }), "READ_ONLY");
  });

  it("refuses a peer restored from an old file, and records nothing about it", async () => {
    const { a, b, aAdapter } = await pair();
    const old = track(aAdapter.rawCopy());
    hours(1);
    await a.create({ n: 1 });
    await b.pullFrom(a);
    const restored = await open(old);
    const error = await expectCode(b.pullFrom(restored), "REWIND_DETECTED");
    expect(error.message).toContain("likely restored or copied from an old file");
    expect(await b.syncState()).toMatchObject({ rewound: false });
  });

  it("still catches it after the restored copy pulled from replicas that knew nothing, thanks to the tip", async () => {
    // c never sees a's later writes; b does. The restored a pulls from c
    // first, which adds entries to its log, and only then from b.
    const { a, b, aAdapter } = await pair();
    const { db: c } = await fromTicket(a);
    await a.pullFrom(c);
    await b.pullFrom(a);
    const old = track(aAdapter.rawCopy());
    hours(1);
    await a.create({ n: 1 });
    await b.pullFrom(a);
    // c writes a lot, so the restored a's log grows past where b knew it.
    for (let n = 0; n < 20; n++) {
      await c.create({ c: n });
    }
    const restored = await open(old);
    await restored.pullFrom(c);
    expect(old.lastSeq()).toBeGreaterThan(aAdapter.lastSeq());
    await expectCode(restored.pullFrom(b), "REWIND_DETECTED");
    expect(await restored.syncState()).toMatchObject({ rewound: true });
  });

  it("catches a restored copy that wrote past where it was before it pulled, by the entry its peer saw", async () => {
    const { a, b, aAdapter } = await pair();
    const doc = await a.create({ n: 1 });
    await b.pullFrom(a);
    const old = track(aAdapter.rawCopy());
    hours(1);
    const onA = (await a.get<{ n: number }>(doc.id)) as NonNullable<Awaited<ReturnType<Database["get"]>>>;
    onA.content = { n: 2 };
    await onA.save();
    await b.pullFrom(a);
    const restored = await open(old);
    for (const n of [3, 4]) {
      hours(1);
      const loaded = (await restored.get<{ n: number }>(doc.id)) as NonNullable<Awaited<ReturnType<Database["get"]>>>;
      loaded.content = { n };
      await loaded.save();
    }
    expect(old.lastSeq()).toBeGreaterThan(aAdapter.lastSeq() - 1);
    await expectCode(restored.pullFrom(b), "REWIND_DETECTED");
    expect(await restored.syncState()).toMatchObject({ rewound: true });
  });

  it("catches a restored copy that wrote as many entries as it lost, when others pull from it first", async () => {
    const { a, b, aAdapter } = await pair();
    await b.pullFrom(a);
    const old = track(aAdapter.rawCopy());
    hours(1);
    await b.create({ from: "b" });
    await a.pullFrom(b);
    await b.pullFrom(a);
    const restored = await open(old);
    hours(1);
    await restored.create({ from: "the restored copy" });
    expect(old.lastSeq()).toBe(aAdapter.lastSeq());
    // b sees a different newest entry at a position it saw before.
    await expectCode(b.pullFrom(restored), "REWIND_DETECTED");
    // b kept the tip it saw first, so the copy finds out at its next pull.
    await expectCode(restored.pullFrom(b), "REWIND_DETECTED");
    expect(await restored.syncState()).toMatchObject({ rewound: true });
  });

  it("catches a restored copy from a hello without tips, as 0.7.0 sends, by how far the peer knows its log", async () => {
    const { a, b, aAdapter } = await pair();
    const old = track(aAdapter.rawCopy());
    hours(1);
    await a.create({ n: 1 });
    await b.pullFrom(a);
    const restored = await open(old);
    const { tip: _tip, tips: _tips, ...hello } = await b.syncHello();
    await expectCode(restored.checkPeer(hello), "REWIND_DETECTED");
    expect(await restored.syncState()).toMatchObject({ rewound: true });
  });

  it("sends its newest entry and the tips it saw in its hello, which an older engine ignores", async () => {
    const { a, b } = await pair();
    const hello = await a.syncHello();
    expect(hello.tip).toEqual({ seq: expect.any(Number), entry: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(Object.keys(hello.tips ?? {})).toEqual([b.instanceId]);
    for (const bad of [{ tip: 3 }, { tip: { seq: -1, entry: "x".repeat(43) } }, { tips: { [b.instanceId]: { seq: 1 } } }, { tips: { notAnId: { seq: 1, entry: "x".repeat(43) } } }]) {
      await expectCode(Promise.resolve().then(() => parseHello({ ...hello, ...bad })), "INVALID_HANDSHAKE");
    }
    const { tip: _tip, tips: _tips, ...older } = hello;
    expect(parseHello(older)).toEqual(older);
  });

  it("marks a replica rewound when a batch brings back a write of its own it doesn't hold", async () => {
    // c gets a's write d through b, in a batch that isn't the last of its
    // pull, so c learns nothing of how far a's log went; and c never checks
    // a's hello. Only d itself shows the restored a went back.
    const { a, b, aAdapter } = await pair();
    const { db: c } = await fromTicket(b);
    await a.pullFrom(b);
    await b.pullFrom(c);
    await c.pullFrom(b);
    const old = track(aAdapter.rawCopy());
    hours(1);
    const d = await a.create({ n: 1 });
    await b.pullFrom(a);
    await b.create({ n: 2 });
    await c.checkPeer(await b.syncHello());
    const batch = await b.exportChanges({ since: await c.syncPosition(b.instanceId), limit: 1 });
    expect(await c.applyChanges(batch)).toMatchObject({ hasMore: true });
    expect(await c.get(d.id)).toBeDefined();

    const restored = await open(old);
    const error = await expectCode(restored.pullFrom(c), "REWIND_DETECTED");
    expect(error.message).toContain("another replica holds a write of this one that it doesn't have");
    expect(await restored.syncState()).toMatchObject({ rewound: true });
    expect(await restored.get(d.id)).toBeUndefined();
  });
});

describe("retireReplica", () => {
  it("retires another replica: everyone who learns of it refuses it, and it stops once it learns", async () => {
    const { a, b } = await pair();
    const { db: c } = await fromTicket(a);
    await b.pullFrom(a);
    await a.retireReplica(c.instanceId);
    await b.pullFrom(a);
    await expectCode(a.pullFrom(c), "SYNC_MISMATCH");
    await expectCode(b.pullFrom(c), "SYNC_MISMATCH");
    // c can still pull (export doesn't know the puller), and learns it is retired.
    await c.pullFrom(b);
    expect(await c.syncState()).toMatchObject({ retired: true });
    await expectCode(c.create({ n: 1 }), "READ_ONLY");
    await expectCode(c.syncHello(), "SYNC_MISMATCH");
    expect((await a.replicas()).find((replica) => replica.instanceId === c.instanceId)).toBeDefined();
  });

  it("is refused for this replica itself, an unknown one and for non-admins; twice does nothing", async () => {
    const { a, b, aAdapter } = await pair();
    await expectCode(a.retireReplica(a.instanceId), "NOT_SUPPORTED");
    await expectCode(a.retireReplica("2f6f0c4e-4d7b-4a3e-9a9e-0b1c2d3e4f50"), "NOT_FOUND");
    await expect(a.retireReplica(3 as unknown as string)).rejects.toThrow(TypeError);
    const acl = await a.getAcl();
    acl.readers = ["alice", "bob"];
    await acl.save();
    await expectCode((await bob.openDatabase(aAdapter, { now })).retireReplica(b.instanceId), "ACCESS_DENIED");
    await a.retireReplica(b.instanceId);
    const lastSeq = (await a.syncHello()).lastSeq;
    await a.retireReplica(b.instanceId);
    expect((await a.syncHello()).lastSeq).toBe(lastSeq);
  });
});

describe("retirement racing a replica's own registration write", () => {
  it("ends retired on every replica", async () => {
    const { a, b } = await pair();
    // fresh's first open writes its engine's level into its registration;
    // b has only the introducer's version when it retires fresh.
    const fresh = await alice.openDatabase(memory(), { now, replicaOf: await a.registerReplica() });
    await b.pullFrom(a);
    await b.retireReplica(fresh.instanceId);
    await a.pullFrom(fresh);
    await a.pullFrom(b);
    await b.pullFrom(a);
    for (const db of [a, b]) {
      const registration = (await db.replicas()).find((replica) => replica.instanceId === fresh.instanceId);
      expect(registration).toBeDefined();
    }
    await expectCode(a.pullFrom(fresh), "SYNC_MISMATCH");
    await expectCode(b.pullFrom(fresh), "SYNC_MISMATCH");
    await fresh.pullFrom(a);
    expect(await fresh.syncState()).toMatchObject({ retired: true });
  });
});

describe("backups and adoption", () => {
  it("makes a consistent backup that reads, refuses writes and sync, and that 0.7.0's format refuses", async () => {
    const source = file("source.cromdb");
    const a = await open(source);
    const kept = await a.create({ n: 1 });
    await (await a.create({ n: 2 })).delete();
    const target = file("backup.cromdb");
    await a.backup(target);
    const raw = new BetterSqlite(join(directory, "backup.cromdb"), { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(3);
    raw.close();

    const backup = await open(target);
    expect(backup.instanceId).toBe(a.instanceId);
    expect(await backup.get(kept.id)).toMatchObject({ content: { n: 1 } });
    expect(await backup.syncState()).toMatchObject({ backupOf: a.instanceId, rewound: false, retired: false });
    // Opening a backup writes nothing, not even the engine's level, which
    // an ordinary open records when the registration lacks it.
    const own = registrationDocId(a.databaseId, a.instanceId);
    const stored = target.getDocument(own);
    if (stored === undefined) throw new Error("no registration");
    target.putDocument({ ...stored, content: { ...stored.content, maxLevel: 3 } });
    const before = target.lastSeq();
    await open(target);
    expect(target.lastSeq()).toBe(before);
    expect(target.getDocument(own)?.content["maxLevel"]).toBe(3);
    await expectCode(backup.create({ n: 3 }), "READ_ONLY");
    await expectCode(backup.syncHello(), "SYNC_MISMATCH");
    await expectCode(backup.pullFrom(a), "SYNC_MISMATCH");
    await expectCode(a.pullFrom(backup), "SYNC_MISMATCH");
    await expectCode(backup.purge(), "READ_ONLY");
    await expectCode(backup.backup(memory()), "READ_ONLY");
    expect(target.lastSeq()).toBe(before);
  });

  it("is refused into a storage that isn't empty, or its own, and for non-admins", async () => {
    const source = memory();
    const a = await open(source);
    const full = memory();
    await open(full);
    await expectCode(a.backup(full), "INVALID_DATABASE");
    await expectCode(a.backup(source), "INVALID_DATABASE");
    await expect(a.backup({} as StorageAdapter)).rejects.toThrow(TypeError);
    const acl = await a.getAcl();
    acl.readers = ["alice", "bob"];
    await acl.save();
    const target = memory();
    await expectCode((await bob.openDatabase(source, { now })).backup(target), "ACCESS_DENIED");
    expect(target.isEmpty()).toBe(true);
  });

  it("adopts a backup when it is the only copy left: a new ID, the old one retired, writable", async () => {
    const source = memory();
    const a = await open(source);
    await a.saveSettings({ purgeAfterDays: 30 });
    const doc = await a.create({ n: 1 });
    const backup = memory();
    await a.backup(backup);
    const second = track(backup.rawCopy());
    source.close();

    const adopted = await open(backup, { adopt: true });
    expect(adopted.instanceId).not.toBe(a.instanceId);
    // The new ID is stored, not only reported.
    expect((await open(backup)).instanceId).toBe(adopted.instanceId);
    expect(await adopted.syncState()).toMatchObject({ rewound: false, retired: false });
    expect((await adopted.syncState()).backupOf).toBeUndefined();
    expect(await adopted.getSettings()).toEqual({ purgeAfterDays: 30 });
    const loaded = await adopted.get<{ n: number }>(doc.id);
    expect(loaded?.content.n).toBe(1);
    (loaded as NonNullable<typeof loaded>).content.n = 2;
    await (loaded as NonNullable<typeof loaded>).save();
    const replicas = await adopted.replicas();
    expect(replicas.map((replica) => replica.instanceId).sort()).toEqual([a.instanceId, adopted.instanceId].sort());
    expect(backup.getDocument(registrationDocId(a.databaseId, a.instanceId))?.content["status"]).toBe("retired");

    // Another copy of the same backup becomes another replica, never the same ID.
    const other = await open(second, { adopt: true });
    expect(other.instanceId).not.toBe(adopted.instanceId);
    expect(other.instanceId).not.toBe(a.instanceId);
    // And a replica made from the adopted one syncs with it.
    const { db: next } = await fromTicket(adopted);
    expect((await next.get<{ n: number }>(doc.id))?.content.n).toBe(2);
  });

  it("refuses to adopt what isn't a backup, for non-admins, and with other options", async () => {
    const a = await open(memory());
    const plain = memory();
    await open(plain);
    await expectCode(open(plain, { adopt: true }), "NOT_SUPPORTED");
    const backup = memory();
    await a.backup(backup);
    await expect(alice.openDatabase(backup, { now, adopt: "yes" as unknown as boolean })).rejects.toThrow(TypeError);
    await expect(alice.openDatabase(backup, { now, adopt: true, replicaName: "x" })).rejects.toThrow(TypeError);
    await expectCode(bob.openDatabase(backup, { now, adopt: true }), "ACCESS_DENIED");
    // Still a backup after the refusals.
    expect(await (await open(backup)).syncState()).toMatchObject({ backupOf: a.instanceId });
  });

  it("leaves the adopted replica unknown to replicas still in use, which refuse it", async () => {
    const { a, b, aAdapter } = await pair();
    const backup = memory();
    await a.backup(backup);
    void aAdapter;
    const adopted = await open(backup, { adopt: true });
    await expectCode(b.pullFrom(adopted), "SYNC_MISMATCH");
  });

  it("keeps a stale replica's backup stale", async () => {
    const { a, b } = await pair();
    await (await a.create({ n: 1 })).delete();
    time += 91 * DAY_MS;
    await a.purge();
    await b.create({ only: "b" });
    await expectCode(b.pullFrom(a), "STALE_REPLICA");
    const backup = memory();
    await b.backup(backup);
    const adopted = await open(backup, { adopt: true });
    expect(await adopted.syncState()).toMatchObject({ stale: true });
    await expectCode(adopted.create({ n: 2 }), "READ_ONLY");
  });
});

describe("recover and suspects", () => {
  /**
   * a and b; b goes offline. On a: d1 is deleted and purged after 91 days,
   * which leaves b stuck stale. On b meanwhile: d2 is made (only b has it),
   * d3 edited while a edits it too, d4 deleted while a keeps it.
   */
  async function stuck() {
    const { a, b, bAdapter } = await pair();
    const d1 = await a.create({ d: 1 });
    const d3 = await a.create({ d: 3 });
    const d4 = await a.create({ d: 4 });
    await b.pullFrom(a);
    hours(1);
    await (await a.get(d1.id))?.delete();
    const onA3 = (await a.get<{ d: number; by?: string }>(d3.id)) as NonNullable<Awaited<ReturnType<Database["get"]>>>;
    onA3.content = { d: 3, by: "a" };
    await onA3.save();
    const d2 = await b.create({ d: 2 });
    const onB3 = (await b.get<{ d: number; by?: string }>(d3.id)) as NonNullable<Awaited<ReturnType<Database["get"]>>>;
    onB3.content = { d: 3, by: "b" };
    await onB3.save();
    await (await b.get(d4.id))?.delete();
    time += 91 * DAY_MS;
    await a.purge();
    await expectCode(b.pullFrom(a), "STALE_REPLICA");
    const { db: n, adapter: nAdapter } = await fromTicket(a);
    return { a, b, bAdapter, n, nAdapter, ids: { d1: d1.id, d2: d2.id, d3: d3.id, d4: d4.id } };
  }

  it("finds each kind of suspect, and nothing the new replica already has", async () => {
    const { n, bAdapter, ids, b } = await stuck();
    const result = await n.recover(bAdapter);
    expect(result).toMatchObject({ suspects: 4, seen: 0 });
    const suspects = await n.suspects();
    const reasons = Object.fromEntries(suspects.map((suspect) => [suspect.documentId, suspect.reason]));
    expect(reasons).toEqual({ [ids.d1]: "absent", [ids.d2]: "absent", [ids.d3]: "concurrent", [ids.d4]: "deleted" });
    for (const suspect of suspects) {
      expect(suspect.from).toBe(b.instanceId);
    }
    expect(suspects.find((suspect) => suspect.documentId === ids.d4)?.document.deleted).toBe(true);
    expect(suspects.find((suspect) => suspect.documentId === ids.d2)?.current).toBeUndefined();
    expect(suspects.find((suspect) => suspect.documentId === ids.d3)?.current).toEqual(expect.any(String));
    expect((await n.recover(bAdapter)).suspects).toBe(0);
  });

  it("accepts, accepts with content and discards; accepted writes sync and win", async () => {
    const { a, n, bAdapter, ids } = await stuck();
    await n.recover(bAdapter);
    const byId = new Map((await n.suspects()).map((suspect) => [suspect.documentId, suspect]));
    const d2 = byId.get(ids.d2);
    const d3 = byId.get(ids.d3);
    const d4 = byId.get(ids.d4);
    const d1 = byId.get(ids.d1);
    if (d1 === undefined || d2 === undefined || d3 === undefined || d4 === undefined) throw new Error("missing suspect");

    await d2.accept();
    await expect(d3.accept()).rejects.toThrow(TypeError);
    await expectCode(d3.accept({ ifVersion: "not the version" }), "STALE_DOCUMENT");
    await d3.accept({ ifVersion: d3.current as string });
    await d4.accept({ ifVersion: d4.current as string });
    await expect(d1.acceptWithContent({ content: { d: 1, merged: true } })).resolves.toBeDefined();
    expect(await n.suspects()).toEqual([]);
    await expectCode(d2.discard(), "NOT_FOUND");

    expect((await n.get<{ d: number }>(ids.d2))?.content).toEqual({ d: 2 });
    const onN3 = await n.get<{ d: number; by: string }>(ids.d3);
    expect(onN3?.content).toEqual({ d: 3, by: "b" });
    expect(await onN3?.conflict()).toBeUndefined();
    expect(await n.get(ids.d4)).toBeUndefined();
    expect((await n.get(ids.d1))?.content).toEqual({ d: 1, merged: true });

    await a.pullFrom(n);
    expect((await a.get<{ d: number; by: string }>(ids.d3))?.content).toEqual({ d: 3, by: "b" });
    expect(await a.get(ids.d4)).toBeUndefined();
    expect((await a.get(ids.d2))?.content).toEqual({ d: 2 });
  });

  it("never offers a discarded suspect again, nor one the replica already had", async () => {
    const { n, bAdapter } = await stuck();
    await n.recover(bAdapter);
    for (const suspect of await n.suspects()) {
      await suspect.discard();
    }
    expect(await n.recover(bAdapter)).toMatchObject({ suspects: 0 });
    expect(await n.suspects()).toEqual([]);
  });

  it("keeps suspects across a restart", async () => {
    const { a, bAdapter } = await stuck();
    const path = join(directory, "n.cromdb");
    const nFile = track(SqliteAdapter.open(path));
    const n = await alice.openDatabase(nFile, { now, replicaOf: await a.registerReplica() });
    await n.pullFrom(a);
    await n.recover(bAdapter);
    const keys = (await n.suspects()).map((suspect) => suspect.key);
    nFile.close();
    const reopened = await open(track(SqliteAdapter.open(path)));
    expect((await reopened.suspects()).map((suspect) => suspect.key)).toEqual(keys);
  });

  it("is refused for a copy of itself, another database, an adapter without suspects, and on a replica that takes no writes", async () => {
    const { n, nAdapter, bAdapter, b } = await stuck();
    await expectCode(n.recover(track(nAdapter.rawCopy())), "SYNC_MISMATCH");
    await expectCode(n.recover(nAdapter), "SYNC_MISMATCH");
    const other = memory();
    await open(other);
    await expectCode(n.recover(other), "SYNC_MISMATCH");
    const backup = memory();
    await n.backup(backup);
    await expectCode((await open(backup)).recover(bAdapter), "READ_ONLY");
    nAdapter.putSuspect = undefined;
    await expectCode(n.recover(bAdapter), "NOT_SUPPORTED");
    void b;
  });

  it("lets a stuck replica be replaced: recover, then retire the old ID, which everyone then refuses", async () => {
    const { a, b, n, bAdapter } = await stuck();
    await n.recover(bAdapter);
    await n.retireReplica(b.instanceId);
    await a.pullFrom(n);
    await expectCode(a.pullFrom(b), "SYNC_MISMATCH");
    // The stuck copy can't learn it is retired: it doesn't know the new
    // replica, and a pull from a refuses it as stale first. It still takes
    // no writes, as a stale replica.
    await expectCode(b.pullFrom(n), "SYNC_MISMATCH");
    await expectCode(b.pullFrom(a), "STALE_REPLICA");
    await expectCode(b.create({ n: 1 }), "READ_ONLY");
  });
});

describe("a database made by 0.7.0", () => {
  it("opens, backs up, is adopted and recovered from, at level 4", async () => {
    const seed = track(new TestAdapter("alice", "0.7.0"));
    const db = await open(seed);
    expect(db.level).toBe(4);
    const doc = await db.create({ made: "on a 0.7.0 file" });
    const backup = memory();
    await db.backup(backup);
    const adopted = await open(backup, { adopt: true });
    expect((await adopted.get<{ made: string }>(doc.id))?.content.made).toBe("on a 0.7.0 file");
    const other = track(new TestAdapter("alice", "0.7.0"));
    const fresh = await open(other);
    await expectCode(fresh.recover(seed), "SYNC_MISMATCH");
  });
});

describe("spaceUsage", () => {
  it("reports the file's size and free space, which compact gives back", async () => {
    const adapter = file("space.cromdb");
    const db = await open(adapter);
    for (let n = 0; n < 300; n++) {
      await (await db.create({ n, padding: "x".repeat(500) })).delete();
    }
    time += 91 * DAY_MS;
    await db.purge();
    const before = adapter.spaceUsage();
    expect(before.freeBytes).toBeGreaterThan(0);
    expect(before.totalBytes).toBeGreaterThan(before.freeBytes);
    adapter.compact();
    const after = adapter.spaceUsage();
    expect(after.freeBytes).toBeLessThan(before.freeBytes);
    expect(after.totalBytes).toBeLessThan(before.totalBytes);
  });
});
