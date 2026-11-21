// database.raise on real level-3 files, made by cromdb 0.6.0.

import { copyFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "cromdb";
import type { DriverError } from "@cromdb/driver";
import { createLevel4Driver } from "../src/index.js";
import { tempDir } from "./helpers.js";

// Empty databases with "alice" as their only admin, at level 2 (0.5.0) and 3 (0.6.0).
const LEVEL_2 = fileURLToPath(new URL("../../engine/test/fixtures/0.5.0/seeds/alice.cromdb", import.meta.url));
const LEVEL_3 = fileURLToPath(new URL("../../engine/test/fixtures/0.6.0/seeds/alice.cromdb", import.meta.url));
const ALICE = { id: "alice" };

const dir = tempDir();
afterAll(() => dir.remove());

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function copy(fixture: string): string {
  const path = dir.path();
  copyFileSync(fixture, path);
  return path;
}

async function refusal(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
  } catch (error) {
    return error as DriverError;
  }
  throw new Error("expected a refusal");
}

describe("database.raise", () => {
  it("raises a level-3 database to level 4 and leaves it open", async () => {
    const path = copy(LEVEL_3);
    const driver = createLevel4Driver();
    const storage = { kind: "sqlite" as const, path };
    const raised = await driver.call("database.raise", { storage, principal: ALICE });
    expect([raised.level, raised.raisedFrom]).toEqual([4, 3]);
    const on = { handle: raised.handle, principal: ALICE };
    expect(await driver.call("database.info", { handle: raised.handle })).toEqual({ databaseId: raised.databaseId, instanceId: raised.instanceId, level: 4 });
    const { acl } = await driver.call("acl.get", on);
    expect([acl.admins, acl.readers]).toEqual([["alice"], ["alice"]]);
    const { document } = await driver.call("documents.create", { ...on, content: { after: "raise" } });
    expect(await driver.call("settings.get", on)).toEqual({ settings: { purgeAfterDays: 90 } });
    expect((await driver.call("database.purge", on)).tombstones).toBe(0);
    await driver.call("database.close", { handle: raised.handle });

    const opened = await driver.call("database.open", { storage });
    expect([opened.databaseId, opened.level]).toEqual([raised.databaseId, 4]);
    expect((await driver.call("documents.get", { handle: opened.handle, principal: ALICE, id: document.id })).document?.content).toEqual({ after: "raise" });
    await driver.shutdown();
  });

  it("refuses a principal who isn't an admin, and writes nothing", async () => {
    const path = copy(LEVEL_3);
    const before = digest(path);
    const driver = createLevel4Driver();
    const storage = { kind: "sqlite" as const, path };
    expect((await refusal(driver.call("database.raise", { storage, principal: { id: "bob" } }))).code).toBe("ACCESS_DENIED");
    expect(digest(path)).toBe(before);
    // Released again: a raise by alice now works.
    expect((await driver.call("database.raise", { storage, principal: ALICE })).raisedFrom).toBe(3);
    await driver.shutdown();
  });

  it("refuses a level it doesn't raise from, and writes nothing", async () => {
    const path = copy(LEVEL_2);
    const before = digest(path);
    const driver = createLevel4Driver();
    const error = await refusal(driver.call("database.raise", { storage: { kind: "sqlite", path }, principal: ALICE }));
    expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { level: 2 }]);
    expect(digest(path)).toBe(before);
    await driver.shutdown();
  });

  it("holds an exclusive lock from start to end", async () => {
    const path = copy(LEVEL_3);
    const driver = createLevel4Driver();
    const raised = await driver.call("database.raise", { storage: { kind: "sqlite", path, exclusive: true }, principal: ALICE });
    expect(raised.raisedFrom).toBe(3);
    let code: string | undefined;
    try {
      // Exclusive, so it fails at once instead of after SQLite's wait.
      SqliteAdapter.open(path, { exclusive: true }).close();
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("STORAGE_LOCKED");
    await driver.call("database.close", { handle: raised.handle });
    SqliteAdapter.open(path).close();
    await driver.shutdown();
  });

  it("raises once: a second raise opens it unchanged", async () => {
    const path = copy(LEVEL_3);
    const driver = createLevel4Driver();
    const storage = { kind: "sqlite" as const, path };
    await driver.call("database.close", { handle: (await driver.call("database.raise", { storage, principal: ALICE })).handle });
    const before = digest(path);
    const again = await driver.call("database.raise", { storage, principal: { id: "bob" } });
    expect([again.level, again.raisedFrom]).toEqual([4, 4]);
    await driver.call("database.close", { handle: again.handle });
    expect(digest(path)).toBe(before);
    await driver.shutdown();
  });
});
