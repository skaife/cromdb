import { ANONYMOUS, validatePrincipalName } from "./acl.js";
import { Database } from "./database.js";
import { validatePrincipalId } from "./principals.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { ENGINE_UNICODE_VERSION } from "./unicode/version.js";

/** How a session identifies its user. */
export type SessionKind = "id" | "named" | "anonymous";

export class Session {
  /** The ID as given, the NFKC form of the name, or "anonymous". */
  readonly principal: string;
  readonly kind: SessionKind;

  private constructor(principal: string, kind: SessionKind) {
    this.principal = principal;
    this.kind = kind;
  }

  /**
   * For a user identified by ID, as in every database this engine creates
   * (level 2). An ID is 1 to 512 characters from U+0021 to U+007E: ASCII
   * letters, digits and punctuation, no spaces. It is stored as given and
   * compared exactly, so "Alice" and "alice" are different users. Reserved:
   * "*", anything starting with "[", and "system" and "anonymous" in any
   * case. INVALID_PRINCIPAL otherwise.
   */
  static withId(id: string): Session {
    return new Session(validatePrincipalId(id), "id");
  }

  /**
   * For a user identified by name, in a database made by 0.3.0 or earlier
   * (level 1). Names are compared without case after NFKC. Every character
   * must be assigned in this engine's Unicode version. A named session can't
   * create a database.
   */
  static named(principal: string): Session {
    return new Session(validatePrincipalName(principal, ENGINE_UNICODE_VERSION), "named");
  }

  /** For an app with no logged-in user. Opens a database at any level. */
  static anonymous(): Session {
    return new Session(ANONYMOUS, "anonymous");
  }

  /**
   * Opens the database in the adapter, initializing it on first open. The
   * adapter belongs to the caller; the Database doesn't close it.
   *
   * Only a session with an ID can create a database, at level 2. An existing
   * database at level 1 opens with a named or anonymous session, and one at
   * level 2 with an ID or anonymous session; another kind of session is
   * refused with INVALID_PRINCIPAL. An empty adapter opened anonymously is
   * refused with ACCESS_DENIED.
   *
   * replicaName names the first replica of a new database, with the rules of
   * Database.createReplica's name. It is only for the open that creates the
   * database: if the adapter already holds one, TypeError.
   */
  async openDatabase(adapter: StorageAdapter, options: { now?: () => Date; replicaName?: string } = {}): Promise<Database> {
    return Database.open(this, adapter, options.now ?? (() => new Date()), ENGINE_UNICODE_VERSION, options.replicaName);
  }
}
