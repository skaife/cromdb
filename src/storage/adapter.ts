import type { ChangeEntry, DocumentEnvelope } from "../envelope.js";

// Synchronous on purpose: better-sqlite3 is synchronous and its transactions
// cannot span awaits. The public API stays async above this layer.
//
// The adapter stores and returns what it is given. Validation and engine
// rules belong to the layers above it.
export type LiveDocumentsNarrowing = { readonly parentId: string } | { readonly topLevel: true };

export interface StorageAdapter {
  getDocument(id: string): DocumentEnvelope | undefined;
  /** Inserts the document, or replaces the one with the same id. */
  putDocument(doc: DocumentEnvelope): void;
  /**
   * Every document of kind "document" that isn't deleted, in no particular
   * order. With parentId, only those whose parentId is that value (a
   * top-level document with that id included). With topLevel, only those
   * whose parentId equals their id.
   */
  liveDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[];
  /** Every stored document, all kinds, deleted included, in id order. */
  allDocuments(): DocumentEnvelope[];
  /** Returns the sequence number assigned to the entry. */
  appendChange(entry: Omit<ChangeEntry, "seq">): number;
  /** Entries with seq greater than the given one, in ascending order. */
  changesSince(seq: number): ChangeEntry[];
  /** The highest sequence number assigned so far, or 0 if none. */
  lastSeq(): number;
  /** Replica-local state that never replicates, such as the instance ID. */
  getLocal(key: string): string | undefined;
  setLocal(key: string, value: string): void;
  /** True when there are no documents, no change entries and no local state. */
  isEmpty(): boolean;
  /** Runs fn all-or-nothing and rethrows its error. Calls may nest. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
