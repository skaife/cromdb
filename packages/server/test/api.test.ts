// The API under /api/v0 for the server, people and invitations, through the
// test browser, so every response is checked against the route table. First
// the refusals every route shares, driven by the table itself; then each
// route; then sessions. Last, every documented response of these routes must
// have been produced. Databases and documents are in databases.test.ts.

import { copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLevel4Driver } from "@cromdb/driver-level-4";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dataPaths } from "../src/data-dir.js";
import { ServerDb } from "../src/store/server-db.js";
import { selfSigned } from "./certificates.js";
import { tempDir } from "./helpers.js";
import { createApp } from "../src/http/app.js";
import type { Route, Services } from "../src/http/route.js";
import { ROUTES } from "../src/http/routes.js";
import { fakeHarness, missingCoverage, ONLY_ON_FAULTS, startTestServer, type LoginHarness, type TestBrowser, type TestServer } from "./harness.js";

let h: LoginHarness;
let t: TestServer;
let admin: TestBrowser;
let ivy: TestBrowser;
let ivyId: string;
let adminId: string;

beforeAll(async () => {
  h = await fakeHarness();
});
afterAll(() => h.close());

beforeEach(async () => {
  t = await startTestServer(h);
  admin = t.browser();
  expect((await admin.login(h, h.users.admin)).status).toBe(302);
  const invited = await admin.api("POST", "/api/v0/invitations", { email: h.users.invited.email });
  ivyId = invited.body.personId;
  ivy = t.browser();
  expect((await ivy.login(h, h.users.invited)).status).toBe(302);
  adminId = (await admin.api("GET", "/api/v0/me")).body.personId;
});
afterEach(() => t.close());

const etagOf = async (personId: string) => (await admin.api("GET", `/api/v0/people/${personId}/details`)).headers.get("etag") ?? "";
const settingsRead = () => admin.api("GET", "/api/v0/server/settings");

/** A body each route takes, as read now. */
async function exampleFor(route: Route): Promise<Record<string, unknown> | undefined> {
  switch (route.operationId) {
    case "invite":
      return { email: "new@example.com" };
    case "setServerAdmin":
      return { serverAdmin: true };
    case "saveServerSettings":
      return (await settingsRead()).body.saved;
    case "setClientSecret":
      return { secret: "another-secret" };
    case "restoreDatabase":
      return { databaseId: "a-database" };
    default:
      return undefined;
  }
}

/** A request to a route that passes every check before the one a test is about. */
async function call(
  browser: TestBrowser,
  route: Route,
  options: { headers?: Record<string, string>; body?: string; origin?: string | null; personId?: string; noIfMatch?: boolean } = {},
) {
  const path = route.path.replace("{personId}", options.personId ?? ivyId);
  const example = await exampleFor(route);
  const headers: Record<string, string> = { ...(example === undefined ? {} : { "content-type": "application/json" }) };
  if (route.ifMatch === true && options.noIfMatch !== true) {
    headers["if-match"] = route.operationId === "saveServerSettings" ? ((await settingsRead()).headers.get("etag") ?? "") : await etagOf(options.personId ?? ivyId);
  }
  return browser.request(path, {
    method: route.method.toUpperCase(),
    headers: { ...headers, ...options.headers },
    ...(options.body !== undefined ? { body: options.body } : example === undefined ? {} : { body: JSON.stringify(example) }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
}

const code = (response: { text: string }) => (JSON.parse(response.text) as { error: { code: string } }).error.code;
/** The routes this file is about. */
const TABLE = ROUTES.filter((route) => route.tag !== "databases" && route.tag !== "documents");
const apiRoutes = TABLE.filter((route) => route.tag !== "browser");
const changing = TABLE.filter((route) => route.method !== "get");

describe("what every route refuses", () => {
  it("needs a session where the table says so, and removes a cookie that names none", async () => {
    for (const route of TABLE.filter((r) => r.auth !== "none")) {
      const response = await call(t.browser(), route);
      expect(response.status, route.operationId).toBe(401);
      expect(code(response)).toBe("UNAUTHENTICATED");
      const stale = t.browser();
      stale.setCookie("cromdb-session", "not-a-session");
      const again = await call(stale, route);
      expect(again.status).toBe(401);
      expect(again.headers.getSetCookie()).toEqual(["cromdb-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"]);
    }
  });

  it("refuses a state change from another origin, or with no origin at all", async () => {
    for (const route of changing) {
      for (const origin of ["https://evil.example", "http://localhost:8081", "null", null]) {
        const response = await call(admin, route, { origin });
        expect(response.status, `${route.operationId} ${origin}`).toBe(403);
        expect(code(response)).toBe("BAD_ORIGIN");
      }
      // Without Origin, Sec-Fetch-Site: same-origin is enough; cross-site is not.
      const sameSite = await call(admin, route, { origin: null, headers: { "sec-fetch-site": "same-origin" } });
      expect(sameSite.status, route.operationId).not.toBe(403);
      const crossSite = await call(admin, route, { origin: null, headers: { "sec-fetch-site": "cross-site" } });
      expect(crossSite.status).toBe(403);
      if (route.operationId === "logout") {
        expect((await admin.login(h, h.users.admin)).status).toBe(302);
      }
    }
  });

  it("keeps server-admin routes to server admins", async () => {
    for (const route of TABLE.filter((r) => r.auth === "serverAdmin")) {
      const response = await call(ivy, route, { personId: adminId });
      expect(response.status, route.operationId).toBe(403);
      expect(JSON.parse(response.text)).toEqual({ error: { code: "ACCESS_DENIED", message: expect.any(String), details: { reason: "serverAdmin" } } });
    }
  });

  it("takes only JSON bodies, up to 1 MB", async () => {
    for (const route of changing) {
      const text = await call(admin, route, { headers: { "content-type": "text/plain" }, body: "hello" });
      expect(text.status, route.operationId).toBe(415);
      expect(code(text)).toBe("UNSUPPORTED_MEDIA_TYPE");
      const form = await call(admin, route, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
      expect(form.status).toBe(415);
      const large = await call(admin, route, { headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x".repeat(1024 * 1024) }) });
      expect(large.status, route.operationId).toBe(413);
      expect(code(large)).toBe("TOO_LARGE");
    }
  });

  it("needs If-Match where the table says so, as one current version", async () => {
    for (const route of TABLE.filter((r) => r.ifMatch === true)) {
      const missing = await call(admin, route, { noIfMatch: true });
      expect(missing.status, route.operationId).toBe(428);
      expect(code(missing)).toBe("IF_MATCH_REQUIRED");
      for (const bad of ["*", "W/\"x\"", "abc", '"a", "b"', '""']) {
        const response = await call(admin, route, { headers: { "if-match": bad } });
        expect(response.status, `${route.operationId} ${bad}`).toBe(400);
        expect(JSON.parse(response.text).error.details).toEqual({ header: "If-Match" });
      }
      const stale = await call(admin, route, { headers: { "if-match": '"an-old-version"' } });
      expect(stale.status, route.operationId).toBe(412);
      expect(code(stale)).toBe("STALE_VERSION");
    }
  });

  it("checks bodies against their schemas, closed", async () => {
    for (const route of TABLE.filter((r) => r.body !== undefined)) {
      for (const [body, path] of [
        ["{", ""],
        ["[]", ""],
        [JSON.stringify({ extra: 1, ...(await exampleFor(route)) }), "/extra"],
        ['{"serverAdmin":"yes","email":7}', undefined],
      ] as const) {
        const response = await call(admin, route, { headers: { "content-type": "application/json" }, body });
        expect(response.status, `${route.operationId} ${body}`).toBe(400);
        expect(code(response)).toBe("INVALID_INPUT");
        if (path !== undefined) expect(JSON.parse(response.text).error.details.path).toBe(path);
      }
      const none = await call(admin, route, { headers: { "content-type": "application/json" }, body: "" });
      expect(none.status).toBe(400);
    }
  });

  it("refuses unknown, repeated or malformed query parameters where the table is strict", async () => {
    for (const route of TABLE.filter((r) => r.strictQuery === true)) {
      for (const query of ["?nope=1", "?limit=1&limit=2", "?limit=0", "?limit=1001", "?limit=x", "?after=not-a-cursor", "?__proto__=1"]) {
        const response = await admin.request(`${route.path}${query}`);
        expect(response.status, `${route.operationId}${query}`).toBe(400);
        expect(code(response)).toBe("INVALID_INPUT");
      }
    }
  });

  it("answers an unknown path or method with a JSON 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/v0/nothing"],
      ["DELETE", "/api/v0/me"],
      ["GET", "/api/v0/people/x/y/z"],
    ] as const) {
      const response = await admin.request(path, { method });
      expect(response.status).toBe(404);
      expect(code(response)).toBe("NOT_FOUND");
    }
  });
});

describe("the server", () => {
  it("answers the health check and serves its description", async () => {
    expect((await t.browser().api("GET", "/api/v0/health")).body).toEqual({ status: "ok" });
    expect((await t.browser().api("GET", "/api/v0/server/about")).body).toEqual({ serverName: "Test <Server>" });
    const openapi = await t.browser().api("GET", "/api/v0/openapi.json");
    expect(openapi.body.openapi).toBe("3.1.0");
    expect(Object.keys(openapi.body.paths)).toContain("/api/v0/people/{personId}");
  });

  it("hides a fault's details from the client and logs them", async () => {
    const logs: string[] = [];
    const failing: Route = {
      method: "get",
      path: "/api/v0/fail",
      operationId: "fail",
      summary: "Fails.",
      tag: "server",
      auth: "none",
      responses: {},
      handler: () => {
        throw new Error("the secret detail");
      },
    };
    const services = { settings: t.server.serverDb.settings, sessions: t.server.sessions, directory: t.server.directory, cookies: { session: "s", login: "l" }, log: (line: string) => logs.push(line) } as unknown as Services;
    const app = createApp({ trustProxy: false, routes: [failing], services });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v0/fail`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong on the server" } });
      expect(logs.join("\n")).toContain("the secret detail");
    } finally {
      server.close();
    }
  });
});

describe("people", () => {
  it("shows a person their own details at /me", async () => {
    expect((await ivy.api("GET", "/api/v0/me")).body).toEqual({
      personId: ivyId,
      displayName: h.users.invited.name,
      email: h.users.invited.email,
      serverAdmin: false,
      serverName: "Test <Server>",
    });
  });

  it("shows anyone the cards of many people at once, in the order asked, each once", async () => {
    const cards = await ivy.api("GET", `/api/v0/people/cards?ids=${adminId},no-such-person,${ivyId},,${adminId}`);
    expect(cards.status).toBe(200);
    expect(cards.body).toEqual({ people: [{ personId: adminId, displayName: "Ada Admin" }, { personId: ivyId, displayName: "Ivy Invited" }] });
    expect((await ivy.api("GET", "/api/v0/people/cards")).body).toEqual({ people: [] });
    for (const odd of ["__proto__", "constructor", "toString", "cromdb-server", "*"]) {
      expect((await ivy.api("GET", `/api/v0/people/cards?ids=${encodeURIComponent(odd)}`)).body, odd).toEqual({ people: [] });
    }
    const hundred = Array.from({ length: 100 }, (_, i) => `id-${i}`).join(",");
    expect((await ivy.api("GET", `/api/v0/people/cards?ids=${hundred}`)).status).toBe(200);
    // Repeats and empty ones don't count.
    expect((await ivy.api("GET", `/api/v0/people/cards?ids=${hundred},id-0,,`)).status).toBe(200);
    const tooMany = await ivy.api("GET", `/api/v0/people/cards?ids=${hundred},one-more`);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toEqual({ code: "INVALID_INPUT", message: "ids may name at most 100 people", details: { parameter: "ids" } });
  });

  it("shows anyone only the ID and display name of a person whose ID they hold", async () => {
    const card = await ivy.api("GET", `/api/v0/people/${adminId}`);
    expect(card.body).toEqual({ personId: adminId, displayName: "Ada Admin" });
    expect(card.headers.get("etag")).toBeNull();
    expect((await ivy.api("GET", "/api/v0/people/no-such-person")).status).toBe(404);
    expect((await ivy.api("GET", "/api/v0/people/__proto__")).status).toBe(404);
  });

  it("gives server admins a person in full, with a version", async () => {
    const details = await admin.api("GET", `/api/v0/people/${ivyId}/details`);
    expect(details.body).toMatchObject({ personId: ivyId, email: h.users.invited.email, status: "active", serverAdmin: false, invitedBy: adminId });
    expect(details.body.logins).toHaveLength(1);
    expect((await admin.api("GET", "/api/v0/people/nobody/details")).status).toBe(404);
  });

  it("lists people for server admins, in pages, searched by email or name, filtered by status", async () => {
    for (const email of ["zed@example.com", "bea@example.com", "cat@example.com"]) {
      await admin.api("POST", "/api/v0/invitations", { email });
    }
    const all = await admin.api("GET", "/api/v0/people");
    expect(all.body.people.map((p: { email: string }) => p.email)).toEqual(["admin@example.com", "bea@example.com", "cat@example.com", "ivy@example.com", "zed@example.com"]);
    expect(all.body.next).toBeNull();
    const pages: string[] = [];
    let after: string | null = null;
    do {
      const page: { body: { people: { email: string }[]; next: string | null } } = await admin.api("GET", `/api/v0/people?limit=2${after === null ? "" : `&after=${after}`}`);
      pages.push(page.body.people.map((p) => p.email).join(","));
      after = page.body.next;
    } while (after !== null);
    expect(pages).toEqual(["admin@example.com,bea@example.com", "cat@example.com,ivy@example.com", "zed@example.com"]);
    expect((await admin.api("GET", "/api/v0/people?q=IVY")).body.people.map((p: { personId: string }) => p.personId)).toEqual([ivyId]);
    expect((await admin.api("GET", "/api/v0/people?q=ada%20adm")).body.people.map((p: { personId: string }) => p.personId)).toEqual([adminId]);
    expect((await admin.api("GET", "/api/v0/people?status=invited")).body.people).toHaveLength(3);
    expect((await admin.api("GET", "/api/v0/people?status=disabled")).body.people).toEqual([]);
  });

  it("disables and enables people, ending their sessions; never the last active server admin", async () => {
    const disabled = await admin.api("POST", `/api/v0/people/${ivyId}/disable`, undefined, { "if-match": await etagOf(ivyId) });
    expect(disabled.body).toMatchObject({ status: "disabled", statusBy: adminId });
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(401);
    // Disabling again changes nothing.
    const again = await admin.api("POST", `/api/v0/people/${ivyId}/disable`, undefined, { "if-match": disabled.headers.get("etag") ?? "" });
    expect(again.headers.get("etag")).toBe(disabled.headers.get("etag"));
    const enabled = await admin.api("POST", `/api/v0/people/${ivyId}/enable`, undefined, { "if-match": disabled.headers.get("etag") ?? "" });
    expect(enabled.body.status).toBe("active");
    expect((await ivy.login(h, h.users.invited)).status).toBe(302);
    // Someone who never logged in goes back to invited.
    const sam = await admin.api("POST", "/api/v0/invitations", { email: h.users.uninvited.email });
    const off = await admin.api("POST", `/api/v0/people/${sam.body.personId}/disable`, undefined, { "if-match": sam.headers.get("etag") ?? "" });
    const on = await admin.api("POST", `/api/v0/people/${sam.body.personId}/enable`, undefined, { "if-match": off.headers.get("etag") ?? "" });
    expect(on.body.status).toBe("invited");

    const last = await admin.api("POST", `/api/v0/people/${adminId}/disable`, undefined, { "if-match": await etagOf(adminId) });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("LAST_ADMIN");
  });

  it("can't change someone who isn't there", async () => {
    for (const route of TABLE.filter((r) => r.pathParams !== undefined)) {
      const path = route.path.replace("{personId}", "nobody");
      const body = route.operationId === "setServerAdmin" ? { serverAdmin: true } : route.operationId === "restoreDatabase" ? { databaseId: "a-database" } : undefined;
      const response = await admin.api(route.method.toUpperCase(), path, body, route.ifMatch === true ? { "if-match": '"x"' } : {});
      expect(response.status, route.operationId).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("makes people server admins and back; never removes the last one", async () => {
    const granted = await admin.api("PUT", `/api/v0/people/${ivyId}/server-admin`, { serverAdmin: true }, { "if-match": await etagOf(ivyId) });
    expect(granted.body.serverAdmin).toBe(true);
    expect((await ivy.api("GET", "/api/v0/people")).status).toBe(200);
    // The version changed: the old one is refused.
    const stale = await admin.api("PUT", `/api/v0/people/${ivyId}/server-admin`, { serverAdmin: false }, { "if-match": `"${"x"}"` });
    expect(stale.status).toBe(412);
    const removed = await ivy.api("PUT", `/api/v0/people/${adminId}/server-admin`, { serverAdmin: false }, { "if-match": await etagOf(adminId) });
    expect(removed.body.serverAdmin).toBe(false);
    const last = await ivy.api("PUT", `/api/v0/people/${ivyId}/server-admin`, { serverAdmin: false }, { "if-match": await etagOfAs(ivy, ivyId) });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("LAST_ADMIN");
  });

  it("lets only one of two admins disabling each other at once succeed", async () => {
    await admin.api("PUT", `/api/v0/people/${ivyId}/server-admin`, { serverAdmin: true }, { "if-match": await etagOf(ivyId) });
    const ivyVersion = await etagOf(ivyId);
    const adminVersion = await etagOf(adminId);
    const [one, two] = await Promise.all([
      admin.api("POST", `/api/v0/people/${ivyId}/disable`, undefined, { "if-match": ivyVersion }),
      ivy.api("POST", `/api/v0/people/${adminId}/disable`, undefined, { "if-match": adminVersion }),
    ]);
    // Changes run one at a time: the second sees the first. It is refused as
    // the last admin, or (if its sender was disabled before it arrived) has
    // no session any more.
    const statuses = [one.status, two.status];
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409 || status === 401)).toHaveLength(1);
    const active = t.server.directory.index.all().filter((entry) => entry.person.status === "active" && entry.person.serverAdmin);
    expect(active).toHaveLength(1);
  });
});

const etagOfAs = async (browser: TestBrowser, personId: string) => (await browser.api("GET", `/api/v0/people/${personId}/details`)).headers.get("etag") ?? "";

describe("invitations", () => {
  it("invites by email, normalized, with a Location and a version", async () => {
    const response = await admin.api("POST", "/api/v0/invitations", { email: "  New.Person@Example.COM ", serverAdmin: true });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ email: "new.person@example.com", status: "invited", serverAdmin: true, invitedBy: adminId, logins: [] });
    expect(response.headers.get("location")).toBe(`/api/v0/people/${response.body.personId}/details`);
    const listed = await admin.api("GET", "/api/v0/invitations");
    expect(listed.body.people.map((p: { personId: string }) => p.personId)).toEqual([response.body.personId]);
  });

  it("refuses a bad email, and an email someone already has", async () => {
    const bad = await admin.api("POST", "/api/v0/invitations", { email: "not an email" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual({ path: "/email" });
    for (const email of [h.users.invited.email, "ADMIN@example.com"]) {
      const taken = await admin.api("POST", "/api/v0/invitations", { email });
      expect(taken.status).toBe(409);
      expect(taken.body.error.code).toBe("PERSON_EXISTS");
    }
    const first = await admin.api("POST", "/api/v0/invitations", { email: "twice@example.com" });
    const twice = await admin.api("POST", "/api/v0/invitations", { email: "twice@example.com" });
    expect(twice.body.error.details).toEqual({ personId: first.body.personId });
    // A revoked invitation never used doesn't count.
    await admin.api("DELETE", `/api/v0/invitations/${first.body.personId}`, undefined, { "if-match": first.headers.get("etag") ?? "" });
    expect((await admin.api("POST", "/api/v0/invitations", { email: "twice@example.com" })).status).toBe(201);
  });

  it("revokes only invitations", async () => {
    const invited = await admin.api("POST", "/api/v0/invitations", { email: "rev@example.com" });
    const revoked = await admin.api("DELETE", `/api/v0/invitations/${invited.body.personId}`, undefined, { "if-match": invited.headers.get("etag") ?? "" });
    expect(revoked.body).toMatchObject({ status: "disabled", statusBy: adminId });
    const notInvited = await admin.api("DELETE", `/api/v0/invitations/${ivyId}`, undefined, { "if-match": await etagOf(ivyId) });
    expect(notInvited.status).toBe(409);
    expect(notInvited.body.error.code).toBe("NOT_INVITED");
    expect((await admin.api("DELETE", "/api/v0/invitations/nobody", undefined, { "if-match": '"x"' })).status).toBe(404);
  });
});

describe("sessions", () => {
  it("end after the idle time with no request", async () => {
    t.clockMs = 11 * 3_600_000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(200);
    t.clockMs += 11 * 3_600_000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(200);
    t.clockMs += 12 * 3_600_000 + 1000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(401);
  });

  it("end after 7 days however much they are used", async () => {
    for (let hours = 10; hours < 7 * 24; hours += 10) {
      t.clockMs = hours * 3_600_000;
      expect((await ivy.api("GET", "/api/v0/me")).status, `${hours} hours`).toBe(200);
    }
    t.clockMs = 7 * 24 * 3_600_000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(401);
  });

  it("survive a restart, with the time they were last used", async () => {
    t.clockMs = 11 * 3_600_000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(200);
    await t.restart();
    const again = t.browser();
    again.setCookie("cromdb-session", ivy.cookie("cromdb-session") ?? "");
    t.clockMs = 22 * 3_600_000;
    // Used at 11 hours, so still live at 22: lastSeenAt was written at shutdown.
    expect((await again.api("GET", "/api/v0/me")).status).toBe(200);
    expect(t.server.sessions.size).toBe(2);
  });
});

describe("the server's settings, restart and status", () => {
  const LEVEL_2_FIXTURE = fileURLToPath(new URL("../../engine/test/fixtures/0.5.0/seeds/alice.cromdb", import.meta.url));
  const save = async (change: Record<string, unknown>, version?: string) => {
    const read = await settingsRead();
    return admin.api("PUT", "/api/v0/server/settings", { ...read.body.saved, ...change }, { "if-match": version ?? read.headers.get("etag") ?? "" });
  };
  const reconnect = (browser: TestBrowser) => {
    const again = t.browser();
    again.setCookie("cromdb-session", browser.cookie("cromdb-session") ?? "");
    return again;
  };

  it("are read as saved and as running, without the client secret", async () => {
    const read = await settingsRead();
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toMatch(/^"[^"]+"$/);
    expect(read.body.saved).toEqual(read.body.running);
    expect(read.body.saved).toMatchObject({ serverName: "Test <Server>", publicUrl: "http://localhost:8080", tls: null, trustProxy: false, maintenanceTimeZone: null });
    expect(read.body.restartKeys).toEqual(["publicUrl", "listen", "tls", "trustProxy", "oidcIssuer", "oidcClientId"]);
    expect(read.body).toMatchObject({ clientSecretSet: true, clientSecretWaiting: false, listenFixed: null, certificate: null, canRestart: false, lastMaintenance: null });
    expect(JSON.stringify(read.body)).not.toContain(h.client.secret);
  });

  it("take the live ones at once: the name, the session lengths and the maintenance schedule", async () => {
    const saved = await save({ serverName: "Renamed", sessionIdleMinutes: 5, maintenanceHour: 4, maintenanceTimeZone: "Europe/Paris", serverDbPurgeAfterDays: 20 });
    expect(saved.status).toBe(200);
    expect(saved.body.running).toEqual(saved.body.saved);
    expect((await admin.api("GET", "/api/v0/me")).body.serverName).toBe("Renamed");
    expect(t.server.maintenance.hour).toBe(4);
    expect(t.server.maintenance.zone).toBe("Europe/Paris");
    expect(t.logs).toContain(`Settings changed by ${adminId}: serverName (now), sessionIdleMinutes (now), serverDbPurgeAfterDays (now), maintenanceHour (now), maintenanceTimeZone (now)`);
    // Idle for 6 minutes: past the new limit.
    t.clockMs = 6 * 60_000;
    expect((await ivy.api("GET", "/api/v0/me")).status).toBe(401);
  });

  it("keep the restart ones saved but not in effect until the server starts again", async () => {
    const saved = await save({ oidcClientId: "another-client", trustProxy: true });
    expect(saved.status).toBe(200);
    expect(saved.body.saved).toMatchObject({ oidcClientId: "another-client", trustProxy: true });
    expect(saved.body.running).toMatchObject({ oidcClientId: h.client.clientId, trustProxy: false });
    await t.restart();
    admin = reconnect(admin);
    expect((await settingsRead()).body.running).toMatchObject({ oidcClientId: "another-client", trustProxy: true });
  });

  it("are refused when they changed since they were read", async () => {
    const before = (await settingsRead()).headers.get("etag") ?? "";
    expect((await save({ serverName: "First" })).status).toBe(200);
    const late = await save({ serverName: "Second" }, before);
    expect(late.status).toBe(412);
    expect(late.body.error.code).toBe("STALE_VERSION");
  });

  it("are checked as config set checks them, each at its path", async () => {
    for (const [change, path] of [
      [{ serverName: " " }, "/serverName"],
      [{ publicUrl: "ftp://example.com" }, "/publicUrl"],
      [{ listen: "nowhere" }, "/listen"],
      [{ sessionIdleMinutes: 1 }, "/sessionIdleMinutes"],
      [{ sessionMaxDays: 0 }, "/sessionMaxDays"],
      [{ serverDbPurgeAfterDays: 4000 }, "/serverDbPurgeAfterDays"],
      [{ maintenanceHour: 24 }, "/maintenanceHour"],
      [{ maintenanceTimeZone: "Mars/Base" }, "/maintenanceTimeZone"],
      [{ oidcClientId: " " }, "/oidcClientId"],
      [{ tls: { certFile: "relative.pem", keyFile: "/key.pem" } }, "/tls/certFile"],
      [{ tls: { certFile: "/no/such/cert.pem", keyFile: "/no/such/key.pem" } }, "/tls"],
    ] as const) {
      const response = await save(change);
      expect(response.status, JSON.stringify(change)).toBe(400);
      expect(response.body.error.code).toBe("INVALID_INPUT");
      expect(response.body.error.details.path, JSON.stringify(change)).toBe(path);
    }
  });

  it("serve HTTPS only with an https public address, and check the files", async () => {
    const dir = tempDir();
    try {
      const pair = selfSigned();
      writeFileSync(dir.join("cert.pem"), pair.cert);
      writeFileSync(dir.join("key.pem"), pair.key);
      const tls = { certFile: dir.join("cert.pem"), keyFile: dir.join("key.pem") };
      const plain = await save({ tls });
      expect(plain.status).toBe(400);
      expect(plain.body.error.details.path).toBe("/publicUrl");
      const secure = await save({ tls, publicUrl: "https://localhost:8443" });
      expect(secure.status).toBe(200);
      expect(secure.body.saved.tls).toEqual(tls);
      expect(secure.body.running.tls).toBeNull();
      expect(secure.body.certificate).toBeNull();
    } finally {
      dir.remove();
    }
  });

  it("ask before a plain http address that leaves this machine", async () => {
    const refused = await save({ publicUrl: "http://cromdb.example.com" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual({ path: "/publicUrl", reason: "plainHttp" });
    const allowed = await save({ publicUrl: "http://cromdb.example.com", allowPlainHttp: true });
    expect(allowed.status).toBe(200);
    // Saved already: saving it again asks nothing.
    expect((await save({ serverName: "Again" })).status).toBe(200);
  });

  it("check a new issuer against its discovery document before saving it", async () => {
    const wrong = await save({ oidcIssuer: `${h.issuer}/` });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.path).toBe("/oidcIssuer");
    expect(wrong.body.error.message).toMatch(/^The issuer was not saved: The provider's issuer is/);
    t.offline = true;
    const unreachable = await save({ oidcIssuer: "https://login.example.com/realms/other" });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.error.details.path).toBe("/oidcIssuer");
    // An unchanged issuer isn't fetched again.
    expect((await save({ serverName: "Offline" })).status).toBe(200);
  });

  it("replace the client secret, which is never shown", async () => {
    const response = await admin.api("PUT", "/api/v0/server/client-secret", { secret: "the-new-secret" });
    expect(response.status).toBe(204);
    expect(t.server.serverDb.secret("oidcClientSecret")).toBe("the-new-secret");
    expect(JSON.stringify((await settingsRead()).body)).not.toContain("the-new-secret");
    expect(t.logs.join("\n")).not.toContain("the-new-secret");
    const blank = await admin.api("PUT", "/api/v0/server/client-secret", { secret: "  " });
    expect(blank.status).toBe(400);
  });

  it("count a replaced client secret as waiting for a restart, until the next start", async () => {
    expect((await settingsRead()).body.clientSecretWaiting).toBe(false);
    expect((await admin.api("PUT", "/api/v0/server/client-secret", { secret: "the-new-secret" })).status).toBe(204);
    expect((await settingsRead()).body.clientSecretWaiting).toBe(true);
    await t.restart();
    admin = reconnect(admin);
    expect((await settingsRead()).body.clientSecretWaiting).toBe(false);
  });

  it("say when the listen address was given at the start, so the setting isn't used", async () => {
    await t.close();
    t = await startTestServer(h, { listen: "127.0.0.1:0" });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const read = await settingsRead();
    expect(read.body.listenFixed).toBe("127.0.0.1:0");
    expect(read.body.running.listen).toBe("127.0.0.1:0");
  });

  it("say on the status whether a newer version is published, once the update check is on", async () => {
    await t.close();
    t = await startTestServer(h, { updateSource: async () => ["server-v0.1.0", "server-v99.0.0", "server-v100.0.0-rc1", "v101.0.0"] });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const status = () => admin.api("GET", "/api/v0/server/status");
    expect((await status()).body.update).toEqual({ state: "off", checkedAt: null, latest: null, changesUrl: null });
    expect((await settingsRead()).body.saved.updateCheck).toBe(false);
    const on = await save({ updateCheck: true });
    expect(on.status).toBe(200);
    expect(on.body.running.updateCheck).toBe(true);
    expect(t.logs.some((line) => line.endsWith(": updateCheck (now)"))).toBe(true);
    expect((await status()).body.update.state).toBe("pending");
    await t.server.admin.updates.checkNow();
    expect((await status()).body.update).toEqual({
      state: "available",
      checkedAt: expect.any(String),
      latest: "99.0.0",
      changesUrl: "https://github.com/skaife/cromdb/blob/server-v99.0.0/packages/server/CHANGELOG.md",
    });
    expect((await save({ updateCheck: false })).status).toBe(200);
    expect((await status()).body.update.state).toBe("off");
  });

  it("restart only when something starts the server again", async () => {
    const refused = await admin.api("POST", "/api/v0/server/restart");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_SUPERVISED");
    await t.close();
    let asked = 0;
    t = await startTestServer(h, { onRestart: () => (asked += 1) });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    expect((await settingsRead()).body.canRestart).toBe(true);
    const accepted = await admin.api("POST", "/api/v0/server/restart");
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ restarting: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asked).toBe(1);
  });

  it("back up now and list the sets, when there is a backups folder", async () => {
    const off = await admin.api("POST", "/api/v0/server/backups");
    expect([off.status, off.body.error.code]).toEqual([409, "BACKUPS_OFF"]);
    expect((await admin.api("GET", "/api/v0/server/backups")).body).toMatchObject({ enabled: false, sets: [] });
    await t.close();
    t = await startTestServer(h, { backups: true });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const started = await admin.api("POST", "/api/v0/server/backups");
    expect(started.status).toBe(202);
    await t.server.backups.settled();
    const listed = await admin.api("GET", "/api/v0/server/backups");
    expect(listed.status).toBe(200);
    expect(listed.body.sets.map((set: { name: string }) => set.name)).toEqual([started.body.name]);
    await t.close();
    t = await startTestServer(h, { backups: true, fileSystemSpace: () => ({ totalBytes: 1_000_000, freeBytes: 0 }) });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const full = await admin.api("POST", "/api/v0/server/backups");
    expect([full.status, full.body.error.code]).toEqual([507, "BACKUP_NO_SPACE"]);

    // A set to read and restore from, made on a server with room.
    await t.close();
    t = await startTestServer(h, { backups: true });
    admin = t.browser();
    expect((await admin.login(h, h.users.admin)).status).toBe(302);
    const databaseId = (await admin.api("POST", "/api/v0/databases", { name: "Kept" })).body.databaseId as string;
    const set = (await admin.api("POST", "/api/v0/server/backups")).body.name as string;
    await t.server.backups.settled();
    expect((await admin.api("GET", `/api/v0/server/backups/${set}`)).status).toBe(200);
    expect((await admin.api("POST", `/api/v0/server/backups/${set}/restore`, { databaseId })).status).toBe(200);
    expect((await admin.api("POST", `/api/v0/server/backups/${set}/restore`, { databaseId: "elsewhere" })).status).toBe(404);
    const folder = join(t.backupsDir, set, "databases");
    const file = join(folder, readdirSync(folder)[0] ?? "");
    writeFileSync(file, Buffer.alloc(16));
    expect((await admin.api("POST", `/api/v0/server/backups/${set}/restore`, { databaseId })).status).toBe(409);
  });

  it("show the versions, the databases and the last maintenance", async () => {
    const before = (await admin.api("GET", "/api/v0/server/status")).body;
    expect(before).toMatchObject({ serverName: "Test <Server>", publicUrl: "http://localhost:8080", databases: { available: 0, unavailable: [] } });
    expect(before.versions).toEqual({ server: expect.stringMatching(/^\d+\.\d+\.\d+/), driver: expect.any(String), engine: expect.any(String) });
    expect(before.maintenance).toMatchObject({ lastRunAt: null, hour: 3, databases: [] });
    expect((await admin.api("POST", "/api/v0/databases", { name: "Notes" })).status).toBe(201);
    const paths = dataPaths(t.dataDir);
    await t.restart(async () => {
      copyFileSync(LEVEL_2_FIXTURE, join(paths.databases, "old.cromdb"));
      const driver = createLevel4Driver();
      const serverDb = await ServerDb.open(driver, paths.serverDb);
      await serverDb.addDatabase({ databaseId: "level-2-db", name: "Old", file: "old.cromdb", createdAt: new Date().toISOString(), createdBy: adminId, home: serverDb.identity.serverId });
      await serverDb.close();
      await driver.shutdown();
    });
    admin = reconnect(admin);
    await t.server.maintenance.runNow();
    const after = (await admin.api("GET", "/api/v0/server/status")).body;
    expect(after.databases.available).toBe(1);
    expect(after.databases.unavailable).toEqual([{ databaseId: "level-2-db", name: "Old", reason: expect.stringContaining("level 2"), since: after.startedAt }]);
    expect(after.maintenance.lastRunAt).toEqual(expect.any(String));
    expect(Date.parse(after.maintenance.nextDueAt)).toBeGreaterThan(Date.parse(after.maintenance.lastRunAt));
    expect(after.maintenance.databases.map((entry: { what: string }) => entry.what)).toEqual(["the server database", "the directory", 'database "Notes"']);
    expect(after.maintenance.databases.every((entry: { ok: boolean; tombstones: number }) => entry.ok && typeof entry.tombstones === "number")).toBe(true);
    expect((await settingsRead()).body.lastMaintenance).toEqual({ at: after.maintenance.lastRunAt, ok: true });
  });
});

afterAll(() => {
  expect(missingCoverage(apiRoutes, ONLY_ON_FAULTS)).toEqual([]);
});
