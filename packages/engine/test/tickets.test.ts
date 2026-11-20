import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/conflict-policy.js";
import type { Database } from "../src/database.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import { SUPPORTED_LEVELS, VERSION } from "../src/engine.js";
import { sync } from "../src/replication.js";
import { Session } from "../src/session.js";
import { aclDocId, databaseDocId, registrationDocId } from "../src/system-docs.js";
import type { ReplicaTicket } from "../src/ticket.js";
import { TestAdapter, admitEveryone, expectCode, seedAdapter } from "./helpers.js";

const alice = Session.withId("alice");
const bob = Session.withId("bob");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);
function tick(): void {
  time += 1000;
}

beforeEach(() => {
  adapters = [];
  time = Date.parse("2026-11-16T12:00:00.000Z");
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

function newAdapter(seed?: "alice"): TestAdapter {
  const adapter = seed === undefined ? new TestAdapter() : seedAdapter(seed);
  adapters.push(adapter);
  return adapter;
}

/** As it would arrive over a network: JSON text, parsed. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A mutable copy of a ticket, for making bad ones. */
function mutable(ticket: ReplicaTicket): Record<string, unknown> & { documents: Record<string, unknown>[] } {
  return roundTrip(ticket) as unknown as Record<string, unknown> & { documents: Record<string, unknown>[] };
}

/** session founds a database that admits everyone, as a database below level 3 does. */
async function founder(session: Session = alice): Promise<{ db: Database; adapter: TestAdapter }> {
  const adapter = newAdapter();
  return { db: await admitEveryone(await session.openDatabase(adapter, { now, replicaName: "A" })), adapter };
}

/** Registers a replica on source and opens it from the ticket, after a JSON round trip. */
async function fromTicket(source: Database, session: Session = alice, name?: string): Promise<{ db: Database; adapter: TestAdapter }> {
  tick();
  const ticket = roundTrip(await source.registerReplica(name === undefined ? {} : { name }));
  const adapter = newAdapter();
  tick();
  return { db: await session.openDatabase(adapter, { now, replicaOf: ticket }), adapter };
}

async function contents(db: Database): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const doc of await db.find()) {
    result.push({ id: doc.id, content: doc.content, version: doc.version, readers: doc.readers });
  }
  return result;
}

/** Every stored row, system documents included, by ID. */
function rows(adapter: TestAdapter): DocumentEnvelope[] {
  return adapter.allDocuments();
}

/** Opens a ticket on a new adapter, expects the code, and checks the adapter stayed empty. */
async function expectOpenRefused(ticket: unknown, code: string, session: Session = alice): Promise<CromDBError> {
  const adapter = newAdapter();
  const error = await expectCode(session.openDatabase(adapter, { now, replicaOf: ticket as ReplicaTicket }), code);
  expect(adapter.isEmpty()).toBe(true);
  return error;
}

describe("registerReplica", () => {
  it("returns a frozen plain-JSON ticket holding the four system documents", async () => {
    const a = await founder();
    const ticket = await a.db.registerReplica({ name: "B" });
    expect(roundTrip(ticket)).toEqual(ticket);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.documents[1]?.content)).toBe(true);
    expect(ticket).toMatchObject({
      ticket: 1,
      databaseId: a.db.databaseId,
      introducedBy: a.db.instanceId,
      level: 3,
      conflictPolicy: DEFAULT_POLICY,
      engine: VERSION,
    });
    expect(ticket.instanceId).not.toBe(a.db.instanceId);
    expect(ticket.documents.map((doc) => doc.id)).toEqual([
      databaseDocId(a.db.databaseId),
      aclDocId(a.db.databaseId),
      registrationDocId(a.db.databaseId, a.db.instanceId),
      registrationDocId(a.db.databaseId, ticket.instanceId),
    ]);
    expect(ticket.documents.map((doc) => a.adapter.getDocument(doc.id))).toEqual(ticket.documents);
  });

  it("writes the registration as createReplica does", async () => {
    const a = await founder();
    tick();
    const target = newAdapter();
    await a.db.createReplica(target, { name: "B" });
    const copied = target.getLocal("instanceId") as string;
    tick();
    const ticket = await a.db.registerReplica({ name: "C" });
    const byCopy = a.adapter.getDocument(registrationDocId(a.db.databaseId, copied)) as DocumentEnvelope;
    const byTicket = a.adapter.getDocument(registrationDocId(a.db.databaseId, ticket.instanceId)) as DocumentEnvelope;
    const shape = (row: DocumentEnvelope) => ({ ...row, id: "", parentId: "", vectorClock: {}, createdAt: "", updatedAt: "", content: Object.keys(row.content) });
    expect(shape(byTicket)).toEqual(shape(byCopy));
    expect(byTicket.content).toMatchObject({ instanceId: ticket.instanceId, status: "active", introducedBy: a.db.instanceId, name: "C" });
    expect(Object.hasOwn(byTicket.content, "maxLevel")).toBe(false);
  });

  it("refuses a non-admin with ACCESS_DENIED, writing nothing", async () => {
    const a = await founder();
    const asBob = await bob.openDatabase(a.adapter, { now });
    const before = rows(a.adapter);
    await expectCode(asBob.registerReplica(), "ACCESS_DENIED");
    expect(rows(a.adapter)).toEqual(before);
  });

  it("refuses bad options and names with TypeError, writing nothing", async () => {
    const a = await founder();
    const before = rows(a.adapter);
    await expect(a.db.registerReplica(null as never)).rejects.toThrow(TypeError);
    await expect(a.db.registerReplica({ name: " padded" })).rejects.toThrow(TypeError);
    await expect(a.db.registerReplica({ name: "" })).rejects.toThrow(TypeError);
    expect(rows(a.adapter)).toEqual(before);
  });
});

describe("opening a replica from a ticket", () => {
  it("gives a complete replica with no user documents, then the same state as createReplica after the first pull", async () => {
    const a = await founder();
    const acl = await a.db.getAcl();
    acl.admins = ["alice", "carol"];
    acl.creators = ["*"];
    await acl.save();
    tick();
    const parent = await a.db.create({ title: "parent", due: new Date("2026-11-01T00:00:00.000Z") });
    await a.db.create({ title: "child" }, { parentId: parent.id, readers: ["alice"] });
    const gone = await a.db.create({ title: "gone" });
    tick();
    await gone.delete();

    const copy = newAdapter();
    tick();
    await a.db.createReplica(copy, { name: "B" });
    const b = await alice.openDatabase(copy, { now });
    const c = await fromTicket(a.db, alice, "C");

    expect(c.db.databaseId).toBe(a.db.databaseId);
    expect(c.db.level).toBe(3);
    expect(await contents(c.db)).toEqual([]);
    expect((await c.db.getAcl()).admins).toEqual(["alice", "carol"]);
    expect((await c.db.replicas()).map((replica) => replica.name)).toEqual(["A", "C"]);
    // Its first open recorded its maxLevel, as every new replica's does.
    const own = c.adapter.getDocument(registrationDocId(a.db.databaseId, c.db.instanceId)) as DocumentEnvelope;
    expect(own.content["maxLevel"]).toBe(SUPPORTED_LEVELS.max);
    expect(own.updatedOn).toBe(c.db.instanceId);
    expect(c.adapter.marks).toEqual([3]);

    const pulled = await c.db.pullFrom(a.db);
    expect(pulled.applied).toBeGreaterThan(0);
    expect(await contents(c.db)).toEqual(await contents(b));
    expect(await contents(c.db)).toEqual(await contents(a.db));
    expect((await c.db.getAcl()).version).toBe((await a.db.getAcl()).version);
    // The deleted document arrived as a tombstone, as createReplica copies it.
    expect(c.adapter.getDocument(gone.id)?.deleted).toBe(true);

    // All three converge.
    await sync(a.db, c.db);
    await sync(a.db, b);
    await sync(b, c.db);
    const names = async (db: Database) => (await db.replicas()).map((replica) => replica.name);
    expect(await names(a.db)).toEqual(["A", "B", "C"]);
    expect(await names(b)).toEqual(["A", "B", "C"]);
    expect(await names(c.db)).toEqual(["A", "B", "C"]);
    const docs = (adapter: TestAdapter) => adapter.allDocuments().filter((row) => row.kind === "document");
    expect(docs(c.adapter)).toEqual(docs(a.adapter));
    expect(docs(copy)).toEqual(docs(a.adapter));
  });

  it("syncs writes made on the new replica back, and across to the others", async () => {
    const a = await founder();
    const copy = newAdapter();
    await a.db.createReplica(copy);
    const b = await alice.openDatabase(copy, { now });
    const c = await fromTicket(a.db);
    await c.db.pullFrom(a.db);
    tick();
    const note = await c.db.create({ text: "from C" });
    await a.db.pullFrom(c.db);
    await b.pullFrom(a.db);
    expect((await b.get(note.id))?.content).toEqual({ text: "from C" });
    // Once B has learned of C through A, they sync directly.
    await c.db.pullFrom(b);
    await sync(b, c.db);
  });

  it("fills over several batches, and an interrupted first pull resumes", async () => {
    const a = await founder();
    for (let index = 0; index < 12; index++) {
      tick();
      await a.db.create({ index });
    }
    const c = await fromTicket(a.db);
    await c.db.checkPeer(await a.db.syncHello());
    // Two batches of 5, then stop.
    for (let batch = 0; batch < 2; batch++) {
      const since = await c.db.syncPosition(a.db.instanceId);
      const result = await c.db.applyChanges(roundTrip(await a.db.exportChanges({ since, limit: 5 })));
      expect(result.hasMore).toBe(true);
    }
    expect((await contents(c.db)).length).toBeGreaterThan(0);
    expect((await contents(c.db)).length).toBeLessThan(12);
    // A restart: the replica opens as it is, and the pull goes on from where it stopped.
    const reopened = await alice.openDatabase(c.adapter, { now });
    let batches = 0;
    for (;;) {
      const since = await reopened.syncPosition(a.db.instanceId);
      const result = await reopened.applyChanges(roundTrip(await a.db.exportChanges({ since, limit: 5 })));
      batches++;
      if (!result.hasMore) {
        break;
      }
    }
    expect(batches).toBeGreaterThan(1);
    expect(await contents(reopened)).toEqual(await contents(a.db));
  });

  it("works at level 1, with a named session", async () => {
    const seed = newAdapter("alice");
    const named = Session.named("Alice");
    const a = await named.openDatabase(seed, { now });
    expect(a.level).toBe(1);
    tick();
    await a.create({ title: "old" });
    const ticket = roundTrip(await a.registerReplica({ name: "B" }));
    expect(ticket.level).toBe(1);
    const newRegistration = ticket.documents[3] as DocumentEnvelope;
    expect(Object.hasOwn(newRegistration.content, "maxLevel")).toBe(false);
    const target = newAdapter();
    const b = await named.openDatabase(target, { now, replicaOf: ticket });
    expect(b.level).toBe(1);
    expect(target.marks).toEqual([]);
    await b.pullFrom(a);
    await a.pullFrom(b);
    expect(await contents(b)).toEqual(await contents(a));
    // Level 1 needs a named session.
    await expectOpenRefused(roundTrip(await a.registerReplica()), "INVALID_PRINCIPAL", alice);
  });

  it("knows only the introducer at first: other replicas are refused until they have met through it", async () => {
    const a = await founder();
    const copy = newAdapter();
    await a.db.createReplica(copy, { name: "B" });
    const b = await alice.openDatabase(copy, { now });
    await sync(a.db, b);
    const c = await fromTicket(a.db, alice, "C");
    await expectCode(c.db.pullFrom(b), "SYNC_MISMATCH");
    await expectCode(b.pullFrom(c.db), "SYNC_MISMATCH");
    await c.db.pullFrom(a.db);
    await b.pullFrom(a.db);
    await sync(b, c.db);
  });

  it("picks up an ACL changed after the ticket was written", async () => {
    const a = await founder();
    tick();
    const ticket = roundTrip(await a.db.registerReplica());
    tick();
    const acl = await a.db.getAcl();
    acl.creators = ["alice", "bob"];
    await acl.save();
    const target = newAdapter();
    const c = await alice.openDatabase(target, { now, replicaOf: ticket });
    expect((await c.getAcl()).creators).toEqual(["alice"]);
    await c.pullFrom(a.db);
    expect((await c.getAcl()).creators).toEqual(["alice", "bob"]);
  });

  it("stops syncing once a later ACL drops the session from admins", async () => {
    const a = await founder();
    const acl = await a.db.getAcl();
    acl.admins = ["alice", "bob"];
    await acl.save();
    const c = await fromTicket(a.db, bob);
    tick();
    const later = await a.db.getAcl();
    later.admins = ["alice"];
    await later.save();
    await c.db.pullFrom(a.db);
    await expectCode(c.db.pullFrom(a.db), "ACCESS_DENIED");
  });

  it("leaves an unused ticket's registration as a replica that never syncs, harming nothing", async () => {
    const a = await founder();
    const copy = newAdapter();
    tick();
    await a.db.createReplica(copy, { name: "B" });
    const b = await alice.openDatabase(copy, { now });
    tick();
    const lost = await a.db.registerReplica({ name: "lost" });
    tick();
    await a.db.create({ text: "after" });
    await sync(a.db, b);
    expect((await b.replicas()).map((replica) => replica.name)).toEqual(["A", "B", "lost"]);
    expect((await b.replicas()).find((replica) => replica.instanceId === lost.instanceId)?.maxLevel).toBeUndefined();
    expect(await contents(b)).toEqual(await contents(a.db));
  });

  it("makes two replicas with one identity when a ticket is used twice, which sync can catch", async () => {
    const a = await founder();
    const shared = await a.db.create({ text: "shared" });
    const ticket = roundTrip(await a.db.registerReplica());
    const first = await alice.openDatabase(newAdapter(), { now, replicaOf: ticket });
    const second = await alice.openDatabase(newAdapter(), { now, replicaOf: ticket });
    expect(first.instanceId).toBe(second.instanceId);
    await first.pullFrom(a.db);
    await second.pullFrom(a.db);
    tick();
    const edited = await first.get<{ text: string }>(shared.id);
    if (edited === undefined) {
      throw new Error("missing");
    }
    edited.content.text = "edited on the first";
    await edited.save();
    await a.db.pullFrom(first);
    // The second receives its own counter, which it never reached.
    await expectCode(second.pullFrom(a.db), "REWIND_DETECTED");
  });
});

describe("refusing to open a ticket", () => {
  async function aTicket(): Promise<{ db: Database; ticket: ReplicaTicket }> {
    const a = await founder();
    return { db: a.db, ticket: roundTrip(await a.db.registerReplica({ name: "B" })) };
  }

  it("refuses a target that isn't empty with INVALID_DATABASE, changing nothing", async () => {
    const { ticket } = await aTicket();
    const target = newAdapter();
    target.setLocal("something", "x");
    await expectCode(alice.openDatabase(target, { now, replicaOf: ticket }), "INVALID_DATABASE");
    expect(target.allDocuments()).toEqual([]);
    expect(target.getLocal("instanceId")).toBeUndefined();
  });

  it("refuses the same adapter twice", async () => {
    const { ticket } = await aTicket();
    const target = newAdapter();
    await alice.openDatabase(target, { now, replicaOf: ticket });
    await expectCode(alice.openDatabase(target, { now, replicaOf: ticket }), "INVALID_DATABASE");
  });

  it("refuses replicaName with replicaOf with TypeError", async () => {
    const { ticket } = await aTicket();
    const target = newAdapter();
    await expect(alice.openDatabase(target, { now, replicaOf: ticket, replicaName: "B" })).rejects.toThrow(TypeError);
    expect(target.isEmpty()).toBe(true);
  });

  it("refuses a session that isn't an admin with ACCESS_DENIED, anonymous included", async () => {
    const { ticket } = await aTicket();
    await expectOpenRefused(ticket, "ACCESS_DENIED", bob);
    await expectOpenRefused(ticket, "ACCESS_DENIED", Session.anonymous());
  });

  it("refuses a named session at level 2 with INVALID_PRINCIPAL", async () => {
    const { ticket } = await aTicket();
    await expectOpenRefused(ticket, "INVALID_PRINCIPAL", Session.named("alice"));
  });

  it.each([
    ["a later ticket format", (t: Record<string, unknown>) => (t["ticket"] = 2)],
    ["a level above this engine", (t: Record<string, unknown>) => (t["level"] = SUPPORTED_LEVELS.max + 1)],
    ["an unknown conflict policy", (t: Record<string, unknown>) => (t["conflictPolicy"] = "newer")],
    ["a later Unicode version", (t: Record<string, unknown>) => (t["unicodeVersion"] = "99.0")],
  ])("refuses %s with UPGRADE_REQUIRED", async (_name, change) => {
    const { ticket } = await aTicket();
    const bad = mutable(ticket);
    change(bad);
    await expectOpenRefused(bad, "UPGRADE_REQUIRED");
  });

  type Mutation = (t: Record<string, unknown> & { documents: Record<string, unknown>[] }) => void;
  const doc = (t: { documents: Record<string, unknown>[] }, index: number) => t.documents[index] as Record<string, unknown>;
  const content = (t: { documents: Record<string, unknown>[] }, index: number) => doc(t, index)["content"] as Record<string, unknown>;
  // An unknown field in a system document reads as a later engine's, as in
  // batches: UPGRADE_REQUIRED. Everything else is INVALID_TICKET.
  const cases: [string, Mutation, string?][] = [
    ["format 0", (t) => (t["ticket"] = 0)],
    ["no format", (t) => delete t["ticket"]],
    ["an unknown field", (t) => (t["extra"] = true)],
    ["a databaseId that isn't a UUID", (t) => (t["databaseId"] = "x")],
    ["another database's ID", (t) => (t["databaseId"] = "00000000-0000-4000-8000-000000000000")],
    ["the introducer as the new replica", (t) => (t["instanceId"] = t["introducedBy"])],
    ["another instanceId", (t) => (t["instanceId"] = "00000000-0000-4000-8000-000000000001")],
    ["another introducer", (t) => (t["introducedBy"] = "00000000-0000-4000-8000-000000000002")],
    ["level 1 with level-2 documents", (t) => (t["level"] = 1)],
    ["another Unicode version", (t) => (t["unicodeVersion"] = "16.0")],
    ["an empty engine", (t) => (t["engine"] = "")],
    ["documents not an array", (t) => ((t as Record<string, unknown>)["documents"] = {})],
    ["a missing document", (t) => t.documents.pop()],
    ["an extra document", (t) => t.documents.push(t.documents[0] as Record<string, unknown>)],
    ["documents out of order", (t) => t.documents.reverse()],
    ["a deleted document", (t) => Object.assign(doc(t, 1), { deleted: true, deletedAt: doc(t, 1)["updatedAt"] })],
    ["a document of kind document", (t) => (doc(t, 1)["kind"] = "document")],
    ["a malformed clock", (t) => (doc(t, 1)["vectorClock"] = { x: 1 })],
    ["a clock entry for the new replica", (t) => ((doc(t, 1)["vectorClock"] as Record<string, number>)[t["instanceId"] as string] = 1)],
    ["an unauthorized version", (t) => (doc(t, 1)["updatedBy"] = "mallory")],
    ["an ACL with no admins", (t) => (content(t, 1)["admins"] = [])],
    ["a database document at another level", (t) => (content(t, 0)["level"] = 1)],
    ["a database document for another database", (t) => (content(t, 0)["databaseId"] = "00000000-0000-4000-8000-000000000000")],
    ["a retired introducer", (t) => (content(t, 2)["status"] = "retired")],
    ["a retired new replica", (t) => (content(t, 3)["status"] = "retired")],
    ["a new replica introduced by another", (t) => (content(t, 3)["introducedBy"] = "00000000-0000-4000-8000-000000000002")],
    ["an unknown registration field", (t) => (content(t, 3)["extra"] = 1), "UPGRADE_REQUIRED"],
  ];
  it.each(cases)("refuses %s, writing nothing", async (_name, change, code = "INVALID_TICKET") => {
    const { ticket } = await aTicket();
    const bad = mutable(ticket);
    change(bad);
    await expectOpenRefused(bad, code);
  });

  it("refuses a ticket that isn't a plain object, and a getter, with INVALID_TICKET", async () => {
    const { ticket } = await aTicket();
    await expectOpenRefused("ticket", "INVALID_TICKET");
    await expectOpenRefused([ticket], "INVALID_TICKET");
    const withGetter = mutable(ticket);
    Object.defineProperty(withGetter, "engine", { get: () => "x", enumerable: true });
    await expectOpenRefused(withGetter, "INVALID_TICKET");
  });

  it("never writes part of a mutated ticket: it opens whole, or is refused with a ticket, upgrade or access code", async () => {
    const { ticket } = await aTicket();
    const base = mutable(ticket);
    // Every path to a value in the ticket.
    const paths: (string | number)[][] = [];
    const walk = (value: unknown, path: (string | number)[]): void => {
      paths.push(path);
      if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
        }
      }
    };
    walk(base, []);
    const settable = paths.filter((path) => path.length > 0);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...settable),
        fc.oneof(fc.jsonValue(), fc.constant(undefined)),
        async (path, replacement) => {
          const bad = mutable(ticket) as unknown as Record<string | number, unknown>;
          let parent: Record<string | number, unknown> = bad;
          for (const key of path.slice(0, -1)) {
            parent = parent[key] as Record<string | number, unknown>;
          }
          const last = path[path.length - 1] as string | number;
          if (replacement === undefined) {
            delete parent[last];
          } else {
            parent[last] = replacement;
          }
          const adapter = new TestAdapter();
          try {
            const error: unknown = await alice.openDatabase(adapter, { now, replicaOf: bad as unknown as ReplicaTicket }).then(
              () => undefined,
              (reason: unknown) => reason,
            );
            if (error === undefined) {
              expect(adapter.isEmpty()).toBe(false);
              return;
            }
            expect(error).toBeInstanceOf(CromDBError);
            expect(["INVALID_TICKET", "UPGRADE_REQUIRED", "ACCESS_DENIED"]).toContain((error as CromDBError).code);
            expect(adapter.isEmpty()).toBe(true);
          } finally {
            adapter.close();
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
