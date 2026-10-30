import { canAccess } from "./acl.js";
import type { Conflict } from "./conflict-object.js";
import type { DocumentSet } from "./document-set.js";
import type { DocumentEnvelope } from "./envelope.js";
import { CromDBError } from "./errors.js";
import type { VectorClock } from "./vector-clock.js";
import { documentVersion } from "./version.js";

/** @internal How a Document writes through its Database. */
export interface DocumentHost {
  /** The session's principal, for myAccess. */
  readonly principal: string;
  save(
    id: string,
    loadedClock: VectorClock,
    content: Record<string, unknown>,
    readers: unknown,
    writers: unknown,
  ): { envelope: DocumentEnvelope; result: WriteResult };
  delete(id: string, loadedClock: VectorClock): { envelope: DocumentEnvelope; result: WriteResult };
  children<C extends Record<string, unknown>>(id: string): Promise<DocumentSet<C>>;
  conflict<C extends Record<string, unknown>>(primaryId: string, ifVersion: string | undefined): Conflict<C> | undefined;
}

/** What a save, a delete or a resolve reports. */
export interface WriteResult {
  /**
   * True when the document is still in conflict after this write: it has
   * conflict versions, from any replica, or its primary is unauthorized. The
   * write succeeded; the app should prompt the user to resolve the conflict.
   */
  readonly editedThroughConflict: boolean;
}

/** What this session's principal may do with a document. */
export interface DocumentAccess {
  /** Whether the principal is in the stored readers. False for a creator left out of readers. */
  readonly read: boolean;
  readonly update: boolean;
  /** The same as update, for now. */
  readonly delete: boolean;
}

/** Returned by Database.get and Database.create. */
export class Document<T extends Record<string, unknown>> {
  readonly id: string;
  readonly parentId: string;
  /** Decoded content. Edit it in place, then save. */
  content: T;
  readers: string[];
  writers: string[];

  readonly #host: DocumentHost;
  // The document this is a version of: its own id, or its conflictOf.
  readonly #primaryId: string;
  // Conflict versions, every version a Conflict lists, and a deleted primary in conflict.
  readonly #readOnly: boolean;
  // Whether the version this object holds is a deletion.
  readonly #versionDeleted: boolean;
  // As last loaded or saved, not as edited.
  #storedReaders: readonly string[];
  #storedWriters: readonly string[];
  #vectorClock: VectorClock;
  #deleted = false;
  #createdAt: string;
  #createdBy: string;
  #updatedAt: string;
  #updatedBy: string;
  #updatedOn: string;

  /** @internal Documents come from Database.get, Database.create and Conflict.versions. */
  constructor(host: DocumentHost, envelope: DocumentEnvelope, content: T, readOnly = false) {
    this.#host = host;
    this.id = envelope.id;
    this.parentId = envelope.parentId;
    this.#primaryId = envelope.conflictOf ?? envelope.id;
    this.#readOnly = readOnly;
    this.#versionDeleted = envelope.deleted;
    this.content = content;
    this.readers = [...envelope.readers];
    this.writers = [...envelope.writers];
    this.#storedReaders = [...envelope.readers];
    this.#storedWriters = [...envelope.writers];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#createdAt = envelope.createdAt;
    this.#createdBy = envelope.createdBy;
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }

  /**
   * Computed from the stored lists as last loaded or saved, not from edits
   * not yet saved. Returns a frozen snapshot. For UI decisions only: every
   * write is still checked when it happens. Async so it can later depend on
   * the database's ACL. update and delete need read and the principal in
   * writers, and are false for a read-only conflict version. All false once
   * this object has deleted the document.
   */
  async myAccess(): Promise<DocumentAccess> {
    if (this.#deleted) {
      return Object.freeze({ read: false, update: false, delete: false });
    }
    const read = canAccess(this.#host.principal, this.#storedReaders);
    const update = read && !this.#readOnly && canAccess(this.#host.principal, this.#storedWriters);
    return Object.freeze({ read, update, delete: update });
  }

  /** The clock this object was loaded or last saved with. Each read returns a copy. */
  get vectorClock(): VectorClock {
    return { ...this.#vectorClock };
  }

  /**
   * The version this object was loaded or last saved with, as an opaque
   * string: ASCII, safe in a URL and an HTTP header. The same version of a
   * document has the same string on every replica, and different versions
   * have different strings. Give it back to Database.get as ifVersion to load
   * the document only if it is still at this version.
   */
  get version(): string {
    return documentVersion(this.#vectorClock);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  get createdBy(): string {
    return this.#createdBy;
  }

  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  get updatedBy(): string {
    return this.#updatedBy;
  }

  get updatedOn(): string {
    return this.#updatedOn;
  }

  /**
   * Whether this object holds a deletion: a deleted primary still in
   * conflict, a deleted conflict version, or a document this object deleted.
   */
  get deleted(): boolean {
    return this.#versionDeleted || this.#deleted;
  }

  async save(): Promise<WriteResult> {
    this.#checkWritable();
    const { envelope, result } = this.#host.save(this.id, this.#vectorClock, this.content, this.readers, this.writers);
    this.#applyWrite(envelope);
    return result;
  }

  async delete(): Promise<WriteResult> {
    this.#checkWritable();
    const { envelope, result } = this.#host.delete(this.id, this.#vectorClock);
    this.#applyWrite(envelope);
    this.#deleted = true;
    return result;
  }

  /**
   * The document's concurrent versions, or undefined if it isn't in conflict.
   * Works on the document and on any of its conflict versions. A document is
   * in conflict when it has a stored conflict version, or when its own
   * version is unauthorized (written by someone not in its writers) and a
   * writer has yet to confirm it.
   *
   * With ifVersion, a Conflict.version from earlier: throws STALE_DOCUMENT if
   * the document's versions have changed since, including when it is no
   * longer in conflict.
   */
  async conflict(options: { ifVersion?: string } = {}): Promise<Conflict<T> | undefined> {
    const ifVersion = options.ifVersion;
    if (ifVersion !== undefined && typeof ifVersion !== "string") {
      throw new TypeError(`ifVersion must be a string, got ${typeof ifVersion}`);
    }
    return this.#host.conflict<T>(this.#primaryId, ifVersion);
  }

  /**
   * The same as Database.find({ parentId: id }). Works after this object has
   * deleted the document: its children still exist, as orphans. C defaults to
   * this document's content type.
   */
  async getChildren<C extends Record<string, unknown> = T>(): Promise<DocumentSet<C>> {
    return this.#host.children<C>(this.id);
  }

  #checkWritable(): void {
    if (this.#readOnly) {
      throw new CromDBError(
        "READ_ONLY",
        `Document ${JSON.stringify(this.id)} is a version in a conflict and is read-only; resolve the conflict through conflict()`,
      );
    }
  }

  #applyWrite(envelope: DocumentEnvelope): void {
    this.readers = [...envelope.readers];
    this.writers = [...envelope.writers];
    this.#storedReaders = [...envelope.readers];
    this.#storedWriters = [...envelope.writers];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#createdAt = envelope.createdAt;
    this.#createdBy = envelope.createdBy;
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }
}
