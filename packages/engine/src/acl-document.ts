import type { AccessLists } from "./access.js";
import type { DocumentEnvelope } from "./envelope.js";
import type { AclDocContent } from "./system-docs.js";
import type { VectorClock } from "./vector-clock.js";
import { documentVersion } from "./version.js";

/** @internal What an ACL write returns: the stored envelope and the lists in it. */
export interface AclWrite {
  readonly envelope: DocumentEnvelope;
  readonly acl: AclDocContent;
}

/** @internal How an Acl writes through its Database. */
export interface AclHost {
  /** The database's level, for version strings. */
  readonly level: number;
  save(loadedClock: VectorClock, lists: { readonly [type in keyof AccessLists]: unknown }): AclWrite;
}

/**
 * The database's access control list: a list of principals for each access
 * type (see ACCESS_TYPES). Returned by Database.getAcl, to admins only. Edit
 * the lists in place, then save.
 *
 * The lists are independent: being in one gives nothing another gives. The
 * database's lists set the most anyone may do, and each document's own
 * readers and writers can only narrow it, so "*" in a document means every
 * signed-in user the database admits. noAccess overrides every other list.
 * Anyone in any list but noAccess may open the database.
 *
 * In a database below level 3, readers and writers read as ["anonymous"]
 * and noAccess as [], which is how such a database behaves: everyone may
 * open it, and the documents' own lists decide. save refuses a change to
 * them there with NOT_SUPPORTED.
 */
export class Acl {
  /**
   * Who may read and edit this list, make replicas and sync. At least one
   * user, and at least one outside noAccess: an ID, or a name in a level-1
   * database. Being an admin doesn't let you read or write documents; that
   * takes readers or writers.
   */
  admins: string[];
  /** Who may create documents. May be empty. */
  creators: string[];
  /**
   * Who may edit documents, as far as each document's own writers allow.
   * Editing a document also needs reading it. May be empty.
   */
  writers: string[];
  /** Who may read documents, as far as each document's own readers allow. May be empty. */
  readers: string[];
  /**
   * Who may do nothing at all, whatever the other lists say: they can't
   * even open the database. User IDs only, not "*" or "anonymous". An admin
   * can't add themselves; another admin can lock them out.
   */
  noAccess: string[];

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
    this.admins = [...loaded.acl.admins];
    this.creators = [...loaded.acl.creators];
    this.writers = [...loaded.acl.writers];
    this.readers = [...loaded.acl.readers];
    this.noAccess = [...loaded.acl.noAccess];
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

  /**
   * The version this object was loaded or last saved with, as an opaque
   * string like Document.version: the same on every replica for the same
   * ACL. Give it back to Database.getAcl as ifVersion to load the ACL only if
   * it is still at this version.
   */
  get version(): string {
    return documentVersion(this.#vectorClock, this.#host.level);
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

  /**
   * Writes every list at once. Refused with STALE_DOCUMENT if the ACL was
   * saved since this object was loaded, ACCESS_DENIED unless you are an
   * admin outside noAccess (in the stored ACL), or if the new lists would
   * take you out of admins or put you in noAccess, and INVALID_ACCESS_LIST
   * for a malformed list or if no admin would be left outside noAccess.
   */
  async save(): Promise<void> {
    const { envelope, acl } = this.#host.save(this.#vectorClock, {
      admins: this.admins,
      creators: this.creators,
      writers: this.writers,
      readers: this.readers,
      noAccess: this.noAccess,
    });
    this.admins = [...acl.admins];
    this.creators = [...acl.creators];
    this.writers = [...acl.writers];
    this.readers = [...acl.readers];
    this.noAccess = [...acl.noAccess];
    this.#vectorClock = { ...envelope.vectorClock };
    this.#createdAt = envelope.createdAt;
    this.#createdBy = envelope.createdBy;
    this.#updatedAt = envelope.updatedAt;
    this.#updatedBy = envelope.updatedBy;
    this.#updatedOn = envelope.updatedOn;
  }
}
