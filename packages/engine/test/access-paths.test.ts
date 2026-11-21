// Every way into a level-3 database, against every kind of membership in its
// ACL. The table below lists each public method of Session, Database,
// Document, Conflict, Acl and DocumentSet; a reflection test fails if one is
// missing, so a new method can't skip the access check. Each case loads its
// objects while the principal has every access, then narrows the ACL to the
// table's and calls the method: access is checked when a method is called,
// not when its object was loaded. Property tests then compare random ACLs and
// document lists with a small reference model.

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { Acl } from "../src/acl-document.js";
import { Conflict } from "../src/conflict-object.js";
import { Database } from "../src/database.js";
import { Document } from "../src/document.js";
import { DocumentSet } from "../src/document-set.js";
import { CromDBError } from "../src/errors.js";
import { Session } from "../src/session.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { aclDocId } from "../src/system-docs.js";
import { TestAdapter } from "./helpers.js";

let adapters: TestAdapter[] = [];
let time = Date.parse("2026-11-20T12:00:00.000Z");
const now = (): Date => new Date(time);
const tick = (): void => {
  time += 1000;
};

function newAdapter(): TestAdapter {
  const adapter = new TestAdapter();
  adapters.push(adapter);
  return adapter;
}

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
  adapters = [];
});

const alice = Session.withId("alice");

interface Lists {
  admins: string[];
  creators: string[];
  writers: string[];
  readers: string[];
  noAccess: string[];
}

async function setAcl(db: Database, lists: Lists): Promise<void> {
  const acl = await db.getAcl();
  Object.assign(acl, lists);
  tick();
  await acl.save();
}

/** What a call did: succeeded, found nothing, or was refused with ACCESS_DENIED. */
type Outcome = "ok" | "none" | "denied";

async function outcomeOf(call: () => Promise<unknown>): Promise<Outcome | string> {
  try {
    const result = await call();
    if (result === undefined || (result instanceof DocumentSet && result.count === 0)) {
      return "none";
    }
    return typeof result === "string" ? result : "ok";
  } catch (error) {
    if (error instanceof CromDBError && error.code === "ACCESS_DENIED") {
      return "denied";
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The table.

// The rows: one principal for each kind of membership in TABLE_ACL.
const ROWS = ["all", "admin", "creator", "writer", "reader", "readerWriter", "stranger", "locked", "anonymous"] as const;
type Row = (typeof ROWS)[number];

const SESSIONS: Record<Row, Session> = {
  all: Session.withId("all"),
  admin: Session.withId("admin"),
  creator: Session.withId("creator"),
  writer: Session.withId("writer"),
  reader: Session.withId("reader"),
  readerWriter: Session.withId("readerWriter"),
  stranger: Session.withId("stranger"),
  locked: Session.withId("locked"),
  anonymous: Session.anonymous(),
};

const NAMED = ROWS.filter((row) => row !== "anonymous");

// Each named row in the lists its name says. "locked" is in every list and
// in noAccess. Nobody lists "anonymous", "*" or "stranger".
const TABLE_ACL: Lists = {
  admins: ["alice", "all", "admin", "locked"],
  creators: ["alice", "all", "creator", "locked"],
  writers: ["alice", "all", "writer", "readerWriter", "locked"],
  readers: ["alice", "all", "reader", "readerWriter", "locked"],
  noAccess: ["locked"],
};

// Before the table's ACL: everyone may do everything, so every row can load
// a Document, a Conflict, a DocumentSet and (named rows) an Acl.
const OPEN_ACL: Lists = {
  admins: ["alice", ...NAMED],
  creators: ["anonymous"],
  writers: ["anonymous"],
  readers: ["anonymous"],
  noAccess: [],
};

/** What a principal loaded while it had every access, and the world around it. */
interface World {
  a: Database;
  b: Database;
  db: Database;
  doc: Document<{ n: number }>;
  inConflict: Document<{ n: number }>;
  conflict: Conflict<{ n: number }>;
  acl: Acl | undefined;
  set: DocumentSet<Record<string, unknown>>;
  session: Session;
  adapter: TestAdapter;
}

/**
 * alice founds a database with replica b, a document with a child, and a
 * document in conflict, all readable and writable by "anonymous"; the
 * principal loads its objects; then alice narrows the ACL to lists.
 */
async function world(session: Session, lists: Lists): Promise<World> {
  const adapter = newAdapter();
  const a = await alice.openDatabase(adapter, { now });
  await setAcl(a, OPEN_ACL);
  const everyone = { readers: ["anonymous"], writers: ["anonymous"] };
  const doc = await a.create({ n: 1 }, everyone);
  await a.create({ n: 2 }, { ...everyone, parentId: doc.id });
  const inConflict = await a.create({ n: 3 }, everyone);
  const bAdapter = newAdapter();
  tick();
  await a.createReplica(bAdapter);
  const b = await alice.openDatabase(bAdapter, { now });
  tick();
  const onB = (await b.get<{ n: number }>(inConflict.id)) as Document<{ n: number }>;
  onB.content.n = 4;
  await onB.save();
  inConflict.content.n = 5;
  await inConflict.save();
  await a.pullFrom(b);

  const db = await session.openDatabase(adapter, { now });
  const loaded = (await db.get<{ n: number }>(doc.id)) as Document<{ n: number }>;
  const loadedInConflict = (await db.get<{ n: number }>(inConflict.id)) as Document<{ n: number }>;
  const conflict = (await loadedInConflict.conflict()) as Conflict<{ n: number }>;
  const acl = session.kind === "anonymous" ? undefined : await db.getAcl();
  const set = await db.find();
  expect([loaded, conflict, set.count]).toEqual([expect.any(Document), expect.any(Conflict), 3]);

  await setAcl(a, lists);
  return { a, b, db, doc: loaded, inConflict: loadedInConflict, conflict, acl, set, session, adapter };
}

/** myAccess as letters: visible, read, write, create, admin; "-" for false. */
function letters(access: Record<string, boolean>, keys: readonly [string, string][]): string {
  return keys.map(([key, letter]) => (access[key] === true ? letter : "-")).join("");
}
const DATABASE_ACCESS: readonly [string, string][] = [
  ["visible", "V"],
  ["read", "R"],
  ["write", "W"],
  ["create", "C"],
  ["admin", "A"],
];
const DOCUMENT_ACCESS: readonly [string, string][] = [
  ["read", "R"],
  ["update", "U"],
  ["delete", "D"],
];

// Every public method, and what calling it gives each row. "+" succeeds,
// "0" finds nothing (undefined or an empty set), "x" is ACCESS_DENIED, and
// "n/a" can't be tried: an anonymous session can't be an admin, so it never
// holds an Acl. myAccess shows what it returned, as letters.
type Calls = (w: World) => Promise<unknown>;
const CALLS: Record<string, Calls> = {
  "Session.openDatabase": (w) => w.session.openDatabase(w.adapter, { now }),
  "Database.get": (w) => w.db.get(w.doc.id),
  "Database.find": (w) => w.db.find(),
  "Database.create": (w) => w.db.create({ n: 9 }),
  "Database.getAcl": (w) => w.db.getAcl(),
  "Database.myAccess": async (w) => letters({ ...(await w.db.myAccess()) }, DATABASE_ACCESS),
  "Database.createReplica": async (w) => {
    await w.db.createReplica(newAdapter());
    return true;
  },
  "Database.registerReplica": (w) => w.db.registerReplica(),
  "Database.replicas": (w) => w.db.replicas(),
  "Database.syncHello": (w) => w.db.syncHello(),
  "Database.checkPeer": async (w) => w.db.checkPeer(await w.b.syncHello()),
  "Database.exportChanges": (w) => w.db.exportChanges(),
  "Database.applyChanges": async (w) => w.db.applyChanges(await w.b.exportChanges({ since: await w.a.syncPosition(w.b.instanceId) })),
  "Database.syncPosition": (w) => w.db.syncPosition(w.b.instanceId),
  "Database.pullFrom": (w) => w.db.pullFrom(w.b),
  "Database.purge": (w) => w.db.purge(),
  "Database.getSettings": (w) => w.db.getSettings(),
  "Database.saveSettings": async (w) => {
    await w.db.saveSettings({ purgeAfterDays: 30 });
    return true;
  },
  "Database.raiseLevel": (w) => w.db.raiseLevel(),
  "Database.syncState": (w) => w.db.syncState(),
  "Database.retireReplica": async (w) => {
    await w.db.retireReplica(w.b.instanceId);
    return true;
  },
  "Document.myAccess": async (w) => letters({ ...(await w.doc.myAccess()) }, DOCUMENT_ACCESS),
  "Document.save": (w) => {
    w.doc.content.n = 10;
    return w.doc.save();
  },
  "Document.delete": (w) => w.doc.delete(),
  "Document.conflict": (w) => w.inConflict.conflict(),
  "Document.getChildren": (w) => w.doc.getChildren(),
  "Conflict.resolveWith": (w) => w.conflict.resolveWith((w.conflict.versions[0] as { document: Document<{ n: number }> }).document),
  "Conflict.resolveWithContent": (w) => w.conflict.resolveWithContent({ content: { n: 11 } }),
  "Conflict.resolveByDeleting": (w) => w.conflict.resolveByDeleting(),
  // Any change to the ACL makes an Acl loaded before it stale, so the
  // table's ACL is written here with the clock the Acl was loaded at, as
  // only another engine could; save's own access check is what is left.
  "Acl.save": async (w) => {
    const acl = w.acl as Acl;
    const stored = w.adapter.getDocument(aclDocId(w.a.databaseId)) as DocumentEnvelope;
    w.adapter.putDocument({ ...stored, vectorClock: acl.vectorClock });
    await acl.save();
    return true;
  },
  "DocumentSet.[Symbol.asyncIterator]": async (w) => {
    let count = 0;
    for await (const _ of w.set) {
      count++;
    }
    return count === 0 ? undefined : count;
  },
};

//                                       all      admin    creator  writer   reader   readerW  stranger locked   anonymous
const TABLE: Record<string, readonly string[]> = {
  "Session.openDatabase":               ["+",     "+",     "+",     "+",     "+",     "+",     "x",     "x",     "x"],
  "Database.get":                       ["+",     "0",     "0",     "0",     "+",     "+",     "x",     "x",     "x"],
  "Database.find":                      ["+",     "0",     "0",     "0",     "+",     "+",     "x",     "x",     "x"],
  "Database.create":                    ["+",     "x",     "+",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.getAcl":                    ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.myAccess":                  ["VRWCA", "V---A", "V--C-", "V-W--", "VR---", "VRW--", "-----", "-----", "-----"],
  "Database.createReplica":             ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.registerReplica":           ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.replicas":                  ["+",     "+",     "+",     "+",     "+",     "+",     "x",     "x",     "x"],
  "Database.syncHello":                 ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.checkPeer":                 ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.exportChanges":             ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.applyChanges":              ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.syncPosition":              ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.pullFrom":                  ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.purge":                     ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.getSettings":               ["+",     "+",     "+",     "+",     "+",     "+",     "x",     "x",     "x"],
  "Database.saveSettings":              ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.raiseLevel":                ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Database.syncState":                 ["+",     "+",     "+",     "+",     "+",     "+",     "x",     "x",     "x"],
  "Database.retireReplica":             ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "x"],
  "Document.myAccess":                  ["RUD",   "---",   "---",   "---",   "R--",   "RUD",   "---",   "---",   "---"],
  "Document.save":                      ["+",     "x",     "x",     "x",     "x",     "+",     "x",     "x",     "x"],
  "Document.delete":                    ["+",     "x",     "x",     "x",     "x",     "+",     "x",     "x",     "x"],
  "Document.conflict":                  ["+",     "0",     "0",     "0",     "+",     "+",     "x",     "x",     "x"],
  "Document.getChildren":               ["+",     "0",     "0",     "0",     "+",     "+",     "x",     "x",     "x"],
  "Conflict.resolveWith":               ["+",     "x",     "x",     "x",     "x",     "+",     "x",     "x",     "x"],
  "Conflict.resolveWithContent":        ["+",     "x",     "x",     "x",     "x",     "+",     "x",     "x",     "x"],
  "Conflict.resolveByDeleting":         ["+",     "x",     "x",     "x",     "x",     "+",     "x",     "x",     "x"],
  "Acl.save":                           ["+",     "+",     "x",     "x",     "x",     "x",     "x",     "x",     "n/a"],
  "DocumentSet.[Symbol.asyncIterator]": ["+",     "0",     "0",     "0",     "+",     "+",     "x",     "x",     "x"],
};

// Members that only report what an object already holds, from when it was
// loaded or last saved. They read nothing from the database, except level,
// which says only what kind of database it is.
const DATA = new Set([
  "Database.level",
  ...["vectorClock", "version", "createdAt", "createdBy", "updatedAt", "updatedBy", "updatedOn"].flatMap((name) => [`Document.${name}`, `Acl.${name}`]),
  "Document.deleted",
]);

const SYMBOLS: Record<string, Outcome | string> = { "+": "ok", "0": "none", x: "denied" };

describe("the access table", () => {
  it("lists every public method of the classes a session reaches, and nothing else", () => {
    const members: string[] = [];
    for (const [name, prototype] of [
      ["Session", Session.prototype],
      ["Database", Database.prototype],
      ["Document", Document.prototype],
      ["Conflict", Conflict.prototype],
      ["Acl", Acl.prototype],
      ["DocumentSet", DocumentSet.prototype],
    ] as const) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (key !== "constructor") {
          members.push(`${name}.${typeof key === "symbol" ? `[${key.description ?? ""}]` : key}`);
        }
      }
    }
    const listed = [...Object.keys(TABLE), ...DATA].sort();
    expect(members.sort()).toEqual(listed);
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(TABLE).sort());
  });

  it("has a row for every membership", () => {
    for (const [method, row] of Object.entries(TABLE)) {
      expect(row.length, method).toBe(ROWS.length);
    }
  });

  for (const [method, expected] of Object.entries(TABLE)) {
    describe(method, () => {
      it.each(ROWS.map((row, index) => [row, expected[index] as string] as const))("as %s: %s", async (row, symbol) => {
        if (symbol === "n/a") {
          return;
        }
        const w = await world(SESSIONS[row], TABLE_ACL);
        const outcome = await outcomeOf(() => (CALLS[method] as Calls)(w));
        expect(outcome).toBe(SYMBOLS[symbol] ?? symbol);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The reference model.

const POOL = ["p1", "p2", "p3"] as const;
const SPECIAL = ["*", "anonymous"] as const;

/** The ladder: "anonymous" admits everyone, "*" every signed-in principal, an ID that principal. */
function admits(principal: string, list: readonly string[]): boolean {
  return list.includes("anonymous") || (principal !== "anonymous" && (list.includes("*") || list.includes(principal)));
}

interface ModelGrant {
  visible: boolean;
  read: boolean;
  write: boolean;
  create: boolean;
  admin: boolean;
}

function modelGrant(principal: string, lists: Lists): ModelGrant {
  if (lists.noAccess.includes(principal)) {
    return { visible: false, read: false, write: false, create: false, admin: false };
  }
  const read = admits(principal, lists.readers);
  const write = admits(principal, lists.writers);
  const create = admits(principal, lists.creators);
  const admin = principal !== "anonymous" && lists.admins.includes(principal);
  return { visible: read || write || create || admin, read, write, create, admin };
}

const OPS = ["open", "get", "find", "create", "save", "delete", "docMyAccess", "myAccess", "getAcl", "exportChanges"] as const;
type Op = (typeof OPS)[number];

/** What the model says op gives: an Outcome, or myAccess as letters. */
function modelOutcome(op: Op, grant: ModelGrant, docRead: boolean, docWrite: boolean): string {
  const refused = (allowed: boolean): string => (allowed ? "ok" : "denied");
  const reads = grant.read && docRead;
  const writes = reads && grant.write && docWrite;
  switch (op) {
    case "open":
      return refused(grant.visible);
    case "get":
    case "find":
      return grant.visible ? (reads ? "ok" : "none") : "denied";
    case "create":
      return refused(grant.create);
    case "save":
    case "delete":
      return refused(writes);
    case "docMyAccess":
      return letters({ read: reads, update: writes, delete: writes }, DOCUMENT_ACCESS);
    case "myAccess":
      return letters({ ...grant }, DATABASE_ACCESS);
    case "getAcl":
    case "exportChanges":
      return refused(grant.admin);
  }
}

const subset = <T extends string>(items: readonly T[]): fc.Arbitrary<T[]> => fc.subarray([...items]);
const listsArbitrary: fc.Arbitrary<Lists> = fc.record({
  admins: subset(POOL).map((admins) => ["alice", ...admins]),
  creators: subset([...POOL, ...SPECIAL]),
  writers: subset([...POOL, ...SPECIAL]),
  readers: subset([...POOL, ...SPECIAL]),
  noAccess: subset(POOL),
});
const docListArbitrary = fc.subarray([...POOL, ...SPECIAL], { minLength: 1 });

interface Case {
  lists: Lists;
  docReaders: string[];
  docWriters: string[];
  principal: string;
  op: Op;
}

/**
 * Runs one case: alice makes a document with the case's lists while the
 * database admits everyone; the principal opens it and loads the document if
 * it can; then alice sets the case's ACL and the principal calls op. Returns
 * undefined when op needs a loaded document the principal couldn't get.
 */
async function run(c: Case): Promise<string | undefined> {
  const adapter = newAdapter();
  try {
    const a = await alice.openDatabase(adapter, { now });
    await setAcl(a, { admins: ["alice", ...POOL], creators: ["alice"], writers: ["anonymous"], readers: ["anonymous"], noAccess: [] });
    const created = await a.create({ n: 1 }, { readers: c.docReaders, writers: c.docWriters });
    const session = c.principal === "anonymous" ? Session.anonymous() : Session.withId(c.principal);
    const db = await session.openDatabase(adapter, { now });
    const doc = await db.get<{ n: number }>(created.id);
    await setAcl(a, c.lists);
    const needsDoc = c.op === "save" || c.op === "delete" || c.op === "docMyAccess";
    if (needsDoc && doc === undefined) {
      return undefined;
    }
    const call: Record<Op, () => Promise<unknown>> = {
      open: () => session.openDatabase(adapter, { now }),
      get: () => db.get(created.id),
      find: () => db.find(),
      create: () => db.create({ n: 2 }),
      save: () => (doc as Document<{ n: number }>).save(),
      delete: () => (doc as Document<{ n: number }>).delete(),
      docMyAccess: async () => letters({ ...(await (doc as Document<{ n: number }>).myAccess()) }, DOCUMENT_ACCESS),
      myAccess: async () => letters({ ...(await db.myAccess()) }, DATABASE_ACCESS),
      getAcl: () => db.getAcl(),
      exportChanges: () => db.exportChanges(),
    };
    return await outcomeOf(call[c.op]);
  } finally {
    adapter.close();
    adapters = adapters.filter((each) => each !== adapter);
  }
}

const caseArbitrary = (principal: fc.Arbitrary<string>, lists: fc.Arbitrary<Lists> = listsArbitrary): fc.Arbitrary<Case> =>
  fc.record({ lists, docReaders: docListArbitrary, docWriters: docListArbitrary, principal, op: fc.constantFrom(...OPS) });

describe("against the reference model (properties)", () => {
  it("every call gives what the model says", async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary(fc.constantFrom(...POOL, "anonymous")), async (c) => {
        const outcome = await run(c);
        fc.pre(outcome !== undefined);
        const grant = modelGrant(c.principal, c.lists);
        expect(outcome).toBe(modelOutcome(c.op, grant, admits(c.principal, c.docReaders), admits(c.principal, c.docWriters)));
      }),
      { numRuns: 300 },
    );
  });

  it("a principal in noAccess gets nothing, whatever the other lists say", async () => {
    const locked = fc.constantFrom(...POOL).chain((principal) =>
      caseArbitrary(fc.constant(principal), listsArbitrary.map((lists) => ({ ...lists, noAccess: [...new Set([...lists.noAccess, principal])] }))),
    );
    await fc.assert(
      fc.asyncProperty(locked, async (c) => {
        const outcome = await run(c);
        fc.pre(outcome !== undefined);
        const nothing: Record<Op, string> = {
          open: "denied",
          get: "denied",
          find: "denied",
          create: "denied",
          save: "denied",
          delete: "denied",
          docMyAccess: "---",
          myAccess: "-----",
          getAcl: "denied",
          exportChanges: "denied",
        };
        expect(outcome).toBe(nothing[c.op]);
      }),
      { numRuns: 200 },
    );
  });

  it("nothing grants more than the database's lists", async () => {
    await fc.assert(
      fc.asyncProperty(caseArbitrary(fc.constantFrom(...POOL, "anonymous")), async (c) => {
        const outcome = await run(c);
        fc.pre(outcome !== undefined);
        const listed = (list: readonly string[]): boolean => !c.lists.noAccess.includes(c.principal) && admits(c.principal, list);
        const anyList = [c.lists.admins, c.lists.creators, c.lists.writers, c.lists.readers].some(listed);
        if (outcome !== "denied") {
          expect(anyList || c.op === "myAccess" || c.op === "docMyAccess").toBe(true);
        }
        if ((c.op === "get" || c.op === "find") && outcome === "ok") {
          expect(listed(c.lists.readers)).toBe(true);
        }
        if ((c.op === "save" || c.op === "delete") && outcome === "ok") {
          expect(listed(c.lists.writers) && listed(c.lists.readers)).toBe(true);
        }
        if (c.op === "create" && outcome === "ok") {
          expect(listed(c.lists.creators)).toBe(true);
        }
        if ((c.op === "getAcl" || c.op === "exportChanges") && outcome === "ok") {
          expect(listed(c.lists.admins)).toBe(true);
        }
        if (c.op === "myAccess") {
          const [v, r, w, cr, ad] = [...outcome];
          expect(v === "-" || anyList).toBe(true);
          expect(r === "-" || listed(c.lists.readers)).toBe(true);
          expect(w === "-" || listed(c.lists.writers)).toBe(true);
          expect(cr === "-" || listed(c.lists.creators)).toBe(true);
          expect(ad === "-" || listed(c.lists.admins)).toBe(true);
        }
        if (c.op === "docMyAccess") {
          expect(outcome[0] === "-" || listed(c.lists.readers)).toBe(true);
          expect(outcome[1] === "-" || listed(c.lists.writers)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
