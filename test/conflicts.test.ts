import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthorizedVersion } from "../src/acl.js";
import { conflictRowId } from "../src/conflict.js";
import type { Conflict } from "../src/conflict-object.js";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import { newId } from "../src/ids.js";
import { parsePeerPosition, peerKey, sync, type ChangeBatch } from "../src/replication.js";
import { Session } from "../src/session.js";
import type { StorageAdapter } from "../src/storage/adapter.js";
import { aclDocId } from "../src/system-docs.js";
import { canonicalString, compare, totalEdits, type VectorClock } from "../src/vector-clock.js";
import { conflictVersion, documentVersion } from "../src/version.js";
import { TestAdapter, expectCode } from "./helpers.js";

type Content = Record<string, unknown>;

const alice = Session.named("alice");
const bob = Session.named("bob");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);
function tick(): void {
  time += 1000;
}

beforeEach(() => {
  adapters = [];
  time = Date.parse("2026-10-19T12:00:00.000Z");
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
});

interface Replica {
  db: Database;
  adapter: TestAdapter;
}

/** Opens the database with exportChanges returning a JSON round-tripped batch. */
async function openAs(session: Session, adapter: StorageAdapter): Promise<Database> {
  const db = await session.openDatabase(adapter, { now });
  const exportChanges = db.exportChanges.bind(db);
  db.exportChanges = async (options) => JSON.parse(JSON.stringify(await exportChanges(options))) as ChangeBatch;
  return db;
}

async function founder(): Promise<Replica> {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return { db: await openAs(alice, adapter), adapter };
}

async function replicaOf(source: Database): Promise<Replica> {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  tick();
  await source.createReplica(adapter);
  return { db: await openAs(alice, adapter), adapter };
}

async function nextBatch(target: Replica, source: Database): Promise<ChangeBatch> {
  const since = parsePeerPosition(target.adapter.getLocal(peerKey(source.instanceId)), source.instanceId);
  return source.exportChanges({ since });
}

/** Pulls between every pair until a whole round applies nothing. */
async function settle(replicas: readonly Replica[]): Promise<void> {
  for (let round = 0; round < 20; round++) {
    let applied = 0;
    for (const target of replicas) {
      for (const source of replicas) {
        if (target !== source) {
          applied += (await target.db.pullFrom(source.db)).applied;
        }
      }
    }
    if (applied === 0) {
      return;
    }
  }
  throw new Error("replicas did not settle");
}

function expectIdentical(replicas: readonly Replica[]): void {
  const [first, ...rest] = replicas as [Replica, ...Replica[]];
  for (const replica of rest) {
    expect(replica.adapter.allDocuments()).toEqual(first.adapter.allDocuments());
  }
}

async function load(db: Database, id: string): Promise<Document<Content>> {
  const doc = await db.get<Content>(id);
  if (doc === undefined) {
    throw new Error(`document ${id} not readable`);
  }
  return doc;
}

async function edit(db: Database, id: string, content: Content, lists: { readers?: string[]; writers?: string[] } = {}): Promise<void> {
  tick();
  const doc = await load(db, id);
  doc.content = content;
  if (lists.readers !== undefined) {
    doc.readers = lists.readers;
  }
  if (lists.writers !== undefined) {
    doc.writers = lists.writers;
  }
  await doc.save();
}

async function remove(db: Database, id: string): Promise<void> {
  tick();
  await (await load(db, id)).delete();
}

async function conflictOf(db: Database, id: string): Promise<Conflict<Content>> {
  const conflict = await (await load(db, id)).conflict();
  if (conflict === undefined) {
    throw new Error(`document ${id} not in conflict`);
  }
  return conflict;
}

function rowsOf(replica: Replica, id: string): DocumentEnvelope[] {
  return replica.adapter.conflictRows(id);
}

function primaryOf(replica: Replica, id: string): DocumentEnvelope {
  return replica.adapter.getDocument(id) as DocumentEnvelope;
}

async function contentOf(conflict: Conflict<Content>): Promise<unknown[]> {
  return conflict.versions.map((version) => version.document.content);
}

/**
 * A on the founder, B a replica, with document id synced to both. With
 * conflict, A then edits it to { n: 1 } and B (later, so B's ranks higher) to
 * { n: 2 }, and they sync.
 */
async function pair(options: { conflict?: boolean; readers?: string[]; writers?: string[] } = {}): Promise<{ a: Replica; b: Replica; id: string }> {
  const a = await founder();
  const b = await replicaOf(a.db);
  tick();
  const doc = await a.db.create(
    { n: 0 },
    { ...(options.readers === undefined ? {} : { readers: options.readers }), ...(options.writers === undefined ? {} : { writers: options.writers }) },
  );
  await sync(a.db, b.db);
  if (options.conflict === true) {
    await edit(a.db, doc.id, { n: 1 });
    await edit(b.db, doc.id, { n: 2 });
    await sync(a.db, b.db);
  }
  return { a, b, id: doc.id };
}

describe("detecting conflicts", () => {
  it("keeps concurrent edits as one primary and one conflict row, the same on both replicas", async () => {
    const { a, b, id } = await pair({ conflict: true });
    expectIdentical([a, b]);
    for (const replica of [a, b]) {
      expect(primaryOf(replica, id).content).toEqual({ n: 2 });
      expect(primaryOf(replica, id).conflictOf).toBeUndefined();
      const rows = rowsOf(replica, id);
      expect(rows).toHaveLength(1);
      const [row] = rows as [DocumentEnvelope];
      expect(row.content).toEqual({ n: 1 });
      expect(row.id).toBe(conflictRowId(id, row.vectorClock));
      expect(row.parentId).toBe(id);
      expect(row.conflictOf).toBe(id);
      expect(row.vectorClock).toEqual({ [a.db.instanceId]: 2 });
      expect(row.updatedOn).toBe(a.db.instanceId);
      expect((await replica.db.find({ inConflict: true })).count).toBe(1);
      expect((await replica.db.find({ inConflict: false })).count).toBe(0);
    }
  });

  it("ranks equal edits by updatedAt, whichever replica applies them", async () => {
    // B edits first this time, so A's ranks higher.
    const { a, b, id } = await pair();
    await edit(b.db, id, { n: 2 });
    await edit(a.db, id, { n: 1 });
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect(primaryOf(a, id).content).toEqual({ n: 1 });
  });

  it("puts a live edit above a concurrent delete, which becomes a deleted conflict row", async () => {
    const { a, b, id } = await pair();
    await remove(a.db, id);
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect(primaryOf(a, id).deleted).toBe(false);
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    expect(row.deleted).toBe(true);
    expect(row.content).toEqual({});
    const conflict = await conflictOf(a.db, id);
    expect(conflict.versions.map((version) => version.deleted)).toEqual([false, true]);
  });

  it("merges conflicts from separate pairs flat: one primary and three conflict rows", async () => {
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    const d = await replicaOf(a.db);
    await settle([a, b, c, d]); // so every replica knows the others
    await edit(a.db, id, { by: "a" });
    await edit(b.db, id, { by: "b" });
    await sync(a.db, b.db);
    await edit(c.db, id, { by: "c" });
    await edit(d.db, id, { by: "d" });
    await sync(c.db, d.db);
    await settle([a, b, c, d]);
    expectIdentical([a, b, c, d]);
    const rows = rowsOf(a, id);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.conflictOf).toBe(id);
      expect(row.parentId).toBe(id);
      expect(rowsOf(a, row.id)).toEqual([]);
    }
    expect(primaryOf(a, id).content).toEqual({ by: "d" });
    const conflict = await conflictOf(a.db, id);
    expect(await contentOf(conflict)).toEqual([{ by: "d" }, { by: "c" }, { by: "b" }, { by: "a" }]);
  });

  it.each([2, 3])(
    "converges to the true history with %i replicas: random edits, deletes, full and partial resolves, and pulls",
    async (count) => {
      type Op =
        | { kind: "edit"; replica: number; n: number; private: boolean }
        | { kind: "delete"; replica: number }
        | { kind: "resolve"; replica: number; asBob: boolean; pick: number; byDeleting: boolean }
        | { kind: "sync"; from: number; to: number };
      const replica = fc.nat({ max: count - 1 });
      const op: fc.Arbitrary<Op> = fc.oneof(
        { weight: 4, arbitrary: fc.record({ kind: fc.constant("edit" as const), replica, n: fc.nat({ max: 99 }), private: fc.boolean() }) },
        { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), replica }) },
        {
          weight: 3,
          arbitrary: fc.record({
            kind: fc.constant("resolve" as const),
            replica,
            asBob: fc.nat({ max: 3 }).map((x) => x > 0),
            pick: fc.nat({ max: 3 }),
            byDeleting: fc.nat({ max: 3 }).map((x) => x === 0),
          }),
        },
        { weight: 5, arbitrary: fc.record({ kind: fc.constant("sync" as const), from: replica, to: replica }) },
      );

      let runs = 0;
      // How often the hard cases came up, so the property can't pass vacuously.
      const seen = { conflictAtEnd: 0, writerKey: 0, partialResolve: 0 };
      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 8, maxLength: 28 }), async (ops) => {
          runs++;
          const first = await founder();
          const replicas = [first];
          while (replicas.length < count) {
            replicas.push(await replicaOf(first.db));
          }
          await settle(replicas);
          const bobs = await Promise.all(replicas.map((r) => openAs(bob, r.adapter)));
          tick();
          const { id } = await first.db.create({ n: 0 });
          await settle(replicas);

          // True history: for each version (by its clock), every version its writer read, transitively.
          const read = new Map<string, Set<string>>([[canonicalString(primaryOf(first, id).vectorClock), new Set()]]);
          const versionsOf = (r: Replica): string[] => [primaryOf(r, id), ...rowsOf(r, id)].map((v) => canonicalString(v.vectorClock));
          const record = (r: Replica, from: readonly VectorClock[]): void => {
            const written = versionsOf(r).filter((clock) => !read.has(clock));
            expect(written).toHaveLength(1);
            const history = new Set<string>();
            for (const clock of from) {
              const key = canonicalString(clock);
              history.add(key);
              for (const earlier of read.get(key) ?? []) {
                history.add(earlier);
              }
            }
            read.set(written[0] as string, history);
          };

          for (const step of ops) {
            tick();
            if (step.kind === "sync") {
              const from = replicas[step.from] as Replica;
              const to = replicas[step.to] as Replica;
              if (from !== to) {
                await to.db.pullFrom(from.db);
              }
              continue;
            }
            const target = replicas[step.replica] as Replica;
            const db = step.kind === "resolve" && step.asBob ? (bobs[step.replica] as Database) : target.db;
            const doc = await db.get<Content>(id);
            if (doc === undefined) {
              continue; // not readable by this session
            }
            if (step.kind === "edit" || step.kind === "delete") {
              if (doc.deleted) {
                continue; // a deleted primary in conflict is read-only
              }
              const before = doc.vectorClock;
              if (step.kind === "edit") {
                doc.content = { n: step.n };
                doc.readers = step.private ? ["alice"] : ["*"];
                await doc.save();
              } else {
                await doc.delete();
              }
              record(target, [before]);
              continue;
            }
            const conflict = await doc.conflict();
            if (conflict === undefined) {
              continue;
            }
            const included = conflict.versions.map((version) => version.document.vectorClock);
            if (included.length < rowsOf(target, id).length + 1) {
              seen.partialResolve++;
            }
            const version = conflict.versions[step.pick % conflict.versions.length];
            if (step.byDeleting || version === undefined) {
              await conflict.resolveByDeleting();
            } else if (version.deleted) {
              await conflict.resolveWithContent({ content: { n: step.pick } });
            } else {
              await conflict.resolveWith(version.document);
            }
            record(target, included);
          }

          await settle(replicas);
          expectIdentical(replicas);
          const everRead = new Set([...read.values()].flatMap((history) => [...history]));
          const truth = [...read.keys()].filter((clock) => !everRead.has(clock)).sort();
          expect(versionsOf(first).sort()).toEqual(truth);
          if (rowsOf(first, id).length > 0) {
            seen.conflictAtEnd++;
          }
          if ([...read.keys()].some((clock) => clock.includes("/"))) {
            seen.writerKey++;
          }
        }),
        { numRuns: 100 },
      );
      if (process.env["CROMDB_STATS"] === "1") {
        console.log(`${count} replicas`, seen);
      }
      expect(runs).toBe(100);
      expect(seen.conflictAtEnd).toBeGreaterThan(5);
      expect(seen.writerKey).toBeGreaterThan(5);
      expect(seen.partialResolve).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("conflict()", () => {
  it("is undefined for a document not in conflict", async () => {
    const { a, id } = await pair();
    expect(await (await load(a.db, id)).conflict()).toBeUndefined();
  });

  it("gives the same group from the primary and from a conflict row, primary first", async () => {
    const { a, id } = await pair({ conflict: true });
    const fromPrimary = await conflictOf(a.db, id);
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    const rowDoc = await load(a.db, row.id);
    const fromRow = (await rowDoc.conflict()) as Conflict<Content>;
    for (const conflict of [fromPrimary, fromRow]) {
      expect(conflict.primaryId).toBe(id);
      expect(await contentOf(conflict)).toEqual([{ n: 2 }, { n: 1 }]);
      expect(conflict.versions.map((version) => version.isPrimary)).toEqual([true, false]);
      expect(conflict.versions.map((version) => version.authorized)).toEqual([true, true]);
      expect(conflict.versions.map((version) => version.document.id)).toEqual([id, row.id]);
    }
    expect(Object.isFrozen(fromPrimary.versions)).toBe(true);
  });

  it("lists only versions the session can read", async () => {
    const { a, b, id } = await pair();
    await edit(a.db, id, { n: 1 }, { readers: ["alice"] });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const bobs = await openAs(bob, a.adapter);
    const conflict = await conflictOf(bobs, id);
    expect(await contentOf(conflict)).toEqual([{ n: 2 }]);
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    expect(await bobs.get(row.id)).toBeUndefined();
  });
});

describe("conflict documents", () => {
  it("are read-only", async () => {
    const { a, id } = await pair({ conflict: true });
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    const rowDoc = await load(a.db, row.id);
    const before = a.adapter.allDocuments();
    await expectCode(rowDoc.save(), "READ_ONLY");
    await expectCode(rowDoc.delete(), "READ_ONLY");
    expect(await rowDoc.myAccess()).toEqual({ read: true, update: false, delete: false });
    // So are the documents a Conflict lists, the primary's included.
    const conflict = await conflictOf(a.db, id);
    for (const version of conflict.versions) {
      await expectCode(version.document.save(), "READ_ONLY");
      expect(await version.document.myAccess()).toEqual({ read: true, update: false, delete: false });
    }
    expect(a.adapter.allDocuments()).toEqual(before);
  });

  it("never appear in find, getChildren, counts or orphans", async () => {
    const { a, id } = await pair({ conflict: true });
    tick();
    const child = await a.db.create({ child: true }, { parentId: id });
    const ids = async (filter?: Parameters<Database["find"]>[0]): Promise<string[]> => {
      const found: string[] = [];
      for await (const doc of await a.db.find(filter)) {
        found.push(doc.id);
      }
      return found;
    };
    expect(await ids()).toEqual([id, child.id]);
    expect(await ids({ parentId: id })).toEqual([child.id]);
    expect((await (await load(a.db, id)).getChildren()).count).toBe(1);
    expect(await ids({ orphaned: true })).toEqual([]);
    expect(await ids({ topLevel: false })).toEqual([child.id]);
    expect(await ids({ inConflict: true })).toEqual([id]);
    expect(await ids({ inConflict: false })).toEqual([child.id]);
  });

  it("can't be a parent", async () => {
    const { a, id } = await pair({ conflict: true });
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    await expectCode(a.db.create({ x: 1 }, { parentId: row.id }), "NOT_FOUND");
  });
});

describe("resolving", () => {
  it("resolveWith a conflict version writes it as the primary and removes the rows, on both replicas", async () => {
    const { a, b, id } = await pair({ conflict: true });
    const conflict = await conflictOf(a.db, id);
    const loser = conflict.versions[1] as (typeof conflict.versions)[number];
    loser.document.content = { edited: "ignored" };
    tick();
    expect(await conflict.resolveWith(loser.document)).toEqual({ editedThroughConflict: false });
    const primary = primaryOf(a, id);
    expect(primary.content).toEqual({ n: 1 });
    expect(primary.updatedBy).toBe("alice");
    expect(rowsOf(a, id)).toEqual([]);
    expect(await (await load(a.db, id)).conflict()).toBeUndefined();
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect(rowsOf(b, id)).toEqual([]);
  });

  it("resolveWith the primary's own version keeps its content", async () => {
    const { a, b, id } = await pair({ conflict: true });
    const conflict = await conflictOf(a.db, id);
    await conflict.resolveWith((conflict.versions[0] as (typeof conflict.versions)[number]).document);
    expect(primaryOf(a, id).content).toEqual({ n: 2 });
    expect(rowsOf(a, id)).toEqual([]);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("resolveWithContent writes the merge, ahead of every included version", async () => {
    const { a, b, id } = await pair({ conflict: true });
    const conflict = await conflictOf(a.db, id);
    const clocks = conflict.versions.map((version) => version.document.vectorClock);
    expect(await conflict.resolveWithContent({ content: { n: 3, when: new Date(time) } })).toEqual({ editedThroughConflict: false });
    const primary = primaryOf(a, id);
    expect(primary.content).toEqual({ n: 3, when: new Date(time).toISOString() });
    expect(primary.fieldTypes).toEqual({ "/when": "datetime" });
    expect(primary.readers).toEqual(["*"]);
    for (const clock of clocks) {
      expect(compare(clock, primary.vectorClock)).toBe("before");
    }
    expect(totalEdits(primary.vectorClock)).toBe(4);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("resolveWithContent checks readers and writers as save does", async () => {
    const { a, id } = await pair({ conflict: true });
    const conflict = await conflictOf(a.db, id);
    const before = a.adapter.allDocuments();
    await expectCode(conflict.resolveWithContent({ content: {}, writers: [] }), "INVALID_ACCESS_LIST");
    const error = await expectCode(conflict.resolveWithContent({ content: {}, writers: ["bob"] }), "ACCESS_DENIED");
    expect(error.message).toContain("cannot remove themselves");
    await expect(conflict.resolveWithContent({ content: { x: Number.NaN } })).rejects.toThrow(TypeError);
    expect(a.adapter.allDocuments()).toEqual(before);
    await conflict.resolveWithContent({ content: { ok: true }, readers: ["alice", "bob"], writers: ["alice"] });
    expect(primaryOf(a, id)).toMatchObject({ readers: ["alice", "bob"], writers: ["alice"] });
  });

  it("resolveByDeleting leaves a tombstone and no rows, and replicates", async () => {
    const { a, b, id } = await pair({ conflict: true });
    expect(await (await conflictOf(a.db, id)).resolveByDeleting()).toEqual({ editedThroughConflict: false });
    const primary = primaryOf(a, id);
    expect(primary).toMatchObject({ deleted: true, content: {}, fieldTypes: {}, readers: ["*"], writers: ["*"] });
    expect(primary.deletedAt).toBe(primary.updatedAt);
    expect(rowsOf(a, id)).toEqual([]);
    expect(await a.db.get(id)).toBeUndefined();
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("is STALE_DOCUMENT, writing nothing, when a version arrives, a save happens, or another resolve wins", async () => {
    const { a, b, id } = await pair({ conflict: true });
    // A version arrives.
    const first = await conflictOf(a.db, id);
    await edit(b.db, id, { n: 5 });
    await sync(a.db, b.db);
    let before = a.adapter.allDocuments();
    await expectCode(first.resolveByDeleting(), "STALE_DOCUMENT");
    expect(a.adapter.allDocuments()).toEqual(before);
    // A local save of the primary.
    const second = await conflictOf(b.db, id);
    await edit(b.db, id, { n: 6 });
    before = b.adapter.allDocuments();
    await expectCode(second.resolveByDeleting(), "STALE_DOCUMENT");
    expect(b.adapter.allDocuments()).toEqual(before);
    // Another resolve.
    const [x, y] = [await conflictOf(b.db, id), await conflictOf(b.db, id)];
    await x.resolveWithContent({ content: { n: 7 } });
    before = b.adapter.allDocuments();
    await expectCode(y.resolveWithContent({ content: { n: 8 } }), "STALE_DOCUMENT");
    expect(b.adapter.allDocuments()).toEqual(before);
  });

  it("refuses with TypeError a deleted version, a document not in the snapshot, and a spent Conflict", async () => {
    const { a, b, id } = await pair();
    await remove(a.db, id);
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const conflict = await conflictOf(a.db, id);
    const deleted = conflict.versions[1] as (typeof conflict.versions)[number];
    expect(deleted.deleted).toBe(true);
    const before = a.adapter.allDocuments();
    await expect(conflict.resolveWith(deleted.document)).rejects.toThrow(TypeError);
    await expect(conflict.resolveWith(await load(a.db, id))).rejects.toThrow(TypeError);
    const other = await conflictOf(a.db, id);
    await expect(conflict.resolveWith((other.versions[0] as (typeof other.versions)[number]).document)).rejects.toThrow(TypeError);
    expect(a.adapter.allDocuments()).toEqual(before);

    await conflict.resolveWith((conflict.versions[0] as (typeof conflict.versions)[number]).document);
    await expect(conflict.resolveByDeleting()).rejects.toThrow(TypeError);
    await expect(conflict.resolveWithContent({ content: {} })).rejects.toThrow(TypeError);
  });

  it("refuses a non-writer, and a writer who can't read the document, with ACCESS_DENIED", async () => {
    const { a, b, id } = await pair({ writers: ["alice"] });
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const bobs = await openAs(bob, a.adapter);
    const before = a.adapter.allDocuments();
    await expectCode((await conflictOf(bobs, id)).resolveByDeleting(), "ACCESS_DENIED");
    expect(a.adapter.allDocuments()).toEqual(before);

    // bob writes, but can read only the conflict version, not the primary.
    const second = await pair({ writers: ["alice", "bob"] });
    await edit(second.a.db, second.id, { n: 1 });
    await edit(second.b.db, second.id, { n: 2 }, { readers: ["alice"] });
    await sync(second.a.db, second.b.db);
    const bobsSecond = await openAs(bob, second.a.adapter);
    expect(await bobsSecond.get(second.id)).toBeUndefined();
    const [row] = rowsOf(second.a, second.id) as [DocumentEnvelope];
    const conflict = (await (await load(bobsSecond, row.id)).conflict()) as Conflict<Content>;
    expect(await contentOf(conflict)).toEqual([{ n: 1 }]);
    const error = await expectCode(conflict.resolveWith((conflict.versions[0] as (typeof conflict.versions)[number]).document), "ACCESS_DENIED");
    expect(error.message).toContain("can't read");
  });

  it("refuses resolveWith a version whose writers leave the resolver out", async () => {
    const { a, b, id } = await pair({ writers: ["alice", "bob"] });
    // bob's version goes first, so alice's ranks higher and stays primary.
    const bobsB = await openAs(bob, b.adapter);
    await edit(bobsB, id, { n: 2 }, { writers: ["bob"] });
    await edit(a.db, id, { n: 1 });
    await sync(a.db, b.db);
    const conflict = await conflictOf(a.db, id);
    const bobs = conflict.versions[1] as (typeof conflict.versions)[number];
    expect(bobs.document.writers).toEqual(["bob"]);
    const error = await expectCode(conflict.resolveWith(bobs.document), "ACCESS_DENIED");
    expect(error.message).toContain("cannot remove themselves");
  });

  it("resolves partially: a version the resolver can't read stays in conflict", async () => {
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    await edit(c.db, id, { by: "c" }, { readers: ["alice"] });
    await edit(a.db, id, { by: "a" });
    await edit(b.db, id, { by: "b" });
    await settle([a, b, c]);
    expect(rowsOf(a, id)).toHaveLength(2);
    const bobs = await openAs(bob, a.adapter);
    const conflict = await conflictOf(bobs, id);
    expect(await contentOf(conflict)).toEqual([{ by: "b" }, { by: "a" }]);
    const result = await conflict.resolveWith((conflict.versions[1] as (typeof conflict.versions)[number]).document);
    expect(result).toEqual({ editedThroughConflict: true });
    const rows = rowsOf(a, id);
    expect(rows.map((row) => row.content)).toEqual([{ by: "c" }]);
    expect(primaryOf(a, id).content).toEqual({ by: "a" });
    expect((await a.db.find({ inConflict: true })).count).toBe(1);
    await settle([a, b, c]);
    expectIdentical([a, b, c]);
  });

  it("drops a late copy of a resolved version arriving from a third replica", async () => {
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    await c.db.pullFrom(b.db); // c holds the conflict too
    expect(rowsOf(c, id)).toHaveLength(1);
    await (await conflictOf(a.db, id)).resolveWithContent({ content: { n: 3 } });
    await sync(a.db, b.db);
    const before = a.adapter.allDocuments();
    await a.db.pullFrom(c.db);
    expect(a.adapter.allDocuments()).toEqual(before);
    await settle([a, b, c]);
    expectIdentical([a, b, c]);
    expect(rowsOf(c, id)).toEqual([]);
    expect(primaryOf(c, id).content).toEqual({ n: 3 });
  });

  it("exports past the change entries of removed rows", async () => {
    const { a, id } = await pair({ conflict: true });
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    await (await conflictOf(a.db, id)).resolveByDeleting();
    expect(a.adapter.changesSince(0).some((entry) => entry.docId === row.id)).toBe(true);
    const batch = await a.db.exportChanges();
    expect(batch.documents.some((doc) => doc.id === row.id)).toBe(false);
    const fresh = await replicaOf(a.db);
    expect(fresh.adapter.getDocument(row.id)).toBeUndefined();
  });
});

describe("versions for stateless callers", () => {
  it("gives the same document version the same string on every replica", async () => {
    const { a, b, id } = await pair();
    expect((await load(b.db, id)).version).toBe((await load(a.db, id)).version);
    await edit(b.db, id, { n: 5 });
    expect((await load(b.db, id)).version).not.toBe((await load(a.db, id)).version);
    await sync(a.db, b.db);
    expect((await load(b.db, id)).version).toBe((await load(a.db, id)).version);
  });

  it("gives equal versions exactly for equal clocks", () => {
    const key = fc.constantFrom(newId(), newId(), `${newId()}/2`);
    const clock = fc.dictionary(key, fc.nat({ max: 3 }));
    fc.assert(
      fc.property(clock, clock, (x, y) => {
        expect(documentVersion(x) === documentVersion(y)).toBe(canonicalString(x) === canonicalString(y));
      }),
    );
  });

  it("gives a conflict the same version on every replica and from any of its versions", async () => {
    const { a, b, id } = await pair({ conflict: true });
    const onA = await conflictOf(a.db, id);
    expect(onA.version).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(onA.version).not.toBe((await load(a.db, id)).version);
    expect((await conflictOf(b.db, id)).version).toBe(onA.version);
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    expect((await (await load(a.db, row.id)).conflict())?.version).toBe(onA.version);
    expect(conflictVersion([...rowsOf(a, id)].reverse().concat(primaryOf(a, id)))).toBe(onA.version);
  });

  it("covers versions the session can't read", async () => {
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    await edit(c.db, id, { by: "c" }, { readers: ["alice"] });
    await edit(a.db, id, { by: "a" });
    await edit(b.db, id, { by: "b" });
    await settle([a, b, c]);
    const bobs = await openAs(bob, a.adapter);
    const bobsConflict = await conflictOf(bobs, id);
    expect(bobsConflict.versions).toHaveLength(2);
    expect(bobsConflict.version).toBe((await conflictOf(a.db, id)).version);
  });

  it("conflict with ifVersion loads the same set, and is STALE_DOCUMENT once a version arrives or it is resolved", async () => {
    const { a, b, id } = await pair({ conflict: true });
    const version = (await conflictOf(a.db, id)).version;
    const doc = await load(a.db, id);
    expect((await doc.conflict({ ifVersion: version }))?.version).toBe(version);

    await edit(b.db, id, { n: 5 });
    await sync(a.db, b.db);
    await expectCode(doc.conflict({ ifVersion: version }), "STALE_DOCUMENT");

    const current = (await conflictOf(a.db, id)).version;
    await (await conflictOf(a.db, id)).resolveByDeleting();
    await expectCode(doc.conflict({ ifVersion: current }), "STALE_DOCUMENT");
    expect(await doc.conflict()).toBeUndefined();
  });

  it("reports editedThroughConflict for each resolve call left with versions the resolver can't read", async () => {
    for (const resolve of [
      (conflict: Conflict<Content>) => conflict.resolveWithContent({ content: { by: "bob" } }),
      (conflict: Conflict<Content>) => conflict.resolveByDeleting(),
    ]) {
      const { a, b, id } = await pair();
      const c = await replicaOf(a.db);
      await edit(c.db, id, { by: "c" }, { readers: ["alice"] });
      await edit(a.db, id, { by: "a" });
      await edit(b.db, id, { by: "b" });
      await settle([a, b, c]);
      const bobs = await openAs(bob, a.adapter);
      expect(await resolve(await conflictOf(bobs, id))).toEqual({ editedThroughConflict: true });
      expect(rowsOf(a, id)).toHaveLength(1);
      // alice reads them all, so her resolve leaves no conflict.
      expect(await resolve(await conflictOf(a.db, id))).toEqual({ editedThroughConflict: false });
    }
  });
});

describe("local writes while in conflict", () => {
  it("editing the primary keeps it primary and keeps the conflict", async () => {
    const { a, b, id } = await pair({ conflict: true });
    await edit(b.db, id, { n: 3 });
    expect(primaryOf(b, id).content).toEqual({ n: 3 });
    expect(rowsOf(b, id)).toHaveLength(1);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect(rowsOf(a, id)).toHaveLength(1);
  });

  it("keeps the conflict when the replica whose version lost edits the primary (writer keys)", async () => {
    // Alice's example: A's {A:2} lost to B's {A:1,B:1}.
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    await settle([a, b, c]);
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const A = a.db.instanceId;
    const B = b.db.instanceId;
    expect(primaryOf(a, id).vectorClock).toEqual({ [A]: 1, [B]: 1 });

    tick();
    const doc = await load(a.db, id);
    doc.content = { n: 3 };
    expect(await doc.save()).toEqual({ editedThroughConflict: true });
    expect(primaryOf(a, id).vectorClock).toEqual({ [A]: 1, [B]: 1, [`${A}/1`]: 1 });
    expect(rowsOf(a, id).map((row) => row.content)).toEqual([{ n: 1 }]);
    expect((await a.db.find({ inConflict: true })).count).toBe(1);

    await settle([a, b, c]);
    expectIdentical([a, b, c]);
    for (const replica of [a, b, c]) {
      expect(primaryOf(replica, id).content).toEqual({ n: 3 });
      expect(rowsOf(replica, id).map((row) => row.content)).toEqual([{ n: 1 }]);
    }

    // The next edit continues "A/1", and the conflict remains.
    tick();
    const again = await load(a.db, id);
    again.content = { n: 4 };
    expect(await again.save()).toEqual({ editedThroughConflict: true });
    expect(primaryOf(a, id).vectorClock).toEqual({ [A]: 1, [B]: 1, [`${A}/1`]: 2 });

    // Once resolved, edits report false.
    await (await conflictOf(a.db, id)).resolveWithContent({ content: { n: 5 } });
    tick();
    const after = await load(a.db, id);
    after.content = { n: 6 };
    expect(await after.save()).toEqual({ editedThroughConflict: false });
  });

  it('starts "A/2" when both of A\'s keys are held in conflict versions, and a full resolve goes back to plain A', async () => {
    const { a, b, id } = await pair();
    const A = a.db.instanceId;
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    await edit(a.db, id, { n: 3 }); // "A/1": 1
    await sync(a.db, b.db);
    await edit(a.db, id, { n: 4 }); // "A/1": 2
    await edit(b.db, id, { n: 5 }); // B's ranks higher
    await sync(a.db, b.db);
    expect(primaryOf(a, id).content).toEqual({ n: 5 });
    expect(rowsOf(a, id).map((row) => row.content).sort((x, y) => Number(x["n"]) - Number(y["n"]))).toEqual([{ n: 1 }, { n: 4 }]);

    tick();
    const doc = await load(a.db, id);
    doc.content = { n: 6 };
    expect(await doc.save()).toEqual({ editedThroughConflict: true });
    expect(primaryOf(a, id).vectorClock[`${A}/2`]).toBe(1);
    expect(rowsOf(a, id)).toHaveLength(2);

    const conflict = await conflictOf(a.db, id);
    expect(conflict.versions).toHaveLength(3);
    await conflict.resolveWithContent({ content: { n: 7 } });
    const resolved = primaryOf(a, id).vectorClock;
    expect(resolved[A]).toBe(3);
    expect(resolved[`${A}/3`]).toBeUndefined();
    expect(rowsOf(a, id)).toEqual([]);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("keeps the conflict through a local delete of the primary on that replica", async () => {
    const { a, b, id } = await pair({ conflict: true });
    tick();
    expect(await (await load(a.db, id)).delete()).toEqual({ editedThroughConflict: true });
    // Live beats deleted: A's own version is promoted, the delete is a conflict row.
    expect(primaryOf(a, id).content).toEqual({ n: 1 });
    const [row] = rowsOf(a, id) as [DocumentEnvelope];
    expect(row.deleted).toBe(true);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("keeps a version the resolver couldn't read when the resolver's replica wrote it", async () => {
    const { a, b, id } = await pair();
    await edit(a.db, id, { by: "a" }, { readers: ["alice"] });
    await edit(b.db, id, { by: "b" });
    await sync(a.db, b.db);
    const bobs = await openAs(bob, a.adapter);
    const conflict = await conflictOf(bobs, id);
    expect(await contentOf(conflict)).toEqual([{ by: "b" }]);
    await conflict.resolveWithContent({ content: { by: "bob" } });
    expect(primaryOf(a, id).vectorClock[`${a.db.instanceId}/1`]).toBe(1);
    expect(rowsOf(a, id).map((row) => row.content)).toEqual([{ by: "a" }]);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect(rowsOf(b, id).map((row) => row.content)).toEqual([{ by: "a" }]);
  });

  it("reports editedThroughConflict false for saves and deletes of documents not in conflict", async () => {
    const { a } = await pair({ conflict: true });
    const plain = await a.db.create({ x: 1 });
    plain.content = { x: 2 };
    const result = await plain.save();
    expect(result).toEqual({ editedThroughConflict: false });
    expect(Object.isFrozen(result)).toBe(true);
    expect(await plain.delete()).toEqual({ editedThroughConflict: false });
  });

  it("reports editedThroughConflict true when the conflict versions came only from other replicas", async () => {
    const { b, id } = await pair({ conflict: true });
    // On B, whose version is primary, editing continues plain B; A's version stays in conflict.
    tick();
    const onB = await load(b.db, id);
    expect(await onB.save()).toEqual({ editedThroughConflict: true });
    expect(Object.keys(primaryOf(b, id).vectorClock).every((key) => !key.includes("/"))).toBe(true);
    expect(rowsOf(b, id)).toHaveLength(1);
  });

  it("keeps a child document's parentId when a conflict version is promoted", async () => {
    const { a, b, id: parent } = await pair();
    tick();
    const child = await a.db.create({ n: 0 }, { parentId: parent });
    await sync(a.db, b.db);
    await edit(a.db, child.id, { n: 1 });
    await edit(b.db, child.id, { n: 2 });
    await sync(a.db, b.db);
    expect(rowsOf(b, child.id)[0]?.parentId).toBe(child.id);
    await remove(b.db, child.id);
    expect(primaryOf(b, child.id)).toMatchObject({ content: { n: 1 }, parentId: parent });
    await sync(a.db, b.db);
    expectIdentical([a, b]);
    expect((await (await load(a.db, parent)).getChildren()).count).toBe(1);
  });

  it("deleting the primary promotes the best live conflict version", async () => {
    const { a, b, id } = await pair({ conflict: true });
    await remove(b.db, id);
    expect(primaryOf(b, id).content).toEqual({ n: 1 });
    const [row] = rowsOf(b, id) as [DocumentEnvelope];
    expect(row.deleted).toBe(true);
    expect((await load(b.db, id)).content).toEqual({ n: 1 });
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });
});

describe("a deleted primary in conflict", () => {
  /** Concurrent deletes on A and B: a deleted primary with a deleted conflict row. */
  async function bothDeleted(): Promise<{ a: Replica; b: Replica; id: string }> {
    const { a, b, id } = await pair({ readers: ["alice"] });
    await remove(a.db, id);
    await remove(b.db, id);
    await sync(a.db, b.db);
    expect(primaryOf(a, id).deleted).toBe(true);
    expect(rowsOf(a, id).map((row) => row.deleted)).toEqual([true]);
    return { a, b, id };
  }

  it("stays reachable, read-only, through get and find({ inConflict: true })", async () => {
    const { a, id } = await bothDeleted();
    const doc = await load(a.db, id);
    expect(doc.deleted).toBe(true);
    expect(doc.content).toEqual({});
    await expectCode(doc.save(), "READ_ONLY");
    await expectCode(doc.delete(), "READ_ONLY");
    expect(await doc.myAccess()).toEqual({ read: true, update: false, delete: false });
    expect((await a.db.find({ inConflict: true })).count).toBe(1);
    expect((await a.db.find()).count).toBe(0);
    expect((await a.db.find({ inConflict: false })).count).toBe(0);
    const conflict = await conflictOf(a.db, id);
    expect(conflict.versions.map((version) => version.deleted)).toEqual([true, true]);
    // Readers still apply.
    const bobs = await openAs(bob, a.adapter);
    expect(await bobs.get(id)).toBeUndefined();
    expect((await bobs.find({ inConflict: true })).count).toBe(0);
  });

  it("can be resolved, after which it is hidden again", async () => {
    const { a, b, id } = await bothDeleted();
    await (await conflictOf(a.db, id)).resolveByDeleting();
    expect(rowsOf(a, id)).toEqual([]);
    expect(await a.db.get(id)).toBeUndefined();
    expect((await a.db.find({ inConflict: true })).count).toBe(0);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("is skipped by a find set loaded before it was deleted, unless that set asked for inConflict", async () => {
    const { a, b, id } = await pair({ readers: ["alice"] });
    await edit(a.db, id, { n: 1 });
    await remove(b.db, id);
    await sync(a.db, b.db);
    expect(primaryOf(a, id).deleted).toBe(false);
    const plain = await a.db.find();
    const inConflict = await a.db.find({ inConflict: false });
    await remove(a.db, id);
    await sync(a.db, b.db);
    expect(primaryOf(a, id).deleted).toBe(true);
    expect(rowsOf(a, id)).toHaveLength(1);
    const ids = async (set: Awaited<ReturnType<Database["find"]>>): Promise<string[]> => {
      const found: string[] = [];
      for await (const doc of set) {
        found.push(doc.id);
      }
      return found;
    };
    expect(await ids(plain)).toEqual([]);
    expect(await ids(inConflict)).toEqual([]);
    expect(await ids(await a.db.find({ inConflict: true }))).toEqual([id]);
  });

  it("is not auto-resolved when every version is a deletion", async () => {
    const { a, b, id } = await bothDeleted();
    await settle([a, b]);
    expect(rowsOf(b, id)).toHaveLength(1);
    expect((await b.db.find({ inConflict: true })).count).toBe(1);
  });

  it("can be resolved with a live version", async () => {
    const { a, b, id } = await pair();
    await remove(a.db, id);
    await remove(b.db, id);
    await sync(a.db, b.db);
    const conflict = await conflictOf(a.db, id);
    await conflict.resolveWithContent({ content: { back: true } });
    expect((await load(a.db, id)).deleted).toBe(false);
    expect(primaryOf(a, id).content).toEqual({ back: true });
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });
});

describe("rewind check over writer keys", () => {
  it('checks each "/n" key of this replica against its highest stored count', async () => {
    const { a, b, id } = await pair();
    const B = b.db.instanceId;
    const stored = primaryOf(a, id);
    const batch = await nextBatch(b, a.db);
    const at = (clock: Record<string, number>): unknown => ({ ...batch, documents: [{ ...stored, vectorClock: clock }] });
    const base = stored.vectorClock;
    // B never wrote "B/1" for this document.
    const error = await expectCode(b.db.applyChanges(at({ ...base, [`${B}/1`]: 1, [a.db.instanceId]: 9 })), "REWIND_DETECTED");
    expect(error.message).toContain(`${B}/1`);
    // Other replicas' "/n" keys are not checked here.
    expect(await b.db.applyChanges(at({ ...base, [`${a.db.instanceId}/4`]: 1 }))).toMatchObject({ applied: 1 });
  });

  it("passes up to the stored count of a key this replica did use", async () => {
    // B's version loses, then B edits the primary, starting "B/1".
    const { a, b, id } = await pair();
    await edit(b.db, id, { n: 2 });
    await edit(a.db, id, { n: 1 });
    await sync(a.db, b.db);
    await edit(b.db, id, { n: 3 });
    const B = b.db.instanceId;
    expect(primaryOf(b, id).vectorClock[`${B}/1`]).toBe(1);
    const batch = await nextBatch(b, a.db);
    const primary = primaryOf(b, id);
    const at = (count: number): unknown => ({
      ...batch,
      documents: [{ ...primary, updatedOn: a.db.instanceId, vectorClock: { ...primary.vectorClock, [`${B}/1`]: count, [a.db.instanceId]: 9 } }],
    });
    await expectCode(b.db.applyChanges(at(2)), "REWIND_DETECTED");
    expect(await b.db.applyChanges(at(1))).toMatchObject({ applied: 1 });
  });
});

describe("unauthorized versions", () => {
  /** A's next batch to B with the document's version rewritten as mallory's. */
  async function forged(a: Replica, b: Replica, id: string, clock?: Record<string, number>): Promise<ChangeBatch> {
    const batch = await nextBatch(b, a.db);
    return {
      ...batch,
      documents: batch.documents.map((doc) =>
        doc.id === id ? { ...doc, updatedBy: "mallory", ...(clock === undefined ? {} : { vectorClock: clock }) } : doc,
      ),
    };
  }

  it("become conflict rows, never primary while an authorized version exists", async () => {
    const { a, b, id } = await pair({ writers: ["alice"] });
    await edit(b.db, id, { n: 2 });
    await edit(a.db, id, { n: 1 });
    await b.db.applyChanges(await forged(a, b, id, { [a.db.instanceId]: 9 }));
    expect(primaryOf(b, id).content).toEqual({ n: 2 });
    const [row] = rowsOf(b, id) as [DocumentEnvelope];
    expect(row.updatedBy).toBe("mallory");
    const conflict = await conflictOf(b.db, id);
    expect(conflict.versions.map((version) => version.authorized)).toEqual([true, false]);
    // The unauthorized conflict row never shows up in find, even with inConflict.
    const found: string[] = [];
    for await (const doc of await b.db.find({ inConflict: true })) {
      found.push(doc.id);
    }
    expect(found).toEqual([id]);
  });

  it("can't supersede the authorized version they claim to follow", async () => {
    const { a, b, id } = await pair({ writers: ["alice"] });
    await edit(a.db, id, { n: 1 });
    const stored = primaryOf(b, id);
    await b.db.applyChanges(await forged(a, b, id));
    expect(primaryOf(b, id)).toEqual(stored);
    const [row] = rowsOf(b, id) as [DocumentEnvelope];
    expect(row).toMatchObject({ updatedBy: "mallory", content: { n: 1 } });
    expect(compare(stored.vectorClock, row.vectorClock)).toBe("before");
    // Resolving includes both, and the next authorized version supersedes them.
    await (await conflictOf(b.db, id)).resolveWithContent({ content: { n: 2 } });
    expect(rowsOf(b, id)).toEqual([]);
    await sync(a.db, b.db);
    expectIdentical([a, b]);
  });

  it("alone, is the primary and in conflict until a writer resolves it", async () => {
    const { a, b } = await pair();
    tick();
    const { id } = await a.db.create({ n: 1 }, { writers: ["alice"] });
    await b.db.applyChanges(await forged(a, b, id));
    expect(primaryOf(b, id).updatedBy).toBe("mallory");
    expect(rowsOf(b, id)).toEqual([]);
    expect((await b.db.find({ inConflict: true })).count).toBe(1);
    const conflict = await conflictOf(b.db, id);
    expect(conflict.versions.map((version) => [version.isPrimary, version.authorized])).toEqual([[true, false]]);
    await conflict.resolveWith((conflict.versions[0] as (typeof conflict.versions)[number]).document);
    expect(isAuthorizedVersion(primaryOf(b, id))).toBe(true);
    expect(await (await load(b.db, id)).conflict()).toBeUndefined();
    expect((await b.db.find({ inConflict: true })).count).toBe(0);
  });
});

describe("access rules across replicas", () => {
  it("replicates a drop box: authorized everywhere, hidden from its creator", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    tick();
    const doc = await a.db.create({ secret: 1 }, { readers: ["bob"] });
    expect(doc.writers).toEqual(["*"]);
    await sync(a.db, b.db);
    expect(b.adapter.getDocument(doc.id)).toEqual(a.adapter.getDocument(doc.id));
    expect(isAuthorizedVersion(b.adapter.getDocument(doc.id) as DocumentEnvelope)).toBe(true);
    for (const replica of [a, b]) {
      expect(await replica.db.get(doc.id)).toBeUndefined();
      expect((await replica.db.find()).count).toBe(0);
      const bobs = await openAs(bob, replica.adapter);
      expect(await bobs.get(doc.id)).toBeDefined();
      expect((await bobs.find({ inConflict: true })).count).toBe(0);
    }
  });

  it("replicates a document created with the creator added to writers as authorized", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    tick();
    const doc = await a.db.create({ x: 1 }, { writers: ["bob"] });
    await sync(a.db, b.db);
    const stored = b.adapter.getDocument(doc.id) as DocumentEnvelope;
    expect(stored.writers).toEqual(["bob", "alice"]);
    expect(isAuthorizedVersion(stored)).toBe(true);
    expect((await b.db.find({ inConflict: true })).count).toBe(0);
  });
});

describe("replicating conflict rows", () => {
  /** A and B in conflict over id; C a replica of A made before the conflict. */
  async function three(): Promise<{ a: Replica; b: Replica; c: Replica; id: string; batch: ChangeBatch; row: DocumentEnvelope }> {
    const { a, b, id } = await pair();
    const c = await replicaOf(a.db);
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const batch = await nextBatch(c, a.db);
    const row = batch.documents.find((doc) => doc.conflictOf !== undefined) as DocumentEnvelope;
    expect(row).toBeDefined();
    return { a, b, c, id, batch, row };
  }

  async function refused(c: Replica, a: Replica, batch: ChangeBatch, documents: unknown[], message?: string): Promise<void> {
    const before = { docs: c.adapter.allDocuments(), changes: c.adapter.changesSince(0) };
    const error = await expectCode(c.db.applyChanges({ ...batch, documents }), "INVALID_BATCH");
    if (message !== undefined) {
      expect(error.message).toContain(message);
    }
    expect({ docs: c.adapter.allDocuments(), changes: c.adapter.changesSince(0) }).toEqual(before);
    expect(a).toBeDefined();
  }

  it("applies a conflict row, before or after its primary in the batch", async () => {
    const { a, c, batch } = await three();
    await c.db.applyChanges({ ...batch, documents: [...batch.documents].reverse() });
    expectIdentical([a, c]);
  });

  it("applies a conflict row placed before a primary the receiver doesn't have yet", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    const c = await replicaOf(a.db);
    await settle([a, b, c]);
    tick();
    const { id } = await a.db.create({ n: 0 });
    await sync(a.db, b.db);
    await edit(a.db, id, { n: 1 });
    await edit(b.db, id, { n: 2 });
    await sync(a.db, b.db);
    const batch = await nextBatch(c, a.db);
    const rowFirst = [...batch.documents].sort((x, y) => Number(y.conflictOf !== undefined) - Number(x.conflictOf !== undefined));
    expect(rowFirst[0]?.conflictOf).toBe(id);
    await c.db.applyChanges({ ...batch, documents: rowFirst });
    expectIdentical([a, c]);
  });

  it.each<[string, (row: DocumentEnvelope) => Record<string, unknown>]>([
    ["a conflict row with the wrong id", (row) => ({ ...row, id: newId() })],
    ["a conflict row whose parentId isn't its conflictOf", (row) => ({ ...row, parentId: newId() })],
    ["a conflict row whose conflictOf isn't a UUID", (row) => ({ ...row, conflictOf: "doc" })],
    ["a conflict row of kind system", (row) => ({ ...row, kind: "system" })],
    ["a conflict row whose id was derived from another clock", (row) => ({ ...row, vectorClock: { ...row.vectorClock, [row.updatedOn]: 7 } })],
  ])("refuses %s", async (_name, mutate) => {
    const { a, c, batch, row } = await three();
    await refused(c, a, batch, batch.documents.map((doc) => (doc === row ? mutate(row) : doc)));
  });

  it("refuses a conflict row of a document this replica doesn't have", async () => {
    const { a, c, batch, row } = await three();
    const other = newId();
    const orphanRow = { ...row, conflictOf: other, parentId: other, id: conflictRowId(other, row.vectorClock) };
    await refused(c, a, batch, [orphanRow], "doesn't have");
  });

  it("refuses versions that misuse a stored conflict row", async () => {
    const { a, c, batch, row, id } = await three();
    await c.db.applyChanges(batch);
    const next = await nextBatch(c, a.db);
    const primary = a.adapter.getDocument(id) as DocumentEnvelope;
    // A plain version with a conflict row's id.
    await refused(c, a, next, [{ ...primary, id: row.id, parentId: row.id }], "conflict document here");
    // A child of a conflict row.
    await refused(c, a, next, [{ ...primary, id: newId(), parentId: row.id }], "conflict document as its parent");
    // A conflict row of a conflict row.
    const nested = { ...row, conflictOf: row.id, parentId: row.id, id: conflictRowId(row.id, row.vectorClock) };
    await refused(c, a, next, [nested], "conflict document here");
  });

  it("refuses a version whose parentId, createdAt or createdBy differs from the stored one", async () => {
    const { a, c, batch, row, id } = await three();
    const primary = batch.documents.find((doc) => doc.id === id) as DocumentEnvelope;
    const swap = (doc: DocumentEnvelope): DocumentEnvelope[] => batch.documents.map((other) => (other.id === doc.id ? doc : other));
    await refused(c, a, batch, swap({ ...primary, parentId: newId() }), "different parentId");
    await refused(c, a, batch, swap({ ...row, createdAt: "2020-01-01T00:00:00.000Z" }), "different parentId, createdAt or createdBy");
    await refused(c, a, batch, swap({ ...row, createdBy: "bob" }), "different parentId, createdAt or createdBy");
  });

  it("counts conflict rows in the rewind check", async () => {
    const { a, b, id } = await pair();
    // B edits first, so A's version is primary on B and B's own is a conflict row.
    await edit(b.db, id, { n: 2 });
    await edit(a.db, id, { n: 1 });
    await sync(a.db, b.db);
    expect(rowsOf(b, id)[0]?.updatedOn).toBe(b.db.instanceId);
    const primary = a.adapter.getDocument(id) as DocumentEnvelope;
    const batch = await nextBatch(b, a.db);
    const at = (count: number): unknown => ({
      ...batch,
      documents: [{ ...primary, vectorClock: { [a.db.instanceId]: 3, [b.db.instanceId]: count } }],
    });
    await expectCode(b.db.applyChanges(at(2)), "REWIND_DETECTED");
    expect(await b.db.applyChanges(at(1))).toMatchObject({ applied: 1 });
    expect(rowsOf(b, id)).toEqual([]);
  });

  it("still refuses concurrent system document versions", async () => {
    const { a, b } = await pair();
    const aclA = await a.db.getAcl();
    aclA.creators = ["alice", "bob"];
    await aclA.save();
    const aclB = await b.db.getAcl();
    aclB.creators = ["alice", "carol"];
    await aclB.save();
    await expectCode(b.db.pullFrom(a.db), "NOT_SUPPORTED");
    expect(b.adapter.getDocument(aclDocId(b.db.databaseId))?.content).toEqual({ creators: ["alice", "carol"], admins: ["alice"] });
  });
});
