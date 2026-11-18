import fc from "fast-check";
import type { JsonObject } from "../json.js";
import type { DocumentData, FieldTypes } from "../operations.js";
import { assert, assertEqual, type ContractContext } from "./context.js";
import type { ContractCheck } from "./index.js";

const ALICE = { id: "alice" };
const BOB = { id: "bob" };

function escape(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Content as given, own keys only (JSON.parse makes "__proto__" an own key). */
function json(text: string): JsonObject {
  return JSON.parse(text) as JsonObject;
}

async function open(ctx: ContractContext) {
  const { handle } = await ctx.create(ALICE);
  const as = (principal: { id: string }) => ({ handle, principal });
  return { handle, alice: as(ALICE), bob: as(BOB) };
}

async function letBobCreate(ctx: ContractContext, alice: { handle: string; principal: { id: string } }): Promise<void> {
  // Through acl.save if the driver has it; otherwise checks that need Bob
  // to create aren't run.
  const { acl } = await ctx.call("acl.get", alice);
  await ctx.call("acl.save", { ...alice, ifVersion: acl.version, creators: [...acl.creators, BOB.id], admins: [...acl.admins] });
}

const key = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.constantFrom("__proto__", "constructor", "toString", "hasOwnProperty", "", "a/b", "~", "~1", "/", "0"),
);
const timestamp = fc
  .date({ min: new Date("0001-01-01T00:00:00.000Z"), max: new Date("9999-12-31T23:59:59.999Z"), noInvalidDate: true })
  .map((date) => date.toISOString());

/** Content with datetimes at tricky keys, in an object and an array, and the fieldTypes for them. */
const datedContent = fc
  .record({
    plain: fc.dictionary(key, fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 }),
    when: fc.dictionary(key, timestamp, { maxKeys: 4 }),
    list: fc.array(timestamp, { maxLength: 3 }),
  })
  .map(({ plain, when, list }) => {
    // Through JSON, so -0 is 0 and every key is an own property.
    const content = JSON.parse(JSON.stringify({ ...plain })) as JsonObject;
    const whenCopy = JSON.parse(JSON.stringify(when)) as JsonObject;
    Object.defineProperty(content, "when", { value: whenCopy, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(content, "list", { value: list, enumerable: true, writable: true, configurable: true });
    const fieldTypes: Record<string, "datetime"> = {};
    for (const name of Object.keys(whenCopy)) {
      Object.defineProperty(fieldTypes, `/when/${escape(name)}`, { value: "datetime", enumerable: true, writable: true, configurable: true });
    }
    list.forEach((_, index) => {
      fieldTypes[`/list/${index}`] = "datetime";
    });
    return { content, fieldTypes: fieldTypes as FieldTypes };
  });

function stored(document: DocumentData) {
  return { content: document.content, fieldTypes: document.fieldTypes };
}

export const DOCUMENT_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: ["documents"],
    name: "documents are created, read, saved and deleted with versions",
    async run(ctx) {
      const { alice } = await open(ctx);
      const { document: created } = await ctx.call("documents.create", { ...alice, content: { title: "one" } });
      assertEqual(created.content, { title: "one" }, "created content");
      assertEqual(created.createdBy, ALICE.id, "createdBy");
      assertEqual(created.parentId, created.id, "a top-level document is its own parent");
      assertEqual(created.deleted, false, "deleted");
      assertEqual(created.access, { read: true, update: true, delete: true }, "the creator's access");

      const { document: read } = await ctx.call("documents.get", { ...alice, id: created.id });
      assertEqual(read, created, "the document read back");
      assertEqual((await ctx.call("documents.get", { ...alice, id: created.id, ifVersion: created.version })).document, created, "get at its version");

      const saved = await ctx.call("documents.save", { ...alice, id: created.id, ifVersion: created.version, content: { title: "two" } });
      assertEqual(saved.editedThroughConflict, false, "editedThroughConflict");
      assertEqual(saved.document.content, { title: "two" }, "saved content");
      assert(saved.document.version !== created.version, "a save gives a new version");
      assertEqual((await ctx.call("documents.get", { ...alice, id: created.id })).document, saved.document, "the saved document read back");

      await ctx.fails("STALE_DOCUMENT", "documents.get", { ...alice, id: created.id, ifVersion: created.version });
      await ctx.fails("STALE_DOCUMENT", "documents.save", { ...alice, id: created.id, ifVersion: created.version, content: {} });
      await ctx.fails("STALE_DOCUMENT", "documents.delete", { ...alice, id: created.id, ifVersion: created.version });

      const deleted = await ctx.call("documents.delete", { ...alice, id: created.id, ifVersion: saved.document.version });
      assertEqual(deleted, { editedThroughConflict: false }, "documents.delete");
      assertEqual((await ctx.call("documents.get", { ...alice, id: created.id })).document, null, "a deleted document");
      await ctx.fails("NOT_FOUND", "documents.save", { ...alice, id: created.id, ifVersion: saved.document.version, content: {} });
      assertEqual((await ctx.call("documents.get", { ...alice, id: "no-such-document" })).document, null, "a missing document");
    },
  },
  {
    capabilities: ["documents"],
    name: "saving keeps readers and writers unless given",
    async run(ctx) {
      const { alice } = await open(ctx);
      const { document } = await ctx.call("documents.create", { ...alice, content: {}, readers: ["alice", "bob"], writers: ["alice"] });
      const kept = await ctx.call("documents.save", { ...alice, id: document.id, ifVersion: document.version, content: { a: 1 } });
      assertEqual([kept.document.readers, kept.document.writers], [["alice", "bob"], ["alice"]], "lists kept");
      const changed = await ctx.call("documents.save", {
        ...alice,
        id: document.id,
        ifVersion: kept.document.version,
        content: { a: 2 },
        readers: ["*"],
      });
      assertEqual([changed.document.readers, changed.document.writers], [["*"], ["alice"]], "readers changed, writers kept");
    },
  },
  {
    capabilities: ["documents"],
    name: "datetimes and any content keys round-trip",
    async run(ctx) {
      const { alice } = await open(ctx);
      await fc.assert(
        fc.asyncProperty(datedContent, async ({ content, fieldTypes }) => {
          const { document } = await ctx.call("documents.create", { ...alice, content, fieldTypes });
          assertEqual(stored(document), { content, fieldTypes }, "created");
          const { document: read } = await ctx.call("documents.get", { ...alice, id: document.id });
          assertEqual(read === null ? null : stored(read), { content, fieldTypes }, "read back");
        }),
        { numRuns: ctx.numRuns },
      );
      const content = json('{"__proto__":{"a/b":"2026-01-02T03:04:05.000Z"},"constructor":1,"~x":["2026-01-02T03:04:05.006Z"]}');
      const fieldTypes = json('{"/__proto__/a~1b":"datetime","/~0x/0":"datetime"}') as FieldTypes;
      const { document } = await ctx.call("documents.create", { ...alice, content, fieldTypes });
      assertEqual(stored(document), { content, fieldTypes }, "escaped pointers and special keys");
      assert(Object.hasOwn(document.content, "__proto__"), "__proto__ is kept as an own key");
    },
  },
  {
    capabilities: ["documents"],
    name: "fieldTypes that don't fit the content are INVALID_INPUT",
    async run(ctx) {
      const { alice } = await open(ctx);
      const content = { due: "2026-01-02T03:04:05.000Z", n: 1, list: ["2026-01-02T03:04:05.000Z"], loose: "2026-01-02" };
      for (const fieldTypes of [{ "/missing": "datetime" }, { "/n": "datetime" }, { "/loose": "datetime" }, { "": "datetime" }, { "/list/00": "datetime" }]) {
        await ctx.fails("INVALID_INPUT", "documents.create", { ...alice, content, fieldTypes });
      }
      await ctx.fails("INVALID_INPUT", "documents.create", { ...alice, content, fieldTypes: { "/due": "date" } });
      const { document } = await ctx.call("documents.create", { ...alice, content: {} });
      await ctx.fails("INVALID_INPUT", "documents.save", { ...alice, id: document.id, ifVersion: document.version, content, fieldTypes: { "/n": "datetime" } });
      assertEqual((await ctx.call("documents.get", { ...alice, id: document.id })).document?.version, document.version, "a refused save writes nothing");
    },
  },
  {
    capabilities: ["documents"],
    name: "document inputs are checked strictly",
    async run(ctx) {
      const { alice, handle } = await open(ctx);
      const { document } = await ctx.call("documents.create", { ...alice, content: {} });
      const target = { ...alice, id: document.id };
      const bad: [string, string, unknown][] = [
        ["an unknown key", "documents.get", { ...target, extra: true }],
        ["no principal", "documents.get", { handle, id: document.id }],
        ["an unknown key in principal", "documents.get", { ...target, principal: { id: "alice", role: "admin" } }],
        ["a handle that isn't a string", "documents.get", { ...target, handle: 1 }],
        ["content that isn't an object", "documents.create", { ...alice, content: [] }],
        ["a Date in content", "documents.create", { ...alice, content: { due: new Date() } }],
        ["undefined in content", "documents.create", { ...alice, content: { a: undefined } }],
        ["Infinity in content", "documents.create", { ...alice, content: { a: Number.POSITIVE_INFINITY } }],
        ["readers that aren't strings", "documents.create", { ...alice, content: {}, readers: [1] }],
        ["save without ifVersion", "documents.save", { ...target, content: {} }],
        ["delete without ifVersion", "documents.delete", target],
        ["an unknown filter key", "documents.find", { ...alice, limit: 10, filter: { kind: "x" } }],
        ["find without limit", "documents.find", alice],
        ["limit 0", "documents.find", { ...alice, limit: 0 }],
        ["limit 1001", "documents.find", { ...alice, limit: 1001 }],
        ["limit 1.5", "documents.find", { ...alice, limit: 1.5 }],
        ["a where value that is an object", "documents.find", { ...alice, limit: 10, filter: { where: { a: {} } } }],
        ["a cursor that isn't one", "documents.find", { ...alice, limit: 10, after: "nonsense" }],
      ];
      for (const [what, op, input] of bad) {
        try {
          await ctx.fails("INVALID_INPUT", op, input);
        } catch (error) {
          throw new Error(`with ${what}: ${(error as Error).message}`);
        }
      }
      assertEqual((await ctx.call("documents.get", target)).document?.version, document.version, "nothing was written");
    },
  },
  {
    capabilities: ["documents"],
    name: "a principal ID the engine refuses is INVALID_PRINCIPAL",
    async run(ctx) {
      const { handle } = await open(ctx);
      for (const id of ["", "has space", "system", "anonymous", "*"]) {
        await ctx.fails("INVALID_PRINCIPAL", "documents.get", { handle, principal: { id }, id: "x" });
      }
    },
  },
  {
    capabilities: ["documents", "acl"],
    name: "creators, readers and writers are enforced",
    async run(ctx) {
      const { alice, bob } = await open(ctx);
      assertEqual(await ctx.call("access.mine", alice), { create: true, admin: true }, "the creator's database access");
      assertEqual(await ctx.call("access.mine", bob), { create: false, admin: false }, "another's database access");
      await ctx.fails("ACCESS_DENIED", "documents.create", { ...bob, content: {} });
      await letBobCreate(ctx, alice);
      assertEqual(await ctx.call("access.mine", bob), { create: true, admin: false }, "a creator's database access");

      const { document: secret } = await ctx.call("documents.create", { ...alice, content: { s: 1 }, readers: ["alice"] });
      assertEqual((await ctx.call("documents.get", { ...bob, id: secret.id })).document, null, "a document Bob can't read");
      await ctx.fails("NOT_FOUND", "documents.save", { ...bob, id: secret.id, ifVersion: secret.version, content: {} });
      const { documents } = await ctx.call("documents.find", { ...bob, limit: 100 });
      assert(!documents.some((doc) => doc.id === secret.id), "find shows Bob a document he can't read");

      const { document: shared } = await ctx.call("documents.create", { ...alice, content: {}, writers: ["alice"] });
      const { document: asBob } = await ctx.call("documents.get", { ...bob, id: shared.id });
      assertEqual(asBob?.access, { read: true, update: false, delete: false }, "Bob's access to a document he can only read");
      await ctx.fails("ACCESS_DENIED", "documents.save", { ...bob, id: shared.id, ifVersion: shared.version, content: { b: 1 } });
      await ctx.fails("ACCESS_DENIED", "documents.delete", { ...bob, id: shared.id, ifVersion: shared.version });

      const { document: own } = await ctx.call("documents.create", { ...bob, content: {}, readers: ["alice"], writers: ["alice"] });
      assertEqual([own.readers, own.writers, own.access.read], [["alice"], ["alice", "bob"], false], "a creator is added to writers, not readers");
    },
  },
  {
    capabilities: ["documents"],
    name: "find filters by parent, top level, orphans and where",
    async run(ctx) {
      const { alice } = await open(ctx);
      const create = async (content: JsonObject, parentId?: string, fieldTypes?: FieldTypes) =>
        (await ctx.call("documents.create", { ...alice, content, ...(parentId === undefined ? {} : { parentId }), ...(fieldTypes === undefined ? {} : { fieldTypes }) })).document;
      const parent = await create({ kind: "parent" });
      const first = await create({ kind: "child", n: 1 }, parent.id);
      const second = await create({ kind: "child", n: 2, due: "2026-05-06T07:08:09.010Z" }, parent.id, { "/due": "datetime" });
      const other = await create({ kind: "other", due: "2026-05-06T07:08:09.010Z" });
      const ids = async (filter: object) => (await ctx.call("documents.find", { ...alice, limit: 100, filter })).documents.map((doc) => doc.id).sort();

      assertEqual(await ids({ parentId: parent.id }), [first.id, second.id].sort(), "children");
      assertEqual(await ids({ topLevel: true }), [parent.id, other.id].sort(), "top level");
      assertEqual(await ids({ where: { kind: "child", n: 2 } }), [second.id], "where");
      assertEqual(await ids({ where: { due: "2026-05-06T07:08:09.010Z" }, whereTypes: { due: "datetime" } }), [second.id], "where a datetime");
      assertEqual(await ids({ where: { due: "2026-05-06T07:08:09.010Z" } }), [other.id], "where a string, not a datetime");
      await ctx.fails("INVALID_INPUT", "documents.find", { ...alice, limit: 10, filter: { whereTypes: { due: "datetime" } } });
      await ctx.fails("INVALID_INPUT", "documents.find", { ...alice, limit: 10, filter: { where: { due: "May" }, whereTypes: { due: "datetime" } } });
      await ctx.fails("NOT_FOUND", "documents.create", { ...alice, content: {}, parentId: "no-such-document" });

      assertEqual(await ids({ orphaned: true }), [], "no orphans yet");
      await ctx.call("documents.delete", { ...alice, id: parent.id, ifVersion: parent.version });
      assertEqual(await ids({ orphaned: true }), [first.id, second.id].sort(), "orphans");
    },
  },
  {
    capabilities: ["documents"],
    name: "find pages through every document once",
    async run(ctx) {
      const { alice } = await open(ctx);
      const created: string[] = [];
      let tag = 0;
      const page = async (filter: object, limit: number) => {
        const seen: string[] = [];
        let after: string | undefined;
        for (let pages = 0; ; pages++) {
          assert(pages <= 1000, "find never reached the end");
          const result = await ctx.call("documents.find", { ...alice, limit, filter, ...(after === undefined ? {} : { after }) });
          assert(result.documents.length <= limit, "a page holds more than limit documents");
          seen.push(...result.documents.map((doc) => doc.id));
          if (result.next === null) {
            return seen;
          }
          after = result.next;
        }
      };
      for (let i = 0; i < 7; i++) {
        created.push((await ctx.call("documents.create", { ...alice, content: { tag: "fixed", i } })).document.id);
      }
      assertEqual((await page({ where: { tag: "fixed" } }, 3)).sort(), [...created].sort(), "pages of 3 over 7 documents");
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 5 }), async (matching, others, limit) => {
          tag++;
          const mine: string[] = [];
          for (let i = 0; i < matching + others; i++) {
            const { document } = await ctx.call("documents.create", { ...alice, content: { tag: i < matching ? tag : -tag } });
            if (i < matching) mine.push(document.id);
          }
          const seen = await page({ where: { tag } }, limit);
          assertEqual(new Set(seen).size, seen.length, "a document seen twice");
          assertEqual([...seen].sort(), [...mine].sort(), "the documents found");
        }),
        { numRuns: ctx.numRuns },
      );
      const first = await ctx.call("documents.find", { ...alice, limit: 1, filter: { where: { tag: "fixed" } } });
      assert(first.next !== null, "a first page of one has a next");
      await ctx.fails("INVALID_INPUT", "documents.find", { ...alice, limit: 1, filter: { topLevel: true }, after: first.next });
    },
  },
];
