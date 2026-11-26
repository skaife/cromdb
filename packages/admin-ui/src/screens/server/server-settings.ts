// The server settings form: from the settings as saved to the fields on the
// page and back. HTTPS is one choice on the page for two settings: tls (the
// server serves HTTPS with these files) and trustProxy (a reverse proxy in
// front says who the client is and whether it used HTTPS).

import type { Schemas } from "../../api/schema.ts";

export type ServerSettings = Schemas["ServerSettings"];
export type SettingsView = Schemas["ServerSettingsView"];
export type SettingKey = keyof ServerSettings;

export type Https = "server" | "proxy" | "off";

export interface Form {
  readonly serverName: string;
  readonly publicUrl: string;
  readonly listen: string;
  readonly https: Https;
  readonly certFile: string;
  readonly keyFile: string;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly sessionIdleMinutes: string;
  readonly sessionMaxDays: string;
  readonly maintenanceHour: string;
  /** Empty: the server's own time zone. */
  readonly maintenanceTimeZone: string;
  readonly serverDbPurgeAfterDays: string;
}

export type FieldName = keyof Form;

export function httpsOf(settings: Pick<ServerSettings, "tls" | "trustProxy">): Https {
  if (settings.tls !== null) return "server";
  return settings.trustProxy ? "proxy" : "off";
}

export function formOf(settings: ServerSettings): Form {
  return {
    serverName: settings.serverName,
    publicUrl: settings.publicUrl,
    listen: settings.listen,
    https: httpsOf(settings),
    certFile: settings.tls?.certFile ?? "",
    keyFile: settings.tls?.keyFile ?? "",
    oidcIssuer: settings.oidcIssuer,
    oidcClientId: settings.oidcClientId,
    sessionIdleMinutes: String(settings.sessionIdleMinutes),
    sessionMaxDays: String(settings.sessionMaxDays),
    maintenanceHour: String(settings.maintenanceHour),
    maintenanceTimeZone: settings.maintenanceTimeZone ?? "",
    serverDbPurgeAfterDays: String(settings.serverDbPurgeAfterDays),
  };
}

/** A whole number as typed, or NaN, which the server refuses with its own message. */
function whole(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN;
}

/**
 * The settings to save. A server that serves HTTPS itself keeps the
 * trustProxy it had (a proxy may still be in front of it); the other two
 * choices set it.
 */
export function settingsOf(form: Form, saved: ServerSettings): ServerSettings {
  return {
    serverName: form.serverName,
    publicUrl: form.publicUrl.trim(),
    listen: form.listen.trim(),
    tls: form.https === "server" ? { certFile: form.certFile.trim(), keyFile: form.keyFile.trim() } : null,
    trustProxy: form.https === "server" ? saved.tls !== null && saved.trustProxy : form.https === "proxy",
    oidcIssuer: form.oidcIssuer.trim(),
    oidcClientId: form.oidcClientId.trim(),
    sessionIdleMinutes: whole(form.sessionIdleMinutes),
    sessionMaxDays: whole(form.sessionMaxDays),
    maintenanceHour: whole(form.maintenanceHour),
    maintenanceTimeZone: form.maintenanceTimeZone.trim() === "" ? null : form.maintenanceTimeZone.trim(),
    serverDbPurgeAfterDays: whole(form.serverDbPurgeAfterDays),
  };
}

/** Numbers the page can tell are wrong before asking the server: each field's problem. */
export function formProblems(form: Form): ReadonlyMap<FieldName, string> {
  const problems = new Map<FieldName, string>();
  const range = (field: FieldName, text: string, min: number, max: number) => {
    const value = whole(text);
    if (!(value >= min && value <= max)) problems.set(field, `Give a whole number from ${min} to ${max}.`);
  };
  range("sessionIdleMinutes", form.sessionIdleMinutes, 5, 43_200);
  range("sessionMaxDays", form.sessionMaxDays, 1, 365);
  range("serverDbPurgeAfterDays", form.serverDbPurgeAfterDays, 1, 3650);
  if (form.serverName.trim() === "") problems.set("serverName", "Give the server a name.");
  if (form.https === "server") {
    if (form.certFile.trim() === "") problems.set("certFile", "Give the certificate file's path on the server.");
    if (form.keyFile.trim() === "") problems.set("keyFile", "Give the key file's path on the server.");
  }
  return problems;
}

/** The field a server refusal is about, from its details.path. */
export function fieldOfPath(path: unknown): FieldName | undefined {
  switch (path) {
    case "/serverName":
    case "/publicUrl":
    case "/listen":
    case "/oidcIssuer":
    case "/oidcClientId":
    case "/sessionIdleMinutes":
    case "/sessionMaxDays":
    case "/maintenanceHour":
    case "/maintenanceTimeZone":
    case "/serverDbPurgeAfterDays":
      return path.slice(1) as FieldName;
    case "/tls":
    case "/tls/certFile":
      return "certFile";
    case "/tls/keyFile":
      return "keyFile";
    case "/trustProxy":
      return "https";
    default:
      return undefined;
  }
}

/** The settings each field sets, to tag it "restart" and to tell when it waits for one. */
export const FIELD_SETTINGS: Readonly<Record<FieldName, readonly SettingKey[]>> = {
  serverName: ["serverName"],
  publicUrl: ["publicUrl"],
  listen: ["listen"],
  https: ["tls", "trustProxy"],
  certFile: ["tls"],
  keyFile: ["tls"],
  oidcIssuer: ["oidcIssuer"],
  oidcClientId: ["oidcClientId"],
  sessionIdleMinutes: ["sessionIdleMinutes"],
  sessionMaxDays: ["sessionMaxDays"],
  maintenanceHour: ["maintenanceHour"],
  maintenanceTimeZone: ["maintenanceTimeZone"],
  serverDbPurgeAfterDays: ["serverDbPurgeAfterDays"],
};

/** The settings saved but not yet in effect: they wait for a restart. */
export function waitingForRestart(view: Pick<SettingsView, "saved" | "running">): readonly SettingKey[] {
  return (Object.keys(view.saved) as SettingKey[]).filter((key) => JSON.stringify(view.saved[key]) !== JSON.stringify(view.running[key]));
}

/** A setting as people read it, for "running now: …". */
export function shownValue(settings: ServerSettings, key: SettingKey): string {
  switch (key) {
    case "tls":
      return settings.tls === null ? "no HTTPS of its own" : `${settings.tls.certFile} and ${settings.tls.keyFile}`;
    case "trustProxy":
      return settings.trustProxy ? "trusts a reverse proxy in front" : "no reverse proxy trusted";
    case "maintenanceTimeZone":
      return settings.maintenanceTimeZone ?? "the server's own time zone";
    default:
      return String(settings[key]);
  }
}

/** "03:00" for 3. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}
