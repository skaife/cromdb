// The daily maintenance: on a real server with its clock moved, then the
// runner alone with a stub driver, for compact's count, the timer and
// shutdown.

import { DriverError, type Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COMPACT_AFTER_ENTRIES, FIRST_CHECK_MS, CHECK_EVERY_MS, Maintenance, type MaintainedDatabase } from "../src/maintenance/maintenance.js";
import type { MaintenanceRecord, ServerDb } from "../src/store/server-db.js";
import { fakeHarness, startTestServer, type LoginHarness, type TestServer } from "./harness.js";
import { expectExit, runMain } from "./helpers.js";

const DAY_MS = 24 * 3_600_000;

let h: LoginHarness;
beforeAll(async () => {
  h = await fakeHarness();
});
afterAll(() => h.close());

describe("maintenance on a running server", () => {
  let t: TestServer;
  afterEach(() => t.close());

  /** A database the admin made, with one document made and deleted. */
  async function withTombstone(driver?: () => Driver) {
    t = await startTestServer(h, driver === undefined ? {} : { driver });
    const admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const databaseId = (await admin.api("POST", "/api/v0/databases", { name: "Notes" })).body.databaseId as string;
    const made = await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "Gone" } });
    const removed = await admin.api("DELETE", `/api/v0/databases/${databaseId}/documents/${made.body.id}`, undefined, { "if-match": made.headers.get("etag") ?? "" });
    expect(removed.status).toBe(200);
    return databaseId;
  }

  it("says when it is due, at start", async () => {
    await withTombstone();
    expect(t.logs).toContainEqual(expect.stringMatching(/^Maintenance is due daily at 03:00 \S+$/));
    await t.restart(async () => {
      expectExit(await runMain(["config", "set", "maintenanceTimeZone", "Asia/Tokyo", "--data", t.dataDir]), 0);
      expectExit(await runMain(["config", "set", "maintenanceHour", "22", "--data", t.dataDir]), 0);
    });
    expect(t.logs).toContain("Maintenance is due daily at 22:00 Asia/Tokyo");
  });

  it("purges every database once its tombstones are old enough, and keeps the record", async () => {
    const databaseId = await withTombstone();
    const { serverDb } = t.server;
    // An ended session leaves a tombstone in server.cromdb.
    await t.server.sessions.end(await t.server.sessions.create("someone"));

    const first = await t.server.maintenance.runNow();
    expect(first.databases[databaseId]).toMatchObject({ what: 'database "Notes"', ok: true, tombstones: 0, sinceCompact: expect.any(Number) });
    expect(first.databases[serverDb.databaseId]).toMatchObject({ what: "the server database", ok: true, tombstones: 0 });
    expect(Object.values(first.databases).map((entry) => entry.what).sort()).toEqual(['database "Notes"', "the directory", "the server database"]);

    t.clockMs = 8 * DAY_MS;
    const week = await t.server.maintenance.runNow();
    expect(week.databases[serverDb.databaseId]?.tombstones).toBeGreaterThanOrEqual(1);
    expect(week.databases[databaseId]?.tombstones).toBe(0);

    t.clockMs = 91 * DAY_MS;
    const later = await t.server.maintenance.runNow();
    expect(later.databases[databaseId]).toMatchObject({ ok: true, tombstones: 1 });
    expect(later.databases[databaseId]?.horizon).toBeGreaterThan(0);
    expect(t.logs).toContainEqual(expect.stringMatching(new RegExp(`^Purged database "Notes" \\(${databaseId}\\): 1 tombstones, \\d+ entries, horizon \\d+, \\d+ ms$`)));
    expect(t.logs).toContainEqual(expect.stringMatching(/^Maintenance finished: 3 databases in \d+ ms$/));
    expect(new Date(later.lastRunAt).getTime()).toBeGreaterThan(Date.now() + 90 * DAY_MS);

    await t.restart();
    expect(t.server.serverDb.maintenance).toEqual(later);
    expect(t.server.maintenance.due).toBe(false);
    t.clockMs += DAY_MS;
    expect(t.server.maintenance.due).toBe(true);
  });

  it("goes on past a database whose purge fails, and records the failure", async () => {
    let failing: string | undefined;
    const driver = (): Driver => {
      const real = createLevel4Driver({ now: () => new Date(Date.now() + (t?.clockMs ?? 0)) });
      const call = (op: string, input: unknown) =>
        op === "database.purge" && (input as { handle: string }).handle === failing
          ? Promise.reject(new DriverError("INTERNAL", "disk on fire"))
          : real.callByName(op, input);
      return { call: call as Driver["call"], callByName: call, shutdown: () => real.shutdown() };
    };
    const databaseId = await withTombstone(driver);
    const state = t.server.databases.get(databaseId);
    failing = state?.status === "open" ? state.handle : undefined;
    const record = await t.server.maintenance.runNow();
    expect(record.databases[databaseId]).toMatchObject({ ok: false, error: "disk on fire", sinceCompact: 0 });
    expect(record.databases[t.server.serverDb.databaseId]).toMatchObject({ ok: true });
    expect(t.logs).toContain(`Purging database "Notes" (${databaseId}) failed: disk on fire`);
  });
});

// The runner alone, with a stub driver and record store.

interface Stub {
  readonly driver: Driver;
  readonly calls: { op: string; handle: string }[];
  /** Entries each database.purge reports, by handle. */
  readonly entries: Map<string, number>;
  /** A purge waits for this, when set. */
  gate: Promise<void> | undefined;
}

function stubDriver(): Stub {
  const stub: Stub = {
    calls: [],
    entries: new Map(),
    gate: undefined,
    driver: undefined as unknown as Driver,
  };
  const call = async (op: string, input: unknown) => {
    const { handle } = input as { handle: string };
    stub.calls.push({ op, handle });
    if (op === "database.purge") {
      await stub.gate;
      return { tombstones: 0, entries: stub.entries.get(handle) ?? 0, horizon: 0 };
    }
    if (op === "database.compact") return {};
    throw new Error(`unexpected ${op}`);
  };
  (stub as { driver: Driver }).driver = { call: call as Driver["call"], callByName: call, shutdown: async () => {} };
  return stub;
}

function stubServerDb(initial?: MaintenanceRecord): ServerDb & { saved: MaintenanceRecord[] } {
  const saved: MaintenanceRecord[] = [];
  let current = initial;
  return {
    saved,
    get maintenance() {
      return current;
    },
    async saveMaintenance(record: MaintenanceRecord) {
      saved.push(record);
      current = record;
    },
  } as unknown as ServerDb & { saved: MaintenanceRecord[] };
}

const A: MaintainedDatabase = { databaseId: "db-a", what: "the server database", handle: "h-a" };
const B: MaintainedDatabase = { databaseId: "db-b", what: 'database "B"', handle: "h-b" };

function runner(stub: Stub, serverDb: ServerDb, now: () => Date, logs: string[] = []) {
  return new Maintenance({
    driver: stub.driver,
    serverDb,
    databases: () => [A, B],
    skipped: () => ['database "C" (db-c): gone'],
    hour: 3,
    zone: "UTC",
    now,
    log: (line) => logs.push(line),
  });
}

describe("the maintenance runner", () => {
  it("compacts once the entries removed since the last compact reach the limit, and not before", async () => {
    const stub = stubDriver();
    const serverDb = stubServerDb({
      lastRunAt: "2026-06-01T03:00:00.000Z",
      databases: {
        "db-a": { what: "the server database", at: "2026-06-01T03:00:00.000Z", ok: true, sinceCompact: COMPACT_AFTER_ENTRIES - 10 },
        "db-b": { what: 'database "B"', at: "2026-06-01T03:00:00.000Z", ok: true, sinceCompact: COMPACT_AFTER_ENTRIES - 10 },
      },
    });
    stub.entries.set("h-a", 9).set("h-b", 10);
    const logs: string[] = [];
    const record = await runner(stub, serverDb, () => new Date("2026-06-02T03:30:00.000Z"), logs).runNow();
    expect(stub.calls.filter((call) => call.op === "database.compact")).toEqual([{ op: "database.compact", handle: "h-b" }]);
    expect(record.databases["db-a"]).toMatchObject({ sinceCompact: COMPACT_AFTER_ENTRIES - 1 });
    expect(record.databases["db-b"]).toMatchObject({ sinceCompact: 0, compactedAt: "2026-06-02T03:30:00.000Z" });
    expect(logs).toContain('Maintenance skips database "C" (db-c): gone');
    expect(logs).toContainEqual(expect.stringMatching(/^Compacted database "B" \(db-b\) after 10000 entries: \d+\.\d s$/));

    // The next run keeps counting from there.
    stub.entries.set("h-a", 1).set("h-b", 0);
    const next = await runner(stub, serverDb, () => new Date("2026-06-03T03:30:00.000Z")).runNow();
    expect(next.databases["db-a"]).toMatchObject({ sinceCompact: 0 });
    expect(next.databases["db-b"]).toMatchObject({ sinceCompact: 0, compactedAt: "2026-06-02T03:30:00.000Z" });
    expect(stub.calls.filter((call) => call.op === "database.compact").map((call) => call.handle)).toEqual(["h-b", "h-a"]);
  });

  it("checks a minute after start and then hourly, running once a day", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-01T02:00:00.000Z") });
    try {
      const stub = stubDriver();
      const serverDb = stubServerDb({ lastRunAt: "2026-05-31T03:10:00.000Z", databases: {} });
      const maintenance = runner(stub, serverDb, () => new Date());
      maintenance.start();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
      expect(serverDb.saved).toHaveLength(0); // 02:01: before the hour
      await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
      expect(serverDb.saved.map((record) => record.lastRunAt)).toEqual(["2026-06-01T03:01:00.000Z"]);
      await vi.advanceTimersByTimeAsync(20 * CHECK_EVERY_MS);
      expect(serverDb.saved).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4 * CHECK_EVERY_MS);
      expect(serverDb.saved.map((record) => record.lastRunAt)).toEqual(["2026-06-01T03:01:00.000Z", "2026-06-02T03:01:00.000Z"]);
      await maintenance.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at shutdown after the database it is on, and the run doesn't count", async () => {
    const stub = stubDriver();
    let release = () => {};
    stub.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous: MaintenanceRecord = { lastRunAt: "2026-05-31T03:10:00.000Z", databases: {} };
    const serverDb = stubServerDb(previous);
    const logs: string[] = [];
    const maintenance = runner(stub, serverDb, () => new Date("2026-06-01T04:00:00.000Z"), logs);
    const running = maintenance.check();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopping = maintenance.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await Promise.all([running, stopping]);
    expect(stub.calls.map((call) => call.handle)).toEqual(["h-a"]);
    expect(serverDb.saved.at(-1)?.lastRunAt).toBe(previous.lastRunAt);
    expect(serverDb.saved.at(-1)?.databases["db-a"]).toMatchObject({ ok: true });
    expect(logs).toContain("Maintenance stopped for shutdown");
    expect(await maintenance.check()).toBeUndefined();
  });

  it("runs once at a time", async () => {
    const stub = stubDriver();
    const serverDb = stubServerDb();
    const maintenance = runner(stub, serverDb, () => new Date("2026-06-01T04:00:00.000Z"));
    const [first, second] = await Promise.all([maintenance.runNow(), maintenance.runNow()]);
    expect(first).toBe(second);
    expect(stub.calls.filter((call) => call.op === "database.purge")).toHaveLength(2);
    expect(await maintenance.check()).toBeUndefined();
  });
});

