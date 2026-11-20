// The databases the server serves: the registry in the server database, and
// their open handles. Creating databases comes with the database API (S3c).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "@cromdb/driver";
import type { DataPaths } from "./data-dir.js";
import { serverFile, type DatabaseRecord } from "./store/server-db.js";

export type DatabaseState =
  | { readonly record: DatabaseRecord; readonly status: "open"; readonly handle: string }
  | { readonly record: DatabaseRecord; readonly status: "unavailable"; readonly reason: string };

export class Databases {
  readonly #driver: Driver;
  readonly #byId = new Map<string, DatabaseState>();

  private constructor(driver: Driver) {
    this.#driver = driver;
  }

  /**
   * Opens every registered database. One that fails (a missing file, a level
   * the driver doesn't serve, another database in the file) is logged and
   * marked unavailable; the others are served. Files in the databases folder
   * that no record names are logged, never opened, served or removed.
   * The directory is never in the registry, so it can't be served.
   */
  static async open(options: {
    driver: Driver;
    paths: DataPaths;
    records: readonly DatabaseRecord[];
    directoryDatabaseId: string;
    log: (message: string) => void;
  }): Promise<Databases> {
    const databases = new Databases(options.driver);
    for (const record of options.records) {
      databases.#byId.set(record.databaseId, await databases.#openOne(record, options.paths, options.directoryDatabaseId, options.log));
    }
    const known = new Set(options.records.map((record) => record.file));
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

  async #openOne(record: DatabaseRecord, paths: DataPaths, directoryDatabaseId: string, log: (message: string) => void): Promise<DatabaseState> {
    const unavailable = (reason: string): DatabaseState => {
      log(`Database ${record.databaseId} (${JSON.stringify(record.name)}) is unavailable: ${reason}`);
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
      opened = await this.#driver.call("database.open", { storage: serverFile(join(paths.databases, record.file)) });
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    if (opened.databaseId !== record.databaseId) {
      await this.#driver.call("database.close", { handle: opened.handle });
      return unavailable(`its file holds database ${opened.databaseId}`);
    }
    return { record, status: "open", handle: opened.handle };
  }

  list(): DatabaseState[] {
    return [...this.#byId.values()];
  }

  get(databaseId: string): DatabaseState | undefined {
    return this.#byId.get(databaseId);
  }
}
