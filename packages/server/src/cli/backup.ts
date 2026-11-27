// cromdb-server backup: backs up a stopped server, as Back up now does a
// running one. It takes the data directory's lock, so it refuses while the
// server runs; then the running server's own Back up now is the way.
//
// A backup never changes the data: nothing is raised (a file an older server
// made is refused, or left out and named), and no record of the run is
// written. A backup taken before an upgrade is then of the data exactly as
// the older server left it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { Backups } from "../backups/backups.js";
import { dataPaths } from "../data-dir.js";
import { Databases } from "../databases.js";
import { openServerFile } from "../store/open.js";
import { ServerDb, ServerDbError } from "../store/server-db.js";
import { UsageError, type Io } from "./io.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * Makes one set in the folder given with --to, or else CROMDB_BACKUPS. It
 * never removes older sets: backupKeep is for the running server's own
 * runs.
 */
export async function backup(io: Io, dataDir: string, to: string | undefined, driver: Driver = createLevel4Driver()): Promise<number> {
  const folder = to ?? (io.env["CROMDB_BACKUPS"] || undefined);
  if (folder === undefined) {
    await driver.shutdown();
    throw new UsageError("--to DIR is needed, or CROMDB_BACKUPS: the folder to back up into");
  }
  const log = (line: string) => io.out(line);
  try {
    const paths = dataPaths(dataDir);
    const serverDb = await ServerDb.open(driver, paths.serverDb, log, { raise: false });
    const opened = await openServerFile(driver, paths.directory, "the directory", log, { raise: false });
    if (opened.databaseId !== serverDb.identity.directoryDatabaseId) {
      throw new ServerDbError(`${paths.directory} holds database ${opened.databaseId}, not this server's directory ${serverDb.identity.directoryDatabaseId}`);
    }
    const databases = await Databases.open({ driver, paths, serverDb, log, raise: false });
    const info = await driver.call("driver.info", {});
    const backups = new Backups({
      driver,
      serverDb,
      directoryHandle: opened.handle,
      databases,
      folder: resolve(folder),
      keep: () => serverDb.settings.backupKeep,
      versions: { server: PACKAGE.version, driver: info.driver.version, engine: info.engine.version },
      serverName: () => serverDb.settings.serverName,
      now: () => new Date(),
      log,
    });
    await backups.run("command");
    return 0;
  } finally {
    await driver.shutdown();
  }
}
