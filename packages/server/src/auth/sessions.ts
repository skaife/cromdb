// Sessions: one document each in the server database (type "session"),
// with a copy in memory so that checking a request needs no database read.
// The cookie's ID is never stored, only its hash.
//
// lastSeenAt changes on every request, and every write to a CromDB database
// is a new version and a change-log entry that stays until purge exists. So
// it is kept in memory and written at most once per FLUSH interval for each
// session that was used in it, and at shutdown. After a crash, the stored
// lastSeenAt is at most one interval old, so a session can end up to that
// much early, never late: the idle timeout is never extended.

import { DriverError, type DocumentData, type Driver, type JsonValue } from "@cromdb/driver";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import { isIsoTime } from "../text.js";
import { hashId, randomId } from "./secrets.js";

/** How often lastSeenAt is written, and expired sessions removed. */
export const SESSION_FLUSH_MS = 15 * 60_000;
const SERVER_ONLY = [SERVER_PRINCIPAL.id];
const PAGE = 1000;

export interface SessionLimits {
  readonly idleMinutes: number;
  readonly maxDays: number;
}

interface Entry {
  readonly idHash: string;
  readonly personId: string;
  readonly createdAt: number;
  lastSeenAt: number;
  persistedLastSeenAt: number;
  readonly documentId: string;
  version: string;
}

/** A live session, as a request sees it. */
export interface Session {
  readonly personId: string;
  readonly createdAt: Date;
}

function own(object: Readonly<Record<string, JsonValue>>, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export interface SessionsOptions {
  readonly driver: Driver;
  /** The server database's handle. */
  readonly handle: string;
  readonly limits: SessionLimits;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

export class Sessions {
  readonly #driver: Driver;
  readonly #handle: string;
  #limits: SessionLimits;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #byHash = new Map<string, Entry>();
  /** Writes happen one at a time, in order. */
  #queue: Promise<void> = Promise.resolve();

  private constructor(options: SessionsOptions) {
    this.#driver = options.driver;
    this.#handle = options.handle;
    this.#limits = options.limits;
    this.#now = options.now;
    this.#log = options.log;
  }

  get #on() {
    return { handle: this.#handle, principal: SERVER_PRINCIPAL };
  }

  /** Loads every stored session and removes the expired ones. */
  static async load(options: SessionsOptions): Promise<Sessions> {
    const sessions = new Sessions(options);
    let after: string | undefined;
    const documents: DocumentData[] = [];
    do {
      const page = await options.driver.call("documents.find", {
        ...sessions.#on,
        filter: { where: { type: "session" } },
        limit: PAGE,
        ...(after === undefined ? {} : { after }),
      });
      documents.push(...page.documents);
      after = page.next ?? undefined;
    } while (after !== undefined);
    for (const document of documents) {
      const entry = sessions.#read(document);
      if (entry === undefined) {
        options.log(`Session document ${document.id} is unreadable; it is ignored`);
      } else if (sessions.#byHash.has(entry.idHash)) {
        options.log(`Session document ${document.id} repeats another session; it is ignored`);
      } else {
        sessions.#byHash.set(entry.idHash, entry);
      }
    }
    await sessions.flush();
    return sessions;
  }

  #read(document: DocumentData): Entry | undefined {
    const idHash = own(document.content, "idHash");
    const personId = own(document.content, "personId");
    const createdAt = own(document.content, "createdAt");
    const lastSeenAt = own(document.content, "lastSeenAt");
    if (typeof idHash !== "string" || !/^[0-9a-f]{64}$/.test(idHash) || typeof personId !== "string" || !isIsoTime(createdAt) || !isIsoTime(lastSeenAt)) {
      return undefined;
    }
    const seen = Date.parse(lastSeenAt);
    return { idHash, personId, createdAt: Date.parse(createdAt), lastSeenAt: seen, persistedLastSeenAt: seen, documentId: document.id, version: document.version };
  }

  #expired(entry: Entry, now: number): boolean {
    return now >= entry.createdAt + this.#limits.maxDays * 86_400_000 || now >= entry.lastSeenAt + this.#limits.idleMinutes * 60_000;
  }

  /** New limits, from settings saved while the server runs: live sessions are judged by them from their next request. */
  setLimits(limits: SessionLimits): void {
    this.#limits = limits;
  }

  /** How long a new session's cookie should last, in seconds. */
  get maxAgeSeconds(): number {
    return this.#limits.maxDays * 86_400;
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** A new session for a person; returns the ID for the cookie. */
  async create(personId: string): Promise<string> {
    const id = randomId();
    const idHash = hashId(id);
    const now = this.#now();
    const at = now.toISOString();
    await this.#enqueue(async () => {
      const { document } = await this.#driver.call("documents.create", {
        ...this.#on,
        content: { type: "session", idHash, personId, createdAt: at, lastSeenAt: at },
        fieldTypes: { "/createdAt": "datetime", "/lastSeenAt": "datetime" },
        readers: SERVER_ONLY,
        writers: SERVER_ONLY,
      });
      this.#byHash.set(idHash, {
        idHash,
        personId,
        createdAt: now.getTime(),
        lastSeenAt: now.getTime(),
        persistedLastSeenAt: now.getTime(),
        documentId: document.id,
        version: document.version,
      });
    });
    return id;
  }

  /**
   * The live session for a cookie's ID, marked as used now; undefined when
   * there is none or it has expired. An expired session is removed.
   */
  use(id: string): Session | undefined {
    const entry = this.#byHash.get(hashId(id));
    if (entry === undefined) {
      return undefined;
    }
    const now = this.#now().getTime();
    if (this.#expired(entry, now)) {
      this.#remove([entry]).catch((error: unknown) => this.#log(`Removing an expired session failed: ${(error as Error).message}`));
      return undefined;
    }
    entry.lastSeenAt = Math.max(entry.lastSeenAt, now);
    return { personId: entry.personId, createdAt: new Date(entry.createdAt) };
  }

  /** Ends the session with this cookie ID, if there is one (logout). */
  async end(id: string): Promise<void> {
    const entry = this.#byHash.get(hashId(id));
    if (entry !== undefined) {
      await this.#remove([entry]);
    }
  }

  /** Ends every session of a person; returns how many. */
  async endFor(personId: string): Promise<number> {
    const entries = [...this.#byHash.values()].filter((entry) => entry.personId === personId);
    await this.#remove(entries);
    return entries.length;
  }

  /** The number of sessions held, expired or not. */
  get size(): number {
    return this.#byHash.size;
  }

  #remove(entries: readonly Entry[]): Promise<void> {
    for (const entry of entries) {
      this.#byHash.delete(entry.idHash);
    }
    return this.#enqueue(async () => {
      for (const entry of entries) {
        await this.#deleteDocument(entry);
      }
    });
  }

  async #deleteDocument(entry: Entry): Promise<void> {
    try {
      await this.#driver.call("documents.delete", { ...this.#on, id: entry.documentId, ifVersion: entry.version });
    } catch (error) {
      if (error instanceof DriverError && (error.code === "STALE_DOCUMENT" || error.code === "NOT_FOUND")) {
        // Changed or gone since it was read: delete what is there now.
        const { document } = await this.#driver.call("documents.get", { ...this.#on, id: entry.documentId });
        if (document !== null && !document.deleted) {
          await this.#driver.call("documents.delete", { ...this.#on, id: entry.documentId, ifVersion: document.version });
        }
        return;
      }
      throw error;
    }
  }

  /**
   * Writes lastSeenAt for every session used since it was last written, and
   * removes expired sessions. Runs every SESSION_FLUSH_MS and at shutdown.
   */
  flush(): Promise<void> {
    const now = this.#now().getTime();
    const expired = [...this.#byHash.values()].filter((entry) => this.#expired(entry, now));
    const removing = this.#remove(expired);
    const writing = this.#enqueue(async () => {
      for (const entry of [...this.#byHash.values()]) {
        if (entry.lastSeenAt === entry.persistedLastSeenAt || !this.#byHash.has(entry.idHash)) continue;
        const seen = entry.lastSeenAt;
        const { document } = await this.#driver.call("documents.save", {
          ...this.#on,
          id: entry.documentId,
          ifVersion: entry.version,
          content: {
            type: "session",
            idHash: entry.idHash,
            personId: entry.personId,
            createdAt: new Date(entry.createdAt).toISOString(),
            lastSeenAt: new Date(seen).toISOString(),
          },
          fieldTypes: { "/createdAt": "datetime", "/lastSeenAt": "datetime" },
          readers: SERVER_ONLY,
          writers: SERVER_ONLY,
        });
        entry.version = document.version;
        entry.persistedLastSeenAt = seen;
      }
    });
    return Promise.all([removing, writing]).then(() => undefined);
  }
}
