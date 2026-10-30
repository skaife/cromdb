// Runs the demo for a test: resets three database files in a temporary
// directory, then starts replicas A, B and C as child processes on free ports
// (or the default ones, if asked), and the page server too if asked. Tests
// talk to them over HTTP only.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_PAGE_PORT, DEFAULT_PORTS, REPLICA_NAMES, dataFileName, type ReplicaName } from "../server/identities.ts";

const demoDir = join(import.meta.dirname, "..");

export interface Answer {
  readonly status: number;
  // The parsed JSON. Tests read into it freely.
  readonly body: any;
}

export interface Demo {
  readonly pids: Record<ReplicaName, number>;
  /** The page's port. Its URL is http://127.0.0.1:<port>, once started with page: true. */
  readonly pagePort: number;
  call(name: ReplicaName, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer>;
  /** Sends a request as is, for checks on headers. */
  fetch(name: ReplicaName, path: string, init?: RequestInit): Promise<Response>;
  /** Kills the replica's process and waits for it to exit. */
  kill(name: ReplicaName): Promise<void>;
  /** Starts a killed replica again, with the same arguments and file. */
  restart(name: ReplicaName): Promise<void>;
  stop(): Promise<void>;
}

/** Every answer any Demo has received, for checks across a whole test run. */
export const answers: Answer[] = [];

async function freePorts(count: number): Promise<number[]> {
  // All held open together, so no two are the same.
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Server>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    return address.port;
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/** Resolves once the replica says it is listening; rejects if it exits first. */
function started(name: string, child: ChildProcess): Promise<void> {
  // Both the replicas and the page server print this once listening.
  return new Promise((resolve, reject) => {
    const output: string[] = [];
    const timer = setTimeout(() => reject(new Error(`Replica ${name} did not start:\n${output.join("\n")}`)), 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Replica ${name} exited with ${code}:\n${output.join("\n")}`));
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) {
        continue;
      }
      createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        if (line.includes("listening on")) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** defaultPorts: listen on 4000 to 4003, as npm run demo does, instead of free ports. */
export async function startDemo(options: { page?: boolean; defaultPorts?: boolean } = {}): Promise<Demo> {
  const dir = mkdtempSync(join(tmpdir(), "cromdb-demo-"));
  const reset = spawnSync(process.execPath, [join(demoDir, "scripts", "reset.ts"), "--dir", dir], { encoding: "utf8" });
  if (reset.status !== 0) {
    throw new Error(`reset failed:\n${reset.stdout}${reset.stderr}`);
  }

  const [pagePort, ...ports] = (
    options.defaultPorts === true
      ? [DEFAULT_PAGE_PORT, ...REPLICA_NAMES.map((name) => DEFAULT_PORTS[name])]
      : await freePorts(REPLICA_NAMES.length + 1)
  ) as [number, ...number[]];
  const urls = Object.fromEntries(REPLICA_NAMES.map((name, i) => [name, `http://127.0.0.1:${ports[i]}`])) as Record<
    ReplicaName,
    string
  >;
  const children = new Map<ReplicaName | "page", ChildProcess>();
  const replicaArgs = new Map<ReplicaName, string[]>();
  for (const [i, name] of REPLICA_NAMES.entries()) {
    const peers = REPLICA_NAMES.filter((other) => other !== name).flatMap((other) => ["--peer", `${other}=${urls[other]}`]);
    const args = ["--name", name, "--port", String(ports[i]), "--data", join(dir, dataFileName(name)), "--page-port", String(pagePort), ...peers];
    replicaArgs.set(name, [join(demoDir, "server", "replica.ts"), ...args]);
    children.set(name, spawn(process.execPath, replicaArgs.get(name) ?? []));
  }
  if (options.page === true) {
    const replicas = REPLICA_NAMES.flatMap((name, i) => ["--replica", `${name}=${ports[i]}`]);
    children.set("page", spawn(process.execPath, [join(demoDir, "server", "page.ts"), "--port", String(pagePort), ...replicas]));
  }

  async function stop(): Promise<void> {
    for (const child of children.values()) {
      child.kill();
    }
    await Promise.all([...children.values()].map(exited));
    // Windows can hold the files briefly after the processes exit.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  try {
    await Promise.all([...children].map(([name, child]) => started(name, child)));
  } catch (error) {
    await stop();
    throw error;
  }

  const pids = Object.fromEntries(REPLICA_NAMES.map((name) => [name, children.get(name)?.pid])) as Record<ReplicaName, number>;

  return {
    pids,
    pagePort,
    async call(name, method, path, body, headers = {}) {
      const response = await fetch(urls[name] + path, {
        method,
        headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const answer = { status: response.status, body: await response.json() };
      answers.push(answer);
      return answer;
    },
    fetch(name, path, init) {
      return fetch(urls[name] + path, init);
    },
    async kill(name) {
      const child = children.get(name);
      if (child !== undefined) {
        child.kill("SIGKILL");
        await exited(child);
      }
    },
    async restart(name) {
      const child = spawn(process.execPath, replicaArgs.get(name) ?? []);
      children.set(name, child);
      await started(name, child);
    },
    stop,
  };
}
