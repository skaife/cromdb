import { canAccess } from "./acl.js";
import type { DocumentSet } from "./document-set.js";
import type { DocumentEnvelope } from "./envelope.js";
import type { VectorClock } from "./vector-clock.js";

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
  ): DocumentEnvelope;
  delete(id: string, loadedClock: VectorClock): DocumentEnvelope;
  children<C extends Record<string, unknown>>(id: string): Promise<DocumentSet<C>>;
}

/** What this session's principal may do with a document. */
export interface DocumentAccess {
  /** Always true: you hold the document. */
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
  // As last loaded or saved, not as edited.
  #storedWriters: readonly string[];
  #vectorClock: VectorClock;
  #deleted = false;
  #createdAt: string;
  #createdBy: string;
  #updatedAt: string;
  #updatedBy: string;
  #updatedOn: string;

  /** @internal Documents come from Database.get and Database.create. */
  constructor(host: DocumentHost, envelope: DocumentEnvelope, content: T) {
    this.#host = host;
    this.id = envelope.id;
    this.parentId = envelope.parentId;
    this.content = content;
    this.readers = [...envelope.readers];
    this.writers = [...envelope.writers];
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
   * the database's ACL. All false once this object has deleted the document.
   */
  async myAccess(): Promise<DocumentAccess> {
    if (this.#deleted) {
      return Object.freeze({ read: false, update: false, delete: false });
    }
    const update = canAccess(this.#host.principal, this.#storedWriters);
    return Object.freeze({ read: true, update, delete: update });
  }

  /** The clock this object was loaded or last saved with. Each read returns a copy. */
  get vectorClock(): VectorClock {
    return { ...this.#vectorClock };
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

  async save(): Promise<void> {
    this.#applyWrite(this.#host.save(this.id, this.#vectorClock, this.content, this.readers, this.writers));
  }

  async delete(): Promise<void> {
    this.#applyWrite(this.#host.delete(this.id, this.#vectorClock));
    this.#deleted = true;
  }

  /**
   * The same as Database.find({ parentId: id }). Works after this object has
   * deleted the document: its children still exist, as orphans. C defaults to
   * this document's content type.
   */
  async getChildren<C extends Record<string, unknown> = T>(): Promise<DocumentSet<C>> {
    return this.#host.children<C>(this.id);
  }

  #applyWrite(envelope: DocumentEnvelope): void {
    this.readers = [...envelope.readers];
    this.writers = [...envelope.writers];
    this.#storedWriters = [...envelope.writers];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#createdAt = envelope.createdAt;
    this.#createdBy = envelope.createdBy;
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }
}
