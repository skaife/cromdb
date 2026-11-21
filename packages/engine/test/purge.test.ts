// Purge, staleness, settings and raising a database to level 4, one
// behaviour at a time. The randomized checks against the reference model are
// in purge-model.test.ts and purge-engine.test.ts.

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { parseHello } from "../src/handshake.js";
import {
  DAY_MS,
  HOUR_MS,
  MAX_CHECKPOINTS,
  compareStamps,
  mergeRegistrationContent,
  mergeSettingsContent,
  mergeSystemVersions,
  noteCheckpoint,
  purgeCandidate,
  trimCheckpoints,
  uncovered,
  type Checkpoints,
} from "../src/purge.js";
import { parseBatch } from "../src/replication.js";
import { Session } from "../src/session.js";
import { databaseDocId, registrationDocId, settingsDocId } from "../src/system-docs.js";
import type { ReplicaTicket } from "../src/ticket.js";
import { compare, type VectorClock } from "../src/vector-clock.js";
import { TestAdapter, expectCode, level2Adapter, level3Adapter } from "./helpers.js";

const alice = Session.withId("alice");
const bob = Session.withId("bob");
const START = Date.parse("2026-03-01T00:00:00.000Z");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);

beforeEach(() => {
  adapters = [];
  time = START;
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

function newAdapter(make: () => TestAdapter = () => new TestAdapter()): TestAdapter {
  const adapter = make();
  adapters.push(adapter);
  return adapter;
}

function hours(n: number): void {
  time += n * HOUR_MS;
}

interface Replica {
  db: Database;
  adapter: TestAdapter;
}

/** n replicas of a level-4 database alice founded, with purgeAfterDays days, each knowing the others. */
async function replicas(n: number, days = 2): Promise<Replica[]> {
  const first = newAdapter();
  const founder = await alice.openDatabase(first, { now });
  await founder.saveSettings({ purgeAfterDays: days });
  const all: Replica[] = [{ db: founder, adapter: first }];
  for (let r = 1; r < n; r++) {
    const adapter = newAdapter();
    await founder.createReplica(adapter);
    all.push({ db: await alice.openDatabase(adapter, { now }), adapter });
  }
  for (const replica of all.slice(1)) {
    await replica.db.pullFrom(founder);
  }
  return all;
}

const docRows = (replica: Replica): DocumentEnvelope[] => replica.adapter.allDocuments().filter((doc) => doc.kind === "document");

describe("purge", () => {
  it("removes a tombstone and its entries once it is older than purgeAfterDays here, and raises the horizon", async () => {
    const [a] = (await replicas(1)) as [Replica];
    const kept = await a.db.create({ n: 1 });
    const gone = await a.db.create({ n: 2 });
    hours(1);
    await gone.delete();
    const deleteSeq = a.adapter.lastSeq();
    hours(47);
    // Not yet two days.
    expect(await a.db.purge()).toMatchObject({ tombstones: 0 });
    expect(a.adapter.getDocument(gone.id)?.deleted).toBe(true);
    hours(2);
    const result = await a.db.purge();
    expect(result.tombstones).toBe(1);
    expect(result.horizon).toBe(deleteSeq);
    expect(a.adapter.getDocument(gone.id)).toBeUndefined();
    expect(a.adapter.inner.changesFor(gone.id)).toEqual([]);
    expect(await a.db.get(kept.id)).toBeDefined();
    expect(await a.db.syncState()).toEqual({ stale: false, purgedThrough: deleteSeq, rewound: false, retired: false });
  });

  it("compacts the change log to one entry per stored row, and never lowers lastSeq", async () => {
    const [a] = (await replicas(1)) as [Replica];
    const doc = await a.db.create({ n: 1 });
    for (let n = 2; n <= 5; n++) {
      hours(1);
      doc.content.n = n;
      await doc.save();
    }
    const last = a.adapter.lastSeq();
    expect(a.adapter.inner.changesFor(doc.id)).toHaveLength(5);
    const result = await a.db.purge();
    expect(result.entries).toBeGreaterThanOrEqual(4);
    expect(a.adapter.inner.changesFor(doc.id).map((entry) => entry.seq)).toEqual([last]);
    const ids = a.adapter.changesSince(0).map((entry) => entry.docId);
    expect(new Set(ids).size).toBe(ids.length);
    // The newest entries removed by a purge don't give their numbers back.
    hours(1);
    await doc.delete();
    const deleted = a.adapter.lastSeq();
    hours(72);
    await a.db.purge();
    expect(a.adapter.lastSeq()).toBe(deleted);
    hours(1);
    await a.db.create({ n: 9 });
    expect(a.adapter.lastSeq()).toBe(deleted + 1);
  });

  it("counts a tombstone's age from when this replica recorded it, not when it was written", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    hours(1);
    await doc.delete();
    // b hears of the delete three days later.
    hours(72);
    await b.db.pullFrom(a.db);
    expect((await b.db.purge()).tombstones).toBe(0);
    hours(49);
    expect((await b.db.purge()).tombstones).toBe(1);
  });

  it("keeps a tombstone that is in a conflict", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    hours(1);
    await doc.delete();
    const onB = (await b.db.get<{ n: number }>(doc.id)) as NonNullable<Awaited<ReturnType<typeof b.db.get<{ n: number }>>>>;
    onB.content.n = 2;
    await onB.save();
    await a.db.pullFrom(b.db);
    expect(a.adapter.conflictRows(doc.id).length + (a.adapter.getDocument(doc.id)?.deleted === true ? 0 : 1)).toBeGreaterThan(0);
    hours(24 * 10);
    await a.db.purge();
    expect(docRows(a).filter((row) => row.id === doc.id || row.conflictOf === doc.id)).toHaveLength(2);
  });

  it("is admin only, needs level 4, and needs an adapter that can remove entries", async () => {
    const [a] = (await replicas(1)) as [Replica];
    await a.db.saveSettings({ purgeAfterDays: 1 });
    const acl = await a.db.getAcl();
    acl.readers = ["alice", "bob"];
    await acl.save();
    await expectCode((await bob.openDatabase(a.adapter, { now })).purge(), "ACCESS_DENIED");

    a.adapter.removeChanges = undefined;
    expect((await expectCode(a.db.purge(), "NOT_SUPPORTED")).message).toContain("changesFor and removeChanges");

    const three = await alice.openDatabase(newAdapter(level3Adapter), { now });
    expect((await expectCode(three.purge(), "NOT_SUPPORTED")).message).toContain("raiseLevel");
  });
});

describe("staleness", () => {
  /** a, b and c; c misses a delete, and a and b purge it. */
  async function purgedWhileAway(): Promise<{ a: Replica; b: Replica; c: Replica; id: string }> {
    const [a, b, c] = (await replicas(3)) as [Replica, Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    await c.db.pullFrom(a.db);
    hours(1);
    await doc.delete();
    await b.db.pullFrom(a.db);
    await a.db.pullFrom(b.db);
    hours(24 * 3);
    expect((await a.db.purge()).tombstones).toBe(1);
    expect((await b.db.purge()).tombstones).toBe(1);
    return { a, b, c, id: doc.id };
  }

  it("refuses the classic resurrection: an old replica's copy of a purged document never comes back", async () => {
    const { a, c, id } = await purgedWhileAway();
    expect((await c.db.get(id))?.deleted).toBe(false);

    // a pulling from c: c can't show it has a's purged deletions.
    const before = a.adapter.allDocuments();
    const refused = await expectCode(a.db.pullFrom(c.db), "STALE_REPLICA");
    expect(refused.message).toContain(`Replica ${JSON.stringify(c.db.instanceId)} is stale`);
    expect(refused.message).toContain("doesn't prove a deletion is missing");
    expect(a.adapter.allDocuments()).toEqual(before);
    expect(await a.db.get(id)).toBeUndefined();
    expect((await a.db.syncState()).stale).toBe(false);

    // c pulling from a: c finds itself stale and takes no more writes.
    const stale = await expectCode(c.db.pullFrom(a.db), "STALE_REPLICA");
    expect(stale.message).toContain("This replica is stale");
    expect(stale.message).toContain("doesn't prove a deletion is missing, only that it can't be shown present");
    expect(await c.db.syncState()).toEqual({ stale: true, staleSource: a.db.instanceId, purgedThrough: 0, rewound: false, retired: false });
    await expectCode(c.db.create({ n: 2 }), "READ_ONLY");
    const doc = await c.db.get<{ n: number }>(id);
    await expectCode((doc as NonNullable<typeof doc>).delete(), "READ_ONLY");
    await expectCode(c.db.saveSettings({ purgeAfterDays: 5 }), "READ_ONLY");
    await expectCode(c.db.registerReplica(), "READ_ONLY");
  });

  it("is cleared by a pull from a replica that still holds the deletion", async () => {
    const [a, b, c, d] = (await replicas(4)) as [Replica, Replica, Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    for (const replica of [b, c, d]) {
      await replica.db.pullFrom(a.db);
    }
    hours(1);
    await doc.delete();
    await d.db.pullFrom(a.db);
    hours(24 * 3);
    await a.db.purge();
    await expectCode(c.db.pullFrom(a.db), "STALE_REPLICA");
    // d still holds the tombstone and covers a's purge.
    await c.db.pullFrom(d.db);
    expect(await c.db.syncState()).toMatchObject({ stale: false });
    expect((await c.db.get(doc.id))?.deleted ?? true).toBe(true);
    await c.db.pullFrom(a.db);
    await c.db.create({ n: 2 });
    // b never saw the delete either, and c now carries a's purge horizon.
    await expectCode(b.db.pullFrom(c.db), "STALE_REPLICA");
  });

  it("lets a new replica from a ticket fill itself after a purge, and take over the purge horizons", async () => {
    const { a, b } = await purgedWhileAway();
    const ticket = JSON.parse(JSON.stringify(await a.db.registerReplica())) as ReplicaTicket;
    const fresh = newAdapter();
    const d = await alice.openDatabase(fresh, { now, replicaOf: ticket });
    await d.pullFrom(a.db);
    expect(JSON.parse(fresh.getLocal("horizons") ?? "{}")).toEqual(JSON.parse(a.adapter.getLocal("horizons") ?? "{}"));
    await b.db.pullFrom(a.db);
    await d.pullFrom(b.db);
    expect(await d.syncState()).toMatchObject({ stale: false });
  });

  it("takes a source's knowledge only from the last batch of a pull", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    hours(1);
    await a.db.create({ n: 2 });
    const deleted = await a.db.get(doc.id);
    await (deleted as NonNullable<typeof deleted>).delete();
    // b takes one batch of two, holding the new document but not the deletion.
    await b.db.checkPeer(await a.db.syncHello());
    const first = await b.db.applyChanges(await a.db.exportChanges({ since: await b.db.syncPosition(a.db.instanceId), limit: 1 }));
    expect(first.hasMore).toBe(true);
    expect((await b.db.replicas()).find((replica) => replica.instanceId === a.db.instanceId)?.knownThrough).toBe(first.toSeq);
    hours(24 * 3);
    expect((await a.db.purge()).tombstones).toBe(1);
    // So b can't claim to have the purged deletion, and its old copy can't come back.
    await expectCode(b.db.pullFrom(a.db), "STALE_REPLICA");
    await expectCode(a.db.pullFrom(b.db), "STALE_REPLICA");
    expect(await a.db.get(doc.id)).toBeUndefined();
  });

  it("shows how far each replica is known, in replicas()", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    const listed = await b.db.replicas();
    expect(listed.find((replica) => replica.instanceId === a.db.instanceId)?.knownThrough).toBe(a.adapter.lastSeq());
    expect(listed.find((replica) => replica.instanceId === b.db.instanceId)?.knownThrough).toBeUndefined();
  });

  it("checks before any batch moves, in checkPeer", async () => {
    const { a, c } = await purgedWhileAway();
    const before = c.adapter.allDocuments();
    await expectCode(c.db.checkPeer(await a.db.syncHello()), "STALE_REPLICA");
    expect(c.adapter.allDocuments()).toEqual(before);
    expect((await c.db.syncState()).stale).toBe(true);
  });
});

describe("export at level 4", () => {
  it("sends every version of a document together, whatever the limit", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    const doc = await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    hours(1);
    const onA = await a.db.get<{ n: number }>(doc.id);
    const onB = await b.db.get<{ n: number }>(doc.id);
    (onA as NonNullable<typeof onA>).content.n = 2;
    (onB as NonNullable<typeof onB>).content.n = 3;
    await (onA as NonNullable<typeof onA>).save();
    await (onB as NonNullable<typeof onB>).save();
    await a.db.pullFrom(b.db);
    expect(a.adapter.conflictRows(doc.id)).toHaveLength(1);
    const batch = await a.db.exportChanges({ since: a.adapter.lastSeq() - 1, limit: 1 });
    expect(batch.documents.map((envelope) => envelope.conflictOf ?? envelope.id)).toEqual([doc.id, doc.id]);
  });
});

describe("settings", () => {
  it("default to 90 days, are saved by admins, and are read by anyone the database admits", async () => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    expect(await db.getSettings()).toEqual({ purgeAfterDays: 90 });
    await db.saveSettings({ purgeAfterDays: 7 });
    expect(await db.getSettings()).toEqual({ purgeAfterDays: 7 });
    expect(adapter.getDocument(settingsDocId(db.databaseId))).toMatchObject({ kind: "system", readers: ["alice"], writers: ["alice"], updatedBy: "alice" });
    const acl = await db.getAcl();
    acl.readers = ["alice", "bob"];
    await acl.save();
    const bobs = await bob.openDatabase(adapter, { now });
    expect(await bobs.getSettings()).toEqual({ purgeAfterDays: 7 });
    await expectCode(bobs.saveSettings({ purgeAfterDays: 8 }), "ACCESS_DENIED");
  });

  it.each([0, 3651, 1.5, "7", null, undefined])("refuses purgeAfterDays %j with TypeError", async (days) => {
    const db = await alice.openDatabase(newAdapter(), { now });
    await expect(db.saveSettings({ purgeAfterDays: days as number })).rejects.toThrow(TypeError);
  });

  it("can't be saved below level 4", async () => {
    const db = await alice.openDatabase(newAdapter(level3Adapter), { now });
    expect(await db.getSettings()).toEqual({ purgeAfterDays: 90 });
    await expectCode(db.saveSettings({ purgeAfterDays: 7 }), "NOT_SUPPORTED");
  });

  it("merge when saved on two replicas at once: the larger wins everywhere", async () => {
    const [a, b] = (await replicas(2, 10)) as [Replica, Replica];
    hours(1);
    await a.db.saveSettings({ purgeAfterDays: 5 });
    await b.db.saveSettings({ purgeAfterDays: 30 });
    await a.db.pullFrom(b.db);
    await b.db.pullFrom(a.db);
    expect(await a.db.getSettings()).toEqual({ purgeAfterDays: 30 });
    expect(await b.db.getSettings()).toEqual({ purgeAfterDays: 30 });
    const id = settingsDocId(a.db.databaseId);
    expect(a.adapter.getDocument(id)).toEqual(b.adapter.getDocument(id));
    // Nothing more moves: both computed the same version.
    const seq = a.adapter.lastSeq();
    await a.db.pullFrom(b.db);
    expect(a.adapter.lastSeq()).toBe(seq);
  });

  it("are checked in a batch", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    hours(1);
    await a.db.saveSettings({ purgeAfterDays: 9 });
    const batch = await a.db.exportChanges({ since: await b.db.syncPosition(a.db.instanceId) });
    const settings = batch.documents.find((doc) => doc.id === settingsDocId(a.db.databaseId)) as DocumentEnvelope;
    const swap = (content: Record<string, unknown>) => ({ ...batch, documents: [{ ...settings, content }] });
    await expectCode(b.db.applyChanges(swap({ purgeAfterDays: 0 })), "INVALID_BATCH");
    await expectCode(b.db.applyChanges(swap({ purgeAfterDays: 9, later: true })), "UPGRADE_REQUIRED");
  });
});

describe("system document merges", () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const version = (clock: VectorClock, content: Record<string, unknown>, at: string, on: string): DocumentEnvelope => ({
    id: "r",
    parentId: "r",
    kind: "system",
    vectorClock: clock,
    deleted: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "alice",
    updatedAt: at,
    updatedBy: "alice",
    updatedOn: on,
    readers: ["alice"],
    writers: ["alice"],
    content: content as DocumentEnvelope["content"],
    fieldTypes: {},
  });
  // A version's content and stamps follow from its clock, as for real
  // versions: one clock is one version, and later versions have later stamps.
  const stamp = (own: number, others: number) => `2026-01-01T${String(own).padStart(2, "0")}:${String(others).padStart(2, "0")}:00.000Z`;
  const registration = fc
    .record({ ownWrites: fc.integer({ min: 1, max: 4 }), otherWrites: fc.integer({ min: 0, max: 4 }) })
    .map(({ ownWrites, otherWrites }) =>
      version(
        { [owner]: ownWrites, ...(otherWrites > 0 ? { [other]: otherWrites } : {}) },
        // Only another replica's admin retires it; the replica writes its own maxLevel.
        { instanceId: owner, status: otherWrites > 0 ? "retired" : "active", introducedBy: null, introducedAt: "2026-01-01T00:00:00.000Z", maxLevel: 2 + ownWrites },
        stamp(ownWrites, otherWrites),
        otherWrites > ownWrites ? other : owner,
      ),
    );
  const settings = fc
    .record({ a: fc.integer({ min: 1, max: 4 }), b: fc.nat(4) })
    .map(({ a, b }) =>
      version({ [owner]: a, ...(b > 0 ? { [other]: b } : {}) }, { purgeAfterDays: 1 + ((a * 7 + b * 13) % 3650) }, stamp(a, b), b > a ? other : owner),
    );

  it.each([
    ["registrations", registration, mergeRegistrationContent],
    ["settings", settings, mergeSettingsContent],
  ] as const)("merge %s commutatively, associatively and idempotently", (_name, arbitrary, content) => {
    const m = (x: DocumentEnvelope, y: DocumentEnvelope) => mergeSystemVersions(x, y, content);
    fc.assert(
      fc.property(arbitrary, arbitrary, arbitrary, (x, y, z) => {
        expect(m(x, y)).toEqual(m(y, x));
        expect(m(m(x, y), z)).toEqual(m(x, m(y, z)));
        expect(m(x, x)).toEqual(x);
        expect(["after", "equal"]).toContain(compare(m(x, y).vectorClock, x.vectorClock));
      }),
    );
  });

  it("keeps a registration retired if either version is, with the replica's own fields from its latest write", () => {
    const own = version({ [owner]: 3 }, { instanceId: owner, status: "active", maxLevel: 4 }, "2026-01-01T00:01:00.000Z", owner);
    const retired = version({ [owner]: 2, [other]: 1 }, { instanceId: owner, status: "retired", maxLevel: 3 }, "2026-01-01T00:02:00.000Z", other);
    expect(mergeRegistrationContent(own, retired)).toEqual({ instanceId: owner, status: "retired", maxLevel: 4 });
    expect(compareStamps(own, retired)).toBeLessThan(0);
  });

  it("merges a registration written on two replicas at once, in the engine", async () => {
    const [a, b] = (await replicas(2)) as [Replica, Replica];
    const id = registrationDocId(a.db.databaseId, b.db.instanceId);
    // Another engine retires b on a, while b records its maxLevel again
    // after a rollback: two concurrent versions of b's registration.
    const onA = a.adapter.getDocument(id) as DocumentEnvelope;
    hours(1);
    const retired = {
      ...onA,
      vectorClock: { ...onA.vectorClock, [a.db.instanceId]: (onA.vectorClock[a.db.instanceId] ?? 0) + 1 },
      updatedAt: now().toISOString(),
      updatedBy: "alice",
      updatedOn: a.db.instanceId,
      content: { ...onA.content, status: "retired" },
    };
    a.adapter.putDocument(retired);
    a.adapter.appendChange({ docId: id, vectorClock: retired.vectorClock, op: "put", instanceId: a.db.instanceId, updatedBy: "alice", timestamp: retired.updatedAt, suspect: false, suspectReason: null });
    const onB = b.adapter.getDocument(id) as DocumentEnvelope;
    b.adapter.putDocument({ ...onB, content: { ...onB.content, maxLevel: 3 } });
    hours(1);
    await alice.openDatabase(b.adapter, { now });
    await b.db.pullFrom(a.db);
    expect(b.adapter.getDocument(id)?.content).toMatchObject({ status: "retired", maxLevel: 4 });
  });
});

describe("raiseLevel", () => {
  it("raises a level-3 database with no other replicas to level 4, for every Database of the storage", async () => {
    const adapter = newAdapter(level3Adapter);
    const db = await alice.openDatabase(adapter, { now });
    const other = await alice.openDatabase(adapter, { now });
    const doc = await db.create({ n: 1 });
    const versionBefore = doc.version;
    hours(1);
    expect(await db.raiseLevel()).toBe(4);
    expect(db.level).toBe(4);
    expect(adapter.getDocument(databaseDocId(db.databaseId))?.content["level"]).toBe(4);
    expect(adapter.marks).toEqual([4]);
    expect((await other.get(doc.id))?.version).not.toBe(versionBefore);
    expect((await other.exportChanges()).format).toBe(3);
    await other.saveSettings({ purgeAfterDays: 3 });
    expect(await db.raiseLevel()).toBe(4);
  });

  it("refuses a database with other replicas, below level 3, and non-admins", async () => {
    const adapter = newAdapter(level3Adapter);
    const db = await alice.openDatabase(adapter, { now });
    await expectCode((await alice.openDatabase(newAdapter(level2Adapter), { now })).raiseLevel(), "NOT_SUPPORTED");
    const acl = await db.getAcl();
    acl.readers = ["alice", "bob"];
    await acl.save();
    await expectCode((await bob.openDatabase(adapter, { now })).raiseLevel(), "ACCESS_DENIED");
    await db.registerReplica();
    expect((await expectCode(db.raiseLevel(), "NOT_SUPPORTED")).message).toContain("other replicas");
    expect(db.level).toBe(3);
  });
});

describe("hellos and batches at level 4", () => {
  it("need knowledge, horizons and lastSeq in a hello", async () => {
    const [a] = (await replicas(1)) as [Replica];
    const hello = { ...(await a.db.syncHello()) } as Record<string, unknown>;
    expect(parseHello(hello)).toEqual(hello);
    for (const key of ["lastSeq", "knowledge", "horizons"]) {
      const { [key]: _gone, ...rest } = hello;
      expect(() => parseHello(rest)).toThrow(expect.objectContaining({ code: "INVALID_HANDSHAKE" }));
    }
    expect(() => parseHello({ ...hello, knowledge: { notAnId: 1 } })).toThrow(expect.objectContaining({ code: "INVALID_HANDSHAKE" }));
    expect(() => parseHello({ ...hello, horizons: { [a.db.instanceId]: -1 } })).toThrow(expect.objectContaining({ code: "INVALID_HANDSHAKE" }));
  });

  it("need format 3 with knowledge and horizons in a batch", async () => {
    const [a] = (await replicas(1)) as [Replica];
    const batch = { ...(await a.db.exportChanges()) } as Record<string, unknown>;
    expect(() => parseBatch(batch)).not.toThrow();
    for (const change of [{ format: 2 }, { knowledge: undefined }, { horizons: { x: 1 } }, { knowledge: { [a.db.instanceId]: 1.5 } }, { level: 3 }]) {
      const changed: Record<string, unknown> = { ...batch, ...change };
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) {
          delete changed[key];
        }
      }
      expect(() => parseBatch(changed)).toThrow(expect.objectContaining({ code: "INVALID_BATCH" }));
    }
  });
});

describe("checkpoints", () => {
  const empty: Checkpoints = { closed: [] };

  it("keep one window an hour, and never go back in time", () => {
    let points = noteCheckpoint(empty, 3, 0);
    points = noteCheckpoint(points, 5, 30 * 60_000);
    expect(points).toEqual({ closed: [], open: { seq: 5, at: 30 * 60_000, since: 0 } });
    points = noteCheckpoint(points, 9, HOUR_MS);
    expect(points).toEqual({ closed: [[5, 30 * 60_000]], open: { seq: 9, at: HOUR_MS, since: HOUR_MS } });
    points = noteCheckpoint(points, 10, HOUR_MS - 5000);
    expect(points.open).toEqual({ seq: 10, at: HOUR_MS, since: HOUR_MS });
  });

  it("give the newest position recorded by a cutoff", () => {
    const points: Checkpoints = { closed: [[5, 10], [9, 20], [12, 30]], open: { seq: 15, at: 40, since: 35 } };
    expect([0, 9, 10, 25, 39, 40].map((cutoff) => purgeCandidate(points, cutoff))).toEqual([0, 0, 5, 9, 12, 15]);
    expect(trimCheckpoints(points, 25).closed).toEqual([[9, 20], [12, 30]]);
  });

  it("stay at most about MAX_CHECKPOINTS, only ever making entries look newer", () => {
    let points = empty;
    for (let n = 1; n <= MAX_CHECKPOINTS + 50; n++) {
      points = noteCheckpoint(points, n, n * HOUR_MS);
    }
    expect(points.closed.length).toBeLessThanOrEqual(MAX_CHECKPOINTS);
    // Every entry's recorded time is at or after when it really was recorded.
    for (let seq = 1; seq <= MAX_CHECKPOINTS + 49; seq++) {
      const covering = points.closed.find(([upTo]) => upTo >= seq);
      expect(covering === undefined || covering[1] >= seq * HOUR_MS).toBe(true);
    }
  });

  it("say what isn't covered", () => {
    expect(uncovered({ a: 5, b: 1 }, { a: 5, b: 3, c: 1, me: 9 }, ["me"])).toEqual([
      ["b", 1, 3],
      ["c", 0, 1],
    ]);
    expect(DAY_MS).toBe(24 * HOUR_MS);
  });
});
