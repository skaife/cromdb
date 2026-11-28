// The running server: opens the server database, the directory and the
// databases through the driver, then serves HTTP or HTTPS.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { resolve } from "node:path";
import { LoginStates } from "./auth/login-states.js";
import { Backups, fileSystemSpace, type Space } from "./backups/backups.js";
import { OidcClient, type Fetch } from "./auth/oidc.js";
import { SESSION_FLUSH_MS, Sessions } from "./auth/sessions.js";
import { dataPaths, type DataPaths } from "./data-dir.js";
import { Databases } from "./databases.js";
import { Directory } from "./directory/directory.js";
import { createApp } from "./http/app.js";
import { openApiDocument } from "./http/openapi.js";
import type { CookieNames } from "./http/route.js";
import { ROUTES } from "./http/routes.js";
import { adminUiDist, loadAdminUi } from "./http/static.js";
import { Maintenance } from "./maintenance/maintenance.js";
import { maintenanceTimeZone, processTimeZone } from "./maintenance/schedule.js";
import { ServerAdmin } from "./server-admin.js";
import { parseListen } from "./settings.js";
import { openServerFile } from "./store/open.js";
import { ServerDb, ServerDbError } from "./store/server-db.js";
import { CertificateWatcher } from "./tls.js";
import { githubSource, UpdateCheck, type UpdateSource } from "./update-check.js";

/** How often the certificate files are checked for renewal. */
export const CERTIFICATE_CHECK_MS = 60_000;

/**
 * How long an idle connection is kept open. Longer than the 60 s that
 * proxies and load balancers commonly keep theirs, so the proxy always
 * closes an idle connection first and never sends a request on one the
 * server is closing.
 */
export const KEEP_ALIVE_MS = 65_000;

/** How long a request's headers may take; Node needs it longer than the keep-alive. */
export const HEADERS_TIMEOUT_MS = 66_000;

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

/**
 * The cookie names. With an https public URL the session cookie is
 * __Host- (Secure, Path=/, no Domain: no other host can set or overwrite
 * it) and the login cookie __Secure-.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure ? { session: "__Host-cromdb-session", login: "__Secure-cromdb-login" } : { session: "cromdb-session", login: "cromdb-login" };
}

export interface ServerOptions {
  readonly dataDir: string;
  /** The backups folder; default CROMDB_BACKUPS. With neither, or null, backups are off. */
  readonly backupsDir?: string | null;
  /** For tests: how the free space of a folder's file system is read. */
  readonly fileSystemSpace?: (path: string) => Space | undefined;
  /** Overrides the listen setting, "host:port". */
  readonly listen?: string;
  readonly log?: (message: string) => void;
  /** For tests: how often to check the certificate files. */
  readonly certificateCheckMs?: number;
  /** For tests: the driver to use instead of a new level-4 driver. */
  readonly driver?: Driver;
  /** For tests: how the server reaches the login service. */
  readonly fetch?: Fetch;
  /** For tests: the server's clock. */
  readonly now?: () => Date;
  /** For tests: the admin UI's build folder instead of the installed one's. */
  readonly adminUiDir?: string;
  /** Whether something starts the server again when it exits. Default: CROMDB_RESTART_ON_EXIT is 1. */
  readonly restartOnExit?: boolean;
  /** Called when a server admin asks for a restart (and restartOnExit allows it): the caller stops the server and exits. */
  readonly onRestart?: () => void;
  /** For tests and the dev server: where the update check gets the tags, instead of GitHub. */
  readonly updateSource?: UpdateSource;
  /** For tests and the dev server: how long the update check waits for its first check. */
  readonly updateFirstCheckMs?: number;
}

export interface RunningServer {
  /** Where it listens: http or https, the address and the actual port. */
  readonly url: string;
  readonly port: number;
  readonly paths: DataPaths;
  readonly serverDb: ServerDb;
  readonly directory: Directory;
  readonly databases: Databases;
  readonly sessions: Sessions;
  readonly loginStates: LoginStates;
  /** The daily purge. */
  readonly maintenance: Maintenance;
  readonly backups: Backups;
  /** Settings as saved and running, restart, status. */
  readonly admin: ServerAdmin;
  /** For tests: checks the certificate files now; true if a new pair was loaded. */
  checkCertificates(): boolean;
  close(): Promise<void>;
}

function defaultLog(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** Opens everything and starts listening. Rejects with ServerDbError, TlsError, or a listen error. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? defaultLog;
  const paths = dataPaths(options.dataDir);
  const now = options.now ?? (() => new Date());
  // The engine counts purge's days by the same clock as the server.
  const driver = options.driver ?? createLevel4Driver({ now });
  let watcher: CertificateWatcher | undefined;
  let listener: HttpServer | HttpsServer | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let maintenance: Maintenance | undefined;
  let backups: Backups | undefined;
  let updates: UpdateCheck | undefined;
  try {
    const serverDb = await ServerDb.open(driver, paths.serverDb, log);
    const { identity, settings } = serverDb;
    const purgeChange = await serverDb.applyPurgeSetting();
    if (purgeChange !== undefined) {
      log(`The server database now keeps tombstones ${purgeChange.to} days (serverDbPurgeAfterDays), not ${purgeChange.from}`);
    }
    const listen = parseListen(options.listen ?? settings.listen);
    if (!listen.ok) {
      throw new ServerDbError(listen.problem);
    }

    const opened = await openServerFile(driver, paths.directory, "the directory", log);
    if (opened.databaseId !== identity.directoryDatabaseId) {
      throw new ServerDbError(`${paths.directory} holds database ${opened.databaseId}, not this server's directory ${identity.directoryDatabaseId}`);
    }
    const directory = await Directory.load({ driver, handle: opened.handle, serverId: identity.serverId, log });
    const databases = await Databases.open({ driver, paths, serverDb, log });
    const info = await driver.call("driver.info", {});
    const backupsDir = options.backupsDir === null ? undefined : (options.backupsDir ?? (process.env["CROMDB_BACKUPS"] || undefined));
    // Both are live settings, so the saved values are the ones in effect.
    backups = new Backups({
      driver,
      serverDb,
      directoryHandle: opened.handle,
      databases,
      folder: backupsDir === undefined ? undefined : resolve(backupsDir),
      keep: () => serverDb.settings.backupKeep,
      versions: { server: PACKAGE.version, driver: info.driver.version, engine: info.engine.version },
      serverName: () => serverDb.settings.serverName,
      ...(options.fileSystemSpace === undefined ? {} : { fileSystemSpace: options.fileSystemSpace }),
      now,
      log,
    });
    const made = backups;
    log(made.folder === undefined ? "Backups are off: there is no backups folder (--backups, or CROMDB_BACKUPS)" : `Backups are saved in ${made.folder}, the newest ${settings.backupKeep} kept`);
    const { zone, fallback } = maintenanceTimeZone(settings.maintenanceTimeZone, processTimeZone());
    maintenance = new Maintenance({
      driver,
      serverDb,
      databases: () => [
        { databaseId: serverDb.databaseId, what: "the server database", handle: serverDb.handle },
        { databaseId: opened.databaseId, what: "the directory", handle: opened.handle },
        ...databases.list().flatMap((state) =>
          state.status === "open" ? [{ databaseId: state.record.databaseId, what: `database ${JSON.stringify(state.record.name)}`, handle: state.handle }] : [],
        ),
      ],
      skipped: () =>
        databases.list().flatMap((state) => (state.status === "open" ? [] : [`database ${JSON.stringify(state.record.name)} (${state.record.databaseId}): ${state.reason}`])),
      hour: settings.maintenanceHour,
      zone,
      ...(made.enabled ? { backup: () => made.run("scheduled") } : {}),
      tidy: () => void databases.pruneReplaced(now()),
      now,
      log,
    });
    const hour = `${String(settings.maintenanceHour).padStart(2, "0")}:00`;
    log(
      fallback
        ? `Maintenance is due daily at ${hour} UTC: the server's own time zone isn't known (set TZ, or maintenanceTimeZone)`
        : `Maintenance is due daily at ${hour} ${zone}`,
    );

    const clientSecret = serverDb.secret("oidcClientSecret");
    if (clientSecret === undefined) {
      throw new ServerDbError('The client secret is not set. Run "cromdb-server config set oidcClientSecret" first.');
    }
    const sessions = await Sessions.load({
      driver,
      handle: serverDb.handle,
      limits: { idleMinutes: settings.sessionIdleMinutes, maxDays: settings.sessionMaxDays },
      now,
      log,
    });
    flushTimer = setInterval(() => {
      sessions.flush().catch((error: unknown) => log(`Writing sessions failed: ${error instanceof Error ? error.message : String(error)}`));
    }, SESSION_FLUSH_MS);
    flushTimer.unref();
    const loginStates = new LoginStates();
    const secure = settings.publicUrl.startsWith("https:");
    const cookies = cookieNames(secure);
    const oidc = new OidcClient({
      issuer: settings.oidcIssuer,
      clientId: settings.oidcClientId,
      clientSecret,
      redirectUri: `${settings.publicUrl}/auth/callback`,
      fetch: options.fetch ?? fetch,
      now,
    });
    updates = new UpdateCheck({
      running: PACKAGE.version,
      enabled: settings.updateCheck,
      source: options.updateSource ?? githubSource(),
      now,
      log,
      ...(options.updateFirstCheckMs === undefined ? {} : { firstCheckMs: options.updateFirstCheckMs }),
    });
    const admin = new ServerAdmin({
      serverDb,
      sessions,
      maintenance,
      updates,
      started: { ...settings, listen: options.listen ?? settings.listen },
      listenFixed: options.listen,
      startedAt: now(),
      dataSpace: () => (options.fileSystemSpace ?? fileSystemSpace)(paths.root),
      versions: { server: PACKAGE.version, driver: info.driver.version, engine: info.engine.version },
      processZone: processTimeZone(),
      canRestart: options.restartOnExit ?? process.env["CROMDB_RESTART_ON_EXIT"] === "1",
      restart: () => options.onRestart?.(),
      fetch: options.fetch ?? fetch,
      log,
    });
    const app = createApp({
      adminUi: loadAdminUi(options.adminUiDir ?? adminUiDist(), log),
      trustProxy: settings.trustProxy,
      routes: ROUTES,
      services: {
        get settings() {
          return admin.running;
        },
        admin,
        backups: made,
        directory,
        databases,
        sessions,
        loginStates,
        oidc,
        cookies,
        secure,
        now,
        log,
        openapi: openApiDocument(ROUTES, { version: PACKAGE.version, sessionCookie: cookies.session }),
      },
    });
    if (settings.tls === null) {
      listener = createHttpServer(app);
    } else {
      watcher = new CertificateWatcher(settings.tls, log);
      const https = createHttpsServer({ ...watcher.initial() }, app);
      watcher.start(https, options.certificateCheckMs ?? CERTIFICATE_CHECK_MS);
      listener = https;
    }
    const server = listener;
    server.keepAliveTimeout = KEEP_ALIVE_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.value.port, listen.value.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const scheme = settings.tls === null ? "http" : "https";
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
    const url = `${scheme}://${host}:${address.port}`;
    log(`${settings.serverName} is listening on ${url} (public URL ${settings.publicUrl}); ${directory.index.size} people, ${databases.list().length} databases`);
    maintenance.start();

    let closed: Promise<void> | undefined;
    return {
      url,
      port: address.port,
      paths,
      serverDb,
      directory,
      databases,
      sessions,
      loginStates,
      maintenance,
      backups: made,
      admin,
      checkCertificates: () => (watcher === undefined ? false : watcher.check(server as HttpsServer)),
      close() {
        closed ??= (async () => {
          updates?.close();
          watcher?.stop();
          clearInterval(flushTimer);
          await maintenance?.stop();
          await made.settled();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
          try {
            await sessions.flush();
          } catch (error) {
            log(`Writing sessions at shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          await driver.shutdown();
        })();
        return closed;
      },
    };
  } catch (error) {
    updates?.close();
    watcher?.stop();
    clearInterval(flushTimer);
    await maintenance?.stop();
    await backups?.settled();
    listener?.close();
    await driver.shutdown();
    throw error;
  }
}
