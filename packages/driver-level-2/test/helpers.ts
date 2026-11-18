import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A temporary directory for database files, and a way to remove it. */
export function tempDir(): { path(name?: string): string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "cromdb-driver-"));
  let n = 0;
  return {
    path: (name) => join(dir, name ?? `db-${++n}.cromdb`),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
