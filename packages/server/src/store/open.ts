// Opens a database file of the data directory through the driver. A database
// at a level the driver can raise from (one an earlier server made) is
// raised to the driver's level first, as "cromdb-server", and kept open, so
// the file's lock is never let go in between.

import { DriverError, type Driver, type Opened, type Storage } from "@cromdb/driver";
import { SERVER_PRINCIPAL } from "../directory/directory.js";

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

/**
 * Opens the file at path, raising it if the driver can. what names it in the
 * log line a raise writes, such as "the server database". A level the driver
 * neither serves nor raises from is the driver's NOT_SUPPORTED, unchanged.
 */
export async function openServerFile(driver: Driver, path: string, what: string, log: (message: string) => void): Promise<Opened> {
  const storage = serverFile(path);
  try {
    return await driver.call("database.open", { storage });
  } catch (error) {
    const level = error instanceof DriverError && error.code === "NOT_SUPPORTED" ? error.details?.["level"] : undefined;
    if (typeof level !== "number") {
      throw error;
    }
    const info = await driver.call("driver.info", {});
    if (!info.capabilities.includes("raise") || !info.raisesFrom.includes(level)) {
      throw error;
    }
    const { raisedFrom, ...opened } = await driver.call("database.raise", { storage, principal: SERVER_PRINCIPAL });
    if (raisedFrom !== opened.level) {
      log(`Raised ${what} (${opened.databaseId}) from level ${raisedFrom} to level ${opened.level}`);
    }
    return opened;
  }
}
