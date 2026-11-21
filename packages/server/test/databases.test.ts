// The API for databases, ACLs, documents and conflicts, through the test
// browser, so every response is checked against the route table. First the
// refusals every route shares, driven by the table; then each route; then
// access as the engine decides it, seen through HTTP. Last, every documented
// response of these routes must have been produced.

import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriverError, type Driver } from "@cromdb/driver";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_ROUTES } from "../src/http/database-routes.js";
import type { Route } from "../src/http/route.js";
import { dataPaths } from "../src/data-dir.js";
import { ServerDb } from "../src/store/server-db.js";
import { fakeHarness, missingCoverage, ONLY_ON_FAULTS, startTestServer, type LoginHarness, type TestBrowser, type TestServer } from "./harness.js";

// An empty level-2 database made by cromdb 0.5.0.
const LEVEL_2_FIXTURE = fileURLToPath(new URL("../../engine/test/fixtures/0.5.0/seeds/alice.cromdb", import.meta.url));
const SERVER = "cromdb-server";
const NO_ACCESS = { visible: false, read: false, write: false, create: false, admin: false };

let h: LoginHarness;
let t: TestServer;
let admin: TestBrowser;
let ivy: TestBrowser;
let sam: TestBrowser;
let adminId: string;
let ivyId: string;
let samId: string;
/** A database the admin made, with one document. */
let db: string;
let doc: string;

/** Faults the next test server's driver injects: an operation, and a check on its input. */
const faults: { op: string; when: (input: Record<string, unknown>) => boolean }[] = [];

function faultyDriver(): Driver {
  const real = createLevel4Driver();
  const call = (op: string, input: unknown) => {
    if (faults.some((fault) => fault.op === op && fault.when(input as Record<string, unknown>))) {
      return Promise.reject(new DriverError("INTERNAL", `injected fault in ${op}`));
    }
    return real.callByName(op, input);
  };
  return { call: call as Driver["call"], callByName: call, shutdown: () => real.shutdown() };
}

beforeAll(async () => {
  h = await fakeHarness();
});
afterAll(() => h.close());

beforeEach(async () => {
  faults.length = 0;
  t = await startTestServer(h, { driver: faultyDriver });
  admin = t.browser();
  expect((await admin.login(h, h.users.admin)).status).toBe(302);
  ivyId = (await admin.api("POST", "/api/v0/invitations", { email: h.users.invited.email })).body.personId;
  samId = (await admin.api("POST", "/api/v0/invitations", { email: h.users.uninvited.email })).body.personId;
  ivy = t.browser();
  expect((await ivy.login(h, h.users.invited)).status).toBe(302);
  sam = t.browser();
  expect((await sam.login(h, h.users.uninvited)).status).toBe(302);
  adminId = (await admin.api("GET", "/api/v0/me")).body.personId;
  db = await newDatabase("Notes");
  doc = (await admin.api("POST", `${base(db)}/documents`, { content: { title: "First" } })).body.id;
});
afterEach(async () => {
  expect(t.logs.filter((line) => line.includes("which the route table doesn't document"))).toEqual([]);
  await t.close();
});

const base = (databaseId: string) => `/api/v0/databases/${databaseId}`;
const etag = (response: { headers: Headers }) => response.headers.get("etag") ?? "";
const ifMatch = (version: string) => ({ "if-match": version });

/** The same person in a browser that knows the restarted server's address. */
function reconnect(browser: TestBrowser): TestBrowser {
  const again = t.browser();
  again.setCookie("cromdb-session", browser.cookie("cromdb-session") ?? "");
  return again;
}

async function newDatabase(name: string): Promise<string> {
  const response = await admin.api("POST", "/api/v0/databases", { name });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.databaseId;
}

type Lists = { admins: readonly string[]; creators: readonly string[]; writers: readonly string[]; readers: readonly string[]; noAccess: readonly string[] };

/** The database's ACL with these lists changed, saved by who (the admin by default). */
async function setAcl(databaseId: string, change: Partial<Lists>, who: TestBrowser = admin) {
  const current = await who.api("GET", `${base(databaseId)}/acl`);
  expect(current.status).toBe(200);
  const { admins, creators, writers, readers, noAccess } = current.body as Lists;
  return who.api("PUT", `${base(databaseId)}/acl`, { admins, creators, writers, readers, noAccess, ...change }, ifMatch(etag(current)));
}

async function ok(response: Promise<{ status: number; body: any; headers: Headers }> | { status: number; body: any; headers: Headers }, status = 200) {
  const done = await response;
  expect(done.status, JSON.stringify(done.body)).toBe(status);
  return done;
}

// ---------------------------------------------------------------------------
// What every route refuses

/** A path for the route, on this database and document. */
function pathFor(route: Route, databaseId = db, documentId = doc): string {
  return route.path.replace("{databaseId}", databaseId).replace("{documentId}", documentId);
}

/** A body that fits the route's schema. */
async function exampleBody(route: Route, browser: TestBrowser = admin): Promise<unknown> {
  switch (route.operationId) {
    case "createDatabase":
      return { name: "Another" };
    case "saveAcl": {
      const { admins, creators, writers, readers, noAccess } = (await browser.api("GET", `${base(db)}/acl`)).body as Lists;
      return admins === undefined ? { admins: [adminId, SERVER], creators: [], writers: [], readers: [], noAccess: [] } : { admins, creators, writers, readers, noAccess };
    }
    case "createDocument":
    case "saveDocument":
      return { content: { title: "Changed" } };
    case "findDocuments":
      return {};
    case "resolveConflict":
      return { delete: true };
    default:
      return undefined;
  }
}

/** The current version of what the route changes, for If-Match. */
async function versionFor(route: Route): Promise<string> {
  if (route.operationId === "saveAcl") return etag(await admin.api("GET", `${base(db)}/acl`));
  return etag(await admin.api("GET", `${base(db)}/documents/${doc}`));
}

/** A request to a route that passes every check before the one a test is about. */
async function call(
  browser: TestBrowser,
  route: Route,
  options: { headers?: Record<string, string>; body?: string; origin?: string | null; noIfMatch?: boolean; databaseId?: string } = {},
) {
  const example = await exampleBody(route);
  const headers: Record<string, string> = { ...(example === undefined ? {} : { "content-type": "application/json" }) };
  if (route.ifMatch === true && options.noIfMatch !== true) headers["if-match"] = await versionFor(route);
  return browser.request(pathFor(route, options.databaseId), {
    method: route.method.toUpperCase(),
    headers: { ...headers, ...options.headers },
    ...(options.body !== undefined ? { body: options.body } : example === undefined ? {} : { body: JSON.stringify(example) }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
}

const code = (response: { text: string }) => (JSON.parse(response.text) as { error: { code: string } }).error.code;
const changing = DATABASE_ROUTES.filter((route) => route.method !== "get");
const onDatabase = DATABASE_ROUTES.filter((route) => route.path.includes("{databaseId}"));

describe("what every database route refuses", () => {
  it("needs a session", async () => {
    for (const route of DATABASE_ROUTES) {
      const response = await call(t.browser(), route);
      expect(response.status, route.operationId).toBe(401);
      expect(code(response)).toBe("UNAUTHENTICATED");
    }
  });

  it("refuses a change from another origin, or with no origin at all", async () => {
    for (const route of changing) {
      for (const origin of ["https://evil.example", "null", null]) {
        const response = await call(admin, route, { origin });
        expect(response.status, `${route.operationId} ${origin}`).toBe(403);
        expect(code(response)).toBe("BAD_ORIGIN");
      }
      const sameSite = await call(admin, route, { origin: null, headers: { "sec-fetch-site": "same-origin" } });
      expect(sameSite.status, route.operationId).not.toBe(403);
    }
  });

  it("keeps making databases to server admins", async () => {
    for (const route of DATABASE_ROUTES.filter((r) => r.auth === "serverAdmin")) {
      const response = await call(ivy, route);
      expect(response.status, route.operationId).toBe(403);
      expect(JSON.parse(response.text).error.details).toEqual({ reason: "serverAdmin" });
    }
  });

  it("takes only JSON bodies, up to 1 MB", async () => {
    for (const route of changing) {
      const text = await call(admin, route, { headers: { "content-type": "text/plain" }, body: "hello" });
      expect(text.status, route.operationId).toBe(415);
      const large = await call(admin, route, { headers: { "content-type": "application/json" }, body: JSON.stringify({ content: { x: "x".repeat(1024 * 1024) } }) });
      expect(large.status, route.operationId).toBe(413);
      expect(code(large)).toBe("TOO_LARGE");
    }
  });

  it("needs If-Match where the table says so, as one current version", async () => {
    const withIfMatch = DATABASE_ROUTES.filter((r) => r.ifMatch === true);
    expect(withIfMatch.map((r) => r.operationId).sort()).toEqual(["deleteDocument", "resolveConflict", "saveAcl", "saveDocument"]);
    for (const route of withIfMatch) {
      const missing = await call(admin, route, { noIfMatch: true });
      expect(missing.status, route.operationId).toBe(428);
      expect(code(missing)).toBe("IF_MATCH_REQUIRED");
      for (const bad of ["*", 'W/"x"', '""']) {
        const response = await call(admin, route, { headers: { "if-match": bad } });
        expect(response.status, `${route.operationId} ${bad}`).toBe(400);
      }
      const stale = await call(admin, route, { headers: { "if-match": '"an-old-version"' } });
      expect(stale.status, route.operationId).toBe(412);
      expect(code(stale)).toBe("STALE_VERSION");
    }
  });

  it("checks bodies against their schemas, closed", async () => {
    for (const route of DATABASE_ROUTES.filter((r) => r.body !== undefined)) {
      const example = JSON.stringify(await exampleBody(route));
      // An empty body is {}, which only find takes (everything in it is optional).
      const empty = route.operationId === "findDocuments" ? [] : [""];
      for (const body of ["{", "[]", ...empty, `{"extra":1,${example.slice(1)}`, '{"content":7,"name":7,"admins":7,"limit":"x"}']) {
        const response = await call(admin, route, { headers: { "content-type": "application/json" }, body });
        expect(response.status, `${route.operationId} ${body.slice(0, 40)}`).toBe(400);
        expect(code(response)).toBe("INVALID_INPUT");
      }
    }
  });

  it("answers 404 alike for a database that doesn't exist and one the person can't see, whatever the request", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const route of onDatabase) {
      const hidden = await call(sam, route);
      const missing = await call(sam, route, { databaseId: unknown });
      expect(hidden.status, route.operationId).toBe(404);
      expect(missing.status, route.operationId).toBe(404);
      expect(JSON.parse(hidden.text)).toEqual(JSON.parse(missing.text.replaceAll(unknown, db)));
    }
    // Not even a body the server would refuse tells them apart.
    const bad = { admins: [SERVER], creators: ["anonymous"], writers: [], readers: [], noAccess: [SERVER] };
    expect((await sam.api("PUT", `${base(db)}/acl`, bad, ifMatch('"x"'))).status).toBe(404);
    expect((await sam.api("POST", `${base(db)}/documents`, { content: {}, fieldTypes: { "/nothing": "datetime" } })).status).toBe(404);
  });

  it("never serves the directory or the server database, even to a server admin", async () => {
    const ids = [t.server.serverDb.identity.directoryDatabaseId];
    const info = await t.server.databases.driver.call("database.info", { handle: t.server.serverDb.handle });
    ids.push(info.databaseId);
    for (const id of ids) {
      for (const route of onDatabase) {
        const response = await call(admin, route, { databaseId: id });
        expect(response.status, `${route.operationId} ${id}`).toBe(404);
      }
    }
    expect((await admin.api("GET", "/api/v0/databases")).body.databases.map((d: { databaseId: string }) => d.databaseId)).toEqual([db]);
  });
});

// ---------------------------------------------------------------------------
// Databases

describe("databases", () => {
  it("are made by server admins, who are their first admin, creator, writer and reader, with the server as an admin", async () => {
    const response = await ok(admin.api("POST", "/api/v0/databases", { name: "  Projects " }), 201);
    const id = response.body.databaseId;
    expect(response.body).toEqual({
      databaseId: id,
      name: "Projects",
      createdAt: expect.any(String),
      createdBy: adminId,
      access: { visible: true, read: true, write: true, create: true, admin: true },
    });
    expect(response.headers.get("location")).toBe(base(id));
    const acl = await ok(admin.api("GET", `${base(id)}/acl`));
    expect(acl.body).toMatchObject({ admins: [adminId, SERVER], creators: [adminId], writers: [adminId], readers: [adminId], noAccess: [] });
    expect(etag(acl)).toBe(`"${acl.body.version}"`);
    const record = t.server.serverDb.databases().find((r) => r.databaseId === id);
    expect(record).toMatchObject({ name: "Projects", createdBy: adminId, home: t.server.serverDb.identity.serverId });
    expect(readdirSync(t.server.paths.databases)).toContain(record?.file);
    // Nobody else sees it, until the ACL says so.
    expect((await ivy.api("GET", `${base(id)}`)).status).toBe(404);
  });

  it("need a name that isn't blank", async () => {
    const blank = await admin.api("POST", "/api/v0/databases", { name: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.error.details).toEqual({ path: "/name" });
    expect((await admin.api("POST", "/api/v0/databases", { name: "" })).status).toBe(400);
  });

  it("are listed only where the person is in a list and not locked out, with what they may do", async () => {
    const second = await newDatabase("Archive");
    expect((await ok(admin.api("GET", "/api/v0/databases"))).body).toEqual({
      databases: [
        { databaseId: second, name: "Archive", createdAt: expect.any(String), createdBy: adminId, access: { visible: true, read: true, write: true, create: true, admin: true } },
        { databaseId: db, name: "Notes", createdAt: expect.any(String), createdBy: adminId, access: { visible: true, read: true, write: true, create: true, admin: true } },
      ],
      unavailable: [],
    });
    expect((await ok(ivy.api("GET", "/api/v0/databases"))).body).toEqual({ databases: [], unavailable: [] });
    await ok(setAcl(db, { readers: [adminId, ivyId] }));
    const listed = (await ok(ivy.api("GET", "/api/v0/databases"))).body;
    expect(listed.databases).toEqual([expect.objectContaining({ databaseId: db, access: { visible: true, read: true, write: false, create: false, admin: false } })]);
    expect((await ok(ivy.api("GET", base(db)))).body.access).toEqual({ visible: true, read: true, write: false, create: false, admin: false });
    await ok(setAcl(db, { noAccess: [ivyId] }));
    expect((await ok(ivy.api("GET", "/api/v0/databases"))).body.databases).toEqual([]);
    expect((await ivy.api("GET", base(db))).status).toBe(404);
  });

  it("keep being served after a restart", async () => {
    await t.restart();
    admin = reconnect(admin);
    expect((await ok(admin.api("GET", `${base(db)}/documents/${doc}`))).body.content).toEqual({ title: "First" });
  });

  it("that the server can't open (another level, a broken file) are unavailable: listed to server admins only, served to nobody", async () => {
    const paths = dataPaths(t.dataDir);
    await t.restart(async () => {
      copyFileSync(LEVEL_2_FIXTURE, join(paths.databases, "old.cromdb"));
      const driver = createLevel4Driver();
      const serverDb = await ServerDb.open(driver, paths.serverDb);
      const record = (databaseId: string, name: string, file: string) => ({ databaseId, name, file, createdAt: new Date().toISOString(), createdBy: adminId, home: serverDb.identity.serverId });
      await serverDb.addDatabase(record("level-2-db", "Old", "old.cromdb"));
      await serverDb.addDatabase(record("missing-db", "Gone", "gone.cromdb"));
      await serverDb.close();
      await driver.shutdown();
    });
    admin = reconnect(admin);
    ivy = reconnect(ivy);
    const list = (await ok(admin.api("GET", "/api/v0/databases"))).body;
    expect(list.databases.map((d: { databaseId: string }) => d.databaseId)).toEqual([db]);
    expect(list.unavailable).toEqual([
      { databaseId: "missing-db", name: "Gone", reason: expect.stringContaining("no database") },
      { databaseId: "level-2-db", name: "Old", reason: expect.stringContaining("level 2") },
    ]);
    expect((await ok(ivy.api("GET", "/api/v0/databases"))).body.unavailable).toEqual([]);
    for (const route of onDatabase) {
      const response = await call(admin, route, { databaseId: "level-2-db" });
      expect(response.status, route.operationId).toBe(404);
    }
  });

  it("aren't left behind when making one fails part way", async () => {
    const before = readdirSync(t.server.paths.databases).sort();
    const registered = t.server.serverDb.databases().length;
    faults.push({ op: "acl.save", when: () => true });
    const failed = await admin.api("POST", "/api/v0/databases", { name: "Broken" });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("INTERNAL");
    faults.length = 0;
    // The registry write fails: a database document in the server database.
    faults.push({ op: "documents.create", when: (input) => (input["content"] as { type?: unknown } | undefined)?.type === "database" });
    expect((await admin.api("POST", "/api/v0/databases", { name: "Broken too" })).status).toBe(500);
    faults.length = 0;
    expect(readdirSync(t.server.paths.databases).sort()).toEqual(before);
    expect(t.server.serverDb.databases()).toHaveLength(registered);
    expect((await ok(admin.api("GET", "/api/v0/databases"))).body.databases).toHaveLength(1);
    expect(t.logs.join("\n")).toContain("injected fault in acl.save");
    // And a later one works.
    await newDatabase("Fine");
  });
});

// ---------------------------------------------------------------------------
// ACLs

describe("the ACL", () => {
  it("is read and replaced by the database's admins, with its version as ETag", async () => {
    const before = await ok(admin.api("GET", `${base(db)}/acl`));
    const saved = await ok(setAcl(db, { readers: ["*"], writers: [adminId, ivyId], creators: [adminId, ivyId] }));
    expect(saved.body).toMatchObject({ admins: [adminId, SERVER], readers: ["*"], writers: [adminId, ivyId], updatedBy: adminId });
    expect(etag(saved)).not.toBe(etag(before));
    const stale = await admin.api("PUT", `${base(db)}/acl`, { ...saved.body, version: undefined, createdAt: undefined }, ifMatch(etag(before)));
    expect(stale.status).toBe(400);
    const { admins, creators, writers, readers, noAccess } = saved.body as Lists;
    const old = await admin.api("PUT", `${base(db)}/acl`, { admins, creators, writers, readers, noAccess }, ifMatch(etag(before)));
    expect(old.status).toBe(412);
    expect(old.body.error.code).toBe("STALE_VERSION");
  });

  it("is refused to people who can see the database but don't admin it", async () => {
    await ok(setAcl(db, { readers: ["*"] }));
    const read = await ivy.api("GET", `${base(db)}/acl`);
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("ACCESS_DENIED");
    const lists = { admins: [ivyId, SERVER], creators: [], writers: [], readers: [], noAccess: [] };
    expect((await ivy.api("PUT", `${base(db)}/acl`, lists, ifMatch('"x"'))).status).toBe(403);
  });

  it('keeps "cromdb-server" an admin and out of noAccess, and refuses "anonymous" in any list', async () => {
    for (const [change, path] of [
      [{ admins: [adminId] }, "/admins"],
      [{ noAccess: [SERVER] }, "/noAccess/0"],
      [{ readers: [adminId, "anonymous"] }, "/readers/1"],
      [{ creators: ["Anonymous"] }, "/creators/0"],
      [{ writers: ["ANONYMOUS"] }, "/writers/0"],
      [{ admins: [adminId, SERVER, "anonymous"] }, "/admins/2"],
    ] as const) {
      const response = await setAcl(db, change);
      expect(response.status, JSON.stringify(change)).toBe(400);
      expect(response.body.error).toEqual({ code: "INVALID_INPUT", message: expect.any(String), details: { path } });
    }
    expect((await setAcl(db, { readers: ["anonymous"] })).body.error.message).toContain("no anonymous sessions");
    // "*" is everyone who logs in, and is taken.
    await ok(setAcl(db, { readers: ["*"] }));
  });

  it("passes on the engine's own rules", async () => {
    const star = await setAcl(db, { noAccess: ["*"] });
    expect(star.status).toBe(400);
    expect(star.body.error.code).toBe("INVALID_INPUT");
    const self = await setAcl(db, { noAccess: [adminId] });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toContain("lock themselves out");
    // An admin may lock out another admin, who then has no access at all.
    await ok(setAcl(db, { admins: [adminId, ivyId, SERVER] }));
    await ok(setAcl(db, { noAccess: [adminId] }, ivy));
    expect((await admin.api("GET", `${base(db)}/acl`)).status).toBe(404);
    expect((await admin.api("GET", base(db))).status).toBe(404);
  });

  it("lets an admin who is in no other list manage the database but not read or write in it", async () => {
    await ok(setAcl(db, { admins: [adminId, ivyId, SERVER] }));
    expect((await ok(ivy.api("GET", base(db)))).body.access).toEqual({ visible: true, read: false, write: false, create: false, admin: true });
    await ok(ivy.api("GET", `${base(db)}/acl`));
    expect((await ok(ivy.api("POST", `${base(db)}/find`, {}))).body.documents).toEqual([]);
    expect((await ivy.api("GET", `${base(db)}/documents/${doc}`)).status).toBe(404);
    expect((await ivy.api("POST", `${base(db)}/documents`, { content: {} })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Documents

describe("documents", () => {
  it("are made, read, saved and deleted, with versions as ETags", async () => {
    const created = await ok(admin.api("POST", `${base(db)}/documents`, { content: { title: "Plan", due: "2026-12-01T00:00:00.000Z" }, fieldTypes: { "/due": "datetime" } }), 201);
    const id = created.body.id;
    expect(created.headers.get("location")).toBe(`${base(db)}/documents/${id}`);
    expect(created.body).toMatchObject({ id, parentId: id, deleted: false, readers: ["*"], writers: ["*"], createdBy: adminId, fieldTypes: { "/due": "datetime" } });
    expect(created.body.access).toEqual({ read: true, update: true, delete: true });
    expect(etag(created)).toBe(`"${created.body.version}"`);

    const read = await ok(admin.api("GET", `${base(db)}/documents/${id}`));
    expect(read.body).toEqual(created.body);
    const saved = await ok(admin.api("PUT", `${base(db)}/documents/${id}`, { content: { title: "Plan B" }, readers: [adminId] }, ifMatch(etag(read))));
    expect(saved.body).toMatchObject({ editedThroughConflict: false, document: { content: { title: "Plan B" }, readers: [adminId], fieldTypes: {} } });
    expect(etag(saved)).toBe(`"${saved.body.document.version}"`);
    const stale = await admin.api("PUT", `${base(db)}/documents/${id}`, { content: {} }, ifMatch(etag(read)));
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe("STALE_VERSION");
    expect((await admin.api("DELETE", `${base(db)}/documents/${id}`, undefined, ifMatch(etag(read)))).status).toBe(412);
    expect((await ok(admin.api("DELETE", `${base(db)}/documents/${id}`, undefined, ifMatch(etag(saved))))).body).toEqual({ editedThroughConflict: false });
    expect((await admin.api("GET", `${base(db)}/documents/${id}`)).status).toBe(404);
    expect((await admin.api("PUT", `${base(db)}/documents/${id}`, { content: {} }, ifMatch(etag(saved)))).status).toBe(404);
    expect((await admin.api("DELETE", `${base(db)}/documents/${id}`, undefined, ifMatch(etag(saved)))).status).toBe(404);
  });

  it("refuse content the engine won't store", async () => {
    const missing = await admin.api("POST", `${base(db)}/documents`, { content: { a: 1 }, fieldTypes: { "/b": "datetime" } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain("/b");
    const notTime = await admin.api("POST", `${base(db)}/documents`, { content: { a: "yesterday" }, fieldTypes: { "/a": "datetime" } });
    expect(notTime.status).toBe(400);
    const read = await admin.api("GET", `${base(db)}/documents/${doc}`);
    expect((await admin.api("PUT", `${base(db)}/documents/${doc}`, { content: {}, writers: [adminId, ""] }, ifMatch(etag(read)))).status).toBe(400);
  });

  it("can have a parent the person can read", async () => {
    const child = await ok(admin.api("POST", `${base(db)}/documents`, { content: { n: 1 }, parentId: doc }), 201);
    expect(child.body.parentId).toBe(doc);
    const found = await ok(admin.api("POST", `${base(db)}/find`, { filter: { parentId: doc } }));
    expect(found.body.documents.map((d: { id: string }) => d.id)).toEqual([child.body.id]);
    const orphan = await admin.api("POST", `${base(db)}/documents`, { content: {}, parentId: "no-such-document" });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error.details).toEqual({ path: "/parentId" });
  });

  it("are found by filter, in pages of up to 1000, 50 by default", async () => {
    for (let n = 0; n < 5; n++) {
      await ok(admin.api("POST", `${base(db)}/documents`, { content: { kind: "task", n } }), 201);
    }
    const all = await ok(admin.api("POST", `${base(db)}/find`, {}));
    const empty = await admin.request(`${base(db)}/find`, { method: "POST", headers: { "content-type": "application/json" }, body: "" });
    expect(JSON.parse(empty.text)).toEqual(all.body);
    expect(all.body.documents).toHaveLength(6);
    expect(all.body.next).toBeNull();
    const pages: number[][] = [];
    let after: string | null = null;
    do {
      const page: { body: { documents: { content: { n: number } }[]; next: string | null } } = await ok(
        admin.api("POST", `${base(db)}/find`, { filter: { where: { kind: "task" } }, limit: 2, ...(after === null ? {} : { after }) }),
      );
      pages.push(page.body.documents.map((d) => d.content.n));
      after = page.body.next;
    } while (after !== null);
    // In createdAt order, then ID: documents made in one millisecond can come in any order.
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat().sort()).toEqual([0, 1, 2, 3, 4]);
    for (const body of [{ limit: 0 }, { limit: 1001 }, { filter: { nope: true } }, { after: 7 }]) {
      expect((await admin.api("POST", `${base(db)}/find`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await admin.api("POST", `${base(db)}/find`, { after: "not-a-position" })).status).toBe(400);
    expect((await ok(admin.api("POST", `${base(db)}/find`, { limit: 1000 }))).body.documents).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Access, as the engine decides it

describe("access through HTTP", () => {
  it("is the database's maximum: a document open to everyone is still closed to people outside the database", async () => {
    const open = await ok(admin.api("POST", `${base(db)}/documents`, { content: { open: true }, readers: ["*"], writers: ["*"] }), 201);
    expect((await ivy.api("GET", `${base(db)}/documents/${open.body.id}`)).status).toBe(404);
    await ok(setAcl(db, { readers: ["*"] }));
    expect((await ok(ivy.api("GET", `${base(db)}/documents/${open.body.id}`))).body.access).toEqual({ read: true, update: false, delete: false });
  });

  it("lets a reader read but not write, make or delete", async () => {
    await ok(setAcl(db, { readers: [adminId, ivyId] }));
    const read = await ok(ivy.api("GET", `${base(db)}/documents/${doc}`));
    const save = await ivy.api("PUT", `${base(db)}/documents/${doc}`, { content: { by: "ivy" } }, ifMatch(etag(read)));
    expect(save.status).toBe(403);
    expect(save.body.error.code).toBe("ACCESS_DENIED");
    expect((await ivy.api("DELETE", `${base(db)}/documents/${doc}`, undefined, ifMatch(etag(read)))).status).toBe(403);
    expect((await ivy.api("POST", `${base(db)}/documents`, { content: {} })).status).toBe(403);
    expect((await ok(ivy.api("POST", `${base(db)}/find`, {}))).body.documents).toHaveLength(1);
  });

  it("lets a depositor make documents but not read them back", async () => {
    await ok(setAcl(db, { creators: [adminId, samId] }));
    expect((await ok(sam.api("GET", base(db)))).body.access).toEqual({ visible: true, read: false, write: false, create: true, admin: false });
    const made = await ok(sam.api("POST", `${base(db)}/documents`, { content: { tip: "anonymous tip" } }), 201);
    expect(made.body.access).toEqual({ read: false, update: false, delete: false });
    expect((await sam.api("GET", `${base(db)}/documents/${made.body.id}`)).status).toBe(404);
    expect((await ok(sam.api("POST", `${base(db)}/find`, {}))).body.documents).toEqual([]);
    expect((await sam.api("PUT", `${base(db)}/documents/${made.body.id}`, { content: {} }, ifMatch(etag(made)))).status).toBe(404);
    expect((await ok(admin.api("GET", `${base(db)}/documents/${made.body.id}`))).body.content).toEqual({ tip: "anonymous tip" });
  });

  it("locks a person in noAccess out of every route", async () => {
    await ok(setAcl(db, { readers: ["*"], writers: ["*"], creators: ["*"], admins: [adminId, ivyId, SERVER] }));
    await ok(ivy.api("GET", `${base(db)}/documents/${doc}`));
    await ok(setAcl(db, { noAccess: [ivyId] }));
    for (const route of onDatabase) {
      const response = await call(ivy, route);
      expect(response.status, route.operationId).toBe(404);
      expect(code(response)).toBe("NOT_FOUND");
    }
    expect((await ok(ivy.api("GET", "/api/v0/databases"))).body.databases).toEqual([]);
  });

  it("gives two people different access to the same database", async () => {
    await ok(setAcl(db, { readers: [adminId, ivyId, samId], writers: [adminId, ivyId], creators: [adminId, ivyId] }));
    const shared = await ok(ivy.api("POST", `${base(db)}/documents`, { content: { for: "everyone" } }), 201);
    const secret = await ok(ivy.api("POST", `${base(db)}/documents`, { content: { for: "ivy" }, readers: [ivyId, adminId] }), 201);
    const ids = async (who: TestBrowser) => (await ok(who.api("POST", `${base(db)}/find`, {}))).body.documents.map((d: { id: string }) => d.id).sort();
    expect(await ids(ivy)).toEqual([doc, shared.body.id, secret.body.id].sort());
    expect(await ids(sam)).toEqual([doc, shared.body.id].sort());
    expect((await sam.api("GET", `${base(db)}/documents/${secret.body.id}`)).status).toBe(404);
    expect((await sam.api("PUT", `${base(db)}/documents/${shared.body.id}`, { content: {} }, ifMatch(etag(shared)))).status).toBe(403);
    await ok(ivy.api("PUT", `${base(db)}/documents/${shared.body.id}`, { content: { edited: true } }, ifMatch(etag(shared))));
    expect((await ok(sam.api("GET", base(db)))).body.access).toEqual({ visible: true, read: true, write: false, create: false, admin: false });
    expect((await ok(ivy.api("GET", base(db)))).body.access).toEqual({ visible: true, read: true, write: true, create: true, admin: false });
    expect((await ok(admin.api("GET", "/api/v0/databases"))).body.databases[0].access).toEqual({ visible: true, read: true, write: true, create: true, admin: true });
    // Nobody acts as the server: every write is the person's own.
    expect((await ok(admin.api("GET", `${base(db)}/documents/${shared.body.id}`))).body.updatedBy).toBe(ivyId);
  });

  it("shows a person no access at all to a database outside every list", async () => {
    expect(await t.server.databases.driver.call("access.mine", { handle: (t.server.databases.get(db) as { handle: string }).handle, principal: { id: samId } })).toEqual(NO_ACCESS);
    expect((await sam.api("GET", base(db))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Conflicts

describe("conflicts", () => {
  /**
   * Makes the document conflict: a second replica (made and synced as
   * "cromdb-server", as servers will) saves it as the admin while the
   * server saves it too, then the replica's change is pulled in.
   */
  async function conflictOn(id: string): Promise<void> {
    const driver = t.server.databases.driver;
    const server = { handle: (t.server.databases.get(db) as { handle: string }).handle, principal: { id: SERVER } };
    const { ticket } = await driver.call("replicas.register", server);
    const opened = await driver.call("database.createFromTicket", { storage: { kind: "memory" }, principal: { id: SERVER }, ticket });
    const replica = { handle: opened.handle, principal: { id: SERVER } };
    const pull = async (from: typeof server, fromInstance: string, to: typeof server) => {
      const { hello } = await driver.call("sync.hello", from);
      await driver.call("sync.checkPeer", { ...to, hello });
      for (;;) {
        const { since } = await driver.call("sync.position", { ...to, sourceInstanceId: fromInstance });
        const { batch } = await driver.call("sync.export", { ...from, since });
        if (!(await driver.call("sync.apply", { ...to, batch })).hasMore) return;
      }
    };
    const serverInstance = (await driver.call("database.info", { handle: server.handle })).instanceId;
    await pull(server, serverInstance, replica);
    const there = await driver.call("documents.get", { handle: replica.handle, principal: { id: adminId }, id });
    await driver.call("documents.save", { handle: replica.handle, principal: { id: adminId }, id, ifVersion: there.document?.version ?? "", content: { side: "replica" } });
    const here = await ok(admin.api("GET", `${base(db)}/documents/${id}`));
    await ok(admin.api("PUT", `${base(db)}/documents/${id}`, { content: { side: "server" } }, ifMatch(etag(here))));
    await pull(replica, opened.instanceId, server);
    await driver.call("database.close", { handle: replica.handle });
  }

  async function conflict(id: string, who: TestBrowser = admin) {
    return ok(who.api("GET", `${base(db)}/documents/${id}/conflict`));
  }

  it("are shown with every version the person can read, and the conflict's version as ETag", async () => {
    expect((await admin.api("GET", `${base(db)}/documents/${doc}/conflict`)).status).toBe(404);
    await conflictOn(doc);
    const found = await conflict(doc);
    expect(etag(found)).toBe(`"${found.body.version}"`);
    expect(found.body.primaryId).toBe(doc);
    expect(found.body.versions.map((v: { document: { content: { side: string } } }) => v.document.content.side).sort()).toEqual(["replica", "server"]);
    expect(found.body.versions.filter((v: { isPrimary: boolean }) => v.isPrimary)).toHaveLength(1);
    expect(found.body.versions.every((v: { authorized: boolean; deleted: boolean }) => v.authorized && !v.deleted)).toBe(true);
    const inConflict = await ok(admin.api("POST", `${base(db)}/find`, { filter: { inConflict: true } }));
    expect(inConflict.body.documents.map((d: { id: string }) => d.id)).toEqual([doc]);
  });

  it("are flagged on every document the API returns, with the replica each version was changed on", async () => {
    const other = (await ok(admin.api("POST", `${base(db)}/documents`, { content: { side: "alone" } }), 201)).body;
    expect(other.inConflict).toBe(false);
    const here = (await t.server.databases.driver.call("database.info", { handle: (t.server.databases.get(db) as { handle: string }).handle })).instanceId;
    expect(other.updatedOn).toBe(here);
    expect((await ok(admin.api("GET", `${base(db)}/documents/${doc}`))).body.inConflict).toBe(false);

    await conflictOn(doc);
    expect((await ok(admin.api("GET", `${base(db)}/documents/${doc}`))).body.inConflict).toBe(true);
    expect((await ok(admin.api("GET", `${base(db)}/documents/${other.id}`))).body.inConflict).toBe(false);
    const all = await ok(admin.api("POST", `${base(db)}/find`, {}));
    const flags = Object.fromEntries(all.body.documents.map((d: { id: string; inConflict: boolean }) => [d.id, d.inConflict]));
    expect(flags).toEqual({ [doc]: true, [other.id]: false });

    const found = await conflict(doc);
    const versions = found.body.versions as { document: { id: string; inConflict: boolean; updatedOn: string; content: { side: string } }; isPrimary: boolean }[];
    expect(versions.every((v) => v.document.inConflict)).toBe(true);
    const fromReplica = versions.find((v) => v.document.content.side === "replica");
    expect(fromReplica?.document.updatedOn).not.toBe(here);
    const version = versions.find((v) => !v.isPrimary);
    if (version === undefined) throw new Error("no conflict version");
    // A version read by its own ID says what conflicts.get says of it.
    const read = await ok(admin.api("GET", `${base(db)}/documents/${version.document.id}`));
    expect(typeof read.body.inConflict).toBe("boolean");

    const primary = await ok(admin.api("GET", `${base(db)}/documents/${doc}`));
    const through = await ok(admin.api("PUT", `${base(db)}/documents/${doc}`, { content: { side: "both" } }, ifMatch(etag(primary))));
    expect(through.body.document.inConflict).toBe(true);
    await ok(admin.api("POST", `${base(db)}/documents/${doc}/conflict/resolve`, { delete: true }, ifMatch(etag(await conflict(doc)))));
    const after = await ok(admin.api("POST", `${base(db)}/find`, {}));
    expect(after.body.documents.map((d: { id: string; inConflict: boolean }) => [d.id, d.inConflict])).toEqual([[other.id, false]]);
  });

  it("keep their versions read-only, and a save through a conflict says so", async () => {
    await conflictOn(doc);
    const versions = (await conflict(doc)).body.versions as { document: { id: string; version: string }; isPrimary: boolean }[];
    const other = versions.find((v) => !v.isPrimary);
    if (other === undefined) throw new Error("no conflict version");
    const readOnly = await admin.api("PUT", `${base(db)}/documents/${other.document.id}`, { content: {} }, ifMatch(`"${other.document.version}"`));
    expect(readOnly.status).toBe(409);
    expect(readOnly.body.error.code).toBe("READ_ONLY");
    expect((await admin.api("DELETE", `${base(db)}/documents/${other.document.id}`, undefined, ifMatch(`"${other.document.version}"`))).status).toBe(409);
    const primary = await ok(admin.api("GET", `${base(db)}/documents/${doc}`));
    const through = await ok(admin.api("PUT", `${base(db)}/documents/${doc}`, { content: { side: "both" } }, ifMatch(etag(primary))));
    expect(through.body.editedThroughConflict).toBe(true);
  });

  it("are resolved with a version, with new content, or by deleting, once each", async () => {
    const second = (await ok(admin.api("POST", `${base(db)}/documents`, { content: {} }), 201)).body.id;
    const third = (await ok(admin.api("POST", `${base(db)}/documents`, { content: {} }), 201)).body.id;
    for (const id of [doc, second, third]) await conflictOn(id);

    const first = await conflict(doc);
    const replicaSide = first.body.versions.find((v: { document: { content: { side: string } } }) => v.document.content.side === "replica");
    const resolve = (id: string, body: unknown, version: string) => admin.api("POST", `${base(db)}/documents/${id}/conflict/resolve`, body, ifMatch(version));
    expect((await resolve(doc, { chooseId: "not-a-version" }, etag(first))).status).toBe(404);
    expect((await ok(resolve(doc, { chooseId: replicaSide.document.id }, etag(first)))).body).toEqual({ editedThroughConflict: false });
    expect((await ok(admin.api("GET", `${base(db)}/documents/${doc}`))).body.content).toEqual({ side: "replica" });
    expect((await admin.api("GET", `${base(db)}/documents/${doc}/conflict`)).status).toBe(404);
    const again = await resolve(doc, { delete: true }, etag(first));
    expect(again.status).toBe(412);

    await ok(resolve(second, { content: { side: "merged" }, readers: ["*"] }, etag(await conflict(second))));
    expect((await ok(admin.api("GET", `${base(db)}/documents/${second}`))).body.content).toEqual({ side: "merged" });
    await ok(resolve(third, { delete: true }, etag(await conflict(third))));
    expect((await admin.api("GET", `${base(db)}/documents/${third}`)).status).toBe(404);
  });

  it("take one way of resolving at a time", async () => {
    await conflictOn(doc);
    const found = await conflict(doc);
    for (const body of [{}, { chooseId: "x", delete: true }, { delete: false }, { content: {}, chooseId: "x" }]) {
      const response = await admin.api("POST", `${base(db)}/documents/${doc}/conflict/resolve`, body, ifMatch(etag(found)));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.message).toContain("one of { chooseId }");
    }
  });

  it("are resolved only by people who can write the document", async () => {
    await ok(setAcl(db, { readers: [adminId, ivyId] }));
    await conflictOn(doc);
    const found = await conflict(doc, ivy);
    const refused = await ivy.api("POST", `${base(db)}/documents/${doc}/conflict/resolve`, { delete: true }, ifMatch(etag(found)));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("ACCESS_DENIED");
  });
});

afterAll(() => {
  expect(missingCoverage(DATABASE_ROUTES, ONLY_ON_FAULTS)).toEqual([]);
});
