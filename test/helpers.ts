import { expect } from "vitest";
import type { ChangeEntry, DocumentEnvelope } from "../src/envelope.js";
import { CromDBError } from "../src/errors.js";
import type { StorageAdapter } from "../src/storage/adapter.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";

// Delegates to a SqliteAdapter, records puts, and can be told to fail
// appendChange to test that writes are all-or-nothing.
export class TestAdapter implements StorageAdapter {
  readonly inner = SqliteAdapter.open(":memory:");
  readonly puts: DocumentEnvelope[] = [];
  failAppendChange = false;

  getDocument(id: string): DocumentEnvelope | undefined {
    return this.inner.getDocument(id);
  }
  putDocument(doc: DocumentEnvelope): void {
    this.puts.push(doc);
    this.inner.putDocument(doc);
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
  getLocal(key: string): string | undefined {
    return this.inner.getLocal(key);
  }
  setLocal(key: string, value: string): void {
    this.inner.setLocal(key, value);
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
