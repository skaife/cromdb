// The access structure of a level-3 database: one ACL with a list for each
// access type, which every document's own lists narrow, and noAccess over
// everything. The table over every public method is in access-paths.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_TYPES } from "../src/access.js";
import type { Database } from "../src/database.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import * as api from "../src/index.js";
import type { ChangeBatch } from "../src/replication.js";
import { Session } from "../src/session.js";
import { aclDocId, registrationDocId } from "../src/system-docs.js";
import { TestAdapter, expectCode } from "./helpers.js";

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);

const alice = Session.withId("alice");
const bob = Session.withId("bob");
const carol = Session.withId("carol");
const anonymous = Session.anonymous();

let adapter: TestAdapter;
let db: Database;

function newAdapter(): TestAdapter {
  const created = new TestAdapter();
  adapters.push(created);
  return created;
}

function open(session: Session, on: TestAdapter = adapter): Promise<Database> {
  return session.openDatabase(on, { now });
}

function storedAcl(on: TestAdapter = adapter): DocumentEnvelope {
  return on.getDocument(aclDocId(db.databaseId)) as DocumentEnvelope;
}

type Lists = { admins?: string[]; creators?: string[]; writers?: string[]; readers?: string[]; noAccess?: string[] };

/** Sets the lists given, as alice, keeping the others. */
async function setAcl(lists: Lists, as: Database = db): Promise<void> {
  const acl = await as.getAcl();
  Object.assign(acl, lists);
  time += 1000;
  await acl.save();
}

beforeEach(async () => {
  adapters = [];
  time = Date.parse("2026-11-20T12:00:00.000Z");
  adapter = newAdapter();
  db = await open(alice);
  time += 60_000;
});

afterEach(() => {
  for (const each of adapters) {
    each.close();
  }
});

describe("a new database", () => {
  it("has the five lists, with only its creator in them, and noAccess empty", async () => {
    const acl = await db.getAcl();
    expect([acl.admins, acl.creators, acl.writers, acl.readers, acl.noAccess]).toEqual([["alice"], ["alice"], ["alice"], ["alice"], []]);
    expect(storedAcl().content).toEqual({ admins: ["alice"], creators: ["alice"], writers: ["alice"], readers: ["alice"], noAccess: [] });
    expect(await db.myAccess()).toEqual({ visible: true, read: true, write: true, create: true, admin: true });
  });

  it("exports the access types, in the order they are stored", () => {
    expect(api.ACCESS_TYPES).toBe(ACCESS_TYPES);
    expect(ACCESS_TYPES).toEqual(["admins", "creators", "writers", "readers", "noAccess"]);
    expect(Object.keys(storedAcl().content)).toEqual([...ACCESS_TYPES]);
  });

  it("admits nobody else: other sessions can't open it", async () => {
    for (const session of [bob, anonymous]) {
      const error = await expectCode(open(session), "ACCESS_DENIED");
      expect(error.message).toBe(`${JSON.stringify(session.principal)} has no access to this database`);
    }
  });
});

describe("opening", () => {
  it.each<[string, Lists]>([
    ["readers", { readers: ["alice", "bob"] }],
    ["writers", { writers: ["alice", "bob"] }],
    ["creators", { creators: ["alice", "bob"] }],
    ["admins", { admins: ["alice", "bob"] }],
    ['readers ["*"]', { readers: ["*"] }],
  ])("is allowed to a session in %s", async (_name, lists) => {
    await setAcl(lists);
    expect((await (await open(bob)).myAccess()).visible).toBe(true);
    await expectCode(open(anonymous), "ACCESS_DENIED");
  });

  it('is allowed to an anonymous session only through "anonymous"', async () => {
    await setAcl({ readers: ["alice", "anonymous"] });
    const anon = await open(anonymous);
    expect(await anon.myAccess()).toEqual({ visible: true, read: true, write: false, create: false, admin: false });
    expect((await open(bob)).databaseId).toBe(db.databaseId);
  });

  it("is refused to a session in noAccess, whatever else lists it", async () => {
    await setAcl({ admins: ["alice", "bob"], creators: ["*"], writers: ["*"], readers: ["*"], noAccess: ["bob"] });
    await expectCode(open(bob), "ACCESS_DENIED");
    expect(await (await open(carol)).myAccess()).toEqual({ visible: true, read: true, write: true, create: true, admin: false });
  });

  it("writes nothing when refused, not even this replica's maxLevel", async () => {
    const target = newAdapter();
    await db.createReplica(target);
    const before = target.allDocuments();
    await expectCode(open(bob, target), "ACCESS_DENIED");
    expect(target.allDocuments()).toEqual(before);
  });
});

describe("a Database held while access changes", () => {
  it("refuses every call but myAccess once its session is removed, and works again when readmitted", async () => {
    await setAcl({ readers: ["alice", "bob"] });
    const doc = await db.create({ n: 1 }, { readers: ["*"] });
    const bobs = await open(bob);
    expect((await bobs.get(doc.id))?.content).toEqual({ n: 1 });
    const held = await bobs.find();

    await setAcl({ readers: ["alice"] });
    await expectCode(bobs.get(doc.id), "ACCESS_DENIED");
    await expectCode(bobs.find(), "ACCESS_DENIED");
    await expectCode(bobs.replicas(), "ACCESS_DENIED");
    // A set found earlier loads each document when iterated, so it is refused too.
    await expectCode((async () => {
      for await (const _ of held) {
        // nothing
      }
    })(), "ACCESS_DENIED");
    expect(await bobs.myAccess()).toEqual({ visible: false, read: false, write: false, create: false, admin: false });

    await setAcl({ readers: ["alice", "bob"] });
    expect((await bobs.get(doc.id))?.content).toEqual({ n: 1 });
  });

  it("refuses a loaded Document's save and delete once its session is locked out, and its myAccess says so", async () => {
    await setAcl({ readers: ["*"], writers: ["*"] });
    const created = await db.create({ n: 1 });
    const bobsDoc = (await (await open(bob)).get<{ n: number }>(created.id)) as api.Document<{ n: number }>;
    expect(await bobsDoc.myAccess()).toEqual({ read: true, update: true, delete: true });

    await setAcl({ noAccess: ["bob"] });
    expect(await bobsDoc.myAccess()).toEqual({ read: false, update: false, delete: false });
    bobsDoc.content.n = 2;
    await expectCode(bobsDoc.save(), "ACCESS_DENIED");
    await expectCode(bobsDoc.delete(), "ACCESS_DENIED");
    expect((await db.get<{ n: number }>(created.id))?.content.n).toBe(1);
  });
});

describe("the lists are independent", () => {
  beforeEach(async () => {
    await setAcl({ creators: ["*"] });
  });

  it("a writer who isn't a reader can edit nothing", async () => {
    const doc = await db.create({ n: 1 });
    await setAcl({ writers: ["alice", "bob"] });
    const bobs = await open(bob);
    expect(await bobs.myAccess()).toEqual({ visible: true, read: false, write: true, create: true, admin: false });
    expect(await bobs.get(doc.id)).toBeUndefined();
    expect((await bobs.find()).count).toBe(0);
  });

  it("a reader who isn't a writer can read but not edit, whatever the document's writers say", async () => {
    const doc = await db.create({ n: 1 }, { writers: ["*", "bob"] });
    await setAcl({ readers: ["alice", "bob"] });
    const bobsDoc = (await (await open(bob)).get<{ n: number }>(doc.id)) as api.Document<{ n: number }>;
    expect(bobsDoc.content).toEqual({ n: 1 });
    expect(await bobsDoc.myAccess()).toEqual({ read: true, update: false, delete: false });
    bobsDoc.content.n = 2;
    const error = await expectCode(bobsDoc.save(), "ACCESS_DENIED");
    expect(error.message).toBe(`"bob" cannot write document ${JSON.stringify(doc.id)}`);
  });

  it("a depositor (creators without readers) can create, but not read back or edit", async () => {
    const bobs = await open(bob);
    expect(await bobs.myAccess()).toEqual({ visible: true, read: false, write: false, create: true, admin: false });
    const deposited = await bobs.create({ note: "for alice" }, { readers: ["alice"] });
    expect(await bobs.get(deposited.id)).toBeUndefined();
    expect(await deposited.myAccess()).toEqual({ read: false, update: false, delete: false });
    await expectCode(deposited.save(), "ACCESS_DENIED");
    expect((await db.get(deposited.id))?.content).toEqual({ note: "for alice" });
    expect((await db.get(deposited.id))?.writers).toEqual(["*"]);
  });

  it("an admin in no other list manages the database but reads and writes no documents", async () => {
    const doc = await db.create({ n: 1 });
    await setAcl({ admins: ["alice", "bob"], creators: ["alice"] });
    const bobs = await open(bob);
    expect(await bobs.myAccess()).toEqual({ visible: true, read: false, write: false, create: false, admin: true });
    expect(await bobs.get(doc.id)).toBeUndefined();
    expect((await bobs.find()).count).toBe(0);
    await expectCode(bobs.create({ n: 2 }), "ACCESS_DENIED");
    // Managing: the ACL, replicas, sync.
    const acl = await bobs.getAcl();
    acl.creators = ["alice", "carol"];
    await acl.save();
    expect((await bobs.replicas()).length).toBe(1);
    await bobs.registerReplica();
    const target = newAdapter();
    await bobs.createReplica(target);
    expect((await bobs.exportChanges()).documents.length).toBeGreaterThan(0);
  });
});

describe('"*" in a document', () => {
  it("means everyone the database admits, never everyone signed in", async () => {
    const doc = await db.create({ n: 1 });
    expect(doc.readers).toEqual(["*"]);
    await setAcl({ readers: ["alice", "bob"], creators: ["alice", "carol"] });
    expect((await (await open(bob)).get(doc.id))?.content).toEqual({ n: 1 });
    // carol is admitted, as a creator, but isn't a reader: "*" doesn't reach her.
    const carols = await open(carol);
    expect(await carols.get(doc.id)).toBeUndefined();
    expect((await carols.find()).count).toBe(0);
  });

  it("and the database's readers can't widen a document's own readers", async () => {
    const doc = await db.create({ n: 1 }, { readers: ["alice"] });
    await setAcl({ readers: ["*"] });
    expect(await (await open(bob)).get(doc.id)).toBeUndefined();
  });
});

describe("saving the ACL", () => {
  it("stores all five lists and sets the ACL document's readers and writers to the admins outside noAccess", async () => {
    await setAcl({ admins: ["alice", "bob", "carol"], creators: ["*"], writers: [], readers: ["anonymous"], noAccess: ["carol"] });
    expect(storedAcl()).toMatchObject({
      readers: ["alice", "bob"],
      writers: ["alice", "bob"],
      content: { admins: ["alice", "bob", "carol"], creators: ["*"], writers: [], readers: ["anonymous"], noAccess: ["carol"] },
    });
  });

  it("gives registrations the admins outside noAccess too", async () => {
    await setAcl({ admins: ["alice", "bob", "carol"], noAccess: ["carol"] });
    const ticket = await db.registerReplica();
    const registration = adapter.getDocument(registrationDocId(db.databaseId, ticket.instanceId)) as DocumentEnvelope;
    expect([registration.readers, registration.writers]).toEqual([
      ["alice", "bob"],
      ["alice", "bob"],
    ]);
  });

  it("lets readers, writers and creators be empty", async () => {
    await setAcl({ creators: [], writers: [], readers: [] });
    expect(await db.myAccess()).toEqual({ visible: true, read: false, write: false, create: false, admin: true });
  });

  it.each<[string, Lists, string, RegExp]>([
    ["empty admins", { admins: [] }, "INVALID_ACCESS_LIST", /^admins must be an array with at least one entry$/],
    ['"*" in admins', { admins: ["alice", "*"] }, "INVALID_ACCESS_LIST", /^admins entry "\*" is not allowed/],
    ['"*" in noAccess', { noAccess: ["*"] }, "INVALID_ACCESS_LIST", /^noAccess can't hold "\*"; name the people to lock out$/],
    ['"anonymous" in noAccess', { noAccess: ["anonymous"] }, "INVALID_ACCESS_LIST", /^noAccess can't hold "anonymous"; name the people to lock out$/],
    ["a duplicate in noAccess", { noAccess: ["bob", "bob"] }, "INVALID_ACCESS_LIST", /^noAccess lists "bob" more than once$/],
    ["a role in readers", { readers: ["[Sales]"] }, "INVALID_ACCESS_LIST", /^readers entry "\[Sales\]" starts with "\["/],
    ["a non-array writers", { writers: "bob" as unknown as string[] }, "INVALID_ACCESS_LIST", /^writers must be an array$/],
    ["the saver in noAccess", { admins: ["alice", "bob"], noAccess: ["alice"] }, "ACCESS_DENIED", /^"alice" cannot lock themselves out; another admin must do it$/],
    ["the saver out of admins", { admins: ["bob"] }, "ACCESS_DENIED", /cannot remove themselves from admins/],
  ])("refuses %s, changing nothing", async (_name, lists, code, message) => {
    const before = storedAcl();
    const acl = await db.getAcl();
    Object.assign(acl, lists);
    const error = await expectCode(acl.save(), code);
    expect(error.message).toMatch(message);
    expect(storedAcl()).toEqual(before);
  });

  it("lets an admin lock out another admin, who then can't open the database or write the ACL anywhere", async () => {
    await setAcl({ admins: ["alice", "bob"] });
    const bobsAcl = await (await open(bob)).getAcl();
    const target = newAdapter();
    await db.createReplica(target);

    await setAcl({ noAccess: ["bob"] });
    expect((await db.getAcl()).admins).toEqual(["alice", "bob"]);
    await expectCode(open(bob), "ACCESS_DENIED");
    // bob's ACL, loaded before, is stale; and a fresh one can't be had.
    await expectCode(bobsAcl.save(), "STALE_DOCUMENT");

    // On another replica that hasn't heard yet, bob is still an admin. An
    // ACL version written there by bob after the lockout arrived would be
    // unauthorized: he isn't in the ACL document's writers any more.
    const b = await open(alice, target);
    await b.pullFrom(db);
    await expectCode(open(bob, target), "ACCESS_DENIED");
    const stored = storedAcl();
    const forged: DocumentEnvelope = {
      ...stored,
      vectorClock: { ...stored.vectorClock, [b.instanceId]: 1 },
      updatedBy: "bob",
      updatedOn: b.instanceId,
      content: { ...stored.content, noAccess: [] },
    };
    const batch = (await b.exportChanges({ since: 0 })) as ChangeBatch;
    const error = await expectCode(
      db.applyChanges({ ...batch, since: await db.syncPosition(b.instanceId), documents: [forged] }),
      "NOT_SUPPORTED",
    );
    expect(error.message).toContain("not in its writers");
  });
});

describe("tickets", () => {
  it("need an admin outside noAccess", async () => {
    await setAcl({ admins: ["alice", "bob"], noAccess: ["bob"] });
    const ticket = await db.registerReplica();
    const target = newAdapter();
    await expectCode(bob.openDatabase(target, { now, replicaOf: ticket }), "ACCESS_DENIED");
    expect(target.isEmpty()).toBe(true);
    const replica = await alice.openDatabase(target, { now, replicaOf: ticket });
    await replica.pullFrom(db);
    expect((await replica.getAcl()).noAccess).toEqual(["bob"]);
  });
});

describe("a synced ACL", () => {
  async function batchWithAcl(content: Record<string, unknown>): Promise<{ target: Database; batch: ChangeBatch }> {
    const targetAdapter = newAdapter();
    await db.createReplica(targetAdapter);
    const target = await open(alice, targetAdapter);
    await setAcl({ creators: ["*"] });
    const batch = await db.exportChanges({ since: await target.syncPosition(db.instanceId) });
    const documents = batch.documents.map((doc) => (doc.id === aclDocId(db.databaseId) ? { ...doc, content: content as DocumentEnvelope["content"] } : doc));
    return { target, batch: JSON.parse(JSON.stringify({ ...batch, documents })) as ChangeBatch };
  }

  const lists = { admins: ["alice"], creators: ["*"], writers: ["alice"], readers: ["alice"], noAccess: [] as string[] };

  it("is applied with all five lists", async () => {
    const { target, batch } = await batchWithAcl(lists);
    await target.applyChanges(batch);
    expect((await target.getAcl()).creators).toEqual(["*"]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a missing list", { ...lists, noAccess: undefined }, "INVALID_BATCH"],
    ["an access type this engine doesn't know", { ...lists, approvers: [] }, "UPGRADE_REQUIRED"],
    ['"*" in noAccess', { ...lists, noAccess: ["*"] }, "INVALID_BATCH"],
    ["no admin outside noAccess", { ...lists, admins: ["alice"], noAccess: ["alice"] }, "INVALID_BATCH"],
  ])("is refused with %s", async (_name, content, code) => {
    const cleaned = Object.fromEntries(Object.entries(content).filter(([, value]) => value !== undefined));
    const { target, batch } = await batchWithAcl(cleaned);
    await expectCode(target.applyChanges(batch), code);
  });
});

describe("a stored ACL", () => {
  it.each<[string, (content: Record<string, unknown>) => void]>([
    ["missing a list", (content) => delete content["readers"]],
    ["with an unknown key", (content) => (content["approvers"] = [])],
    ["with a list that isn't strings", (content) => (content["noAccess"] = [1])],
  ])("%s makes the database INVALID_DATABASE", async (_name, change) => {
    const stored = storedAcl();
    const content: Record<string, unknown> = { ...stored.content };
    change(content);
    adapter.putDocument({ ...stored, content: content as DocumentEnvelope["content"] });
    await expectCode(open(alice), "INVALID_DATABASE");
    await expectCode(db.get("x"), "INVALID_DATABASE");
  });
});
