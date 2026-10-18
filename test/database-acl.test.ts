import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Acl } from "../src/acl-document.js";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { Session } from "../src/session.js";
import { aclDocId } from "../src/system-docs.js";
import { TestAdapter, expectCode } from "./helpers.js";

let adapter: TestAdapter;
let time: number;
const now = (): Date => new Date(time);

const alice = Session.named("alice");
const bob = Session.named("bob");
const carol = Session.named("Carol");
const anonymous = Session.anonymous();

function open(session: Session): Promise<Database> {
  return session.openDatabase(adapter, { now });
}

let db: Database;

function storedAcl(): DocumentEnvelope {
  return adapter.getDocument(aclDocId(db.databaseId)) as DocumentEnvelope;
}

beforeEach(async () => {
  adapter = new TestAdapter();
  time = Date.parse("2026-10-17T12:00:00.000Z");
  db = await open(alice);
  time += 60_000;
});

afterEach(() => {
  adapter.close();
});

/** Sets creators as alice. */
async function setCreators(creators: string[]): Promise<void> {
  const acl = await db.getAcl();
  acl.creators = creators;
  await acl.save();
}

describe("reading the ACL", () => {
  it("gives the creator a list with them as creator and admin", async () => {
    const acl = await db.getAcl();
    expect(acl.creators).toEqual(["alice"]);
    expect(acl.admins).toEqual(["alice"]);
    expect(acl.vectorClock).toEqual({ [db.instanceId]: 1 });
    expect(acl.updatedBy).toBe("system");
    expect(acl.updatedOn).toBe(db.instanceId);
    expect(acl.updatedAt).toEqual(new Date("2026-10-17T12:00:00.000Z"));
  });

  it("refuses a named non-admin and an anonymous session", async () => {
    await expectCode((await open(bob)).getAcl(), "ACCESS_DENIED");
    await expectCode((await open(anonymous)).getAcl(), "ACCESS_DENIED");
  });

  it("is not returned by get, even to an admin", async () => {
    expect(await db.get(aclDocId(db.databaseId))).toBeUndefined();
  });

  it("returns a copy of the clock", async () => {
    const acl = await db.getAcl();
    const clock = acl.vectorClock;
    (clock as Record<string, number>)[db.instanceId] = 99;
    expect(acl.vectorClock).toEqual({ [db.instanceId]: 1 });
  });
});

describe("db.myAccess", () => {
  it("gives the creator create and admin, and others neither", async () => {
    expect(await db.myAccess()).toEqual({ create: true, admin: true });
    expect(await (await open(bob)).myAccess()).toEqual({ create: false, admin: false });
    expect(await (await open(anonymous)).myAccess()).toEqual({ create: false, admin: false });
  });

  it('with creators ["*"], gives create to named sessions only', async () => {
    await setCreators(["*"]);
    expect(await db.myAccess()).toEqual({ create: true, admin: true });
    expect(await (await open(bob)).myAccess()).toEqual({ create: true, admin: false });
    expect(await (await open(anonymous)).myAccess()).toEqual({ create: false, admin: false });
  });

  it('with creators ["*", "anonymous"], gives anonymous create but never admin', async () => {
    await setCreators(["*", "anonymous"]);
    const anon = await open(anonymous);
    expect(await anon.myAccess()).toEqual({ create: true, admin: false });
    await expect(anon.create({ x: 1 })).resolves.toBeDefined();
  });

  it("with creators [], gives create to nobody, the admin included", async () => {
    await setCreators([]);
    expect(await db.myAccess()).toEqual({ create: false, admin: true });
    expect(await (await open(bob)).myAccess()).toEqual({ create: false, admin: false });
    expect(await (await open(anonymous)).myAccess()).toEqual({ create: false, admin: false });
    await expectCode(db.create({ x: 1 }), "ACCESS_DENIED");
    expect((await db.getAcl()).creators).toEqual([]);
  });

  it("returns a frozen snapshot", async () => {
    const before = await db.myAccess();
    expect(Object.isFrozen(before)).toBe(true);
    await setCreators(["Bob"]);
    expect(before).toEqual({ create: true, admin: true });
    expect(await db.myAccess()).toEqual({ create: false, admin: true });
  });
});

describe("doc.myAccess", () => {
  it("gives a writer update and delete", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["*"], writers: ["alice"] });
    const access = await doc.myAccess();
    expect(access).toEqual({ read: true, update: true, delete: true });
    expect(Object.isFrozen(access)).toBe(true);
  });

  it("gives a reader who is not a writer read only", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["*", "anonymous"], writers: ["alice"] });
    const bobDoc = await (await open(bob)).get(doc.id);
    expect(await bobDoc?.myAccess()).toEqual({ read: true, update: false, delete: false });
    const anonDoc = await (await open(anonymous)).get(doc.id);
    expect(await anonDoc?.myAccess()).toEqual({ read: true, update: false, delete: false });
  });

  it("follows the stored lists, not unsaved edits", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["*"], writers: ["alice", "Bob"] });
    const bobDoc = (await (await open(bob)).get(doc.id)) as Document<{ x: number }>;
    expect(await bobDoc.myAccess()).toEqual({ read: true, update: true, delete: true });

    bobDoc.writers = ["alice"];
    expect(await bobDoc.myAccess()).toEqual({ read: true, update: true, delete: true });
    await bobDoc.save();
    expect(await bobDoc.myAccess()).toEqual({ read: true, update: false, delete: false });

    doc.writers = ["alice"];
    const before = await doc.myAccess();
    doc.writers = ["Bob"];
    expect(await doc.myAccess()).toEqual(before);
  });
});

describe("editing the ACL", () => {
  it("lets a new creator create, matching names case-insensitively", async () => {
    const bobDb = await open(bob);
    await expectCode(bobDb.create({ x: 1 }), "ACCESS_DENIED");

    await setCreators(["alice", "Bob"]);
    expect((await bobDb.myAccess()).create).toBe(true);
    const doc = await bobDb.create({ x: 1 });
    expect(doc.updatedBy).toBe("bob");
  });

  it("does not make admins creators", async () => {
    const acl = await db.getAcl();
    acl.creators = ["Bob"];
    acl.admins = ["alice", "Bob"];
    await acl.save();
    expect(await db.myAccess()).toEqual({ create: false, admin: true });
    expect(await (await open(bob)).myAccess()).toEqual({ create: true, admin: true });
  });

  it("lets a new admin read and save the ACL", async () => {
    const acl = await db.getAcl();
    acl.admins.push("Carol");
    await acl.save();

    const carolDb = await open(carol);
    const carolAcl = await carolDb.getAcl();
    expect(carolAcl.admins).toEqual(["alice", "Carol"]);
    carolAcl.creators.push("Carol");
    await carolAcl.save();
    expect(await carolDb.myAccess()).toEqual({ create: true, admin: true });
    expect(carolAcl.updatedBy).toBe("Carol");
  });

  it("refuses an admin removing themselves, even with another admin left", async () => {
    const acl = await db.getAcl();
    acl.admins = ["alice", "Carol"];
    await acl.save();
    const before = storedAcl();

    acl.admins = ["Carol"];
    const error = await expectCode(acl.save(), "ACCESS_DENIED");
    expect(error.message).toMatch(/cannot remove themselves.*another admin/);
    expect(storedAcl()).toEqual(before);
    expect(acl.vectorClock).toEqual(before.vectorClock);
    expect(acl.updatedBy).toBe("alice");
  });

  it("refuses new admins that leave out the saving admin, such as a typo", async () => {
    const acl = await db.getAcl();
    acl.admins = ["Alcie"];
    await expectCode(acl.save(), "ACCESS_DENIED");
    expect(storedAcl().content).toEqual({ creators: ["alice"], admins: ["alice"] });

    acl.admins = ["alice", "Alcie"];
    await acl.save();
    expect(storedAcl().content).toEqual({ creators: ["alice"], admins: ["alice", "Alcie"] });
  });

  it("lets another admin remove an admin, whose loaded ACL is then stale", async () => {
    const setup = await db.getAcl();
    setup.admins = ["alice", "Carol"];
    await setup.save();

    const aliceAcl = await db.getAcl();
    const carolAcl = await (await open(carol)).getAcl();
    carolAcl.admins = ["Carol"];
    await carolAcl.save();
    expect(storedAcl().content).toEqual({ creators: ["alice"], admins: ["Carol"] });
    await expectCode(db.getAcl(), "ACCESS_DENIED");
    expect(await db.myAccess()).toEqual({ create: true, admin: false });

    // The clock check comes before the admins check.
    aliceAcl.creators = ["*"];
    await expectCode(aliceAcl.save(), "STALE_DOCUMENT");
    expect(storedAcl().content).toEqual({ creators: ["alice"], admins: ["Carol"] });
  });

  it("checks the stored admins on save", async () => {
    // Not reachable through the API: an admin can't remove themselves, and
    // removal by another admin makes their loaded ACL stale. Write the ACL
    // document directly, keeping its clock, so alice's save isn't stale.
    const acl = await db.getAcl();
    const before = storedAcl();
    adapter.putDocument({ ...before, content: { creators: ["alice"], admins: ["Carol"] } });

    acl.creators = ["*"];
    const error = await expectCode(acl.save(), "ACCESS_DENIED");
    expect(error.message).toMatch(/cannot edit the ACL/);
    expect(storedAcl().content).toEqual({ creators: ["alice"], admins: ["Carol"] });
    expect(storedAcl().vectorClock).toEqual(before.vectorClock);
  });

  it("refuses the second of two saves from the same version", async () => {
    const first = await db.getAcl();
    const second = await db.getAcl();
    first.creators = ["*"];
    await first.save();
    second.creators = ["Bob"];
    await expectCode(second.save(), "STALE_DOCUMENT");
    expect(second.creators).toEqual(["Bob"]);
    expect(second.vectorClock).toEqual({ [db.instanceId]: 1 });
    expect(storedAcl().content).toEqual({ creators: ["*"], admins: ["alice"] });
  });

  it("writes as the admin, bumps the clock, and appends one change", async () => {
    const changeCount = adapter.changesSince(0).length;
    const acl = await db.getAcl();
    acl.creators = ["*"];
    acl.admins = ["alice", "Carol"];
    await acl.save();

    expect(acl.updatedBy).toBe("alice");
    expect(acl.updatedOn).toBe(db.instanceId);
    expect(acl.updatedAt).toEqual(new Date("2026-10-17T12:01:00.000Z"));
    expect(acl.vectorClock).toEqual({ [db.instanceId]: 2 });

    const stored = storedAcl();
    expect(stored).toMatchObject({
      kind: "system",
      parentId: stored.id,
      deleted: false,
      readers: ["alice", "Carol"],
      writers: ["alice", "Carol"],
      content: { creators: ["*"], admins: ["alice", "Carol"] },
      fieldTypes: {},
      vectorClock: { [db.instanceId]: 2 },
      updatedBy: "alice",
      updatedOn: db.instanceId,
    });

    const changes = adapter.changesSince(0).slice(changeCount);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      docId: stored.id,
      op: "put",
      vectorClock: { [db.instanceId]: 2 },
      updatedBy: "alice",
      instanceId: db.instanceId,
    });
  });

  it("stamps updatedBy with the name as stored in the session", async () => {
    const acl = await db.getAcl();
    acl.admins = ["alice", "Carol"];
    await acl.save();

    const carolAcl = await (await open(Session.named("CAROL"))).getAcl();
    await carolAcl.save();
    expect(carolAcl.updatedBy).toBe("CAROL");
    expect(storedAcl().updatedBy).toBe("CAROL");
  });

  it("stores and shows names in NFKC form", async () => {
    const fullwidthCarol = String.fromCodePoint(0xff23, 0xff41, 0xff52, 0xff4f, 0xff4c);
    const acl = await db.getAcl();
    acl.creators = [fullwidthCarol];
    acl.admins = ["alice", fullwidthCarol];
    await acl.save();
    expect(acl.creators).toEqual(["Carol"]);
    expect(acl.admins).toEqual(["alice", "Carol"]);
    expect(storedAcl().content).toEqual({ creators: ["Carol"], admins: ["alice", "Carol"] });
    expect(storedAcl().readers).toEqual(["alice", "Carol"]);
  });
});

describe("validation", () => {
  // Each case is saved by alice and must leave the stored ACL as it was.
  async function expectRefused(creators: unknown, admins: unknown, field: "creators" | "admins"): Promise<void> {
    const before = storedAcl();
    const acl = await db.getAcl();
    (acl as { creators: unknown }).creators = creators;
    (acl as { admins: unknown }).admins = admins;
    const error = await expectCode(acl.save(), "INVALID_ACCESS_LIST");
    expect(error.message).toMatch(new RegExp(`^${field} `));
    expect(storedAcl()).toEqual(before);
    expect(acl.vectorClock).toEqual(before.vectorClock);
  }

  it("refuses empty admins", async () => {
    await expectRefused(["alice"], [], "admins");
  });

  // U+FF0A FULLWIDTH ASTERISK is "*" in NFKC form.
  it.each([[["*"]], [["anonymous"]], [["ANONYMOUS"]], [[String.fromCodePoint(0xff0a)]], [["alice", "*"]]])(
    "refuses admins %j",
    async (admins) => {
      await expectRefused(["alice"], admins, "admins");
    },
  );

  it("refuses duplicate admins and creators by canonical form", async () => {
    await expectRefused(["alice"], ["Alice", "alice"], "admins");
    await expectRefused(["Bob", "BOB"], ["alice"], "creators");
  });

  it("refuses reserved names and roles", async () => {
    await expectRefused(["system"], ["alice"], "creators");
    await expectRefused(["alice"], ["[Admin]"], "admins");
  });

  it("refuses lists that are not arrays of strings", async () => {
    await expectRefused("alice", ["alice"], "creators");
    await expectRefused(["alice"], "alice", "admins");
    await expectRefused([1], ["alice"], "creators");
  });

  it("checks names against the database's Unicode version", async () => {
    // U+A7CF LATIN SMALL LETTER PHARYNGEAL VOICED FRICATIVE, new in 17.0.
    const new17 = "Bob" + String.fromCodePoint(0xa7cf);
    const databaseDoc = adapter.getDocument(db.databaseId) as DocumentEnvelope;
    adapter.putDocument({ ...databaseDoc, content: { ...databaseDoc.content, unicodeVersion: "16.0" } });
    db = await open(alice);

    await expectRefused([new17], ["alice"], "creators");
    await expectRefused(["alice"], ["alice", new17], "admins");
  });
});

describe("atomicity", () => {
  it("leaves the stored ACL and the object as they were when a save fails", async () => {
    const before = storedAcl();
    const changeCount = adapter.changesSince(0).length;
    const acl: Acl = await db.getAcl();
    acl.creators = ["*"];
    acl.admins = ["alice", "Carol"];

    adapter.failAppendChange = true;
    await expect(acl.save()).rejects.toThrow("appendChange failed");
    expect(storedAcl()).toEqual(before);
    expect(adapter.changesSince(0).length).toBe(changeCount);
    expect(acl.vectorClock).toEqual({ [db.instanceId]: 1 });
    expect(acl.updatedBy).toBe("system");
    expect(acl.creators).toEqual(["*"]);

    adapter.failAppendChange = false;
    await acl.save(); // still loaded at the stored clock, so not stale
    expect(storedAcl().content).toEqual({ creators: ["*"], admins: ["alice", "Carol"] });
    expect(acl.vectorClock).toEqual({ [db.instanceId]: 2 });
  });
});
