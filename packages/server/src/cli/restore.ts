// cromdb-server restore: puts a whole server back from a backup set, into an
// empty data directory, with the server stopped. --check only checks the
// set, writing nothing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { restoreServer } from "../backups/restore.js";
import { UsageError, type Io } from "./io.js";

/**
 * Restores the set in from into dataDir, or with check, restores it into a
 * temporary folder and removes that again: everything a restore checks,
 * nothing written where it counts.
 */
export async function restore(io: Io, dataDir: string | undefined, from: string | undefined, check: boolean, driver: Driver = createLevel4Driver()): Promise<number> {
  try {
    if (from === undefined) {
      throw new UsageError("--from SET is needed: the backup set's folder, such as /backups/2026-11-26T03-00-12Z");
    }
    if (!check && dataDir === undefined) {
      throw new UsageError("--data DIR is needed: the empty data directory to restore into");
    }
    const log = (line: string) => io.out(line);
    const into = check ? mkdtempSync(join(tmpdir(), "cromdb-restore-check-")) : (dataDir as string);
    try {
      const done = await restoreServer({ driver, from: resolve(from), dataDir: into, now: () => new Date(), log });
      const { manifest } = done;
      const databases = manifest.files.filter((file) => file.role === "database").length;
      if (check) {
        io.out(`The set ${manifest.name} is whole and restores: the server database, the directory and ${databases} databases, as backed up ${manifest.finishedAt}.`);
      } else {
        io.out(`Restored ${resolve(into)} from the set ${manifest.name} (backed up ${manifest.finishedAt}): the server database, the directory and ${databases} databases.`);
        io.out(`Each has a new instance ID, and the one it was a backup of is retired. ${done.sessionsEnded} sessions were ended: everyone logs in again.`);
      }
      for (const skipped of manifest.skipped) {
        io.out(`Not in the set: database ${JSON.stringify(skipped.name)} (${skipped.databaseId}): ${skipped.reason}`);
      }
      return 0;
    } finally {
      if (check) rmSync(into, { recursive: true, force: true });
    }
  } finally {
    await driver.shutdown();
  }
}
