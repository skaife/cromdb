import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import type { DocumentSet } from "../src/document-set.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { matchesWhere, parseFindFilter, type FindFilter } from "../src/find-filter.js";
import type { JsonPrimitive } from "../src/json.js";
import { Session } from "../src/session.js";
import { TestAdapter } from "./helpers.js";

let adapter: TestAdapter;
let time: number;
const now = (): Date => new Date(time);

const alice = Session.named("alice");
const bob = Session.named("bob");
const anonymous = Session.anonymous();

function open(session: Session): Promise<Database> {
  return session.openDatabase(adapter, { now });
}

async function docs<T extends Record<string, unknown>>(set: DocumentSet<T>): Promise<Document<T>[]> {
  const result: Document<T>[] = [];
  for await (const doc of set) {
    result.push(doc);
  }
  return result;
}

async function ids<T extends Record<string, unknown>>(set: DocumentSet<T>): Promise<string[]> {
  return (await docs(set)).map((doc) => doc.id);
}

/** Iterates the set and checks count agrees with what iteration yields. */
async function found<T extends Record<string, unknown>>(set: DocumentSet<T>): Promise<string[]> {
  const result = await ids(set);
  expect(set.count).toBe(result.length);
  return result;
}

function byCreation(...docs: Document<Record<string, unknown>>[]): string[] {
  return docs.map((doc) => doc.id);
}

let db: Database;

beforeEach(async () => {
  adapter = new TestAdapter();
  time = Date.parse("2026-10-18T12:00:00.000Z");
  db = await open(alice);
});

afterEach(() => {
  adapter.close();
});

// Each create gets a later createdAt, so creation order is find order.
async function create(
  content: Record<string, unknown>,
  options: { readers?: string[]; writers?: string[]; parentId?: string } = {},
): Promise<Document<Record<string, unknown>>> {
  time += 60_000;
  return db.create(content, options);
}

describe("find with no filter", () => {
  it("returns every readable live document and no system documents", async () => {
    expect(await found(await db.find())).toEqual([]);

    const a = await create({ n: 1 });
    const b = await create({ n: 2 }, { parentId: a.id });
    const gone = await create({ n: 3 });
    await gone.delete();
    const c = await create({ n: 4 });

    expect(await found(await db.find())).toEqual(byCreation(a, b, c));
    expect(await found(await db.find({}))).toEqual(byCreation(a, b, c));
  });

  it("yields documents loaded as get() loads them", async () => {
    const a = await create({ title: "Hello", due: new Date("2026-11-01T00:00:00.000Z") }, { writers: ["alice"] });
    const [doc] = await docs(await db.find<{ title: string; due: Date }>());
    expect(doc?.content).toEqual({ title: "Hello", due: new Date("2026-11-01T00:00:00.000Z") });
    expect(doc?.vectorClock).toEqual(a.vectorClock);
    expect(doc?.writers).toEqual(["alice"]);
    expect(doc?.createdAt).toEqual(a.createdAt);
  });
});

describe("readers", () => {
  it("hides documents the session can't read, in count and iteration", async () => {
    const everyone = await create({ n: 1 });
    await create({ n: 2 }, { readers: ["alice"] });
    const withBob = await create({ n: 3 }, { readers: ["alice", "Bob"] });
    const withAnonymous = await create({ n: 4 }, { readers: ["*", "anonymous"] });

    expect((await db.find()).count).toBe(4);
    expect(await found(await (await open(bob)).find())).toEqual(byCreation(everyone, withBob, withAnonymous));
    expect(await found(await (await open(anonymous)).find())).toEqual(byCreation(withAnonymous));
  });
});

describe("parentId and getChildren", () => {
  it("gives direct children only, not the parent or grandchildren", async () => {
    const parent = await create({ n: 1 });
    const first = await create({ n: 2 }, { parentId: parent.id });
    const second = await create({ n: 3 }, { parentId: parent.id });
    await create({ n: 4 }, { parentId: first.id });
    await create({ n: 5 });

    expect(await found(await db.find({ parentId: parent.id }))).toEqual(byCreation(first, second));
    expect(await found(await parent.getChildren())).toEqual(byCreation(first, second));
    expect(await found(await db.find({ parentId: "missing" }))).toEqual([]);
  });

  it("applies readers to children", async () => {
    const parent = await create({ n: 1 });
    await create({ n: 2 }, { parentId: parent.id, readers: ["alice"] });
    const shared = await create({ n: 3 }, { parentId: parent.id });

    const bobParent = await (await open(bob)).get(parent.id);
    expect(await found(await (bobParent as Document<Record<string, unknown>>).getChildren())).toEqual(byCreation(shared));
  });

  it("works on a deleted Document object", async () => {
    const parent = await create({ n: 1 });
    const child = await create({ n: 2 }, { parentId: parent.id });
    await parent.delete();
    expect(await found(await parent.getChildren())).toEqual(byCreation(child));
  });
});

describe("topLevel", () => {
  it("splits top-level documents from the rest", async () => {
    const parent = await create({ n: 1 });
    const child = await create({ n: 2 }, { parentId: parent.id });
    const other = await create({ n: 3 });
    const grandchild = await create({ n: 4 }, { parentId: child.id });

    expect(await found(await db.find({ topLevel: true }))).toEqual(byCreation(parent, other));
    expect(await found(await db.find({ topLevel: false }))).toEqual(byCreation(child, grandchild));
    expect(await found(await db.find({ parentId: parent.id, topLevel: true }))).toEqual([]);
    expect(await found(await db.find({ parentId: parent.id, topLevel: false }))).toEqual(byCreation(child));
  });
});

describe("orphaned", () => {
  it("counts a child of a deleted or missing parent as orphaned", async () => {
    const parent = await create({ n: 1 });
    const child = await create({ n: 2 }, { parentId: parent.id });
    const top = await create({ n: 3 });
    const kept = await create({ n: 4 }, { parentId: top.id });
    const lost = await create({ n: 5 });
    // A missing parent can only come from storage, for example through replication.
    adapter.putDocument({ ...(adapter.getDocument(lost.id) as DocumentEnvelope), parentId: "missing" });

    expect(await found(await db.find({ orphaned: true }))).toEqual(byCreation(lost));
    await parent.delete();
    expect(await found(await db.find({ orphaned: true }))).toEqual(byCreation(child, lost));
    expect(await found(await db.find({ orphaned: false }))).toEqual(byCreation(top, kept));
    expect(await found(await db.find({ orphaned: true, topLevel: true }))).toEqual([]);
  });

  it("doesn't count a parent the session can't read as missing", async () => {
    const parent = await create({ n: 1 }, { readers: ["alice"] });
    const child = await create({ n: 2 }, { parentId: parent.id });
    const bobDb = await open(bob);

    expect(await bobDb.get(parent.id)).toBeUndefined();
    expect(await found(await bobDb.find({ orphaned: true }))).toEqual([]);
    expect(await found(await bobDb.find({ orphaned: false }))).toEqual(byCreation(child));
  });
});

describe("where", () => {
  const due = new Date("2026-11-01T00:00:00.000Z");

  it("matches strings, numbers and booleans by type", async () => {
    const a = await create({ s: "1", n: 1, b: true });
    const b = await create({ s: 1, n: "1", b: 1 });

    expect(await found(await db.find({ where: { s: "1" } }))).toEqual(byCreation(a));
    expect(await found(await db.find({ where: { s: 1 } }))).toEqual(byCreation(b));
    expect(await found(await db.find({ where: { n: 1 } }))).toEqual(byCreation(a));
    expect(await found(await db.find({ where: { b: true } }))).toEqual(byCreation(a));
    expect(await found(await db.find({ where: { b: false } }))).toEqual([]);
  });

  it("matches null only on a field that is present", async () => {
    const present = await create({ x: null });
    await create({ y: 1 });
    expect(await found(await db.find({ where: { x: null } }))).toEqual(byCreation(present));
  });

  it("matches a Date only on a datetime field, and a string only on a plain one", async () => {
    const date = await create({ due });
    const text = await create({ due: due.toISOString() });

    expect(await found(await db.find({ where: { due: new Date(due.getTime()) } }))).toEqual(byCreation(date));
    expect(await found(await db.find({ where: { due: due.toISOString() } }))).toEqual(byCreation(text));
    expect(await found(await db.find({ where: { due: new Date("2026-11-02T00:00:00.000Z") } }))).toEqual([]);
  });

  it("checks fieldTypes with the key escaped as a JSON Pointer", async () => {
    const date = await create({ "a/b~c": due });
    await create({ "a/b~c": due.toISOString() });
    expect(await found(await db.find({ where: { "a/b~c": due } }))).toEqual(byCreation(date));
  });

  it("ANDs keys, and with the other conditions", async () => {
    const parent = await create({ kind: "order", open: true });
    const both = await create({ kind: "order", open: true }, { parentId: parent.id });
    await create({ kind: "order", open: false }, { parentId: parent.id });
    await create({ kind: "note", open: true }, { parentId: parent.id });

    expect(await found(await db.find({ where: { kind: "order", open: true } }))).toEqual(byCreation(parent, both));
    expect(await found(await db.find({ parentId: parent.id, where: { kind: "order", open: true } }))).toEqual(byCreation(both));
  });

  it("treats keys like __proto__ as ordinary field names", async () => {
    const proto = await create(JSON.parse('{"__proto__": "x"}') as Record<string, unknown>);
    await create({ constructor: "y" });

    const where = JSON.parse('{"__proto__": "x"}') as Record<string, JsonPrimitive>;
    expect(await found(await db.find({ where }))).toEqual(byCreation(proto));
    expect(await found(await db.find({ where: { constructor: "x" } }))).toEqual([]);
    expect(await found(await db.find({ where: { toString: "x" } }))).toEqual([]);
  });

  it("never matches nested objects or arrays", async () => {
    await create({ x: { a: 1 }, y: [1] });
    expect(await found(await db.find({ where: { x: 1 } }))).toEqual([]);
    expect(await found(await db.find({ where: { y: 1 } }))).toEqual([]);
  });

  it.each([
    ["an object", { a: 1 }],
    ["an array", [1]],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses %s with TypeError", async (_name, value) => {
    const filter = { where: { x: value } } as unknown as FindFilter;
    await expect(db.find(filter)).rejects.toThrow(TypeError);
  });

  it("refuses an invalid Date with RangeError", async () => {
    await expect(db.find({ where: { x: new Date(Number.NaN) } })).rejects.toThrow(RangeError);
  });

  it("is a type-exact equality on top-level primitives (property)", () => {
    const primitive = fc.oneof(fc.string(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.boolean(), fc.constant(null));
    fc.assert(
      fc.property(primitive, primitive, fc.boolean(), (stored, wanted, datetime) => {
        const envelope = {
          content: { field: stored },
          fieldTypes: datetime ? { "/field": "datetime" } : {},
        } as unknown as DocumentEnvelope;
        const { where } = parseFindFilter({ where: { field: wanted } });
        expect(matchesWhere(envelope, where)).toBe(!datetime && stored === wanted);
      }),
    );
  });
});

describe("filter checks", () => {
  it.each([
    ["an unknown key", { parentID: "x" }],
    ["a misspelled key", { toplevel: true }],
    ["a non-string parentId", { parentId: 1 }],
    ["a non-boolean topLevel", { topLevel: "yes" }],
    ["a non-boolean orphaned", { orphaned: 1 }],
    ["a where that isn't a plain object", { where: [] }],
    ["a filter that isn't a plain object", []],
    ["a null filter", null],
    ["a Map", new Map()],
  ])("refuses %s with TypeError", async (_name, filter) => {
    await expect(db.find(filter as unknown as FindFilter)).rejects.toThrow(TypeError);
  });

  it("treats a key set to undefined as absent", async () => {
    const a = await create({ n: 1 });
    expect(await found(await db.find({ parentId: undefined, where: undefined }))).toEqual(byCreation(a));
  });
});

describe("order", () => {
  it("is createdAt, then id", async () => {
    time = Date.parse("2026-10-18T13:00:00.000Z");
    const late = await db.create({ n: 1 });
    time = Date.parse("2026-10-18T12:30:00.000Z");
    const first = await db.create({ n: 2 });
    const sameTime = [first, await db.create({ n: 3 }), await db.create({ n: 4 })];
    // A save doesn't move a document in the order.
    time = Date.parse("2026-10-18T14:00:00.000Z");
    first.content["n"] = 5;
    await first.save();

    const tied = sameTime.map((doc) => doc.id).sort();
    expect(await found(await db.find())).toEqual([...tied, late.id]);
  });
});

describe("fixed membership", () => {
  it("skips a document deleted since load, without changing count", async () => {
    const a = await create({ n: 1 });
    const b = await create({ n: 2 });
    const set = await db.find();
    await a.delete();
    expect(set.count).toBe(2);
    expect(await ids(set)).toEqual(byCreation(b));
  });

  it("skips a document made unreadable since load", async () => {
    const a = await create({ n: 1 });
    const b = await create({ n: 2 });
    const set = await (await open(bob)).find();
    a.readers = ["alice"];
    await a.save();
    expect(set.count).toBe(2);
    expect(await ids(set)).toEqual(byCreation(b));
  });

  it("still yields a document that no longer matches where, with fresh content", async () => {
    const a = await create({ status: "open" });
    const set = await db.find<{ status: string }>({ where: { status: "open" } });
    a.content["status"] = "closed";
    await a.save();

    const yielded = await docs(set);
    expect(yielded.map((doc) => doc.content)).toEqual([{ status: "closed" }]);
    expect(await found(await db.find({ where: { status: "open" } }))).toEqual([]);
  });

  it("doesn't pick up documents created since load", async () => {
    await create({ n: 1 });
    const set = await db.find();
    await create({ n: 2 });
    expect(set.count).toBe(1);
    expect(await ids(set)).toHaveLength(1);
  });

  it("starts over from the first document on each iteration", async () => {
    const a = await create({ n: 1 });
    const b = await create({ n: 2 });
    const set = await db.find();
    expect(await ids(set)).toEqual(byCreation(a, b));
    expect(await ids(set)).toEqual(byCreation(a, b));

    const seen: string[] = [];
    for await (const doc of set) {
      seen.push(doc.id);
      break;
    }
    expect(await ids(set)).toEqual(byCreation(a, b));
    expect(seen).toEqual(byCreation(a));
  });

  it("loads each document when it is reached", async () => {
    const a = await create({ n: 1 });
    const b = await create({ n: 2 });
    const set = await db.find();
    const iterator = set[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.id).toBe(a.id);
    await b.delete();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});
