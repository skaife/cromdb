// Restoring from a backup set. Every restored file is adopted: it becomes
// its database's replica again under a new instance ID, and the instance it
// was a backup of is retired in it. A restored copy never takes back the
// identity it was a backup of, so it can't be mistaken for the copy that
// went on without it.
//
// Two ways: a whole server into an empty data directory (the restore
// command, with the server stopped), and one database of a running server
// (Databases.restore), whose live file is kept aside first.

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Driver } from "@cromdb/driver";
import { Sessions } from "../auth/sessions.js";
import { dataPaths, restrict } from "../data-dir.js";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import { serverFile } from "../store/open.js";
import { ServerDb } from "../store/server-db.js";
import { readManifest, type Manifest, type ManifestFile } from "./sets.js";

/** A restore that can't be done, said for people. Nothing it would write is left behind. */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

const DATABASE_PATH = /^databases\/[A-Za-z0-9._-]+\.cromdb$/;

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Where a set's file goes in a data directory, from its path in the set. */
export function placeOf(dataDir: string, file: ManifestFile): string {
  const paths = dataPaths(dataDir);
  if (file.role === "server") return paths.serverDb;
  if (file.role === "directory") return paths.directory;
  return join(paths.databases, file.path.slice("databases/".length));
}

/**
 * The set's manifest, once each file it names is checked against it: there,
 * the same size, the same SHA-256. Only the files in only, when given. The
 * files themselves are only read.
 */
export async function checkSet(folder: string, only?: (file: ManifestFile) => boolean): Promise<Manifest> {
  const manifest = readManifest(folder);
  if (manifest === undefined) {
    throw new RestoreError(`${folder} isn't a backup set this server reads: it has no manifest.json of format 1`);
  }
  const roles = manifest.files.map((file) => file.role);
  if (roles.filter((role) => role === "server").length !== 1 || roles.filter((role) => role === "directory").length !== 1) {
    throw new RestoreError(`The set ${manifest.name} doesn't hold exactly one server database and one directory`);
  }
  for (const file of manifest.files) {
    const expected = file.role === "server" ? file.path === "server.cromdb" : file.role === "directory" ? file.path === "directory.cromdb" : DATABASE_PATH.test(file.path);
    if (!expected) {
      throw new RestoreError(`The set ${manifest.name} names a file at ${JSON.stringify(file.path)}, where none belongs`);
    }
  }
  for (const file of manifest.files.filter((entry) => only === undefined || only(entry))) {
    const path = join(folder, ...file.path.split("/"));
    if (!existsSync(path)) {
      throw new RestoreError(`The set ${manifest.name} is missing ${file.path}`);
    }
    if (statSync(path).size !== file.bytes || (await sha256(path)) !== file.sha256) {
      throw new RestoreError(`${file.path} in the set ${manifest.name} doesn't match its manifest: it was changed or damaged since the backup`);
    }
  }
  return manifest;
}

/** Copies a set's file to place, readable by its owner only. */
export function copyInto(folder: string, file: ManifestFile, place: string): void {
  copyFileSync(join(folder, ...file.path.split("/")), place);
  restrict(place, 0o600);
}

/**
 * Adopts the backup at place as cromdb-server: a new instance ID, the one
 * it was a backup of retired. Checks it is the backup the manifest says.
 * Leaves it open and returns the handle and its new instance ID.
 */
export async function adopt(driver: Driver, place: string, file: ManifestFile): Promise<{ handle: string; instanceId: string }> {
  const adopted = await driver.call("database.adopt", { storage: serverFile(place), principal: SERVER_PRINCIPAL });
  if (adopted.databaseId !== file.databaseId || adopted.retired !== file.instanceId) {
    await driver.call("database.close", { handle: adopted.handle });
    throw new RestoreError(`${file.path} holds a backup of database ${adopted.databaseId}, instance ${adopted.retired}, not what the manifest says`);
  }
  return { handle: adopted.handle, instanceId: adopted.instanceId };
}

export interface ServerRestore {
  readonly manifest: Manifest;
  /** By file path in the set: the instance ID the file now has. */
  readonly instances: Readonly<Record<string, string>>;
  readonly sessionsEnded: number;
}

/**
 * Checks the set, then puts it in dataDir, which must be empty or missing,
 * adopting every file; the server keeps its serverId and deploymentId, and
 * every session is ended, so everyone logs in again. Any failure removes
 * what was written, leaving dataDir as it was.
 */
export async function restoreServer(options: {
  readonly driver: Driver;
  readonly from: string;
  readonly dataDir: string;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}): Promise<ServerRestore> {
  const { driver, from, log } = options;
  const dataDir = resolve(options.dataDir);
  const existed = existsSync(dataDir);
  if (existed && readdirSync(dataDir).length > 0) {
    throw new RestoreError(`${dataDir} isn't empty. A server is restored into an empty data directory: empty it first, as the guide shows.`);
  }
  const manifest = await checkSet(from);
  const paths = dataPaths(dataDir);
  const handles: string[] = [];
  try {
    mkdirSync(paths.databases, { recursive: true });
    restrict(dataDir, 0o700);
    const instances: Record<string, string> = {};
    for (const file of manifest.files) {
      const place = placeOf(dataDir, file);
      copyInto(from, file, place);
      const { handle, instanceId } = await adopt(driver, place, file);
      handles.push(handle);
      instances[file.path] = instanceId;
    }
    for (const handle of handles.splice(0)) {
      await driver.call("database.close", { handle });
    }
    const serverDb = await ServerDb.open(driver, paths.serverDb, log);
    let ended: number;
    try {
      const { identity, settings } = serverDb;
      if (identity.serverId !== manifest.serverId || identity.deploymentId !== manifest.deploymentId) {
        throw new RestoreError(`server.cromdb in the set ${manifest.name} belongs to server ${identity.serverId}, not ${manifest.serverId} as its manifest says`);
      }
      const sessions = await Sessions.load({
        driver,
        handle: serverDb.handle,
        limits: { idleMinutes: settings.sessionIdleMinutes, maxDays: settings.sessionMaxDays },
        now: options.now,
        log,
      });
      ended = await sessions.endAll();
    } finally {
      await serverDb.close();
    }
    return { manifest, instances, sessionsEnded: ended };
  } catch (error) {
    for (const handle of handles) {
      await driver.call("database.close", { handle }).catch(() => undefined);
    }
    if (existed) {
      for (const entry of readdirSync(dataDir)) rmSync(join(dataDir, entry), { recursive: true, force: true });
    } else {
      rmSync(dataDir, { recursive: true, force: true });
    }
    throw error;
  }
}
