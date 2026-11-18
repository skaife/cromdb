// database.open opens a database anonymously to read its level before
// deciding whether to serve it. That check must write nothing.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Session, SqliteAdapter } from "cromdb";
import { DriverError } from "@cromdb/driver";
import { createLevel2Driver } from "../src/index.js";
import { tempDir } from "./helpers.js";

const LEVEL_1_FIXTURE = fileURLToPath(new URL("../../engine/test/fixtures/0.3.0/lisbon.cromdb", import.meta.url));
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
  it("refuses a level-1 database and leaves its file byte-identical", async () => {
    const path = dir.path("level-1.cromdb");
    copyFileSync(LEVEL_1_FIXTURE, path);
    const before = digest(path);
    const driver = createLevel2Driver();
    const error = await refusal(driver.call("database.open", { storage: { kind: "sqlite", path } }));
    expect(error).toBeInstanceOf(DriverError);
    expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { level: 1 }]);
    expect(digest(path)).toBe(before);
    expect(leftovers(path)).toEqual([]);
    // The file was closed and released: refused again, not ALREADY_OPEN.
    expect((await refusal(driver.call("database.open", { storage: { kind: "sqlite", path } }))).code).toBe("NOT_SUPPORTED");
    await driver.shutdown();
    expect(digest(path)).toBe(before);
  });

  it("writes nothing to a level-2 database it opens", async () => {
    const path = dir.path("level-2.cromdb");
    const driver = createLevel2Driver();
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
    expect(replicas.replicas.map((replica) => replica.maxLevel)).toEqual([2]);
    await driver.shutdown();
  });

  it("writes only what any first open writes, for a replica copied and never opened", async () => {
    // A replica made by createReplica records its engine's highest level in
    // its registration the first time anything opens it, whatever the
    // session (the engine does this on purpose). The server makes replicas
    // from tickets, opened by a principal at once, so it never meets one;
    // this documents the case.
    const source = SqliteAdapter.open(dir.path("source.cromdb"));
    const path = dir.path("copy.cromdb");
    const target = SqliteAdapter.open(path);
    await (await Session.withId("alice").openDatabase(source)).createReplica(target);
    const lastSeq = target.lastSeq();
    target.close();
    source.close();

    const driver = createLevel2Driver();
    const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    await driver.call("database.close", { handle });
    const opened = SqliteAdapter.open(path);
    expect(opened.lastSeq()).toBe(lastSeq + 1);
    opened.close();

    const before = digest(path);
    await driver.call("database.close", { handle: (await driver.call("database.open", { storage: { kind: "sqlite", path } })).handle });
    expect(digest(path)).toBe(before);
    await driver.shutdown();
  });

  it("refuses a ticket for a level-1 database before touching storage", async () => {
    const path = dir.path("from-ticket.cromdb");
    const driver = createLevel2Driver();
    const error = await refusal(driver.call("database.createFromTicket", { storage: { kind: "sqlite", path }, principal: ALICE, ticket: { level: 1 } }));
    expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { level: 1 }]);
    expect(existsSync(path)).toBe(false);
    await driver.shutdown();
  });
});
