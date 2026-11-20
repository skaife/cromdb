import { randomUUID } from "node:crypto";
import { DriverError, type Opened, type Principal, type Storage } from "@cromdb/driver";
import { Session, describeDatabase, type Database, type DatabaseDescription, type ReplicaTicket, type SqliteAdapter } from "cromdb";
import { openExisting, openForCreate, storageKey } from "./storage.js";

/** The one database level this driver serves. */
export const LEVEL = 4;

/** How many principals' Database objects each handle keeps open. */
const SESSION_CACHE = 256;

interface Entry {
  readonly handle: string;
  readonly adapter: SqliteAdapter;
  readonly key: string | undefined;
  /** Principal ID to its Database, least recently used first. */
  readonly sessions: Map<string, Database>;
  inFlight: number;
  closing: boolean;
  drained: (() => void) | undefined;
}

export function refuseLevel(level: number): DriverError {
  return new DriverError("NOT_SUPPORTED", `This driver serves level ${LEVEL} databases, not level ${level}`, { level });
}

/**
 * The open databases. Each handle is one adapter, shared by one Database per
 * principal: each reads stored state on every call, so they see each other's
 * writes at once (the engine's pattern since 0.2.0).
 */
export class Handles {
  readonly #entries = new Map<string, Entry>();
  /** Storage keys in use, including ones still being opened. */
  readonly #keys = new Set<string>();

  #reserve(storage: Storage): string | undefined {
    const key = storageKey(storage);
    if (key !== undefined) {
      if (this.#keys.has(key)) {
        throw new DriverError("ALREADY_OPEN", `${JSON.stringify(key)} is already open`);
      }
      this.#keys.add(key);
    }
    return key;
  }

  #register(adapter: SqliteAdapter, key: string | undefined, described: DatabaseDescription, opened?: { principal: Principal; db: Database }): Opened {
    const entry: Entry = {
      handle: randomUUID(),
      adapter,
      key,
      sessions: new Map(opened === undefined ? [] : [[opened.principal.id, opened.db]]),
      inFlight: 0,
      closing: false,
      drained: undefined,
    };
    this.#entries.set(entry.handle, entry);
    return { handle: entry.handle, databaseId: described.databaseId, instanceId: described.instanceId, level: described.level };
  }

  async create(storage: Storage, principal: Principal, options: { replicaName?: string; replicaOf?: ReplicaTicket }): Promise<Opened> {
    // Checked before the storage is touched.
    const session = Session.withId(principal.id);
    const key = this.#reserve(storage);
    try {
      const { adapter, discard } = openForCreate(storage);
      let db: Database;
      try {
        db = await session.openDatabase(adapter, options);
      } catch (error) {
        discard();
        throw error;
      }
      return this.#register(adapter, key, { databaseId: db.databaseId, instanceId: db.instanceId, level: db.level }, { principal, db });
    } catch (error) {
      if (key !== undefined) {
        this.#keys.delete(key);
      }
      throw error;
    }
  }

  /**
   * Reads the database's level without opening it as anyone, since no
   * principal is known yet; a level this driver doesn't serve is refused and
   * the storage closed again, with nothing written.
   */
  async open(storage: Storage): Promise<Opened> {
    const key = this.#reserve(storage);
    try {
      const adapter = openExisting(storage);
      try {
        const described = describeDatabase(adapter);
        if (described === undefined) {
          throw new DriverError("NO_DATABASE", "There is no database in this storage");
        }
        if (described.level !== LEVEL) {
          throw refuseLevel(described.level);
        }
        return this.#register(adapter, key, described);
      } catch (error) {
        adapter.close();
        throw error;
      }
    } catch (error) {
      if (key !== undefined) {
        this.#keys.delete(key);
      }
      throw error;
    }
  }

  #entry(handle: string): Entry {
    const entry = this.#entries.get(handle);
    if (entry === undefined || entry.closing) {
      throw new DriverError("UNKNOWN_HANDLE", `No open database has the handle ${JSON.stringify(handle)}`);
    }
    return entry;
  }

  async #session(entry: Entry, principal: Principal): Promise<Database> {
    const cached = entry.sessions.get(principal.id);
    if (cached !== undefined) {
      entry.sessions.delete(principal.id);
      entry.sessions.set(principal.id, cached);
      return cached;
    }
    const db = await Session.withId(principal.id).openDatabase(entry.adapter);
    entry.sessions.set(principal.id, db);
    if (entry.sessions.size > SESSION_CACHE) {
      const [oldest] = entry.sessions.keys();
      if (oldest !== undefined) {
        entry.sessions.delete(oldest);
      }
    }
    return db;
  }

  /** The database's IDs and level, read fresh. */
  describe(handle: string): DatabaseDescription {
    const described = describeDatabase(this.#entry(handle).adapter);
    if (described === undefined) {
      throw new DriverError("NO_DATABASE", "There is no database in this storage");
    }
    return described;
  }

  /**
   * Runs fn with the principal's Database on this handle; database.close
   * waits for it. Opening it is refused with the engine's ACCESS_DENIED if
   * the database doesn't admit the principal.
   */
  async use<T>(handle: string, principal: Principal, fn: (db: Database) => Promise<T>): Promise<T> {
    const entry = this.#entry(handle);
    entry.inFlight++;
    try {
      const db = await this.#session(entry, principal);
      return await fn(db);
    } finally {
      entry.inFlight--;
      if (entry.closing && entry.inFlight === 0) {
        entry.drained?.();
      }
    }
  }

  /** Stops new calls on the handle, waits for those running, then closes the storage. */
  async close(handle: string): Promise<void> {
    const entry = this.#entry(handle);
    entry.closing = true;
    if (entry.inFlight > 0) {
      await new Promise<void>((resolve) => {
        entry.drained = resolve;
      });
    }
    entry.sessions.clear();
    this.#entries.delete(handle);
    if (entry.key !== undefined) {
      this.#keys.delete(entry.key);
    }
    entry.adapter.close();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((handle) => this.close(handle)));
  }
}
