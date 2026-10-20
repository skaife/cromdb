import { expect } from "vitest";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import type { LiveDocumentsNarrowing, StorageAdapter } from "../src/storage/adapter.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";

// Delegates to a SqliteAdapter, records puts, and can be told to fail
// appendChange or setLocal to test that writes are all-or-nothing. Local keys
// in hiddenLocalKeys read as missing.
export class TestAdapter implements StorageAdapter {
  readonly inner = SqliteAdapter.open(":memory:");
  readonly puts: DocumentEnvelope[] = [];
  readonly hiddenLocalKeys = new Set<string>();
  failAppendChange = false;
  failSetLocal = false;

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
  }
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
