import { describe, expect, it } from "vitest";
import {
  checkUrl,
  isLoopbackHost,
  isPlainHttpOffMachine,
  parseListen,
  parseSettingText,
  readSettings,
  settingsContent,
  showSetting,
  settingsProblems,
  type Settings,
} from "../src/settings.js";
import { emailProblem, normalizeEmail } from "../src/text.js";

const settings: Settings = {
  serverName: "S",
  publicUrl: "https://db.example.com",
  listen: "0.0.0.0:8443",
  tls: { certFile: "/c.pem", keyFile: "/k.pem" },
  trustProxy: false,
  oidcIssuer: "https://id.example.com/realms/r",
  oidcClientId: "cromdb",
  sessionIdleMinutes: 720,
  sessionMaxDays: 7,
  serverDbPurgeAfterDays: 30,
  maintenanceHour: 4,
  maintenanceTimeZone: "Europe/Paris",
};

describe("email addresses", () => {
  it("are trimmed, NFC and lower case", () => {
    expect(normalizeEmail("  Ann@Example.COM ")).toBe("ann@example.com");
    expect(normalizeEmail("Jose\u0301@example.com")).toBe("jos\u00E9@example.com");
  });

  it("are checked loosely", () => {
    expect(emailProblem("ann@example.com")).toBeUndefined();
    for (const bad of ["", "ann", "@example.com", "ann@", "a@b@example.com", "ann@example", "an n@example.com", "ann@.example.com", "ann@example..com"]) {
      expect(emailProblem(bad), bad).toBeDefined();
    }
  });
});

describe("URLs", () => {
  it("are absolute http or https, without query, fragment or user, stored without a trailing slash", () => {
    expect(checkUrl("https://db.example.com/", "u")).toEqual({ ok: true, value: "https://db.example.com" });
    expect(checkUrl(" https://db.example.com/crom/ ", "u")).toEqual({ ok: true, value: "https://db.example.com/crom" });
    for (const bad of ["db.example.com", "ftp://x", "https://x/?a=1", "https://x/#f", "https://x/?", "https://u:p@x"]) {
      expect(checkUrl(bad, "u").ok, bad).toBe(false);
    }
  });

  it("know which hosts are this machine", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["example.com", "10.0.0.1", "[::]", "128.0.0.1", "localhost.example.com"]) expect(isLoopbackHost(host), host).toBe(false);
    expect(isPlainHttpOffMachine("http://localhost:8080")).toBe(false);
    expect(isPlainHttpOffMachine("http://db.lan")).toBe(true);
    expect(isPlainHttpOffMachine("https://db.lan")).toBe(false);
  });

  it("keep the issuer as typed, since it is compared exactly", () => {
    expect(parseSettingText("oidcIssuer", " https://id.example.com/realms/r/ ")).toEqual({ ok: true, value: "https://id.example.com/realms/r/" });
  });
});

describe("listen addresses", () => {
  it("are host:port", () => {
    expect(parseListen("127.0.0.1:8080")).toEqual({ ok: true, value: { host: "127.0.0.1", port: 8080 } });
    expect(parseListen("[::]:443")).toEqual({ ok: true, value: { host: "::", port: 443 } });
    expect(parseListen("db.lan:0")).toEqual({ ok: true, value: { host: "db.lan", port: 0 } });
    for (const bad of ["8080", "host:", "host:65536", "[nope]:80", "::1:80", "a b:80"]) expect(parseListen(bad).ok, bad).toBe(false);
  });
});

describe("settings typed as text", () => {
  it("are checked and converted", () => {
    expect(parseSettingText("trustProxy", "Yes")).toEqual({ ok: true, value: true });
    expect(parseSettingText("trustProxy", "maybe").ok).toBe(false);
    expect(parseSettingText("sessionIdleMinutes", "30")).toEqual({ ok: true, value: 30 });
    for (const bad of ["4", "1.5", "-1", "x", "43201"]) expect(parseSettingText("sessionIdleMinutes", bad).ok, bad).toBe(false);
    expect(parseSettingText("sessionMaxDays", "366").ok).toBe(false);
    expect(parseSettingText("serverDbPurgeAfterDays", "1")).toEqual({ ok: true, value: 1 });
    expect(parseSettingText("serverDbPurgeAfterDays", "3650")).toEqual({ ok: true, value: 3650 });
    for (const bad of ["0", "3651", "7.5", "seven"]) expect(parseSettingText("serverDbPurgeAfterDays", bad).ok, bad).toBe(false);
    expect(parseSettingText("maintenanceHour", "0")).toEqual({ ok: true, value: 0 });
    expect(parseSettingText("maintenanceHour", "23")).toEqual({ ok: true, value: 23 });
    for (const bad of ["24", "-1", "3.5", "3am"]) expect(parseSettingText("maintenanceHour", bad).ok, bad).toBe(false);
    expect(parseSettingText("maintenanceTimeZone", " America/Los_Angeles ")).toEqual({ ok: true, value: "America/Los_Angeles" });
    expect(parseSettingText("maintenanceTimeZone", "UTC")).toEqual({ ok: true, value: "UTC" });
    expect(parseSettingText("maintenanceTimeZone", "local")).toEqual({ ok: true, value: null });
    for (const bad of ["Mars/Olympus", "+05:00", "", "Europe/", "../etc", "America/Los Angeles"]) {
      expect(parseSettingText("maintenanceTimeZone", bad).ok, bad).toBe(false);
    }
    expect(parseSettingText("serverName", " padded").ok).toBe(false);
    expect(parseSettingText("serverName", "x".repeat(101)).ok).toBe(false);
    expect(parseSettingText("oidcClientId", "  ").ok).toBe(false);
  });
});

describe("stored settings", () => {
  it("read back as written", () => {
    expect(readSettings(settingsContent(settings))).toEqual({ ok: true, value: settings });
  });

  it("take defaults for what has one", () => {
    const {
      listen: _l,
      sessionIdleMinutes: _i,
      sessionMaxDays: _d,
      trustProxy: _t,
      tls: _s,
      serverDbPurgeAfterDays: _p,
      maintenanceHour: _h,
      maintenanceTimeZone: _z,
      ...rest
    } = settingsContent(settings);
    expect(readSettings(rest)).toEqual({
      ok: true,
      value: {
        ...settings,
        listen: "127.0.0.1:8080",
        sessionIdleMinutes: 720,
        sessionMaxDays: 7,
        trustProxy: false,
        tls: null,
        serverDbPurgeAfterDays: 7,
        maintenanceHour: 3,
        maintenanceTimeZone: null,
      },
    });
  });

  it("refuse a stored maintenance setting out of range", () => {
    for (const [key, value] of [
      ["maintenanceHour", 24],
      ["maintenanceHour", -1],
      ["maintenanceTimeZone", "Mars/Olympus"],
      ["maintenanceTimeZone", 3],
    ] as const) {
      expect(readSettings({ ...settingsContent(settings), [key]: value }), `${key} ${value}`).toEqual({ ok: false, problem: expect.stringContaining(key) });
    }
  });

  it("show the time zone as local when it is the server's own", () => {
    expect(showSetting({ ...settings, maintenanceTimeZone: null }, "maintenanceTimeZone")).toBe("local");
    expect(showSetting(settings, "maintenanceTimeZone")).toBe('"Europe/Paris"');
  });

  it("refuse a stored serverDbPurgeAfterDays the engine wouldn't take", () => {
    for (const days of [0, 3651, 2.5, "7"]) {
      expect(readSettings({ ...settingsContent(settings), serverDbPurgeAfterDays: days }), String(days)).toEqual({
        ok: false,
        problem: expect.stringContaining("serverDbPurgeAfterDays"),
      });
    }
  });

  it("name what is damaged, reading only their own fields", () => {
    const content = { ...settingsContent(settings), serverName: 3, tls: { certFile: "/c.pem" } };
    expect(readSettings(content)).toEqual({ ok: false, problem: expect.stringContaining("serverName, tls") });
    const inherited = Object.create({ publicUrl: "https://evil" }) as Record<string, unknown>;
    Object.assign(inherited, settingsContent(settings));
    delete inherited["publicUrl"];
    expect(readSettings(inherited as never)).toEqual({ ok: false, problem: expect.stringContaining("publicUrl") });
  });

  it("need an https public URL when the server serves HTTPS", () => {
    expect(settingsProblems(settings)).toEqual([]);
    expect(settingsProblems({ ...settings, publicUrl: "http://db.example.com" })).toHaveLength(1);
    expect(settingsProblems({ ...settings, publicUrl: "http://db.example.com", tls: null })).toEqual([]);
  });
});
