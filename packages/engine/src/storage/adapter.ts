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
  /** Removes the document if there is one. Its change entries stay. */
  removeDocument(id: string): void;
  /**
   * Every document of kind "document" that isn't deleted and isn't a conflict
   * document (no conflictOf), in no particular order. With parentId, only
   * those whose parentId is that value (a top-level document with that id
   * included). With topLevel, only those whose parentId equals their id.
   */
  liveDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[];
  /** As liveDocuments, but deleted documents included. */
  primaryDocuments(narrow?: LiveDocumentsNarrowing): DocumentEnvelope[];
  /**
   * Optional, for paging through find. The documents liveDocuments returns
   * for narrow (primaryDocuments if includeDeleted), ordered by createdAt and
   * then id, both compared as plain strings, starting after the given
   * position (from the first if undefined), at most limit of them.
   *
   * Without this method the engine reads every candidate and sorts it for
   * each page, with the same results, more slowly.
   */
  documentsAfter?(
    narrow: LiveDocumentsNarrowing | undefined,
    includeDeleted: boolean,
    after: { readonly createdAt: string; readonly id: string } | undefined,
    limit: number,
  ): DocumentEnvelope[];
  /** Every conflict document whose conflictOf is primaryId, deleted included, in id order. */
  conflictRows(primaryId: string): DocumentEnvelope[];
  /** Every stored document, all kinds, deleted included, in id order. */
  allDocuments(): DocumentEnvelope[];
  /** Returns the sequence number assigned to the entry. */
  appendChange(entry: Omit<ChangeEntry, "seq">): number;
  /** Entries with seq greater than the given one, in ascending order. */
  changesSince(seq: number): ChangeEntry[];
  /**
   * The highest sequence number assigned so far, or 0 if none. It never
   * decreases, even when entries are removed: a removed number is never
   * assigned again.
   */
  lastSeq(): number;
  /**
   * Optional, for purge. Every change entry of the document with this ID, in
   * ascending order. An adapter without this method and removeChanges can't
   * purge; everything else works.
   */
  changesFor?(docId: string): ChangeEntry[];
  /** Optional. The change entry with this sequence number, or undefined if there is none (it was never assigned, or was removed). */
  changeAt?(seq: number): ChangeEntry | undefined;
  /** Optional, for purge. Removes the change entries with these sequence numbers; any that aren't there are ignored. */
  removeChanges?(seqs: readonly number[]): void;
  /**
   * Optional. Gives the space freed by removed documents and entries back to
   * the storage, for example by rewriting a file. May take a while on a large
   * database; nothing changes for the engine. Not inside a transaction.
   */
  compact?(): void;
  /**
   * Optional. Called inside the transaction that makes this storage a
   * backup (true) or adopts one (false). A file-based adapter should mark the
   * file so engines that don't know backups (0.7.0 and earlier) refuse to
   * open it, and write under the backed-up replica's ID.
   */
  markBackup?(backup: boolean): void;
  /** Replica-local state that never replicates, such as the instance ID. */
  getLocal(key: string): string | undefined;
  setLocal(key: string, value: string): void;
  /** True when there are no documents, no change entries and no local state. */
  isEmpty(): boolean;
  /**
   * Optional. Called inside the transaction that records a database level of
   * 2 or higher: when a database is created, and when a replica of one is
   * copied into this adapter. A file-based adapter should mark the file so
   * engines that don't know levels (0.3.0 and earlier) refuse to open it.
   */
  markLevel?(level: number): void;
  /** Runs fn all-or-nothing and rethrows its error. Calls may nest. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
