import { ANONYMOUS, validatePrincipalName } from "./acl.js";
import { Database } from "./database.js";
import { validatePrincipalId } from "./principals.js";
import type { StorageAdapter } from "./storage/adapter.js";
import type { ReplicaTicket } from "./ticket.js";
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
   *
   * replicaOf, a ticket from Database.registerReplica (possibly made on
   * another machine), makes the empty adapter that new replica. The ticket is
   * checked in full first: INVALID_TICKET if it is malformed or doesn't hold
   * together, UPGRADE_REQUIRED if its database needs a later engine. The
   * adapter must be empty (INVALID_DATABASE), the session of the kind the
   * database's level needs, and an admin in the ticket's ACL (ACCESS_DENIED),
   * since filling the replica needs an admin. A refused open writes nothing.
   * Not with replicaName (TypeError): the name is given to registerReplica.
   *
   * The replica opened from a ticket is complete but holds no documents yet:
   * sync it with the replica that wrote the ticket (the ticket's
   * introducedBy) to fill it. Until that first sync has pulled everything,
   * it is behind, like any replica that hasn't synced; opened is not the
   * same as caught up. It knows only that one replica at first, so its first
   * sync must be with it. A ticket is single-use: treat it like a database
   * file (see Database.registerReplica).
   */
  async openDatabase(
    adapter: StorageAdapter,
    options: { now?: () => Date; replicaName?: string; replicaOf?: ReplicaTicket } = {},
  ): Promise<Database> {
    return Database.open(this, adapter, options.now ?? (() => new Date()), ENGINE_UNICODE_VERSION, options.replicaName, options.replicaOf);
  }
}
