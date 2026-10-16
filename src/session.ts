import { ANONYMOUS, validatePrincipalName } from "./acl.js";
import { Database } from "./database.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { ENGINE_UNICODE_VERSION } from "./unicode/version.js";

export class Session {
  /** The NFKC form of the name, as written. */
  readonly principal: string;

  private constructor(principal: string) {
    this.principal = principal;
  }

  /** Every character must be assigned in this engine's Unicode version. */
  static named(principal: string): Session {
    return new Session(validatePrincipalName(principal, ENGINE_UNICODE_VERSION));
  }

  /** For an app with no logged-in user. */
  static anonymous(): Session {
    return new Session(ANONYMOUS);
  }

  /**
   * Opens the database in the adapter, initializing it on first open. The
   * adapter belongs to the caller; the Database doesn't close it.
   */
  async openDatabase(adapter: StorageAdapter, options: { now?: () => Date } = {}): Promise<Database> {
    return Database.open(this, adapter, options.now ?? (() => new Date()), ENGINE_UNICODE_VERSION);
  }
}
