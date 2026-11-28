// The databases the server serves: the registry in the server database, and
// their open handles.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Driver } from "@cromdb/driver";
import { adopt, checkSet, copyInto, RestoreError } from "./backups/restore.js";
import type { DataPaths } from "./data-dir.js";
import { SERVER_PRINCIPAL } from "./directory/directory.js";
import { openServerFile } from "./store/open.js";
import { serverFile, type DatabaseRecord, type ServerDb } from "./store/server-db.js";

export type DatabaseState =
  | { readonly record: DatabaseRecord; readonly status: "open"; readonly handle: string }
  | { readonly record: DatabaseRecord; readonly status: "unavailable"; readonly reason: string };

export type OpenDatabase = Extract<DatabaseState, { status: "open" }>;

/** How long a database file replaced by a restore is kept, in its databases/replaced folder. */
export const REPLACED_KEEP_DAYS = 30;
const REPLACED_NAME = /^(.+\.cromdb)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/;

/** What restoring one database did. */
export interface DatabaseRestore {
  readonly state: OpenDatabase;
  /** Where the file it replaced was kept, relative to the data directory, if there was one. */
  readonly replaced: string | undefined;
  /** The restored copy's new instance ID. */
  readonly instanceId: string;
  /** The instance ID retired in it: the replica it was a backup of. */
  readonly retired: string;
  /** Whether the database wasn't in the registry, and was added to it. */
  readonly registered: boolean;
}

export interface DatabasesOptions {
  readonly driver: Driver;
  readonly paths: DataPaths;
  /** Where the registry is kept. */
  readonly serverDb: ServerDb;
  readonly log: (message: string) => void;
  /** false: a database file an older server made is left unavailable, not raised (see openServerFile). */
  readonly raise?: boolean;
}

export class Databases {
  readonly #driver: Driver;
  readonly #paths: DataPaths;
  readonly #serverDb: ServerDb;
  readonly #log: (message: string) => void;
  readonly #raise: boolean;
  readonly #byId = new Map<string, DatabaseState>();
  /** The databases a restore holds now: from the start of its turn to its end. */
  readonly #restoring = new Set<string>();
  /** Settles when the last create or backup run queued has ended. */
  #turns: Promise<unknown> = Promise.resolve();

  private constructor(options: DatabasesOptions) {
    this.#driver = options.driver;
    this.#paths = options.paths;
    this.#serverDb = options.serverDb;
    this.#log = options.log;
    this.#raise = options.raise ?? true;
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
      opened = await openServerFile(this.#driver, join(this.#paths.databases, record.file), `database ${JSON.stringify(record.name)}`, this.#log, { raise: this.#raise });
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
   * It waits while a backup runs (see whileUnchanged).
   */
  create(options: { name: string; personId: string; now: Date }): Promise<OpenDatabase> {
    return this.#inTurn(() => this.#create(options));
  }

  /**
   * Runs work while no database is created: creates asked for meanwhile
   * wait for it, and it waits for those already under way. A backup run
   * uses it, so the registry it backs up names exactly the files it backs
   * up.
   */
  whileUnchanged<T>(work: () => Promise<T>): Promise<T> {
    return this.#inTurn(work);
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#turns.then(work, work);
    this.#turns = run.catch(() => undefined);
    return run;
  }

  async #create(options: { name: string; personId: string; now: Date }): Promise<OpenDatabase> {
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

  /** Renames an open database in the registry, on this server only. */
  async rename(databaseId: string, name: string): Promise<OpenDatabase> {
    const state = this.#byId.get(databaseId);
    if (state === undefined || state.status !== "open") {
      throw new Error(`Database ${databaseId} is not open`);
    }
    const record = await this.#serverDb.renameDatabase(databaseId, name);
    const renamed: OpenDatabase = { ...state, record };
    this.#byId.set(databaseId, renamed);
    this.#log(`Database ${databaseId} renamed from ${JSON.stringify(state.record.name)} to ${JSON.stringify(name)}`);
    return renamed;
  }

  /**
   * Puts one database back from a backup set, on the running server: the
   * set's copy of it is checked against the manifest, the live file is
   * closed and kept aside in databases/replaced (for REPLACED_KEEP_DAYS),
   * and the copy is adopted in its place, with a new instance ID, and
   * opened. A database the registry no longer names is registered again,
   * under its name in the set. If anything fails, the live file is put
   * back as it was. Waits while a backup or a create runs.
   */
  restore(options: { readonly from: string; readonly databaseId: string; readonly by: string; readonly now: Date }): Promise<DatabaseRestore> {
    return this.#inTurn(async () => {
      this.#restoring.add(options.databaseId);
      try {
        return await this.#restore(options);
      } finally {
        this.#restoring.delete(options.databaseId);
      }
    });
  }

  async #restore(options: { readonly from: string; readonly databaseId: string; readonly by: string; readonly now: Date }): Promise<DatabaseRestore> {
    const { databaseId } = options;
    const isIt = (file: { role: string; databaseId: string }) => file.role === "database" && file.databaseId === databaseId;
    const manifest = await checkSet(options.from, isIt);
    const file = manifest.files.find(isIt);
    if (file === undefined) {
      throw new RestoreError(`The set ${manifest.name} doesn't hold database ${databaseId}`);
    }
    const before = this.#byId.get(databaseId);
    const setFile = file.file ?? file.path.slice("databases/".length);
    const fileName = before?.record.file ?? (existsSync(join(this.#paths.databases, setFile)) ? `${randomUUID()}.cromdb` : setFile);
    const live = join(this.#paths.databases, fileName);
    if (before?.status === "open") {
      await this.#driver.call("database.close", { handle: before.handle });
    }
    let replaced: string | undefined;
    if (existsSync(live)) {
      const folder = join(this.#paths.databases, "replaced");
      mkdirSync(folder, { recursive: true });
      replaced = join(folder, `${fileName}.${options.now.toISOString().slice(0, 19).replaceAll(":", "-")}Z`);
      renameSync(live, replaced);
    }
    let adopted: { handle: string; instanceId: string } | undefined;
    try {
      copyInto(options.from, file, live);
      adopted = await adopt(this.#driver, live, file);
      let record = before?.record;
      if (record === undefined) {
        record = {
          databaseId,
          name: file.name ?? databaseId,
          file: fileName,
          createdAt: options.now.toISOString(),
          createdBy: options.by,
          home: this.#serverDb.identity.serverId,
        };
        await this.#serverDb.addDatabase(record);
      }
      const state: OpenDatabase = { record, status: "open", handle: adopted.handle };
      this.#byId.set(databaseId, state);
      const kept = replaced === undefined ? undefined : `databases/replaced/${replaced.slice(join(this.#paths.databases, "replaced").length + 1)}`;
      this.#log(
        `Database ${databaseId} (${JSON.stringify(record.name)}) restored by ${options.by} from the backup ${manifest.name}: instance ${adopted.instanceId}, ${file.instanceId} retired${kept === undefined ? "" : `; the file it replaced is kept as ${kept}`}`,
      );
      return { state, replaced: kept, instanceId: adopted.instanceId, retired: file.instanceId, registered: before === undefined };
    } catch (error) {
      if (adopted !== undefined) {
        await this.#driver.call("database.close", { handle: adopted.handle }).catch(() => undefined);
      }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(live + suffix, { force: true });
      }
      if (replaced !== undefined) {
        renameSync(replaced, live);
      }
      if (before !== undefined) {
        this.#byId.set(databaseId, await this.#openOne(before.record, this.#serverDb.identity.directoryDatabaseId));
      }
      throw error;
    }
  }

  /**
   * Whether a request on the database, given the handle it used, met a
   * restore: one holds the database now, or put a new copy in place since
   * the request found it.
   */
  restoring(databaseId: string, handle?: string): boolean {
    if (this.#restoring.has(databaseId)) return true;
    const state = this.#byId.get(databaseId);
    return handle !== undefined && state?.status === "open" && state.handle !== handle;
  }

  /** Removes the files restores replaced that are older than REPLACED_KEEP_DAYS. Returns their names. */
  pruneReplaced(now: Date): string[] {
    const folder = join(this.#paths.databases, "replaced");
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      const match = REPLACED_NAME.exec(name);
      const stamp = match?.[2];
      if (stamp === undefined) continue;
      const at = Date.parse(`${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}Z`);
      if (now.getTime() - at >= REPLACED_KEEP_DAYS * 86_400_000) {
        rmSync(join(folder, name), { force: true });
        removed.push(name);
        this.#log(`Removed databases/replaced/${name}: a file a restore replaced, kept ${REPLACED_KEEP_DAYS} days`);
      }
    }
    return removed;
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
