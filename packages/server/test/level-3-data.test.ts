// A data directory an earlier server made, at level 3, is raised to level 4
// the first time this server opens it: server.cromdb by any command, the
// directory and the databases by start. Always on a copy of the fixture.

import { copyFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DriverError } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { startServer } from "../src/server.js";
import { serverFile } from "../src/store/server-db.js";
import { expectExit, runMain, scriptedIo, tempDir } from "./helpers.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/level-3/data", import.meta.url));
// An empty level-2 database made by cromdb 0.5.0.
const LEVEL_2 = fileURLToPath(new URL("../../engine/test/fixtures/0.5.0/seeds/alice.cromdb", import.meta.url));
const SERVER = { id: "cromdb-server" };
const NOTES_FILE = "aff92d0b-5dfe-454f-86d1-eb4e209f5916.cromdb";

const dirs: { remove(): void }[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.remove();
});

function copyFixture(): string {
  const dir = tempDir();
  dirs.push(dir);
  const data = dir.join("data");
  cpSync(FIXTURE, data, { recursive: true });
  return data;
}

async function start(data: string) {
  const logs: string[] = [];
  const server = await startServer({ dataDir: data, listen: "127.0.0.1:0", log: (line) => logs.push(line) });
  return { server, logs };
}

/** The level each database file is at, read by opening it with a new driver: anything below 4 is refused. */
async function levels(data: string): Promise<Record<string, number | string>> {
  const driver = createLevel4Driver();
  const files = ["server.cromdb", "directory.cromdb", ...readdirSync(join(data, "databases")).map((file) => join("databases", file))];
  const result: Record<string, number | string> = {};
  try {
    for (const file of files) {
      try {
        const opened = await driver.call("database.open", { storage: serverFile(join(data, file)) });
        result[file] = opened.level;
        await driver.call("database.close", { handle: opened.handle });
      } catch (error) {
        result[file] = error instanceof DriverError && typeof error.details?.["level"] === "number" ? error.details["level"] : String(error);
      }
    }
  } finally {
    await driver.shutdown();
  }
  return result;
}

describe("a level-3 data directory", () => {
  it("is raised at start, everything in it kept, and logged", async () => {
    const data = copyFixture();
    const { server, logs } = await start(data);
    try {
      const raised = logs.filter((line) => line.startsWith("Raised "));
      expect(raised).toEqual([
        expect.stringMatching(/^Raised the server database \(.+\) from level 3 to level 4$/),
        expect.stringMatching(/^Raised the directory \(.+\) from level 3 to level 4$/),
        expect.stringMatching(/^Raised database "Notes" \(.+\) from level 3 to level 4$/),
      ]);
      expect(logs).toContain("The server database now keeps tombstones 7 days (serverDbPurgeAfterDays), not 90");
      expect(server.directory.index.size).toBe(2);
      expect(server.sessions.size).toBe(1);

      const [notes, ...others] = server.databases.list();
      expect(others).toEqual([]);
      expect(notes?.status).toBe("open");
      if (notes?.status !== "open") return;
      const driver = server.databases.driver;
      const on = { handle: notes.handle, principal: SERVER };
      const { acl } = await driver.call("acl.get", on);
      const adminId = acl.admins.find((id) => id !== SERVER.id) ?? "";
      const { documents } = await driver.call("documents.find", { handle: notes.handle, principal: { id: adminId }, limit: 10 });
      expect(documents.map((doc) => doc.content["title"]).sort()).toEqual(["First", "Second"]);
      expect(await driver.call("database.info", { handle: notes.handle })).toMatchObject({ level: 4 });
      expect(await driver.call("database.info", { handle: server.serverDb.handle })).toMatchObject({ level: 4 });
      expect(await driver.call("settings.get", { handle: server.serverDb.handle, principal: SERVER })).toEqual({ settings: { purgeAfterDays: 7 } });
    } finally {
      await server.close();
    }
    expect(await levels(data)).toEqual({ "server.cromdb": 4, "directory.cromdb": 4, [join("databases", NOTES_FILE)]: 4 });

    // Only once: the next start raises nothing and changes no setting.
    const again = await start(data);
    await again.server.close();
    expect(again.logs.filter((line) => line.startsWith("Raised ") || line.includes("keeps tombstones"))).toEqual([]);
  });

  it("has only its server database raised by a command, the rest at start", async () => {
    const data = copyFixture();
    const io = scriptedIo();
    expectExit(await runMain(["config", "get", "serverName", "--data", data], io), 0);
    expect(io.errors).toEqual([expect.stringMatching(/^Raised the server database \(.+\) from level 3 to level 4$/)]);
    expect(await levels(data)).toEqual({ "server.cromdb": 4, "directory.cromdb": 3, [join("databases", NOTES_FILE)]: 3 });

    const { server, logs } = await start(data);
    await server.close();
    expect(logs.filter((line) => line.startsWith("Raised "))).toEqual([
      expect.stringMatching(/^Raised the directory /),
      expect.stringMatching(/^Raised database "Notes" /),
    ]);
    expect(await levels(data)).toEqual({ "server.cromdb": 4, "directory.cromdb": 4, [join("databases", NOTES_FILE)]: 4 });
  });

  it("serves the rest when a database in it can't be raised", async () => {
    const data = copyFixture();
    copyFileSync(LEVEL_2, join(data, "databases", NOTES_FILE));
    const { server, logs } = await start(data);
    try {
      const [notes] = server.databases.list();
      expect(notes).toMatchObject({ status: "unavailable", reason: expect.stringContaining("level 2") });
      expect(logs.filter((line) => line.startsWith("Raised "))).toHaveLength(2);
    } finally {
      await server.close();
    }
    expect(await levels(data)).toEqual({ "server.cromdb": 4, "directory.cromdb": 4, [join("databases", NOTES_FILE)]: 2 });
  });

  it("applies a changed serverDbPurgeAfterDays at the next start", async () => {
    const data = copyFixture();
    expectExit(await runMain(["config", "set", "serverDbPurgeAfterDays", "30", "--data", data]), 0);
    const { server, logs } = await start(data);
    try {
      expect(logs).toContain("The server database now keeps tombstones 30 days (serverDbPurgeAfterDays), not 90");
      expect(await server.databases.driver.call("settings.get", { handle: server.serverDb.handle, principal: SERVER })).toEqual({ settings: { purgeAfterDays: 30 } });
    } finally {
      await server.close();
    }
  });
});
