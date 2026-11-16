import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
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

  /** seed is a file under test/fixtures/0.3.0/seeds/, without ".cromdb". */
  constructor(seed?: string) {
    if (seed === undefined) {
      this.inner = SqliteAdapter.open(":memory:");
      return;
    }
    this.#dir = mkdtempSync(join(tmpdir(), "cromdb-seed-"));
    const file = join(this.#dir, `${seed}.cromdb`);
    copyFileSync(new URL(`fixtures/0.3.0/seeds/${seed}.cromdb`, import.meta.url), file);
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

export async function expectCode(promise: Promise<unknown>, code: string): Promise<CromDBError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CromDBError);
  expect((error as CromDBError).code).toBe(code);
  return error as CromDBError;
}
