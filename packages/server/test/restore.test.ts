// Restoring from backup sets: a whole server with the restore command, into
// an empty data directory, and one database of a running server through the
// API. A restored copy always gets a new instance ID, with the one it was a
// backup of retired.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { restoreServer } from "../src/backups/restore.js";
import { listSets } from "../src/backups/sets.js";
import { REPLACED_KEEP_DAYS } from "../src/databases.js";
import { fakeHarness, startTestServer, type LoginHarness, type TestBrowser, type TestServer } from "./harness.js";
import { expectExit, runMain, tempDir } from "./helpers.js";

const DAY_MS = 86_400_000;

let h: LoginHarness;
beforeAll(async () => {
  h = await fakeHarness();
});
afterAll(() => h.close());

let t: TestServer;
afterEach(async () => {
  await t.close();
});

/** A server with backups on, the admin logged in, someone invited, and "Notes" holding "Kept". */
async function withNotes() {
  t = await startTestServer(h, { backups: true });
  const admin = t.browser();
  expect((await admin.login(h, h.users.admin)).status).toBe(302);
  expect((await admin.api("POST", "/api/v0/invitations", { email: h.users.invited.email })).status).toBe(201);
  const databaseId = (await admin.api("POST", "/api/v0/databases", { name: "Notes" })).body.databaseId as string;
  const made = await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "Kept" } });
  return { admin, databaseId, documentId: made.body.id as string, version: made.headers.get("etag") ?? "" };
}

/** Back up now, and the set it made, once it has finished. */
async function backUp(admin: TestBrowser): Promise<string> {
  const started = await admin.api("POST", "/api/v0/server/backups");
  expect(started.status).toBe(202);
  await t.server.backups.settled();
  expect(t.server.backups.last).toMatchObject({ ok: true, name: started.body.name });
  return started.body.name as string;
}

/** Each replica a database's copy lists: instance ID to status. */
async function replicaStatuses(handle: string): Promise<Record<string, string>> {
  const { replicas } = await t.server.databases.driver.call("replicas.list", { handle, principal: { id: "cromdb-server" } });
  return Object.fromEntries(replicas.map((replica) => [replica.instanceId, replica.status]));
}

/** The instance ID of each file the server holds: the server database, the directory, and each database by ID. */
async function instanceIds(): Promise<Record<string, string>> {
  const { driver } = t.server.databases;
  const of = async (handle: string) => (await driver.call("database.info", { handle })).instanceId;
  const result: Record<string, string> = {
    server: await of(t.server.serverDb.handle),
  };
  for (const state of t.server.databases.list()) {
    if (state.status === "open") result[state.record.databaseId] = await of(state.handle);
  }
  return result;
}

describe("cromdb-server restore", () => {
  it("puts a whole server back with its identity, new instance IDs, the old ones retired, and every session ended", async () => {
    const { admin, databaseId, documentId } = await withNotes();
    const name = await backUp(admin);
    const before = await instanceIds();
    const set = join(t.backupsDir, name);
    const peopleBefore = t.server.directory.index.all().map((entry) => entry.person.email).sort();
    const identity = t.server.serverDb.identity;

    await t.restart(async () => {
      renameSync(t.dataDir, `${t.dataDir}-old`);
      const restored = await runMain(["restore", "--data", t.dataDir, "--from", set]);
      expectExit(restored, 0);
      expect(restored.io.lines).toContain(`Restored ${t.dataDir} from the set ${name} (backed up ${listSets(t.backupsDir)[0]?.finishedAt}): the server database, the directory and 1 databases.`);
      expect(restored.io.lines).toContain("Each has a new instance ID, and the one it was a backup of is retired. 1 sessions were ended: everyone logs in again.");
    });

    // The same server: its identity, people and documents.
    expect(t.server.serverDb.identity).toEqual(identity);
    expect(t.server.directory.index.all().map((entry) => entry.person.email).sort()).toEqual(peopleBefore);
    // The session from before the backup no longer works.
    const oldSession = t.browser();
    oldSession.setCookie("cromdb-session", admin.cookie("cromdb-session") ?? "");
    expect((await oldSession.api("GET", "/api/v0/me")).status).toBe(401);
    const again = t.browser();
    expect((await again.login(h, h.users.admin)).status).toBe(302);
    const read = await again.api("GET", `/api/v0/databases/${databaseId}/documents/${documentId}`);
    expect(read.body.content).toEqual({ title: "Kept" });

    // Every file has a new instance ID, and lists the old one as retired.
    const after = await instanceIds();
    for (const key of Object.keys(before)) {
      expect(after[key], key).not.toBe(before[key]);
    }
    const state = t.server.databases.get(databaseId);
    if (state?.status !== "open") throw new Error("Notes isn't open");
    expect(await replicaStatuses(state.handle)).toEqual({ [before[databaseId] ?? ""]: "retired", [after[databaseId] ?? ""]: "active" });

    // It takes writes.
    expect((await again.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "After" } })).status).toBe(201);

    // The same set restored again gets instance IDs of its own once more.
    const second = tempDir();
    const driver = createLevel4Driver();
    try {
      const done = await restoreServer({ driver, from: set, dataDir: second.join("data"), now: () => new Date(), log: () => {} });
      const file = done.manifest.files.find((entry) => entry.role === "database");
      expect(done.instances[file?.path ?? ""]).not.toBe(after[databaseId]);
      expect(done.instances[file?.path ?? ""]).not.toBe(before[databaseId]);
    } finally {
      await driver.shutdown();
      second.remove();
    }
  });

  it("checks a set without writing anything, and refuses a damaged one or a data directory that isn't empty", async () => {
    const { admin } = await withNotes();
    const name = await backUp(admin);
    const set = join(t.backupsDir, name);
    const into = tempDir();
    try {
      const checked = await runMain(["restore", "--check", "--from", set]);
      expectExit(checked, 0);
      expect(checked.io.lines[0]).toMatch(new RegExp(`^The set ${name} is whole and restores: the server database, the directory and 1 databases, as backed up `));

      const busy = await runMain(["restore", "--data", t.dataDir, "--from", set]);
      expectExit(busy, 1);
      expect(busy.io.errors[0]).toBe(`${t.dataDir} isn't empty. A server is restored into an empty data directory: empty it first, as the guide shows.`);

      // One byte changed in the database's copy.
      const file = readdirSync(join(set, "databases"))[0] ?? "";
      const path = join(set, "databases", file);
      const bytes = readFileSync(path);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      writeFileSync(path, bytes);
      const damaged = await runMain(["restore", "--data", into.join("data"), "--from", set]);
      expectExit(damaged, 1);
      expect(damaged.io.errors[0]).toBe(`databases/${file} in the set ${name} doesn't match its manifest: it was changed or damaged since the backup`);
      expect(existsSync(into.join("data"))).toBe(false);
      expectExit(await runMain(["restore", "--check", "--from", set]), 1);

      expectExit(await runMain(["restore", "--check"]), 2);
      expectExit(await runMain(["restore", "--from", set], { ...(await import("./helpers.js")).scriptedIo({ env: {} }) }), 2);
      expectExit(await runMain(["restore", "--check", "--from", into.path]), 1);
    } finally {
      into.remove();
    }
  });
});

describe("restoring one database", () => {
  it("puts the set's copy in place with a new instance ID, keeping the live file aside", async () => {
    const { admin, databaseId, documentId, version } = await withNotes();
    const name = await backUp(admin);
    const oldInstance = (await instanceIds())[databaseId] ?? "";
    // Written after the backup: only the live file has these.
    expect((await admin.api("PUT", `/api/v0/databases/${databaseId}/documents/${documentId}`, { content: { title: "Changed" } }, { "if-match": version })).status).toBe(200);
    const later = (await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "Later" } })).body.id as string;

    const detail = await admin.api("GET", `/api/v0/server/backups/${name}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name, databases: 1, contents: [{ databaseId, name: "Notes", bytes: expect.any(Number), onServer: true }] });

    const restored = await admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
    expect(restored.status).toBe(200);
    const file = t.server.serverDb.databases().find((record) => record.databaseId === databaseId)?.file ?? "";
    expect(restored.body).toEqual({
      databaseId,
      name: "Notes",
      instanceId: expect.any(String),
      retired: oldInstance,
      replaced: expect.stringMatching(new RegExp(`^databases/replaced/${file.replace(".", "\\.")}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z$`)),
      registered: false,
    });
    expect(restored.body.instanceId).not.toBe(oldInstance);
    expect(existsSync(join(t.dataDir, restored.body.replaced))).toBe(true);
    expect(t.logs).toContainEqual(expect.stringMatching(new RegExp(`^Database ${databaseId} \\("Notes"\\) restored by \\S+ from the backup ${name}: instance `)));

    expect((await admin.api("GET", `/api/v0/databases/${databaseId}/documents/${documentId}`)).body.content).toEqual({ title: "Kept" });
    expect((await admin.api("GET", `/api/v0/databases/${databaseId}/documents/${later}`)).status).toBe(404);
    const state = t.server.databases.get(databaseId);
    if (state?.status !== "open") throw new Error("Notes isn't open");
    expect(await replicaStatuses(state.handle)).toEqual({ [oldInstance]: "retired", [restored.body.instanceId]: "active" });
    expect((await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "After" } })).status).toBe(201);

    // It survives a restart as the database's file.
    await t.restart();
    expect((await instanceIds())[databaseId]).toBe(restored.body.instanceId);
  });

  it("answers requests that meet a restore with 503 DATABASE_RESTORING, never a fault", async () => {
    const { admin, databaseId, documentId } = await withNotes();
    const name = await backUp(admin);
    const path = `/api/v0/databases/${databaseId}/documents/${documentId}`;
    // Gates on driver calls: a request held inside its documents.get, and the
    // restore held at its adopt, after it has closed the live file.
    const { driver } = t.server.databases;
    const original = driver.call;
    const gates = new Map<string, { reached: () => void; release: Promise<void> }>();
    const gate = (op: string) => {
      let reached!: () => void;
      let release!: () => void;
      const at = new Promise<void>((resolve) => (reached = resolve));
      gates.set(op, { reached, release: new Promise<void>((resolve) => (release = resolve)) });
      return { at, release };
    };
    driver.call = (async (op: string, input: unknown) => {
      const held = gates.get(op);
      if (held !== undefined) {
        gates.delete(op);
        held.reached();
        await held.release;
      }
      return original(op as never, input as never);
    }) as typeof driver.call;
    try {
      const inFlight = gate("documents.get");
      const reading = admin.api("GET", path);
      await inFlight.at;
      const adopting = gate("database.adopt");
      const restoring = admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
      await adopting.at;

      // In flight: its handle was closed under it.
      inFlight.release();
      const met = await reading;
      expect([met.status, met.body.error?.code, met.headers.get("retry-after")]).toEqual([503, "DATABASE_RESTORING", "1"]);
      expect(met.body.error.message).toBe("This database is being restored. Try again in a moment.");
      // Arriving while the restore holds the database.
      const arriving = await admin.api("GET", path);
      expect([arriving.status, arriving.body.error?.code, arriving.headers.get("retry-after")]).toEqual([503, "DATABASE_RESTORING", "1"]);
      expect((await admin.api("GET", `/api/v0/databases/${databaseId}/replicas`)).status).toBe(503);

      adopting.release();
      expect((await restoring).status).toBe(200);
      expect((await admin.api("GET", path)).status).toBe(200);
    } finally {
      driver.call = original;
    }

    // Without gates: requests racing a restore get the restored copy or 503.
    const statuses = new Set<number>();
    const restore = admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
    let done = false;
    void restore.finally(() => (done = true));
    while (!done) {
      for (const answer of await Promise.all(Array.from({ length: 8 }, () => admin.api("GET", path)))) {
        statuses.add(answer.status);
      }
    }
    expect((await restore).status).toBe(200);
    expect([...statuses].filter((status) => status !== 200 && status !== 503)).toEqual([]);
    expect(t.logs.filter((line) => line.includes(" failed: "))).toEqual([]);
  });

  it("refuses a damaged copy, a set or database it doesn't have, and leaves the database as it was", async () => {
    const { admin, databaseId, documentId, version } = await withNotes();
    const name = await backUp(admin);
    expect((await admin.api("PUT", `/api/v0/databases/${databaseId}/documents/${documentId}`, { content: { title: "Changed" } }, { "if-match": version })).status).toBe(200);

    expect((await admin.api("GET", "/api/v0/server/backups/2020-01-01T00-00-00Z")).status).toBe(404);
    expect((await admin.api("GET", "/api/v0/server/backups/..")).status).toBe(404);
    expect((await admin.api("POST", "/api/v0/server/backups/2020-01-01T00-00-00Z/restore", { databaseId })).status).toBe(404);
    const missing = await admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId: "not-in-the-set" });
    expect([missing.status, missing.body.error.code]).toEqual([404, "NOT_FOUND"]);

    const set = join(t.backupsDir, name, "databases");
    const path = join(set, readdirSync(set)[0] ?? "");
    const bytes = readFileSync(path);
    bytes[100] = (bytes[100] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);
    const refused = await admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
    expect([refused.status, refused.body.error.code]).toEqual([409, "RESTORE_REFUSED"]);
    expect(refused.body.error.message).toMatch(/doesn't match its manifest/);
    expect((await admin.api("GET", `/api/v0/databases/${databaseId}/documents/${documentId}`)).body.content).toEqual({ title: "Changed" });
    expect(existsSync(join(t.dataDir, "databases", "replaced"))).toBe(false);

    expect((await admin.api("POST", "/api/v0/invitations", { email: h.users.uninvited.email })).status).toBe(201);
    const person = t.browser();
    expect((await person.login(h, h.users.uninvited)).status).toBe(302);
    expect((await person.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId })).status).toBe(403);
  });

  it("adds back a database the server doesn't have, under its name in the set", async () => {
    const { admin, databaseId } = await withNotes();
    const name = await backUp(admin);
    const source = join(t.backupsDir, name);
    const other = t;
    t = await startTestServer(h, { backups: true });
    try {
      const otherAdmin = t.browser();
      expect((await otherAdmin.login(h, h.users.admin)).status).toBe(302);
      // The set, brought into this server's backups folder.
      (await import("node:fs")).cpSync(source, join(t.backupsDir, name), { recursive: true });
      const detail = await otherAdmin.api("GET", `/api/v0/server/backups/${name}`);
      expect(detail.body.contents).toEqual([{ databaseId, name: "Notes", bytes: expect.any(Number), onServer: false }]);
      const restored = await otherAdmin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({ name: "Notes", replaced: null, registered: true });
      expect(t.server.serverDb.databases().map((record) => record.name)).toEqual(["Notes"]);
      expect(t.server.databases.get(databaseId)?.status).toBe("open");
    } finally {
      await t.close();
      t = other;
    }
  });

  it(`removes a replaced file after ${REPLACED_KEEP_DAYS} days, at maintenance`, async () => {
    const { admin, databaseId } = await withNotes();
    const name = await backUp(admin);
    const restored = await admin.api("POST", `/api/v0/server/backups/${name}/restore`, { databaseId });
    const kept = join(t.dataDir, restored.body.replaced);
    t.clockMs = (REPLACED_KEEP_DAYS - 1) * DAY_MS;
    await t.server.maintenance.runNow();
    expect(existsSync(kept)).toBe(true);
    t.clockMs = (REPLACED_KEEP_DAYS + 1) * DAY_MS;
    await t.server.maintenance.runNow();
    expect(existsSync(kept)).toBe(false);
    expect(t.logs).toContain(`Removed ${restored.body.replaced}: a file a restore replaced, kept ${REPLACED_KEEP_DAYS} days`);
  });
});
