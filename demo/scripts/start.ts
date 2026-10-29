// Starts replicas A, B and C and the page as four child processes on their
// default ports, with each line of output prefixed by its name. Ctrl+C stops
// them all. First installs the demo's dependencies if they are missing or
// older than package-lock.json (say after a git pull), runs the reset if the
// database files aren't there yet, and builds the page.
//
// Usage: node scripts/start.ts [--fresh]
//   --fresh  reset the database files even if they exist
//
// Imports nothing outside node: and this directory's own files, since it
// may run before the dependencies are installed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { DEFAULT_DATA_DIR, REPLICA_NAMES, dataFileName } from "../server/identities.ts";

const demoDir = join(import.meta.dirname, "..");
const { values } = parseArgs({ options: { fresh: { type: "boolean", default: false } } });

/** Runs a step to completion, with its output shown; exits if it fails. */
function runStep(command: string, args: string[], shell = false): void {
  const result = spawnSync(command, args, { cwd: demoDir, stdio: "inherit", shell });
  if (result.status !== 0) {
    console.error(`${[command, ...args].join(" ")} failed (${result.error?.message ?? `exit code ${result.status}`})`);
    process.exit(result.status ?? 1);
  }
}

/** Whether npm has installed from the current package-lock.json. npm writes node_modules/.package-lock.json on each install. */
function installed(): boolean {
  const done = join(demoDir, "node_modules", ".package-lock.json");
  return existsSync(done) && statSync(done).mtimeMs >= statSync(join(demoDir, "package-lock.json")).mtimeMs;
}

if (!installed()) {
  console.log("Installing the demo's dependencies (npm ci in demo/)");
  // Under npm, npm_execpath is npm's own script, which runs the same on
  // every OS. Otherwise npm is a .cmd file on Windows, which needs a shell.
  const npm = process.env.npm_execpath;
  if (npm !== undefined && npm.endsWith(".js")) {
    runStep(process.execPath, [npm, "ci", "--no-audit", "--no-fund"]);
  } else {
    runStep("npm", ["ci", "--no-audit", "--no-fund"], process.platform === "win32");
  }
}

if (values.fresh || !REPLICA_NAMES.every((name) => existsSync(join(DEFAULT_DATA_DIR, dataFileName(name))))) {
  runStep(process.execPath, [join(demoDir, "scripts", "reset.ts")]);
}

// Vite's own script, run with this Node, works the same on every OS.
runStep(process.execPath, [join(demoDir, "node_modules", "vite", "bin", "vite.js"), "build", "web", "--logLevel", "warn"]);

function prefixLines(stream: NodeJS.ReadableStream, prefix: string, out: NodeJS.WritableStream): void {
  createInterface({ input: stream }).on("line", (line) => out.write(`${prefix} ${line}\n`));
}

const processes: [string, string[]][] = [
  ...REPLICA_NAMES.map((name): [string, string[]] => [name, [join(demoDir, "server", "replica.ts"), "--name", name]]),
  ["page", [join(demoDir, "server", "page.ts")]],
];
const children = new Map<string, ChildProcess>();
for (const [name, args] of processes) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  prefixLines(child.stdout, `[${name}]`, process.stdout);
  prefixLines(child.stderr, `[${name}]`, process.stderr);
  child.on("exit", (code, signal) => {
    children.delete(name);
    console.log(`[${name}] stopped (${signal ?? `exit code ${code}`})`);
    if (children.size === 0) {
      process.exit(0);
    }
  });
  children.set(name, child);
}

function stopAll(): void {
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
