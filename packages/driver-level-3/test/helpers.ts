import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractOptions } from "@cromdb/driver/contract";
import { createLevel3Driver } from "../src/index.js";

/** A temporary directory for database files, and a way to remove it. */
export function tempDir(): { path(name?: string): string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "cromdb-driver-"));
  let n = 0;
  return {
    path: (name) => join(dir, name ?? `db-${++n}.cromdb`),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Contract options for the level-3 driver, or for a driver wrapping it. */
export function contractOptions(dir: { path(): string }, wrap = (driver: ReturnType<typeof createLevel3Driver>) => driver, numRuns?: number): ContractOptions {
  return {
    makeDriver: () => wrap(createLevel3Driver()),
    freshStorage: () => ({ kind: "memory" }),
    freshFilePath: () => dir.path(),
    ...(numRuns === undefined ? {} : { numRuns }),
  };
}
