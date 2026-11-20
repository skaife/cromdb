// database.open reads a database's level, without opening it as anyone,
// before deciding whether to serve it. That check must write nothing.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Session, SqliteAdapter } from "cromdb";
import { DriverError } from "@cromdb/driver";
import { createLevel3Driver } from "../src/index.js";
import { tempDir } from "./helpers.js";

const LEVEL_1_FIXTURE = fileURLToPath(new URL("../../engine/test/fixtures/0.3.0/lisbon.cromdb", import.meta.url));
// An empty level-2 database made by cromdb 0.5.0.
const LEVEL_2_FIXTURE = fileURLToPath(new URL("../../engine/test/fixtures/0.5.0/seeds/alice.cromdb", import.meta.url));
const ALICE = { id: "alice" };

const dir = tempDir();
afterAll(() => dir.remove());

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function leftovers(path: string): string[] {
  return ["-wal", "-shm", "-journal"].filter((suffix) => existsSync(path + suffix));
}

async function refusal(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
  } catch (error) {
    return error as DriverError;
  }
  throw new Error("expected a refusal");
}

describe("the level check on database.open", () => {
  it.each([
    [1, LEVEL_1_FIXTURE],
    [2, LEVEL_2_FIXTURE],
  ])("refuses a level-%i database and leaves its file byte-identical", async (level, fixture) => {
    const path = dir.path(`level-${level}.cromdb`);
    copyFileSync(fixture, path);
    const before = digest(path);
    const driver = createLevel3Driver();
    const error = await refusal(driver.call("database.open", { storage: { kind: "sqlite", path } }));
    expect(error).toBeInstanceOf(DriverError);
    expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { level }]);
    expect(digest(path)).toBe(before);
    expect(leftovers(path)).toEqual([]);
    // The file was closed and released: refused again, not ALREADY_OPEN.
    expect((await refusal(driver.call("database.open", { storage: { kind: "sqlite", path } }))).code).toBe("NOT_SUPPORTED");
    await driver.shutdown();
    expect(digest(path)).toBe(before);
  });

  it("writes nothing to a level-3 database it opens", async () => {
    const path = dir.path("level-3.cromdb");
    const driver = createLevel3Driver();
    const created = await driver.call("database.create", { storage: { kind: "sqlite", path }, principal: ALICE });
    await driver.call("documents.create", { handle: created.handle, principal: ALICE, content: { n: 1 } });
    await driver.call("database.close", { handle: created.handle });
    const before = digest(path);

    const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    await driver.call("database.close", { handle });
    expect(digest(path)).toBe(before);
    expect(leftovers(path)).toEqual([]);

    // The change log and registrations, read through the engine, agree.
    const adapter = SqliteAdapter.open(path);
    const lastSeq = adapter.lastSeq();
    adapter.close();
    const again = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    const replicas = await driver.call("replicas.list", { handle: again.handle, principal: ALICE });
    await driver.call("database.close", { handle: again.handle });
    const check = SqliteAdapter.open(path);
    expect(check.lastSeq()).toBe(lastSeq);
    check.close();
    expect(replicas.replicas.map((replica) => replica.maxLevel)).toEqual([3]);
    await driver.shutdown();
  });

  it("writes nothing to a replica copied and never opened, until a principal uses it", async () => {
    // A replica made by createReplica records its engine's highest level in
    // its registration the first time a session opens it (the engine does
    // this on purpose). database.open opens no session, so that write waits
    // for the first call by a principal.
    const source = SqliteAdapter.open(dir.path("source.cromdb"));
    const path = dir.path("copy.cromdb");
    const target = SqliteAdapter.open(path);
    await (await Session.withId("alice").openDatabase(source)).createReplica(target);
    const lastSeq = target.lastSeq();
    target.close();
    source.close();

    const driver = createLevel3Driver();
    const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    await driver.call("database.close", { handle });
    const opened = SqliteAdapter.open(path);
    expect(opened.lastSeq()).toBe(lastSeq);
    opened.close();

    const again = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    await driver.call("replicas.list", { handle: again.handle, principal: ALICE });
    await driver.call("database.close", { handle: again.handle });
    const used = SqliteAdapter.open(path);
    expect(used.lastSeq()).toBe(lastSeq + 1);
    used.close();
    await driver.shutdown();
  });

  it.each([1, 2])("refuses a ticket for a level-%i database before touching storage", async (level) => {
    const path = dir.path(`from-ticket-${level}.cromdb`);
    const driver = createLevel3Driver();
    const error = await refusal(driver.call("database.createFromTicket", { storage: { kind: "sqlite", path }, principal: ALICE, ticket: { level } }));
    expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { level }]);
    expect(existsSync(path)).toBe(false);
    await driver.shutdown();
  });
});
