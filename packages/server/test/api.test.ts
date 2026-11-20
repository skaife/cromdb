// The API under /api/v0 for the server, people and invitations, through the
// test browser, so every response is checked against the route table. First
// the refusals every route shares, driven by the table itself; then each
// route; then sessions. Last, every documented response of these routes must
// have been produced. Databases and documents are in databases.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

/** A request to a route that passes every check before the one a test is about. */
async function call(
  browser: TestBrowser,
  route: Route,
  options: { headers?: Record<string, string>; body?: string; origin?: string | null; personId?: string; noIfMatch?: boolean } = {},
) {
  const path = route.path.replace("{personId}", options.personId ?? ivyId);
  const example = route.operationId === "invite" ? { email: "new@example.com" } : route.operationId === "setServerAdmin" ? { serverAdmin: true } : undefined;
  const headers: Record<string, string> = { ...(example === undefined ? {} : { "content-type": "application/json" }) };
  if (route.ifMatch === true && options.noIfMatch !== true) headers["if-match"] = await etagOf(options.personId ?? ivyId);
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
        ['{"extra":1,"email":"a@b.example","serverAdmin":true}', "/extra"],
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
    expect((await ivy.api("GET", "/api/v0/me")).body).toEqual({ personId: ivyId, displayName: h.users.invited.name, email: h.users.invited.email, serverAdmin: false });
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
      const body = route.operationId === "setServerAdmin" ? { serverAdmin: true } : undefined;
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

afterAll(() => {
  expect(missingCoverage(apiRoutes, ONLY_ON_FAULTS)).toEqual([]);
});
