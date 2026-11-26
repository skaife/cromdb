import { X509Certificate } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dataPaths } from "../src/data-dir.js";
import { SERVER_PRINCIPAL } from "../src/directory/directory.js";
import { startServer, type RunningServer } from "../src/server.js";
import { settingsContent } from "../src/settings.js";
import { ServerDb } from "../src/store/server-db.js";
import { selfSigned } from "./certificates.js";
import { createLevel4Driver, expectExit, fakeIssuer, runMain, scriptedIo, setUp, tempDir, type FakeIssuer } from "./helpers.js";

let fake: FakeIssuer;
let dir: ReturnType<typeof tempDir>;
let data: string;
let server: RunningServer | undefined;
const logs: string[] = [];

beforeAll(async () => {
  fake = await fakeIssuer();
});
afterAll(() => fake.close());
beforeEach(async () => {
  dir = tempDir();
  data = dir.join("data");
  logs.length = 0;
  await setUp(data, fake.issuer);
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  dir.remove();
});

const start = async (options: { listen?: string; certificateCheckMs?: number } = {}) => {
  server = await startServer({ dataDir: data, log: (m) => logs.push(m), ...options });
  return server;
};

/** Changes the server database the way "config set" does, with the server stopped. */
async function withServerDb(fn: (db: ServerDb) => Promise<void>) {
  const driver = createLevel4Driver();
  try {
    await fn(await ServerDb.open(driver, dataPaths(data).serverDb));
  } finally {
    await driver.shutdown();
  }
}

describe("serving HTTP", () => {
  it("answers the health check, with the security headers", async () => {
    const { url } = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${url}/api/v0/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(logs.join("\n")).toContain("Test Server is listening on http://127.0.0.1:");
    expect(logs.join("\n")).toContain("1 people, 0 databases");
  });

  it("keeps an idle connection 65 s, longer than a proxy's 60 s, so the proxy closes it first", async () => {
    const { url } = await start();
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest(`${url}/api/v0/health`, { agent: false, headers: { connection: "keep-alive" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(String(res.headers["keep-alive"])));
      });
      req.on("error", reject);
      req.end();
    });
    expect(keepAlive).toBe("timeout=65");
  });

  it("is healthy to the health command", async () => {
    const { port } = await start();
    const io = scriptedIo();
    expectExit(await runMain(["health", "--listen", `127.0.0.1:${port}`], io), 0);
    expect(io.lines).toEqual(["ok (http)"]);
  });

  it("answers anything else with a JSON 404", async () => {
    const { url } = await start();
    for (const path of ["/api/v0/nothing", "/auth/nothing", "/api/v0/health/x", "/api/v0/__proto__", "/favicon.ico"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: expect.stringContaining("No route") } });
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    }
    expect((await fetch(`${url}/api/v0/health`, { method: "POST" })).status).toBe(404);
  });

  it("listens where --listen says, over the setting", async () => {
    await withServerDb((db) => db.saveSettings({ ...db.settings, listen: "127.0.0.1:1" }));
    const { url } = await start({ listen: "localhost:0" });
    expect((await fetch(`${url}/api/v0/health`)).status).toBe(200);
  });

  it("refuses a bad --listen", async () => {
    await expect(start({ listen: "nowhere" })).rejects.toThrow('listen must be "host:port"');
  });

  it("can be closed twice", async () => {
    const running = await start();
    await running.close();
    await running.close();
    await expect(fetch(`${running.url}/api/v0/health`)).rejects.toThrow();
  });

  it("refuses a port that is taken", async () => {
    const first = await start();
    const other = dir.join("other");
    await setUp(other, fake.issuer);
    await expect(startServer({ dataDir: other, listen: `127.0.0.1:${first.port}`, log: () => {} })).rejects.toThrow(/EADDRINUSE/);
  });

  it("refuses a second server, and every command, on its data directory until it stops", async () => {
    const first = await start();
    const inUse = "The server is running, or another command is using this data directory. Stop it first.";
    await expect(startServer({ dataDir: data, listen: "127.0.0.1:0", log: () => {} })).rejects.toThrow(inUse);
    const io = scriptedIo();
    expectExit(await runMain(["config", "list", "--data", data], io), 1);
    expect(io.errors).toContain(inUse);
    const grant = scriptedIo();
    expectExit(await runMain(["admin", "grant", "someone@example.com", "--data", data], grant), 1);
    expect(grant.errors).toContain(inUse);
    // Still serving, and the refused commands changed nothing.
    expect((await fetch(`${first.url}/api/v0/health`)).status).toBe(200);
    await first.close();
    server = undefined;
    expectExit(await runMain(["config", "list", "--data", data]), 0);
  });

  it("refuses to start on a driver that can't lock database files", async () => {
    const driver = createLevel4Driver();
    const call = driver.call.bind(driver) as (op: string, input: unknown) => Promise<unknown>;
    const unlocking = {
      ...driver,
      call: async (op: string, input: unknown) => {
        const output = await call(op, input);
        return op === "driver.info" ? { ...(output as object), storageOptions: {} } : output;
      },
    } as typeof driver;
    await expect(startServer({ dataDir: data, driver: unlocking, log: () => {} })).rejects.toThrow("can't lock database files, which the server needs");
  });
});

describe("starting from a data directory", () => {
  it("explains one that isn't set up", async () => {
    await expect(startServer({ dataDir: dir.join("nothing"), log: () => {} })).rejects.toThrow('Run "cromdb-server setup" first');
  });

  it("explains a setup that didn't finish", async () => {
    const half = dir.join("half");
    mkdirSync(half);
    const driver = createLevel4Driver();
    await withServerDb(async (db) => {
      await ServerDb.create(driver, dataPaths(half).serverDb, db.settings, { oidcClientSecret: "x" });
    });
    await driver.shutdown();
    await expect(startServer({ dataDir: half, log: () => {} })).rejects.toThrow("Setup didn't finish");
  });

  it("refuses a server database from a newer server", async () => {
    const driver = createLevel4Driver();
    try {
      const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: dataPaths(data).serverDb } });
      const { documents } = await driver.call("documents.find", { handle, principal: SERVER_PRINCIPAL, limit: 10, filter: { where: { type: "identity" } } });
      const identity = documents[0]!;
      await driver.call("documents.save", { handle, principal: SERVER_PRINCIPAL, id: identity.id, ifVersion: identity.version, content: { ...identity.content, format: 2 }, fieldTypes: identity.fieldTypes });
    } finally {
      await driver.shutdown();
    }
    await expect(startServer({ dataDir: data, log: () => {} })).rejects.toThrow("format 2; this server reads format 1");
  });

  it("refuses damaged settings, naming them", async () => {
    const driver = createLevel4Driver();
    try {
      const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: dataPaths(data).serverDb } });
      const { documents } = await driver.call("documents.find", { handle, principal: SERVER_PRINCIPAL, limit: 10, filter: { where: { type: "settings" } } });
      const settings = documents[0]!;
      await driver.call("documents.save", { handle, principal: SERVER_PRINCIPAL, id: settings.id, ifVersion: settings.version, content: { ...settings.content, publicUrl: 42 } });
    } finally {
      await driver.shutdown();
    }
    await expect(startServer({ dataDir: data, log: () => {} })).rejects.toThrow("settings are missing or damaged: publicUrl");
  });

  it("refuses another database in the directory's place", async () => {
    const driver = createLevel4Driver();
    const other = dir.join("other");
    mkdirSync(other);
    await setUp(other, fake.issuer);
    await driver.shutdown();
    const { copyFileSync } = await import("node:fs");
    copyFileSync(dataPaths(other).directory, dataPaths(data).directory);
    await expect(startServer({ dataDir: data, log: () => {} })).rejects.toThrow("not this server's directory");
  });
});

describe("the registered databases", () => {
  it("opens each, marks the ones that fail unavailable, and logs files nobody registered", async () => {
    const driver = createLevel4Driver();
    let good = "";
    let directoryId = "";
    try {
      const db = await ServerDb.open(driver, dataPaths(data).serverDb);
      directoryId = db.identity.directoryDatabaseId;
      const record = (databaseId: string, file: string) => ({
        databaseId,
        name: file,
        file,
        createdAt: "2026-11-19T12:00:00.000Z",
        createdBy: "p1",
        home: db.identity.serverId,
      });
      const made = await driver.call("database.create", { storage: { kind: "sqlite", path: join(dataPaths(data).databases, "good.cromdb") }, principal: { id: "p1" } });
      good = made.databaseId;
      await db.addDatabase(record(good, "good.cromdb"));
      await db.addDatabase(record("missing-id", "missing.cromdb"));
      await db.addDatabase(record(directoryId, "dir.cromdb"));
      await db.addDatabase(record("escape-id", "../server.cromdb"));
      const wrong = await driver.call("database.create", { storage: { kind: "sqlite", path: join(dataPaths(data).databases, "wrong.cromdb") }, principal: { id: "p1" } });
      await db.addDatabase(record("not-" + wrong.databaseId, "wrong.cromdb"));
      await driver.call("database.create", { storage: { kind: "sqlite", path: join(dataPaths(data).databases, "stray.cromdb") }, principal: { id: "p1" } });
      await expect(db.addDatabase(record(good, "again.cromdb"))).rejects.toThrow("already registered");
    } finally {
      await driver.shutdown();
    }
    const running = await start();
    const states = Object.fromEntries(running.databases.list().map((s) => [s.record.file, s.status]));
    expect(states).toEqual({
      "good.cromdb": "open",
      "missing.cromdb": "unavailable",
      "dir.cromdb": "unavailable",
      "../server.cromdb": "unavailable",
      "wrong.cromdb": "unavailable",
    });
    expect(running.databases.get(good)?.status).toBe("open");
    const text = logs.join("\n");
    expect(text).toContain("it is the directory, which is never served");
    expect(text).toContain("is not a .cromdb file in the databases folder");
    expect(text).toContain("its file holds database");
    expect(text).toContain(`${join(dataPaths(data).databases, "stray.cromdb")} is not registered; it is not served`);
    expect(text).not.toContain("good.cromdb is not registered");
  });
});

describe("serving HTTPS", () => {
  /** The certificate the server presents, by fingerprint. */
  function presented(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(`${url}/api/v0/health`, { rejectUnauthorized: false, agent: false }, (res) => {
        const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256;
        res.resume();
        res.on("end", () => resolve(fingerprint));
      });
      req.on("error", reject);
      req.end();
    });
  }
  const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256;

  beforeEach(async () => {
    const pair = selfSigned("first");
    writeFileSync(dir.join("cert.pem"), pair.cert);
    writeFileSync(dir.join("key.pem"), pair.key);
    for (const args of [
      ["config", "set", "publicUrl", "https://localhost"],
      ["config", "set", "tls", dir.join("cert.pem"), dir.join("key.pem")],
    ]) {
      expectExit(await runMain([...args, "--data", data]), 0);
    }
  });

  it("serves with the certificate files", async () => {
    const { url } = await start();
    expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    expect(await presented(url)).toBe(fingerprint((await import("node:fs")).readFileSync(dir.join("cert.pem"), "utf8")));
  });

  it("loads renewed files without a restart, and keeps the old pair until the new one is whole", async () => {
    const running = await start({ certificateCheckMs: 3_600_000 });
    const first = await presented(running.url);
    expect(running.checkCertificates()).toBe(false);

    const second = selfSigned("second");
    // The certificate is renewed before the key: not a pair yet.
    writeFileSync(dir.join("cert.pem"), second.cert);
    expect(running.checkCertificates()).toBe(false);
    expect(running.checkCertificates()).toBe(false);
    expect(logs.filter((m) => m.includes("were not loaded"))).toHaveLength(1);
    expect(await presented(running.url)).toBe(first);

    writeFileSync(dir.join("key.pem"), second.key);
    expect(running.checkCertificates()).toBe(true);
    expect(logs.at(-1)).toBe("Loaded renewed certificate files.");
    expect(await presented(running.url)).toBe(fingerprint(second.cert));
  });

  it("checks the files on its own", async () => {
    const running = await start({ certificateCheckMs: 20 });
    const next = selfSigned("third");
    writeFileSync(dir.join("key.pem"), next.key);
    writeFileSync(dir.join("cert.pem"), next.cert);
    const deadline = Date.now() + 5_000;
    while ((await presented(running.url)) !== fingerprint(next.cert) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await presented(running.url)).toBe(fingerprint(next.cert));
  });

  it("is healthy to the health command, without checking its certificate", async () => {
    const { port } = await start();
    const io = scriptedIo();
    expectExit(await runMain(["health", "--listen", `0.0.0.0:${port}`], io), 0);
    expect(io.lines).toEqual(["ok (https)"]);
  });

  it("won't start with files that aren't a pair", async () => {
    writeFileSync(dir.join("key.pem"), selfSigned().key);
    await expect(startServer({ dataDir: data, log: () => {} })).rejects.toThrow("can't be used together");
  });
});

describe("the settings document", () => {
  it("is what config set wrote", async () => {
    await withServerDb(async (db) => {
      expect(settingsContent(db.settings)).toMatchObject({ serverName: "Test Server", tls: null });
    });
  });
});

describe("the health command", () => {
  it("fails when nothing listens", async () => {
    // A port that was free a moment ago.
    const probe = createNetServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const io = scriptedIo();
    expectExit(await runMain(["health", "--listen", `127.0.0.1:${port}`], io), 1);
    expect(io.errors.join("\n")).toMatch(new RegExp(`^The server at 127\\.0\\.0\\.1:${port} isn't healthy\\. https: .*ECONNREFUSED.*; http: .*ECONNREFUSED`));
  });

  it("fails when something else answers", async () => {
    const other = (await import("node:http")).createServer((_req, res) => res.writeHead(503).end("{}"));
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const io = scriptedIo();
      expectExit(await runMain(["health", "--listen", `127.0.0.1:${(other.address() as AddressInfo).port}`], io), 1);
      expect(io.errors.join("\n")).toContain("http: answered 503");
    } finally {
      await new Promise<void>((resolve) => {
        other.close(() => resolve());
        other.closeAllConnections();
      });
    }
  });

  it("refuses a bad --listen", async () => {
    const io = scriptedIo();
    expectExit(await runMain(["health", "--listen", "nowhere"], io), 2);
    expect(io.errors[0]).toContain("--listen:");
  });
});
