import type { Document, WriteResult } from "./document.js";
import type { VectorClock } from "./vector-clock.js";
import { conflictVersion } from "./version.js";

/** One version of a document in conflict, as Conflict.versions lists it. */
export interface ConflictVersion<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Read-only: its save and delete throw READ_ONLY. */
  readonly document: Document<T>;
  /** Whether this is the version stored as the document itself, the one get returns. */
  readonly isPrimary: boolean;
  /** Whether whoever wrote this version was in its own writers. */
  readonly authorized: boolean;
  /** Whether this version deletes the document. Its content is empty. */
  readonly deleted: boolean;
}

/** @internal One stored row of the document's versions, as it was when the Conflict was loaded. */
export interface ConflictRow {
  readonly id: string;
  readonly vectorClock: VectorClock;
}

/** @internal What a resolve call writes as the new primary. */
export type Resolution =
  | { readonly kind: "version"; readonly rowId: string }
  | {
      readonly kind: "content";
      readonly content: Record<string, unknown>;
      readonly readers: unknown;
      readonly writers: unknown;
    }
  | { readonly kind: "delete" };

/** @internal How a Conflict resolves through its Database. */
export interface ConflictHost {
  resolve(primaryId: string, rows: readonly ConflictRow[], included: readonly string[], resolution: Resolution): WriteResult;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A document's concurrent versions, from Document.conflict. A snapshot of
 * every stored version, including ones this session can't read: if any
 * version is added, removed or changed before a resolve call, the call fails
 * with STALE_DOCUMENT and writes nothing. Resolving writes one new version
 * that supersedes every version in versions; versions this session can't read
 * stay in conflict. One resolve call per Conflict: after one succeeds, the
 * Conflict is spent.
 */
export class Conflict<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly primaryId: string;
  /** The versions this session can read: the primary first, then by rank. */
  readonly versions: readonly ConflictVersion<T>[];
  /**
   * The whole set of stored versions as loaded, including ones this session
   * can't read, as an opaque string like Document.version. Give it back to
   * Document.conflict as ifVersion to load the conflict only if the set is
   * unchanged.
   */
  readonly version: string;

  readonly #host: ConflictHost;
  readonly #rows: readonly ConflictRow[];
  // Row IDs of the versions in versions, in the same order.
  readonly #rowIds: readonly string[];
  #spent = false;

  /** @internal Conflicts come from Document.conflict. */
  constructor(
    host: ConflictHost,
    primaryId: string,
    rows: readonly ConflictRow[],
    versions: readonly { readonly rowId: string; readonly version: ConflictVersion<T> }[],
  ) {
    this.#host = host;
    this.primaryId = primaryId;
    this.#rows = Object.freeze(rows.map((row) => Object.freeze({ id: row.id, vectorClock: { ...row.vectorClock } })));
    this.#rowIds = Object.freeze(versions.map(({ rowId }) => rowId));
    this.versions = Object.freeze(versions.map(({ version }) => Object.freeze({ ...version })));
    this.version = conflictVersion(this.#rows);
  }

  /**
   * Makes this version the document. document must be the document of one of
   * versions, not a deleted one; otherwise TypeError. Its stored content,
   * readers and writers are used, not edits made to the object.
   * editedThroughConflict is true when versions this session can't read stay
   * in conflict, as for Document.save.
   */
  async resolveWith(document: Document<T>): Promise<WriteResult> {
    this.#checkUsable();
    const index = this.versions.findIndex((version) => version.document === document);
    const version = this.versions[index];
    if (version === undefined) {
      throw new TypeError("resolveWith takes the document of one of this conflict's versions");
    }
    if (version.deleted) {
      throw new TypeError("resolveWith can't take a deleted version; use resolveByDeleting");
    }
    return this.#resolve({ kind: "version", rowId: this.#rowIds[index] as string });
  }

  /**
   * Writes new content. readers and writers default to the stored document's,
   * and are checked as save checks them. Reports as resolveWith does.
   */
  async resolveWithContent(choice: { content: T; readers?: string[]; writers?: string[] }): Promise<WriteResult> {
    this.#checkUsable();
    if (!isPlainRecord(choice) || !isPlainRecord(choice.content)) {
      throw new TypeError("resolveWithContent takes { content, readers?, writers? } with content an object");
    }
    return this.#resolve({ kind: "content", content: choice.content, readers: choice.readers, writers: choice.writers });
  }

  /** Deletes the document, keeping its readers and writers. Reports as resolveWith does. */
  async resolveByDeleting(): Promise<WriteResult> {
    this.#checkUsable();
    return this.#resolve({ kind: "delete" });
  }

  #checkUsable(): void {
    if (this.#spent) {
      throw new TypeError("This conflict has already been resolved; call conflict() again");
    }
  }

  #resolve(resolution: Resolution): WriteResult {
    const result = this.#host.resolve(this.primaryId, this.#rows, this.#rowIds, resolution);
    this.#spent = true;
    return result;
  }
}
