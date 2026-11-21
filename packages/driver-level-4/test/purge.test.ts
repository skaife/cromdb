// Purge, settings and staleness through the driver, with the clock moved so
// tombstones grow old. The contract suite can't move a driver's clock.

import { afterAll, describe, expect, it } from "vitest";
import type { Driver, DriverError } from "@cromdb/driver";
import { createLevel4Driver } from "../src/index.js";
import { tempDir } from "./helpers.js";

const ALICE = { id: "alice" };
const DAY_MS = 24 * 3_600_000;
const dir = tempDir();
afterAll(() => dir.remove());

/** A driver whose clock moves only when told to. */
function clockedDriver(): { driver: Driver; advanceDays(days: number): void } {
  let now = new Date("2026-11-01T12:00:00.000Z").getTime();
  return {
    driver: createLevel4Driver({ now: () => new Date(now) }),
    advanceDays(days) {
      now += days * DAY_MS;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
  } catch (error) {
    return error as DriverError;
  }
  throw new Error("expected a refusal");
}

interface Side {
  readonly handle: string;
  readonly instanceId: string;
  readonly on: { readonly handle: string; readonly principal: { readonly id: string } };
}

function side(opened: { handle: string; instanceId: string }): Side {
  return { handle: opened.handle, instanceId: opened.instanceId, on: { handle: opened.handle, principal: ALICE } };
}

async function pull(driver: Driver, from: Side, to: Side): Promise<void> {
  const { hello } = await driver.call("sync.hello", from.on);
  await driver.call("sync.checkPeer", { ...to.on, hello });
  for (;;) {
    const { since } = await driver.call("sync.position", { ...to.on, sourceInstanceId: from.instanceId });
    const { batch } = await driver.call("sync.export", { ...from.on, since });
    if (!(await driver.call("sync.apply", { ...to.on, batch })).hasMore) {
      return;
    }
  }
}

async function deleted(driver: Driver, on: Side["on"]): Promise<string> {
  const { document } = await driver.call("documents.create", { ...on, content: { n: 1 } });
  await driver.call("documents.delete", { ...on, id: document.id, ifVersion: document.version });
  return document.id;
}

describe("purge through the driver", () => {
  it("removes a tombstone once it is older than purgeAfterDays, and not before", async () => {
    const { driver, advanceDays } = clockedDriver();
    const a = side(await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE }));
    await deleted(driver, a.on);
    advanceDays(89);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(0);
    advanceDays(2);
    const result = await driver.call("database.purge", a.on);
    expect(result.tombstones).toBe(1);
    expect(result.horizon).toBeGreaterThan(0);
    expect(await driver.call("sync.state", a.on)).toEqual({ stale: false, purgedThrough: result.horizon });
    await driver.shutdown();
  });

  it("uses the saved purgeAfterDays", async () => {
    const { driver, advanceDays } = clockedDriver();
    const a = side(await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE }));
    await driver.call("settings.save", { ...a.on, settings: { purgeAfterDays: 7 } });
    await deleted(driver, a.on);
    advanceDays(6);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(0);
    advanceDays(2);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(1);
    await driver.shutdown();
  });

  it("keeps a tombstone that is in a conflict", async () => {
    const { driver, advanceDays } = clockedDriver();
    const a = side(await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE }));
    const { ticket } = await driver.call("replicas.register", a.on);
    const b = side(await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: ALICE, ticket }));
    const { document } = await driver.call("documents.create", { ...a.on, content: { n: 0 } });
    await pull(driver, a, b);
    await driver.call("documents.delete", { ...a.on, id: document.id, ifVersion: document.version });
    await driver.call("documents.save", { ...b.on, id: document.id, ifVersion: document.version, content: { n: 1 } });
    await pull(driver, b, a);
    await pull(driver, a, b);
    expect((await driver.call("conflicts.get", { ...a.on, id: document.id })).conflict).not.toBeNull();
    advanceDays(100);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(0);
    await driver.shutdown();
  });

  it("passes STALE_REPLICA on as a known code, and a stale replica takes no writes", async () => {
    const { driver, advanceDays } = clockedDriver();
    const a = side(await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE }));
    const { ticket } = await driver.call("replicas.register", a.on);
    const b = side(await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: ALICE, ticket }));
    await pull(driver, a, b);
    await pull(driver, b, a);
    const { document } = await driver.call("documents.create", { ...b.on, content: { kept: true } });
    await pull(driver, b, a);
    // b never hears of this deletion before a purges it.
    await deleted(driver, a.on);
    advanceDays(91);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(1);

    const error = await refusal(pull(driver, a, b));
    expect(error.code).toBe("STALE_REPLICA");
    expect(error.details).toBeUndefined();
    expect(await driver.call("sync.state", b.on)).toEqual({ stale: true, staleSource: a.instanceId, purgedThrough: 0 });
    const write = await refusal(driver.call("documents.save", { ...b.on, id: document.id, ifVersion: document.version, content: { kept: false } }));
    expect(write.code).toBe("READ_ONLY");
    await driver.shutdown();
  });

  it("lists knownThrough for the other replica only", async () => {
    const { driver } = clockedDriver();
    const a = side(await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE }));
    const { ticket } = await driver.call("replicas.register", a.on);
    const b = side(await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: ALICE, ticket }));
    await pull(driver, a, b);
    const { replicas } = await driver.call("replicas.list", b.on);
    const byId = new Map(replicas.map((replica) => [replica.instanceId, replica]));
    expect(byId.get(b.instanceId)?.knownThrough).toBeUndefined();
    const { since } = await driver.call("sync.position", { ...b.on, sourceInstanceId: a.instanceId });
    expect(byId.get(a.instanceId)?.knownThrough).toBe(since);
    await driver.shutdown();
  });
});

describe("compact through the driver", () => {
  it("compacts a database file after a purge, and the file shrinks", async () => {
    const { driver, advanceDays } = clockedDriver();
    const path = dir.path();
    const a = side(await driver.call("database.create", { storage: { kind: "sqlite", path }, principal: ALICE }));
    for (let i = 0; i < 200; i++) {
      await deleted(driver, a.on);
    }
    const { statSync } = await import("node:fs");
    advanceDays(91);
    expect((await driver.call("database.purge", a.on)).tombstones).toBe(200);
    await driver.call("database.close", { handle: a.handle });
    const before = statSync(path).size;
    const again = await driver.call("database.open", { storage: { kind: "sqlite", path } });
    await driver.call("database.compact", { handle: again.handle });
    await driver.call("database.close", { handle: again.handle });
    expect(statSync(path).size).toBeLessThan(before);
    await driver.shutdown();
  });
});
