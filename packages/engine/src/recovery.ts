// Recovering versions only an old copy of a replica had: which versions are
// suspects, and the Suspect object a person decides with. Database.recover and
// the suspect methods do the storage and access parts.

import type { Document, WriteResult } from "./document.js";
import type { DocumentEnvelope } from "./envelope.js";
import type { StoredSuspect } from "./storage/adapter.js";
import { canonicalString, compare } from "./vector-clock.js";

/**
 * Why a version is a suspect:
 *   "absent"      the document isn't on this replica at all: it never got
 *                 here, or it was deleted and purged, so accepting it may
 *                 bring back a document others deleted
 *   "concurrent"  the document is here, and this version isn't superseded by
 *                 anything here
 *   "deleted"     the old copy deleted the document, which is live here
 */
export type SuspectReason = "absent" | "concurrent" | "deleted";

/** @internal The key a version gets: its document's ID and its clock. */
export function suspectKey(primaryId: string, envelope: DocumentEnvelope): string {
  return `${primaryId}|${canonicalString(envelope.vectorClock)}`;
}

/**
 * @internal For each version of one document on the old copy (its primary
 * row and conflict rows), whether this replica already has it or something
 * after it, and otherwise why it is a suspect.
 */
export function classify(
  old: readonly DocumentEnvelope[],
  here: readonly DocumentEnvelope[],
): { version: DocumentEnvelope; reason: SuspectReason | "known" }[] {
  return old.map((version) => {
    const known = here.some((row) => {
      const order = compare(version.vectorClock, row.vectorClock);
      return order === "before" || order === "equal";
    });
    if (known) {
      return { version, reason: "known" };
    }
    return { version, reason: here.length === 0 ? "absent" : version.deleted ? "deleted" : "concurrent" };
  });
}

/** What Database.recover found. */
export interface RecoverResult {
  /** New suspects: versions only the old copy had, not found by an earlier recover. */
  readonly suspects: number;
  /** Versions this replica already had, or had something after. */
  readonly known: number;
  /** Versions an earlier recover already compared, which were left as they were. */
  readonly seen: number;
}

/** @internal What a Suspect calls back into its Database for. */
export interface SuspectHost {
  accept(key: string, options: { ifVersion?: string; content?: Record<string, unknown>; readers?: unknown; writers?: unknown }): WriteResult;
  discard(key: string): void;
}

/**
 * A version only an old copy had, found by Database.recover and kept on this
 * replica, never replicated, until a person accepts or discards it. A
 * snapshot: read it again with Database.suspects to see later changes.
 */
export class Suspect<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly #host: SuspectHost;
  /** Identifies the suspect on this replica: its document's ID and its version's clock. */
  readonly key: string;
  readonly documentId: string;
  readonly reason: SuspectReason;
  /** The instance ID of the copy it was recovered from. */
  readonly from: string;
  readonly recoveredAt: Date;
  /** The old copy's version, read-only. For a deletion, deleted is true and its content is empty. */
  readonly document: Document<T>;
  /**
   * Everything this replica holds of the document now, as one version string,
   * or undefined if it holds nothing. Accepting needs it as ifVersion, so a
   * document that changed after this was read isn't overwritten.
   */
  readonly current: string | undefined;

  /** @internal Use Database.suspects. */
  constructor(host: SuspectHost, stored: StoredSuspect, document: Document<T>, current: string | undefined) {
    this.#host = host;
    this.key = stored.key;
    this.documentId = stored.primaryId;
    this.reason = stored.reason as SuspectReason;
    this.from = stored.from;
    this.recoveredAt = new Date(stored.recoveredAt);
    this.document = document;
    this.current = current;
  }

  /**
   * Writes this version as a new version of the document here, as this
   * session's principal, with the access a save (or a create, for an absent
   * document, or a delete, for a deletion) would need. The new version comes
   * after every version here and the suspect's, so on every replica it
   * supersedes them; it replicates like any other write. A document absent
   * here keeps its ID. Accepting a deletion of a document absent here
   * writes nothing.
   *
   * ifVersion must be current (STALE_DOCUMENT if the document changed since);
   * leave it out only when current is undefined. The document's other pending
   * suspects are decided with this one. READ_ONLY on a replica that takes no
   * writes.
   */
  async accept(options: { ifVersion?: string } = {}): Promise<WriteResult> {
    return this.#host.accept(this.key, { ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }) });
  }

  /** As accept, with content (and readers or writers, if given) a person merged, instead of the suspect's. Not for a deletion. */
  async acceptWithContent(options: { content: T; readers?: readonly string[]; writers?: readonly string[]; ifVersion?: string }): Promise<WriteResult> {
    return this.#host.accept(this.key, options);
  }

  /** Drops the suspect: nothing is written, and recovering again never offers it. */
  async discard(): Promise<void> {
    this.#host.discard(this.key);
  }
}
