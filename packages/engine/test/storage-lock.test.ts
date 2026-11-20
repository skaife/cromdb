// SqliteAdapter.open(file, { exclusive: true }): the lock is SQLite's own,
// so it holds against other processes and goes when the holder closes or
// dies. The other process here uses better-sqlite3 directly, as any SQLite
// client would.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CromDBError } from "../src/errors.js";
import { Session } from "../src/session.js";
import { SqliteAdapter } from "../src/storage/sqlite-adapter.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

// Run in a child process from the package directory, so it finds
// better-sqlite3. "hold" takes the file the way an exclusive adapter does and
// keeps it until stdin closes or the process is killed; "try" opens the file
// once, reads it, and prints "ok" or SQLite's error code.
const CHILD = `
const Database = require("better-sqlite3");
const [mode, file] = process.argv.slice(1);
if (mode === "hold") {
  const db = new Database(file, { timeout: 0 });
  db.pragma("locking_mode = EXCLUSIVE");
  db.pragma("journal_mode = WAL");
  db.transaction(() => {}).immediate();
  console.log("held");
  process.stdin.on("end", () => { db.close(); process.exit(0); });
  process.stdin.resume();
} else {
  try {
    const db = new Database(file, { timeout: 0 });
    db.pragma("user_version");
    db.close();
    console.log("ok");
  } catch (error) {
    console.log(error.code);
  }
}
`;

function child(mode: "hold" | "try", file: string): ChildProcess {
  return spawn(process.execPath, ["-e", CHILD, mode, file], { cwd: PACKAGE_DIR, stdio: ["pipe", "pipe", "inherit"] });
}

/** The child's first line of output. */
function firstLine(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end !== -1) {
        resolve(text.slice(0, end).trim());
      }
    });
    process.on("error", reject);
    process.on("exit", (code) => reject(new Error(`child exited with ${String(code)} before printing`)));
  });
}

function exited(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
    } else {
      process.on("exit", () => resolve());
    }
  });
}

function lockedError(fn: () => unknown): CromDBError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CromDBError);
  expect((caught as CromDBError).code).toBe("STORAGE_LOCKED");
  return caught as CromDBError;
}

describe("an exclusive SqliteAdapter", () => {
  let directory: string;
  let file: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cromdb-lock-"));
    file = join(directory, "data.cromdb");
  });

  afterEach(async () => {
    for (const process of children.splice(0)) {
      process.kill();
      await exited(process);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps another process out until it closes, and makes no -shm file", async () => {
    const adapter = SqliteAdapter.open(file, { exclusive: true });
    try {
      const refused = child("try", file);
      children.push(refused);
      expect(await firstLine(refused)).toMatch(/^SQLITE_BUSY/);
      expect(existsSync(`${file}-shm`)).toBe(false);
    } finally {
      adapter.close();
    }
    const allowed = child("try", file);
    children.push(allowed);
    expect(await firstLine(allowed)).toBe("ok");
  });

  it("is refused at once with STORAGE_LOCKED while another process holds the file", async () => {
    SqliteAdapter.open(file).close();
    const holder = child("hold", file);
    children.push(holder);
    expect(await firstLine(holder)).toBe("held");

    const started = Date.now();
    const error = lockedError(() => SqliteAdapter.open(file, { exclusive: true }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.message).toContain(file);

    holder.stdin?.end();
    await exited(holder);
    SqliteAdapter.open(file, { exclusive: true }).close();
  });

  it("refuses a plain open of a held file with STORAGE_LOCKED too, after SQLite's wait", async () => {
    SqliteAdapter.open(file).close();
    const holder = child("hold", file);
    children.push(holder);
    expect(await firstLine(holder)).toBe("held");
    lockedError(() => SqliteAdapter.open(file));
  }, 20_000);

  it("is free again when the holding process dies", async () => {
    SqliteAdapter.open(file).close();
    const holder = child("hold", file);
    children.push(holder);
    expect(await firstLine(holder)).toBe("held");
    lockedError(() => SqliteAdapter.open(file, { exclusive: true }));

    holder.kill("SIGKILL");
    await exited(holder);
    const adapter = SqliteAdapter.open(file, { exclusive: true });
    try {
      expect(adapter.isEmpty()).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it("keeps a second adapter in the same process out", () => {
    const first = SqliteAdapter.open(file, { exclusive: true });
    try {
      lockedError(() => SqliteAdapter.open(file, { exclusive: true }));
    } finally {
      first.close();
    }
    SqliteAdapter.open(file, { exclusive: true }).close();
  });

  it("holds a database that works as usual, and keeps it after reopening", async () => {
    const adapter = SqliteAdapter.open(file, { exclusive: true });
    const db = await Session.withId("alice").openDatabase(adapter);
    const created = await db.create({ title: "kept" });
    adapter.close();

    const reopened = SqliteAdapter.open(file, { exclusive: true });
    try {
      const again = await Session.withId("alice").openDatabase(reopened);
      expect((await again.get(created.id))?.content).toEqual({ title: "kept" });
    } finally {
      reopened.close();
    }
  });

  it("ignores the option for an in-memory database", () => {
    const first = SqliteAdapter.open(":memory:", { exclusive: true });
    const second = SqliteAdapter.open(":memory:", { exclusive: true });
    first.close();
    second.close();
  });

  it("refuses options that aren't { exclusive: boolean }", () => {
    expect(() => SqliteAdapter.open(file, null as unknown as { exclusive?: boolean })).toThrow(TypeError);
    expect(() => SqliteAdapter.open(file, { exclusive: "yes" as unknown as boolean })).toThrow(TypeError);
  });
});
