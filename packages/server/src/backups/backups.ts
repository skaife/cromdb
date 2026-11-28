// Backups of a running server: a set holds an engine backup of the server
// database, the directory and every database the server serves, made one
// after the other while no database is created, so the registry backed up
// names exactly the files backed up. Each file is consistent on its own; the
// set as a whole isn't one moment, which the databases, being independent,
// don't need. Runs as "cromdb-server", an admin of every file.
//
// A backup holds everything the data directory does, the client secret
// included, unencrypted: the files and set folders are readable by the
// server's own user only, and the guide says to keep sets as safe as the
// data.

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Driver } from "@cromdb/driver";
import { restrict } from "../data-dir.js";
import type { Databases } from "../databases.js";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import type { BackupRecord, ServerDb } from "../store/server-db.js";
import {
  freeName,
  isSetName,
  listSets,
  readManifest,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  MANIFEST_KIND,
  PARTIAL,
  prune,
  removeUnfinished,
  setSummary,
  type BackupSet,
  type Manifest,
  type ManifestFile,
  type Trigger,
} from "./sets.js";

/** Room kept free beyond what the files are expected to take. */
export const SPACE_MARGIN_BYTES = 16 * 1024 * 1024;
/** How much more than the databases' used space a set is allowed to take. */
export const SPACE_FACTOR = 1.1;

/** Asked for a backup when the server has no backups folder. */
export class BackupsOffError extends Error {
  constructor() {
    super("Backups are off: the server has no backups folder. Start it with --backups DIR, or set CROMDB_BACKUPS.");
    this.name = "BackupsOffError";
  }
}

/** A backup run that couldn't be made, said for people. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

/** The files won't fit in the backups folder, found before anything is written. */
export class BackupNoSpaceError extends BackupError {
  constructor(message: string) {
    super(message);
    this.name = "BackupNoSpaceError";
  }
}

/** A run under way: what started it, when, and the set it is writing. */
export interface RunningBackup {
  readonly trigger: Trigger;
  readonly startedAt: string;
  readonly name: string;
}

export interface Space {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/** The size and free space of the file system that holds path, or undefined if it can't be read. */
export function fileSystemSpace(path: string): Space | undefined {
  try {
    const stats = statfsSync(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return undefined;
  }
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export interface BackupsOptions {
  readonly driver: Driver;
  readonly serverDb: ServerDb;
  /** The directory's open handle. */
  readonly directoryHandle: string;
  readonly databases: Databases;
  /** The backups folder, or undefined: backups are off. */
  readonly folder: string | undefined;
  /** How many finished sets to keep, read at each run. */
  readonly keep: () => number;
  readonly versions: { readonly server: string; readonly driver: string; readonly engine: string };
  readonly serverName: () => string;
  /** How the free space of a folder's file system is read; fileSystemSpace by default. */
  readonly fileSystemSpace?: (path: string) => Space | undefined;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

interface Target {
  readonly role: ManifestFile["role"];
  readonly handle: string;
  readonly databaseId: string;
  readonly path: string;
  readonly what: string;
  readonly name?: string;
  readonly file?: string;
}

export class Backups {
  readonly #options: BackupsOptions;
  #running: Promise<BackupSet> | undefined;
  #current: RunningBackup | undefined;

  constructor(options: BackupsOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#options.folder !== undefined;
  }

  get folder(): string | undefined {
    return this.#options.folder;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /** The run under way, or undefined. */
  get current(): RunningBackup | undefined {
    return this.#running === undefined ? undefined : this.#current;
  }

  get keep(): number {
    return this.#options.keep();
  }

  /** Resolves once no run is going. */
  async settled(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** The last run, or undefined before the first. */
  get last(): BackupRecord | undefined {
    return this.#options.serverDb.lastBackup;
  }

  /** The finished sets in the backups folder, oldest first. */
  list(): BackupSet[] {
    return this.#options.folder === undefined ? [] : listSets(this.#options.folder);
  }

  /** The folder of the finished set with this name, and its manifest, or undefined if there is none. */
  set(name: string): { folder: string; manifest: Manifest } | undefined {
    const { folder } = this.#options;
    if (folder === undefined || !isSetName(name)) return undefined;
    const path = join(folder, name);
    const manifest = readManifest(path);
    return manifest === undefined || manifest.name !== name ? undefined : { folder: path, manifest };
  }

  /** The backups folder's file system: its size and free space. */
  space(): Space | undefined {
    return this.#options.folder === undefined ? undefined : this.#space(this.#options.folder);
  }

  #space(path: string): Space | undefined {
    return (this.#options.fileSystemSpace ?? fileSystemSpace)(path);
  }

  /**
   * Makes a set now, or joins the run already going, and resolves when it
   * is finished. Rejects with BackupsOffError, BackupNoSpaceError, or
   * BackupError when it couldn't be made; a failed run leaves no files
   * behind and, unless it was the backup command, is recorded as the last
   * run.
   */
  run(trigger: Trigger): Promise<BackupSet> {
    this.#running ??= this.#run(trigger).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /**
   * Starts a run, or joins the one going, and resolves as soon as it is
   * under way, with what it is. Refuses before starting with
   * BackupsOffError, or BackupNoSpaceError when the files won't fit. What
   * goes wrong after the start is only in the run's record (last).
   */
  async start(trigger: Trigger): Promise<RunningBackup> {
    const going = this.current;
    if (going !== undefined) {
      return going;
    }
    const { folder } = this.#options;
    if (folder === undefined) {
      throw new BackupsOffError();
    }
    mkdirSync(folder, { recursive: true });
    await this.#checkSpace(this.#targets().targets, folder);
    // Another start may have begun meanwhile: join it.
    const started = this.current;
    if (started !== undefined) {
      return started;
    }
    this.run(trigger).catch(() => undefined);
    const current = this.current;
    if (current === undefined) {
      throw new BackupError("The backup run didn't start");
    }
    return current;
  }

  /** Keeps the run's result in server.cromdb, except for the backup command, which writes nothing to the data. */
  async #record(record: BackupRecord): Promise<void> {
    if (record.trigger === "command") {
      return;
    }
    try {
      await this.#options.serverDb.saveLastBackup(record);
    } catch (error) {
      this.#options.log(`Recording the backup run failed: ${message(error)}`);
    }
  }

  async #run(trigger: Trigger): Promise<BackupSet> {
    const { folder, databases, serverDb, now, log } = this.#options;
    if (folder === undefined) {
      throw new BackupsOffError();
    }
    const began = Date.now();
    let partial: string | undefined;
    // Everything up to the first await runs as soon as run is called, so
    // start can say at once which set the run is writing.
    try {
      mkdirSync(folder, { recursive: true });
      for (const left of removeUnfinished(folder)) {
        log(`Removed ${join(folder, left)}, a backup that didn't finish`);
      }
      const startedAt = now();
      const name = freeName(folder, startedAt);
      this.#current = { trigger, startedAt: startedAt.toISOString(), name };
      const unfinished = join(folder, name + PARTIAL);
      partial = unfinished;
      mkdirSync(join(unfinished, "databases"), { recursive: true });
      restrict(unfinished, 0o700);
      restrict(join(unfinished, "databases"), 0o700);
      const { files, skipped } = await databases.whileUnchanged(() => this.#backUp(unfinished));
      const { identity } = serverDb;
      const manifest: Manifest = {
        format: MANIFEST_FORMAT,
        kind: MANIFEST_KIND,
        name,
        trigger,
        serverId: identity.serverId,
        deploymentId: identity.deploymentId,
        serverName: this.#options.serverName(),
        versions: this.#options.versions,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        files,
        skipped,
      };
      const manifestPath = join(unfinished, MANIFEST_FILE);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      restrict(manifestPath, 0o600);
      renameSync(unfinished, join(folder, name));
      partial = undefined;
      const set = setSummary(folder, name);
      if (set === undefined) {
        throw new BackupError(`The set ${name} was written but its manifest can't be read back`);
      }
      log(
        `Backed up to ${join(folder, name)}: ${set.databases} databases, ${megabytes(set.bytes)}, ${skipped.length} left out, ${((Date.now() - began) / 1000).toFixed(1)} s`,
      );
      if (trigger !== "command") {
        for (const removed of prune(folder, this.#options.keep())) {
          log(`Removed the backup ${removed}: only the newest ${this.#options.keep()} are kept (backupKeep)`);
        }
      }
      await this.#record({ at: now().toISOString(), ok: true, trigger, name, bytes: set.bytes, skipped: skipped.length });
      return set;
    } catch (error) {
      if (partial !== undefined) {
        rmSync(partial, { recursive: true, force: true });
      }
      log(`The backup failed: ${message(error)}`);
      await this.#record({ at: now().toISOString(), ok: false, trigger, error: message(error) });
      throw error instanceof BackupError ? error : new BackupError(message(error));
    }
  }

  /** Every file the server holds, in order: the server database, the directory, then each database. */
  #targets(): { targets: Target[]; skipped: Manifest["skipped"][number][] } {
    const { serverDb, directoryHandle, databases } = this.#options;
    const targets: Target[] = [
      { role: "server", handle: serverDb.handle, databaseId: serverDb.databaseId, path: "server.cromdb", what: "the server database" },
      { role: "directory", handle: directoryHandle, databaseId: serverDb.identity.directoryDatabaseId, path: "directory.cromdb", what: "the directory" },
    ];
    const skipped: Manifest["skipped"][number][] = [];
    for (const state of databases.list()) {
      const { databaseId, name, file } = state.record;
      if (state.status === "open") {
        targets.push({ role: "database", handle: state.handle, databaseId, path: `databases/${file}`, what: `database ${JSON.stringify(name)}`, name, file });
      } else {
        skipped.push({ databaseId, name, reason: `It is unavailable: ${state.reason}` });
      }
    }
    return { targets, skipped };
  }

  async #backUp(into: string): Promise<{ files: ManifestFile[]; skipped: Manifest["skipped"][number][] }> {
    const { driver, folder, log } = this.#options;
    const { targets, skipped } = this.#targets();
    await this.#checkSpace(targets, folder as string);
    const files: ManifestFile[] = [];
    for (const target of targets) {
      const path = join(into, ...target.path.split("/"));
      try {
        await driver.call("database.backup", { handle: target.handle, principal: SERVER_PRINCIPAL, target: { kind: "sqlite", path } });
      } catch (error) {
        if (target.role !== "database") {
          throw new BackupError(`Backing up ${target.what} failed: ${message(error)}`);
        }
        log(`Backing up ${target.what} (${target.databaseId}) failed, so the set leaves it out: ${message(error)}`);
        skipped.push({ databaseId: target.databaseId, name: target.name ?? target.what, reason: message(error) });
        continue;
      }
      restrict(path, 0o600);
      const { instanceId } = await driver.call("database.info", { handle: target.handle });
      files.push({
        role: target.role,
        path: target.path,
        databaseId: target.databaseId,
        instanceId,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.file === undefined ? {} : { file: target.file }),
        bytes: statSync(path).size,
        sha256: await sha256(path),
      });
    }
    return { files, skipped };
  }

  /** Refuses the run before anything is written when the files won't fit, with room to spare. */
  async #checkSpace(targets: readonly Target[], folder: string): Promise<void> {
    const { driver } = this.#options;
    const info = await driver.call("driver.info", {});
    const free = this.#space(folder);
    if (!info.capabilities.includes("space") || free === undefined) {
      return;
    }
    let used = 0;
    for (const target of targets) {
      const { totalBytes, freeBytes } = await driver.call("database.space", { handle: target.handle });
      used += totalBytes - freeBytes;
    }
    const needed = used * SPACE_FACTOR + SPACE_MARGIN_BYTES;
    if (free.freeBytes < needed) {
      throw new BackupNoSpaceError(`Not enough free space in ${folder}: the backup needs about ${megabytes(needed)}, and ${megabytes(free.freeBytes)} is free`);
    }
  }
}
