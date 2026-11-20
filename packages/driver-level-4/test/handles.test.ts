import { afterAll, describe, expect, it } from "vitest";
import type { DriverError } from "@cromdb/driver";
import { createLevel4Driver } from "../src/index.js";
import { tempDir } from "./helpers.js";

const ALICE = { id: "alice" };
const dir = tempDir();
afterAll(() => dir.remove());

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as DriverError).code;
  }
  return "no error";
}

describe("handles", () => {
  it("database.close waits for calls already running on the handle", async () => {
    const driver = createLevel4Driver();
    const { handle } = await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE });
    for (let i = 0; i < 50; i++) {
      await driver.call("documents.create", { handle, principal: ALICE, content: { i } });
    }
    const finding = driver.call("documents.find", { handle, principal: ALICE, limit: 1000 });
    const closing = driver.call("database.close", { handle });
    expect((await finding).documents).toHaveLength(50);
    await closing;
    expect(await code(driver.call("documents.find", { handle, principal: ALICE, limit: 10 }))).toBe("UNKNOWN_HANDLE");
    await driver.shutdown();
  });

  it("serves more principals than it keeps sessions for", async () => {
    const driver = createLevel4Driver();
    const { handle } = await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE });
    const { acl } = await driver.call("acl.get", { handle, principal: ALICE });
    const { admins, creators, writers, noAccess } = acl;
    await driver.call("acl.save", { handle, principal: ALICE, ifVersion: acl.version, admins, creators, writers, readers: ["*"], noAccess });
    const { document } = await driver.call("documents.create", { handle, principal: ALICE, content: { shared: true } });
    for (let i = 0; i < 300; i++) {
      const { document: read } = await driver.call("documents.get", { handle, principal: { id: `person-${i}` }, id: document.id });
      expect(read?.version).toBe(document.version);
    }
    // The first sessions were dropped from the cache and open again.
    expect((await driver.call("access.mine", { handle, principal: { id: "person-0" } })).create).toBe(false);
    expect((await driver.call("access.mine", { handle, principal: ALICE })).admin).toBe(true);
    await driver.shutdown();
  });

  it("shutdown closes every database and frees its file", async () => {
    const path = dir.path();
    const driver = createLevel4Driver();
    const { handle } = await driver.call("database.create", { storage: { kind: "sqlite", path }, principal: ALICE });
    const other = await driver.call("database.create", { storage: { kind: "memory" }, principal: ALICE });
    await driver.shutdown();
    expect(await code(driver.call("database.info", { handle }))).toBe("UNKNOWN_HANDLE");
    expect(await code(driver.call("database.info", { handle: other.handle }))).toBe("UNKNOWN_HANDLE");
    const again = createLevel4Driver();
    await again.call("database.open", { storage: { kind: "sqlite", path } });
    await again.shutdown();
  });

  it("two drivers keep their handles apart", async () => {
    const first = createLevel4Driver();
    const second = createLevel4Driver();
    const { handle } = await first.call("database.create", { storage: { kind: "memory" }, principal: ALICE });
    expect(await code(second.call("database.info", { handle }))).toBe("UNKNOWN_HANDLE");
    await first.shutdown();
    await second.shutdown();
  });
});
