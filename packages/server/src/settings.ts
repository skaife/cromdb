// The server's settings: their names, checks and defaults. Pure: reading the
// certificate files and the provider's discovery document happen elsewhere.

import { isIP } from "node:net";
import type { JsonObject, JsonValue } from "@cromdb/driver";
import { isTimeZone } from "./maintenance/schedule.js";
import { nameProblem } from "./text.js";

export interface TlsFiles {
  /** Absolute path of the certificate chain, PEM. */
  readonly certFile: string;
  /** Absolute path of the private key, PEM. */
  readonly keyFile: string;
}

export interface Settings {
  readonly serverName: string;
  /** Where people reach the server: http or https, no trailing slash. Redirects and cookies follow it. */
  readonly publicUrl: string;
  /** Where the server listens, "host:port". */
  readonly listen: string;
  /** Serve HTTPS with these files, or plain HTTP (a reverse proxy may still serve HTTPS in front). */
  readonly tls: TlsFiles | null;
  /** Trust X-Forwarded-For and X-Forwarded-Proto from a reverse proxy. */
  readonly trustProxy: boolean;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly sessionIdleMinutes: number;
  readonly sessionMaxDays: number;
  /** How many days server.cromdb keeps a tombstone (an ended session, say) before purge removes it. */
  readonly serverDbPurgeAfterDays: number;
  /** The hour, 0 to 23, at which the daily maintenance (purge) is due, in maintenanceTimeZone. */
  readonly maintenanceHour: number;
  /** The IANA time zone maintenanceHour is read in, or null for the server process's own (UTC if that's unknown). */
  readonly maintenanceTimeZone: string | null;
}

export const SETTING_KEYS = [
  "serverName",
  "publicUrl",
  "listen",
  "tls",
  "trustProxy",
  "oidcIssuer",
  "oidcClientId",
  "sessionIdleMinutes",
  "sessionMaxDays",
  "serverDbPurgeAfterDays",
  "maintenanceHour",
  "maintenanceTimeZone",
] as const satisfies readonly (keyof Settings)[];
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings a running server takes at once when they are saved through the API. The rest wait for a restart. */
export const LIVE_SETTING_KEYS = [
  "serverName",
  "sessionIdleMinutes",
  "sessionMaxDays",
  "serverDbPurgeAfterDays",
  "maintenanceHour",
  "maintenanceTimeZone",
] as const satisfies readonly SettingKey[];

export function isLiveSetting(key: SettingKey): boolean {
  return (LIVE_SETTING_KEYS as readonly string[]).includes(key);
}

/** What a running server uses after a save: the saved live settings, and the rest as it started with them. */
export function withLiveSettings(running: Settings, saved: Settings): Settings {
  return { ...running, ...Object.fromEntries(LIVE_SETTING_KEYS.map((key) => [key, saved[key]])) };
}

export const SECRET_KEYS = ["oidcClientSecret"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export const DEFAULT_LISTEN = "127.0.0.1:8080";
export const DEFAULT_SESSION_IDLE_MINUTES = 12 * 60;
export const DEFAULT_SESSION_MAX_DAYS = 7;
export const DEFAULT_SERVER_DB_PURGE_AFTER_DAYS = 7;
export const DEFAULT_MAINTENANCE_HOUR = 3;
/** What maintenanceTimeZone is set to, typed, for the server process's own zone. */
export const LOCAL_TIME_ZONE = "local";
const SESSION_IDLE_MINUTES = { min: 5, max: 30 * 24 * 60 };
const SESSION_MAX_DAYS = { min: 1, max: 365 };
/** The engine's range for purgeAfterDays. */
const PURGE_AFTER_DAYS = { min: 1, max: 3650 };
const HOURS = { min: 0, max: 23 };

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export function isSecretKey(key: string): key is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(key);
}

/** A check's result: the value in stored form, or why it can't be used. */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = (problem: string): Checked<never> => ({ ok: false, problem });

/** Whether a URL host is this machine: localhost or a loopback address. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (isIP(host) === 4) {
    return host.startsWith("127.");
  }
  return host === "::1";
}

/**
 * An absolute http or https URL with no query, fragment or user name; path
 * allowed. Stored without a trailing slash.
 */
export function checkUrl(text: string, what: string): Checked<string> {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return bad(`${what} must be an absolute URL such as https://example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return bad(`${what} must start with https:// or http://`);
  }
  if (url.search !== "" || url.hash !== "" || text.includes("?") || text.includes("#")) {
    return bad(`${what} may not have a query (?) or fragment (#)`);
  }
  if (url.username !== "" || url.password !== "") {
    return bad(`${what} may not contain a user name or password`);
  }
  const href = url.href;
  return ok(href.endsWith("/") ? href.slice(0, -1) : href);
}

/** Whether an http (not https) URL leaves this machine, so it needs the plain HTTP warning. */
export function isPlainHttpOffMachine(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname);
}

/** "host:port" with an IPv4 address, a host name, or an IPv6 address in brackets; port 0 to 65535. */
export function parseListen(text: string): Checked<{ host: string; port: number }> {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(text.trim());
  const port = match === null ? NaN : Number(match[2]);
  if (match === null || match[1] === undefined || !(port >= 0 && port <= 65535)) {
    return bad('listen must be "host:port", such as 127.0.0.1:8080, 0.0.0.0:8080 or [::]:8080');
  }
  const host = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
  if (match[1].startsWith("[") && isIP(host) !== 6) {
    return bad(`listen has ${match[1]}, which is not an IPv6 address`);
  }
  return ok({ host, port });
}

function checkInteger(text: string, key: string, range: { min: number; max: number }): Checked<number> {
  const value = Number(text.trim());
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value < range.min || value > range.max) {
    return bad(`${key} must be a whole number from ${range.min} to ${range.max}`);
  }
  return ok(value);
}

/** yes/no, true/false, as typed. */
export function parseYesNo(text: string): boolean | undefined {
  const value = text.trim().toLowerCase();
  if (["yes", "y", "true"].includes(value)) return true;
  if (["no", "n", "false"].includes(value)) return false;
  return undefined;
}

/**
 * A setting typed as text, checked and in stored form. tls is set by the
 * caller from two file names (or "off"), since its files must be read.
 */
export function parseSettingText(key: Exclude<SettingKey, "tls">, text: string): Checked<JsonValue> {
  switch (key) {
    case "serverName": {
      const problem = nameProblem(text);
      return problem === undefined ? ok(text) : bad(`serverName ${problem}`);
    }
    case "publicUrl":
      return checkUrl(text, "publicUrl");
    case "oidcIssuer": {
      // The issuer is compared exactly with what the provider says, so it is
      // kept as typed apart from surrounding spaces.
      const checked = checkUrl(text, "oidcIssuer");
      return checked.ok ? ok(text.trim()) : checked;
    }
    case "listen": {
      const checked = parseListen(text);
      return checked.ok ? ok(text.trim()) : checked;
    }
    case "trustProxy": {
      const value = parseYesNo(text);
      return value === undefined ? bad("trustProxy must be yes or no") : ok(value);
    }
    case "oidcClientId":
      return text.trim() === "" || /\p{Cc}/u.test(text) ? bad("oidcClientId must be non-empty, with no control characters") : ok(text.trim());
    case "sessionIdleMinutes":
      return checkInteger(text, key, SESSION_IDLE_MINUTES);
    case "sessionMaxDays":
      return checkInteger(text, key, SESSION_MAX_DAYS);
    case "serverDbPurgeAfterDays":
      return checkInteger(text, key, PURGE_AFTER_DAYS);
    case "maintenanceHour":
      return checkInteger(text, key, HOURS);
    case "maintenanceTimeZone": {
      const zone = text.trim();
      if (zone === LOCAL_TIME_ZONE) {
        return ok(null);
      }
      return isTimeZone(zone) ? ok(zone) : bad(`maintenanceTimeZone must be an IANA time zone such as Europe/Paris or UTC, or "${LOCAL_TIME_ZONE}" for the server's own`);
    }
  }
}

/** Rules between settings. Returns the problems, empty when they fit together. */
export function settingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  if (settings.tls !== null && !settings.publicUrl.startsWith("https:")) {
    problems.push("The server serves HTTPS itself (tls is set), so publicUrl must start with https://");
  }
  return problems;
}

function field(content: JsonObject, key: string): JsonValue | undefined {
  return Object.hasOwn(content, key) ? content[key] : undefined;
}

/**
 * Settings from their stored document. Missing ones take their defaults where
 * they have one; anything else missing or of the wrong type is an error,
 * reported by key.
 */
export function readSettings(content: JsonObject): Checked<Settings> {
  const text = (key: SettingKey): string | undefined => {
    const value = field(content, key);
    return typeof value === "string" ? value : undefined;
  };
  const number = (key: SettingKey, fallback: number, range?: { min: number; max: number }): number | undefined => {
    const value = field(content, key);
    if (value === undefined) {
      return fallback;
    }
    const inRange = range === undefined || (typeof value === "number" && value >= range.min && value <= range.max);
    return typeof value === "number" && Number.isSafeInteger(value) && inRange ? value : undefined;
  };
  const zoneValue = field(content, "maintenanceTimeZone");
  const maintenanceTimeZone = zoneValue === undefined || zoneValue === null ? null : typeof zoneValue === "string" && isTimeZone(zoneValue) ? zoneValue : undefined;
  const tlsValue = field(content, "tls");
  let tls: TlsFiles | null | undefined;
  if (tlsValue === undefined || tlsValue === null) {
    tls = null;
  } else if (
    typeof tlsValue === "object" &&
    !Array.isArray(tlsValue) &&
    typeof field(tlsValue, "certFile") === "string" &&
    typeof field(tlsValue, "keyFile") === "string"
  ) {
    tls = { certFile: field(tlsValue, "certFile") as string, keyFile: field(tlsValue, "keyFile") as string };
  }
  const trustProxy = field(content, "trustProxy");
  const values = {
    serverName: text("serverName"),
    publicUrl: text("publicUrl"),
    listen: text("listen") ?? (field(content, "listen") === undefined ? DEFAULT_LISTEN : undefined),
    tls,
    trustProxy: trustProxy === undefined ? false : typeof trustProxy === "boolean" ? trustProxy : undefined,
    oidcIssuer: text("oidcIssuer"),
    oidcClientId: text("oidcClientId"),
    sessionIdleMinutes: number("sessionIdleMinutes", DEFAULT_SESSION_IDLE_MINUTES),
    sessionMaxDays: number("sessionMaxDays", DEFAULT_SESSION_MAX_DAYS),
    serverDbPurgeAfterDays: number("serverDbPurgeAfterDays", DEFAULT_SERVER_DB_PURGE_AFTER_DAYS, PURGE_AFTER_DAYS),
    maintenanceHour: number("maintenanceHour", DEFAULT_MAINTENANCE_HOUR, HOURS),
    maintenanceTimeZone,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    return bad(`The server database's settings are missing or damaged: ${missing.join(", ")}`);
  }
  return ok(values as Settings);
}

/** Settings as stored. */
export function settingsContent(settings: Settings): JsonObject {
  return {
    serverName: settings.serverName,
    publicUrl: settings.publicUrl,
    listen: settings.listen,
    tls: settings.tls === null ? null : { certFile: settings.tls.certFile, keyFile: settings.tls.keyFile },
    trustProxy: settings.trustProxy,
    oidcIssuer: settings.oidcIssuer,
    oidcClientId: settings.oidcClientId,
    sessionIdleMinutes: settings.sessionIdleMinutes,
    sessionMaxDays: settings.sessionMaxDays,
    serverDbPurgeAfterDays: settings.serverDbPurgeAfterDays,
    maintenanceHour: settings.maintenanceHour,
    maintenanceTimeZone: settings.maintenanceTimeZone,
  };
}

/** A setting for people to read: JSON, except tls, which is "off" or "cert=..., key=...". */
export function showSetting(settings: Settings, key: SettingKey): string {
  if (key === "tls") {
    return settings.tls === null ? "off" : `cert=${settings.tls.certFile} key=${settings.tls.keyFile}`;
  }
  if (key === "maintenanceTimeZone" && settings.maintenanceTimeZone === null) {
    return LOCAL_TIME_ZONE;
  }
  return JSON.stringify(settings[key]);
}
