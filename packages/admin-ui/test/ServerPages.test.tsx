import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { fakeFetch, type Answer, type Sent } from "./fake-server.ts";

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
};
const VIEW = {
  saved: SAVED,
  running: SAVED,
  restartKeys: ["publicUrl", "listen", "tls", "trustProxy", "oidcIssuer", "oidcClientId"],
  clientSecretSet: true,
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
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
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
    expect(await screen.findByText("Replaced. The server uses it from its next restart.")).toBeTruthy();
    expect(server.sent.find((s) => s.url === "/api/v0/server/client-secret")?.body).toEqual({ secret: "s3cret" });
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

  it("lists this server alone until servers sync", async () => {
    start("/server/servers");
    const table = await screen.findByRole("table", { name: "The servers in this deployment" });
    expect((within(table).getAllByRole("row")[1] as HTMLElement).textContent).toBe("office-1 (this server)https://office-1.example.orgRunning0.2.0");
  });
});
