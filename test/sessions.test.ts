import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import { sync } from "../src/replication.js";
import { Session } from "../src/session.js";
import { TestAdapter, expectCode } from "./helpers.js";

// Several Database objects on one adapter, one per user, as a server serving
// many users from one file would open them. Nothing is cached between calls,
// so each sees the others' writes at once and checks its own principal.

type Content = Record<string, unknown>;

const alice = Session.named("alice");
const bob = Session.named("bob");
const carol = Session.named("carol");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);
function tick(): void {
  time += 1000;
}

beforeEach(() => {
  adapters = [];
  time = Date.parse("2026-10-30T12:00:00.000Z");
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

function newAdapter(): TestAdapter {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return adapter;
}

/** alice founds the database and makes bob a creator and an admin; then both open it. */
async function shared(): Promise<{ adapter: TestAdapter; alices: Database; bobs: Database }> {
  const adapter = newAdapter();
  const alices = await alice.openDatabase(adapter, { now });
  const acl = await alices.getAcl();
  acl.creators = ["alice", "bob"];
  acl.admins = ["alice", "bob"];
  await acl.save();
  return { adapter, alices, bobs: await bob.openDatabase(adapter, { now }) };
}

async function load(db: Database, id: string): Promise<Document<Content>> {
  const doc = await db.get<Content>(id);
  if (doc === undefined) {
    throw new Error(`document ${id} not readable`);
  }
  return doc;
}

describe("many sessions on one adapter", () => {
  it("see each other's writes at once", async () => {
    const { alices, bobs } = await shared();
    const doc = await alices.create({ n: 1 });
    const held = await load(alices, doc.id);
    expect((await load(bobs, doc.id)).content).toEqual({ n: 1 });

    tick();
    const bobsCopy = await load(bobs, doc.id);
    bobsCopy.content = { n: 2 };
    await bobsCopy.save();
    expect((await load(alices, doc.id)).content).toEqual({ n: 2 });
    expect((await load(alices, doc.id)).updatedBy).toBe("bob");
    held.content = { n: 3 };
    await expectCode(held.save(), "STALE_DOCUMENT");

    await bobsCopy.delete();
    expect(await alices.get(doc.id)).toBeUndefined();
    expect((await alices.find()).count).toBe(0);
  });

  it("each enforce their own principal's access to documents", async () => {
    const { adapter, alices, bobs } = await shared();
    const doc = await alices.create({ n: 1 }, { readers: ["alice", "bob"], writers: ["alice", "bob"] });
    const open = await alices.create({ n: 0 });
    const carols = await carol.openDatabase(adapter, { now });
    expect(await carols.get(doc.id)).toBeUndefined();
    expect((await load(carols, open.id)).content).toEqual({ n: 0 });
    await expectCode(carols.create({ n: 1 }), "ACCESS_DENIED");
    const bobsCopy = await load(bobs, doc.id);

    tick();
    const alicesCopy = await load(alices, doc.id);
    alicesCopy.readers = ["alice"];
    await alicesCopy.save();
    expect(await bobs.get(doc.id)).toBeUndefined();
    expect((await bobs.find()).count).toBe(1);
    expect((await alices.find()).count).toBe(2);
    // bob's copy was loaded before the change; the stored version wins.
    bobsCopy.content = { n: 2 };
    await expectCode(bobsCopy.save(), "STALE_DOCUMENT");
  });

  it("apply ACL changes made through another at once", async () => {
    const { adapter, alices, bobs } = await shared();
    await expect(bobs.create({ n: 1 })).resolves.toBeDefined();
    expect(await bobs.myAccess()).toEqual({ create: true, admin: true });

    tick();
    const acl = await alices.getAcl();
    acl.creators = ["alice"];
    acl.admins = ["alice"];
    await acl.save();

    await expectCode(bobs.create({ n: 2 }), "ACCESS_DENIED");
    expect(await bobs.myAccess()).toEqual({ create: false, admin: false });
    await expectCode(bobs.getAcl(), "ACCESS_DENIED");
    await expectCode(bobs.exportChanges(), "ACCESS_DENIED");
    await expectCode(bobs.createReplica(newAdapter()), "ACCESS_DENIED");
    // A database opened after the change agrees.
    await expectCode((await bob.openDatabase(adapter, { now })).create({ n: 3 }), "ACCESS_DENIED");
  });

  it("see incoming syncs and conflicts at once, whichever session pulled", async () => {
    const { alices, bobs } = await shared();
    const other = newAdapter();
    tick();
    await alices.createReplica(other);
    const remote = await alice.openDatabase(other, { now });

    tick();
    const doc = await remote.create({ n: 1 });
    await bobs.pullFrom(remote);
    expect((await load(alices, doc.id)).content).toEqual({ n: 1 });
    // The position bob's pull stored is the one alice's next pull starts from.
    expect(await alices.syncPosition(remote.instanceId)).toBe(await bobs.syncPosition(remote.instanceId));
    expect(await alices.pullFrom(remote)).toEqual({ applied: 0, skipped: 0, batches: 1 });

    tick();
    const local = await load(alices, doc.id);
    local.content = { n: 2 };
    await local.save();
    tick();
    const far = await load(remote, doc.id);
    far.content = { n: 3 };
    await far.save();
    await sync(alices, remote);

    const bobsConflict = await (await load(bobs, doc.id)).conflict();
    expect(bobsConflict?.versions.map((version) => version.document.content)).toEqual([{ n: 3 }, { n: 2 }]);
    expect((await bobs.find({ inConflict: true })).count).toBe(1);

    // Resolved through alice's, bob's conflict is stale and the document is out of conflict for bob.
    tick();
    await (await (await load(alices, doc.id)).conflict())?.resolveWithContent({ content: { n: 4 } });
    await expectCode((bobsConflict as NonNullable<typeof bobsConflict>).resolveByDeleting(), "STALE_DOCUMENT");
    expect(await (await load(bobs, doc.id)).conflict()).toBeUndefined();
    expect((await load(bobs, doc.id)).content).toEqual({ n: 4 });
  });
});
