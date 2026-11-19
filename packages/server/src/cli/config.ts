// cromdb-server config list | get KEY | set KEY VALUE, and admin grant EMAIL.
// They change the server database directly. Stop the server first: it reads
// settings and people at start, and nothing stops two programs using one data
// directory yet (the storage lock comes with engine round E2).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Driver } from "@cromdb/driver";
import { createLevel2Driver } from "@cromdb/driver-level-2";
import { dataPaths } from "../data-dir.js";
import { Directory } from "../directory/directory.js";
import { checkIssuer, DiscoveryError } from "../oidc-discovery.js";
import {
  isPlainHttpOffMachine,
  isSecretKey,
  isSettingKey,
  parseSettingText,
  SECRET_KEYS,
  SETTING_KEYS,
  settingsProblems,
  showSetting,
  type Settings,
} from "../settings.js";
import { ServerDb } from "../store/server-db.js";
import { emailProblem, normalizeEmail } from "../text.js";
import { loadTlsFiles, TlsError } from "../tls.js";
import { CommandError, UsageError, type Io } from "./io.js";
import { confirmPlainHttp } from "./setup.js";

const RESTART = "Restart the server for the change to take effect.";

async function withServerDb<T>(dataDir: string, driver: Driver, fn: (db: ServerDb) => Promise<T>): Promise<T> {
  try {
    const db = await ServerDb.open(driver, dataPaths(dataDir).serverDb);
    return await fn(db);
  } finally {
    await driver.shutdown();
  }
}

function keyList(): string {
  return [...SETTING_KEYS, ...SECRET_KEYS].join(", ");
}

export interface ConfigFlags {
  readonly "from-file"?: string | undefined;
  readonly "allow-plain-http"?: boolean | undefined;
}

async function newSettings(io: Io, settings: Settings, key: string, values: readonly string[], flags: ConfigFlags): Promise<Settings> {
  if (!isSettingKey(key)) {
    throw new UsageError(`Unknown setting ${JSON.stringify(key)}. Settings: ${keyList()}`);
  }
  if (key === "tls") {
    if (values.length === 1 && values[0] === "off") {
      return { ...settings, tls: null };
    }
    const [certFile, keyFile] = values;
    if (values.length !== 2 || certFile === undefined || keyFile === undefined) {
      throw new UsageError("Use: config set tls CERT_FILE KEY_FILE, or config set tls off");
    }
    const files = { certFile: resolve(certFile), keyFile: resolve(keyFile) };
    try {
      loadTlsFiles(files);
    } catch (error) {
      if (error instanceof TlsError) throw new CommandError(error.message);
      throw error;
    }
    return { ...settings, tls: files };
  }
  const [text] = values;
  if (values.length !== 1 || text === undefined) {
    throw new UsageError(`Use: config set ${key} VALUE`);
  }
  const checked = parseSettingText(key, text);
  if (!checked.ok) {
    throw new CommandError(checked.problem);
  }
  if ((key === "publicUrl" || key === "oidcIssuer") && isPlainHttpOffMachine(checked.value as string)) {
    await confirmPlainHttp(io, checked.value as string, key === "publicUrl" ? "The public URL" : "The issuer URL", flags["allow-plain-http"]);
  }
  if (key === "oidcIssuer") {
    try {
      await checkIssuer(checked.value as string, io.fetch);
    } catch (error) {
      if (error instanceof DiscoveryError) throw new CommandError(error.message);
      throw error;
    }
  }
  return { ...settings, [key]: checked.value };
}

async function readSecretValue(io: Io, flags: ConfigFlags, key: string): Promise<string> {
  let value: string;
  if (flags["from-file"] !== undefined) {
    try {
      value = readFileSync(flags["from-file"], "utf8");
    } catch (error) {
      throw new CommandError(`Can't read ${flags["from-file"]}: ${(error as Error).message}`);
    }
  } else if (io.prompter.interactive) {
    value = await io.prompter.ask({ text: key, flag: "--from-file", secret: true });
  } else {
    value = await io.readStdin();
  }
  value = value.replace(/\r?\n$/, "");
  if (value === "") {
    throw new CommandError(`${key} can't be empty`);
  }
  return value;
}

export async function config(io: Io, dataDir: string, args: readonly string[], flags: ConfigFlags, driver: Driver = createLevel2Driver()): Promise<number> {
  const [action, key, ...values] = args;
  if (action === "list" && key === undefined) {
    return withServerDb(dataDir, driver, async (db) => {
      for (const name of SETTING_KEYS) io.out(`${name} = ${showSetting(db.settings, name)}`);
      for (const name of SECRET_KEYS) io.out(`${name} = ${db.secret(name) === undefined ? "(not set)" : "(set)"}`);
      return 0;
    });
  }
  if (action === "get" && key !== undefined && values.length === 0) {
    if (isSecretKey(key)) {
      throw new CommandError(`${key} is a secret; it is never shown. "config list" shows whether it is set.`);
    }
    if (!isSettingKey(key)) {
      throw new UsageError(`Unknown setting ${JSON.stringify(key)}. Settings: ${keyList()}`);
    }
    return withServerDb(dataDir, driver, async (db) => {
      io.out(showSetting(db.settings, key));
      return 0;
    });
  }
  if (action === "set" && key !== undefined) {
    if (isSecretKey(key)) {
      if (values.length > 0) {
        throw new UsageError(`Secrets are never given on the command line. Use: config set ${key} --from-file FILE, or pipe it in`);
      }
      const value = await readSecretValue(io, flags, key);
      return withServerDb(dataDir, driver, async (db) => {
        await db.setSecret(key, value);
        io.out(`Set ${key}. ${RESTART}`);
        return 0;
      });
    }
    return withServerDb(dataDir, driver, async (db) => {
      const settings = await newSettings(io, db.settings, key, values, flags);
      const problems = settingsProblems(settings);
      if (problems.length > 0) {
        throw new CommandError(problems.join("\n"));
      }
      await db.saveSettings(settings);
      io.out(`Set ${key} = ${isSettingKey(key) ? showSetting(settings, key) : ""}. ${RESTART}`);
      return 0;
    });
  }
  throw new UsageError("Use: config list | config get KEY | config set KEY VALUE");
}

/** admin grant EMAIL: the way back in when no server admin can log in. */
export async function admin(io: Io, dataDir: string, args: readonly string[], driver: Driver = createLevel2Driver()): Promise<number> {
  const [action, email, ...rest] = args;
  if (action !== "grant" || email === undefined || rest.length > 0) {
    throw new UsageError("Use: admin grant EMAIL");
  }
  const normalized = normalizeEmail(email);
  const problem = emailProblem(normalized);
  if (problem !== undefined) {
    throw new CommandError(`The email address ${problem}`);
  }
  return withServerDb(dataDir, driver, async (db) => {
    const paths = dataPaths(dataDir);
    const { identity } = db;
    const opened = await driver.call("database.open", { storage: { kind: "sqlite", path: paths.directory } });
    if (opened.databaseId !== identity.directoryDatabaseId) {
      throw new CommandError(`${paths.directory} is not this server's directory`);
    }
    const directory = await Directory.load({ driver, handle: opened.handle, serverId: identity.serverId, log: io.err });
    const result = await directory.grantAdmin(normalized, io.now());
    const who = `${normalized} (person ${result.entry.person.personId})`;
    if (result.invited) {
      io.out(`Invited ${who} as a server admin.`);
    } else if (!result.changed) {
      io.out(`${who} is already a server admin (status ${result.entry.person.status}). Nothing changed.`);
    } else {
      io.out(`${who} is now a server admin${result.enabled ? `, and no longer disabled (status ${result.entry.person.status})` : ""}.`);
    }
    io.out(RESTART);
    return 0;
  });
}
