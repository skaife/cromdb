// cromdb-server setup: makes a new data directory. Every question can be
// answered by a flag instead, so setup can run without a terminal.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { dataPaths, restrict } from "../data-dir.js";
import { Directory, SERVER_PRINCIPAL } from "../directory/directory.js";
import { checkIssuer, DiscoveryError } from "../oidc-discovery.js";
import {
  DEFAULT_LISTEN,
  DEFAULT_SESSION_IDLE_MINUTES,
  DEFAULT_SESSION_MAX_DAYS,
  DEFAULT_SERVER_DB_PURGE_AFTER_DAYS,
  DEFAULT_MAINTENANCE_HOUR,
  isPlainHttpOffMachine,
  parseSettingText,
  parseYesNo,
  settingsProblems,
  type Checked,
  type Settings,
  type TlsFiles,
} from "../settings.js";
import { ServerDb, serverFile } from "../store/server-db.js";
import { emailProblem, normalizeEmail } from "../text.js";
import { loadTlsFiles, TlsError } from "../tls.js";
import { CommandError, UsageError, type Io, type Question } from "./io.js";

export interface SetupFlags {
  readonly data?: string | undefined;
  readonly deployment?: string | undefined;
  readonly "server-name"?: string | undefined;
  readonly "public-url"?: string | undefined;
  readonly "allow-plain-http"?: boolean | undefined;
  readonly "tls-cert"?: string | undefined;
  readonly "tls-key"?: string | undefined;
  readonly "no-tls"?: boolean | undefined;
  readonly "trust-proxy"?: string | undefined;
  readonly listen?: string | undefined;
  readonly issuer?: string | undefined;
  readonly "client-id"?: string | undefined;
  readonly "client-secret-file"?: string | undefined;
  readonly "admin-email"?: string | undefined;
}

type Check<T> = (text: string) => Promise<Checked<T>> | Checked<T>;

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = (problem: string): Checked<never> => ({ ok: false, problem });

/**
 * The answer from the flag if given, else asked. A bad flag stops setup; a
 * bad typed answer is explained and asked again.
 */
async function answer<T>(io: Io, flag: string | undefined, question: Question, check: Check<T>): Promise<T> {
  if (flag !== undefined) {
    const checked = await check(flag);
    if (!checked.ok) {
      throw new CommandError(`${question.flag}: ${checked.problem}`);
    }
    return checked.value;
  }
  for (;;) {
    const checked = await check(await io.prompter.ask(question));
    if (checked.ok) {
      return checked.value;
    }
    io.err(checked.problem);
  }
}

function yesNo(text: string): Checked<boolean> {
  const value = parseYesNo(text);
  return value === undefined ? bad("Answer yes or no") : ok(value);
}

/** The plain HTTP warning; confirmed by --allow-plain-http or a typed yes. */
export async function confirmPlainHttp(io: Io, url: string, what: string, allowed: boolean | undefined): Promise<void> {
  io.err(
    `Warning: ${what} ${url} is plain HTTP and not on this machine. Passwords, cookies and data would cross the network unencrypted. Use it only on a network you trust.`,
  );
  if (allowed === true) {
    return;
  }
  if (!io.prompter.interactive) {
    throw new CommandError(`${what} is plain HTTP; give --allow-plain-http to use it anyway`);
  }
  const confirmed = await answer(io, undefined, { text: "Use plain HTTP anyway? (yes/no)", flag: "--allow-plain-http", default: "no" }, yesNo);
  if (!confirmed) {
    throw new CommandError("Setup stopped; nothing was written");
  }
}

function checkTls(certFile: string, keyFile: string): Checked<TlsFiles> {
  const files = { certFile: resolve(certFile), keyFile: resolve(keyFile) };
  try {
    loadTlsFiles(files);
  } catch (error) {
    if (error instanceof TlsError) return bad(error.message);
    throw error;
  }
  return ok(files);
}

async function askTls(io: Io, flags: SetupFlags, publicUrl: string): Promise<TlsFiles | null> {
  const certFlag = flags["tls-cert"];
  const keyFlag = flags["tls-key"];
  if ((certFlag === undefined) !== (keyFlag === undefined)) {
    throw new UsageError("--tls-cert and --tls-key go together");
  }
  if (flags["no-tls"] === true && certFlag !== undefined) {
    throw new UsageError("--no-tls can't go with --tls-cert and --tls-key");
  }
  const https = publicUrl.startsWith("https:");
  if (!https) {
    if (certFlag !== undefined) {
      throw new CommandError("The public URL is http, so the server can't serve HTTPS; give an https public URL to use --tls-cert");
    }
    return null;
  }
  if (certFlag !== undefined && keyFlag !== undefined) {
    const checked = checkTls(certFlag, keyFlag);
    if (!checked.ok) throw new CommandError(checked.problem);
    return checked.value;
  }
  if (flags["no-tls"] === true) {
    return null;
  }
  const here = await answer(
    io,
    undefined,
    {
      text: "Serve HTTPS here, with a certificate file and key file? Answer no if a reverse proxy in front of the server serves HTTPS (yes/no)",
      flag: "--tls-cert and --tls-key, or --no-tls",
      default: "yes",
    },
    yesNo,
  );
  if (!here) {
    return null;
  }
  for (;;) {
    const certFile = await io.prompter.ask({ text: "Certificate file (PEM, with its chain)", flag: "--tls-cert" });
    const keyFile = await io.prompter.ask({ text: "Private key file (PEM)", flag: "--tls-key" });
    const checked = checkTls(certFile, keyFile);
    if (checked.ok) return checked.value;
    io.err(checked.problem);
  }
}

async function readSecret(io: Io, flags: SetupFlags): Promise<string> {
  const file = flags["client-secret-file"];
  let secret: string | undefined;
  if (file !== undefined) {
    try {
      secret = readFileSync(file, "utf8");
    } catch (error) {
      throw new CommandError(`Can't read --client-secret-file ${file}: ${(error as Error).message}`);
    }
  } else if (io.env["CROMDB_CLIENT_SECRET"] !== undefined) {
    secret = io.env["CROMDB_CLIENT_SECRET"];
  }
  if (secret !== undefined) {
    secret = secret.replace(/\r?\n$/, "");
    if (secret === "") throw new CommandError("The client secret is empty");
    return secret;
  }
  io.out("The client secret can't be checked until someone logs in.");
  return answer(
    io,
    undefined,
    { text: "Client secret", flag: "--client-secret-file or CROMDB_CLIENT_SECRET", secret: true },
    (text) => (text === "" ? bad("The client secret can't be empty") : ok(text)),
  );
}

interface Answers {
  readonly settings: Settings;
  readonly clientSecret: string;
  readonly adminEmail: string;
}

async function ask(io: Io, flags: SetupFlags): Promise<Answers | "join"> {
  const deployment = await answer(
    io,
    flags.deployment,
    { text: "Start a new deployment, or join an existing one? (new/join)", flag: "--deployment", default: "new" },
    (text) => (text === "new" || text === "join" ? ok(text) : bad("Answer new or join")),
  );
  if (deployment === "join") {
    return "join";
  }
  const text = (key: Parameters<typeof parseSettingText>[0]) => (input: string) => {
    const checked = parseSettingText(key, input);
    return checked.ok ? ok(checked.value as string) : checked;
  };
  const serverName = await answer(io, flags["server-name"], { text: "Server name, shown to people", flag: "--server-name" }, text("serverName"));
  const publicUrl = await answer(
    io,
    flags["public-url"],
    { text: "Public URL, where people reach the server (https://...)", flag: "--public-url" },
    text("publicUrl"),
  );
  if (isPlainHttpOffMachine(publicUrl)) {
    await confirmPlainHttp(io, publicUrl, "The public URL", flags["allow-plain-http"]);
  }
  const tls = await askTls(io, flags, publicUrl);
  const trustProxy = await answer(
    io,
    flags["trust-proxy"],
    {
      text: "Is the server behind a reverse proxy? If yes, it trusts the proxy's X-Forwarded headers (yes/no)",
      flag: "--trust-proxy",
      default: publicUrl.startsWith("https:") && tls === null ? "yes" : "no",
    },
    yesNo,
  );
  const listen = await answer(io, flags.listen, { text: "Listen address", flag: "--listen", default: DEFAULT_LISTEN }, text("listen"));
  const oidcIssuer = await answer(
    io,
    flags.issuer,
    { text: "Login provider's issuer URL (for Keycloak, https://.../realms/<realm>)", flag: "--issuer" },
    async (input) => {
      const checked = parseSettingText("oidcIssuer", input);
      if (!checked.ok) return checked;
      const issuer = checked.value as string;
      if (isPlainHttpOffMachine(issuer)) {
        await confirmPlainHttp(io, issuer, "The issuer URL", flags["allow-plain-http"]);
      }
      try {
        await checkIssuer(issuer, io.fetch);
      } catch (error) {
        if (error instanceof DiscoveryError) return bad(error.message);
        throw error;
      }
      return ok(issuer);
    },
  );
  const oidcClientId = await answer(io, flags["client-id"], { text: "Client ID at the provider", flag: "--client-id" }, text("oidcClientId"));
  const clientSecret = await readSecret(io, flags);
  const adminEmail = await answer(
    io,
    flags["admin-email"],
    { text: "Email address of the first server admin", flag: "--admin-email" },
    (input) => {
      const email = normalizeEmail(input);
      const problem = emailProblem(email);
      return problem === undefined ? ok(email) : bad(`The email address ${problem}`);
    },
  );
  const settings: Settings = {
    serverName,
    publicUrl,
    listen,
    tls,
    trustProxy,
    oidcIssuer,
    oidcClientId,
    sessionIdleMinutes: DEFAULT_SESSION_IDLE_MINUTES,
    sessionMaxDays: DEFAULT_SESSION_MAX_DAYS,
    serverDbPurgeAfterDays: DEFAULT_SERVER_DB_PURGE_AFTER_DAYS,
    maintenanceHour: DEFAULT_MAINTENANCE_HOUR,
    maintenanceTimeZone: null,
    updateCheck: false,
  };
  const problems = settingsProblems(settings);
  if (problems.length > 0) {
    throw new CommandError(problems.join("\n"));
  }
  return { settings, clientSecret, adminEmail };
}

/** Writes a new data directory. The identity goes last: without it the server won't start. */
async function write(driver: Driver, dataDir: string, answers: Answers, now: Date): Promise<void> {
  const paths = dataPaths(dataDir);
  mkdirSync(paths.root, { recursive: true });
  restrict(paths.root, 0o700);
  mkdirSync(paths.databases);
  const serverDb = await ServerDb.create(driver, paths.serverDb, answers.settings, { oidcClientSecret: answers.clientSecret });
  restrict(paths.serverDb, 0o600);
  const serverId = randomUUID();
  const directory = await driver.call("database.create", {
    storage: serverFile(paths.directory),
    principal: SERVER_PRINCIPAL,
  });
  const people = await Directory.load({ driver, handle: directory.handle, serverId, log: () => {} });
  await people.invite({ email: answers.adminEmail, serverAdmin: true, by: "setup", now });
  await serverDb.writeIdentity({
    serverId,
    deploymentId: randomUUID(),
    createdAt: now.toISOString(),
    directoryDatabaseId: directory.databaseId,
  });
}

/** Removes what a failed setup made: the whole directory if setup made it, else only its contents. */
function undo(dataDir: string, existed: boolean): void {
  const root = resolve(dataDir);
  if (!existed) {
    rmSync(root, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync(root)) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
}

export interface SetupOptions {
  /** Whether to end with how to start the server. Default true; run starts it itself. */
  readonly startLine?: boolean;
}

export async function setup(
  io: Io,
  flags: SetupFlags,
  dataDir: string,
  driver: Driver = createLevel4Driver(),
  options: SetupOptions = {},
): Promise<number> {
  const root = resolve(dataDir);
  const existed = existsSync(root);
  if (existed && readdirSync(root).length > 0) {
    await driver.shutdown();
    throw new CommandError(`${root} is not empty. Setup only writes a new data directory.`);
  }
  let answers: Answers | "join";
  try {
    answers = await ask(io, flags);
  } catch (error) {
    await driver.shutdown();
    throw error;
  }
  if (answers === "join") {
    await driver.shutdown();
    io.err("Joining an existing deployment isn't available yet.");
    return 2;
  }
  try {
    await write(driver, root, answers, io.now());
    await driver.shutdown();
  } catch (error) {
    await driver.shutdown().catch(() => {});
    undo(root, existed);
    throw error;
  }
  const { publicUrl, oidcClientId } = answers.settings;
  io.out(`Set up ${answers.settings.serverName} in ${root}.`);
  io.out("");
  io.out(`Register this in the login provider, for client ${JSON.stringify(oidcClientId)}:`);
  io.out(`  Redirect URI:              ${publicUrl}/auth/callback`);
  io.out(`  Post-logout redirect URI:  ${publicUrl}/`);
  io.out(`  Scopes:                    openid, email and profile`);
  io.out("");
  io.out(`${answers.adminEmail} is invited as the first server admin.`);
  if (options.startLine !== false) {
    io.out(`Start the server with: cromdb-server start --data ${root}`);
  }
  return 0;
}
