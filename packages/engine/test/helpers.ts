import BetterSqlite from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
import type { Database } from "../src/database.js";
import { CromDBError } from "../src/errors.js";
import type { LiveDocumentsNarrowing, StorageAdapter } from "../src/storage/adapter.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";

// Delegates to a SqliteAdapter, records puts, and can be told to fail
// appendChange or setLocal to test that writes are all-or-nothing. Local keys
// in hiddenLocalKeys read as missing. Set documentsAfter or markLevel to
// undefined to test the engine without them. In memory, or a copy of a seed
// (see seedAdapter), removed on close.
export class TestAdapter implements StorageAdapter {
  readonly inner: SqliteAdapter;
  readonly #dir: string | undefined;
  readonly puts: DocumentEnvelope[] = [];
  readonly marks: number[] = [];
  readonly hiddenLocalKeys = new Set<string>();
  failAppendChange = false;
  failSetLocal = false;
  documentsAfter: StorageAdapter["documentsAfter"] = (narrow, includeDeleted, after, limit) =>
    this.inner.documentsAfter(narrow, includeDeleted, after, limit);
  markLevel: StorageAdapter["markLevel"] = (level) => {
    this.marks.push(level);
    this.inner.markLevel(level);
  };
  changesFor: StorageAdapter["changesFor"] = (docId) => this.inner.changesFor(docId);
  changeAt: StorageAdapter["changeAt"] = (seq) => this.inner.changeAt(seq);
  removeChanges: StorageAdapter["removeChanges"] = (seqs) => this.inner.removeChanges(seqs);
  compact: StorageAdapter["compact"] = () => this.inner.compact();
  spaceUsage: StorageAdapter["spaceUsage"] = () => this.inner.spaceUsage();
  putSuspect: StorageAdapter["putSuspect"] = (suspect) => this.inner.putSuspect(suspect);
  getSuspect: StorageAdapter["getSuspect"] = (key) => this.inner.getSuspect(key);
  suspects: StorageAdapter["suspects"] = (state, after, limit) => this.inner.suspects(state, after, limit);
  markBackup: StorageAdapter["markBackup"] = (backup) => this.inner.markBackup(backup);

  /**
   * A byte for byte copy of this in-memory database, as copying its file
   * would make: same instance ID, same everything. For tests of copies
   * restored from an old file.
   */
  rawCopy(): TestAdapter {
    const db = (this.inner as unknown as { db: { serialize(): Buffer } }).db;
    return TestAdapter.fromBytes(db.serialize());
  }

  /** An in-memory database made from rawCopy's bytes. */
  static fromBytes(bytes: Buffer): TestAdapter {
    const adapter = new TestAdapter();
    const Ctor = SqliteAdapter as unknown as new (db: unknown) => SqliteAdapter;
    (adapter as { inner: SqliteAdapter }).inner.close();
    (adapter as { inner: SqliteAdapter }).inner = new Ctor(new BetterSqlite(bytes));
    return adapter;
  }

  /** seed is a file under test/fixtures/<release>/seeds/, without ".cromdb". */
  constructor(seed?: string, release = "0.3.0") {
    if (seed === undefined) {
      this.inner = SqliteAdapter.open(":memory:");
      return;
    }
    this.#dir = mkdtempSync(join(tmpdir(), "cromdb-seed-"));
    const file = join(this.#dir, `${seed}.cromdb`);
    copyFileSync(new URL(`fixtures/${release}/seeds/${seed}.cromdb`, import.meta.url), file);
    this.inner = SqliteAdapter.open(file);
  }

  getDocument(id: string): DocumentEnvelope | undefined {
    return this.inner.getDocument(id);
  }
  liveDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[] {
    return this.inner.liveDocuments(narrow);
  }
  primaryDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[] {
    return this.inner.primaryDocuments(narrow);
  }
  allDocuments(): DocumentEnvelope[] {
    return this.inner.allDocuments();
  }
  conflictRows(primaryId: string): DocumentEnvelope[] {
    return this.inner.conflictRows(primaryId);
  }
  putDocument(doc: DocumentEnvelope): void {
    this.puts.push(doc);
    this.inner.putDocument(doc);
  }
  removeDocument(id: string): void {
    this.inner.removeDocument(id);
  }
  appendChange(entry: Omit<ChangeEntry, "seq">): number {
    if (this.failAppendChange) {
      throw new Error("appendChange failed");
    }
    return this.inner.appendChange(entry);
  }
  changesSince(seq: number): ChangeEntry[] {
    return this.inner.changesSince(seq);
  }
  lastSeq(): number {
    return this.inner.lastSeq();
  }
  getLocal(key: string): string | undefined {
    return this.hiddenLocalKeys.has(key) ? undefined : this.inner.getLocal(key);
  }
  setLocal(key: string, value: string): void {
    if (this.failSetLocal) {
      throw new Error("setLocal failed");
    }
    this.inner.setLocal(key, value);
  }
  isEmpty(): boolean {
    return this.inner.isEmpty();
  }
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }
  close(): void {
    this.inner.close();
    if (this.#dir !== undefined) {
      rmSync(this.#dir, { recursive: true, force: true });
    }
  }
}

/**
 * A copy of an empty level-1 database made by cromdb 0.3.0, with "alice" as
 * its only admin and creator, for tests of databases that identify people by
 * name. Every copy of one seed has the same database and instance IDs; "alice"
 * and "other" are separate databases.
 */
export function seedAdapter(seed: "alice" | "other" = "alice"): TestAdapter {
  return new TestAdapter(seed);
}

/**
 * A copy of an empty level-2 database made by cromdb 0.5.0, with "alice" (an
 * ID) as its only admin and creator, for tests of level-2 databases, which
 * this engine opens and syncs but no longer creates. Every copy of one seed
 * has the same database and instance IDs; "alice" and "other" are separate
 * databases.
 */
export function level2Adapter(seed: "alice" | "other" = "alice"): TestAdapter {
  return new TestAdapter(seed, "0.5.0");
}

/**
 * A copy of an empty level-3 database made by cromdb 0.6.0, with "alice" as
 * its only admin, creator, writer and reader, for tests of level-3
 * databases, which this engine opens, syncs and can raise but no longer
 * creates. As level2Adapter otherwise.
 */
export function level3Adapter(seed: "alice" | "other" = "alice"): TestAdapter {
  return new TestAdapter(seed, "0.6.0");
}

/**
 * Lets everyone in, as a database below level 3 does: sets the database's
 * readers and writers to ["anonymous"], so each document's own lists decide.
 * creators are left as they are. For tests about documents' own lists, with
 * several users. The session must be an admin. Returns db.
 */
export async function admitEveryone(db: Database): Promise<Database> {
  const acl = await db.getAcl();
  acl.writers = ["anonymous"];
  acl.readers = ["anonymous"];
  await acl.save();
  return db;
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<CromDBError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CromDBError);
  expect((error as CromDBError).code).toBe(code);
  return error as CromDBError;
}
