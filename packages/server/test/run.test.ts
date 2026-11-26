import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../src/cli/io.js";
import { run } from "../src/cli/run.js";
import { dataPaths } from "../src/data-dir.js";
import { Directory } from "../src/directory/directory.js";
import { ServerDb } from "../src/store/server-db.js";
import { selfSigned } from "./certificates.js";
import { createLevel4Driver, expectExit, fakeIssuer, runMain, scriptedIo, setUp, tempDir, type FakeIssuer, type ScriptedIo } from "./helpers.js";

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

/** Every variable a first start needs, for the fake issuer. */
function variables(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CROMDB_SERVER_NAME: "Docker Server",
    CROMDB_PUBLIC_URL: "http://localhost:8080",
    CROMDB_ISSUER: fake.issuer,
    CROMDB_CLIENT_ID: "cromdb",
    CROMDB_CLIENT_SECRET: "s3cret",
    CROMDB_ADMIN_EMAIL: "Admin@Example.com",
    ...extra,
  };
}

/** Runs "run" with a start that only records how it was called. */
async function runWith(data: string, env: Record<string, string>, listen?: string): Promise<{ status: number; io: ScriptedIo; started: { dataDir: string; listen: string | undefined }[] }> {
  const io = scriptedIo({ env });
  const started: { dataDir: string; listen: string | undefined }[] = [];
  const start = async (_io: Io, dataDir: string, at: string | undefined) => {
    started.push({ dataDir, listen: at });
    return 0;
  };
  let status: number;
  try {
    status = await run(io, data, listen, start);
  } catch (error) {
    // As main reports a CommandError.
    io.err((error as Error).message);
    status = 1;
  }
  return { status, io, started };
}

async function read(data: string) {
  const driver = createLevel4Driver();
  try {
    const paths = dataPaths(data);
    const db = await ServerDb.open(driver, paths.serverDb);
    const { handle } = await driver.call("database.open", { storage: { kind: "sqlite", path: paths.directory } });
    const directory = await Directory.load({ driver, handle, serverId: db.identity.serverId, log: () => {} });
    return { settings: db.settings, secret: db.secret("oidcClientSecret"), people: directory.index.all() };
  } finally {
    await driver.shutdown();
  }
}

describe("run on an empty data directory", () => {
  it("sets up from the variables, then starts", async () => {
    const data = dir.join("data");
    const result = await runWith(data, variables(), "0.0.0.0:8080");
    expect(result.status, result.io.text()).toBe(0);
    expect(result.started).toEqual([{ dataDir: data, listen: "0.0.0.0:8080" }]);
    const state = await read(data);
    expect(state.settings).toMatchObject({
      serverName: "Docker Server",
      publicUrl: "http://localhost:8080",
      listen: "0.0.0.0:8080",
      tls: null,
      trustProxy: false,
      oidcIssuer: fake.issuer,
      oidcClientId: "cromdb",
    });
    expect(state.secret).toBe("s3cret");
    expect(state.people.map((entry) => [entry.person.email, entry.person.serverAdmin, entry.person.status])).toEqual([["admin@example.com", true, "invited"]]);
    const text = result.io.text();
    expect(text).toContain(`${data} is empty: setting up from the CROMDB_* variables.`);
    expect(text).toContain("Redirect URI:              http://localhost:8080/auth/callback");
    expect(text).toContain("admin@example.com is invited as the first server admin.");
    expect(text).not.toContain("Start the server with");
    expect(text).not.toContain("s3cret");
  });

  it("sets up a folder that exists but is empty, as a fresh volume is", async () => {
    const data = dir.join("data");
    mkdirSync(data);
    const result = await runWith(data, variables());
    expect(result.status, result.io.text()).toBe(0);
    expect(readdirSync(data).sort()).toEqual(["databases", "directory.cromdb", "server.cromdb"]);
  });

  it("reads the client secret from CROMDB_CLIENT_SECRET_FILE", async () => {
    const data = dir.join("data");
    writeFileSync(dir.join("secret"), "from-a-file\n");
    const env = variables({ CROMDB_CLIENT_SECRET_FILE: dir.join("secret") });
    delete env["CROMDB_CLIENT_SECRET"];
    const result = await runWith(data, env);
    expect(result.status, result.io.text()).toBe(0);
    expect((await read(data)).secret).toBe("from-a-file");
  });

  it("takes TLS files, trust-proxy and plain HTTP when allowed", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("cert.pem"), pair.cert);
    writeFileSync(dir.join("key.pem"), pair.key);
    const tls = dir.join("tls");
    const withTls = await runWith(
      tls,
      variables({ CROMDB_PUBLIC_URL: "https://cromdb.example.com", CROMDB_TLS_CERT: dir.join("cert.pem"), CROMDB_TLS_KEY: dir.join("key.pem") }),
    );
    expect(withTls.status, withTls.io.text()).toBe(0);
    expect((await read(tls)).settings.tls).toEqual({ certFile: dir.join("cert.pem"), keyFile: dir.join("key.pem") });

    const proxied = dir.join("proxied");
    const behind = await runWith(proxied, variables({ CROMDB_PUBLIC_URL: "https://cromdb.example.com", CROMDB_TRUST_PROXY: "yes" }));
    expect(behind.status, behind.io.text()).toBe(0);
    expect((await read(proxied)).settings).toMatchObject({ tls: null, trustProxy: true });

    const plain = dir.join("plain");
    const lan = await runWith(plain, variables({ CROMDB_PUBLIC_URL: "http://cromdb.lan:8080", CROMDB_ALLOW_PLAIN_HTTP: "yes" }));
    expect(lan.status, lan.io.text()).toBe(0);
    expect(lan.io.text()).toContain("Warning: The public URL http://cromdb.lan:8080 is plain HTTP");
    expect((await read(plain)).settings.publicUrl).toBe("http://cromdb.lan:8080");
  });

  it("counts an empty variable as not set", async () => {
    const data = dir.join("data");
    const result = await runWith(data, variables({ CROMDB_TLS_CERT: "", CROMDB_TLS_KEY: "", CROMDB_TRUST_PROXY: "", CROMDB_CLIENT_SECRET_FILE: "" }));
    expect(result.status, result.io.text()).toBe(0);
  });

  it("lists every missing variable at once, writes nothing, and doesn't start", async () => {
    const data = dir.join("data");
    const result = await runWith(data, {});
    expect(result.status).toBe(1);
    expect(result.started).toEqual([]);
    expect(result.io.errors).toEqual([
      "CROMDB_SERVER_NAME is needed: the server name, shown to people.",
      "CROMDB_PUBLIC_URL is needed: the public URL, where people reach the server.",
      "CROMDB_ISSUER is needed: the login provider's issuer URL.",
      "CROMDB_CLIENT_ID is needed: the client ID at the login provider.",
      "CROMDB_CLIENT_SECRET or CROMDB_CLIENT_SECRET_FILE is needed: the client secret at the login provider.",
      "CROMDB_ADMIN_EMAIL is needed: the email address of the first server admin.",
      "Nothing was written. Set the variables and start again.",
    ]);
    expect(existsSync(data)).toBe(false);
  });

  it("names the variable of every bad value", async () => {
    const data = dir.join("data");
    mkdirSync(data);
    const result = await runWith(
      data,
      variables({
        CROMDB_PUBLIC_URL: "http://cromdb.lan:8080",
        CROMDB_ALLOW_PLAIN_HTTP: "maybe",
        CROMDB_TRUST_PROXY: "sure",
        CROMDB_TLS_CERT: dir.join("cert.pem"),
        CROMDB_CLIENT_SECRET_FILE: dir.join("missing"),
        CROMDB_ADMIN_EMAIL: "not an email",
      }),
    );
    expect(result.status).toBe(1);
    const errors = result.io.errors;
    expect(errors).toContain('CROMDB_ALLOW_PLAIN_HTTP: answer yes or no, not "maybe"');
    expect(errors).toContain('CROMDB_TRUST_PROXY: answer yes or no, not "sure"');
    expect(errors).toContain("CROMDB_PUBLIC_URL: http://cromdb.lan:8080 is plain HTTP and not on this machine; set CROMDB_ALLOW_PLAIN_HTTP=yes to use it.");
    expect(errors).toContain("CROMDB_TLS_CERT and CROMDB_TLS_KEY go together: set both, or neither for no TLS.");
    expect(errors).toContain("CROMDB_CLIENT_SECRET and CROMDB_CLIENT_SECRET_FILE are both set: set only one.");
    expect(errors.some((line) => line.startsWith("CROMDB_ADMIN_EMAIL: the email address"))).toBe(true);
    expect(errors.at(-1)).toBe("Nothing was written. Set the variables and start again.");
    expect(readdirSync(data)).toEqual([]);
  });

  it("checks the TLS files and the secret file", async () => {
    const data = dir.join("data");
    writeFileSync(dir.join("cert.pem"), selfSigned().cert);
    writeFileSync(dir.join("key.pem"), selfSigned().key);
    writeFileSync(dir.join("empty"), "\n");
    const env = variables({
      CROMDB_PUBLIC_URL: "https://cromdb.example.com",
      CROMDB_TLS_CERT: dir.join("cert.pem"),
      CROMDB_TLS_KEY: dir.join("key.pem"),
      CROMDB_CLIENT_SECRET_FILE: dir.join("empty"),
    });
    delete env["CROMDB_CLIENT_SECRET"];
    const result = await runWith(data, env);
    expect(result.status).toBe(1);
    expect(result.io.errors.some((line) => line.startsWith("CROMDB_TLS_CERT, CROMDB_TLS_KEY:") && line.includes("can't be used together"))).toBe(true);
    expect(result.io.errors).toContain(`CROMDB_CLIENT_SECRET_FILE: ${dir.join("empty")} is empty.`);
  });

  it("refuses TLS files with an http public URL", async () => {
    const pair = selfSigned();
    writeFileSync(dir.join("cert.pem"), pair.cert);
    writeFileSync(dir.join("key.pem"), pair.key);
    const result = await runWith(dir.join("data"), variables({ CROMDB_TLS_CERT: dir.join("cert.pem"), CROMDB_TLS_KEY: dir.join("key.pem") }));
    expect(result.status).toBe(1);
    expect(result.io.errors[0]).toBe("CROMDB_TLS_CERT: the public URL is http, so the server can't serve HTTPS; give an https CROMDB_PUBLIC_URL.");
  });

  it("says when the login provider can't be reached, so a restart can try again", async () => {
    const data = dir.join("data");
    const result = await runWith(data, variables({ CROMDB_ISSUER: "http://127.0.0.1:1/realms/cromdb" }));
    expect(result.status).toBe(1);
    expect(result.io.errors[0]).toMatch(/^CROMDB_ISSUER: /);
    expect(existsSync(data)).toBe(false);
  });
});

describe("run on a data directory", () => {
  it("starts a set-up one, and says the setup variables aren't used", async () => {
    const data = dir.join("data");
    await setUp(data, fake.issuer);
    const result = await runWith(data, variables({ CROMDB_DATA: data, CROMDB_RESTART_ON_EXIT: "1", CROMDB_SERVER_NAME: "Renamed" }), "0.0.0.0:8080");
    expect(result.status, result.io.text()).toBe(0);
    expect(result.started).toEqual([{ dataDir: data, listen: "0.0.0.0:8080" }]);
    expect(result.io.lines).toEqual([
      `${data} is set up, so CROMDB_SERVER_NAME, CROMDB_PUBLIC_URL, CROMDB_ISSUER, CROMDB_CLIENT_ID, CROMDB_CLIENT_SECRET, CROMDB_ADMIN_EMAIL are not used: they are read only on the first start. Change settings in the admin UI, or with "cromdb-server config set".`,
    ]);
    expect((await read(data)).settings.serverName).toBe("Test Server");
  });

  it("starts a set-up one quietly when no setup variable is set", async () => {
    const data = dir.join("data");
    await setUp(data, fake.issuer);
    const result = await runWith(data, { CROMDB_DATA: data, CROMDB_RESTART_ON_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.io.text()).toBe("");
  });

  it("refuses one that has files but no server database, and deletes nothing", async () => {
    const data = dir.join("data");
    mkdirSync(data);
    writeFileSync(dir.join("data", "notes.txt"), "mine");
    const result = await runWith(data, variables());
    expect(result.status).toBe(1);
    expect(result.started).toEqual([]);
    expect(result.io.errors).toEqual([`${data} has files but no finished setup. Empty it to set up again.`]);
    expect(readdirSync(data)).toEqual(["notes.txt"]);
  });
});

describe("the run command", () => {
  it("needs a data directory", async () => {
    const io = scriptedIo({ env: variables() });
    expectExit(await runMain(["run"], io), 2);
    expect(io.errors[0]).toBe("--data DIR is needed: the server's data directory");
  });

  it("takes no arguments", async () => {
    const io = scriptedIo();
    expectExit(await runMain(["run", "now", "--data", dir.join("data")], io), 2);
  });

  it("exits 1 with the problems", async () => {
    const io = scriptedIo({ env: { CROMDB_DATA: dir.join("data") } });
    expectExit(await runMain(["run"], io), 1);
    expect(io.errors.at(-1)).toBe("Nothing was written. Set the variables and start again.");
  });
});
