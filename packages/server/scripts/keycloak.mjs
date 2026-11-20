#!/usr/bin/env node
// Runs test/keycloak.test.ts against real Keycloak: starts the pinned image
// in Docker with the realms in test/fixtures/keycloak/realms, waits until
// both realms answer, runs the suite (--runs N times, 1 by default), and
// always removes the container. Needs Docker. Used by the "keycloak" CI job
// and by "npm run test:keycloak" anywhere Docker runs.
//
//   node scripts/keycloak.mjs [--runs N] [--record]
//
// --record writes Keycloak's shapes to test/fixtures/keycloak (after raising
// the pinned version) instead of comparing them.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const IMAGE = "quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332";
/** How long Keycloak may take to start and import the realms. */
const READY_MS = 240_000;
const REALMS = ["cromdb", "other"];
const root = fileURLToPath(new URL("..", import.meta.url));
const realms = fileURLToPath(new URL("../test/fixtures/keycloak/realms", import.meta.url));

const { values } = parseArgs({ options: { runs: { type: "string", default: "1" }, record: { type: "boolean", default: false } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs takes a whole number from 1");
  process.exit(2);
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.error !== undefined) {
    throw new Error(`docker can't be run: ${result.error.message}. This suite needs Docker.`);
  }
  return result;
}

function must(args) {
  const result = docker(args);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

const name = `cromdb-keycloak-${process.pid}`;

/** Waits until both realms serve discovery, failing at once if the container stops. */
async function ready(url) {
  const deadline = Date.now() + READY_MS;
  for (;;) {
    if (must(["inspect", "--format", "{{.State.Running}}", name]) !== "true") {
      throw new Error("Keycloak stopped while starting");
    }
    const answers = await Promise.all(
      REALMS.map((realm) =>
        fetch(`${url}/realms/${realm}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) }).then(
          (response) => response.status,
          () => 0,
        ),
      ),
    );
    if (answers.every((status) => status === 200)) return;
    if (Date.now() > deadline) {
      throw new Error(`Keycloak wasn't ready after ${READY_MS / 1000} s (realms answered ${answers.join(", ")})`);
    }
    // Polling, not waiting for a guessed time: the loop ends as soon as both realms answer.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function vitest(url) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", "run", "test/keycloak.test.ts"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, KEYCLOAK_URL: url, ...(values.record ? { KEYCLOAK_RECORD: "1" } : {}) },
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let status = 1;
let started = false;
try {
  console.log(`Starting ${IMAGE}`);
  must([
    "run",
    "--detach",
    "--name",
    name,
    // A free port on this machine only.
    "--publish",
    "127.0.0.1::8080",
    "--volume",
    `${realms}:/opt/keycloak/data/import:ro`,
    IMAGE,
    "start-dev",
    "--import-realm",
  ]);
  started = true;
  const port = must(["port", name, "8080/tcp"]).split("\n")[0]?.split(":").at(-1);
  const url = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  await ready(url);
  console.log(`Keycloak is ready at ${url} after ${Math.round((Date.now() - startedAt) / 1000)} s`);
  status = 0;
  for (let run = 1; run <= runs && status === 0; run++) {
    if (runs > 1) console.log(`\nRun ${run} of ${runs}`);
    status = await vitest(url);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  status = 1;
} finally {
  if (started) {
    if (status !== 0) {
      console.error("\nThe end of Keycloak's log:");
      const logs = docker(["logs", "--tail", "80", name]);
      console.error(`${logs.stdout}${logs.stderr}`);
    }
    docker(["rm", "--force", name]);
  }
}
process.exit(status);
