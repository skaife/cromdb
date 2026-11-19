// The built program, run as a process. The root test script builds first.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeIssuer, setUp, tempDir, type FakeIssuer } from "./helpers.js";

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
    expect(result.stdout).toContain("@cromdb/server 0.1.0");
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
});
