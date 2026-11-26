// A smoke test of the Docker image, run in CI after "docker build" and by
// hand before a release. Linux only: it runs the container on the host's
// network, so 127.0.0.1 is the same address for this script, the fake login
// provider and the server, and port 8080 must be free.
//
// Usage: node scripts/docker-smoke.ts IMAGE
//
// It starts the fake provider (test/fake-provider.ts), runs the image on an
// empty named volume with the setup variables, waits for Docker to call it
// healthy, logs the admin in, makes a database and a document, restarts the
// server from the API and checks it comes back with both, stops it and
// checks it stopped cleanly, then checks that a first start with a variable
// missing names it and writes nothing. It prints the image's size, and
// removes its containers and volumes whatever happens.

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fakeProvider } from "../test/fake-provider.ts";

function imageArgument(): string {
  const given = process.argv[2];
  if (given === undefined || given.startsWith("-")) {
    console.error("Usage: node scripts/docker-smoke.ts IMAGE");
    process.exit(2);
  }
  return given;
}
const image = imageArgument();

const PUBLIC_URL = "http://localhost:8080";
const SERVER = "http://127.0.0.1:8080";
const run = `cromdb-smoke-${process.pid}`;
const CLIENT = { clientId: "cromdb", secret: "smoke-secret" };
const ADMIN = { username: "admin", sub: "sub-admin", email: "admin@example.com", emailVerified: true, name: "Ada Admin" };

function step(text: string): void {
  console.log(`- ${text}`);
}

function fail(text: string): never {
  throw new Error(text);
}

function check(condition: boolean, text: string): void {
  if (!condition) fail(text);
}

function docker(args: string[], options: { allowFail?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error !== undefined) fail(`docker ${args[0]}: ${result.error.message}`);
  const out = { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  if (out.status !== 0 && options.allowFail !== true) {
    fail(`docker ${args.join(" ")} exited ${out.status}: ${out.stderr || out.stdout}`);
  }
  return out;
}

function inspect(container: string, format: string): string {
  return docker(["inspect", "-f", format, container]).stdout;
}

async function waitFor(what: string, seconds: number, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await done()) return;
    if (Date.now() > deadline) fail(`${what}: not after ${seconds} s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function portFree(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** A browser that knows the server as PUBLIC_URL but reaches it at SERVER, keeping cookies by name. */
class Browser {
  readonly #cookies = new Map<string, string>();

  cookies(): ReadonlyMap<string, string> {
    return this.#cookies;
  }

  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; location: string | null; body: any }> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {};
    if (this.#cookies.size > 0) headers["cookie"] = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (method !== "GET") headers["origin"] = new URL(PUBLIC_URL).origin;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${SERVER}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals).trim();
      if (/Max-Age=0/i.test(header)) this.#cookies.delete(name);
      else this.#cookies.set(name, pair.slice(equals + 1).trim());
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not JSON: kept as text.
    }
    return { status: response.status, location: response.headers.get("location"), body };
  }

  async login(): Promise<void> {
    const start = await this.request("/auth/login?returnTo=%2F");
    check(start.status === 302 && start.location !== null, `/auth/login answered ${start.status}`);
    const authorized = await fetch(start.location ?? "", { headers: { "x-fake-login": ADMIN.username }, redirect: "manual" });
    const back = authorized.headers.get("location");
    check(authorized.status === 302 && back !== null, `the provider answered ${authorized.status}`);
    const callback = new URL(back ?? "");
    check(callback.origin === new URL(PUBLIC_URL).origin, `the provider sent the browser to ${callback.origin}`);
    const done = await this.request(callback.pathname + callback.search);
    check(done.status === 302, `/auth/callback answered ${done.status}: ${JSON.stringify(done.body)}`);
  }
}

const containers: string[] = [];
const volumes: string[] = [];

function cleanUp(): void {
  for (const container of containers) docker(["rm", "-f", container], { allowFail: true });
  for (const volume of volumes) docker(["volume", "rm", "-f", volume], { allowFail: true });
}

/** The -e arguments for a first start, without the one named in leaveOut. */
function setupVariables(issuer: string, leaveOut?: string): string[] {
  const variables: Record<string, string> = {
    CROMDB_SERVER_NAME: "Smoke Server",
    CROMDB_PUBLIC_URL: PUBLIC_URL,
    CROMDB_ISSUER: issuer,
    CROMDB_CLIENT_ID: CLIENT.clientId,
    CROMDB_CLIENT_SECRET: CLIENT.secret,
    CROMDB_ADMIN_EMAIL: ADMIN.email,
  };
  return Object.entries(variables).flatMap(([name, value]) => (name === leaveOut ? [] : ["-e", `${name}=${value}`]));
}

async function smoke(): Promise<void> {
  check(await portFree(8080), "Port 8080 on this machine is taken; the container listens there on the host's network");
  const provider = await fakeProvider([
    {
      name: "cromdb",
      clients: [{ ...CLIENT, redirectUris: [`${PUBLIC_URL}/auth/callback`], postLogoutRedirectUris: [`${PUBLIC_URL}/`] }],
      users: [ADMIN],
    },
  ]);
  try {
    const issuer = provider.issuer("cromdb");
    const volume = `${run}-data`;
    const container = `${run}-server`;
    volumes.push(volume);
    containers.push(container);

    step(`starting ${image} on an empty volume`);
    docker(["volume", "create", volume]);
    docker(["run", "-d", "--name", container, "--network", "host", "--restart", "unless-stopped", "-v", `${volume}:/data`, ...setupVariables(issuer), image]);
    await waitFor("Docker's health check to pass", 120, () => {
      const state = inspect(container, "{{.State.Status}} {{.State.Health.Status}}");
      if (state.startsWith("exited")) fail(`the container exited:\n${docker(["logs", container], { allowFail: true }).stdout}`);
      return state === "running healthy";
    });
    const health = await fetch(`${SERVER}/api/v0/health`);
    check(health.status === 200, `health answered ${health.status}`);
    const firstLogs = docker(["logs", container]).stdout;
    check(firstLogs.includes("setting up from the CROMDB_* variables"), "the log doesn't say it set up");
    check(firstLogs.includes("Redirect URI:              http://localhost:8080/auth/callback"), "the log doesn't show the redirect URI");
    check(firstLogs.includes("Smoke Server is listening on http://0.0.0.0:8080"), "the log doesn't say where it listens");
    check(!firstLogs.includes(CLIENT.secret), "the log shows the client secret");

    step("logging the admin in, making a database and a document");
    const admin = new Browser();
    await admin.login();
    const me = await admin.request("/api/v0/me");
    check(me.status === 200 && me.body?.serverAdmin === true, `/api/v0/me answered ${me.status}: ${JSON.stringify(me.body)}`);
    const database = await admin.request("/api/v0/databases", { method: "POST", body: { name: "Smoke" } });
    check(database.status === 201, `making a database answered ${database.status}`);
    const databaseId: string = database.body.databaseId;
    const document = await admin.request(`/api/v0/databases/${databaseId}/documents`, { method: "POST", body: { content: { title: "Kept" } } });
    check(document.status === 201, `making a document answered ${document.status}`);
    const documentId: string = document.body.id;

    step("restarting from the API");
    const restart = await admin.request("/api/v0/server/restart", { method: "POST" });
    check(restart.status === 202 && restart.body?.restarting === true, `restart answered ${restart.status}: ${JSON.stringify(restart.body)}`);
    await waitFor("Docker to start it again", 60, () => Number(inspect(container, "{{.RestartCount}}")) >= 1);
    await waitFor("health after the restart", 120, () => inspect(container, "{{.State.Status}} {{.State.Health.Status}}") === "running healthy");
    const again = await admin.request("/api/v0/me");
    check(again.status === 200, `the session didn't last the restart: /api/v0/me answered ${again.status}`);
    const read = await admin.request(`/api/v0/databases/${databaseId}/documents/${documentId}`);
    check(read.status === 200 && read.body?.content?.title === "Kept", `the document didn't last the restart: ${read.status}`);
    const restartLogs = docker(["logs", container]).stdout;
    check(restartLogs.includes("Restart asked for: stopping"), "the log doesn't show the restart");
    check(restartLogs.includes("is set up, so"), "the second start didn't say the setup variables aren't used");

    step("stopping");
    docker(["stop", container]);
    const exitCode = inspect(container, "{{.State.ExitCode}}");
    check(exitCode === "0", `docker stop: exit code ${exitCode}`);
    const stopped = docker(["logs", container]);
    check(stopped.stdout.includes("SIGTERM: stopping"), "the log doesn't show SIGTERM");
    check(!/failed/i.test(stopped.stdout + stopped.stderr), `the log shows a failure:\n${stopped.stdout}\n${stopped.stderr}`);

    step("a first start with CROMDB_ISSUER missing");
    const emptyVolume = `${run}-empty`;
    const refused = `${run}-refused`;
    volumes.push(emptyVolume);
    containers.push(refused);
    docker(["volume", "create", emptyVolume]);
    const result = docker(["run", "--name", refused, "--network", "host", "-v", `${emptyVolume}:/data`, ...setupVariables(issuer, "CROMDB_ISSUER"), image], {
      allowFail: true,
    });
    check(result.status === 1, `exited ${result.status}, not 1`);
    check(result.stderr.includes("CROMDB_ISSUER is needed: the login provider's issuer URL."), `it didn't name the variable:\n${result.stderr}`);
    check(result.stderr.includes("Nothing was written."), "it didn't say nothing was written");
    const left = docker(["run", "--rm", "--entrypoint", "ls", "-v", `${emptyVolume}:/data`, image, "-A", "/data"]).stdout;
    check(left === "", `the volume isn't empty: ${left}`);

    const bytes = Number(docker(["image", "inspect", "-f", "{{.Size}}", image]).stdout);
    step(`passed. The image is ${(bytes / 1_000_000).toFixed(0)} MB.`);
  } finally {
    await provider.close();
  }
}

try {
  await smoke();
} catch (error) {
  console.error(`Docker smoke test failed: ${(error as Error).message}`);
  for (const container of containers) {
    const logs = docker(["logs", container], { allowFail: true });
    if (logs.stdout !== "" || logs.stderr !== "") console.error(`--- ${container}\n${logs.stdout}\n${logs.stderr}`);
  }
  process.exitCode = 1;
} finally {
  cleanUp();
}
