import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { anythingWaiting, fieldOfPath, formOf, formProblems, httpsOf, settingsOf, waitingForRestart, type ServerSettings } from "../src/screens/server/server-settings.ts";
import { resultText, runSummary } from "../src/screens/server/StatusPage.tsx";

const SAVED: ServerSettings = {
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
};

const settings = fc.record({
  serverName: fc.string({ minLength: 1 }),
  publicUrl: fc.webUrl(),
  listen: fc.constantFrom("127.0.0.1:8080", "0.0.0.0:8443", "[::]:80"),
  tls: fc.option(fc.record({ certFile: fc.constantFrom("/a/cert.pem", "/b/c.pem"), keyFile: fc.constantFrom("/a/key.pem", "/b/k.pem") }), { nil: null }),
  trustProxy: fc.boolean(),
  oidcIssuer: fc.webUrl(),
  oidcClientId: fc.constantFrom("cromdb", "admin-ui"),
  sessionIdleMinutes: fc.integer({ min: 5, max: 43_200 }),
  sessionMaxDays: fc.integer({ min: 1, max: 365 }),
  serverDbPurgeAfterDays: fc.integer({ min: 1, max: 3650 }),
  maintenanceHour: fc.integer({ min: 0, max: 23 }),
  maintenanceTimeZone: fc.option(fc.constantFrom("UTC", "Europe/Paris", "America/Los_Angeles"), { nil: null }),
  updateCheck: fc.boolean(),
});

describe("the server settings form", () => {
  it("gives back the settings it was made from, untouched", () => {
    fc.assert(
      fc.property(settings, (saved) => {
        expect(settingsOf(formOf(saved), saved)).toEqual(saved);
      }),
    );
  });

  it("makes the HTTPS choice from tls and trustProxy, and sets them from it", () => {
    expect(httpsOf(SAVED)).toBe("server");
    expect(httpsOf({ tls: null, trustProxy: true })).toBe("proxy");
    expect(httpsOf({ tls: null, trustProxy: false })).toBe("off");
    const form = formOf(SAVED);
    expect(settingsOf({ ...form, https: "proxy" }, SAVED)).toMatchObject({ tls: null, trustProxy: true });
    expect(settingsOf({ ...form, https: "off" }, SAVED)).toMatchObject({ tls: null, trustProxy: false });
    // Newly served by the server: no proxy trusted.
    const plain = { ...SAVED, tls: null, trustProxy: true };
    expect(settingsOf({ ...formOf(plain), https: "server", certFile: " /c.pem ", keyFile: "/k.pem" }, plain)).toMatchObject({ tls: { certFile: "/c.pem", keyFile: "/k.pem" }, trustProxy: false });
  });

  it("keeps an empty time zone as the server's own", () => {
    expect(settingsOf({ ...formOf(SAVED), maintenanceTimeZone: "  " }, SAVED).maintenanceTimeZone).toBeNull();
    expect(settingsOf({ ...formOf(SAVED), maintenanceTimeZone: " Europe/Paris " }, SAVED).maintenanceTimeZone).toBe("Europe/Paris");
  });

  it("finds the numbers out of range, and the missing files, before asking the server", () => {
    const form = formOf(SAVED);
    expect(formProblems(form).size).toBe(0);
    const bad = formProblems({ ...form, sessionIdleMinutes: "4", sessionMaxDays: "7.5", serverDbPurgeAfterDays: "x", serverName: " ", certFile: "" });
    expect([...bad.keys()].sort()).toEqual(["certFile", "serverDbPurgeAfterDays", "serverName", "sessionIdleMinutes", "sessionMaxDays"]);
    expect(formProblems({ ...form, https: "off", certFile: "" }).size).toBe(0);
  });

  it("puts the server's refusal at its field", () => {
    expect(fieldOfPath("/maintenanceTimeZone")).toBe("maintenanceTimeZone");
    expect(fieldOfPath("/tls")).toBe("certFile");
    expect(fieldOfPath("/tls/keyFile")).toBe("keyFile");
    expect(fieldOfPath("/trustProxy")).toBe("https");
    expect(fieldOfPath("/nothing")).toBeUndefined();
    expect(fieldOfPath(7)).toBeUndefined();
  });

  it("tells which saved settings wait for a restart", () => {
    expect(waitingForRestart({ saved: SAVED, running: SAVED })).toEqual([]);
    expect(waitingForRestart({ saved: { ...SAVED, oidcClientId: "next", tls: null }, running: SAVED })).toEqual(["tls", "oidcClientId"]);
    // Started with --listen: the setting is never used, so it never waits.
    const listening = { ...SAVED, listen: "0.0.0.0:8080" };
    expect(waitingForRestart({ saved: SAVED, running: listening })).toEqual(["listen"]);
    expect(waitingForRestart({ saved: SAVED, running: listening, listenFixed: "0.0.0.0:8080" })).toEqual([]);
    expect(anythingWaiting({ saved: SAVED, running: listening, listenFixed: "0.0.0.0:8080", clientSecretWaiting: false })).toBe(false);
    expect(anythingWaiting({ saved: SAVED, running: SAVED, listenFixed: null, clientSecretWaiting: true })).toBe(true);
  });
});

describe("the status page's words", () => {
  const at = "2026-11-22T03:10:00.000Z";
  it("say what one database's maintenance did", () => {
    expect(resultText({ databaseId: "d", what: "x", at, ok: true, tombstones: 1, entries: 0 })).toBe("1 deletion removed");
    expect(resultText({ databaseId: "d", what: "x", at, ok: true, tombstones: 212, entries: 3, compactedAt: at })).toBe("212 deletions removed, 3 change entries dropped, file compacted");
    expect(resultText({ databaseId: "d", what: "x", at, ok: true, tombstones: 0, entries: 0, compactedAt: "2026-10-01T03:10:00.000Z" })).toBe("0 deletions removed");
    expect(resultText({ databaseId: "d", what: "x", at, ok: false, error: "disk full" })).toBe("Failed: disk full");
  });

  it("sum up a run", () => {
    expect(
      runSummary([
        { databaseId: "a", what: "a", at, ok: true, tombstones: 200, compactedAt: at },
        { databaseId: "b", what: "b", at, ok: true, tombstones: 12 },
        { databaseId: "c", what: "c", at, ok: false, error: "x" },
      ]),
    ).toBe("212 deletions removed, 1 file compacted, 1 database failed");
  });
});
