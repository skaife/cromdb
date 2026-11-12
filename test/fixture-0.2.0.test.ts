import Sqlite from "better-sqlite3";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/database.js";
import { sync } from "../src/replication.js";
import { Session } from "../src/session.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";
import { databaseDocId } from "../src/system-docs.js";

// A database written by the real cromdb 0.2.0 from npm, made by
// compat/scripts/make-fixture.ts. expected.json is what 0.2.0 showed for it.
const FIXTURE = new URL("fixtures/0.2.0/", import.meta.url);

interface Expected {
  madeBy: string;
  databaseId: string;
  replicas: { instanceId: string; name: string }[];
  files: { lisbon: string; osaka: string };
  documents: { id: string; parentId: string; version: string; content: Record<string, unknown> }[];
  bobOnly: { id: string; version: string };
  deleted: string;
  conflict: { id: string; version: string; versions: { isPrimary: boolean; version: string; status: string }[] };
}

const expected = JSON.parse(readFileSync(new URL("expected.json", FIXTURE), "utf8")) as Expected;
const alice = Session.named("alice"); // the fixture wrote "Alice": names compare without case
const bob = Session.named("Bob");

let dir: string;
let adapters: SqliteAdapter[];

/** Opens a copy of the fixture file, so the committed one is never changed. */
function openCopy(name: "lisbon" | "osaka"): SqliteAdapter {
  const file = join(dir, `${name}.cromdb`);
  copyFileSync(new URL(`${name}.cromdb`, FIXTURE), file);
  const adapter = SqliteAdapter.open(file);
  adapters.push(adapter);
  return adapter;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cromdb-fixture-"));
  adapters = [];
});

afterEach(() => {
  for (const adapter of adapters) {
    adapter.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

async function both(): Promise<{ lisbon: Database; osaka: Database; lisbonAdapter: SqliteAdapter }> {
  const lisbonAdapter = openCopy("lisbon");
  return { lisbon: await alice.openDatabase(lisbonAdapter), osaka: await alice.openDatabase(openCopy("osaka")), lisbonAdapter };
}

describe("a database made by cromdb 0.2.0", () => {
  it("was made by 0.2.0", () => {
    expect(expected.madeBy).toBe("cromdb 0.2.0");
  });

  it("opens at level 1, with its replicas and their names", async () => {
    const { lisbon, osaka } = await both();
    for (const [db, instanceId] of [[lisbon, expected.files.lisbon], [osaka, expected.files.osaka]] as const) {
      expect(db.databaseId).toBe(expected.databaseId);
      expect(db.instanceId).toBe(instanceId);
      expect(db.level).toBe(1);
      expect((await db.replicas()).map(({ instanceId: id, name }) => ({ instanceId: id, name }))).toEqual(expected.replicas);
    }
  });

  it("reads every document as 0.2.0 did, versions included", async () => {
    const { lisbon, osaka } = await both();
    for (const db of [lisbon, osaka]) {
      for (const want of expected.documents) {
        const doc = await db.get(want.id);
        expect(doc?.version).toBe(want.version);
        expect(doc?.parentId).toBe(want.parentId);
        expect(JSON.parse(JSON.stringify(doc?.content))).toEqual(want.content);
      }
      const groceries = await db.get<{ due: Date }>(expected.documents[0]?.id as string);
      expect(groceries?.content.due).toBeInstanceOf(Date);
      expect(await db.get(expected.deleted)).toBeUndefined();
    }
  });

  it("keeps access as 0.2.0 wrote it", async () => {
    const { lisbonAdapter, lisbon } = await both();
    expect(await lisbon.get(expected.bobOnly.id)).toBeUndefined();
    const bobs = await bob.openDatabase(lisbonAdapter);
    expect((await bobs.get(expected.bobOnly.id))?.version).toBe(expected.bobOnly.version);
    expect(await bobs.myAccess()).toEqual({ create: true, admin: false });
  });

  it("shows the same conflict on both replicas as 0.2.0 did", async () => {
    const { lisbon, osaka } = await both();
    for (const db of [lisbon, osaka]) {
      const listed = await db.find({ inConflict: true });
      expect(listed.count).toBe(1);
      const conflict = await (await db.get(expected.conflict.id))?.conflict();
      expect(conflict?.version).toBe(expected.conflict.version);
      expect(
        conflict?.versions.map((version) => ({
          isPrimary: version.isPrimary,
          version: version.document.version,
          status: version.document.content["status"],
        })),
      ).toEqual(expected.conflict.versions);
    }
  });

  it("pages through it, using the index added on open", async () => {
    const { lisbon } = await both();
    const all: string[] = [];
    for await (const doc of await lisbon.find()) {
      all.push(doc.id);
    }
    const paged: string[] = [];
    let after: string | undefined;
    do {
      const page = await lisbon.find({}, { limit: 1, after });
      for await (const doc of page) {
        paged.push(doc.id);
      }
      after = page.next;
    } while (after !== undefined);
    expect(paged).toEqual(all);
  });

  it("syncs, resolves the conflict, and still writes nothing 0.2.0 can't read", async () => {
    const { lisbon, osaka } = await both();
    await sync(lisbon, osaka);
    const conflict = await (await osaka.get(expected.conflict.id))?.conflict();
    await conflict?.resolveWithContent({ content: { title: "Plan", status: "approved" } });
    const added = await lisbon.create({ title: "Written by 0.3.0" });
    await sync(lisbon, osaka);
    for (const db of [lisbon, osaka]) {
      expect((await db.find({ inConflict: true })).count).toBe(0);
      expect((await db.get(expected.conflict.id))?.content).toEqual({ title: "Plan", status: "approved" });
      expect((await db.get(added.id))?.content).toEqual({ title: "Written by 0.3.0" });
    }
    expect((await lisbon.get(expected.conflict.id))?.version).toBe((await osaka.get(expected.conflict.id))?.version);

    for (const adapter of adapters) {
      adapter.close();
    }
    adapters = [];
    for (const name of ["lisbon", "osaka"]) {
      const raw = new Sqlite(join(dir, `${name}.cromdb`), { readonly: true });
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      const body = raw.prepare("SELECT body FROM documents WHERE id = ?").pluck().get(databaseDocId(expected.databaseId)) as string;
      expect(Object.keys((JSON.parse(body) as { content: object }).content).sort()).toEqual(["createdAt", "createdOn", "databaseId", "unicodeVersion"]);
      raw.close();
    }
  });
});
