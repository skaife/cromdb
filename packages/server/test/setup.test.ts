import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DriverError, type Driver } from "@cromdb/driver";
import { setup } from "../src/cli/setup.js";
import { dataPaths } from "../src/data-dir.js";
import { Directory } from "../src/directory/directory.js";
import { ServerDb } from "../src/store/server-db.js";
import { selfSigned } from "./certificates.js";
import { createLevel4Driver, expectExit, fakeIssuer, runMain, scriptedIo, setupFlags, setUp, tempDir, type FakeIssuer } from "./helpers.js";

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

/** What a data directory holds, read through the driver. */
async function read(dataDir: string) {
  const driver = createLevel4Driver();
  try {
    const paths = dataPaths(dataDir);
    const db = await ServerDb.open(driver, paths.serverDb);
    const { handle, databaseId } = await driver.call("database.open", { storage: { kind: "sqlite", path: paths.directory } });
    const directory = await Directory.load({ driver, handle, serverId: db.identity.serverId, log: () => {} });
    const acl = await driver.call("acl.get", { handle: db.handle, principal: { id: "cromdb-server" } });
    return { identity: db.identity, settings: db.settings, secret: db.secret("oidcClientSecret"), people: directory.index.all(), databaseId, acl: acl.acl };
  } finally {
    await driver.shutdown();
  }
}

describe("setup from flags", () => {
  it("writes the server database and the directory, with the admin invited", async () => {
    const data = dir.join("data");
    const io = await setUp(data, fake.issuer);
    const state = await read(data);
    expect(state.settings).toEqual({
      serverName: "Test Server",
      publicUrl: "http://localhost:8080",
      listen: "127.0.0.1:0",
      tls: null,
      trustProxy: false,
      oidcIssuer: fake.issuer,
      oidcClientId: "cromdb",
      sessionIdleMinutes: 720,
      sessionMaxDays: 7,
    });
    expect(state.secret).toBe("s3cret");
    expect(state.identity).toMatchObject({ createdAt: "2026-11-19T12:00:00.000Z", directoryDatabaseId: state.databaseId });
    expect(state.identity.serverId).not.toBe(state.identity.deploymentId);
    expect(state.acl).toMatchObject({ creators: ["cromdb-server"], admins: ["cromdb-server"] });
    expect(state.people).toHaveLength(1);
    expect(state.people[0]?.person).toMatchObject({
      email: "admin@example.com",
      status: "invited",
      statusBy: "setup",
      serverAdmin: true,
      invitedBy: "setup",
      logins: [],
      changedOn: state.identity.serverId,
    });
    expect(readdirSync(data).sort()).toEqual(["databases", "directory.cromdb", "server.cromdb"]);
    expect(io.text()).toContain("Redirect URI:              http://localhost:8080/auth/callback");
    expect(io.text()).toContain("Post-logout redirect URI:  http://localhost:8080/");
    expect(io.text()).not.toContain("s3cret");
    if (process.platform !== "win32") {
      expect(statSync(data).mode & 0o777).toBe(0o700);
      expect(statSync(dataPaths(data).serverDb).mode & 0o777).toBe(0o600);
    }
  });

  it("stores every directory document readable and writable only by the server, in databases that admit only the server", async () => {
    const data = dir.join("data");
    await setUp(data, fake.issuer);
    const driver = createLevel4Driver();
    try {
      for (const path of [dataPaths(data).directory, dataPaths(data).serverDb]) {
        const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path } });
        const { documents } = await driver.call("documents.find", { handle, principal: { id: "cromdb-server" }, limit: 100 });
        expect(documents.length).toBeGreaterThan(0);
        for (const document of documents) {
          expect(document.readers).toEqual(["cromdb-server"]);
          expect(document.writers).toEqual(["cromdb-server"]);
        }
        const { acl } = await driver.call("acl.get", { handle, principal: { id: "cromdb-server" } });
        expect([acl.admins, acl.creators, acl.writers, acl.readers, acl.noAccess]).toEqual([["cromdb-server"], ["cromdb-server"], ["cromdb-server"], ["cromdb-server"], []]);
        await expect(driver.call("documents.find", { handle, principal: { id: "someone" }, limit: 100 })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      }
    } finally {
      await driver.shutdown();
    }
  });

  it("reads the client secret from a file", async () => {
    const data = dir.join("data");
    writeFileSync(dir.join("secret"), "from-file\r\n");
    const io = scriptedIo();
    expectExit(await runMain(setupFlags(data, fake.issuer, ["--client-secret-file", dir.join("secret")]), io), 0);
    expect((await read(data)).secret).toBe("from-file");
  });

  it("sets up into an empty directory that already exists", async () => {
    mkdirSync(dir.join("data"));
    await setUp(dir.join("data"), fake.issuer);
    expect(existsSync(dataPaths(dir.join("data")).serverDb)).toBe(true);
  });

  it("refuses a directory that isn't empty", async () => {
    mkdirSync(dir.join("data"));
    writeFileSync(dir.join("data", "keep.txt"), "mine");
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer), io), 1);
    expect(io.errors.join("\n")).toContain("is not empty");
    expect(readdirSync(dir.join("data"))).toEqual(["keep.txt"]);
  });

  it("names the flag for a question it can't ask", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    const flags = setupFlags(dir.join("data"), fake.issuer).filter((_, i, all) => all[i] !== "--client-id" && all[i - 1] !== "--client-id");
    expectExit(await runMain(flags, io), 2);
    expect(io.errors[0]).toContain("--client-id is needed");
    expect(existsSync(dir.join("data"))).toBe(false);
  });

  it("stops on a bad flag, writing nothing", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer, ["--admin-email", "nobody"]), io), 1);
    expect(io.errors[0]).toContain("--admin-email: The email address");
    expect(existsSync(dir.join("data"))).toBe(false);
  });

  it("checks the provider", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), `${fake.issuer}/`), io), 1);
    expect(io.errors[0]).toContain("The provider's issuer is");
  });

  it("says join isn't available yet", async () => {
    const io = scriptedIo();
    expectExit(await runMain(["setup", "--data", dir.join("data"), "--deployment", "join"], io), 2);
    expect(io.errors).toEqual(["Joining an existing deployment isn't available yet."]);
    expect(existsSync(dir.join("data"))).toBe(false);
  });

  it("removes everything it made when writing fails", async () => {
    // A driver that fails the admin's invitation, after both databases exist.
    const failing = (): Driver => {
      const driver = createLevel4Driver();
      return {
        ...driver,
        call: (async (op: string, input: never) => {
          if (op === "documents.create" && (input as { content: { type?: string } }).content.type === "person") {
            throw new DriverError("INTERNAL", "disk full");
          }
          return driver.callByName(op, input);
        }) as Driver["call"],
      };
    };
    const flags = { deployment: "new", "server-name": "S", "public-url": "http://localhost", "trust-proxy": "no", listen: "127.0.0.1:0", issuer: fake.issuer, "client-id": "c", "admin-email": "a@example.com" };

    const made = dir.join("made");
    await expect(setup(scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } }), flags, made, failing())).rejects.toThrow("disk full");
    expect(existsSync(made)).toBe(false);

    const existing = dir.join("existing");
    mkdirSync(existing);
    await expect(setup(scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } }), flags, existing, failing())).rejects.toThrow("disk full");
    expect(readdirSync(existing)).toEqual([]);
  });
});

describe("plain HTTP", () => {
  const offMachine = (data: string, extra: string[] = []) =>
    setupFlags(data, fake.issuer, ["--public-url", "http://db.lan:8080", ...extra]);

  it("needs --allow-plain-http when the public URL leaves the machine", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(offMachine(dir.join("data")), io), 1);
    expect(io.errors.join("\n")).toContain("Warning: The public URL http://db.lan:8080 is plain HTTP");
    expect(io.errors.join("\n")).toContain("give --allow-plain-http");
    expect(existsSync(dir.join("data"))).toBe(false);

    const allowed = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(offMachine(dir.join("data"), ["--allow-plain-http"]), allowed), 0);
    expect(allowed.errors.join("\n")).toContain("Warning:");
  });

  it("refuses a certificate for an http public URL", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("c.pem"), pair.cert);
    writeFileSync(dir.join("k.pem"), pair.key);
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer, ["--tls-cert", dir.join("c.pem"), "--tls-key", dir.join("k.pem")]), io), 1);
    expect(io.errors[0]).toContain("can't serve HTTPS");
  });
});

describe("HTTPS", () => {
  const https = ["--public-url", "https://db.example.com"];

  it("stores the certificate files, checked as a pair", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("c.pem"), pair.cert);
    writeFileSync(dir.join("k.pem"), pair.key);
    await setUp(dir.join("data"), fake.issuer, [...https, "--tls-cert", dir.join("c.pem"), "--tls-key", dir.join("k.pem")]);
    const { settings } = await read(dir.join("data"));
    expect(settings.tls).toEqual({ certFile: dir.join("c.pem"), keyFile: dir.join("k.pem") });
    expect(settings.publicUrl).toBe("https://db.example.com");
  });

  it("refuses a key that doesn't match the certificate", async () => {
    writeFileSync(dir.join("c.pem"), selfSigned().cert);
    writeFileSync(dir.join("k.pem"), selfSigned().key);
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer, [...https, "--tls-cert", dir.join("c.pem"), "--tls-key", dir.join("k.pem")]), io), 1);
    expect(io.errors[0]).toContain("can't be used together");
  });

  it("serves plain HTTP behind a reverse proxy with --no-tls", async () => {
    await setUp(dir.join("data"), fake.issuer, [...https, "--no-tls"]);
    expect((await read(dir.join("data"))).settings.tls).toBeNull();
  });

  it("asks without a terminal flag for neither", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer, https), io), 2);
    expect(io.errors[0]).toContain("--tls-cert and --tls-key, or --no-tls is needed");
  });

  it("wants --tls-cert and --tls-key together", async () => {
    const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "x" } });
    expectExit(await runMain(setupFlags(dir.join("data"), fake.issuer, [...https, "--tls-cert", "c.pem"]), io), 2);
    expect(io.errors[0]).toBe("--tls-cert and --tls-key go together");
  });
});

describe("setup asking on a terminal", () => {
  it("asks each question, explains bad answers and asks again", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("c.pem"), pair.cert);
    writeFileSync(dir.join("k.pem"), pair.key);
    writeFileSync(dir.join("wrong.pem"), selfSigned().key);
    const io = scriptedIo({
      answers: [
        "maybe", // new or join
        "", // new, the default
        "My Server",
        "db.example.com", // not a URL
        "https://db.example.com/",
        "", // HTTPS here: yes
        dir.join("c.pem"),
        dir.join("wrong.pem"), // mismatched key
        dir.join("c.pem"),
        dir.join("k.pem"),
        "", // trust proxy: the default, no (HTTPS is served here)
        "", // listen: the default
        `${fake.issuer}/`, // wrong issuer
        fake.issuer,
        "cromdb",
        "typed-secret",
        "ann@",
        "Ann@Example.com",
      ],
    });
    expectExit(await runMain(["setup", "--data", dir.join("data")], io), 0);
    expect(io.asked.find((q) => q.text === "Client secret")?.secret).toBe(true);
    expect(io.errors).toEqual([
      "Answer new or join",
      expect.stringContaining("publicUrl must be an absolute URL"),
      expect.stringContaining("can't be used together"),
      expect.stringContaining("The provider's issuer is"),
      expect.stringContaining("The email address"),
    ]);
    const state = await read(dir.join("data"));
    expect(state.settings).toMatchObject({ serverName: "My Server", publicUrl: "https://db.example.com", trustProxy: false, listen: "127.0.0.1:8080" });
    expect(state.secret).toBe("typed-secret");
    expect(state.people[0]?.person.email).toBe("ann@example.com");
  });

  it("stops when plain HTTP isn't confirmed", async () => {
    const io = scriptedIo({ answers: ["new", "S", "http://db.lan", "no"] });
    expectExit(await runMain(["setup", "--data", dir.join("data")], io), 1);
    expect(io.errors.at(-1)).toBe("Setup stopped; nothing was written");
    expect(existsSync(dir.join("data"))).toBe(false);
  });

  it("offers trust proxy by default when a reverse proxy serves HTTPS", async () => {
    const io = scriptedIo({ answers: ["new", "S", "https://db.example.com", "no", "", "", fake.issuer, "c", "s", "a@example.com"] });
    expectExit(await runMain(["setup", "--data", dir.join("data")], io), 0);
    expect(io.asked.find((q) => q.flag === "--trust-proxy")?.default).toBe("yes");
    expect((await read(dir.join("data"))).settings.trustProxy).toBe(true);
    expect(readFileSync(dataPaths(dir.join("data")).serverDb).length).toBeGreaterThan(0);
  });
});
