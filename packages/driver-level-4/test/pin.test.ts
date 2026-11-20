import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "cromdb";
import { createLevel4Driver, ENGINE_PIN } from "../src/index.js";

describe("the engine pin", () => {
  it("is an exact version, the one loaded", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["cromdb"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ENGINE_PIN).toBe(pkg.dependencies["cromdb"]);
    expect(VERSION).toBe(ENGINE_PIN);
    const driver = createLevel4Driver();
    expect((await driver.call("driver.info", {})).engine).toEqual({ name: "cromdb", version: ENGINE_PIN });
    await driver.shutdown();
  });
});
