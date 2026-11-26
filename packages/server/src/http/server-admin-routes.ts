// The routes under /api/v0/server for server admins: the settings (read and
// saved, checked as "config set" checks them), the client secret
// (write-only), restart, and the status page's facts.

import { isAbsolute } from "node:path";
import { checkIssuer } from "../oidc-discovery.js";
import { StaleSettingsError } from "../server-admin.js";
import {
  isLiveSetting,
  isPlainHttpOffMachine,
  LOCAL_TIME_ZONE,
  parseSettingText,
  SETTING_KEYS,
  settingsContent,
  settingsProblems,
  type Settings,
  type SettingKey,
  type TlsFiles,
} from "../settings.js";
import { certificateValidUntil, loadTlsFiles, TlsError } from "../tls.js";
import { ApiError } from "./errors.js";
import type { Context, ResponseDoc, Route } from "./route.js";
import { ClientSecretChange, ErrorBody, Restarting, ServerSettingsChange, ServerSettingsView, ServerStatus } from "./schemas.js";

const json = (description: string, schema: ResponseDoc["json"], extra: Partial<ResponseDoc> = {}): ResponseDoc => ({ description, json: schema, ...extra });

function actor(context: Context): string {
  if (context.person === undefined) {
    throw new Error("A server-admin route ran without a person");
  }
  return context.person.person.personId;
}

function invalid(key: string, problem: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError("INVALID_INPUT", problem, { path: `/${key}`, ...details });
}

/** A setting's value from the API as the text "config set" takes. */
function asText(key: Exclude<SettingKey, "tls">, value: unknown): string {
  if (key === "maintenanceTimeZone" && value === null) return LOCAL_TIME_ZONE;
  if (key === "trustProxy") return value === true ? "yes" : "no";
  return String(value);
}

type Body = Omit<Settings, "tls"> & { readonly tls: TlsFiles | null; readonly allowPlainHttp?: boolean };

/**
 * The settings in a request body, checked exactly as "config set" checks
 * them: each value, the rules between them, the certificate files when they
 * change, and the issuer against its discovery document when it changes.
 * Throws INVALID_INPUT at the setting's path.
 */
async function checkedSettings(context: Context, body: Body): Promise<Settings> {
  const saved = context.services.admin.saved;
  const values: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (key === "tls") continue;
    const checked = parseSettingText(key, asText(key, body[key]));
    if (!checked.ok) throw invalid(key, checked.problem);
    values[key] = checked.value;
  }
  let tls: TlsFiles | null = null;
  if (body.tls !== null) {
    for (const file of ["certFile", "keyFile"] as const) {
      if (!isAbsolute(body.tls[file])) throw invalid(`tls/${file}`, `The ${file === "certFile" ? "certificate" : "key"} file must be an absolute path on the server, such as /data/tls/fullchain.pem`);
    }
    tls = { certFile: body.tls.certFile, keyFile: body.tls.keyFile };
    if (JSON.stringify(tls) !== JSON.stringify(saved.tls)) {
      try {
        loadTlsFiles(tls);
      } catch (error) {
        if (error instanceof TlsError) throw invalid("tls", error.message);
        throw error;
      }
    }
  }
  const settings = { ...values, tls } as unknown as Settings;
  for (const key of ["publicUrl", "oidcIssuer"] as const) {
    if (settings[key] !== saved[key] && isPlainHttpOffMachine(settings[key]) && body.allowPlainHttp !== true) {
      throw invalid(
        key,
        `${key === "publicUrl" ? "The public address" : "The issuer address"} is plain http:// and leaves this machine, so logins and sessions would cross the network unencrypted. Use https://, or confirm plain HTTP for a trusted network.`,
        { reason: "plainHttp" },
      );
    }
  }
  const problems = settingsProblems(settings);
  if (problems.length > 0) throw invalid("publicUrl", problems.join(" "));
  if (settings.oidcIssuer !== saved.oidcIssuer) {
    try {
      await checkIssuer(settings.oidcIssuer, context.services.admin.fetch);
    } catch (error) {
      throw invalid("oidcIssuer", `The issuer was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return settings;
}

function viewOf(context: Context) {
  const { admin } = context.services;
  const running = admin.running;
  const last = admin.maintenance.lastRun;
  return {
    saved: settingsContent(admin.saved),
    running: settingsContent(running),
    restartKeys: SETTING_KEYS.filter((key) => !isLiveSetting(key)),
    clientSecretSet: admin.clientSecretSet,
    clientSecretWaiting: admin.clientSecretWaiting,
    listenFixed: admin.listenFixed ?? null,
    certificate: running.tls === null ? null : { validUntil: certificateValidUntil(running.tls.certFile) ?? null },
    canRestart: admin.canRestart,
    serverTimeZone: admin.processZone ?? null,
    lastMaintenance: last === undefined ? null : { at: last.lastRunAt, ok: Object.values(last.databases).every((entry) => entry.ok) },
  };
}

const settingsReply = (context: Context, status = 200) => ({ status, json: viewOf(context), etag: context.services.admin.version });

export const SERVER_ADMIN_ROUTES: readonly Route[] = [
  {
    method: "get",
    path: "/api/v0/server/settings",
    operationId: "getServerSettings",
    summary: "The server's settings, as saved and as in effect now. The client secret is never shown, only whether it is set.",
    tag: "administration",
    auth: "serverAdmin",
    responses: { 200: json("The settings; ETag is their version, to send when saving them.", ServerSettingsView, { etag: true }) },
    handler: (context) => settingsReply(context),
  },
  {
    method: "put",
    path: "/api/v0/server/settings",
    operationId: "saveServerSettings",
    summary:
      "Saves every setting but the client secret, checked as config set checks them. Server name, session lengths and maintenance take effect at once; the rest at the next restart.",
    tag: "administration",
    auth: "serverAdmin",
    ifMatch: true,
    body: ServerSettingsChange,
    responses: {
      200: json("The settings as saved and as now in effect; ETag is their new version.", ServerSettingsView, { etag: true }),
      400: json(
        'INVALID_INPUT: a setting can\'t be used (details.path names it). details.reason "plainHttp": an http:// address that leaves this machine, saved only with allowPlainHttp.',
        ErrorBody,
      ),
    },
    handler: async (context) => {
      const settings = await checkedSettings(context, context.body as Body);
      try {
        await context.services.admin.save(settings, context.ifMatch ?? "", actor(context));
      } catch (error) {
        if (error instanceof StaleSettingsError) throw new ApiError("STALE_VERSION", error.message);
        throw error;
      }
      return settingsReply(context);
    },
  },
  {
    method: "put",
    path: "/api/v0/server/client-secret",
    operationId: "setClientSecret",
    summary: "Replaces the login client secret. Write-only: it is never returned. Used from the next restart.",
    tag: "administration",
    auth: "serverAdmin",
    body: ClientSecretChange,
    responses: { 204: { description: "Replaced." } },
    handler: async (context) => {
      const { secret } = context.body as { secret: string };
      if (secret.trim() === "") throw invalid("secret", "The client secret can't be blank");
      await context.services.admin.setClientSecret(secret, actor(context));
      return { status: 204 };
    },
  },
  {
    method: "post",
    path: "/api/v0/server/restart",
    operationId: "restartServer",
    summary: "Stops the server cleanly so that what supervises it starts it again. Only when CROMDB_RESTART_ON_EXIT=1 says something will.",
    tag: "administration",
    auth: "serverAdmin",
    responses: {
      202: json("Stopping; the server is started again by what supervises it.", Restarting),
      409: json("NOT_SUPERVISED: nothing would start the server again (CROMDB_RESTART_ON_EXIT isn't 1). Restart it yourself.", ErrorBody),
    },
    handler: (context) => {
      const { admin } = context.services;
      if (!admin.canRestart) {
        throw new ApiError("NOT_SUPERVISED", "Nothing would start the server again after it stops (CROMDB_RESTART_ON_EXIT isn't 1). Restart it yourself.");
      }
      admin.restart(actor(context));
      return { status: 202, json: { restarting: true } };
    },
  },
  {
    method: "get",
    path: "/api/v0/server/status",
    operationId: "getServerStatus",
    summary: "The server's versions, its databases, and what the last maintenance run did.",
    tag: "administration",
    auth: "serverAdmin",
    responses: { 200: json("The status.", ServerStatus) },
    handler: (context) => {
      const { admin, databases } = context.services;
      const running = admin.running;
      const states = databases.list();
      const last = admin.maintenance.lastRun;
      return {
        status: 200,
        json: {
          serverName: running.serverName,
          publicUrl: running.publicUrl,
          versions: admin.versions,
          startedAt: admin.startedAt.toISOString(),
          databases: {
            available: states.filter((state) => state.status === "open").length,
            unavailable: states.flatMap((state) =>
              state.status === "open" ? [] : [{ databaseId: state.record.databaseId, name: state.record.name, reason: state.reason, since: admin.startedAt.toISOString() }],
            ),
          },
          maintenance: {
            lastRunAt: last?.lastRunAt ?? null,
            nextDueAt: admin.maintenance.nextDueAt.toISOString(),
            hour: admin.maintenance.hour,
            zone: admin.maintenance.zone,
            databases: Object.entries(last?.databases ?? {}).map(([databaseId, entry]) => ({
              databaseId,
              what: entry.what,
              at: entry.at,
              ok: entry.ok,
              ...(entry.tombstones === undefined ? {} : { tombstones: entry.tombstones }),
              ...(entry.entries === undefined ? {} : { entries: entry.entries }),
              ...(entry.compactedAt === undefined ? {} : { compactedAt: entry.compactedAt }),
              ...(entry.error === undefined ? {} : { error: entry.error }),
            })),
          },
        },
      };
    },
  },
];
