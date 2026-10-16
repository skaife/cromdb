import type { DocumentEnvelope } from "./envelope.js";
import type { VectorClock } from "./vector-clock.js";

/** @internal How a Document writes through its Database. */
export interface DocumentHost {
  save(
    id: string,
    loadedClock: VectorClock,
    content: Record<string, unknown>,
    readers: unknown,
    writers: unknown,
  ): DocumentEnvelope;
  delete(id: string, loadedClock: VectorClock): DocumentEnvelope;
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
  #vectorClock: VectorClock;
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
    this.#vectorClock = { ...envelope.vectorClock };
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }

  /** The clock this object was loaded or last saved with. Each read returns a copy. */
  get vectorClock(): VectorClock {
    return { ...this.#vectorClock };
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
  }

  #applyWrite(envelope: DocumentEnvelope): void {
    this.readers = [...envelope.readers];
    this.writers = [...envelope.writers];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }
}
