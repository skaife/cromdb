// Runs the demo for a test: resets three database files in a temporary
// directory, then starts replicas A, B and C as child processes on free ports.
// Tests talk to them over HTTP only.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { REPLICA_NAMES, dataFileName, type ReplicaName } from "../server/identities.ts";

const demoDir = join(import.meta.dirname, "..");

export interface Answer {
  readonly status: number;
  // The parsed JSON. Tests read into it freely.
  readonly body: any;
}

export interface Demo {
  readonly pids: Record<ReplicaName, number>;
  call(name: ReplicaName, method: string, path: string, body?: unknown): Promise<Answer>;
  /** Kills the replica's process and waits for it to exit. */
  kill(name: ReplicaName): Promise<void>;
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

export async function startDemo(): Promise<Demo> {
  const dir = mkdtempSync(join(tmpdir(), "cromdb-demo-"));
  const reset = spawnSync(process.execPath, [join(demoDir, "scripts", "reset.ts"), "--dir", dir], { encoding: "utf8" });
  if (reset.status !== 0) {
    throw new Error(`reset failed:\n${reset.stdout}${reset.stderr}`);
  }

  const ports = await freePorts(REPLICA_NAMES.length);
  const urls = Object.fromEntries(REPLICA_NAMES.map((name, i) => [name, `http://127.0.0.1:${ports[i]}`])) as Record<
    ReplicaName,
    string
  >;
  const children = new Map<ReplicaName, ChildProcess>();
  for (const [i, name] of REPLICA_NAMES.entries()) {
    const peers = REPLICA_NAMES.filter((other) => other !== name).flatMap((other) => ["--peer", `${other}=${urls[other]}`]);
    const args = ["--name", name, "--port", String(ports[i]), "--data", join(dir, dataFileName(name)), ...peers];
    children.set(name, spawn(process.execPath, [join(demoDir, "server", "replica.ts"), ...args]));
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

  const pids = Object.fromEntries([...children].map(([name, child]) => [name, child.pid])) as Record<ReplicaName, number>;

  return {
    pids,
    async call(name, method, path, body) {
      const response = await fetch(urls[name] + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const answer = { status: response.status, body: await response.json() };
      answers.push(answer);
      return answer;
    },
    async kill(name) {
      const child = children.get(name);
      if (child !== undefined) {
        child.kill("SIGKILL");
        await exited(child);
      }
    },
    stop,
  };
}
