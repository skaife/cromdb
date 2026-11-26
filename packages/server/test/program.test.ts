// The built program, run as a process. The root test script builds first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { fakeHarness, PUBLIC_URL, TestBrowser, type LoginHarness } from "./harness.js";
import { fakeIssuer, scriptedIo, setUp, tempDir, type FakeIssuer } from "./helpers.js";

const program = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));

let fake: FakeIssuer;
let dir: ReturnType<typeof tempDir>;

beforeAll(async () => {
  fake = await fakeIssuer();
});
afterAll(() => fake.close());
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => dir.remove());

describe("the cromdb-server program", () => {
  it("is built", () => {
    expect(existsSync(program), `${program} is missing: run npm run build first`).toBe(true);
  });

  it("shows its versions", () => {
    const result = spawnSync(process.execPath, [program, "version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@cromdb/server 0.3.0");
  });

  it("exits 2 on wrong usage", () => {
    const result = spawnSync(process.execPath, [program, "frobnicate"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });

  it("serves until it is stopped", async () => {
    const data = dir.join("data");
    await setUp(data, fake.issuer);
    const child = spawn(process.execPath, [program, "start", "--data", data, "--listen", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match?.[1] !== undefined) resolve(match[1]);
      });
      child.on("exit", () => reject(new Error(`exited early: ${output}`)));
    });
    expect(await (await fetch(`${url}/api/v0/health`)).json()).toEqual({ status: "ok" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    const code = await exited;
    // Windows has no signals: kill ends the process at once.
    if (process.platform !== "win32") {
      expect(code).toBe(0);
      expect(output).toContain("SIGTERM: stopping");
    }
  }, 30_000);

  it("locks its data directory while it runs, and frees it however it stops", async () => {
    const data = dir.join("data");
    await setUp(data, fake.issuer);
    const child = spawn(process.execPath, [program, "start", "--data", data, "--listen", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("listening on")) resolve();
      });
      child.on("exit", () => reject(new Error(`exited early: ${output}`)));
    });
    const locked = spawnSync(process.execPath, [program, "config", "list", "--data", data], { encoding: "utf8" });
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("The server is running, or another command is using this data directory. Stop it first.");

    // Killed outright, with no chance to close anything: the operating
    // system releases the lock.
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const free = spawnSync(process.execPath, [program, "config", "list", "--data", data], { encoding: "utf8" });
    expect(free.stderr).toBe("");
    expect(free.status).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Stopping: by a signal, or by a server admin's restart

interface Started {
  readonly child: ChildProcess;
  readonly url: string;
  /** Everything the process wrote, so far. */
  output(): string;
  /** What it wrote to stderr, so far. */
  errors(): string;
  /** Resolves with the exit code once the process has ended. */
  readonly exited: Promise<number | null>;
}

/** Runs "cromdb-server start" (or run) with the environment given, and waits until it listens. */
async function startProgram(data: string, env: NodeJS.ProcessEnv, command: "start" | "run" = "start"): Promise<Started> {
  const child = spawn(process.execPath, [program, command, "--data", data, "--listen", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  let errors = "";
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    errors += chunk.toString();
  });
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    void exited.then(() => reject(new Error(`exited early: ${output}`)));
  });
  return { child, url, output: () => output, errors: () => errors, exited };
}

/** The environment without CROMDB_RESTART_ON_EXIT, then with what is given. */
function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!Object.hasOwn(extra, "CROMDB_RESTART_ON_EXIT")) delete env["CROMDB_RESTART_ON_EXIT"];
  return env;
}

describe("the cromdb-server program, stopped", () => {
  let harness: LoginHarness;
  let running: Started | undefined;

  beforeAll(async () => {
    harness = await fakeHarness();
  });
  afterAll(() => harness.close());
  afterEach(async () => {
    if (running !== undefined && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await running.exited;
    }
    running = undefined;
  });

  /** Sets up a data directory for the fake provider, with its admin as setup's admin. */
  async function setUpForLogin(data: string): Promise<void> {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: harness.client.secret } });
    const flags = ["setup", "--data", data, "--deployment", "new", "--server-name", "Test Server", "--public-url", PUBLIC_URL, "--trust-proxy", "no", "--listen", "127.0.0.1:0"];
    const status = await main([...flags, "--issuer", harness.issuer, "--client-id", harness.client.clientId, "--admin-email", harness.users.admin.email], io);
    if (status !== 0) throw new Error(`setup failed with ${status}: ${io.text()}`);
  }

  /**
   * Starts the program, logs the admin in, makes a database and a document,
   * stops it the way given, and checks it stopped cleanly: exit 0, the stop
   * line, nothing written to stderr, and a second start on the same data
   * directory that has the session, the database and the document.
   */
  async function stopsCleanly(stop: (server: Started, admin: TestBrowser) => Promise<void>, stopLine: string, env: NodeJS.ProcessEnv): Promise<void> {
    const data = dir.join("data");
    await setUpForLogin(data);
    running = await startProgram(data, env);
    const admin = new TestBrowser(running.url, PUBLIC_URL);
    const login = await admin.login(harness, harness.users.admin);
    expect(login.status, login.text).toBe(302);
    const database = await admin.api("POST", "/api/v0/databases", { name: "Notes" });
    expect(database.status).toBe(201);
    const databaseId: string = database.body.databaseId;
    const document = await admin.api("POST", `/api/v0/databases/${databaseId}/documents`, { content: { title: "Kept" } });
    expect(document.status).toBe(201);

    const first = running;
    await stop(first, admin);
    expect(await first.exited, first.output()).toBe(0);
    expect(first.output()).toContain(stopLine);
    expect(first.errors()).toBe("");
    expect(first.output()).not.toMatch(/failed/i);

    running = await startProgram(data, env);
    const again = new TestBrowser(running.url, PUBLIC_URL);
    again.setCookie("cromdb-session", admin.cookie("cromdb-session") ?? "");
    expect((await again.api("GET", "/api/v0/me")).status).toBe(200);
    const read = await again.api("GET", `/api/v0/databases/${databaseId}/documents/${document.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.content).toEqual({ title: "Kept" });
    expect(running.output()).toContain("1 databases");
  }

  // Windows has no signals: kill ends the process at once.
  it.skipIf(process.platform === "win32")("by SIGTERM, closes everything and starts again on the same data", async () => {
    await stopsCleanly(
      async (server) => {
        server.child.kill("SIGTERM");
      },
      "SIGTERM: stopping",
      environment(),
    );
  }, 60_000);

  it("by a restart, stops the same way and exits 0 for what supervises it", async () => {
    await stopsCleanly(
      async (_server, admin) => {
        const restart = await admin.api("POST", "/api/v0/server/restart");
        expect(restart.status).toBe(202);
        expect(restart.body).toEqual({ restarting: true });
      },
      "Restart asked for: stopping",
      environment({ CROMDB_RESTART_ON_EXIT: "1" }),
    );
  }, 60_000);

  it("run sets up an empty data directory from the variables, serves, and is healthy", async () => {
    const data = dir.join("data");
    const env = environment({
      CROMDB_SERVER_NAME: "Run Server",
      CROMDB_PUBLIC_URL: PUBLIC_URL,
      CROMDB_ISSUER: harness.issuer,
      CROMDB_CLIENT_ID: harness.client.clientId,
      CROMDB_CLIENT_SECRET: harness.client.secret,
      CROMDB_ADMIN_EMAIL: harness.users.admin.email,
    });
    running = await startProgram(data, env, "run");
    expect(running.output()).toContain("Redirect URI:              http://localhost:8080/auth/callback");
    expect(running.output()).toContain("Run Server is listening on");
    const admin = new TestBrowser(running.url, PUBLIC_URL);
    expect((await admin.login(harness, harness.users.admin)).status).toBe(302);
    expect((await admin.api("GET", "/api/v0/me")).body.serverAdmin).toBe(true);
    const port = new URL(running.url).port;
    const health = spawnSync(process.execPath, [program, "health", "--listen", `127.0.0.1:${port}`], { encoding: "utf8" });
    expect(health.status, health.stderr).toBe(0);
    expect(health.stdout).toBe("ok (http)\n");
    if (process.platform !== "win32") {
      running.child.kill("SIGTERM");
      expect(await running.exited, running.output()).toBe(0);
      expect(running.errors()).toBe("");
    }
  }, 60_000);

  it("refuses a restart when nothing would start it again, and keeps serving", async () => {
    const data = dir.join("data");
    await setUpForLogin(data);
    running = await startProgram(data, environment());
    const admin = new TestBrowser(running.url, PUBLIC_URL);
    expect((await admin.login(harness, harness.users.admin)).status).toBe(302);
    const restart = await admin.api("POST", "/api/v0/server/restart");
    expect(restart.status).toBe(409);
    expect(restart.body.error.code).toBe("NOT_SUPERVISED");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(running.child.exitCode).toBeNull();
    expect((await admin.api("GET", "/api/v0/health")).status).toBe(200);
  }, 60_000);
});
