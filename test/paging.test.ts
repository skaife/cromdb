import fc from "fast-check";
import Sqlite from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { DocumentSet } from "../src/document-set.js";
import type { FindFilter, FindOptions } from "../src/find-filter.js";
import { sync } from "../src/replication.js";
import { Session } from "../src/session.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";
import { TestAdapter } from "./helpers.js";

const alice = Session.named("alice");
const bob = Session.named("bob");

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

function newAdapter(fallback = false): TestAdapter {
  const adapter = new TestAdapter();
  if (fallback) {
    adapter.documentsAfter = undefined;
  }
  adapters.push(adapter);
  return adapter;
}

async function ids(set: DocumentSet<Record<string, unknown>>): Promise<string[]> {
  const result: string[] = [];
  for await (const doc of set) {
    result.push(doc.id);
  }
  expect(set.count).toBe(result.length);
  return result;
}

/** Every page of the filter, until next is undefined. */
async function pages(db: Database, filter: FindFilter | undefined, limit: number): Promise<string[][]> {
  const result: string[][] = [];
  let after: string | undefined;
  for (;;) {
    const page = await db.find(filter, after === undefined ? { limit } : { limit, after });
    const pageIds = await ids(page);
    expect(pageIds.length).toBeLessThanOrEqual(limit);
    result.push(pageIds);
    if (page.next === undefined) {
      return result;
    }
    after = page.next;
    expect(result.length).toBeLessThan(10_000);
  }
}

async function createMany(db: Database, count: number, content: (index: number) => Record<string, unknown> = (n) => ({ n })): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index++) {
    time += 1000;
    created.push((await db.create(content(index))).id);
  }
  return created;
}

describe.each([
  ["with the adapter's documentsAfter", false],
  ["with the fallback", true],
])("find pages %s", (_name, fallback) => {
  let db: Database;

  beforeEach(async () => {
    db = await alice.openDatabase(newAdapter(fallback), { now });
  });

  it("splits the documents into pages in find order", async () => {
    const created = await createMany(db, 25);
    const result = await pages(db, undefined, 10);
    expect(result.map((page) => page.length)).toEqual([10, 10, 5]);
    expect(result.flat()).toEqual(created);
  });

  it("can end with an empty page when the last full page reaches the end", async () => {
    const created = await createMany(db, 20);
    const result = await pages(db, undefined, 10);
    expect(result.map((page) => page.length)).toEqual([10, 10, 0]);
    expect(result.flat()).toEqual(created);
  });

  it("gives one empty page with no next for an empty database", async () => {
    const page = await db.find({}, { limit: 5 });
    expect(page.count).toBe(0);
    expect(page.next).toBeUndefined();
  });

  it("returns every match, with no next, without limit", async () => {
    await createMany(db, 3);
    for (const options of [undefined, {}, { limit: undefined }] as (FindOptions | undefined)[]) {
      const set = await db.find(undefined, options);
      expect(set.count).toBe(3);
      expect(set.next).toBeUndefined();
    }
  });

  it("stops after reading 10 times limit candidates, with a next", async () => {
    await createMany(db, 30, () => ({ kind: "noise" }));
    const wanted = await createMany(db, 2, () => ({ kind: "wanted" }));
    const filter = { where: { kind: "wanted" } };
    const first = await db.find(filter, { limit: 2 });
    expect(first.count).toBe(0);
    expect(first.next).toBeDefined();
    expect((await pages(db, filter, 2)).flat()).toEqual(wanted);
  });

  it("applies every filter condition and readers, as find does", async () => {
    const root = (await db.create({ n: 0 })).id;
    time += 1000;
    for (let index = 0; index < 12; index++) {
      time += index % 3 === 0 ? 0 : 1000; // some share a createdAt
      await db.create({ n: index % 2 }, { parentId: root, readers: index % 4 === 0 ? ["bob"] : ["*"] });
    }
    const filters: FindFilter[] = [{}, { parentId: root }, { topLevel: false }, { where: { n: 1 } }, { parentId: root, where: { n: 0 } }];
    for (const filter of filters) {
      expect((await pages(db, filter, 3)).flat()).toEqual(await ids(await db.find(filter)));
    }
  });

  it("pages through documents in conflict, deleted ones included", async () => {
    const replica = newAdapter(fallback);
    await db.createReplica(replica);
    const other = await alice.openDatabase(replica, { now });
    const shared = await createMany(db, 6);
    await sync(db, other);
    for (const id of shared) {
      const here = await db.get(id);
      const there = await other.get(id);
      await here?.save();
      await (shared.indexOf(id) % 2 === 0 ? there?.delete() : there?.save());
    }
    await sync(db, other);
    const all = await ids(await db.find({ inConflict: true }));
    expect(all.length).toBe(6);
    expect((await pages(db, { inConflict: true }, 4)).flat()).toEqual(all);
  });

  it("matches find for random documents, filters and limits (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ n: fc.integer({ min: 0, max: 2 }), sameTime: fc.boolean(), hidden: fc.boolean(), deleted: fc.boolean() }), { maxLength: 30 }),
        fc.constantFrom<FindFilter>({}, { where: { n: 0 } }, { where: { n: 2 } }, { topLevel: true }),
        fc.integer({ min: 1, max: 7 }),
        async (specs, filter, limit) => {
          const local = await alice.openDatabase(newAdapter(fallback), { now });
          for (const spec of specs) {
            time += spec.sameTime ? 0 : 1000;
            const doc = await local.create({ n: spec.n }, { readers: spec.hidden ? ["bob"] : ["*"] });
            if (spec.deleted && !spec.hidden) {
              await doc.delete();
            }
          }
          expect((await pages(local, filter, limit)).flat()).toEqual(await ids(await local.find(filter)));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("find pages over time", () => {
  let db: Database;

  beforeEach(async () => {
    db = await alice.openDatabase(newAdapter(), { now });
  });

  it("shows a document created during the pass on a later page, and never one twice", async () => {
    const created = await createMany(db, 4);
    const first = await db.find({}, { limit: 2 });
    const added = await createMany(db, 1);
    const second = await db.find({}, { limit: 2, after: first.next as string });
    const third = await db.find({}, { limit: 2, after: second.next as string });
    expect(third.next).toBeUndefined();
    expect([...(await ids(first)), ...(await ids(second)), ...(await ids(third))]).toEqual([...created, ...added]);
  });

  it("leaves out a document deleted before its page is read", async () => {
    const created = await createMany(db, 6);
    const first = await db.find({}, { limit: 3 });
    await (await db.get(created[4] as string))?.delete();
    const second = await db.find({}, { limit: 3, after: first.next as string });
    expect(await ids(second)).toEqual([created[3], created[5]]);
  });

  it("misses a document that arrives by sync with a createdAt the pass is already past", async () => {
    const replica = newAdapter();
    await db.createReplica(replica);
    const other = await alice.openDatabase(replica, { now });
    const early = (await other.create({ from: "other" })).id; // same createdAt as nothing here yet
    const created = await createMany(db, 4);
    const first = await db.find({}, { limit: 2 });
    await sync(db, other);
    const second = await db.find({}, { limit: 2, after: first.next as string });
    // early sorts before everything here, so this pass has passed it.
    expect([...(await ids(first)), ...(await ids(second))]).toEqual(created);
    expect(await ids(await db.find())).toEqual([early, ...created]);
  });

  it("gives a cursor that works the same on another replica", async () => {
    const replica = newAdapter();
    await db.createReplica(replica);
    const other = await alice.openDatabase(replica, { now });
    const created = await createMany(db, 5);
    await sync(db, other);
    const first = await db.find({ where: {} }, { limit: 2 });
    const there = await other.find({}, { limit: 2, after: first.next as string });
    expect(await ids(there)).toEqual(created.slice(2, 4));
  });

  it("works across a restart, with the cursor alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cromdb-paging-"));
    try {
      const file = join(dir, "db.cromdb");
      let adapter = SqliteAdapter.open(file);
      const fileDb = await alice.openDatabase(adapter, { now });
      const created = await createMany(fileDb, 5);
      const next = (await fileDb.find({}, { limit: 3 })).next as string;
      adapter.close();
      adapter = SqliteAdapter.open(file);
      const reopened = await alice.openDatabase(adapter, { now });
      expect(await ids(await reopened.find({}, { limit: 3, after: next }))).toEqual(created.slice(3));
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives each session the documents it can read", async () => {
    const acl = await db.getAcl();
    acl.creators = ["*"];
    await acl.save();
    const bobDb = await bob.openDatabase(adapters[0] as TestAdapter, { now });
    const mine = await createMany(db, 3);
    time += 1000;
    await bobDb.create({ secret: true }, { readers: ["bob"] });
    expect((await pages(db, undefined, 2)).flat()).toEqual(mine);
    expect((await pages(bobDb, undefined, 2)).flat().length).toBe(4);
  });
});

describe("find options checks", () => {
  let db: Database;

  beforeEach(async () => {
    db = await alice.openDatabase(newAdapter(), { now });
    await createMany(db, 3);
  });

  it.each<[string, unknown]>([
    ["not an object", 5],
    ["an array", []],
    ["an unknown key", { limit: 1, skip: 2 }],
    ["limit 0", { limit: 0 }],
    ["limit 1001", { limit: 1001 }],
    ["a fractional limit", { limit: 1.5 }],
    ["a string limit", { limit: "5" }],
    ["limit null", { limit: null }],
    ["after without limit", { after: "x" }],
    ["after not a string", { limit: 1, after: 5 }],
    ["after not a cursor", { limit: 1, after: "not a cursor" }],
    ["after an empty string", { limit: 1, after: "" }],
  ])("refuses %s with TypeError", async (_name, options) => {
    await expect(db.find({}, options as FindOptions)).rejects.toThrow(TypeError);
  });

  it("accepts limit 1 and 1000", async () => {
    expect((await db.find({}, { limit: 1 })).count).toBe(1);
    expect((await db.find({}, { limit: 1000 })).count).toBe(3);
  });

  it("refuses a cursor from another filter, but not from the same filter written differently", async () => {
    const { next } = await db.find({ where: { a: 1, b: 2 } }, { limit: 1 });
    // Nothing matches, so there is no next; make one from a filter that has one.
    expect(next).toBeUndefined();
    const all = await db.find({ topLevel: true, where: {} }, { limit: 1 });
    const after = all.next as string;
    await expect(db.find({}, { limit: 1, after })).rejects.toThrow(/different filter/);
    await expect(db.find({ topLevel: false }, { limit: 1, after })).rejects.toThrow(/different filter/);
    expect((await db.find({ where: {}, topLevel: true }, { limit: 1, after })).count).toBe(1);
  });

  it("treats where keys in any order as the same filter", async () => {
    await db.create({ a: 1, b: 2 });
    await db.create({ a: 1, b: 2 });
    const first = await db.find({ where: { a: 1, b: 2 } }, { limit: 1 });
    const second = await db.find({ where: { b: 2, a: 1 } }, { limit: 1, after: first.next as string });
    expect(second.count).toBe(1);
  });

  it("tells a Date apart from its ISO string in the filter a cursor belongs to", async () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const page = await db.find({ where: { at: date } }, { limit: 1 });
    expect(page.next).toBeUndefined();
    const all = await db.find({}, { limit: 1 });
    await expect(db.find({ where: { at: date.toISOString() } }, { limit: 1, after: all.next as string })).rejects.toThrow(TypeError);
  });
});

describe("SqliteAdapter paging index", () => {
  it("adds the index to a file made without it, and uses it for an unnarrowed page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cromdb-index-"));
    try {
      const file = join(dir, "db.cromdb");
      const adapter = SqliteAdapter.open(file);
      await alice.openDatabase(adapter);
      adapter.close();
      const raw = new Sqlite(file);
      raw.exec("DROP INDEX documents_created");
      raw.close();

      const reopened = SqliteAdapter.open(file);
      reopened.close();
      const check = new Sqlite(file, { readonly: true });
      const names = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").pluck().all();
      expect(names).toContain("documents_created");
      expect(check.pragma("user_version", { simple: true })).toBe(1);
      const plan = check
        .prepare(
          `EXPLAIN QUERY PLAN SELECT body FROM documents WHERE kind = 'document' AND json_extract(body, '$.conflictOf') IS NULL AND deleted = 0
           AND (json_extract(body, '$.createdAt'), id) > (?, ?) ORDER BY json_extract(body, '$.createdAt'), id LIMIT 10`,
        )
        .all("2026-01-01T00:00:00.000Z", "x") as { detail: string }[];
      expect(plan.map((row) => row.detail).join("\n")).toContain("documents_created");
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
