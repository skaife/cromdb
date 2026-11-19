// The server's data directory: /data in the container, --data outside it.

import { chmodSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DataPaths {
  readonly root: string;
  /** The server database: identity, settings, secrets, the database registry. */
  readonly serverDb: string;
  /** The directory of people. */
  readonly directory: string;
  /** One file per database the server serves, named <databaseId>.cromdb. */
  readonly databases: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const root = resolve(dataDir);
  return {
    root,
    serverDb: join(root, "server.cromdb"),
    directory: join(root, "directory.cromdb"),
    databases: join(root, "databases"),
  };
}

/**
 * Only the owner may read the data directory and the files that hold
 * secrets. Windows has no POSIX modes; there the directory's own access
 * control applies.
 */
export function restrict(path: string, mode: 0o700 | 0o600): void {
  if (process.platform !== "win32") {
    chmodSync(path, mode);
  }
}
