// Backup sets on disk: one folder per set in the backups folder, named by
// the time the run started (2026-11-26T03-00-12Z), holding manifest.json,
// server.cromdb, directory.cromdb and databases/<file> for each database. A
// run writes into <name>.partial and renames it once everything is in, so a
// folder without .partial is a finished set.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** The manifest's layout. A newer one is listed but not trusted. */
export const MANIFEST_FORMAT = 1;
export const MANIFEST_KIND = "cromdb-server-backup";
export const MANIFEST_FILE = "manifest.json";
export const PARTIAL = ".partial";

const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/;

export type Trigger = "scheduled" | "manual" | "command";

export interface ManifestFile {
  /** What the file is: the server database, the directory, or a database the server serves. */
  readonly role: "server" | "directory" | "database";
  /** Its path in the set, with forward slashes. */
  readonly path: string;
  readonly databaseId: string;
  /** The instance ID of the replica it is a backup of. */
  readonly instanceId: string;
  /** For a database: its name on this server. */
  readonly name?: string;
  /** For a database: its file name in the data directory's databases folder. */
  readonly file?: string;
  readonly bytes: number;
  /** SHA-256 of the file, hex. */
  readonly sha256: string;
}

export interface Manifest {
  readonly format: number;
  readonly kind: typeof MANIFEST_KIND;
  readonly name: string;
  readonly trigger: Trigger;
  readonly serverId: string;
  readonly deploymentId: string;
  readonly serverName: string;
  readonly versions: { readonly server: string; readonly driver: string; readonly engine: string };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly files: readonly ManifestFile[];
  /** Databases left out, and why. */
  readonly skipped: readonly { readonly databaseId: string; readonly name: string; readonly reason: string }[];
}

/** A finished set as listed. */
export interface BackupSet {
  readonly name: string;
  readonly trigger: Trigger;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Every file's size, added up. */
  readonly bytes: number;
  /** The databases the server serves that are in it (the server database and the directory not counted). */
  readonly databases: number;
  readonly skipped: Manifest["skipped"];
}

/** The folder name for a run that starts at this time. */
export function setName(at: Date): string {
  return `${at.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

/** A name no set or unfinished set in the folder has: the time, then -2, -3 and so on. */
export function freeName(folder: string, at: Date): string {
  const base = setName(at);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(folder, name)) && !existsSync(join(folder, name + PARTIAL))) {
      return name;
    }
  }
}

export function isSetName(name: string): boolean {
  return NAME.test(name);
}

/** The manifest of the set in folder, or undefined if it has none that this server reads. */
export function readManifest(folder: string): Manifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const manifest = value as Partial<Manifest>;
  if (manifest.kind !== MANIFEST_KIND || manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.files) || !Array.isArray(manifest.skipped)) {
    return undefined;
  }
  if (typeof manifest.name !== "string" || typeof manifest.startedAt !== "string" || typeof manifest.finishedAt !== "string") return undefined;
  return manifest as Manifest;
}

function summary(manifest: Manifest): BackupSet {
  return {
    name: manifest.name,
    trigger: manifest.trigger,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    databases: manifest.files.filter((file) => file.role === "database").length,
    skipped: manifest.skipped,
  };
}

/** The finished sets in the folder, oldest first. Folders that aren't sets are left out, never touched. */
export function listSets(folder: string): BackupSet[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const sets: BackupSet[] = [];
  for (const name of names.filter(isSetName).sort()) {
    const path = join(folder, name);
    if (!statSync(path).isDirectory()) continue;
    const manifest = readManifest(path);
    if (manifest !== undefined && manifest.name === name) sets.push(summary(manifest));
  }
  return sets;
}

/** The summary of the finished set with this name, or undefined. */
export function setSummary(folder: string, name: string): BackupSet | undefined {
  const manifest = readManifest(join(folder, name));
  return manifest === undefined ? undefined : summary(manifest);
}

/**
 * Removes the oldest finished sets beyond keep. Only folders listSets lists
 * are ever removed. Returns the names removed.
 */
export function prune(folder: string, keep: number): string[] {
  const sets = listSets(folder);
  const removed = sets.slice(0, Math.max(0, sets.length - keep)).map((set) => set.name);
  for (const name of removed) {
    rmSync(join(folder, name), { recursive: true, force: true });
  }
  return removed;
}

/** Removes sets a run never finished: what a crash or a stop mid-run left. Returns their names. */
export function removeUnfinished(folder: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const left = names.filter((name) => name.endsWith(PARTIAL) && isSetName(name.slice(0, -PARTIAL.length)));
  for (const name of left) {
    rmSync(join(folder, name), { recursive: true, force: true });
  }
  return left;
}
