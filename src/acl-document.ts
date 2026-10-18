import type { DocumentEnvelope } from "./envelope.js";
import type { AclDocContent } from "./system-docs.js";
import type { VectorClock } from "./vector-clock.js";

/** @internal What an ACL write returns: the stored envelope and the lists in it. */
export interface AclWrite {
  readonly envelope: DocumentEnvelope;
  readonly acl: AclDocContent;
}

/** @internal How an Acl writes through its Database. */
export interface AclHost {
  save(loadedClock: VectorClock, creators: unknown, admins: unknown): AclWrite;
}

/** The database's access control list. Returned by Database.getAcl, to admins only. */
export class Acl {
  /** Who may create documents. May be empty. */
  creators: string[];
  /** Who may read and edit this list. At least one named principal. */
  admins: string[];

  readonly #host: AclHost;
  #vectorClock: VectorClock;
  #createdAt: string;
  #createdBy: string;
  #updatedAt: string;
  #updatedBy: string;
  #updatedOn: string;

  /** @internal Acl objects come from Database.getAcl. */
  constructor(host: AclHost, loaded: AclWrite) {
    this.#host = host;
    this.creators = [...loaded.acl.creators];
    this.admins = [...loaded.acl.admins];
    this.#vectorClock = { ...loaded.envelope.vectorClock };
    this.#createdAt = loaded.envelope.createdAt;
    this.#createdBy = loaded.envelope.createdBy;
    this.#updatedAt = loaded.envelope.updatedAt;
    this.#updatedBy = loaded.envelope.updatedBy;
    this.#updatedOn = loaded.envelope.updatedOn;
  }

  /** The clock this object was loaded or last saved with. Each read returns a copy. */
  get vectorClock(): VectorClock {
    return { ...this.#vectorClock };
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  /** "system": the engine wrote the ACL when it initialized the database. */
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
    const { envelope, acl } = this.#host.save(this.#vectorClock, this.creators, this.admins);
    this.creators = [...acl.creators];
    this.admins = [...acl.admins];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#createdAt = envelope.createdAt;
    this.#createdBy = envelope.createdBy;
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }
}
