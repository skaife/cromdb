import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.js";
import { dataPaths } from "../src/data-dir.js";
import { Directory } from "../src/directory/directory.js";
import { ServerDb } from "../src/store/server-db.js";
import { selfSigned } from "./certificates.js";
import { createLevel3Driver, fakeIssuer, scriptedIo, setUp, tempDir, type FakeIssuer } from "./helpers.js";

let fake: FakeIssuer;
let dir: ReturnType<typeof tempDir>;
let data: string;

beforeAll(async () => {
  fake = await fakeIssuer();
});
afterAll(() => fake.close());
beforeEach(async () => {
  dir = tempDir();
  data = dir.join("data");
  await setUp(data, fake.issuer);
});
afterEach(() => dir.remove());

async function run(args: string[], options: Parameters<typeof scriptedIo>[0] = {}) {
  const io = scriptedIo(options);
  const status = await main([...args, "--data", data], io);
  return { status, io };
}

async function people() {
  const driver = createLevel3Driver();
  try {
    const db = await ServerDb.open(driver, dataPaths(data).serverDb);
    const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: dataPaths(data).directory } });
    return (await Directory.load({ driver, handle, serverId: db.identity.serverId, log: () => {} })).index.all().map((e) => e.person);
  } finally {
    await driver.shutdown();
  }
}

describe("config", () => {
  it("lists every setting, and secrets only as set or not", async () => {
    const { status, io } = await run(["config", "list"]);
    expect(status).toBe(0);
    expect(io.lines).toEqual([
      'serverName = "Test Server"',
      'publicUrl = "http://localhost:8080"',
      'listen = "127.0.0.1:0"',
      "tls = off",
      "trustProxy = false",
      `oidcIssuer = ${JSON.stringify(fake.issuer)}`,
      'oidcClientId = "cromdb"',
      "sessionIdleMinutes = 720",
      "sessionMaxDays = 7",
      "oidcClientSecret = (set)",
    ]);
  });

  it("gets one setting, never a secret", async () => {
    expect((await run(["config", "get", "sessionMaxDays"])).io.lines).toEqual(["7"]);
    const secret = await run(["config", "get", "oidcClientSecret"]);
    expect(secret.status).toBe(1);
    expect(secret.io.text()).not.toContain("s3cret");
    expect((await run(["config", "get", "__proto__"])).status).toBe(2);
  });

  it("sets a setting, checked", async () => {
    const set = await run(["config", "set", "sessionIdleMinutes", "60"]);
    expect(set).toMatchObject({ status: 0 });
    expect(set.io.lines[0]).toBe("Set sessionIdleMinutes = 60. Restart the server for the change to take effect.");
    expect((await run(["config", "get", "sessionIdleMinutes"])).io.lines).toEqual(["60"]);

    const bad = await run(["config", "set", "sessionIdleMinutes", "1"]);
    expect(bad.status).toBe(1);
    expect(bad.io.errors[0]).toContain("from 5 to");
    expect((await run(["config", "set", "nope", "1"])).status).toBe(2);
    expect((await run(["config", "set", "serverName"])).status).toBe(2);
  });

  it("re-checks the provider when the issuer changes", async () => {
    const bad = await run(["config", "set", "oidcIssuer", `${fake.issuer}/`]);
    expect(bad.status).toBe(1);
    expect(bad.io.errors[0]).toContain("The provider's issuer is");
    expect((await run(["config", "set", "oidcIssuer", fake.issuer])).status).toBe(0);
  });

  it("warns about plain HTTP off this machine", async () => {
    const refused = await run(["config", "set", "publicUrl", "http://db.lan"]);
    expect(refused.status).toBe(1);
    expect(refused.io.errors.join("\n")).toContain("--allow-plain-http");
    expect((await run(["config", "set", "publicUrl", "http://db.lan", "--allow-plain-http"])).status).toBe(0);
  });

  it("sets tls to a checked pair, or off, keeping the public URL https", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("c.pem"), pair.cert);
    writeFileSync(dir.join("k.pem"), pair.key);
    const needsHttps = await run(["config", "set", "tls", dir.join("c.pem"), dir.join("k.pem")]);
    expect(needsHttps.status).toBe(1);
    expect(needsHttps.io.errors[0]).toContain("publicUrl must start with https://");

    expect((await run(["config", "set", "publicUrl", "https://db.example.com"])).status).toBe(0);
    expect((await run(["config", "set", "tls", dir.join("c.pem"), dir.join("k.pem")])).status).toBe(0);
    expect((await run(["config", "get", "tls"])).io.lines).toEqual([`cert=${dir.join("c.pem")} key=${dir.join("k.pem")}`]);

    writeFileSync(dir.join("other.pem"), selfSigned().key);
    expect((await run(["config", "set", "tls", dir.join("c.pem"), dir.join("other.pem")])).status).toBe(1);
    expect((await run(["config", "set", "tls", "only-one"])).status).toBe(2);
    expect((await run(["config", "set", "tls", "off"])).status).toBe(0);
    expect((await run(["config", "get", "tls"])).io.lines).toEqual(["off"]);
  });

  it("sets a secret from a file, from standard input, or typed, never from the command line", async () => {
    writeFileSync(dir.join("s"), "new-secret\n");
    expect((await run(["config", "set", "oidcClientSecret", "--from-file", dir.join("s")])).status).toBe(0);
    const secret = async () => {
      const driver = createLevel3Driver();
      try {
        return (await ServerDb.open(driver, dataPaths(data).serverDb)).secret("oidcClientSecret");
      } finally {
        await driver.shutdown();
      }
    };
    expect(await secret()).toBe("new-secret");
    expect((await run(["config", "set", "oidcClientSecret"], { stdin: "piped\n" })).status).toBe(0);
    expect(await secret()).toBe("piped");
    const typed = await run(["config", "set", "oidcClientSecret"], { answers: ["typed"] });
    expect(typed.status).toBe(0);
    expect(typed.io.asked[0]?.secret).toBe(true);
    expect(await secret()).toBe("typed");

    const onLine = await run(["config", "set", "oidcClientSecret", "visible"]);
    expect(onLine.status).toBe(2);
    expect((await run(["config", "set", "oidcClientSecret"], { stdin: "\n" })).status).toBe(1);
    expect(await secret()).toBe("typed");
  });

  it("explains a data directory that isn't set up", async () => {
    const io = scriptedIo();
    expect(await main(["config", "list", "--data", dir.join("nothing")], io)).toBe(1);
    expect(io.errors[0]).toContain('Run "cromdb-server setup" first');
  });
});

describe("admin grant", () => {
  it("leaves an existing server admin alone", async () => {
    const { status, io } = await run(["admin", "grant", "ADMIN@example.com"]);
    expect(status).toBe(0);
    expect(io.lines[0]).toContain("is already a server admin (status invited). Nothing changed.");
    expect(await people()).toHaveLength(1);
  });

  it("invites someone unknown as a server admin", async () => {
    const { status, io } = await run(["admin", "grant", "bob@example.com"], { now: new Date("2026-11-20T00:00:00.000Z") });
    expect(status).toBe(0);
    expect(io.lines[0]).toMatch(/^Invited bob@example.com \(person [0-9a-f-]{36}\) as a server admin\.$/);
    const bob = (await people()).find((p) => p.email === "bob@example.com");
    expect(bob).toMatchObject({ status: "invited", serverAdmin: true, invitedBy: "console", invitedAt: "2026-11-20T00:00:00.000Z" });
  });

  it("makes a person an admin and enables them if disabled", async () => {
    await run(["admin", "grant", "bob@example.com"]);
    // Bob is disabled and not an admin, written the way the API will.
    const driver = createLevel3Driver();
    try {
      const db = await ServerDb.open(driver, dataPaths(data).serverDb);
      const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: dataPaths(data).directory } });
      const directory = await Directory.load({ driver, handle, serverId: db.identity.serverId, log: () => {} });
      const [bob] = directory.index.byEmail("bob@example.com");
      await directory.update(bob!.person.personId, new Date("2026-11-21T00:00:00.000Z"), (p) => ({
        ...p,
        status: "disabled",
        statusAt: "2026-11-21T00:00:00.000Z",
        statusBy: "someone",
        serverAdmin: false,
        serverAdminAt: "2026-11-21T00:00:00.000Z",
      }));
    } finally {
      await driver.shutdown();
    }
    const { status, io } = await run(["admin", "grant", "bob@example.com"], { now: new Date("2026-11-22T00:00:00.000Z") });
    expect(status).toBe(0);
    expect(io.lines[0]).toContain("is now a server admin, and no longer disabled (status invited)");
    expect((await people()).find((p) => p.email === "bob@example.com")).toMatchObject({
      status: "invited",
      statusBy: "console",
      statusAt: "2026-11-22T00:00:00.000Z",
      serverAdmin: true,
      changedAt: "2026-11-22T00:00:00.000Z",
    });
  });

  it("checks its arguments", async () => {
    expect((await run(["admin", "grant", "nobody"])).status).toBe(1);
    expect((await run(["admin", "grant"])).status).toBe(2);
    expect((await run(["admin", "revoke", "a@example.com"])).status).toBe(2);
  });
});

describe("the command line", () => {
  it("explains wrong usage with status 2", async () => {
    for (const args of [["frobnicate"], ["start", "--data", data, "--nope"], ["setup", "extra", "--data", data], ["config", "list"]]) {
      const io = scriptedIo();
      expect(await main(args, io), args.join(" ")).toBe(2);
      expect(io.errors.at(-1)).toBe('Run "cromdb-server help" for the commands.');
    }
    const help = scriptedIo();
    expect(await main(["help"], help)).toBe(0);
    expect(help.lines[0]).toContain("Usage: cromdb-server");
    expect(await main([], scriptedIo())).toBe(2);
  });

  it("takes the data directory from CROMDB_DATA", async () => {
    const io = scriptedIo({ env: { CROMDB_DATA: data } });
    expect(await main(["config", "get", "serverName"], io)).toBe(0);
    expect(io.lines).toEqual(['"Test Server"']);
  });

  it("shows the versions", async () => {
    const io = scriptedIo();
    expect(await main(["version"], io)).toBe(0);
    expect(io.lines).toEqual(["@cromdb/server 0.1.0", "@cromdb/driver-level-3 0.1.0 (driver interface 0, database level 3-3)", "cromdb 0.5.0"]);
  });
});
