import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import { SUPPORTED_LEVELS, VERSION } from "../src/engine.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import { parseHello, syncLevel, type SyncHello } from "../src/handshake.js";
import { newId } from "../src/ids.js";
import * as api from "../src/index.js";
import { sync, type ChangeBatch } from "../src/replication.js";
import { Session } from "../src/session.js";
import { databaseDocId, registrationDocId } from "../src/system-docs.js";
import { conflictVersion, documentVersion } from "../src/version.js";
import { TestAdapter, admitEveryone, expectCode, level2Adapter, level3Adapter, seedAdapter } from "./helpers.js";

const alice = Session.withId("alice");
const bob = Session.withId("bob");
const named = Session.named("alice");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);

beforeEach(() => {
  adapters = [];
  time = Date.parse("2026-11-11T12:00:00.000Z");
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

/** A new adapter, or a copy of a seed: a level-1 database made by 0.3.0, a level-2 one made by 0.5.0, or a level-3 one made by 0.6.0. */
function newAdapter(seed?: "alice" | "other" | "level 2" | "level 3"): TestAdapter {
  const adapter =
    seed === undefined ? new TestAdapter() : seed === "level 2" ? level2Adapter() : seed === "level 3" ? level3Adapter() : seedAdapter(seed);
  adapters.push(adapter);
  return adapter;
}

/**
 * Two replicas of a database alice founded, at level 4 (made by this
 * engine), level 3 (made by 0.6.0), both admitting everyone, as a database
 * below level 3 does, or level 2 (made by 0.5.0).
 */
async function pair(level: 2 | 3 | 4 = 4): Promise<{ a: Database; b: Database; aAdapter: TestAdapter; bAdapter: TestAdapter }> {
  const aAdapter = newAdapter(level === 2 ? "level 2" : level === 3 ? "level 3" : undefined);
  const bAdapter = newAdapter();
  const a = await alice.openDatabase(aAdapter, { now });
  if (level >= 3) {
    await admitEveryone(a);
  }
  time += 1000;
  await a.createReplica(bAdapter);
  const b = await alice.openDatabase(bAdapter, { now });
  return { a, b, aAdapter, bAdapter };
}

/** Rewrites the stored database document's content in place, as another engine might have. */
function setDatabaseContent(adapter: TestAdapter, db: Database, change: (content: Record<string, unknown>) => void): void {
  const stored = adapter.getDocument(databaseDocId(db.databaseId)) as DocumentEnvelope;
  const content: Record<string, unknown> = { ...stored.content };
  change(content);
  adapter.putDocument({ ...stored, content: content as DocumentEnvelope["content"] });
}

/** Records the keys of local state written from now on. */
function localWrites(adapter: TestAdapter): string[] {
  const keys: string[] = [];
  const setLocal = adapter.setLocal.bind(adapter);
  adapter.setLocal = (key, value) => {
    keys.push(key);
    setLocal(key, value);
  };
  return keys;
}

describe("levels", () => {
  it("supports levels 1 to 4, and exports them", () => {
    expect(SUPPORTED_LEVELS).toEqual({ min: 1, max: 4 });
    expect(Object.isFrozen(SUPPORTED_LEVELS)).toBe(true);
    expect(api.SUPPORTED_LEVELS).toBe(SUPPORTED_LEVELS);
    expect(api.VERSION).toBe(VERSION);
  });

  it("creates databases at level 4, writing the level, marking the adapter and recording maxLevel", async () => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    expect(db.level).toBe(4);
    expect(adapter.getDocument(databaseDocId(db.databaseId))?.content["level"]).toBe(4);
    expect(adapter.marks).toEqual([4]);
    expect(adapter.getDocument(registrationDocId(db.databaseId, db.instanceId))?.content["maxLevel"]).toBe(4);
    // Opening again writes nothing.
    const seq = adapter.lastSeq();
    await alice.openDatabase(adapter, { now });
    expect(adapter.lastSeq()).toBe(seq);
    expect(adapter.marks).toEqual([4]);
  });

  it("creates a database through an adapter without markLevel", async () => {
    const adapter = newAdapter();
    adapter.markLevel = undefined;
    expect((await alice.openDatabase(adapter, { now })).level).toBe(4);
  });

  it.each([
    ["level 2", 2, "0.5.0"],
    ["level 3", 3, "0.6.0"],
  ] as const)("opens a %s database (level %i, made by %s) at its level, recording only this engine's maxLevel", async (seed, level, _release) => {
    const adapter = newAdapter(seed);
    const before = adapter.allDocuments();
    const localBefore = ["knowledge", "horizons", "checkpoints", "stale"].map((key) => adapter.getLocal(key));
    const db = await alice.openDatabase(adapter, { now });
    expect(db.level).toBe(level);
    const registrationId = registrationDocId(db.databaseId, db.instanceId);
    expect(before.find((doc) => doc.id === registrationId)?.content["maxLevel"]).toBe(level);
    expect(adapter.puts.map((doc) => doc.id)).toEqual([registrationId]);
    expect(adapter.getDocument(registrationId)?.content["maxLevel"]).toBe(4);
    // Nothing else changed: no mark, the ACL as it was, and no purge state.
    expect(adapter.marks).toEqual([]);
    expect(adapter.allDocuments().filter((doc) => doc.id !== registrationId)).toEqual(before.filter((doc) => doc.id !== registrationId));
    expect(["knowledge", "horizons", "checkpoints", "stale"].map((key) => adapter.getLocal(key))).toEqual(localBefore);
  });

  it("opens a database with level 1 written explicitly", async () => {
    const adapter = newAdapter("alice");
    const db = await named.openDatabase(adapter, { now });
    setDatabaseContent(adapter, db, (content) => {
      content["level"] = 1;
    });
    expect((await named.openDatabase(adapter, { now })).level).toBe(1);
  });

  it("refuses to open a database above level 4 with UPGRADE_REQUIRED", async () => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    setDatabaseContent(adapter, db, (content) => {
      content["level"] = 5;
    });
    const error = await expectCode(alice.openDatabase(adapter, { now }), "UPGRADE_REQUIRED");
    expect(error.message).toContain("level 5");
    await expectCode(Session.anonymous().openDatabase(adapter), "UPGRADE_REQUIRED");
  });

  it.each([0, -1, 1.5, "2", null, true])("refuses a stored level %j as INVALID_DATABASE", async (level) => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    setDatabaseContent(adapter, db, (content) => {
      content["level"] = level;
    });
    await expectCode(alice.openDatabase(adapter, { now }), "INVALID_DATABASE");
  });

  it("reads level fresh on each access", async () => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    setDatabaseContent(adapter, db, (content) => {
      content["level"] = 5;
    });
    expect(db.level).toBe(5);
  });
});

describe("describeDatabase", () => {
  it("reads the IDs and level of a database at each level, with no session and writing nothing", async () => {
    const four = newAdapter();
    const db = await alice.openDatabase(four, { now });
    for (const [adapter, level] of [
      [newAdapter("alice"), 1],
      [newAdapter("level 2"), 2],
      [newAdapter("level 3"), 3],
      [four, 4],
    ] as const) {
      const seq = adapter.lastSeq();
      const puts = adapter.puts.length;
      const described = api.describeDatabase(adapter);
      expect(described).toEqual({ databaseId: adapter.getLocal("databaseId"), instanceId: adapter.getLocal("instanceId"), level });
      expect(Object.isFrozen(described)).toBe(true);
      expect([adapter.lastSeq(), adapter.puts.length]).toEqual([seq, puts]);
    }
    expect(api.describeDatabase(four)?.databaseId).toBe(db.databaseId);
  });

  it("gives undefined for an empty adapter, and refuses what openDatabase refuses", async () => {
    expect(api.describeDatabase(newAdapter())).toBeUndefined();
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    setDatabaseContent(adapter, db, (content) => {
      content["level"] = 5;
    });
    expect(() => api.describeDatabase(adapter)).toThrow(expect.objectContaining({ code: "UPGRADE_REQUIRED" }));
    adapter.hiddenLocalKeys.add("instanceId");
    expect(() => api.describeDatabase(adapter)).toThrow(expect.objectContaining({ code: "INVALID_DATABASE" }));
  });
});

describe("opening by kind of session", () => {
  type State = "empty" | "level 1" | "level 2" | "level 3" | "level 4";
  const sessions: Record<Session["kind"], Session> = { id: alice, named, anonymous: Session.anonymous() };

  async function adapterFor(state: State): Promise<TestAdapter> {
    if (state === "level 1") {
      return newAdapter("alice");
    }
    if (state === "level 2" || state === "level 3") {
      return newAdapter(state);
    }
    const adapter = newAdapter();
    if (state === "level 4") {
      await alice.openDatabase(adapter, { now });
    }
    return adapter;
  }

  it.each<[Session["kind"], State, string | number]>([
    ["id", "empty", 4],
    ["named", "empty", "INVALID_PRINCIPAL"],
    ["anonymous", "empty", "ACCESS_DENIED"],
    ["id", "level 1", "INVALID_PRINCIPAL"],
    ["named", "level 1", 1],
    ["anonymous", "level 1", 1],
    ["id", "level 2", 2],
    ["named", "level 2", "INVALID_PRINCIPAL"],
    ["anonymous", "level 2", 2],
    ["id", "level 3", 3],
    ["named", "level 3", "INVALID_PRINCIPAL"],
    ["anonymous", "level 3", "ACCESS_DENIED"],
    ["id", "level 4", 4],
    ["named", "level 4", "INVALID_PRINCIPAL"],
    // A new database admits only its creator.
    ["anonymous", "level 4", "ACCESS_DENIED"],
  ])("a session with kind %j and a database %s: %j", async (kind, state, outcome) => {
    const adapter = await adapterFor(state);
    const before = { docs: adapter.allDocuments(), changes: adapter.changesSince(0), empty: adapter.isEmpty() };
    const opening = sessions[kind].openDatabase(adapter, { now });
    if (typeof outcome === "number") {
      expect((await opening).level).toBe(outcome);
    } else {
      await expectCode(opening, outcome);
      expect({ docs: adapter.allDocuments(), changes: adapter.changesSince(0), empty: adapter.isEmpty() }).toEqual(before);
    }
  });

  it("says what to do in each refusal", async () => {
    await expect(named.openDatabase(newAdapter())).rejects.toThrow("New databases are at level 4, which identifies users by ID: use Session.withId");
    await expect(alice.openDatabase(newAdapter("alice"))).rejects.toThrow(
      "This database is at level 1 and identifies users by name: open it with Session.named. Raising a database to level 2 is not available yet.",
    );
    await expect(named.openDatabase(await adapterFor("level 2"))).rejects.toThrow(
      "This database is at level 2 and identifies users by ID: open it with Session.withId",
    );
    await expect(named.openDatabase(await adapterFor("level 3"))).rejects.toThrow(
      "This database is at level 3 and identifies users by ID: open it with Session.withId",
    );
    await expect(named.openDatabase(await adapterFor("level 4"))).rejects.toThrow(
      "This database is at level 4 and identifies users by ID: open it with Session.withId",
    );
  });
});

describe("maxLevel in registrations", () => {
  function registration(adapter: TestAdapter, db: Database): DocumentEnvelope {
    return adapter.getDocument(registrationDocId(db.databaseId, db.instanceId)) as DocumentEnvelope;
  }

  it("is written by a new replica on its first open, as the engine, and not again", async () => {
    const { a, aAdapter } = await pair();
    const target = newAdapter();
    await a.createReplica(target);
    const copied = target.getDocument(registrationDocId(a.databaseId, target.getLocal("instanceId") as string)) as DocumentEnvelope;
    expect(Object.hasOwn(copied.content, "maxLevel")).toBe(false);
    expect(aAdapter.getDocument(copied.id)).toEqual(copied);

    // An anonymous open is enough: it is the engine's write.
    time += 1000;
    const c = await Session.anonymous().openDatabase(target, { now });
    expect(registration(target, c)).toMatchObject({ updatedBy: "system", updatedOn: c.instanceId, content: { maxLevel: 4 } });
    const seq = target.lastSeq();
    await alice.openDatabase(target, { now });
    expect(target.lastSeq()).toBe(seq);
  });

  it.each([
    ["an earlier engine's value", 2],
    ["a later engine's value, after a rollback", 5],
  ])("is written again over %s", async (_name, stored) => {
    const adapter = newAdapter();
    const db = await alice.openDatabase(adapter, { now });
    const before = registration(adapter, db);
    adapter.putDocument({ ...before, content: { ...before.content, maxLevel: stored } });
    time += 1000;
    await alice.openDatabase(adapter, { now });
    const after = registration(adapter, db);
    expect(after.content["maxLevel"]).toBe(4);
    expect(after.vectorClock).toEqual({ [db.instanceId]: 2 });
  });

  it("is shown by replicas from the registration, with no hello", async () => {
    const { a, b, aAdapter } = await pair();
    // b holds a's registration, which a wrote with its maxLevel at creation.
    expect((await b.replicas()).map((replica) => replica.maxLevel)).toEqual([4, 4]);
    // a learns b's only by applying b's changes, here without a handshake.
    expect((await a.replicas()).map((replica) => replica.maxLevel)).toEqual([4, undefined]);
    await a.applyChanges(await b.exportChanges({ since: await a.syncPosition(b.instanceId) }));
    expect(aAdapter.getLocal(`peerHello:${b.instanceId}`)).toBeUndefined();
    expect((await a.replicas()).map((replica) => replica.maxLevel)).toEqual([4, 4]);
  });

  it("is refused in a level-1 database's batch as a field it doesn't know", async () => {
    const adapter = newAdapter("alice");
    const a = await named.openDatabase(adapter, { now });
    const target = newAdapter();
    await a.createReplica(target);
    const b = await named.openDatabase(target, { now });
    const id = registrationDocId(a.databaseId, a.instanceId);
    const stored = adapter.getDocument(id) as DocumentEnvelope;
    const forged = { ...stored, vectorClock: { [a.instanceId]: 2 }, content: { ...stored.content, maxLevel: 2 } };
    const batch = await a.exportChanges({ since: await b.syncPosition(a.instanceId) });
    const error = await expectCode(b.applyChanges({ ...batch, documents: [forged] }), "UPGRADE_REQUIRED");
    expect(error.message).toContain('"maxLevel"');
  });
});

describe("version strings", () => {
  it.each([2, 3, 4] as const)("differ at level %i from the other levels' formulas for the same clock, and match across replicas", async (level) => {
    const { a, b } = await pair(level);
    const doc = await a.create({ x: 1 });
    await sync(a, b);
    const onB = await b.get(doc.id);
    expect(onB?.version).toBe(doc.version);
    expect(doc.version).toBe(documentVersion(doc.vectorClock, level));
    for (const other of [1, 2, 3, 4].filter((l) => l !== level)) {
      expect(doc.version).not.toBe(documentVersion(doc.vectorClock, other));
    }
  });

  it("never give a version at one level equal to one at another (property)", () => {
    const key = fc.constantFrom(newId(), newId(), `${newId()}/2`);
    const clock = fc.dictionary(key, fc.nat({ max: 3 }));
    const levels = fc.uniqueArray(fc.constantFrom(1, 2, 3, 4), { minLength: 2, maxLength: 2 });
    fc.assert(
      fc.property(clock, clock, levels, (x, y, [m, n]) => {
        expect(documentVersion(x, m as number)).not.toBe(documentVersion(y, n as number));
        expect(conflictVersion([{ id: "r", vectorClock: x }], m as number)).not.toBe(conflictVersion([{ id: "r", vectorClock: y }], n as number));
      }),
    );
  });
});

describe("batches at the wrong level", () => {
  /** Expects the batch refused with code, applying nothing and leaving the position where it was. */
  async function refusedOn(target: TestAdapter, db: Database, source: Database, batch: unknown, code: string): Promise<CromDBError> {
    const before = { docs: target.allDocuments(), changes: target.changesSince(0), position: await db.syncPosition(source.instanceId) };
    const error = await expectCode(db.applyChanges(batch), code);
    expect({ docs: target.allDocuments(), changes: target.changesSince(0), position: await db.syncPosition(source.instanceId) }).toEqual(before);
    return error;
  }

  async function levelOnePair(): Promise<{ a: Database; b: Database; bAdapter: TestAdapter }> {
    const aAdapter = newAdapter("alice");
    const a = await named.openDatabase(aAdapter, { now });
    const bAdapter = newAdapter();
    await a.createReplica(bAdapter);
    const b = await named.openDatabase(bAdapter, { now });
    await a.create({ x: 1 });
    return { a, b, bAdapter };
  }

  it("sends format 1 at level 1, format 2 at levels 2 and 3, and format 3 at level 4", async () => {
    const one = await levelOnePair();
    expect((await one.a.exportChanges()).format).toBe(1);
    expect(Object.hasOwn(await one.a.exportChanges(), "level")).toBe(false);
    expect(await (await pair(2)).a.exportChanges()).toMatchObject({ format: 2, level: 2, engine: VERSION });
    const three = await (await pair(3)).a.exportChanges();
    expect(three).toMatchObject({ format: 2, level: 3, engine: VERSION });
    expect(Object.hasOwn(three, "knowledge") || Object.hasOwn(three, "horizons")).toBe(false);
    expect(await (await pair(4)).a.exportChanges()).toMatchObject({ format: 3, level: 4, engine: VERSION, horizons: {} });
  });

  it("syncs a level-2 database between two replicas on this engine, at level 2", async () => {
    const { a, b } = await pair(2);
    const doc = await a.create({ x: 1 });
    await sync(a, b);
    expect((await b.get(doc.id))?.content).toEqual({ x: 1 });
    expect([a.level, b.level]).toEqual([2, 2]);
  });

  it("refuses a level-2 batch at a level-3 replica with SYNC_MISMATCH, and a level-3 one at a level-2 replica with UPGRADE_REQUIRED", async () => {
    // At level 4 the format must match the level, so a level-4 batch can't just claim level 3.
    const four = await pair(4);
    const fromFour = await four.a.exportChanges({ since: await four.b.syncPosition(four.a.instanceId) });
    await refusedOn(four.bAdapter, four.b, four.a, { ...fromFour, level: 3 }, "INVALID_BATCH");
    const three = await pair(3);
    const fromThree = await three.a.exportChanges({ since: await three.b.syncPosition(three.a.instanceId) });
    await refusedOn(three.bAdapter, three.b, three.a, { ...fromThree, level: 2 }, "SYNC_MISMATCH");
    const two = await pair(2);
    const error = await refusedOn(
      two.bAdapter,
      two.b,
      two.a,
      { ...(await two.a.exportChanges({ since: await two.b.syncPosition(two.a.instanceId) })), level: 3 },
      "UPGRADE_REQUIRED",
    );
    expect(error.message).toContain("raising a database needs a later engine");
  });

  it("refuses a format-2 batch at a level-1 replica with UPGRADE_REQUIRED", async () => {
    const { a, b, bAdapter } = await levelOnePair();
    const batch = { ...(await a.exportChanges({ since: await b.syncPosition(a.instanceId) })), format: 2, level: 2, engine: "0.5.0" };
    const error = await refusedOn(bAdapter, b, a, batch, "UPGRADE_REQUIRED");
    expect(error.message).toContain("raising a database needs a later engine");
  });

  it("refuses a format-1 batch at a level-2 replica with SYNC_MISMATCH", async () => {
    const { a, b, bAdapter } = await pair(2);
    await a.create({ x: 1 });
    const { level: _level, engine: _engine, ...rest } = await a.exportChanges({ since: await b.syncPosition(a.instanceId) });
    const error = await refusedOn(bAdapter, b, a, { ...rest, format: 1 }, "SYNC_MISMATCH");
    expect(error.message).toContain("level 1");
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["format 2 with level 1", { level: 1 }, "INVALID_BATCH"],
    ["format 2 with level 5", { level: 5 }, "UPGRADE_REQUIRED"],
    ["format 2 with level 0", { level: 0 }, "INVALID_BATCH"],
    ["format 2 with a string level", { level: "2" }, "INVALID_BATCH"],
    ["format 2 without an engine", { engine: undefined }, "INVALID_BATCH"],
    ["format 2 with a long engine", { engine: "x".repeat(101) }, "INVALID_BATCH"],
    ["format 1 with a level", { format: 1 }, "INVALID_BATCH"],
  ])("refuses %s", async (_name, change, code) => {
    const { a, b, bAdapter } = await pair(3);
    await a.create({ x: 1 });
    const batch: Record<string, unknown> = { ...(await a.exportChanges({ since: await b.syncPosition(a.instanceId) })), ...change };
    for (const key of Object.keys(change)) {
      if (batch[key] === undefined) {
        delete batch[key];
      }
    }
    await refusedOn(bAdapter, b, a, batch, code);
  });

  describe("database documents", () => {
    async function batchWithDatabaseDoc(level: unknown): Promise<{ a: Database; b: Database; batch: ChangeBatch; bAdapter: TestAdapter }> {
      const { a, b, aAdapter, bAdapter } = await pair();
      const stored = aAdapter.getDocument(databaseDocId(a.databaseId)) as DocumentEnvelope;
      const batch = await a.exportChanges({ since: await b.syncPosition(a.instanceId) });
      const content: Record<string, unknown> = { ...stored.content, level };
      if (level === undefined) {
        delete content["level"];
      }
      const doc = { ...stored, content } as unknown as DocumentEnvelope;
      return { a, b, bAdapter, batch: JSON.parse(JSON.stringify({ ...batch, documents: [doc] })) as ChangeBatch };
    }

    it("accepts the database document at this replica's level", async () => {
      const { b, batch } = await batchWithDatabaseDoc(4);
      await expect(b.applyChanges(batch)).resolves.toMatchObject({ skipped: 1 });
    });

    it.each<[unknown, string]>([
      [5, "UPGRADE_REQUIRED"],
      [3, "SYNC_MISMATCH"],
      [2, "SYNC_MISMATCH"],
      [1, "SYNC_MISMATCH"],
      [undefined, "SYNC_MISMATCH"],
      [0, "INVALID_BATCH"],
      ["4", "INVALID_BATCH"],
      [2.5, "INVALID_BATCH"],
      [null, "INVALID_BATCH"],
    ])("refuses a database document with level %j as %s, applying nothing", async (level, code) => {
      const { a, b, batch, bAdapter } = await batchWithDatabaseDoc(level);
      await refusedOn(bAdapter, b, a, batch, code);
    });

    it("refuses a raise in a format-1 batch at level 1 with UPGRADE_REQUIRED", async () => {
      const { a, b, bAdapter } = await levelOnePair();
      const stored = bAdapter.getDocument(databaseDocId(a.databaseId)) as DocumentEnvelope;
      const raised = { ...stored, vectorClock: { ...stored.vectorClock, [a.instanceId]: 9 }, content: { ...stored.content, level: 2 } };
      const batch = await a.exportChanges({ since: await b.syncPosition(a.instanceId) });
      const error = await refusedOn(bAdapter, b, a, { ...batch, documents: [raised] }, "UPGRADE_REQUIRED");
      expect(error.message).toContain("raises the database to level 2");
    });
  });
});

describe("syncHello", () => {
  it("says what this replica is, as plain JSON", async () => {
    const { a, b, aAdapter } = await pair();
    const hello = await a.syncHello();
    expect(hello).toEqual({
      protocol: 1,
      databaseId: a.databaseId,
      instanceId: a.instanceId,
      engine: VERSION,
      level: 4,
      levels: { min: 1, max: 4 },
      conflictPolicy: "default@1",
      unicodeVersion: "17.0",
      lastSeq: aAdapter.lastSeq(),
      knowledge: { [b.instanceId]: expect.any(Number) as number },
      horizons: {},
    });
    expect(JSON.parse(JSON.stringify(hello))).toEqual(hello);
    expect(Object.isFrozen(hello) && Object.isFrozen(hello.levels)).toBe(true);
    // Below level 4 there is no purge state to tell.
    const { a: three } = await pair(3);
    const old = await three.syncHello();
    expect(["lastSeq", "knowledge", "horizons"].filter((key) => Object.hasOwn(old, key))).toEqual([]);
  });

  it("is admin only", async () => {
    const { aAdapter } = await pair();
    await expectCode((await bob.openDatabase(aAdapter)).syncHello(), "ACCESS_DENIED");
  });
});

describe("checkPeer", () => {
  it("accepts a peer's hello, returns the level, and records the peer's highest level", async () => {
    const { a, b, aAdapter } = await pair();
    const hello = JSON.parse(JSON.stringify(await b.syncHello())) as SyncHello;
    expect(await a.checkPeer(hello)).toEqual({ level: 4 });
    const stored = JSON.parse(aAdapter.getLocal(`peerHello:${b.instanceId}`) as string) as unknown;
    expect(stored).toEqual({ maxLevel: 4, engine: VERSION, checkedAt: now().toISOString() });
    const listed = await a.replicas();
    expect(listed.map((replica) => replica.maxLevel)).toEqual([4, 4]);
  });

  it("shows maxLevel at level 1 only for this replica and peers it has checked", async () => {
    const aAdapter = newAdapter("alice");
    const a = await named.openDatabase(aAdapter, { now });
    const bAdapter = newAdapter();
    await a.createReplica(bAdapter);
    const b = await named.openDatabase(bAdapter, { now });
    expect((await b.replicas()).map((replica) => [replica.instanceId, replica.maxLevel])).toEqual([
      [a.instanceId, undefined],
      [b.instanceId, 4],
    ]);
    // Seen by anyone who can open the database, as replicas is.
    await b.checkPeer(await a.syncHello());
    expect((await (await Session.anonymous().openDatabase(bAdapter)).replicas()).map((replica) => replica.maxLevel)).toEqual([4, 4]);
  });

  it("is done by pullFrom and sync, both ways", async () => {
    const { a, b, aAdapter, bAdapter } = await pair();
    await sync(a, b);
    expect(aAdapter.getLocal(`peerHello:${b.instanceId}`)).toBeDefined();
    expect(bAdapter.getLocal(`peerHello:${a.instanceId}`)).toBeDefined();
  });

  it("takes undefined as a peer with no handshake, at level 1, recording nothing", async () => {
    const aAdapter = newAdapter("alice");
    const a = await named.openDatabase(aAdapter, { now });
    const writes = localWrites(aAdapter);
    expect(await a.checkPeer(undefined)).toEqual({ level: 1 });
    expect(writes).toEqual([]);
  });

  it.each([2, 3, 4] as const)("refuses a peer with no handshake at level %i: it must be upgraded", async (level) => {
    const { a } = await pair(level);
    const error = await expectCode(a.checkPeer(undefined), "UPGRADE_REQUIRED");
    expect(error.message).toContain("the peer, which has no handshake, supports levels up to 1; it must be upgraded");
  });

  it("is admin only, even for undefined", async () => {
    const { a, aAdapter } = await pair();
    const bobs = await bob.openDatabase(aAdapter);
    await expectCode(bobs.checkPeer(undefined), "ACCESS_DENIED");
    await expectCode(bobs.checkPeer(await a.syncHello()), "ACCESS_DENIED");
  });

  it("refuses mismatches with SYNC_MISMATCH, recording nothing", async () => {
    const { a, b, aAdapter } = await pair();
    const hello = await b.syncHello();
    const writes = localWrites(aAdapter);
    const cases: [Partial<SyncHello>, RegExp][] = [
      [{ databaseId: newId() }, /database ID/],
      [{ instanceId: a.instanceId }, /is this replica/],
      [{ instanceId: newId() }, /does not know/],
      [{ conflictPolicy: "other@1" }, /conflict policy/],
      [{ unicodeVersion: "16.0" }, /Unicode version/],
    ];
    for (const [change, message] of cases) {
      const error = await expectCode(a.checkPeer({ ...hello, ...change }), "SYNC_MISMATCH");
      expect(error.message).toMatch(message);
    }
    expect(writes).toEqual([]);
  });

  it("refuses a peer whose registration here is retired", async () => {
    const { a, b, aAdapter } = await pair();
    const id = registrationDocId(a.databaseId, b.instanceId);
    const stored = aAdapter.getDocument(id) as DocumentEnvelope;
    aAdapter.putDocument({ ...stored, content: { ...stored.content, status: "retired" } });
    const error = await expectCode(a.checkPeer(await b.syncHello()), "SYNC_MISMATCH");
    expect(error.message).toContain("not active");
  });

  it("refuses a peer at a level this engine can't handle with UPGRADE_REQUIRED, saying this replica must be upgraded", async () => {
    const { a, b } = await pair();
    const hello = { ...(await b.syncHello()), level: 5, levels: { min: 1, max: 5 } };
    const error = await expectCode(a.checkPeer(hello), "UPGRADE_REQUIRED");
    expect(error.message).toContain("this replica must be upgraded");
    // A peer whose engine supports more, at this level, is fine.
    expect(await a.checkPeer({ ...hello, level: 4 })).toEqual({ level: 4 });
    expect((await a.replicas()).find((replica) => replica.instanceId === b.instanceId)?.maxLevel).toBe(5);
  });

  it("refuses a peer at a lower level with SYNC_MISMATCH, recording nothing", async () => {
    const { a, b, aAdapter } = await pair();
    const writes = localWrites(aAdapter);
    const error = await expectCode(a.checkPeer({ ...(await b.syncHello()), level: 2 }), "SYNC_MISMATCH");
    expect(error.message).toContain("at level 2, but this replica is at level 4");
    expect(writes).toEqual([]);
  });

  it("refuses a peer at a higher level that this engine supports with UPGRADE_REQUIRED: it can't raise", async () => {
    const aAdapter = newAdapter("alice");
    const a = await named.openDatabase(aAdapter, { now });
    const bAdapter = newAdapter();
    await a.createReplica(bAdapter);
    const b = await named.openDatabase(bAdapter, { now });
    const error = await expectCode(a.checkPeer({ ...(await b.syncHello()), level: 2 }), "UPGRADE_REQUIRED");
    expect(error.message).toBe(
      `Replica ${JSON.stringify(b.instanceId)} has this database at level 2, but this replica is at level 1, and raising a database needs a later engine; this replica must be upgraded`,
    );
  });

  it("refuses a level-3 peer from a level-2 replica with UPGRADE_REQUIRED: it can't raise", async () => {
    const { a, b } = await pair(2);
    const error = await expectCode(a.checkPeer({ ...(await b.syncHello()), level: 3 }), "UPGRADE_REQUIRED");
    expect(error.message).toContain("has this database at level 3, but this replica is at level 2, and raising a database needs a later engine");
  });

  it("stops pullFrom before any batch when the check fails", async () => {
    const { a, b, bAdapter } = await pair();
    await a.create({ x: 1 });
    b.checkPeer = async () => {
      throw new CromDBError("UPGRADE_REQUIRED", "test");
    };
    const before = bAdapter.allDocuments();
    await expectCode(b.pullFrom(a), "UPGRADE_REQUIRED");
    expect(bAdapter.allDocuments()).toEqual(before);
  });

  it("refuses a pull from a replica of another database before any batch", async () => {
    const { b } = await pair();
    const other = await alice.openDatabase(newAdapter(), { now });
    const error = await expectCode(b.pullFrom(other), "SYNC_MISMATCH");
    expect(error.message).toContain("database ID");
  });
});

describe("parseHello", () => {
  const valid = (): Record<string, unknown> => ({
    protocol: 1,
    databaseId: newId(),
    instanceId: newId(),
    engine: "0.3.0",
    level: 1,
    levels: { min: 1, max: 1 },
    conflictPolicy: "default@1",
    unicodeVersion: "17.0",
  });

  it("returns a frozen copy, ignoring fields it doesn't know", () => {
    const base = valid();
    const hello = parseHello({ ...base, later: { anything: true } });
    expect(hello).toEqual(base);
    expect(Object.hasOwn(hello, "later")).toBe(false);
    expect(Object.isFrozen(hello)).toBe(true);
  });

  it.each<[string, (hello: Record<string, unknown>) => unknown]>([
    ["not an object", () => "hello"],
    ["null", () => null],
    ["an array", () => []],
    ["a Map", (hello) => new Map(Object.entries(hello))],
    ["no protocol", ({ protocol: _protocol, ...hello }) => hello],
    ["protocol 0", (hello) => ({ ...hello, protocol: 0 })],
    ["protocol \"1\"", (hello) => ({ ...hello, protocol: "1" })],
    ["a databaseId that isn't a UUID", (hello) => ({ ...hello, databaseId: "db" })],
    ["no instanceId", ({ instanceId: _id, ...hello }) => hello],
    ["an empty engine", (hello) => ({ ...hello, engine: "" })],
    ["a long engine", (hello) => ({ ...hello, engine: "x".repeat(101) })],
    ["level 0", (hello) => ({ ...hello, level: 0 })],
    ["a fractional level", (hello) => ({ ...hello, level: 1.5 })],
    ["levels missing", ({ levels: _levels, ...hello }) => hello],
    ["levels an array", (hello) => ({ ...hello, levels: [1, 1] })],
    ["levels min above max", (hello) => ({ ...hello, levels: { min: 2, max: 1 } })],
    ["level outside its own levels", (hello) => ({ ...hello, level: 2 })],
    ["a missing conflictPolicy", ({ conflictPolicy: _policy, ...hello }) => hello],
    ["a numeric unicodeVersion", (hello) => ({ ...hello, unicodeVersion: 17 })],
  ])("refuses %s with INVALID_HANDSHAKE", (_name, mutate) => {
    expect(() => parseHello(mutate(valid()))).toThrow(expect.objectContaining({ code: "INVALID_HANDSHAKE" }));
  });

  it("refuses a getter with INVALID_HANDSHAKE", () => {
    const hello = valid();
    Object.defineProperty(hello, "level", { get: () => 1, enumerable: true });
    expect(() => parseHello(hello)).toThrow(/not a data property/);
  });

  it("refuses a later protocol with UPGRADE_REQUIRED", () => {
    expect(() => parseHello({ ...valid(), protocol: 2 })).toThrow(expect.objectContaining({ code: "UPGRADE_REQUIRED" }));
  });

  it("reads own fields only, so __proto__ and friends are just unknown fields", () => {
    const hello = JSON.parse(`{"__proto__":{"level":5},"constructor":1,"toString":2,${JSON.stringify(valid()).slice(1)}`) as unknown;
    expect(parseHello(hello).level).toBe(1);
    const inherited = Object.assign(Object.create({ protocol: 1 }) as object, { ...valid(), protocol: undefined });
    expect(() => parseHello(inherited)).toThrow();
  });

  it("throws only CromDBErrors for any JSON (property)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ protocol: fc.constant(1), level: fc.jsonValue(), levels: fc.jsonValue() })), (value) => {
        try {
          parseHello(value);
        } catch (error) {
          expect(error).toBeInstanceOf(CromDBError);
        }
      }),
    );
  });
});

describe("syncLevel", () => {
  it("is the level of both, when both engines can handle it", () => {
    expect(syncLevel({ level: 1, max: 1 }, { level: 1, max: 3, name: "x" })).toBe(1);
    expect(syncLevel({ level: 2, max: 2 }, { level: 2, max: 3, name: "x" })).toBe(2);
    expect(syncLevel({ level: 3, max: 3 }, { level: 3, max: 3, name: "x" })).toBe(3);
  });

  it("says which replica must be upgraded", () => {
    expect(() => syncLevel({ level: 1, max: 1 }, { level: 2, max: 2, name: 'replica "p"' })).toThrow(/this replica must be upgraded/);
    expect(() => syncLevel({ level: 2, max: 2 }, { level: 1, max: 1, name: 'replica "p"' })).toThrow(/replica "p" supports levels up to 1; it must be upgraded/);
  });

  it("refuses different levels both engines support: higher is UPGRADE_REQUIRED, lower SYNC_MISMATCH", () => {
    expect(() => syncLevel({ level: 1, max: 2 }, { level: 2, max: 2, name: 'replica "p"' })).toThrow(
      expect.objectContaining({ code: "UPGRADE_REQUIRED", message: expect.stringContaining("raising a database needs a later engine") as string }),
    );
    expect(() => syncLevel({ level: 2, max: 2 }, { level: 1, max: 2, name: 'replica "p"' })).toThrow(
      expect.objectContaining({ code: "SYNC_MISMATCH", message: 'Replica "p" has this database at level 1, but this replica is at level 2' }),
    );
  });
});
