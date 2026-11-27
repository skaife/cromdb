import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { fakeFetch, type Answer, type Sent } from "./fake-server.ts";
import { Routed } from "./routed.tsx";

const ADA = { personId: "p-ada", displayName: "Ada Admin", email: "ada@example.com", serverAdmin: true, serverName: "office-1" };
const SAVED = {
  serverName: "office-1",
  publicUrl: "https://office-1.example.org",
  listen: "0.0.0.0:8443",
  tls: { certFile: "/data/tls/fullchain.pem", keyFile: "/data/tls/privkey.pem" },
  trustProxy: false,
  oidcIssuer: "https://login.example.org/realms/office",
  oidcClientId: "cromdb",
  sessionIdleMinutes: 720,
  sessionMaxDays: 7,
  serverDbPurgeAfterDays: 7,
  maintenanceHour: 3,
  maintenanceTimeZone: null,
  updateCheck: false,
  backupKeep: 7,
};
const VIEW = {
  saved: SAVED,
  running: SAVED,
  restartKeys: ["publicUrl", "listen", "tls", "trustProxy", "oidcIssuer", "oidcClientId"],
  clientSecretSet: true,
  clientSecretWaiting: false,
  listenFixed: null,
  certificate: { validUntil: "2027-02-18T12:00:00.000Z" },
  canRestart: false,
  serverTimeZone: "America/Los_Angeles",
  lastMaintenance: { at: "2026-11-20T11:00:00.000Z", ok: true },
};
const STATUS = {
  serverName: "office-1",
  publicUrl: "https://office-1.example.org",
  versions: { server: "0.2.0", driver: "0.2.0", engine: "0.8.0" },
  startedAt: "2026-11-20T08:02:00.000Z",
  databases: { available: 4, unavailable: [{ databaseId: "d-old", name: "Old inventory", reason: "level 2 database; this server opens level 4 only", since: "2026-11-20T08:02:00.000Z" }] },
  maintenance: {
    lastRunAt: "2026-11-20T11:00:00.000Z",
    nextDueAt: "2026-11-21T11:00:00.000Z",
    hour: 3,
    zone: "America/Los_Angeles",
    databases: [
      { databaseId: "s", what: "the server database", at: "2026-11-20T11:00:01.000Z", ok: true, tombstones: 12, entries: 0 },
      { databaseId: "d-1", what: 'database "Sales tickets"', at: "2026-11-20T11:00:02.000Z", ok: false, error: "disk full" },
    ],
  },
  update: { state: "off", checkedAt: null, latest: null, changesUrl: null },
  backups: {
    enabled: true,
    last: { at: "2026-11-20T11:00:00.000Z", ok: true, trigger: "scheduled", name: "2026-11-20T10-59-58Z", bytes: 4_200_000, skipped: 0 },
    space: { totalBytes: 50_000_000_000, freeBytes: 12_300_000_000 },
  },
  dataSpace: { totalBytes: 50_000_000_000, freeBytes: 12_400_000_000 },
};
const SET = {
  name: "2026-11-20T10-59-58Z",
  trigger: "scheduled",
  startedAt: "2026-11-20T10:59:58.000Z",
  finishedAt: "2026-11-20T11:00:00.000Z",
  bytes: 4_200_000,
  databases: 4,
  skipped: [],
};
const BACKUPS = {
  enabled: true,
  folder: "/backups",
  keep: 7,
  running: false,
  current: null,
  last: STATUS.backups.last,
  space: STATUS.backups.space,
  sets: [{ ...SET, name: "2026-11-21T09-00-00Z", trigger: "manual", skipped: [{ databaseId: "d-old", name: "Old inventory", reason: "It is unavailable" }], databases: 3 }, SET],
};

function start(path: string, routes: Record<string, Answer | ((sent: Sent) => Answer)> = {}) {
  const server = fakeFetch({
    "GET /api/v0/me": { body: ADA },
    "GET /api/v0/server/settings": { body: VIEW, headers: { etag: '"settings-v1"' } },
    "GET /api/v0/server/status": { body: STATUS },
    ...routes,
  });
  vi.stubGlobal("fetch", server.fetch);
  render(
    <Routed path={path}>
      <App />
    </Routed>,
  );
  return server;
}

const box = (name: string) => screen.getByRole("textbox", { name });

describe("Server settings", () => {
  it("shows the settings grouped, the restart ones tagged, and the certificate's expiry", async () => {
    start("/server/settings");
    expect(await screen.findByRole("group", { name: "General" })).toBeTruthy();
    expect(box("Server name")).toHaveProperty("value", "office-1");
    expect(box("Public address restart")).toHaveProperty("value", "https://office-1.example.org");
    expect(screen.getByRole("radio", { name: "Served by this server" })).toHaveProperty("checked", true);
    expect(box("Certificate file restart")).toHaveProperty("value", "/data/tls/fullchain.pem");
    expect(screen.getByText(/^Certificate valid until Feb 18, 2027\./)).toBeTruthy();
    expect(screen.getByText("Set (never shown)")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Nightly maintenance at" })).toHaveProperty("value", "3");
    expect(box("Time zone")).toHaveProperty("placeholder", "America/Los_Angeles (server's own)");
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
  });

  it("saves every setting with the version it read, and says what waits for a restart", async () => {
    const saved = { ...SAVED, sessionMaxDays: 8, oidcClientId: "next" };
    const server = start("/server/settings", {
      "PUT /api/v0/server/settings": { body: { ...VIEW, saved, running: { ...SAVED, sessionMaxDays: 8 } }, headers: { etag: '"settings-v2"' } },
    });
    const user = userEvent.setup();
    await user.clear(await screen.findByRole("textbox", { name: "Longest session (days)" }));
    await user.type(box("Longest session (days)"), "8");
    await user.clear(box("Client ID restart"));
    await user.type(box("Client ID restart"), "next");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Saved. Settings marked restart take effect when the server restarts; the rest are in effect now.")).toBeTruthy();
    const put = server.sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"settings-v1"');
    expect(put?.body).toEqual(saved);
    expect(screen.getByText("Saved, waiting for a restart. Running now: cromdb.")).toBeTruthy();
    expect(screen.getByText(/restart the server to apply them/)).toBeTruthy();
  });

  it("asks before unsaved settings are left from the menu", async () => {
    start("/server/settings", { "GET /api/v0/databases": { body: { databases: [], unavailable: [] } } });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Server name" }), "-b");
    await user.click(within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Databases" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(dialog.textContent).toContain("Your changes to the server settings will be lost.");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(box("Server name")).toHaveProperty("value", "office-1-b");
    await user.click(within(screen.getByRole("navigation", { name: "Main menu" })).getByRole("link", { name: "Databases" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { name: "Databases", level: 1 })).toBeTruthy();
  });

  it("shows the new server name in the header once it is saved", async () => {
    let name = "office-1";
    start("/server/settings", {
      "GET /api/v0/me": () => ({ body: { ...ADA, serverName: name } }),
      "PUT /api/v0/server/settings": (sent) => {
        name = (sent.body as { serverName: string }).serverName;
        const saved = { ...SAVED, serverName: name };
        return { body: { ...VIEW, saved, running: saved }, headers: { etag: '"settings-v2"' } };
      },
    });
    const user = userEvent.setup();
    expect((await screen.findByText("office-1", { selector: "strong" })).textContent).toBe("office-1");
    await user.clear(await screen.findByRole("textbox", { name: "Server name" }));
    await user.type(box("Server name"), "office-2");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("office-2", { selector: "strong" })).toBeTruthy();
  });

  it("puts the server's refusal at the setting it names", async () => {
    start("/server/settings", {
      "PUT /api/v0/server/settings": { status: 400, body: { error: { code: "INVALID_INPUT", message: "maintenanceTimeZone must be an IANA time zone", details: { path: "/maintenanceTimeZone" } } } },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Time zone" }), "Mars/Base");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("maintenanceTimeZone must be an IANA time zone")).toBeTruthy();
    expect(box("Time zone").getAttribute("aria-invalid")).toBe("true");
  });

  it("asks before a plain http address, and saves it only when told to", async () => {
    const server = start("/server/settings", {
      "PUT /api/v0/server/settings": (sent) =>
        (sent.body as { allowPlainHttp?: boolean }).allowPlainHttp === true
          ? { body: VIEW, headers: { etag: '"settings-v2"' } }
          : { status: 400, body: { error: { code: "INVALID_INPUT", message: "The public address is plain http://", details: { path: "/publicUrl", reason: "plainHttp" } } } },
    });
    const user = userEvent.setup();
    await user.clear(await screen.findByRole("textbox", { name: "Public address restart" }));
    await user.type(box("Public address restart"), "http://office-1.example.org");
    await user.click(screen.getByRole("radio", { name: "Off (plain HTTP, trusted networks only)" }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Use plain HTTP?" });
    await user.click(within(dialog).getByRole("button", { name: "Save with plain HTTP" }));
    expect(await screen.findByText(/^Saved\./)).toBeTruthy();
    const puts = server.sent.filter((s) => s.method === "PUT");
    expect(puts.map((s) => (s.body as { allowPlainHttp?: boolean }).allowPlainHttp)).toEqual([undefined, true]);
  });

  it("stops saving when someone saved meanwhile, until reloaded", async () => {
    start("/server/settings", { "PUT /api/v0/server/settings": { status: 412, body: { error: { code: "STALE_VERSION", message: "Changed" } } } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Someone saved the settings since you opened this page/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save settings" })).toHaveProperty("disabled", true);
  });

  it("replaces the client secret without ever reading it", async () => {
    const server = start("/server/settings", { "PUT /api/v0/server/client-secret": { status: 204 } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Replace the client secret" }));
    await user.type(screen.getByLabelText("Client secret restart"), "s3cret");
    await user.click(screen.getByRole("button", { name: "Save secret" }));
    expect(await screen.findByText("Replaced, waiting for a restart: the new client secret is used from the next start.")).toBeTruthy();
    expect(screen.getByText(/Some are waiting for one: restart the server to apply them\./)).toBeTruthy();
    expect(server.sent.find((s) => s.url === "/api/v0/server/client-secret")?.body).toEqual({ secret: "s3cret" });
  });

  it("counts a client secret replaced since the start as waiting, with Restart now", async () => {
    start("/server/settings", {
      "GET /api/v0/server/settings": { body: { ...VIEW, canRestart: true, clientSecretWaiting: true }, headers: { etag: '"settings-v1"' } },
    });
    expect(await screen.findByText("Replaced, waiting for a restart: the new client secret is used from the next start.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
  });

  it("shows a listen address given at the start read only, and doesn't wait for it", async () => {
    start("/server/settings", {
      "GET /api/v0/server/settings": { body: { ...VIEW, listenFixed: "0.0.0.0:8080", running: { ...SAVED, listen: "0.0.0.0:8080" } }, headers: { etag: '"settings-v1"' } },
    });
    const listen = await screen.findByRole("textbox", { name: "Listen address" });
    expect(listen).toHaveProperty("value", "0.0.0.0:8080");
    expect(listen).toHaveProperty("readOnly", true);
    expect(screen.getByText("Set when the server was started (--listen), so this setting isn't used.")).toBeTruthy();
    expect(screen.queryByText(/^Saved, waiting for a restart/)).toBeNull();
    expect(screen.queryByText(/Some are waiting for one/)).toBeNull();
  });

  it("offers Restart now when something starts the server again, after asking", async () => {
    const server = start("/server/settings", {
      "GET /api/v0/server/settings": { body: { ...VIEW, canRestart: true, saved: { ...SAVED, oidcClientId: "next" } }, headers: { etag: '"settings-v1"' } },
      "POST /api/v0/server/restart": { status: 202, body: { restarting: true } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Restart now" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Restart the server?" })).getByRole("button", { name: "Restart now" }));
    expect(await screen.findByText("Restarting. This page reloads when the server answers again.")).toBeTruthy();
    expect(server.sent.some((s) => s.method === "POST" && s.url === "/api/v0/server/restart")).toBe(true);
  });
});

describe("Status and Servers", () => {
  const withUpdate = (update: Record<string, unknown>) => ({ "GET /api/v0/server/status": { body: { ...STATUS, update } } });

  it("says the update check is off, with the way to turn it on", async () => {
    start("/server/status");
    const updates = await screen.findByRole("region", { name: "Updates" });
    expect(updates.textContent).toBe("UpdatesUpdate check is off. Turn it on in Settings.");
    expect(within(updates).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/server/settings");
  });

  it("says when it hasn't checked yet, is up to date, or couldn't reach GitHub", async () => {
    start("/server/status", withUpdate({ state: "pending", checkedAt: null, latest: null, changesUrl: null }));
    expect((await screen.findByRole("region", { name: "Updates" })).textContent).toBe("UpdatesNot checked yet.");
    cleanup();
    start("/server/status", withUpdate({ state: "current", checkedAt: "2026-11-20T10:00:00.000Z", latest: null, changesUrl: null }));
    expect((await screen.findByRole("region", { name: "Updates" })).textContent).toMatch(/^UpdatesUp to date\. Last checked .+\.$/);
    cleanup();
    start("/server/status", withUpdate({ state: "failed", checkedAt: "2026-11-20T10:00:00.000Z", latest: null, changesUrl: null }));
    expect((await screen.findByRole("region", { name: "Updates" })).textContent).toMatch(/^UpdatesLast checked .+: could not reach GitHub\.$/);
  });

  it("shows a newer version with what changed and the steps, the Docker ones and a line for the rest", async () => {
    const changes = "https://github.com/skaife/cromdb/blob/server-v0.9.0/packages/server/CHANGELOG.md";
    start("/server/status", withUpdate({ state: "available", checkedAt: "2026-11-20T10:00:00.000Z", latest: "0.9.0", changesUrl: changes }));
    const updates = await screen.findByRole("region", { name: "Updates" });
    expect(within(updates).getByText("CromDB Server 0.9.0 is available (this server runs 0.2.0)")).toBeTruthy();
    expect(within(updates).getByRole("link", { name: "What changed" }).getAttribute("href")).toBe(changes);
    expect(within(updates).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Back up first (the guide's Backups): an older version can't open the data once a newer one has.",
      "Set CROMDB_VERSION=0.9.0 in .env.",
      "docker compose pull",
      "docker compose up -d",
    ]);
    expect(within(updates).getByRole("link", { name: "the guide's Backups" }).getAttribute("href")).toBe("https://github.com/skaife/cromdb/blob/server-v0.9.0/docker/README.md#backups");
    expect(within(updates).getByRole("link", { name: "server README" }).getAttribute("href")).toBe("https://github.com/skaife/cromdb/blob/server-v0.9.0/packages/server/README.md#upgrading");
    for (const link of within(updates).getAllByRole("link")) expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("turns the update check on from Settings, in its own group", async () => {
    const server = start("/server/settings", {
      "PUT /api/v0/server/settings": (sent) => ({ body: { ...VIEW, saved: sent.body, running: sent.body }, headers: { etag: '"settings-v2"' } }),
    });
    const user = userEvent.setup();
    const group = await screen.findByRole("group", { name: "Updates" });
    const box = within(group).getByRole("checkbox", { name: "Tell me when a newer version is published" });
    expect(box).toHaveProperty("checked", false);
    expect(within(group).getByText(/contacts github\.com about once a day/)).toBeTruthy();
    expect(within(group).queryByText("restart")).toBeNull();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Saved. In effect now.")).toBeTruthy();
    expect(server.sent.find((s) => s.method === "PUT")?.body).toMatchObject({ updateCheck: true });
  });

  it("shows the server, the databases, and each database's maintenance", async () => {
    start("/server/status");
    const server = await screen.findByRole("region", { name: "Server" });
    expect(server.textContent).toMatch(/Server 0\.2\.0 · driver 0\.2\.0 · engine 0\.8\.0/);
    expect(screen.getByRole("region", { name: "Databases" }).textContent).toMatch(/4 available, 1 unavailable/);
    expect(screen.getByRole("region", { name: "Last maintenance" }).textContent).toMatch(/12 deletions removed, 1 database failed/);
    const unavailable = within(screen.getByRole("region", { name: "Unavailable databases" })).getAllByRole("row")[1] as HTMLElement;
    expect(unavailable.textContent).toMatch(/^Old inventorylevel 2 database; this server opens level 4 onlyServer start, /);
    const failed = within(screen.getByRole("region", { name: "Maintenance by database" })).getAllByRole("row")[2] as HTMLElement;
    expect(failed.textContent).toMatch(/Failed: disk full$/);
  });

  it("shows the last backup and the free space where the data and the backups are", async () => {
    start("/server/status");
    expect((await screen.findByRole("region", { name: "Last backup" })).textContent).toMatch(/4\.2 MB/);
    const storage = screen.getByRole("region", { name: "Storage" }).textContent;
    expect(storage).toContain("Data: 12.4 GB free of 50.0 GB");
    expect(storage).toContain("Backups: 12.3 GB free of 50.0 GB");
  });

  it("lists this server alone until servers sync", async () => {
    start("/server/servers");
    const table = await screen.findByRole("table", { name: "The servers in this deployment" });
    expect((within(table).getAllByRole("row")[1] as HTMLElement).textContent).toBe("office-1 (this server)https://office-1.example.orgRunning0.2.0");
  });
});

describe("Backups", () => {
  it("says where backups go, the last one and the free space, and lists the sets newest first", async () => {
    start("/server/backups", { "GET /api/v0/server/backups": { body: BACKUPS } });
    expect((await screen.findByRole("region", { name: "Kept in" })).textContent).toMatch(/^Kept in\/backups12\.3 GB free of 50\.0 GBThe newest 7 kept/);
    expect(screen.getByRole("region", { name: "Last backup" }).textContent).toMatch(/4\.2 MB$/);
    const rows = within(screen.getByRole("region", { name: "The backup sets, scrollable" })).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect((rows[1] as HTMLElement).textContent).toMatch(/^2026-11-21T09-00-00Z.+Back up now3 \(1 left out: Old inventory\)4\.2 MB$/);
    expect((rows[2] as HTMLElement).textContent).toMatch(/Nightly4/);
    expect(screen.getByRole("region", { name: "Keeping backups safe" }).textContent).toContain("isn't encrypted");
  });

  it("starts a backup, follows it while it runs, then says what it made and lists it", async () => {
    let gets = 0;
    let started = false;
    const made = { ...SET, name: "2026-11-22T08-00-00Z", trigger: "manual" };
    const run = { running: true, trigger: "manual", startedAt: "2026-11-22T08:00:00.000Z", name: made.name };
    const server = start("/server/backups", {
      "GET /api/v0/server/backups": () => {
        if (!started) return { body: BACKUPS };
        gets++;
        // The first answer after the start says it is running; the next, that it finished.
        return gets === 1
          ? { body: { ...BACKUPS, running: true, current: run } }
          : { body: { ...BACKUPS, last: { at: "2026-11-22T08:00:03.000Z", ok: true, trigger: "manual", name: made.name, bytes: 4_200_000, skipped: 0 }, sets: [made, ...BACKUPS.sets] } };
      },
      "POST /api/v0/server/backups": () => {
        started = true;
        return { status: 202, body: run };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("button", { name: "Backing up…" })).hasAttribute("disabled")).toBe(true);
    expect((await screen.findByRole("status")).textContent).toMatch(/^A backup is running \(2026-11-22T08-00-00Z, started /);
    expect((await screen.findByText("Backed up: 2026-11-22T08-00-00Z, 4.2 MB.", undefined, { timeout: 4000 })).getAttribute("role")).toBe("status");
    expect(screen.getAllByText("2026-11-22T08-00-00Z").length).toBeGreaterThan(0);
    expect(server.sent.filter((s) => s.method === "POST" && s.url.endsWith("/api/v0/server/backups"))).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Back up now" }).hasAttribute("disabled")).toBe(false);
  });

  it("says how a run failed after it started, from its record", async () => {
    let started = false;
    let gets = 0;
    start("/server/backups", {
      "GET /api/v0/server/backups": () => {
        if (!started) return { body: BACKUPS };
        gets++;
        return gets === 1
          ? { body: { ...BACKUPS, running: true, current: { running: true, trigger: "manual", startedAt: "2026-11-22T08:00:00.000Z", name: "x" } } }
          : { body: { ...BACKUPS, last: { at: "2026-11-22T08:00:03.000Z", ok: false, trigger: "manual", error: "Backing up the directory failed: disk error" } } };
      },
      "POST /api/v0/server/backups": () => {
        started = true;
        return { status: 202, body: { running: true, trigger: "manual", startedAt: "2026-11-22T08:00:00.000Z", name: "x" } };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert", undefined, { timeout: 4000 })).textContent).toBe("The backup failed: Backing up the directory failed: disk error");
  });

  it("says why a backup couldn't start", async () => {
    start("/server/backups", {
      "GET /api/v0/server/backups": { body: BACKUPS },
      "POST /api/v0/server/backups": { status: 507, body: { error: { code: "BACKUP_NO_SPACE", message: "Not enough free space in /backups" } } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not enough free space in /backups (BACKUP_NO_SPACE)");
  });

  it("shows a run already going when the page opens, and how it ends", async () => {
    let gets = 0;
    start("/server/backups", {
      "GET /api/v0/server/backups": () =>
        ++gets === 1
          ? { body: { ...BACKUPS, running: true, current: { running: true, trigger: "scheduled", startedAt: "2026-11-22T03:00:00.000Z", name: "2026-11-22T03-00-00Z" } } }
          : { body: { ...BACKUPS, last: { at: "2026-11-22T03:00:05.000Z", ok: true, trigger: "scheduled", name: "2026-11-22T03-00-00Z", bytes: 5_000_000, skipped: 0 } } },
    });
    expect((await screen.findByRole("status")).textContent).toMatch(/^A backup is running \(2026-11-22T03-00-00Z, started /);
    expect(screen.getByRole("button", { name: "Backing up…" }).hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText("Backed up: 2026-11-22T03-00-00Z, 5.0 MB.", undefined, { timeout: 4000 })).toBeTruthy();
  });

  it("says backups are off, and how to turn them on", async () => {
    start("/server/backups", { "GET /api/v0/server/backups": { body: { ...BACKUPS, enabled: false, folder: null, last: null, space: null, sets: [] } } });
    expect((await screen.findByRole("region", { name: "Backups are off" })).textContent).toContain("--backups");
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
  });
});
