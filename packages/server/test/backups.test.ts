// Backups of a running server (Back up now, and the daily maintenance) and
// of a stopped one (the backup command): what a set holds, how sets are
// named, listed and removed, and what is refused.

import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listSets, readManifest } from "../src/backups/sets.js";
import { dataPaths } from "../src/data-dir.js";
import { ServerDb } from "../src/store/server-db.js";
import { fakeHarness, startTestServer, type LoginHarness, type TestServer } from "./harness.js";
import { expectExit, runMain, scriptedIo, tempDir } from "./helpers.js";

const LEVEL_3 = fileURLToPath(new URL("./fixtures/level-3/data", import.meta.url));
const LEVEL_3_NOTES = join(LEVEL_3, "databases", "aff92d0b-5dfe-454f-86d1-eb4e209f5916.cromdb");

/** Every file under folder, by path, with its SHA-256: what must not change. */
function fingerprint(folder: string): Record<string, string> {
  return Object.fromEntries(filesIn(folder).map((file) => [file, sha256(join(folder, file))]));
}

const SET_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/;
const posix = process.platform !== "win32";

let h: LoginHarness;
beforeAll(async () => {
  h = await fakeHarness();
});
afterAll(() => h.close());

let t: TestServer;
afterEach(async () => {
  await t.close();
});

/** A server with backups on, the admin logged in, and a database "Notes" holding one document. */
async function withNotes(options: Parameters<typeof startTestServer>[1] = {}) {
  t = await startTestServer(h, { backups: true, ...options });
  const admin = t.browser();
  expect((await admin.login(h, h.users.admin)).status).toBe(302);
  const databaseId = (await admin.api("POST", "/api/v0/databases", { name: "Notes" })).body.databaseId as string;
  const made = await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "Kept" } });
  expect(made.status).toBe(201);
  return { admin, databaseId, documentId: made.body.id as string };
}

/**
 * Back up now, as the page does: the run starts and the answer comes at
 * once; then, once it has finished, the list. Gives the start's answer, the
 * list, and the set it made.
 */
async function backUpNow(browser: ReturnType<TestServer["browser"]>) {
  const started = await browser.api("POST", "/api/v0/server/backups");
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  await t.server.backups.settled();
  const list = (await browser.api("GET", "/api/v0/server/backups")).body;
  return { started: started.body, list, set: list.sets.find((set: { name: string }) => set.name === started.body.name) };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under folder, relative, with forward slashes, sorted. */
function filesIn(folder: string, prefix = ""): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesIn(join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}

describe("Back up now", () => {
  it("makes a set holding every file the server holds, with a manifest, readable by the server's user only", async () => {
    const { admin, databaseId, documentId } = await withNotes();
    const { started, set, list } = await backUpNow(admin);
    expect(started).toEqual({ running: true, trigger: "manual", startedAt: expect.any(String), name: expect.stringMatching(SET_NAME) });
    expect(set).toMatchObject({ trigger: "manual", databases: 1, skipped: [], startedAt: started.startedAt });
    expect(list).toMatchObject({ running: false, current: null, last: { ok: true, trigger: "manual", name: started.name } });
    expect(t.logs).toContain(`Back up now, asked for by ${t.server.directory.index.byEmail(h.users.admin.email)[0]?.person.personId}`);
    const made = { body: set };

    const folder = join(t.backupsDir, made.body.name as string);
    const record = t.server.serverDb.databases().find((entry) => entry.databaseId === databaseId);
    expect(filesIn(folder)).toEqual(["databases/" + record?.file, "directory.cromdb", "manifest.json", "server.cromdb"].sort());

    const manifest = readManifest(folder);
    expect(manifest).toMatchObject({
      format: 1,
      kind: "cromdb-server-backup",
      name: made.body.name,
      trigger: "manual",
      serverId: t.server.serverDb.identity.serverId,
      deploymentId: t.server.serverDb.identity.deploymentId,
      serverName: "Test <Server>",
      skipped: [],
    });
    expect(manifest?.files.map((file) => [file.role, file.path])).toEqual([
      ["server", "server.cromdb"],
      ["directory", "directory.cromdb"],
      ["database", `databases/${record?.file}`],
    ]);
    expect(manifest?.files.find((file) => file.role === "database")).toMatchObject({ databaseId, name: "Notes", file: record?.file });
    for (const file of manifest?.files ?? []) {
      const path = join(folder, file.path);
      expect(file.sha256, file.path).toBe(sha256(path));
      expect(file.bytes, file.path).toBe(statSync(path).size);
    }
    expect(made.body.bytes).toBe(manifest?.files.reduce((sum, file) => sum + file.bytes, 0));
    if (posix) {
      for (const path of [folder, join(folder, "databases")]) expect(statSync(path).mode & 0o777, path).toBe(0o700);
      for (const file of filesIn(folder)) expect(statSync(join(folder, file)).mode & 0o777, file).toBe(0o600);
    }

    // Each file is an engine backup of the replica the server serves.
    const driver = createLevel4Driver();
    try {
      const file = manifest?.files.find((entry) => entry.role === "database");
      const opened = await driver.call("database.open", { storage: { kind: "sqlite", path: join(folder, file?.path ?? "") } });
      expect([opened.databaseId, opened.instanceId]).toEqual([databaseId, file?.instanceId]);
      // The database's readers are the person who made it; "cromdb-server" is only an admin.
      const adminId = t.server.directory.index.byEmail(h.users.admin.email)[0]?.person.personId ?? "";
      const on = { handle: opened.handle, principal: { id: adminId } };
      expect((await driver.call("sync.state", on)).backupOf).toBe(file?.instanceId);
      expect((await driver.call("documents.get", { ...on, id: documentId })).document?.content).toEqual({ title: "Kept" });
    } finally {
      await driver.shutdown();
    }
  });

  it("lists the sets newest first with the last run, and keeps only the newest backupKeep", async () => {
    const { admin } = await withNotes();
    await t.restart(async () => {
      expectExit(await runMain(["config", "set", "backupKeep", "2", "--data", t.dataDir]), 0);
    });
    const again = t.browser();
    await again.login(h, h.users.admin);
    const names: string[] = [];
    for (let n = 0; n < 3; n++) {
      names.push((await backUpNow(again)).started.name as string);
    }
    // Three runs in one second are told apart.
    expect(new Set(names).size).toBe(3);
    const list = await again.api("GET", "/api/v0/server/backups");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ enabled: true, folder: t.backupsDir, keep: 2, running: false, last: { ok: true, trigger: "manual", name: names[2], skipped: 0 } });
    expect(list.body.sets.map((set: { name: string }) => set.name)).toEqual([names[2], names[1]]);
    expect(list.body.space).toEqual({ totalBytes: expect.any(Number), freeBytes: expect.any(Number) });
    expect(existsSync(join(t.backupsDir, names[0] ?? ""))).toBe(false);
    expect(t.logs).toContain(`Removed the backup ${names[0]}: only the newest 2 are kept (backupKeep)`);
    void admin;
  });

  it("joins a run already going", async () => {
    const { admin } = await withNotes();
    const [first, second] = await Promise.all([admin.api("POST", "/api/v0/server/backups"), admin.api("POST", "/api/v0/server/backups")]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body).toEqual(first.body);
    // While it runs, the list says so.
    expect((await admin.api("GET", "/api/v0/server/backups")).body).toMatchObject({ running: true, current: first.body });
    await t.server.backups.settled();
    expect(readdirSync(t.backupsDir)).toEqual([first.body.name]);
    expect(t.logs.filter((line) => line.startsWith("Back up now, asked for by ")).some((line) => line.endsWith(": joins the backup under way"))).toBe(true);
  });

  it("makes a database asked for while a run holds the registry only once the run lets go", async () => {
    const { admin } = await withNotes();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = t.server.databases.whileUnchanged(() => gate);
    const creating = admin.api("POST", "/api/v0/databases", { name: "Later" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.server.databases.list().map((state) => state.record.name)).toEqual(["Notes"]);
    release();
    await held;
    expect((await creating).status).toBe(201);
    expect(t.server.databases.list().map((state) => state.record.name).sort()).toEqual(["Later", "Notes"]);
  });

  it("leaves folders that aren't sets alone, and removes what a run that didn't finish left", async () => {
    const { admin } = await withNotes();
    mkdirSync(join(t.backupsDir, "notes"), { recursive: true });
    mkdirSync(join(t.backupsDir, "2026-01-01T00-00-00Z.partial", "databases"), { recursive: true });
    mkdirSync(join(t.backupsDir, "2026-01-02T00-00-00Z"), { recursive: true });
    const made = { body: (await backUpNow(admin)).started };
    expect(readdirSync(t.backupsDir).sort()).toEqual(["2026-01-02T00-00-00Z", made.body.name, "notes"].sort());
    expect(t.logs).toContain(`Removed ${join(t.backupsDir, "2026-01-01T00-00-00Z.partial")}, a backup that didn't finish`);
    // A folder without a manifest isn't a set: it isn't listed, and never removed.
    expect(listSets(t.backupsDir).map((set) => set.name)).toEqual([made.body.name]);
  });

  it("refuses to start when the files won't fit, with 507, writing nothing", async () => {
    const { admin } = await withNotes({ fileSystemSpace: () => ({ totalBytes: 100_000_000, freeBytes: 1_000 }) });
    const refused = await admin.api("POST", "/api/v0/server/backups");
    expect(refused.status).toBe(507);
    expect(refused.body.error.code).toBe("BACKUP_NO_SPACE");
    expect(refused.body.error.message.startsWith(`Not enough free space in ${t.backupsDir}: `)).toBe(true);
    expect(refused.body.error.message).toMatch(/: the backup needs about \d+\.\d MB, and 0\.0 MB is free$/);
    expect(readdirSync(t.backupsDir)).toEqual([]);
    const list = await admin.api("GET", "/api/v0/server/backups");
    // Refused before it started: not a run, so not the last one.
    expect(list.body).toMatchObject({ running: false, last: null, space: { totalBytes: 100_000_000, freeBytes: 1_000 } });
    const status = await admin.api("GET", "/api/v0/server/status");
    expect(status.body.backups).toMatchObject({ enabled: true, last: null });
    expect(status.body.dataSpace).toEqual({ totalBytes: 100_000_000, freeBytes: 1_000 });
  });

  it("records a failure after the start as the last run, leaving nothing", async () => {
    // Room when the run starts, none by the time it checks again.
    let asked = 0;
    const { admin } = await withNotes({ fileSystemSpace: () => ({ totalBytes: 100_000_000, freeBytes: ++asked === 1 ? 50_000_000 : 1_000 }) });
    const { started, list } = await backUpNow(admin);
    expect(started.running).toBe(true);
    expect(list.last).toMatchObject({ ok: false, trigger: "manual", error: expect.stringContaining("Not enough free space") });
    expect(list.sets).toEqual([]);
    expect(readdirSync(t.backupsDir)).toEqual([]);
    expect((await admin.api("GET", "/api/v0/server/status")).body.backups.last).toMatchObject({ ok: false });
  });

  it("leaves out, and names, a database it can't back up", async () => {
    const { admin, databaseId } = await withNotes();
    const file = t.server.serverDb.databases().find((entry) => entry.databaseId === databaseId)?.file ?? "";
    await t.restart(async () => {
      rmSync(join(t.dataDir, "databases", file));
    });
    const again = t.browser();
    await again.login(h, h.users.admin);
    const made = { body: (await backUpNow(again)).set };
    expect(made.body).toMatchObject({ databases: 0, skipped: [{ databaseId, name: "Notes", reason: expect.stringMatching(/^It is unavailable: /) }] });
    expect((await again.api("GET", "/api/v0/server/backups")).body.last).toMatchObject({ ok: true, skipped: 1 });
    void admin;
  });

  it("is off without a backups folder, and only for server admins", async () => {
    t = await startTestServer(h);
    const admin = t.browser();
    await admin.login(h, h.users.admin);
    expect(t.logs).toContain("Backups are off: there is no backups folder (--backups, or CROMDB_BACKUPS)");
    const list = await admin.api("GET", "/api/v0/server/backups");
    expect(list.body).toEqual({ enabled: false, folder: null, keep: 7, running: false, current: null, last: null, space: null, sets: [] });
    const refused = await admin.api("POST", "/api/v0/server/backups");
    expect([refused.status, refused.body.error.code]).toEqual([409, "BACKUPS_OFF"]);
    expect((await admin.api("GET", "/api/v0/server/status")).body.backups).toEqual({ enabled: false, last: null, space: null });

    expect((await admin.api("POST", "/api/v0/invitations", { email: h.users.invited.email })).status).toBe(201);
    const person = t.browser();
    expect((await person.login(h, h.users.invited)).status).toBe(302);
    expect((await person.api("GET", "/api/v0/server/backups")).status).toBe(403);
    expect((await person.api("POST", "/api/v0/server/backups")).status).toBe(403);
  });
});

describe("the daily maintenance", () => {
  it("backs up first, as a scheduled set", async () => {
    await withNotes();
    const record = await t.server.maintenance.runNow();
    const [set] = listSets(t.backupsDir);
    expect(set).toMatchObject({ trigger: "scheduled", databases: 1 });
    expect(t.server.backups.last).toMatchObject({ ok: true, trigger: "scheduled", name: set?.name });
    expect(Object.keys(record.databases)).toHaveLength(3);
    const backedUp = t.logs.findIndex((line) => line.startsWith("Backed up to "));
    const purged = t.logs.findIndex((line) => line.startsWith("Purged "));
    expect(backedUp).toBeGreaterThan(-1);
    expect(backedUp).toBeLessThan(purged);
  });
});

describe("cromdb-server backup", () => {
  it("backs up a stopped server, refuses while it runs, and never removes older sets", async () => {
    await withNotes();
    const into = tempDir();
    try {
      const running = await runMain(["backup", "--data", t.dataDir, "--to", into.path]);
      expectExit(running, 1);
      expect(running.io.errors.join("\n")).toContain("The server is running, or another command is using this data directory. Stop it first.");
      expect(readdirSync(into.path)).toEqual([]);

      await t.restart(async () => {
        expectExit(await runMain(["config", "set", "backupKeep", "1", "--data", t.dataDir]), 0);
        for (let n = 0; n < 2; n++) {
          const made = await runMain(["backup", "--data", t.dataDir, "--to", into.path]);
          expectExit(made, 0);
          expect(made.io.lines).toContainEqual(expect.stringMatching(/^Backed up to .+: 1 databases, \d+\.\d MB, 0 left out, \d+\.\d s$/));
        }
        // From CROMDB_BACKUPS when --to isn't given.
        expectExit(await runMain(["backup", "--data", t.dataDir], scriptedIo({ env: { CROMDB_BACKUPS: into.path } })), 0);
      });
      const sets = listSets(into.path);
      expect(sets.map((set) => set.trigger)).toEqual(["command", "command", "command"]);
      // The command records nothing: a backup never changes the data.
      expect(t.server.serverDb.lastBackup).toBeUndefined();
    } finally {
      into.remove();
    }
  });

  it("never raises: refuses a data directory an older server made, leaving every file as it was", async () => {
    t = await startTestServer(h);
    const dir = tempDir();
    try {
      const data = dir.join("data");
      cpSync(LEVEL_3, data, { recursive: true });
      const before = fingerprint(data);
      const result = await runMain(["backup", "--data", data, "--to", dir.join("backups")]);
      expectExit(result, 1);
      expect(result.io.errors.join("\n")).toBe(
        "The server database was made by an older server (level 3). This server would convert it, and a backup never changes the data: back it up with the version that made it (the image it came from), before upgrading.",
      );
      expect(fingerprint(data)).toEqual(before);
      expect(existsSync(dir.join("backups"))).toBe(false);
    } finally {
      dir.remove();
    }
  });

  it("leaves out, and names, a database an older server made, and changes no file", async () => {
    await withNotes();
    const paths = dataPaths(t.dataDir);
    const into = tempDir();
    try {
      await t.restart(async () => {
        // A level-3 database, registered as an older server would have left it.
        copyFileSync(LEVEL_3_NOTES, join(paths.databases, "old.cromdb"));
        const driver = createLevel4Driver();
        const serverDb = await ServerDb.open(driver, paths.serverDb);
        await serverDb.addDatabase({ databaseId: "level-3-db", name: "Old notes", file: "old.cromdb", createdAt: new Date().toISOString(), createdBy: "someone", home: serverDb.identity.serverId });
        await serverDb.close();
        await driver.shutdown();

        const before = fingerprint(t.dataDir);
        const made = await runMain(["backup", "--data", t.dataDir, "--to", into.path]);
        expectExit(made, 0);
        expect(fingerprint(t.dataDir)).toEqual(before);
      });
      const [set] = listSets(into.path);
      expect(set).toMatchObject({ trigger: "command", databases: 1 });
      expect(set?.skipped).toEqual([
        {
          databaseId: "level-3-db",
          name: "Old notes",
          reason:
            'It is unavailable: Database "Old notes" was made by an older server (level 3). This server would convert it, and a backup never changes the data: back it up with the version that made it (the image it came from), before upgrading.',
        },
      ]);
    } finally {
      into.remove();
    }
  });

  it("needs a folder", async () => {
    t = await startTestServer(h);
    await t.restart(async () => {
      const result = await runMain(["backup", "--data", t.dataDir], scriptedIo({ env: {} }));
      expectExit(result, 2);
      expect(result.io.errors[0]).toBe("--to DIR is needed, or CROMDB_BACKUPS: the folder to back up into");
    });
  });
});
