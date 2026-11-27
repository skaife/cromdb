#!/usr/bin/env node
// The cromdb-server program.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { DriverError } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { BackupError, BackupsOffError } from "../backups/backups.js";
import { DirectoryError } from "../directory/directory.js";
import { OlderFileError } from "../store/open.js";
import { ServerDbError } from "../store/server-db.js";
import { TlsError } from "../tls.js";
import { backup } from "./backup.js";
import { admin, config } from "./config.js";
import { health } from "./health.js";
import { CommandError, processIo, UsageError, type Io } from "./io.js";
import { run } from "./run.js";
import { setup } from "./setup.js";
import { start } from "./start.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };

const USAGE = `Usage: cromdb-server COMMAND --data DIR [options]

Commands:
  setup                  Make a new data directory. Asks each question, or
                         takes it from a flag:
                           --deployment new|join  --server-name NAME
                           --public-url URL       --allow-plain-http
                           --tls-cert FILE --tls-key FILE, or --no-tls
                           --trust-proxy yes|no   --listen HOST:PORT
                           --issuer URL           --client-id ID
                           --client-secret-file FILE (or CROMDB_CLIENT_SECRET)
                           --admin-email EMAIL
  start                  Serve. --listen HOST:PORT overrides the setting.
                         --backups DIR (or CROMDB_BACKUPS): where backups go;
                         without one, backups are off.
  run                    What the container runs: on an empty data directory,
                         set up from the CROMDB_* variables first (see
                         docker/README.md), then start. --listen and --backups
                         as for start.
  backup                 Back up the server while it is stopped: one set in
                         --to DIR, or else CROMDB_BACKUPS. While it runs, use
                         Back up now in the admin UI instead.
  health                 Ask the server on this machine whether it is up, over
                         HTTPS, then HTTP. --listen HOST:PORT, default
                         127.0.0.1:8080. Needs no --data.
  config list            Show the settings. Secrets show only whether they are set.
  config get KEY         Show one setting.
  config set KEY VALUE   Change a setting (stop the server first).
                         config set tls CERT_FILE KEY_FILE, or config set tls off
                         config set oidcClientSecret --from-file FILE (or piped in)
  admin grant EMAIL      Make someone a server admin, inviting them if unknown.
  version                Show the versions of the server, driver and engine.`;

const COMMON: ParseArgsConfig["options"] = { data: { type: "string" }, help: { type: "boolean", short: "h" } };

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  setup: {
    ...COMMON,
    deployment: { type: "string" },
    "server-name": { type: "string" },
    "public-url": { type: "string" },
    "allow-plain-http": { type: "boolean" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    "no-tls": { type: "boolean" },
    "trust-proxy": { type: "string" },
    listen: { type: "string" },
    issuer: { type: "string" },
    "client-id": { type: "string" },
    "client-secret-file": { type: "string" },
    "admin-email": { type: "string" },
  },
  start: { ...COMMON, listen: { type: "string" }, backups: { type: "string" } },
  run: { ...COMMON, listen: { type: "string" }, backups: { type: "string" } },
  backup: { ...COMMON, to: { type: "string" } },
  health: { help: { type: "boolean", short: "h" }, listen: { type: "string" } },
  config: { ...COMMON, "from-file": { type: "string" }, "allow-plain-http": { type: "boolean" } },
  admin: COMMON,
  version: COMMON,
};

function parse(command: string, args: string[]) {
  try {
    const { values, positionals } = parseArgs({ args, options: OPTIONS[command] ?? COMMON, allowPositionals: true, strict: true });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function requireData(values: Record<string, unknown>, env: Io["env"]): string {
  const data = typeof values["data"] === "string" ? values["data"] : env["CROMDB_DATA"];
  if (data === undefined || data === "") {
    throw new UsageError("--data DIR is needed: the server's data directory");
  }
  return data;
}

async function version(io: Io): Promise<number> {
  const driver = createLevel4Driver();
  try {
    const info = await driver.call("driver.info", {});
    io.out(`${PACKAGE.name} ${PACKAGE.version}`);
    io.out(`${info.driver.name} ${info.driver.version} (driver interface ${info.interface}, database level ${info.levels.min}-${info.levels.max})`);
    io.out(`${info.engine.name} ${info.engine.version}`);
  } finally {
    await driver.shutdown();
  }
  return 0;
}

/** Runs one command. Returns the exit status: 0 done, 1 refused or failed, 2 wrong usage or not available. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    }
    if (!Object.hasOwn(OPTIONS, command)) {
      throw new UsageError(`Unknown command ${JSON.stringify(command)}`);
    }
    const { values, positionals } = parse(command, rest);
    if (values["help"] === true) {
      io.out(USAGE);
      return 0;
    }
    switch (command) {
      case "version":
        return await version(io);
      case "setup":
        if (positionals.length > 0) throw new UsageError(`setup takes no arguments, only flags`);
        return await setup(io, values, requireData(values, io.env));
      case "start":
        if (positionals.length > 0) throw new UsageError(`start takes no arguments, only flags`);
        return await start(io, requireData(values, io.env), values["listen"] as string | undefined, values["backups"] as string | undefined);
      case "run":
        if (positionals.length > 0) throw new UsageError(`run takes no arguments, only flags`);
        return await run(io, requireData(values, io.env), values["listen"] as string | undefined, start, undefined, values["backups"] as string | undefined);
      case "backup":
        if (positionals.length > 0) throw new UsageError(`backup takes no arguments, only flags`);
        return await backup(io, requireData(values, io.env), values["to"] as string | undefined);
      case "health":
        if (positionals.length > 0) throw new UsageError(`health takes no arguments, only flags`);
        return await health(io, values["listen"] as string | undefined);
      case "config":
        return await config(io, requireData(values, io.env), positionals, values);
      default:
        return await admin(io, requireData(values, io.env), positionals);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err('Run "cromdb-server help" for the commands.');
      return 2;
    }
    if (
      error instanceof CommandError ||
      error instanceof ServerDbError ||
      error instanceof DirectoryError ||
      error instanceof TlsError ||
      error instanceof BackupError ||
      error instanceof BackupsOffError ||
      error instanceof OlderFileError
    ) {
      io.err(error.message);
      return 1;
    }
    if (error instanceof DriverError) {
      io.err(`${error.code}: ${error.message}`);
      return 1;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      io.err(`Can't listen there: ${(error as Error).message}`);
      return 1;
    }
    io.err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  } finally {
    io.prompter.close();
  }
}

// Run when this file is the program, not when a test imports it.
function isProgram(): boolean {
  const invoked = process.argv[1];
  try {
    return invoked !== undefined && realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isProgram()) {
  process.exitCode = await main(process.argv.slice(2), processIo());
}
