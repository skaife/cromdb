// The databases the server serves: the registry in the server database, and
// their open handles.

import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "@cromdb/driver";
import type { DataPaths } from "./data-dir.js";
import { SERVER_PRINCIPAL } from "./directory/directory.js";
import { openServerFile } from "./store/open.js";
import { serverFile, type DatabaseRecord, type ServerDb } from "./store/server-db.js";

export type DatabaseState =
  | { readonly record: DatabaseRecord; readonly status: "open"; readonly handle: string }
  | { readonly record: DatabaseRecord; readonly status: "unavailable"; readonly reason: string };

export type OpenDatabase = Extract<DatabaseState, { status: "open" }>;

export interface DatabasesOptions {
  readonly driver: Driver;
  readonly paths: DataPaths;
  /** Where the registry is kept. */
  readonly serverDb: ServerDb;
  readonly log: (message: string) => void;
}

export class Databases {
  readonly #driver: Driver;
  readonly #paths: DataPaths;
  readonly #serverDb: ServerDb;
  readonly #log: (message: string) => void;
  readonly #byId = new Map<string, DatabaseState>();

  private constructor(options: DatabasesOptions) {
    this.#driver = options.driver;
    this.#paths = options.paths;
    this.#serverDb = options.serverDb;
    this.#log = options.log;
  }

  /**
   * Opens every registered database, raising one an earlier server made at a
   * lower level (see openServerFile). One that fails (a missing file, a level
   * the driver neither serves nor raises, another database in the file) is logged and
   * marked unavailable; the others are served. Files in the databases folder
   * that no record names are logged, never opened, served or removed.
   * The directory is never in the registry, so it can't be served.
   */
  static async open(options: DatabasesOptions): Promise<Databases> {
    const databases = new Databases(options);
    const records = options.serverDb.databases();
    const { directoryDatabaseId } = options.serverDb.identity;
    for (const record of records) {
      databases.#byId.set(record.databaseId, await databases.#openOne(record, directoryDatabaseId));
    }
    const known = new Set(records.map((record) => record.file));
    let files: string[] = [];
    try {
      files = readdirSync(options.paths.databases);
    } catch (error) {
      options.log(`Can't list ${options.paths.databases}: ${(error as Error).message}`);
    }
    for (const file of files) {
      if (file.endsWith(".cromdb") && !known.has(file)) {
        options.log(`${join(options.paths.databases, file)} is not registered; it is not served`);
      }
    }
    return databases;
  }

  async #openOne(record: DatabaseRecord, directoryDatabaseId: string): Promise<DatabaseState> {
    const unavailable = (reason: string): DatabaseState => {
      this.#log(`Database ${record.databaseId} (${JSON.stringify(record.name)}) is unavailable: ${reason}`);
      return { record, status: "unavailable", reason };
    };
    if (record.databaseId === directoryDatabaseId) {
      return unavailable("it is the directory, which is never served");
    }
    if (record.file.includes("/") || record.file.includes("\\") || !record.file.endsWith(".cromdb")) {
      return unavailable(`its file name ${JSON.stringify(record.file)} is not a .cromdb file in the databases folder`);
    }
    let opened: { handle: string; databaseId: string };
    try {
      opened = await openServerFile(this.#driver, join(this.#paths.databases, record.file), `database ${JSON.stringify(record.name)}`, this.#log);
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    if (opened.databaseId !== record.databaseId) {
      await this.#driver.call("database.close", { handle: opened.handle });
      return unavailable(`its file holds database ${opened.databaseId}`);
    }
    return { record, status: "open", handle: opened.handle };
  }

  /**
   * Makes a new database, registers it and opens it. The person making it is
   * its first admin, creator, writer and reader; "cromdb-server" is an admin
   * too, for sync. The file is named by a new random ID, not the database's
   * ID, which isn't known until the database exists; the registry says which
   * file holds which database. If anything fails, the file is closed and
   * removed and nothing is registered. A crash between the steps can leave a
   * file no record names, which the next start logs and never serves.
   */
  async create(options: { name: string; personId: string; now: Date }): Promise<OpenDatabase> {
    const { personId } = options;
    const principal = { id: personId };
    const file = `${randomUUID()}.cromdb`;
    const path = join(this.#paths.databases, file);
    const opened = await this.#driver.call("database.create", { storage: serverFile(path), principal });
    try {
      const { acl } = await this.#driver.call("acl.get", { handle: opened.handle, principal });
      await this.#driver.call("acl.save", {
        handle: opened.handle,
        principal,
        ifVersion: acl.version,
        admins: [personId, SERVER_PRINCIPAL.id],
        creators: [personId],
        writers: [personId],
        readers: [personId],
        noAccess: [],
      });
      const record: DatabaseRecord = {
        databaseId: opened.databaseId,
        name: options.name,
        file,
        createdAt: options.now.toISOString(),
        createdBy: personId,
        home: this.#serverDb.identity.serverId,
      };
      await this.#serverDb.addDatabase(record);
      const state: OpenDatabase = { record, status: "open", handle: opened.handle };
      this.#byId.set(record.databaseId, state);
      this.#log(`Database ${record.databaseId} (${JSON.stringify(record.name)}) created by ${personId} in ${file}`);
      return state;
    } catch (error) {
      try {
        await this.#driver.call("database.close", { handle: opened.handle });
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          rmSync(path + suffix, { force: true });
        }
      } catch (cleanup) {
        this.#log(`Removing ${path} after a failed create failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
      }
      throw error;
    }
  }

  /** The driver every database is reached through. */
  get driver(): Driver {
    return this.#driver;
  }

  list(): DatabaseState[] {
    return [...this.#byId.values()];
  }

  get(databaseId: string): DatabaseState | undefined {
    return this.#byId.get(databaseId);
  }
}
