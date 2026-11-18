import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DriverError, type Storage } from "@cromdb/driver";
import { SqliteAdapter } from "cromdb";

export const STORAGE_KINDS = ["sqlite", "memory"] as const;

/**
 * What identifies the storage among open handles: the absolute path of a
 * file, or undefined for memory, which is new each time. Two spellings of one
 * file (a symbolic link, or other case on a case-insensitive file system)
 * aren't recognized as the same.
 */
export function storageKey(storage: Storage): string | undefined {
  return storage.kind === "sqlite" ? resolve(storage.path) : undefined;
}

function describe(storage: Storage): string {
  return storage.kind === "sqlite" ? `the file ${JSON.stringify(storage.path)}` : "memory";
}

/**
 * Storage for a new database. ALREADY_EXISTS if it holds anything. discard
 * closes it and, if this call made the file, removes it again.
 */
export function openForCreate(storage: Storage): { adapter: SqliteAdapter; discard(): void } {
  const path = storage.kind === "sqlite" ? storage.path : ":memory:";
  const existed = storage.kind === "sqlite" && existsSync(path);
  const adapter = SqliteAdapter.open(path);
  const discard = () => {
    adapter.close();
    if (storage.kind === "sqlite" && !existed) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(path + suffix, { force: true });
      }
    }
  };
  if (!adapter.isEmpty()) {
    adapter.close();
    throw new DriverError("ALREADY_EXISTS", `There is already something stored in ${describe(storage)}`);
  }
  return { adapter, discard };
}

/** Storage that holds a database. NO_DATABASE if it is missing or empty; a missing file is never created. */
export function openExisting(storage: Storage): SqliteAdapter {
  if (storage.kind === "memory" || !existsSync(storage.path)) {
    throw new DriverError("NO_DATABASE", `There is no database in ${describe(storage)}`);
  }
  const adapter = SqliteAdapter.open(storage.path);
  if (adapter.isEmpty()) {
    adapter.close();
    throw new DriverError("NO_DATABASE", `There is no database in ${describe(storage)}`);
  }
  return adapter;
}
