import { randomUUID } from "node:crypto";
import { DriverError, type Opened, type Principal, type Storage } from "@cromdb/driver";
import { Session, describeDatabase, type Database, type DatabaseDescription, type ReplicaTicket, type SqliteAdapter } from "cromdb";
import { openExisting, openForCreate, storageKey } from "./storage.js";

/** The one database level this driver serves. */
export const LEVEL = 4;

/** The levels database.raise takes a database from. */
export const RAISES_FROM: readonly number[] = [3];

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
  /** Resolves whenever inFlight drops to 0. */
  drained: (() => void) | undefined;
  /** While a compact runs or waits to run: settles when it is done. New calls wait for it. */
  compacting: Promise<void> | undefined;
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
  readonly #now: () => Date;
  readonly #entries = new Map<string, Entry>();
  /** Storage keys in use, including ones still being opened. */
  readonly #keys = new Set<string>();

  constructor(now: () => Date) {
    this.#now = now;
  }

  #openAs(principal: Principal, adapter: SqliteAdapter, options: { replicaName?: string; replicaOf?: ReplicaTicket; adopt?: boolean } = {}): Promise<Database> {
    return Session.withId(principal.id).openDatabase(adapter, { ...options, now: this.#now });
  }

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
      compacting: undefined,
    };
    this.#entries.set(entry.handle, entry);
    return { handle: entry.handle, databaseId: described.databaseId, instanceId: described.instanceId, level: described.level };
  }

  async create(storage: Storage, principal: Principal, options: { replicaName?: string; replicaOf?: ReplicaTicket }): Promise<Opened> {
    // Checked before the storage is touched.
    Session.withId(principal.id);
    const key = this.#reserve(storage);
    try {
      const { adapter, discard } = openForCreate(storage);
      let db: Database;
      try {
        db = await this.#openAs(principal, adapter, options);
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
    return this.#openExisting(storage, async (adapter, described) => {
      if (described.level !== LEVEL) {
        throw refuseLevel(described.level);
      }
      return this.#register(adapter, this.#keyOf(storage), described);
    });
  }

  /**
   * As open, but a database at a level in RAISES_FROM is first raised to
   * LEVEL as principal, who must be an admin of it. The storage stays open
   * throughout, so an exclusive lock is never let go. Any refusal closes it
   * again, still at its level: the engine raises in one transaction. A
   * principal the database doesn't admit writes nothing; one it admits
   * opens it first, and the engine then records its own highest level in
   * this replica's registration, as it does on any first open by a newer
   * engine.
   */
  async raise(storage: Storage, principal: Principal): Promise<Opened & { raisedFrom: number }> {
    Session.withId(principal.id);
    return this.#openExisting(storage, async (adapter, described) => {
      const raisedFrom = described.level;
      if (raisedFrom === LEVEL) {
        return { ...this.#register(adapter, this.#keyOf(storage), described), raisedFrom };
      }
      if (!RAISES_FROM.includes(raisedFrom)) {
        throw refuseLevel(raisedFrom);
      }
      const db = await this.#openAs(principal, adapter);
      const level = await db.raiseLevel();
      if (level !== LEVEL) {
        throw new DriverError("INTERNAL", `The engine raised the database to level ${level}, not ${LEVEL}`);
      }
      return { ...this.#register(adapter, this.#keyOf(storage), { ...described, level }, { principal, db }), raisedFrom };
    });
  }

  /**
   * Opens a backup as a new replica, as principal, who must be an admin of
   * it: a new instance ID, and the replica it was a backup of retired. The
   * engine refuses storage that isn't a backup, writing nothing.
   */
  async adopt(storage: Storage, principal: Principal): Promise<Opened & { retired: string }> {
    Session.withId(principal.id);
    return this.#openExisting(storage, async (adapter, described) => {
      if (described.level !== LEVEL) {
        throw refuseLevel(described.level);
      }
      const db = await this.#openAs(principal, adapter, { adopt: true });
      const opened = this.#register(adapter, this.#keyOf(storage), { databaseId: db.databaseId, instanceId: db.instanceId, level: db.level }, { principal, db });
      return { ...opened, retired: described.instanceId };
    });
  }

  /**
   * Backs up the handle's database into target, as principal, who must be an
   * admin. target is opened only for this and closed again; a refused backup
   * removes the file it made.
   */
  async backup(handle: string, principal: Principal, target: Storage): Promise<void> {
    if (target.kind === "memory") {
      throw new DriverError("NOT_SUPPORTED", "A backup into memory would be lost as soon as it was made; back up into a file");
    }
    await this.use(handle, principal, async (db) => {
      const key = this.#reserve(target);
      try {
        const { adapter, discard } = openForCreate(target);
        try {
          await db.backup(adapter);
        } catch (error) {
          discard();
          throw error;
        }
        adapter.close();
      } finally {
        if (key !== undefined) {
          this.#keys.delete(key);
        }
      }
    });
  }

  /** Recovers into the handle's database from another copy, as principal. from is opened only for this, read, and closed again. */
  async recover(handle: string, principal: Principal, from: Storage): Promise<{ suspects: number; known: number; seen: number }> {
    return this.use(handle, principal, async (db) => {
      const key = this.#reserve(from);
      try {
        const old = openExisting(from);
        try {
          const { suspects, known, seen } = await db.recover(old);
          return { suspects, known, seen };
        } finally {
          old.close();
        }
      } finally {
        if (key !== undefined) {
          this.#keys.delete(key);
        }
      }
    });
  }

  /** The storage's size and free space. */
  space(handle: string): { totalBytes: number; freeBytes: number } {
    const entry = this.#entry(handle);
    if (entry.adapter.spaceUsage === undefined) {
      throw new DriverError("INTERNAL", "This storage can't report its space");
    }
    const { totalBytes, freeBytes } = entry.adapter.spaceUsage();
    return { totalBytes, freeBytes };
  }

  #keyOf(storage: Storage): string | undefined {
    return storageKey(storage);
  }

  /** Reserves the storage, opens it and reads its description, then hands both to use; closes it again if use throws. */
  async #openExisting<T>(storage: Storage, use: (adapter: SqliteAdapter, described: DatabaseDescription) => Promise<T>): Promise<T> {
    const key = this.#reserve(storage);
    try {
      const adapter = openExisting(storage);
      try {
        const described = describeDatabase(adapter);
        if (described === undefined) {
          throw new DriverError("NO_DATABASE", "There is no database in this storage");
        }
        return await use(adapter, described);
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
    const db = await this.#openAs(principal, entry.adapter);
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
    let entry = this.#entry(handle);
    while (entry.compacting !== undefined) {
      // A compact that failed is the compact caller's error, not this call's.
      await entry.compacting.catch(() => undefined);
      entry = this.#entry(handle);
    }
    entry.inFlight++;
    try {
      const db = await this.#session(entry, principal);
      return await fn(db);
    } finally {
      entry.inFlight--;
      if (entry.inFlight === 0) {
        entry.drained?.();
      }
    }
  }

  /** Resolves once no call is running on the entry. */
  async #drain(entry: Entry): Promise<void> {
    while (entry.inFlight > 0) {
      await new Promise<void>((resolve) => {
        entry.drained = resolve;
      });
    }
    entry.drained = undefined;
  }

  /**
   * Gives the storage back the space removed rows left. New calls on the
   * handle wait; those running finish first, so no transaction is open when
   * the storage compacts. A compact asked for while one waits or runs joins
   * it. Other handles carry on.
   */
  compact(handle: string): Promise<void> {
    // Not async, so every caller gets the very same promise to wait on.
    let entry: Entry;
    try {
      entry = this.#entry(handle);
    } catch (error) {
      return Promise.reject(error);
    }
    if (entry.compacting !== undefined) {
      return entry.compacting;
    }
    const run = (async () => {
      await this.#drain(entry);
      try {
        if (entry.adapter.compact === undefined) {
          throw new DriverError("INTERNAL", "This storage can't compact");
        }
        entry.adapter.compact();
      } finally {
        entry.compacting = undefined;
      }
    })();
    entry.compacting = run;
    return run;
  }

  /** Stops new calls on the handle, waits for those running and any compact, then closes the storage. */
  async close(handle: string): Promise<void> {
    const entry = this.#entry(handle);
    entry.closing = true;
    if (entry.compacting !== undefined) {
      await entry.compacting.catch(() => undefined);
    }
    await this.#drain(entry);
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
