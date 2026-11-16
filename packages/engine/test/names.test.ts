import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import type { Document } from "../src/document.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import { sync } from "../src/replication.js";
import { Session } from "../src/session.js";
import { aclDocId } from "../src/system-docs.js";
import { documentVersion } from "../src/version.js";
import { TestAdapter, expectCode, seedAdapter } from "./helpers.js";

// Databases at level 1 identify people by name: stored in NFKC form, compared
// without case. Every database this engine creates is at level 2, so these
// tests run on copies of a database made by cromdb 0.3.0 (see seedAdapter).

let adapters: TestAdapter[];
let adapter: TestAdapter;
let time: number;
const now = (): Date => new Date(time);

const alice = Session.named("alice");
const bob = Session.named("bob");

function open(session: Session, on: TestAdapter = adapter): Promise<Database> {
  return session.openDatabase(on, { now });
}

function newAdapter(seed?: "alice" | "other"): TestAdapter {
  const made = seed === undefined ? new TestAdapter() : seedAdapter(seed);
  adapters.push(made);
  return made;
}

beforeEach(() => {
  adapters = [];
  adapter = newAdapter("alice");
  time = Date.parse("2026-11-12T12:00:00.000Z");
});

afterEach(() => {
  for (const made of adapters) {
    made.close();
  }
});

async function setCreators(db: Database, creators: string[]): Promise<void> {
  const acl = await db.getAcl();
  acl.creators = creators;
  await acl.save();
}

describe("Session.named", () => {
  it("validates and keeps the NFKC form of the name", () => {
    const session = Session.named("Ｓｃｏｔｔ Skaife");
    expect(session.principal).toBe("Scott Skaife");
    expect(session.kind).toBe("named");
  });

  it.each(["system", "System", "anonymous", "ANONYMOUS", "*", "[Admin]", "", " alice", "a  b", "Bob\u0378"])("refuses %j", (name) => {
    expect(() => Session.named(name)).toThrow(CromDBError);
  });
});

describe("a level-1 database", () => {
  it("is at level 1 and opens with a named session, unchanged", async () => {
    const before = adapter.allDocuments();
    const db = await open(alice);
    expect(db.level).toBe(1);
    expect(adapter.allDocuments()).toEqual(before);
    expect(adapter.marks).toEqual([]);
  });
});

describe("creating and reading", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
  });

  it("matches creators by canonical form", async () => {
    const db2 = await open(Session.named("ALICE"));
    await expect(db2.create({ x: 1 })).resolves.toBeDefined();
  });

  it("matches readers by canonical form", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["alice"] });
    expect(await (await open(bob)).get(doc.id)).toBeUndefined();
    expect(await (await open(Session.named("Alice"))).get(doc.id)).toBeDefined();
  });

  it("adds the creator in the NFKC form the session holds", async () => {
    await setCreators(db, ["*"]);
    const wide = await open(Session.named("Ａｌｉｃｅ Ｂ"));
    const doc = await wide.create({ x: 1 }, { writers: ["bob"] });
    expect(doc.writers).toEqual(["bob", "Alice B"]);
  });

  it("keeps writers that already admit the creator by canonical form", async () => {
    expect((await db.create({ x: 1 }, { writers: ["ALICE"] })).writers).toEqual(["ALICE"]);
  });

  it("stores the NFKC form of list entries", async () => {
    const doc = await db.create({ x: 1 }, { readers: ["Ｂｏｂ"] });
    expect(adapter.getDocument(doc.id)?.readers).toEqual(["Bob"]);
  });

  it("refuses duplicate list entries by canonical form", async () => {
    await expectCode(db.create({ x: 1 }, { writers: ["alice", "ALICE"] }), "INVALID_ACCESS_LIST");
  });

  it("sets createdBy from the session's stored name", async () => {
    const doc = await (await open(Session.named("ＡＬＩＣＥ"))).create({ x: 1 });
    expect(doc.createdBy).toBe("ALICE");
    expect(adapter.getDocument(doc.id)).toMatchObject({ createdBy: "ALICE", updatedBy: "ALICE" });
    expect((await db.get(doc.id))?.createdBy).toBe("ALICE");
  });

  it("finds only what the session can read, by canonical form", async () => {
    await db.create({ n: 1 }, { readers: ["alice"] });
    await db.create({ n: 2 }, { readers: ["alice", "Bob"] });
    expect((await (await open(bob)).find()).count).toBe(1);
  });
});

describe("saving", () => {
  let db: Database;
  let doc: Document<{ title: string }>;

  beforeEach(async () => {
    db = await open(alice);
    doc = await db.create({ title: "Hello" });
  });

  it("updates readers and writers to the stored NFKC form", async () => {
    doc.readers = ["*", "Ｂｏｂ"];
    doc.writers = ["＊"];
    await doc.save();
    expect(doc.readers).toEqual(["*", "Bob"]);
    expect(doc.writers).toEqual(["*"]);
    expect(adapter.getDocument(doc.id)?.writers).toEqual(["*"]);
  });

  it("records the saving session's name as written, matching writers by canonical form", async () => {
    const own = await db.create({ x: 1 }, { writers: ["Scott Skaife"] });
    const other = await (await open(Session.named("scott skaife"))).get<{ x: number }>(own.id);
    if (other === undefined) {
      expect.fail("document not readable");
    }
    await other.save();
    expect(other.updatedBy).toBe("scott skaife");
    expect(adapter.getDocument(own.id)?.updatedBy).toBe("scott skaife");
  });

  it("follows the stored lists by canonical form in myAccess", async () => {
    const shared = await db.create({ x: 1 }, { readers: ["*"], writers: ["alice", "Bob"] });
    const bobDoc = (await (await open(bob)).get(shared.id)) as Document<{ x: number }>;
    expect(await bobDoc.myAccess()).toEqual({ read: true, update: true, delete: true });
  });
});

describe("the ACL", () => {
  let db: Database;

  beforeEach(async () => {
    db = await open(alice);
  });

  function storedAcl(): DocumentEnvelope {
    return adapter.getDocument(aclDocId(db.databaseId)) as DocumentEnvelope;
  }

  it("lets a new creator create, matching names case-insensitively", async () => {
    const bobDb = await open(bob);
    await expectCode(bobDb.create({ x: 1 }), "ACCESS_DENIED");
    await setCreators(db, ["alice", "Bob"]);
    expect((await bobDb.myAccess()).create).toBe(true);
    expect((await bobDb.create({ x: 1 })).updatedBy).toBe("bob");
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

  it("refuses duplicate admins and creators by canonical form", async () => {
    for (const [creators, admins] of [
      [["alice"], ["Alice", "alice"]],
      [["Bob", "BOB"], ["alice"]],
    ]) {
      const acl = await db.getAcl();
      acl.creators = creators as string[];
      acl.admins = admins as string[];
      await expectCode(acl.save(), "INVALID_ACCESS_LIST");
    }
  });

  // U+FF0A FULLWIDTH ASTERISK is "*" in NFKC form.
  it.each([[["ANONYMOUS"]], [[String.fromCodePoint(0xff0a)]]])("refuses admins %j", async (admins) => {
    const acl = await db.getAcl();
    acl.admins = admins;
    await expectCode(acl.save(), "INVALID_ACCESS_LIST");
  });
});

describe("Unicode version", () => {
  // U+A7CF LATIN SMALL LETTER PHARYNGEAL VOICED FRICATIVE, new in 17.0.
  // U+A7CD LATIN SMALL LETTER S WITH DIAGONAL STROKE, new in 16.0.
  const new17 = "Bob\uA7CF";
  const new16 = "Bob\uA7CD";

  /** Rewrites the database document as if it had been created at another version. */
  function setDatabaseVersion(db: Database, unicodeVersion: string): void {
    const stored = adapter.getDocument(db.databaseId) as DocumentEnvelope;
    adapter.putDocument({ ...stored, content: { ...stored.content, unicodeVersion } });
  }

  it("opens a database at an older version and checks names against it", async () => {
    setDatabaseVersion(await open(alice), "16.0");
    const older = await open(alice);

    await expectCode(older.create({ x: 1 }, { readers: [new17] }), "INVALID_ACCESS_LIST");
    await expectCode(older.create({ x: 1 }, { writers: ["*", new17] }), "INVALID_ACCESS_LIST");
    await expect(older.create({ x: 1 }, { readers: [new16] })).resolves.toBeDefined();

    const doc = await older.create({ x: 1 });
    doc.writers = [new17];
    await expectCode(doc.save(), "INVALID_ACCESS_LIST");

    const session = Session.named(new17); // fine for this engine
    await expectCode(open(session), "INVALID_PRINCIPAL");
    await expect(open(Session.named(new16))).resolves.toBeDefined();
  });

  it("accepts the same names at 17.0", async () => {
    setDatabaseVersion(await open(alice), "17.0");
    const current = await open(alice);
    const doc = await current.create({ x: 1 }, { readers: [new17], writers: ["*", new17] });
    expect(doc.readers).toEqual([new17]);
    await expect(open(Session.named(new17))).resolves.toBeDefined();
  });

  it("checks ACL names against the database's version", async () => {
    setDatabaseVersion(await open(alice), "16.0");
    const acl = await (await open(alice)).getAcl();
    acl.creators = [new17];
    await expectCode(acl.save(), "INVALID_ACCESS_LIST");
    acl.creators = [new16];
    await acl.save();
    expect(acl.creators).toEqual([new16]);
  });

  it("refuses that session without writing anything", async () => {
    setDatabaseVersion(await open(alice), "16.0");
    const changeCount = adapter.changesSince(0).length;
    await expectCode(open(Session.named(new17)), "INVALID_PRINCIPAL");
    expect(adapter.changesSince(0).length).toBe(changeCount);
  });
});

describe("replication", () => {
  it("copies a level-1 database at level 1, with format-1 batches and unmarked files", async () => {
    const a = await open(alice);
    await setCreators(a, ["*"]);
    const target = newAdapter();
    await a.createReplica(target, { name: "Ｂ" });
    expect(target.marks).toEqual([]);
    expect(target.inner.markLevel).toBeDefined();
    const b = await open(alice, target);
    expect(b.level).toBe(1);

    const doc = await (await open(Session.named("Bob"))).create({ title: "From Bob" }, { writers: ["bob"] });
    const batch = await a.exportChanges({ since: await b.syncPosition(a.instanceId) });
    expect(batch.format).toBe(1);
    expect(Object.keys(batch).sort()).toEqual(
      ["databaseId", "documents", "format", "conflictPolicy", "hasMore", "since", "sourceInstanceId", "sourceLastSeq", "toSeq", "unicodeVersion"].sort(),
    );
    await b.applyChanges(JSON.parse(JSON.stringify(batch)));
    const onB = await (await open(Session.named("BOB"), target)).get<{ title: string }>(doc.id);
    expect(onB?.content.title).toBe("From Bob");
    expect((await onB?.myAccess())?.update).toBe(true);

    // No maxLevel is written at level 1: 0.2.0 and 0.3.0 refuse it.
    const listed = await b.replicas();
    expect(listed.find((replica) => replica.instanceId === b.instanceId)?.maxLevel).toBe(2);
    expect(listed.find((replica) => replica.instanceId === a.instanceId)?.maxLevel).toBeUndefined();
    for (const envelope of target.allDocuments().filter((row) => row.kind === "system")) {
      expect(Object.keys(envelope.content)).not.toContain("maxLevel");
      expect(Object.keys(envelope.content)).not.toContain("level");
    }
    await sync(a, b);
  });

  it("keeps level-1 versions as 0.2.0 and 0.3.0 compute them", async () => {
    const db = await open(alice);
    const doc = await db.create({ x: 1 });
    expect(doc.version).toBe(documentVersion(doc.vectorClock, 1));
    expect(doc.version).not.toBe(documentVersion(doc.vectorClock, 2));
  });

  it("refuses a database from another seed as another database", async () => {
    const a = await open(alice);
    const other = await open(alice, newAdapter("other"));
    expect(other.databaseId).not.toBe(a.databaseId);
    await expectCode(a.applyChanges(await other.exportChanges()), "SYNC_MISMATCH");
  });
});
