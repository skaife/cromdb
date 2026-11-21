// The running server: opens the server database, the directory and the
// databases through the driver, then serves HTTP or HTTPS.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { LoginStates } from "./auth/login-states.js";
import { OidcClient, type Fetch } from "./auth/oidc.js";
import { SESSION_FLUSH_MS, Sessions } from "./auth/sessions.js";
import { dataPaths, type DataPaths } from "./data-dir.js";
import { Databases } from "./databases.js";
import { Directory } from "./directory/directory.js";
import { createApp } from "./http/app.js";
import { openApiDocument } from "./http/openapi.js";
import type { CookieNames } from "./http/route.js";
import { ROUTES } from "./http/routes.js";
import { Maintenance } from "./maintenance/maintenance.js";
import { maintenanceTimeZone, processTimeZone } from "./maintenance/schedule.js";
import { parseListen } from "./settings.js";
import { openServerFile } from "./store/open.js";
import { ServerDb, ServerDbError } from "./store/server-db.js";
import { CertificateWatcher } from "./tls.js";

/** How often the certificate files are checked for renewal. */
export const CERTIFICATE_CHECK_MS = 60_000;

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
    const app = createApp({
      trustProxy: settings.trustProxy,
      routes: ROUTES,
      services: {
        settings,
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
      checkCertificates: () => (watcher === undefined ? false : watcher.check(server as HttpsServer)),
      close() {
        closed ??= (async () => {
          watcher?.stop();
          clearInterval(flushTimer);
          await maintenance?.stop();
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
    watcher?.stop();
    clearInterval(flushTimer);
    await maintenance?.stop();
    listener?.close();
    await driver.shutdown();
    throw error;
  }
}
