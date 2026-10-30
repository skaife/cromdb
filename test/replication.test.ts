import fc from "fast-check";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, isKnownPolicy } from "../src/conflict-policy.js";
import type { Database } from "../src/database.js";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
import type { CromDBError } from "../src/errors.js";
import { newId } from "../src/ids.js";
import { isAuthorizedVersion } from "../src/acl.js";
import {
  parsePeerPosition,
  peerKey,
  selectChanges,
  sync,
  validateEnvelope,
  type ChangeBatch,
} from "../src/replication.js";
import { Session } from "../src/session.js";
import type { StorageAdapter } from "../src/storage/adapter.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";
import { aclDocId, databaseDocId, registrationDocId } from "../src/system-docs.js";
import { TestAdapter, expectCode } from "./helpers.js";

const alice = Session.named("alice");
const bob = Session.named("bob");

let adapters: TestAdapter[];
let time: number;
const now = (): Date => new Date(time);
const at = (): string => new Date(time).toISOString();
function tick(): void {
  time += 1000;
}

beforeEach(() => {
  adapters = [];
  time = Date.parse("2026-10-18T12:00:00.000Z");
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

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Opens the database with exportChanges returning a JSON round-tripped batch,
 * so nothing applied (through sync and pullFrom too) depends on object
 * identity.
 */
async function openAs(session: Session, adapter: StorageAdapter): Promise<Database> {
  const db = await session.openDatabase(adapter, { now });
  const exportChanges = db.exportChanges.bind(db);
  db.exportChanges = async (options) => roundTrip(await exportChanges(options));
  return db;
}

interface Replica {
  db: Database;
  adapter: TestAdapter;
}

async function founder(): Promise<Replica> {
  const adapter = newAdapter();
  return { db: await openAs(alice, adapter), adapter };
}

async function replicaOf(source: Database, session: Session = alice): Promise<Replica> {
  const adapter = newAdapter();
  tick();
  await source.createReplica(adapter);
  return { db: await openAs(session, adapter), adapter };
}

function position(replica: Replica, source: Database): number {
  return parsePeerPosition(replica.adapter.getLocal(peerKey(source.instanceId)), source.instanceId);
}

/** The next batch target would pull from source. */
async function nextBatch(target: Replica, source: Database, limit?: number): Promise<ChangeBatch> {
  return source.exportChanges({ since: position(target, source), ...(limit === undefined ? {} : { limit }) });
}

function stateOf(adapter: TestAdapter, sourceId: string): unknown {
  return {
    documents: adapter.allDocuments(),
    changes: adapter.changesSince(0),
    position: adapter.getLocal(peerKey(sourceId)),
  };
}

/** Applies the batch, expects the error code, and checks nothing changed. */
async function expectRefused(target: Replica, sourceId: string, batch: unknown, code: string): Promise<CromDBError> {
  const before = stateOf(target.adapter, sourceId);
  const error = await expectCode(target.db.applyChanges(batch), code);
  expect(stateOf(target.adapter, sourceId)).toEqual(before);
  return error;
}

function sortedById(envelopes: DocumentEnvelope[]): DocumentEnvelope[] {
  return [...envelopes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

describe("conflict policy", () => {
  it("knows only the default policy", () => {
    expect(DEFAULT_POLICY).toBe("default@1");
    expect(isKnownPolicy("default@1")).toBe(true);
    for (const name of ["default@2", "", "__proto__", "constructor", "toString"]) {
      expect(isKnownPolicy(name)).toBe(false);
    }
  });

  it("is set in local state at initialization", async () => {
    const { adapter } = await founder();
    expect(adapter.getLocal("conflictPolicy")).toBe("default@1");
  });

  it("refuses to open with no policy as INVALID_DATABASE", async () => {
    const { adapter } = await founder();
    adapter.hiddenLocalKeys.add("conflictPolicy");
    await expectCode(alice.openDatabase(adapter), "INVALID_DATABASE");
  });

  it("refuses to open with an unknown policy as UPGRADE_REQUIRED, naming it", async () => {
    const { adapter } = await founder();
    adapter.setLocal("conflictPolicy", "default@2");
    const error = await expectCode(alice.openDatabase(adapter), "UPGRADE_REQUIRED");
    expect(error.message).toContain("default@2");
  });
});

describe("createReplica", () => {
  it("refuses a non-admin before looking at the target", async () => {
    const a = await founder();
    const asBob = await openAs(bob, a.adapter);
    const target = newAdapter();
    target.setLocal("something", "x");
    await expectCode(asBob.createReplica(target), "ACCESS_DENIED");
  });

  it("refuses a non-admin, writing nothing", async () => {
    const a = await founder();
    const asBob = await openAs(bob, a.adapter);
    const before = a.adapter.allDocuments();
    const target = newAdapter();
    await expectCode(asBob.createReplica(target), "ACCESS_DENIED");
    expect(a.adapter.allDocuments()).toEqual(before);
    expect(target.isEmpty()).toBe(true);
  });

  it.each([
    ["a document", (target: TestAdapter, source: TestAdapter) => target.putDocument(source.allDocuments()[0] as DocumentEnvelope)],
    ["local state", (target: TestAdapter) => target.setLocal("something", "x")],
  ])("refuses a target with %s, changing neither side", async (_name, fill) => {
    const a = await founder();
    const target = newAdapter();
    fill(target, a.adapter);
    const sourceBefore = { documents: a.adapter.allDocuments(), changes: a.adapter.changesSince(0) };
    const targetBefore = { documents: target.allDocuments(), changes: target.changesSince(0) };
    await expectCode(a.db.createReplica(target), "INVALID_DATABASE");
    expect({ documents: a.adapter.allDocuments(), changes: a.adapter.changesSince(0) }).toEqual(sourceBefore);
    expect({ documents: target.allDocuments(), changes: target.changesSince(0) }).toEqual(targetBefore);
  });

  it("refuses its own adapter as the target", async () => {
    const a = await founder();
    await expectCode(a.db.createReplica(a.adapter), "INVALID_DATABASE");
  });

  it("copies every document unchanged and sets up the new replica", async () => {
    const a = await founder();
    const acl = await a.db.getAcl();
    acl.admins = ["alice", "carol"];
    await acl.save();
    tick();
    const parent = await a.db.create({ title: "parent", due: new Date("2026-11-01T00:00:00.000Z") });
    const child = await a.db.create({ title: "child" }, { parentId: parent.id, readers: ["alice"] });
    const gone = await a.db.create({ title: "gone" });
    tick();
    await gone.delete();

    const b = await replicaOf(a.db);
    const replicaId = b.db.instanceId;
    expect(b.db.databaseId).toBe(a.db.databaseId);
    expect(replicaId).not.toBe(a.db.instanceId);
    expect(b.adapter.getLocal("instanceId")).toBe(replicaId);
    expect(b.adapter.getLocal("conflictPolicy")).toBe("default@1");

    // Every row, system and tombstones included, with the same clocks.
    const sourceDocs = a.adapter.allDocuments();
    expect(b.adapter.allDocuments()).toEqual(sourceDocs);
    expect(sourceDocs.map((doc) => doc.id)).toEqual(
      expect.arrayContaining([
        databaseDocId(a.db.databaseId),
        aclDocId(a.db.databaseId),
        registrationDocId(a.db.databaseId, a.db.instanceId),
        parent.id,
        child.id,
        gone.id,
      ]),
    );
    expect(b.adapter.getDocument(gone.id)?.deleted).toBe(true);
    expect((await b.db.get(child.id))?.content).toEqual({ title: "child" });

    // The new replica's registration, written on the source by the admin.
    const registrationId = registrationDocId(a.db.databaseId, replicaId);
    const registration = a.adapter.getDocument(registrationId);
    expect(registration).toMatchObject({
      id: registrationId,
      parentId: registrationId,
      kind: "system",
      deleted: false,
      vectorClock: { [a.db.instanceId]: 1 },
      createdBy: "alice",
      updatedBy: "alice",
      updatedOn: a.db.instanceId,
      readers: ["alice", "carol"],
      writers: ["alice", "carol"],
      content: { instanceId: replicaId, status: "active", introducedBy: a.db.instanceId, introducedAt: at() },
      fieldTypes: {},
    });
    expect(b.adapter.getDocument(registrationId)).toEqual(registration);

    // One seeded change entry per document.
    const seeded = b.adapter.changesSince(0);
    expect(seeded).toHaveLength(sourceDocs.length);
    for (const doc of sourceDocs) {
      expect(seeded).toContainEqual({
        seq: expect.any(Number) as number,
        docId: doc.id,
        vectorClock: doc.vectorClock,
        op: doc.deleted ? "delete" : "put",
        instanceId: doc.updatedOn,
        updatedBy: doc.updatedBy,
        timestamp: doc.updatedAt,
        suspect: false,
        suspectReason: null,
      });
    }

    // Each side's position is past the snapshot.
    expect(position(b, a.db)).toBe(a.adapter.lastSeq());
    expect(position(a, b.db)).toBe(b.adapter.lastSeq());
    expect(JSON.parse(b.adapter.getLocal(peerKey(a.db.instanceId)) ?? "")).toEqual({
      lastSeq: a.adapter.lastSeq(),
      lastSyncedAt: at(),
    });

    expect(await b.db.pullFrom(a.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
    expect(await a.db.pullFrom(b.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
  });

  it.each([
    ["appendChange on the target", (_source: TestAdapter, target: TestAdapter) => (target.failAppendChange = true)],
    ["setLocal on the target", (_source: TestAdapter, target: TestAdapter) => (target.failSetLocal = true)],
    ["setLocal on the source (its last step)", (source: TestAdapter) => (source.failSetLocal = true)],
  ])("leaves the target empty when %s fails", async (_name, breakIt) => {
    const a = await founder();
    await a.db.create({ title: "x" });
    const target = newAdapter();
    breakIt(a.adapter, target);
    await expect(a.db.createReplica(target)).rejects.toThrow(/failed/);
    expect(target.isEmpty()).toBe(true);
    a.adapter.failSetLocal = false;
    target.failAppendChange = false;
    target.failSetLocal = false;

    // The orphaned registration stays on the source and does no harm.
    const registrations = a.adapter.allDocuments().filter((doc) => doc.kind === "system" && Object.hasOwn(doc.content, "status"));
    expect(registrations).toHaveLength(2);

    await a.db.createReplica(target);
    const b = await openAs(alice, target);
    expect(target.allDocuments()).toEqual(a.adapter.allDocuments());
    expect(b.databaseId).toBe(a.db.databaseId);
  });
});

describe("exportChanges", () => {
  it("refuses bad since and limit with TypeError", async () => {
    const a = await founder();
    for (const options of [{ since: -1 }, { since: 1.5 }, { limit: 0 }, { limit: -2 }, { limit: 2.5 }, { limit: Number.NaN }]) {
      await expect(a.db.exportChanges(options)).rejects.toThrow(TypeError);
    }
  });

  it("gives a plain JSON batch", async () => {
    const a = await founder();
    await a.db.create({ title: "x", when: new Date(time) });
    const exportChanges = Object.getPrototypeOf(a.db).exportChanges as Database["exportChanges"];
    const batch = await exportChanges.call(a.db, {});
    expect(JSON.parse(JSON.stringify(batch))).toEqual(batch);
    expect(batch).toMatchObject({
      format: 1,
      databaseId: a.db.databaseId,
      sourceInstanceId: a.db.instanceId,
      conflictPolicy: "default@1",
      since: 0,
      toSeq: 4,
      hasMore: false,
      sourceLastSeq: 4,
    });
    expect(batch.documents).toHaveLength(4);
  });

  it("is empty past the end", async () => {
    const a = await founder();
    const batch = await a.db.exportChanges({ since: 99 });
    expect(batch).toMatchObject({ since: 99, toSeq: 99, hasMore: false, sourceLastSeq: 3, documents: [] });
  });
});

describe("selectChanges", () => {
  const entry = (seq: number, docId: string): ChangeEntry => ({
    seq,
    docId,
    vectorClock: {},
    op: "put",
    instanceId: "i",
    updatedBy: "alice",
    timestamp: "2026-10-18T12:00:00.000Z",
    suspect: false,
    suspectReason: null,
  });

  it("stops before the entry that would exceed the limit", () => {
    const entries = [entry(3, "a"), entry(4, "b"), entry(5, "a"), entry(6, "c"), entry(7, "b")];
    expect(selectChanges(entries, 2, 2)).toEqual({ docIds: ["a", "b"], toSeq: 5, hasMore: true });
    expect(selectChanges(entries, 2, 3)).toEqual({ docIds: ["a", "b", "c"], toSeq: 7, hasMore: false });
    expect(selectChanges([], 2, 3)).toEqual({ docIds: [], toSeq: 2, hasMore: false });
  });

  it("pages through every document, each once per page, in first-seen order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "b", "c", "d", "e", "__proto__", "constructor"), { maxLength: 40 }),
        fc.integer({ min: 1, max: 6 }),
        (docIds, limit) => {
          const entries = docIds.map((docId, index) => entry(index + 1, docId));
          let since = 0;
          const seen = new Set<string>();
          for (let pages = 0; ; pages++) {
            expect(pages).toBeLessThanOrEqual(entries.length);
            const page = selectChanges(
              entries.filter((e) => e.seq > since),
              since,
              limit,
            );
            const taken = entries.filter((e) => e.seq > since && e.seq <= page.toSeq);
            expect(page.docIds).toEqual([...new Set(taken.map((e) => e.docId))]);
            expect(page.docIds.length).toBeLessThanOrEqual(limit);
            const next = entries.find((e) => e.seq > page.toSeq);
            expect(page.hasMore).toBe(next !== undefined);
            if (next !== undefined) {
              expect(page.docIds).toHaveLength(limit);
              expect(page.docIds).not.toContain(next.docId);
            }
            page.docIds.forEach((id) => seen.add(id));
            if (!page.hasMore) {
              break;
            }
            expect(page.toSeq).toBeGreaterThan(since);
            since = page.toSeq;
          }
          expect(seen).toEqual(new Set(docIds));
        },
      ),
    );
  });
});

describe("isAuthorizedVersion", () => {
  const version = (overrides: Partial<DocumentEnvelope>): DocumentEnvelope => ({
    id: "d",
    parentId: "d",
    kind: "document",
    vectorClock: { i: 1 },
    deleted: false,
    createdAt: "2026-10-18T12:00:00.000Z",
    createdBy: "alice",
    updatedAt: "2026-10-18T12:00:00.000Z",
    updatedBy: "alice",
    updatedOn: "i",
    readers: ["*"],
    writers: ["alice"],
    content: {},
    fieldTypes: {},
    ...overrides,
  });

  it("checks updatedBy against the version's own writers", () => {
    expect(isAuthorizedVersion(version({}))).toBe(true);
    expect(isAuthorizedVersion(version({ updatedBy: "ALICE" }))).toBe(true);
    expect(isAuthorizedVersion(version({ updatedBy: "bob" }))).toBe(false);
    expect(isAuthorizedVersion(version({ updatedBy: "bob", writers: ["*"] }))).toBe(true);
    expect(isAuthorizedVersion(version({ updatedBy: "anonymous", writers: ["*"] }))).toBe(false);
    expect(isAuthorizedVersion(version({ updatedBy: "anonymous", writers: ["anonymous"] }))).toBe(true);
    expect(isAuthorizedVersion(version({ updatedBy: "bob", writers: ["anonymous"] }))).toBe(true);
  });

  it('allows "system" on system documents only', () => {
    expect(isAuthorizedVersion(version({ kind: "system", updatedBy: "system" }))).toBe(true);
    expect(isAuthorizedVersion(version({ updatedBy: "system", writers: ["*"] }))).toBe(false);
  });
});

describe("pull", () => {
  it("brings an edit across unchanged, with a change entry naming the writer's replica", async () => {
    const a = await founder();
    const doc = await a.db.create<{ title: string }>({ title: "one" });
    const b = await replicaOf(a.db);
    tick();
    doc.content.title = "two";
    await doc.save();

    const lastSeq = b.adapter.lastSeq();
    expect(await b.db.pullFrom(a.db)).toEqual({ applied: 1, skipped: 0, batches: 1 });
    const stored = b.adapter.getDocument(doc.id);
    expect(stored).toEqual(a.adapter.getDocument(doc.id));
    expect(stored?.vectorClock).toEqual({ [a.db.instanceId]: 2 });
    expect(stored).toMatchObject({ updatedBy: "alice", updatedOn: a.db.instanceId, createdAt: doc.createdAt.toISOString() });
    expect((await b.db.get<{ title: string }>(doc.id))?.content.title).toBe("two");

    expect(b.adapter.changesSince(lastSeq)).toEqual([
      {
        seq: lastSeq + 1,
        docId: doc.id,
        vectorClock: { [a.db.instanceId]: 2 },
        op: "put",
        instanceId: a.db.instanceId,
        updatedBy: "alice",
        timestamp: at(),
        suspect: false,
        suspectReason: null,
      },
    ]);
    expect(position(b, a.db)).toBe(a.adapter.lastSeq());
  });

  it("brings a create and a delete across, the tombstone as a tombstone", async () => {
    const a = await founder();
    const existing = await a.db.create({ title: "old" });
    const b = await replicaOf(a.db);
    tick();
    const created = await b.db.create({ title: "new" }, { readers: ["bob"] });
    const loaded = await b.db.get(existing.id);
    await loaded?.delete();

    expect(await a.db.pullFrom(b.db)).toMatchObject({ applied: 2 });
    expect(a.adapter.getDocument(created.id)).toEqual(b.adapter.getDocument(created.id));
    expect(a.adapter.getDocument(existing.id)).toEqual(b.adapter.getDocument(existing.id));
    expect(a.adapter.getDocument(existing.id)).toMatchObject({ deleted: true, deletedAt: at(), content: {} });
    expect(await a.db.get(existing.id)).toBeUndefined();
    expect(a.adapter.changesSince(0).at(-1)).toMatchObject({ docId: existing.id, op: "delete", instanceId: b.db.instanceId });
  });

  it("makes both sides identical after edits on each and sync", async () => {
    const a = await founder();
    const shared = await a.db.create<{ n: number }>({ n: 1 });
    const b = await replicaOf(a.db);
    tick();
    await a.db.create({ from: "a" });
    shared.content.n = 2;
    await shared.save();
    const onB = await b.db.create({ from: "b", when: new Date(time) });
    const bobOnB = await openAs(bob, b.adapter);
    const edited = await bobOnB.get<{ from: string }>(onB.id);
    tick();
    if (edited === undefined) {
      throw new Error("missing");
    }
    edited.content.from = "b, edited by bob";
    await edited.save();

    await sync(a.db, b.db);
    expect(sortedById(a.adapter.allDocuments())).toEqual(sortedById(b.adapter.allDocuments()));
    expect(a.adapter.getDocument(onB.id)?.updatedBy).toBe("bob");

    // Echoes come back as equal versions and are skipped.
    expect(await b.db.pullFrom(a.db)).toMatchObject({ applied: 0 });
    expect(await a.db.pullFrom(b.db)).toMatchObject({ applied: 0 });
    await sync(a.db, b.db);
    expect(await b.db.pullFrom(a.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
    expect(await a.db.pullFrom(b.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
  });

  it("pages with a limit and ends at the source's last seq", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    tick();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await a.db.create({ i })).id);
    }
    const sizes: number[] = [];
    for (;;) {
      const batch = await nextBatch(b, a.db, 2);
      sizes.push(batch.documents.length);
      const result = await b.db.applyChanges(batch);
      expect(position(b, a.db)).toBe(result.toSeq);
      if (!result.hasMore) {
        break;
      }
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(position(b, a.db)).toBe(a.adapter.lastSeq());
    for (const id of ids) {
      expect(b.adapter.getDocument(id)).toEqual(a.adapter.getDocument(id));
    }
  });

  it("sends a document edited three times once, as its latest version", async () => {
    const a = await founder();
    const doc = await a.db.create<{ n: number }>({ n: 0 });
    const b = await replicaOf(a.db);
    for (let n = 1; n <= 3; n++) {
      tick();
      doc.content.n = n;
      await doc.save();
    }
    const batch = await nextBatch(b, a.db);
    expect(batch.documents).toHaveLength(1);
    expect(batch.documents[0]?.vectorClock).toEqual({ [a.db.instanceId]: 4 });
    expect(await b.db.applyChanges(batch)).toEqual({ applied: 1, skipped: 0, toSeq: a.adapter.lastSeq(), hasMore: false });
  });

  it("skips a version older than the stored one", async () => {
    const a = await founder();
    const doc = await a.db.create<{ n: number }>({ n: 1 });
    const b = await replicaOf(a.db);
    const c = await replicaOf(b.db);
    tick();
    doc.content.n = 2;
    await doc.save();
    await c.db.pullFrom(a.db);
    const onC = await c.db.get<{ n: number }>(doc.id);
    if (onC === undefined) {
      throw new Error("missing");
    }
    tick();
    onC.content.n = 3;
    await onC.save();
    await b.db.pullFrom(c.db);
    const newer = b.adapter.getDocument(doc.id);
    expect(newer?.vectorClock).toEqual({ [a.db.instanceId]: 2, [c.db.instanceId]: 1 });

    const batch = await nextBatch(b, a.db);
    expect(batch.documents.find((d) => d.id === doc.id)?.vectorClock).toEqual({ [a.db.instanceId]: 2 });
    expect(await b.db.applyChanges(batch)).toMatchObject({ applied: 0 });
    expect(b.adapter.getDocument(doc.id)).toEqual(newer);
  });

  it("replicates a document only alice can read", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    const secret = await a.db.create({ secret: true }, { readers: ["alice"], writers: ["alice"] });
    await b.db.pullFrom(a.db);
    expect(b.adapter.getDocument(secret.id)).toEqual(a.adapter.getDocument(secret.id));
    expect(await (await openAs(bob, b.adapter)).get(secret.id)).toBeUndefined();
  });

  it("detects a source restored from an old file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cromdb-replication-"));
    const path = join(dir, "a.db");
    const snapshot = join(dir, "a-snapshot.db");
    const fileAdapters: SqliteAdapter[] = [];
    const openFile = async (file: string): Promise<Database> => {
      const adapter = SqliteAdapter.open(file);
      fileAdapters.push(adapter);
      return openAs(alice, adapter);
    };
    try {
      const a = await openFile(path);
      const doc = await a.create<{ n: number }>({ n: 1 });
      const b = await replicaOf(a);
      await sync(a, b.db);

      // Snapshot A's file while closed.
      fileAdapters.pop()?.close();
      expect(existsSync(`${path}-wal`)).toBe(false);
      copyFileSync(path, snapshot);

      const later = await openFile(path);
      const loaded = await later.get<{ n: number }>(doc.id);
      if (loaded === undefined) {
        throw new Error("missing");
      }
      tick();
      loaded.content.n = 2;
      await loaded.save();
      await later.create({ more: true });
      expect(await b.db.pullFrom(later)).toMatchObject({ applied: 2 });
      fileAdapters.pop()?.close();

      const restored = await openFile(snapshot);
      expect(restored.instanceId).toBe(a.instanceId);
      const before = stateOf(b.adapter, restored.instanceId);
      const error = await expectCode(b.db.pullFrom(restored), "REWIND_DETECTED");
      expect(error.message).toContain("full resync");
      expect(stateOf(b.adapter, restored.instanceId)).toEqual(before);
    } finally {
      for (const adapter of fileAdapters) {
        adapter.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a replica once its registration arrives from a known one", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    const c = await replicaOf(b.db);
    tick();
    const fromC = await c.db.create({ from: "c" });

    const error = await expectRefused(a, c.db.instanceId, await nextBatch(a, c.db), "SYNC_MISMATCH");
    expect(error.message).toContain("does not know");

    await a.db.pullFrom(b.db);
    expect(a.adapter.getDocument(registrationDocId(a.db.databaseId, c.db.instanceId))?.content).toMatchObject({
      instanceId: c.db.instanceId,
      introducedBy: b.db.instanceId,
    });
    expect(await a.db.pullFrom(c.db)).toMatchObject({ applied: 1 });
    expect(a.adapter.getDocument(fromC.id)).toEqual(c.adapter.getDocument(fromC.id));
  });
});

describe("syncPosition", () => {
  /** One pull done only through syncPosition, exportChanges, JSON text and applyChanges. */
  async function pullAsText(target: Database, source: Database, limit: number): Promise<number> {
    let batches = 0;
    for (;;) {
      const since = JSON.parse(JSON.stringify(await target.syncPosition(source.instanceId))) as number;
      const text = JSON.stringify(await source.exportChanges({ since, limit }));
      const result = await target.applyChanges(JSON.parse(text));
      batches++;
      if (!result.hasMore) {
        return batches;
      }
    }
  }

  it("refuses a sourceInstanceId that isn't a string with TypeError", async () => {
    const a = await founder();
    for (const value of [undefined, null, 7, {}, ["x"]]) {
      await expect(a.db.syncPosition(value as unknown as string)).rejects.toThrow(TypeError);
    }
  });

  it("is 0 for a source never pulled from", async () => {
    const a = await founder();
    for (const id of [newId(), "", "__proto__", "constructor", "toString"]) {
      expect(await a.db.syncPosition(id)).toBe(0);
    }
  });

  it("is the stored position, after createReplica and after a pull", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    expect(await b.db.syncPosition(a.db.instanceId)).toBe(position(b, a.db));
    expect(await a.db.syncPosition(b.db.instanceId)).toBe(position(a, b.db));
    tick();
    await a.db.create({ n: 1 });
    await b.db.pullFrom(a.db);
    expect(await b.db.syncPosition(a.db.instanceId)).toBe(a.adapter.lastSeq());
  });

  it("is the stored position after a pull through a custom transport", async () => {
    const a = await founder();
    const b = await replicaOf(a.db);
    tick();
    for (let i = 0; i < 5; i++) {
      await a.db.create({ i });
    }
    expect(await pullAsText(b.db, a.db, 2)).toBe(3);
    expect(await b.db.syncPosition(a.db.instanceId)).toBe(a.adapter.lastSeq());
    expect(position(b, a.db)).toBe(a.adapter.lastSeq());
  });

  it("refuses non-admins with ACCESS_DENIED", async () => {
    const a = await founder();
    const bobOnA = await openAs(bob, a.adapter);
    await expectCode(bobOnA.syncPosition(newId()), "ACCESS_DENIED");
  });

  it("refuses a malformed stored position with INVALID_DATABASE", async () => {
    const a = await founder();
    const source = newId();
    a.adapter.setLocal(peerKey(source), "{}");
    await expectCode(a.db.syncPosition(source), "INVALID_DATABASE");
  });

  it("makes both sides identical with a two-way sync done only through JSON text", async () => {
    const a = await founder();
    const shared = await a.db.create<{ n: number }>({ n: 1 });
    const b = await replicaOf(a.db);
    tick();
    for (let i = 0; i < 3; i++) {
      await a.db.create({ from: "a", i });
      await b.db.create({ from: "b", i, when: new Date(time) });
    }
    shared.content.n = 2;
    await shared.save();
    const onB = await b.db.get<{ n: number }>(shared.id);
    if (onB === undefined) {
      throw new Error("missing");
    }
    onB.content.n = 3;
    await onB.save();
    tick();

    await pullAsText(b.db, a.db, 2);
    await pullAsText(a.db, b.db, 2);
    await pullAsText(b.db, a.db, 2);
    expect(sortedById(a.adapter.allDocuments())).toEqual(sortedById(b.adapter.allDocuments()));
    expect(await a.db.syncPosition(b.db.instanceId)).toBe(b.adapter.lastSeq());
    expect(await b.db.syncPosition(a.db.instanceId)).toBe(a.adapter.lastSeq());
    expect((await a.db.find({ inConflict: true })).count).toBe(1);

    // Nothing left to send either way.
    expect(await b.db.pullFrom(a.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
    expect(await a.db.pullFrom(b.db)).toEqual({ applied: 0, skipped: 0, batches: 1 });
  });
});

describe("refusals", () => {
  let a: Replica;
  let b: Replica;
  let batch: ChangeBatch;

  beforeEach(async () => {
    a = await founder();
    b = await replicaOf(a.db);
    tick();
    await a.db.create({ first: 1 });
    await a.db.create({ second: 2 });
    await a.db.create({ third: 3, when: new Date(time) });
    batch = await nextBatch(b, a.db);
    expect(batch.documents).toHaveLength(3);
  });

  const refuse = (value: unknown, code: string): Promise<CromDBError> => expectRefused(b, a.db.instanceId, value, code);

  it("refuses a different databaseId, conflictPolicy or unicodeVersion with SYNC_MISMATCH, naming both", async () => {
    const otherId = newId();
    const cases: [Partial<ChangeBatch>, string, string][] = [
      [{ databaseId: otherId }, otherId, a.db.databaseId],
      [{ conflictPolicy: "other@1" }, "other@1", "default@1"],
      [{ unicodeVersion: "15.1" }, "15.1", batch.unicodeVersion],
    ];
    for (const [change, theirs, ours] of cases) {
      const error = await refuse({ ...batch, ...change }, "SYNC_MISMATCH");
      expect(error.message).toContain(JSON.stringify(theirs));
      expect(error.message).toContain(JSON.stringify(ours));
    }
  });

  it("refuses an unknown source, a retired one, and itself", async () => {
    await refuse({ ...batch, sourceInstanceId: newId() }, "SYNC_MISMATCH");
    const self = await refuse({ ...batch, sourceInstanceId: b.db.instanceId, since: 0 }, "SYNC_MISMATCH");
    expect(self.message).toContain("comes from this replica");

    const registrationId = registrationDocId(a.db.databaseId, a.db.instanceId);
    const registration = b.adapter.getDocument(registrationId) as DocumentEnvelope;
    b.adapter.putDocument({ ...registration, content: { ...registration.content, status: "retired" } });
    const error = await refuse(batch, "SYNC_MISMATCH");
    expect(error.message).toContain("not active");
  });

  it("refuses a batch that doesn't start at the stored position", async () => {
    await refuse({ ...batch, since: batch.since - 1 }, "SYNC_MISMATCH");
    await b.db.applyChanges(batch);
    // The same batch again is stale.
    await refuse(batch, "SYNC_MISMATCH");
  });

  it("refuses a source whose change log is behind our position with REWIND_DETECTED", async () => {
    // The batch a source past its end sends: empty, at since.
    const behind = { ...batch, toSeq: batch.since, hasMore: false, documents: [], sourceLastSeq: batch.since - 1 };
    const error = await refuse(behind, "REWIND_DETECTED");
    expect(error.message).toContain(`ours ${batch.since}, theirs ${batch.since - 1}`);
    expect(error.message).toContain("full resync");
    // Caught before the since check, whatever since says.
    await refuse({ ...batch, since: 0, toSeq: 1, sourceLastSeq: 1 }, "REWIND_DETECTED");
    // Equal to our position is fine.
    expect(await b.db.applyChanges({ ...behind, sourceLastSeq: batch.since })).toMatchObject({ applied: 0 });
  });

  it("refuses concurrent edits of a system document with NOT_SUPPORTED", async () => {
    await b.db.applyChanges(batch);
    tick();
    const onA = await a.db.getAcl();
    const onB = await b.db.getAcl();
    onA.creators = ["alice", "bob"];
    await onA.save();
    onB.creators = ["alice", "carol"];
    await onB.save();
    const error = await expectRefused(b, a.db.instanceId, await nextBatch(b, a.db), "NOT_SUPPORTED");
    expect(error.message).toContain("both replicas");
  });

  it("refuses an unauthorized system document version with NOT_SUPPORTED", async () => {
    await b.db.applyChanges(batch);
    const acl = await a.db.getAcl();
    acl.creators = ["alice", "bob"];
    tick();
    await acl.save();
    const next = await nextBatch(b, a.db);
    const documents = next.documents.map((doc) => (doc.id === aclDocId(a.db.databaseId) ? { ...doc, updatedBy: "mallory" } : doc));
    await expectRefused(b, a.db.instanceId, { ...next, documents }, "NOT_SUPPORTED");
  });

  it("refuses a document written as system with INVALID_BATCH", async () => {
    const [first, ...rest] = batch.documents as [DocumentEnvelope, ...DocumentEnvelope[]];
    // The engine never writes a document as "system", so that is malformed.
    await refuse({ ...batch, documents: [...rest, { ...first, updatedBy: "system" }] }, "INVALID_BATCH");
  });

  it("refuses a system row with conflictOf set with INVALID_BATCH, writing nothing", async () => {
    await b.db.applyChanges(batch);
    const acl = await a.db.getAcl();
    acl.creators = ["alice", "bob"];
    tick();
    await acl.save();
    const next = await nextBatch(b, a.db);
    const aclId = aclDocId(a.db.databaseId);
    const [document] = batch.documents as [DocumentEnvelope];
    for (const conflictOf of [aclId, document.id]) {
      const documents = next.documents.map((doc) => (doc.id === aclId ? { ...doc, conflictOf } : doc));
      expect(documents.some((doc) => doc.kind === "system" && doc.conflictOf === conflictOf)).toBe(true);
      await expectRefused(b, a.db.instanceId, { ...next, documents }, "INVALID_BATCH");
    }
    await b.db.applyChanges(next);
  });

  it("refuses a version carrying this replica's counter ahead of it with REWIND_DETECTED", async () => {
    const [first, ...rest] = batch.documents as [DocumentEnvelope, ...DocumentEnvelope[]];
    const rewound = { ...first, vectorClock: { ...first.vectorClock, [b.db.instanceId]: 1 } };
    await refuse({ ...batch, documents: [...rest, rewound] }, "REWIND_DETECTED");

    // Also for a document this replica already holds.
    await b.db.applyChanges(batch);
    tick();
    const doc = await a.db.get<{ first: number }>(first.id);
    if (doc === undefined) {
      throw new Error("missing");
    }
    doc.content.first = 5;
    await doc.save();
    const next = await nextBatch(b, a.db);
    const [edited] = next.documents as [DocumentEnvelope];
    await expectRefused(b, a.db.instanceId, { ...next, documents: [{ ...edited, vectorClock: { ...edited.vectorClock, [b.db.instanceId]: 7 } }] }, "REWIND_DETECTED");
  });

  it("applies none of the earlier documents when the last one fails", async () => {
    const documents = [...batch.documents];
    documents[2] = { ...(documents[2] as DocumentEnvelope), createdAt: "yesterday" };
    await refuse({ ...batch, documents }, "INVALID_BATCH");
    // And when the last fails a later step.
    const third = documents[2] as DocumentEnvelope;
    documents[2] = { ...third, createdAt: at(), vectorClock: { ...third.vectorClock, [b.db.instanceId]: 1 } };
    await refuse({ ...batch, documents }, "REWIND_DETECTED");
  });

  it("refuses non-admins with ACCESS_DENIED", async () => {
    const bobOnA = await openAs(bob, a.adapter);
    const bobOnB = await openAs(bob, b.adapter);
    await expectCode(bobOnA.exportChanges(), "ACCESS_DENIED");
    await expectRefused({ db: bobOnB, adapter: b.adapter }, a.db.instanceId, batch, "ACCESS_DENIED");
    await expectCode(bobOnB.pullFrom(a.db), "ACCESS_DENIED");
  });

  describe("malformed batches", () => {
    it.each<[string, (value: Record<string, unknown>) => unknown]>([
      ["not an object", () => null],
      ["an array", () => []],
      ["format 2", (value) => ({ ...value, format: 2 })],
      ["a missing field", ({ hasMore: _hasMore, ...value }) => value],
      ["an extra field", (value) => ({ ...value, extra: 1 })],
      ["a negative since", (value) => ({ ...value, since: -1 })],
      ["toSeq before since", (value) => ({ ...value, toSeq: (value["since"] as number) - 1 })],
      ["documents not an array", (value) => ({ ...value, documents: {} })],
      ["no sourceLastSeq", ({ sourceLastSeq: _last, ...value }) => value],
      ["a fractional sourceLastSeq", (value) => ({ ...value, sourceLastSeq: 7.5 })],
      ["a negative sourceLastSeq", (value) => ({ ...value, sourceLastSeq: -1 })],
      ["a string sourceLastSeq", (value) => ({ ...value, sourceLastSeq: String(value["sourceLastSeq"]) })],
      ["sourceLastSeq below toSeq", (value) => ({ ...value, sourceLastSeq: (value["toSeq"] as number) - 1 })],
      [
        "an empty batch at since but with hasMore, above sourceLastSeq",
        (value) => ({ ...value, toSeq: value["since"], documents: [], hasMore: true, sourceLastSeq: 0 }),
      ],
      ["a Map", (value) => new Map(Object.entries(value))],
    ])("refuses %s with INVALID_BATCH", async (_name, mutate) => {
      await refuse(mutate({ ...batch }), "INVALID_BATCH");
    });

    it("refuses a getter in the header", async () => {
      const value: Record<string, unknown> = { ...batch };
      Object.defineProperty(value, "since", { get: () => batch.since, enumerable: true });
      const error = await refuse(value, "INVALID_BATCH");
      expect(error.message).toContain("not a data property");
    });
  });

  describe("malformed documents", () => {
    type Doc = Record<string, unknown>;
    const cases: [string, (doc: Doc, context: { a: Database; b: Database }) => unknown, string?][] = [
      ["not an object", () => "doc"],
      ["no id", ({ id: _id, ...doc }) => doc],
      ["an empty id", (doc) => ({ ...doc, id: "" })],
      ["an unknown kind", (doc) => ({ ...doc, kind: "folder" })],
      ["deleted not a boolean", (doc) => ({ ...doc, deleted: "no" })],
      ["deletedAt while not deleted", (doc) => ({ ...doc, deletedAt: doc["updatedAt"] })],
      ["deleted without deletedAt", (doc) => ({ ...doc, deleted: true })],
      ["a date-only updatedAt", (doc) => ({ ...doc, updatedAt: "2026-10-18" })],
      ["a negative clock count", (doc, { a }) => ({ ...doc, vectorClock: { [a.instanceId]: -1 } })],
      ["a fractional clock count", (doc, { a }) => ({ ...doc, vectorClock: { [a.instanceId]: 1.5 } })],
      ["no clock entry for updatedOn", (doc) => ({ ...doc, vectorClock: { [newId()]: 1 } })],
      ["only another replica's \"/n\" key", (doc) => ({ ...doc, vectorClock: { [`${newId()}/1`]: 1 } })],
      ["updatedOn's \"/n\" key at 0", (doc) => ({ ...doc, vectorClock: { [`${String(doc["updatedOn"])}/1`]: 0 } })],
      ["a clock key that isn't a UUID", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), other: 1 } })],
      ["a clock key \"/0\"", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), [`${newId()}/0`]: 1 } })],
      ["a clock key with a leading zero", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), [`${newId()}/01`]: 1 } })],
      ["a clock key with two slashes", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), [`${newId()}/1/2`]: 1 } })],
      ["a clock key ending in a slash", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), [`${newId()}/`]: 1 } })],
      ["a clock key with a negative n", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), [`${newId()}/-1`]: 1 } })],
      ["a clock key whose prefix isn't a UUID", (doc) => ({ ...doc, vectorClock: { ...(doc["vectorClock"] as object), "replica/1": 1 } })],
      ["updatedOn not a UUID", (doc) => ({ ...doc, updatedOn: "replica-a" })],
      ["a reserved updatedBy", (doc) => ({ ...doc, updatedBy: "System" })],
      ["updatedBy not in NFKC form", (doc) => ({ ...doc, updatedBy: "ａlice" })],
      ["empty readers", (doc) => ({ ...doc, readers: [] })],
      ["readers not in NFKC form", (doc) => ({ ...doc, readers: ["ａlice"] })],
      ["duplicate writers", (doc) => ({ ...doc, writers: ["bob", "BOB"] })],
      ["array content", (doc) => ({ ...doc, content: [1] })],
      ["content with a non-finite number", (doc) => ({ ...doc, content: { n: Number.POSITIVE_INFINITY } })],
      ["content with undefined", (doc) => ({ ...doc, content: { n: undefined } })],
      ["content with a Date", (doc) => ({ ...doc, content: { n: new Date() } })],
      ["a field type that doesn't resolve", (doc) => ({ ...doc, fieldTypes: { "/missing": "datetime" } })],
      ["an unknown field type", (doc) => ({ ...doc, fieldTypes: { "/third": "integer" } })],
      ["an extra field", (doc) => ({ ...doc, colour: "red" })],
      ["a document kind with the ACL's id", (doc, { a }) => ({ ...doc, id: aclDocId(a.databaseId), parentId: aclDocId(a.databaseId) })],
      ["a system document as parent", (doc, { a }) => ({ ...doc, parentId: aclDocId(a.databaseId) })],
      ["a registration as parent", (doc, { a }) => ({ ...doc, parentId: registrationDocId(a.databaseId, a.instanceId) })],
      ["a kind that differs from the stored one", (doc, { a }) => ({ ...doc, id: registrationDocId(a.databaseId, a.instanceId), parentId: registrationDocId(a.databaseId, a.instanceId) })],
      ["a conflictOf that isn't a UUID", (doc) => ({ ...doc, conflictOf: "x" })],
      ["a document kind with an ID that isn't a UUID", (doc) => ({ ...doc, id: "doc-1", parentId: "doc-1" })],
    ];

    it.each(cases)("refuses %s", async (_name, mutate, code = "INVALID_BATCH") => {
      const [first, ...rest] = batch.documents as [DocumentEnvelope, ...DocumentEnvelope[]];
      const third = rest[1] as DocumentEnvelope;
      // The third document has a datetime field; use it so field types are in play.
      const target = { ...third } as Doc;
      await refuse({ ...batch, documents: [first, rest[0], mutate(target, { a: a.db, b: b.db })] }, code);
    });

    it("refuses the same document twice", async () => {
      const [first] = batch.documents as [DocumentEnvelope];
      await refuse({ ...batch, documents: [...batch.documents, first] }, "INVALID_BATCH");
    });

    it("refuses a getter in a document", async () => {
      const doc: Record<string, unknown> = { ...batch.documents[0] };
      const content = batch.documents[0]?.content;
      Object.defineProperty(doc, "content", { get: () => content, enumerable: true });
      const error = await refuse({ ...batch, documents: [doc] }, "INVALID_BATCH");
      expect(error.message).toContain("not a data property");
    });

    it("applies system documents first, so a child of a new registration in the same batch is caught", async () => {
      const c = await replicaOf(a.db);
      const registrationId = registrationDocId(a.db.databaseId, c.db.instanceId);
      const next = await nextBatch(b, a.db);
      const registration = next.documents.find((doc) => doc.id === registrationId) as DocumentEnvelope;
      const child = { ...(next.documents[0] as DocumentEnvelope), parentId: registrationId };
      const error = await expectRefused(b, a.db.instanceId, { ...next, documents: [child, registration] }, "INVALID_BATCH");
      expect(error.message).toContain("system document as its parent");
    });

    describe("system documents", () => {
      async function systemBatch(): Promise<{ batch: ChangeBatch; acl: DocumentEnvelope }> {
        const acl = await a.db.getAcl();
        acl.creators = ["alice", "bob"];
        tick();
        await acl.save();
        const next = await nextBatch(b, a.db);
        const envelope = next.documents.find((doc) => doc.id === aclDocId(a.db.databaseId)) as DocumentEnvelope;
        return { batch: next, acl: envelope };
      }

      it("applies an ACL edit", async () => {
        const { batch: next } = await systemBatch();
        await b.db.applyChanges(next);
        expect(b.adapter.getDocument(aclDocId(a.db.databaseId))).toEqual(a.adapter.getDocument(aclDocId(a.db.databaseId)));
        expect(await (await openAs(bob, b.adapter)).myAccess()).toEqual({ create: true, admin: false });
      });

      it.each<[string, (acl: DocumentEnvelope, db: Database) => unknown]>([
        ["an ACL with \"*\" in admins", (acl) => ({ ...acl, content: { creators: ["*"], admins: ["*"] } })],
        ["an ACL with a missing list", (acl) => ({ ...acl, content: { admins: ["alice"] } })],
        ["a system document with \"*\" in writers", (acl) => ({ ...acl, writers: ["*"] })],
        ["a deleted system document", (acl) => ({ ...acl, deleted: true, deletedAt: acl.updatedAt })],
        ["a system document that is a child", (acl) => ({ ...acl, parentId: newId() })],
        ["a system document with field types", (acl) => ({ ...acl, fieldTypes: { "/creators/0": "datetime" } })],
        ["an unknown system document", (acl) => ({ ...acl, id: newId(), parentId: undefined })],
        [
          "a database document for another database",
          (acl, db) => ({
            ...acl,
            id: databaseDocId(db.databaseId),
            parentId: databaseDocId(db.databaseId),
            content: { databaseId: newId(), createdAt: acl.createdAt, createdOn: db.instanceId, unicodeVersion: "17.0" },
          }),
        ],
        [
          "a registration whose id doesn't match its instanceId",
          (acl, db) => ({
            ...acl,
            id: registrationDocId(db.databaseId, newId()),
            parentId: registrationDocId(db.databaseId, newId()),
            content: { instanceId: newId(), status: "active", introducedBy: null, introducedAt: acl.createdAt },
          }),
        ],
        [
          "a registration with an unknown status",
          (acl, db) => {
            const instanceId = newId();
            const id = registrationDocId(db.databaseId, instanceId);
            return { ...acl, id, parentId: id, content: { instanceId, status: "paused", introducedBy: null, introducedAt: acl.createdAt } };
          },
        ],
      ])("refuses %s", async (_name, mutate) => {
        const { batch: next, acl } = await systemBatch();
        let doc = mutate(acl, a.db) as Record<string, unknown>;
        if (doc["parentId"] === undefined) {
          doc = { ...doc, parentId: doc["id"] };
        }
        await expectRefused(b, a.db.instanceId, { ...next, documents: [doc] }, "INVALID_BATCH");
      });
    });
  });
});

describe("validateEnvelope", () => {
  it("accepts any engine-shaped envelope after a JSON round trip, as a copy", () => {
    const databaseId = newId();
    const instanceId = newId();
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.boolean(), (content, deleted) => {
        const envelope: DocumentEnvelope = {
          id: newId(),
          parentId: newId(),
          kind: "document",
          vectorClock: { [instanceId]: 3, [newId()]: 1, [`${instanceId}/2`]: 4 },
          deleted,
          ...(deleted ? { deletedAt: "2026-10-18T12:00:00.000Z" } : {}),
          createdAt: "2026-10-18T12:00:00.000Z",
          createdBy: "anonymous",
          updatedAt: "2026-10-18T12:00:00.000Z",
          updatedBy: "Scott Skaife",
          updatedOn: instanceId,
          readers: ["*", "anonymous"],
          writers: ["Scott Skaife"],
          content: roundTrip(content) as DocumentEnvelope["content"],
          fieldTypes: {},
        };
        const input = roundTrip(envelope);
        const result = validateEnvelope(input, { databaseId, unicodeVersion: "17.0" });
        expect(result).toEqual(envelope);
        expect(result).not.toBe(input);
        expect(result.content).not.toBe(input.content);
      }),
    );
  });

  it("keeps keys like __proto__ as own data", () => {
    const content = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2, "toString": 3}') as DocumentEnvelope["content"];
    const instanceId = newId();
    const id = newId();
    const result = validateEnvelope(
      {
        id,
        parentId: id,
        kind: "document",
        vectorClock: { [instanceId]: 1 },
        deleted: false,
        createdAt: "2026-10-18T12:00:00.000Z",
        createdBy: "alice",
        updatedAt: "2026-10-18T12:00:00.000Z",
        updatedBy: "alice",
        updatedOn: instanceId,
        readers: ["*"],
        writers: ["*"],
        content,
        fieldTypes: {},
      },
      { databaseId: newId(), unicodeVersion: "17.0" },
    );
    expect(Object.keys(result.content)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getPrototypeOf(result.content)).toBe(Object.prototype);
  });
});

describe("validateEnvelope clock keys", () => {
  it('accepts "/n" keys, and a clock whose only entry for updatedOn is one of its "/n" keys', () => {
    const instanceId = newId();
    const id = newId();
    const envelope = (vectorClock: Record<string, number>): unknown => ({
      id,
      parentId: id,
      kind: "document",
      vectorClock,
      deleted: false,
      createdAt: "2026-10-19T12:00:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-10-19T12:00:00.000Z",
      updatedBy: "alice",
      updatedOn: instanceId,
      readers: ["*"],
      writers: ["*"],
      content: {},
      fieldTypes: {},
    });
    const context = { databaseId: newId(), unicodeVersion: "17.0" };
    const other = newId();
    const clock = { [`${instanceId}/12`]: 2, [other]: 1, [`${other}/3`]: 1 };
    expect(validateEnvelope(envelope(clock), context).vectorClock).toEqual(clock);
    expect(() => validateEnvelope(envelope({ [other]: 1, [`${other}/3`]: 1 }), context)).toThrow(/no entry for updatedOn/);
  });
});

describe("parsePeerPosition", () => {
  it("reads 0 when missing and refuses malformed values", () => {
    expect(parsePeerPosition(undefined, "x")).toBe(0);
    expect(parsePeerPosition('{"lastSeq":7,"lastSyncedAt":"2026-10-18T12:00:00.000Z"}', "x")).toBe(7);
    for (const stored of ["", "7", "{}", '{"lastSeq":-1}', '{"lastSeq":"7"}', "null"]) {
      expect(() => parsePeerPosition(stored, "x")).toThrow(expect.objectContaining({ code: "INVALID_DATABASE" }) as Error);
    }
  });
});
