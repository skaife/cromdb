import type { ChangeEntry, DocumentEnvelope } from "../envelope.js";

// Synchronous on purpose: better-sqlite3 is synchronous and its transactions
// cannot span awaits. The public API stays async above this layer.
//
// The adapter stores and returns what it is given. Validation and engine
// rules belong to the layers above it.
export interface StorageAdapter {
  getDocument(id: string): DocumentEnvelope | undefined;
  /** Inserts the document, or replaces the one with the same id. */
  putDocument(doc: DocumentEnvelope): void;
  /** Returns the sequence number assigned to the entry. */
  appendChange(entry: Omit<ChangeEntry, "seq">): number;
  /** Entries with seq greater than the given one, in ascending order. */
  changesSince(seq: number): ChangeEntry[];
  /** Replica-local state that never replicates, such as the instance ID. */
  getLocal(key: string): string | undefined;
  setLocal(key: string, value: string): void;
  /** Runs fn all-or-nothing and rethrows its error. Calls may nest. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
