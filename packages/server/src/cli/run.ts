// cromdb-server run: what the container runs. On an empty data directory it
// sets up from CROMDB_* variables first, never asking; then it starts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "@cromdb/driver";
import { dataPaths } from "../data-dir.js";
import { checkIssuer, DiscoveryError } from "../oidc-discovery.js";
import { DEFAULT_LISTEN, isPlainHttpOffMachine, parseSettingText, parseYesNo } from "../settings.js";
import { emailProblem, normalizeEmail } from "../text.js";
import { loadTlsFiles, TlsError } from "../tls.js";
import { CommandError, type Io } from "./io.js";
import { setup, type SetupFlags } from "./setup.js";

/** The variables setup reads; used only on the first start. */
export const SETUP_VARIABLES = [
  "CROMDB_SERVER_NAME",
  "CROMDB_PUBLIC_URL",
  "CROMDB_ALLOW_PLAIN_HTTP",
  "CROMDB_TLS_CERT",
  "CROMDB_TLS_KEY",
  "CROMDB_TRUST_PROXY",
  "CROMDB_ISSUER",
  "CROMDB_CLIENT_ID",
  "CROMDB_CLIENT_SECRET",
  "CROMDB_CLIENT_SECRET_FILE",
  "CROMDB_ADMIN_EMAIL",
] as const;

type Variable = (typeof SETUP_VARIABLES)[number];

/** A variable's value; an empty one (as "NAME=" in an env file leaves it) counts as not set. */
function variable(io: Io, name: Variable): string | undefined {
  const value = io.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function yesNoVariable(io: Io, name: Variable, problems: string[]): boolean | undefined {
  const text = variable(io, name);
  if (text === undefined) return undefined;
  const value = parseYesNo(text);
  if (value === undefined) problems.push(`${name}: answer yes or no, not ${JSON.stringify(text)}`);
  return value;
}

/**
 * Checks every variable before anything is written, and returns the flags
 * for setup, or every problem found, each naming its variable.
 */
export async function setupFromEnvironment(io: Io, listen: string): Promise<{ flags: SetupFlags } | { problems: string[] }> {
  const problems: string[] = [];
  const needed = (name: Variable, what: string): string | undefined => {
    const value = variable(io, name);
    if (value === undefined) problems.push(`${name} is needed: ${what}.`);
    return value;
  };
  const setting = (name: Variable, key: "serverName" | "publicUrl" | "oidcIssuer" | "oidcClientId", what: string): string | undefined => {
    const text = needed(name, what);
    if (text === undefined) return undefined;
    const checked = parseSettingText(key, text);
    if (!checked.ok) {
      problems.push(`${name}: ${checked.problem}`);
      return undefined;
    }
    return checked.value as string;
  };

  const serverName = setting("CROMDB_SERVER_NAME", "serverName", "the server name, shown to people");
  const publicUrl = setting("CROMDB_PUBLIC_URL", "publicUrl", "the public URL, where people reach the server");
  const allowPlainHttp = yesNoVariable(io, "CROMDB_ALLOW_PLAIN_HTTP", problems) === true;
  const trustProxy = yesNoVariable(io, "CROMDB_TRUST_PROXY", problems) ?? false;
  const plainHttp = (name: Variable, url: string) => {
    if (isPlainHttpOffMachine(url) && !allowPlainHttp) {
      problems.push(`${name}: ${url} is plain HTTP and not on this machine; set CROMDB_ALLOW_PLAIN_HTTP=yes to use it.`);
    }
  };
  if (publicUrl !== undefined) plainHttp("CROMDB_PUBLIC_URL", publicUrl);

  const certFile = variable(io, "CROMDB_TLS_CERT");
  const keyFile = variable(io, "CROMDB_TLS_KEY");
  if ((certFile === undefined) !== (keyFile === undefined)) {
    problems.push("CROMDB_TLS_CERT and CROMDB_TLS_KEY go together: set both, or neither for no TLS.");
  } else if (certFile !== undefined && keyFile !== undefined) {
    if (publicUrl !== undefined && !publicUrl.startsWith("https:")) {
      problems.push("CROMDB_TLS_CERT: the public URL is http, so the server can't serve HTTPS; give an https CROMDB_PUBLIC_URL.");
    } else {
      try {
        loadTlsFiles({ certFile: resolve(certFile), keyFile: resolve(keyFile) });
      } catch (error) {
        if (!(error instanceof TlsError)) throw error;
        problems.push(`CROMDB_TLS_CERT, CROMDB_TLS_KEY: ${error.message}`);
      }
    }
  }

  const issuer = setting("CROMDB_ISSUER", "oidcIssuer", "the login provider's issuer URL");
  if (issuer !== undefined) {
    plainHttp("CROMDB_ISSUER", issuer);
    try {
      await checkIssuer(issuer, io.fetch);
    } catch (error) {
      if (!(error instanceof DiscoveryError)) throw error;
      problems.push(`CROMDB_ISSUER: ${error.message}`);
    }
  }
  const clientId = setting("CROMDB_CLIENT_ID", "oidcClientId", "the client ID at the login provider");

  const secret = variable(io, "CROMDB_CLIENT_SECRET");
  const secretFile = variable(io, "CROMDB_CLIENT_SECRET_FILE");
  if (secret !== undefined && secretFile !== undefined) {
    problems.push("CROMDB_CLIENT_SECRET and CROMDB_CLIENT_SECRET_FILE are both set: set only one.");
  } else if (secret === undefined && secretFile === undefined) {
    problems.push("CROMDB_CLIENT_SECRET or CROMDB_CLIENT_SECRET_FILE is needed: the client secret at the login provider.");
  } else if (secretFile !== undefined) {
    try {
      if (readFileSync(secretFile, "utf8").replace(/\r?\n$/, "") === "") problems.push(`CROMDB_CLIENT_SECRET_FILE: ${secretFile} is empty.`);
    } catch (error) {
      problems.push(`CROMDB_CLIENT_SECRET_FILE: can't read ${secretFile}: ${(error as Error).message}`);
    }
  }

  const email = needed("CROMDB_ADMIN_EMAIL", "the email address of the first server admin");
  if (email !== undefined) {
    const problem = emailProblem(normalizeEmail(email));
    if (problem !== undefined) problems.push(`CROMDB_ADMIN_EMAIL: the email address ${problem}`);
  }

  if (problems.length > 0) {
    return { problems };
  }
  return {
    flags: {
      deployment: "new",
      "server-name": serverName,
      "public-url": publicUrl,
      "allow-plain-http": allowPlainHttp,
      ...(certFile !== undefined && keyFile !== undefined ? { "tls-cert": certFile, "tls-key": keyFile } : { "no-tls": true }),
      "trust-proxy": trustProxy ? "yes" : "no",
      listen,
      issuer,
      "client-id": clientId,
      ...(secretFile === undefined ? {} : { "client-secret-file": secretFile }),
      "admin-email": email,
    },
  };
}

/** The Io setup gets from run: never asks, even on a terminal, so a missing answer is never waited for. */
function withoutQuestions(io: Io): Io {
  return {
    ...io,
    out: (line) => io.out(line),
    err: (line) => io.err(line),
    prompter: {
      interactive: false,
      ask: async (question) => {
        throw new CommandError(`${question.flag} is needed`);
      },
      close: () => {},
    },
  };
}

export async function run(
  io: Io,
  dataDir: string,
  listen: string | undefined,
  start: (io: Io, dataDir: string, listen: string | undefined, backupsDir?: string) => Promise<number>,
  driver?: Driver,
  backupsDir?: string,
): Promise<number> {
  const root = resolve(dataDir);
  const empty = !existsSync(root) || readdirSync(root).length === 0;
  if (empty) {
    io.out(`${root} is empty: setting up from the CROMDB_* variables.`);
    const checked = await setupFromEnvironment(io, listen ?? DEFAULT_LISTEN);
    if ("problems" in checked) {
      for (const problem of checked.problems) io.err(problem);
      io.err("Nothing was written. Set the variables and start again.");
      return 1;
    }
    const status = await setup(withoutQuestions(io), checked.flags, root, driver, { startLine: false });
    if (status !== 0) return status;
    io.out("");
  } else {
    if (!existsSync(dataPaths(root).serverDb)) {
      throw new CommandError(`${root} has files but no finished setup. Empty it to set up again.`);
    }
    const set = SETUP_VARIABLES.filter((name) => variable(io, name) !== undefined);
    if (set.length > 0) {
      io.out(
        `${root} is set up, so ${set.join(", ")} ${set.length === 1 ? "is" : "are"} not used: they are read only on the first start. Change settings in the admin UI, or with "cromdb-server config set".`,
      );
    }
  }
  return start(io, root, listen, backupsDir);
}
