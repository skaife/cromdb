import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import { Session } from "../src/session.js";
import { aclDocId, databaseDocId, registrationDocId } from "../src/system-docs.js";
import { ENGINE_UNICODE_VERSION } from "../src/unicode/version.js";
import { TestAdapter, expectCode } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let adapter: TestAdapter;
let time: number;
const now = (): Date => new Date(time);

const alice = Session.named("alice");
const bob = Session.named("bob");
const anonymous = Session.anonymous();

function open(session: Session): Promise<Database> {
  return session.openDatabase(adapter, { now });
}

beforeEach(() => {
  adapter = new TestAdapter();
  time = Date.parse("2026-10-15T12:00:00.000Z");
});

afterEach(() => {
  adapter.close();
});

describe("Session", () => {
  it("validates and keeps the NFKC form of the name", () => {
    expect(Session.named("Ｓｃｏｔｔ Skaife").principal).toBe("Scott Skaife");
    expect(Session.anonymous().principal).toBe("anonymous");
  });

  it.each(["system", "System", "anonymous", "*", "[Admin]", "", "Bob\u0378"])("refuses %j", (name) => {
    expect(() => Session.named(name)).toThrow(CromDBError);
  });
});

describe("initialization", () => {
  it("writes local state and the three system documents", async () => {
    const db = await open(alice);
    const { databaseId, instanceId } = db;

    expect(databaseId).toMatch(UUID);
    expect(instanceId).toMatch(UUID);
    expect(databaseId).not.toBe(instanceId);
    expect(adapter.getLocal("databaseId")).toBe(databaseId);
    expect(adapter.getLocal("instanceId")).toBe(instanceId);

    const ids = [databaseDocId(databaseId), aclDocId(databaseId), registrationDocId(databaseId, instanceId)];
    expect(adapter.puts.map((doc) => doc.id)).toEqual(ids);

    for (const id of ids) {
      expect(adapter.getDocument(id)).toMatchObject({
        id,
        parentId: id,
        kind: "system",
        deleted: false,
        createdAt: "2026-10-15T12:00:00.000Z",
        createdBy: "system",
        updatedAt: "2026-10-15T12:00:00.000Z",
        updatedBy: "system",
        updatedOn: instanceId,
        vectorClock: { [instanceId]: 1 },
        readers: ["alice"],
        writers: ["alice"],
        fieldTypes: {},
      });
    }

    expect(adapter.getDocument(ids[0] ?? "")?.content).toEqual({
      databaseId,
      createdAt: "2026-10-15T12:00:00.000Z",
      createdOn: instanceId,
      unicodeVersion: ENGINE_UNICODE_VERSION,
    });
    expect(adapter.getDocument(ids[1] ?? "")?.content).toEqual({ creators: ["alice"], admins: ["alice"] });
    expect(adapter.getDocument(ids[2] ?? "")?.content).toEqual({
      instanceId,
      status: "active",
      introducedBy: null,
      introducedAt: "2026-10-15T12:00:00.000Z",
    });

    const changes = adapter.changesSince(0);
    expect(changes.map((change) => change.docId)).toEqual(ids);
    for (const change of changes) {
      expect(change).toMatchObject({
        op: "put",
        vectorClock: { [instanceId]: 1 },
        instanceId,
        updatedBy: "system",
        timestamp: "2026-10-15T12:00:00.000Z",
        suspect: false,
        suspectReason: null,
      });
    }
  });

  it.each([
    ["the same session", alice],
    ["another named session", bob],
    ["an anonymous session", anonymous],
  ])("is reused by %s and writes nothing", async (_, session) => {
    const first = await open(alice);
    const putCount = adapter.puts.length;
    const changeCount = adapter.changesSince(0).length;

    const second = await open(session);
    expect(second.databaseId).toBe(first.databaseId);
    expect(second.instanceId).toBe(first.instanceId);
    expect(second.session).toBe(session);
    expect(adapter.puts.length).toBe(putCount);
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });

  it("is refused to an anonymous session, writing nothing", async () => {
    await expectCode(open(anonymous), "ACCESS_DENIED");
    expect(adapter.getLocal("databaseId")).toBeUndefined();
    expect(adapter.getLocal("instanceId")).toBeUndefined();
    expect(adapter.puts).toEqual([]);
    expect(adapter.changesSince(0)).toEqual([]);
  });

  it("leaves nothing behind when a write fails", async () => {
    adapter.failAppendChange = true;
    await expect(open(alice)).rejects.toThrow("appendChange failed");
    expect(adapter.getLocal("databaseId")).toBeUndefined();
    expect(adapter.getLocal("instanceId")).toBeUndefined();
    for (const doc of adapter.puts) {
      expect(adapter.getDocument(doc.id)).toBeUndefined();
    }
  });

  it.each(["databaseId", "instanceId"])("refuses local state with only %s", async (key) => {
    adapter.setLocal(key, "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    await expectCode(open(alice), "INVALID_DATABASE");
  });

  it("refuses local state whose database document is missing", async () => {
    adapter.setLocal("databaseId", "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    adapter.setLocal("instanceId", "6ba7b811-9dad-11d1-80b4-00c04fd430c8");
    await expectCode(open(alice), "INVALID_DATABASE");
  });

  it("refuses a database document that does not match", async () => {
    const db = await open(alice);
    const stored = adapter.getDocument(db.databaseId) as DocumentEnvelope;
    adapter.putDocument({ ...stored, content: { ...stored.content, databaseId: "other" } });
    await expectCode(open(alice), "INVALID_DATABASE");
  });

  it("refuses IDs in local state that are not UUIDs", async () => {
    adapter.setLocal("databaseId", "not-a-uuid");
    adapter.setLocal("instanceId", "also-not");
    await expectCode(open(alice), "INVALID_DATABASE");
  });

  it("hides the system documents from get()", async () => {
    const db = await open(alice);
    expect(await db.get(databaseDocId(db.databaseId))).toBeUndefined();
    expect(await db.get(aclDocId(db.databaseId))).toBeUndefined();
    expect(await db.get(registrationDocId(db.databaseId, db.instanceId))).toBeUndefined();
  });
});

describe("create and get", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
    time += 60_000;
  });

  it("is allowed only for creators, writing nothing otherwise", async () => {
    const putCount = adapter.puts.length;
    const changeCount = adapter.changesSince(0).length;

    await expectCode((await open(bob)).create({ x: 1 }), "ACCESS_DENIED");
    await expectCode((await open(anonymous)).create({ x: 1 }), "ACCESS_DENIED");

    expect(adapter.puts.length).toBe(putCount);
    expect(adapter.changesSince(0).length).toBe(changeCount);
    await expect(db.create({ x: 1 })).resolves.toBeDefined();
  });

  it("matches creators by canonical form", async () => {
    const db2 = await open(Session.named("ALICE"));
    await expect(db2.create({ x: 1 })).resolves.toBeDefined();
  });

  it("applies the defaults", async () => {
    const changeCount = adapter.changesSince(0).length;
    const doc = await db.create({ title: "Hello" });

    expect(doc.id).toMatch(UUID);
    expect(doc.parentId).toBe(doc.id);
    expect(doc.readers).toEqual(["*"]);
    expect(doc.writers).toEqual(["*"]);
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 1 });
    expect(doc.updatedBy).toBe("alice");
    expect(doc.updatedOn).toBe(db.instanceId);
    expect(doc.updatedAt).toEqual(new Date("2026-10-15T12:01:00.000Z"));
    expect(doc.content).toEqual({ title: "Hello" });

    expect(adapter.getDocument(doc.id)).toEqual({
      id: doc.id,
      parentId: doc.id,
      kind: "document",
      vectorClock: { [db.instanceId]: 1 },
      deleted: false,
      createdAt: "2026-10-15T12:01:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-10-15T12:01:00.000Z",
      updatedBy: "alice",
      updatedOn: db.instanceId,
      readers: ["*"],
      writers: ["*"],
      content: { title: "Hello" },
      fieldTypes: {},
    });

    const changes = adapter.changesSince(0).slice(changeCount);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      docId: doc.id,
      op: "put",
      vectorClock: { [db.instanceId]: 1 },
      instanceId: db.instanceId,
      updatedBy: "alice",
      timestamp: "2026-10-15T12:01:00.000Z",
    });
  });

  it("returns what get() returns", async () => {
    const doc = await db.create({ title: "Hello", n: 1 }, { readers: ["alice", "bob"], writers: ["alice"] });
    const loaded = await db.get(doc.id);
    expect(loaded?.content).toEqual({ title: "Hello", n: 1 });
    expect(loaded?.readers).toEqual(["alice", "bob"]);
    expect(loaded?.writers).toEqual(["alice"]);
    expect(loaded?.vectorClock).toEqual(doc.vectorClock);
    expect(loaded?.updatedAt).toEqual(doc.updatedAt);
  });

  it("gives get() undefined for a missing document", async () => {
    expect(await db.get("missing")).toBeUndefined();
  });

  it("lets readers ['*'] be read by named sessions but not anonymous", async () => {
    const doc = await db.create({ x: 1 });
    expect(await (await open(bob)).get(doc.id)).toBeDefined();
    expect(await (await open(anonymous)).get(doc.id)).toBeUndefined();
  });

  it("lets readers ['*', 'anonymous'] be read by anonymous", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["*", "anonymous"] });
    expect(await (await open(anonymous)).get(doc.id)).toBeDefined();
  });

  it("hides a document from a principal not in readers", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["alice"] });
    expect(await (await open(bob)).get(doc.id)).toBeUndefined();
    expect(await (await open(Session.named("Alice"))).get(doc.id)).toBeDefined();
  });

  it("round-trips Dates, nested too", async () => {
    const due = new Date("2026-11-01T00:00:00.000Z");
    const shipped = new Date("2026-11-02T00:00:00.000Z");
    const doc = await db.create({ due, items: [{ shipped }] });
    const loaded = await db.get<{ due: Date; items: { shipped: Date }[] }>(doc.id);
    expect(loaded?.content.due).toBeInstanceOf(Date);
    expect(loaded?.content.due).toEqual(due);
    expect(loaded?.content.items[0]?.shipped).toEqual(shipped);
    expect(doc.content.due).toEqual(due);
  });

  it("round-trips a __proto__ content key as an own property", async () => {
    const content = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}') as Record<string, unknown>;
    const doc = await db.create(content);
    const loaded = await db.get(doc.id);
    expect(Object.hasOwn(loaded?.content ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(loaded?.content, "__proto__")?.value).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(loaded?.content)).toBe(Object.prototype);
  });

  it("accepts a readable parent", async () => {
    const parent = await db.create({ x: 1 });
    const child = await db.create({ y: 2 }, { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect((await db.get(child.id))?.parentId).toBe(parent.id);
  });

  it("refuses a missing, unreadable, deleted, or system parent", async () => {
    const unreadable = await db.create({ x: 1 }, { readers: ["bob"] });
    const deleted = await db.create({ x: 1 });
    await deleted.delete();
    const changeCount = adapter.changesSince(0).length;

    for (const parentId of ["missing", unreadable.id, deleted.id, db.databaseId, aclDocId(db.databaseId)]) {
      await expectCode(db.create({ y: 2 }, { parentId }), "NOT_FOUND");
    }
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });

  it.each([
    [{ readers: [] }],
    [{ readers: ["system"] }],
    [{ readers: ["[Admin]"] }],
    [{ writers: [] }],
    [{ writers: ["system"] }],
    [{ writers: ["[Admin]"] }],
    [{ writers: ["alice", "ALICE"] }],
  ])("refuses invalid lists %j, writing nothing", async (options) => {
    const changeCount = adapter.changesSince(0).length;
    await expectCode(db.create({ x: 1 }, options), "INVALID_ACCESS_LIST");
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });

  it("refuses content that isn't JSON-safe, writing nothing", async () => {
    const changeCount = adapter.changesSince(0).length;
    await expect(db.create({ x: Number.NaN })).rejects.toThrow(TypeError);
    await expect(db.create({ x: new Map() })).rejects.toThrow(TypeError);
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });

  it("adds a creator left out of writers to them", async () => {
    const doc = await db.create({ x: 1 }, { writers: ["bob"] });
    expect(doc.writers).toEqual(["bob", "alice"]);
    expect(adapter.getDocument(doc.id)?.writers).toEqual(["bob", "alice"]);
  });

  it("adds the creator in the NFKC form the session holds", async () => {
    const acl = await db.getAcl();
    acl.creators = ["*"];
    await acl.save();
    const wide = await open(Session.named("Ａｌｉｃｅ Ｂ"));
    const doc = await wide.create({ x: 1 }, { writers: ["bob"] });
    expect(doc.writers).toEqual(["bob", "Alice B"]);
  });

  it("keeps writers that already admit the creator", async () => {
    expect((await db.create({ x: 1 })).writers).toEqual(["*"]);
    expect((await db.create({ x: 1 }, { writers: ["ALICE"] })).writers).toEqual(["ALICE"]);
    expect((await db.create({ x: 1 }, { writers: ["anonymous"] })).writers).toEqual(["anonymous"]);
  });

  it('gives an anonymous creator ["*", "anonymous"] by default, and adds "anonymous" to given writers', async () => {
    const acl = await db.getAcl();
    acl.creators = ["anonymous"];
    await acl.save();
    const anon = await open(anonymous);
    expect((await anon.create({ x: 1 })).writers).toEqual(["*", "anonymous"]);
    expect((await anon.create({ x: 1 }, { writers: ["bob"] })).writers).toEqual(["bob", "anonymous"]);
  });

  it("lets a creator leave themselves out of readers (a drop box)", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["bob"] });
    expect(doc.readers).toEqual(["bob"]);
    expect(await db.get(doc.id)).toBeUndefined();
    expect((await db.find()).count).toBe(0);
    expect(await (await open(bob)).get(doc.id)).toBeDefined();
    // Writing needs reading, so the object create returned can't write.
    doc.content.x = 2;
    await expectCode(doc.save(), "ACCESS_DENIED");
    await expectCode(doc.delete(), "ACCESS_DENIED");
    expect(await doc.myAccess()).toEqual({ read: false, update: false, delete: false });
  });

  it("stores the NFKC form of list entries", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["Ｂｏｂ"] });
    expect(adapter.getDocument(doc.id)?.readers).toEqual(["Bob"]);
  });

  it("returns copies of the vector clock", async () => {
    const doc = await db.create({ x: 1 });
    const clock = doc.vectorClock as Record<string, number>;
    clock[db.instanceId] = 99;
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 1 });
  });
});

describe("save", () => {
  let db: Database;
  let doc: Document<{ title: string }>;

  beforeEach(async () => {
    db = await open(alice);
    doc = await db.create({ title: "Hello" });
    time += 60_000;
  });

  function stored(): DocumentEnvelope | undefined {
    return adapter.getDocument(doc.id);
  }

  it("bumps the clock, stamps the write, and appends one change", async () => {
    const changeCount = adapter.changesSince(0).length;
    doc.content.title = "Changed";
    await doc.save();

    expect(doc.vectorClock).toEqual({ [db.instanceId]: 2 });
    expect(doc.updatedAt).toEqual(new Date("2026-10-15T12:01:00.000Z"));
    expect(doc.updatedBy).toBe("alice");
    expect(doc.updatedOn).toBe(db.instanceId);
    expect(stored()).toMatchObject({
      vectorClock: { [db.instanceId]: 2 },
      updatedAt: "2026-10-15T12:01:00.000Z",
      content: { title: "Changed" },
    });

    const changes = adapter.changesSince(0).slice(changeCount);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ docId: doc.id, op: "put", vectorClock: { [db.instanceId]: 2 } });
  });

  it("updates readers and writers to the stored NFKC form", async () => {
    doc.readers = ["*", "Ｂｏｂ"];
    doc.writers = ["＊"];
    await doc.save();
    expect(doc.readers).toEqual(["*", "Bob"]);
    expect(doc.writers).toEqual(["*"]);
    expect(stored()?.writers).toEqual(["*"]);
  });

  it("leaves readers and writers as set when the save fails", async () => {
    doc.writers = ["system"];
    await expectCode(doc.save(), "INVALID_ACCESS_LIST");
    expect(doc.writers).toEqual(["system"]);
  });

  it("writes even when nothing changed", async () => {
    await doc.save();
    await doc.save();
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 3 });
  });

  it("records the saving session's name as written, matching writers by canonical form", async () => {
    const own = await db.create({ x: 1 }, { writers: ["Scott Skaife"] });
    const other = await (await open(Session.named("scott skaife"))).get<{ x: number }>(own.id);
    if (other === undefined) {
      expect.fail("document not readable");
    }
    await other.save();
    expect(other.updatedBy).toBe("scott skaife");
    expect(adapter.getDocument(own.id)?.updatedBy).toBe("scott skaife");
  });

  it("refuses a principal not in writers, changing nothing", async () => {
    const own = await db.create({ x: 1 }, { writers: ["alice"] });
    const before = adapter.getDocument(own.id);
    const changeCount = adapter.changesSince(0).length;

    const bobs = await (await open(bob)).get<{ x: number }>(own.id);
    if (bobs === undefined) {
      expect.fail("document not readable");
    }
    bobs.content.x = 2;
    await expectCode(bobs.save(), "ACCESS_DENIED");

    expect(adapter.getDocument(own.id)).toEqual(before);
    expect(adapter.changesSince(0).length).toBe(changeCount);
    expect(bobs.vectorClock).toEqual(own.vectorClock);
  });

  it("checks the stored writers, not the new ones", async () => {
    const own = await db.create({ x: 1 }, { writers: ["alice", "bob"] });
    const bobs = (await (await open(bob)).get<{ x: number }>(own.id)) as Document<{ x: number }>;
    bobs.writers = ["bob"];
    await bobs.save(); // another writer may remove alice
    expect(adapter.getDocument(own.id)?.writers).toEqual(["bob"]);

    const again = (await db.get<{ x: number }>(own.id)) as Document<{ x: number }>;
    again.writers = ["alice", "bob"];
    await expectCode(again.save(), "ACCESS_DENIED"); // and she can't add herself back
    expect(adapter.getDocument(own.id)?.writers).toEqual(["bob"]);
  });

  it("refuses a writer removing themselves from writers, changing nothing", async () => {
    const own = await db.create({ x: 1 }, { writers: ["alice", "bob"] });
    const before = adapter.getDocument(own.id);
    own.writers = ["bob"];
    const error = await expectCode(own.save(), "ACCESS_DENIED");
    expect(error.message).toMatch(/cannot remove themselves.*another writer/);
    expect(adapter.getDocument(own.id)).toEqual(before);
    // Still a writer through "*" or "anonymous" is fine.
    own.writers = ["*"];
    await own.save();
    own.writers = ["anonymous"];
    await own.save();
    expect(adapter.getDocument(own.id)?.writers).toEqual(["anonymous"]);
  });

  it("refuses a writer who isn't a reader, changing nothing", async () => {
    const own = await db.create({ x: 1 }, { readers: ["alice", "bob"], writers: ["alice", "bob"] });
    const bobs = (await (await open(bob)).get<{ x: number }>(own.id)) as Document<{ x: number }>;
    bobs.readers = ["alice"];
    await bobs.save(); // bob may take himself out of readers
    const before = adapter.getDocument(own.id);
    const changeCount = adapter.changesSince(0).length;
    bobs.content.x = 9;
    const error = await expectCode(bobs.save(), "ACCESS_DENIED");
    expect(error.message).toContain("can't read");
    await expectCode(bobs.delete(), "ACCESS_DENIED");
    expect(adapter.getDocument(own.id)).toEqual(before);
    expect(adapter.changesSince(0).length).toBe(changeCount);
    expect(await bobs.myAccess()).toEqual({ read: false, update: false, delete: false });
  });

  it("lets a reader and writer save progressively, then submit out of readers", async () => {
    const draft = await db.create({ step: 0 }, { readers: ["alice", "bob"], writers: ["alice"] });
    for (let step = 1; step <= 3; step++) {
      draft.content.step = step;
      await draft.save();
    }
    draft.readers = ["bob"];
    await draft.save(); // checked on the stored readers, which still have alice
    expect(adapter.getDocument(draft.id)?.content).toEqual({ step: 3 });
    expect(await db.get(draft.id)).toBeUndefined();
    await expectCode(draft.save(), "ACCESS_DENIED");
    await expectCode(draft.delete(), "ACCESS_DENIED");
  });

  it("refuses a stale document", async () => {
    const other = await db.get<{ title: string }>(doc.id);
    if (other === undefined) {
      expect.fail("document not readable");
    }
    doc.content.title = "First";
    await doc.save();

    other.content.title = "Second";
    await expectCode(other.save(), "STALE_DOCUMENT");
    expect(stored()?.content).toEqual({ title: "First" });
  });

  it.each([[[]], [["system"]], [["[Admin]"]]])("refuses invalid lists %j, changing nothing", async (list) => {
    const before = stored();
    const clock = doc.vectorClock;
    doc.readers = list;
    await expectCode(doc.save(), "INVALID_ACCESS_LIST");
    doc.readers = ["*"];
    doc.writers = list;
    await expectCode(doc.save(), "INVALID_ACCESS_LIST");
    expect(stored()).toEqual(before);
    expect(doc.vectorClock).toEqual(clock);
  });

  it("refuses non-JSON content, changing nothing", async () => {
    const before = stored();
    (doc.content as Record<string, unknown>)["bad"] = () => 1;
    await expect(doc.save()).rejects.toThrow(TypeError);
    expect(stored()).toEqual(before);
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 1 });
  });
});

describe("delete", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
  });

  it("writes a tombstone", async () => {
    const parent = await db.create({ x: 1 });
    const doc = await db.create({ title: "Hello", due: new Date() }, { readers: ["alice", "bob"], writers: ["alice"], parentId: parent.id });
    time += 60_000;
    const changeCount = adapter.changesSince(0).length;
    await doc.delete();

    expect(adapter.getDocument(doc.id)).toEqual({
      id: doc.id,
      parentId: parent.id,
      kind: "document",
      vectorClock: { [db.instanceId]: 2 },
      deleted: true,
      deletedAt: "2026-10-15T12:01:00.000Z",
      createdAt: "2026-10-15T12:00:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-10-15T12:01:00.000Z",
      updatedBy: "alice",
      updatedOn: db.instanceId,
      readers: ["alice", "bob"],
      writers: ["alice"],
      content: {},
      fieldTypes: {},
    });
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 2 });

    const changes = adapter.changesSince(0).slice(changeCount);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ docId: doc.id, op: "delete", vectorClock: { [db.instanceId]: 2 } });

    expect(await db.get(doc.id)).toBeUndefined();
    await expectCode(doc.save(), "NOT_FOUND");
    await expectCode(doc.delete(), "NOT_FOUND");
  });

  it("resets readers and writers to the stored lists", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["alice"], writers: ["alice"] });
    doc.readers = ["changed"];
    doc.writers = ["changed"];
    await doc.delete();
    expect(doc.readers).toEqual(["alice"]);
    expect(doc.writers).toEqual(["alice"]);
    expect(adapter.getDocument(doc.id)?.readers).toEqual(["alice"]);
  });

  it("refuses a non-writer", async () => {
    const doc = await db.create({ x: 1 }, { writers: ["alice"] });
    const before = adapter.getDocument(doc.id);
    const bobs = await (await open(bob)).get(doc.id);
    await expectCode(bobs?.delete() ?? Promise.resolve(), "ACCESS_DENIED");
    expect(adapter.getDocument(doc.id)).toEqual(before);
  });

  it("refuses a stale document", async () => {
    const doc = await db.create({ x: 1 });
    const other = await db.get(doc.id);
    await doc.save();
    await expectCode(other?.delete() ?? Promise.resolve(), "STALE_DOCUMENT");
    expect(adapter.getDocument(doc.id)?.deleted).toBe(false);
  });
});

describe("creation fields", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
    time += 60_000;
  });

  it("gives every system document createdBy system and the init time", async () => {
    const ids = [
      databaseDocId(db.databaseId),
      aclDocId(db.databaseId),
      registrationDocId(db.databaseId, db.instanceId),
    ];
    for (const id of ids) {
      expect(adapter.getDocument(id)).toMatchObject({ createdAt: "2026-10-15T12:00:00.000Z", createdBy: "system" });
    }
  });

  it("are set at create from the clock and the session's stored name", async () => {
    const doc = await (await open(Session.named("ＡＬＩＣＥ"))).create({ x: 1 });
    expect(doc.createdAt).toEqual(new Date("2026-10-15T12:01:00.000Z"));
    expect(doc.createdBy).toBe("ALICE");
    expect(adapter.getDocument(doc.id)).toMatchObject({ createdAt: "2026-10-15T12:01:00.000Z", createdBy: "ALICE" });
    const loaded = await db.get(doc.id);
    expect(loaded?.createdAt).toEqual(doc.createdAt);
    expect(loaded?.createdBy).toBe("ALICE");
  });

  it("never change on save or delete", async () => {
    const doc = await db.create({ x: 1 });
    time += 60_000;
    const bobDoc = (await (await open(bob)).get(doc.id)) as Document<{ x: number }>;
    bobDoc.content.x = 2;
    await bobDoc.save();
    expect(bobDoc.createdAt).toEqual(new Date("2026-10-15T12:01:00.000Z"));
    expect(bobDoc.createdBy).toBe("alice");
    expect(bobDoc.updatedBy).toBe("bob");
    expect(adapter.getDocument(doc.id)).toMatchObject({
      createdAt: "2026-10-15T12:01:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-10-15T12:02:00.000Z",
    });

    time += 60_000;
    await bobDoc.delete();
    expect(bobDoc.createdAt).toEqual(new Date("2026-10-15T12:01:00.000Z"));
    expect(bobDoc.createdBy).toBe("alice");
    expect(adapter.getDocument(doc.id)).toMatchObject({
      deleted: true,
      createdAt: "2026-10-15T12:01:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-10-15T12:03:00.000Z",
    });
  });
});

describe("atomicity", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
  });

  it("leaves no document when create fails", async () => {
    const putCount = adapter.puts.length;
    adapter.failAppendChange = true;
    await expect(db.create({ x: 1 })).rejects.toThrow("appendChange failed");

    const attempted = adapter.puts.slice(putCount);
    expect(attempted).toHaveLength(1);
    expect(adapter.getDocument(attempted[0]?.id ?? "")).toBeUndefined();
  });

  it("leaves the document as it was when save fails", async () => {
    const doc = await db.create({ x: 1 });
    const before = adapter.getDocument(doc.id);
    adapter.failAppendChange = true;
    doc.content.x = 2;
    await expect(doc.save()).rejects.toThrow("appendChange failed");
    expect(adapter.getDocument(doc.id)).toEqual(before);
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 1 });

    adapter.failAppendChange = false;
    await doc.save(); // still loaded at the stored clock, so not stale
    expect(adapter.getDocument(doc.id)?.content).toEqual({ x: 2 });
  });

  it("leaves the document as it was when delete fails", async () => {
    const doc = await db.create({ x: 1 });
    const before = adapter.getDocument(doc.id);
    adapter.failAppendChange = true;
    await expect(doc.delete()).rejects.toThrow("appendChange failed");
    expect(adapter.getDocument(doc.id)).toEqual(before);
    expect(doc.vectorClock).toEqual({ [db.instanceId]: 1 });
  });
});

describe("Unicode version", () => {
  // U+A7CF LATIN SMALL LETTER PHARYNGEAL VOICED FRICATIVE, new in 17.0.
  // U+A7CD LATIN SMALL LETTER S WITH DIAGONAL STROKE, new in 16.0.
  const new17 = "Bob\uA7CF";
  const new16 = "Bob\uA7CD";

  // Rewrites the database document as if it had been created at another
  // version (or with a broken one).
  function setDatabaseVersion(databaseId: string, unicodeVersion: unknown): void {
    const stored = adapter.getDocument(databaseId) as DocumentEnvelope;
    const content = { ...stored.content };
    if (unicodeVersion === undefined) {
      delete content["unicodeVersion"];
    } else {
      content["unicodeVersion"] = unicodeVersion as string;
    }
    adapter.putDocument({ ...stored, content });
  }

  it("refuses a database that needs a newer Unicode version", async () => {
    const db = await open(alice);
    setDatabaseVersion(db.databaseId, "99.0");
    await expectCode(open(alice), "UPGRADE_REQUIRED");
    await expect(open(alice)).rejects.toThrow(`needs Unicode 99.0, but this engine supports Unicode ${ENGINE_UNICODE_VERSION}`);
  });

  it.each([undefined, "17", 17, null])("refuses unicodeVersion %j as INVALID_DATABASE", async (version) => {
    const db = await open(alice);
    setDatabaseVersion(db.databaseId, version);
    await expectCode(open(alice), "INVALID_DATABASE");
  });

  it("opens a database at an older version and checks names against it", async () => {
    const db = await open(alice);
    setDatabaseVersion(db.databaseId, "16.0");
    const older = await open(alice);

    await expectCode(older.create({ x: 1 }, { readers: [new17] }), "INVALID_ACCESS_LIST");
    await expectCode(older.create({ x: 1 }, { writers: ["*", new17] }), "INVALID_ACCESS_LIST");
    await expect(older.create({ x: 1 }, { readers: [new16] })).resolves.toBeDefined();

    const doc = await older.create({ x: 1 });
    doc.writers = [new17];
    await expectCode(doc.save(), "INVALID_ACCESS_LIST");

    const session = Session.named(new17); // fine for this engine
    await expectCode(open(session), "INVALID_PRINCIPAL");
    await expect(open(Session.named(new16))).resolves.toBeDefined();
  });

  it("accepts the same names at 17.0", async () => {
    const db = await open(alice);
    setDatabaseVersion(db.databaseId, "17.0");
    const current = await open(alice);

    const doc = await current.create({ x: 1 }, { readers: [new17], writers: ["*", new17] });
    expect(doc.readers).toEqual([new17]);
    await expect(open(Session.named(new17))).resolves.toBeDefined();
  });

  it("refuses that session without writing anything", async () => {
    const db = await open(alice);
    setDatabaseVersion(db.databaseId, "16.0");
    const changeCount = adapter.changesSince(0).length;
    await expectCode(open(Session.named(new17)), "INVALID_PRINCIPAL");
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });
});
