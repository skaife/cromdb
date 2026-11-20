// The server database: a CromDB database (server.cromdb) that holds the
// server's identity, settings, secrets and the registry of the databases it
// serves. Reached only through the driver, as "cromdb-server", and never
// synced with anything.
//
// One document per kind ("identity", "settings", "secrets"), and one per
// registered database. The identity document is written last by setup, so a
// server database without one is a setup that didn't finish.

import { DriverError, type DocumentData, type Driver, type JsonObject, type JsonValue, type Storage } from "@cromdb/driver";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import { readSettings, settingsContent, type SecretKey, type Settings } from "../settings.js";
import { isIsoTime } from "../text.js";

/** The layout of the server database's documents. A newer one is refused. */
export const SERVER_DB_FORMAT = 1;
const SERVER_ONLY = [SERVER_PRINCIPAL.id];

export interface Identity {
  /** This server, unique to it. */
  readonly serverId: string;
  /** The deployment the server belongs to; servers that join it (S5) share it. */
  readonly deploymentId: string;
  readonly createdAt: string;
  /** The directory's CromDB databaseId. */
  readonly directoryDatabaseId: string;
}

export interface DatabaseRecord {
  readonly databaseId: string;
  readonly name: string;
  /** The file name under the data directory's databases folder. */
  readonly file: string;
  readonly createdAt: string;
  readonly createdBy: string;
  /** The serverId of the database's home server. */
  readonly home: string;
}

/** A refusal to show at the console: setup missing or unfinished, a damaged or newer server database. */
export class ServerDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerDbError";
  }
}

/**
 * Storage for a database file the server opens. Every one is exclusive:
 * locked from open to close against every other connection and program. The
 * server database is opened first by setup, config, admin and start alike,
 * so its lock keeps two servers, or a command and a running server, from
 * using one data directory at once.
 */
export function serverFile(path: string): Storage {
  return { kind: "sqlite", path, exclusive: true };
}

/** What a second opener of a data directory is told. */
export const IN_USE = "The server is running, or another command is using this data directory. Stop it first.";

/** Refuses a driver that can't lock database files: the server relies on the lock. */
async function requireLocking(driver: Driver): Promise<void> {
  const info = await driver.call("driver.info", {});
  if (!(info.storageOptions.sqlite ?? []).includes("exclusive")) {
    throw new ServerDbError(`The driver ${info.driver.name} ${info.driver.version} can't lock database files, which the server needs.`);
  }
}

/** Runs an open of the server database, telling a locked file apart. */
async function opening<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (error) {
    if (error instanceof DriverError && error.code === "STORAGE_LOCKED") {
      throw new ServerDbError(IN_USE);
    }
    throw error;
  }
}

type Kind = "identity" | "settings" | "secrets" | "database";

interface Stored {
  readonly id: string;
  version: string;
  content: JsonObject;
}

function get(object: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function readIdentity(content: JsonObject): Identity | undefined {
  const values = {
    serverId: get(content, "serverId"),
    deploymentId: get(content, "deploymentId"),
    createdAt: get(content, "createdAt"),
    directoryDatabaseId: get(content, "directoryDatabaseId"),
  };
  return typeof values.serverId === "string" &&
    typeof values.deploymentId === "string" &&
    isIsoTime(values.createdAt) &&
    typeof values.directoryDatabaseId === "string"
    ? (values as Identity)
    : undefined;
}

function readDatabase(content: JsonObject): DatabaseRecord | undefined {
  const keys = ["databaseId", "name", "file", "createdBy", "home"] as const;
  const createdAt = get(content, "createdAt");
  if (!keys.every((key) => typeof get(content, key) === "string") || !isIsoTime(createdAt)) {
    return undefined;
  }
  return Object.fromEntries([...keys.map((key) => [key, get(content, key)]), ["createdAt", createdAt]]) as unknown as DatabaseRecord;
}

export class ServerDb {
  readonly #driver: Driver;
  readonly handle: string;
  readonly #single = new Map<Exclude<Kind, "database">, Stored>();
  readonly #databases = new Map<string, { stored: Stored; record: DatabaseRecord }>();
  #settings: Settings | undefined;

  private constructor(driver: Driver, handle: string) {
    this.#driver = driver;
    this.handle = handle;
  }

  get #on() {
    return { handle: this.handle, principal: SERVER_PRINCIPAL };
  }

  /**
   * Makes a new server database at path, with its settings and secrets. The
   * identity is written by writeIdentity once everything else exists.
   */
  static async create(driver: Driver, path: string, settings: Settings, secrets: Readonly<Record<SecretKey, string>>): Promise<ServerDb> {
    await requireLocking(driver);
    const { handle } = await opening(() => driver.call("database.create", { storage: serverFile(path), principal: SERVER_PRINCIPAL }));
    const db = new ServerDb(driver, handle);
    await db.#create("settings", settingsContent(settings));
    await db.#create("secrets", { values: { ...secrets } });
    db.#settings = settings;
    return db;
  }

  /** Opens the server database at path and reads it. */
  static async open(driver: Driver, path: string): Promise<ServerDb> {
    await requireLocking(driver);
    let handle: string;
    try {
      ({ handle } = await opening(() => driver.call("database.open", { storage: serverFile(path) })));
    } catch (error) {
      if (error instanceof DriverError && error.code === "NO_DATABASE") {
        throw new ServerDbError(`There is no server database at ${path}. Run "cromdb-server setup" first.`);
      }
      throw error;
    }
    const db = new ServerDb(driver, handle);
    try {
      await db.#load();
    } catch (error) {
      await driver.call("database.close", { handle });
      throw error;
    }
    return db;
  }

  async #load(): Promise<void> {
    let after: string | undefined;
    const documents: DocumentData[] = [];
    do {
      const page = await this.#driver.call("documents.find", { ...this.#on, limit: 1000, ...(after === undefined ? {} : { after }) });
      documents.push(...page.documents);
      after = page.next ?? undefined;
    } while (after !== undefined);
    for (const document of documents) {
      const kind = get(document.content, "type");
      const stored: Stored = { id: document.id, version: document.version, content: document.content };
      if (kind === "database") {
        const record = readDatabase(document.content);
        if (record === undefined || this.#databases.has(record.databaseId)) {
          throw new ServerDbError(`The server database is damaged: database record ${document.id} is unreadable or repeated`);
        }
        this.#databases.set(record.databaseId, { stored, record });
      } else if (kind === "identity" || kind === "settings" || kind === "secrets") {
        if (this.#single.has(kind)) {
          throw new ServerDbError(`The server database is damaged: it has more than one ${kind} document`);
        }
        this.#single.set(kind, stored);
      }
    }
    const identity = this.#single.get("identity");
    if (identity === undefined) {
      throw new ServerDbError("Setup didn't finish: the server database has no identity. Remove the data directory and run setup again.");
    }
    const format = get(identity.content, "format");
    if (typeof format !== "number" || format > SERVER_DB_FORMAT) {
      throw new ServerDbError(`The server database has format ${JSON.stringify(format)}; this server reads format ${SERVER_DB_FORMAT}. Use a newer server.`);
    }
    if (readIdentity(identity.content) === undefined) {
      throw new ServerDbError("The server database is damaged: its identity is unreadable");
    }
    const settings = readSettings(this.#require("settings").content);
    if (!settings.ok) {
      throw new ServerDbError(settings.problem);
    }
    this.#settings = settings.value;
    this.#require("secrets");
  }

  #require(kind: Exclude<Kind, "database">): Stored {
    const stored = this.#single.get(kind);
    if (stored === undefined) {
      throw new ServerDbError(`The server database is damaged: it has no ${kind} document`);
    }
    return stored;
  }

  async #create(kind: Kind, fields: JsonObject, fieldTypes: Record<string, "datetime"> = {}): Promise<Stored> {
    const content: JsonObject = { type: kind, ...fields };
    const { document } = await this.#driver.call("documents.create", {
      ...this.#on,
      content,
      fieldTypes,
      readers: SERVER_ONLY,
      writers: SERVER_ONLY,
    });
    const stored: Stored = { id: document.id, version: document.version, content: document.content };
    if (kind !== "database") this.#single.set(kind, stored);
    return stored;
  }

  async #save(stored: Stored, fields: JsonObject, fieldTypes: Record<string, "datetime"> = {}): Promise<void> {
    const content: JsonObject = { type: get(stored.content, "type") ?? null, ...fields };
    const { document } = await this.#driver.call("documents.save", {
      ...this.#on,
      id: stored.id,
      ifVersion: stored.version,
      content,
      fieldTypes,
      readers: SERVER_ONLY,
      writers: SERVER_ONLY,
    });
    stored.version = document.version;
    stored.content = document.content;
  }

  /** Writes the identity, which marks setup as finished. */
  async writeIdentity(identity: Identity): Promise<void> {
    if (this.#single.has("identity")) {
      throw new ServerDbError("The server database already has an identity");
    }
    await this.#create("identity", { format: SERVER_DB_FORMAT, ...identity }, { "/createdAt": "datetime" });
  }

  get identity(): Identity {
    const identity = readIdentity(this.#require("identity").content);
    if (identity === undefined) {
      throw new ServerDbError("The server database has no readable identity");
    }
    return identity;
  }

  get settings(): Settings {
    if (this.#settings === undefined) {
      throw new ServerDbError("The server database has no settings");
    }
    return this.#settings;
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.#save(this.#require("settings"), settingsContent(settings));
    this.#settings = settings;
  }

  /** A secret, or undefined if it isn't set. */
  secret(key: SecretKey): string | undefined {
    const values = get(this.#require("secrets").content, "values");
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      return undefined;
    }
    const value = get(values, key);
    return typeof value === "string" ? value : undefined;
  }

  async setSecret(key: SecretKey, value: string): Promise<void> {
    const stored = this.#require("secrets");
    const values = get(stored.content, "values");
    const current = typeof values === "object" && values !== null && !Array.isArray(values) ? values : {};
    await this.#save(stored, { values: { ...current, [key]: value } });
  }

  databases(): DatabaseRecord[] {
    return [...this.#databases.values()].map(({ record }) => record);
  }

  async addDatabase(record: DatabaseRecord): Promise<void> {
    if (this.#databases.has(record.databaseId)) {
      throw new ServerDbError(`Database ${record.databaseId} is already registered`);
    }
    const stored = await this.#create("database", { ...record }, { "/createdAt": "datetime" });
    this.#databases.set(record.databaseId, { stored, record });
  }

  async close(): Promise<void> {
    await this.#driver.call("database.close", { handle: this.handle });
  }
}
