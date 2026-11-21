// The login scenarios: one suite, written against LoginHarness only, so it
// runs against the fake provider here and against real Keycloak later.
// Each refusal must end on a refusal page with no session, no change to any
// person, and the reason in the server log.

import { createHash, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "../src/auth/id-token.js";
import { PUBLIC_URL, startTestServer, type LoginHarness, type TestBrowser, type TestClient, type TestServer, type TestUser } from "./harness.js";

/** How long the provider's ID tokens last, in seconds (Keycloak's default). */
const ID_TOKEN_SECONDS = 300;

export function loginScenarios(makeHarness: () => Promise<LoginHarness>): void {
  let h: LoginHarness;
  let t: TestServer;

  beforeEach(async () => {
    h = await makeHarness();
    t = await startTestServer(h);
  });
  afterEach(async () => {
    await t.close();
    await h.close();
  });

  /** Everyone in the directory with their versions, and how many sessions there are. */
  const people = () =>
    JSON.stringify({
      people: t.server.directory.index
        .all()
        .map((entry) => [entry.person, entry.version])
        .sort(),
      sessions: t.server.sessions.size,
    });
  const SESSION = "cromdb-session";
  const person = (email: string) => t.server.directory.index.byEmail(email)[0]?.person;

  async function admin(): Promise<TestBrowser> {
    const browser = t.browser();
    expect((await browser.login(h, h.users.admin)).status).toBe(302);
    return browser;
  }

  async function invite(email: string): Promise<void> {
    const response = await (await admin()).api("POST", "/api/v0/invitations", { email });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  /** A refused login: the page, the status, no session, nothing written, the reason logged. */
  function expectRefused(response: Response & { text: string }, browser: TestBrowser, status: number, page: RegExp, reason: RegExp, before: string) {
    expect(response.status, response.text).toBe(status);
    expect(response.text).toMatch(page);
    expect(browser.cookie(SESSION)).toBeUndefined();
    expect(people()).toBe(before);
    expect(t.logs.filter((line) => line.startsWith("Login refused")).join("\n")).toMatch(reason);
  }

  /**
   * An ID token for this client from somewhere it shouldn't come from:
   * another issuer, or this issuer for another client. Got by a real login
   * there, with this login's nonce.
   */
  async function idTokenFrom(issuer: string, client: TestClient, user: TestUser, nonce: string): Promise<string> {
    const discovery = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as Record<string, string>;
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(discovery["authorization_endpoint"] ?? "");
    authorize.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: `${PUBLIC_URL}/auth/callback`,
      response_type: "code",
      scope: "openid email profile",
      state: "x",
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const code = new URL(await h.authorize(authorize.href, user)).searchParams.get("code") ?? "";
    const response = await fetch(discovery["token_endpoint"] ?? "", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${PUBLIC_URL}/auth/callback`,
        code_verifier: verifier,
        client_id: client.clientId,
        client_secret: client.secret,
      }).toString(),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body["id_token"] !== "string") throw new Error(`No ID token from ${issuer}: ${JSON.stringify(body)}`);
    return body["id_token"];
  }

  /**
   * Logs the admin in, but the ID token the server gets from the token
   * endpoint is replaced by make(nonce of this login, the real ID token).
   */
  async function withIdToken(make: (nonce: string, original: string) => Promise<string>) {
    const browser = t.browser();
    const authorize = await browser.startLogin();
    const nonce = new URL(authorize).searchParams.get("nonce") ?? "";
    const callback = await h.authorize(authorize, h.users.admin);
    const before = people();
    t.tokens.tamper = async (body) => ({ ...body, id_token: await make(nonce, String(body["id_token"])) });
    const response = await browser.request(callback);
    t.tokens.tamper = undefined;
    return { response, browser, before };
  }

  describe(`admission`, () => {
    it("admits the invited admin, sets a session, and returns where the login started", async () => {
      const browser = t.browser();
      const response = await browser.login(h, h.users.admin, "/somewhere?x=1");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/somewhere?x=1");
      expect(browser.cookie(SESSION)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(browser.cookie("cromdb-login")).toBeUndefined();
      const cookies = response.headers.getSetCookie().join("\n");
      expect(cookies).toMatch(/cromdb-session=[^;]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax$/m);
      expect(cookies).toMatch(/cromdb-login=; Path=\/auth; Max-Age=0; HttpOnly; SameSite=Lax$/m);
      const me = await browser.api("GET", "/api/v0/me");
      expect(me.body).toEqual({ personId: expect.any(String), displayName: "Ada Admin", email: "admin@example.com", serverAdmin: true, serverName: "Test <Server>" });
      const admitted = person(h.users.admin.email);
      expect(admitted?.status).toBe("active");
      expect(admitted?.logins).toEqual([{ issuer: h.issuer, subject: expect.any(String), addedAt: expect.any(String) }]);
      expect(t.logs.join("\n")).toContain(`Login: person ${admitted?.personId} (admitted from an invitation)`);
    });

    it("uses the same person on the next login and writes nothing to them", async () => {
      await admin();
      const before = JSON.parse(people()).people;
      const browser = t.browser();
      expect((await browser.login(h, h.users.admin)).status).toBe(302);
      expect(JSON.parse(people()).people).toEqual(before);
      expect(t.server.sessions.size).toBe(2);
    });

    it("admits a person invited through the API, named by the provider", async () => {
      await invite(h.users.invited.email);
      const browser = t.browser();
      expect((await browser.login(h, h.users.invited)).status).toBe(302);
      const me = await browser.api("GET", "/api/v0/me");
      expect(me.body).toMatchObject({ email: h.users.invited.email.toLowerCase(), serverAdmin: false, displayName: h.users.invited.name });
    });

    it("admits one person once when they finish two logins at the same time", async () => {
      const [one, two] = [t.browser(), t.browser()];
      const callbacks = [await h.authorize(await one.startLogin(), h.users.admin), await h.authorize(await two.startLogin(), h.users.admin)];
      const responses = await Promise.all([one.request(callbacks[0] ?? ""), two.request(callbacks[1] ?? "")]);
      expect(responses.map((r) => r.status)).toEqual([302, 302]);
      expect(t.server.directory.index.all()).toHaveLength(1);
      expect(person(h.users.admin.email)?.logins).toHaveLength(1);
      expect(t.server.sessions.size).toBe(2);
    });

    it("refuses an email the provider hasn't verified, and leaves the invitation alone", async () => {
      await invite(h.users.unverified.email);
      const before = people();
      const browser = t.browser();
      expectRefused(await browser.login(h, h.users.unverified), browser, 403, /not verified/, /\(unverified\): .*email_verified/, before);
      expect(person(h.users.unverified.email)?.status).toBe("invited");
    });

    it("refuses someone not invited, writing nothing", async () => {
      await admin();
      const before = people();
      const browser = t.browser();
      expectRefused(await browser.login(h, h.users.uninvited), browser, 403, /not been invited/, /\(not-invited\)/, before);
    });

    it("refuses a second account with an admitted person's email", async () => {
      await invite(h.users.invited.email);
      expect((await t.browser().login(h, h.users.invited)).status).toBe(302);
      const before = people();
      const browser = t.browser();
      const response = await browser.login(h, h.users.secondAccount);
      expectRefused(response, browser, 403, /not been invited/, /\(not-invited\)/, before);
    });

    it("refuses a disabled person; disabling ends their sessions", async () => {
      const adminBrowser = await admin();
      await adminBrowser.api("POST", "/api/v0/invitations", { email: h.users.invited.email });
      const ivy = t.browser();
      expect((await ivy.login(h, h.users.invited)).status).toBe(302);
      expect((await ivy.api("GET", "/api/v0/me")).status).toBe(200);
      const id = person(h.users.invited.email)?.personId ?? "";
      const details = await adminBrowser.api("GET", `/api/v0/people/${id}/details`);
      const disabled = await adminBrowser.api("POST", `/api/v0/people/${id}/disable`, undefined, { "if-match": details.headers.get("etag") ?? "" });
      expect(disabled.status).toBe(200);
      expect((await ivy.api("GET", "/api/v0/me")).status).toBe(401);
      const before = people();
      const again = t.browser();
      expectRefused(await again.login(h, h.users.invited), again, 403, /disabled/, /\(disabled\)/, before);
    });

    it("admits no one on a revoked invitation", async () => {
      const adminBrowser = await admin();
      const invited = await adminBrowser.api("POST", "/api/v0/invitations", { email: h.users.uninvited.email });
      const revoked = await adminBrowser.api("DELETE", `/api/v0/invitations/${invited.body.personId}`, undefined, { "if-match": invited.headers.get("etag") ?? "" });
      expect(revoked.body.status).toBe("disabled");
      const before = people();
      const browser = t.browser();
      expectRefused(await browser.login(h, h.users.uninvited), browser, 403, /not been invited/, /\(not-invited\)/, before);
    });

    it("admits no one while two invitations have the same email", async () => {
      await admin();
      // Two servers inviting at once (later releases); here, written directly.
      for (let i = 0; i < 2; i++) {
        await t.server.directory.invite({ email: h.users.uninvited.email, serverAdmin: false, by: "test", now: new Date() });
      }
      const before = people();
      const browser = t.browser();
      expectRefused(await browser.login(h, h.users.uninvited), browser, 403, /more than one invitation/, /\(ambiguous\)/, before);
    });
  });

  describe("the login itself", () => {
    it("refuses a changed state", async () => {
      const browser = t.browser();
      const callback = new URL(await h.authorize(await browser.startLogin(), h.users.admin));
      callback.searchParams.set("state", "changed");
      const before = people();
      expectRefused(await browser.request(callback.href), browser, 400, /expired or was not valid/, /state is not this login's/, before);
    });

    it("refuses a callback without the login cookie", async () => {
      const browser = t.browser();
      const callback = await h.authorize(await browser.startLogin(), h.users.admin);
      browser.clearCookies();
      const before = people();
      expectRefused(await browser.request(callback), browser, 400, /expired or was not valid/, /no login cookie/, before);
    });

    it("takes a login cookie once", async () => {
      const browser = t.browser();
      const authorize = await browser.startLogin();
      const loginCookie = browser.cookie("cromdb-login") ?? "";
      const callback = await h.authorize(authorize, h.users.admin);
      expect((await browser.request(callback)).status).toBe(302);
      const replay = t.browser();
      replay.setCookie("cromdb-login", loginCookie, "/auth");
      const before = people();
      expectRefused(await replay.request(callback), replay, 400, /expired or was not valid/, /no login in progress/, before);
    });

    it("refuses a code used before (the provider refuses it)", async () => {
      const browser = t.browser();
      const first = new URL(await h.authorize(await browser.startLogin(), h.users.admin));
      expect((await browser.request(first.href)).status).toBe(302);
      const other = t.browser();
      const second = new URL(await h.authorize(await other.startLogin(), h.users.admin));
      second.searchParams.set("code", first.searchParams.get("code") ?? "");
      const before = people();
      expectRefused(await other.request(second.href), other, 400, /expired or was not valid/, /the provider refused the code: invalid_grant/, before);
    });

    it("refuses a login older than 10 minutes", async () => {
      const browser = t.browser();
      const callback = await h.authorize(await browser.startLogin(), h.users.admin);
      t.clockMs = 10 * 60_000 + 1000;
      const before = people();
      expectRefused(await browser.request(callback), browser, 400, /expired or was not valid/, /no login in progress/, before);
    });

    it("never sends the browser to another site after login", async () => {
      for (const returnTo of ["//evil.example", "/\\evil.example", "https://evil.example/", "/\t/evil.example", "javascript:alert(1)", ""]) {
        const browser = t.browser();
        const response = await browser.login(h, h.users.admin, returnTo);
        expect(response.status, returnTo).toBe(302);
        expect(response.headers.get("location"), returnTo).toBe("/");
      }
    });

    it("sends the provider PKCE (S256), state, nonce, the redirect URI from the public URL, and the scopes", async () => {
      const browser = t.browser();
      const authorize = new URL(await browser.startLogin());
      const params = Object.fromEntries(authorize.searchParams);
      expect(params).toMatchObject({
        client_id: h.client.clientId,
        redirect_uri: `${PUBLIC_URL}/auth/callback`,
        response_type: "code",
        scope: "openid email profile",
        code_challenge_method: "S256",
      });
      expect(params["state"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(params["nonce"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(params["code_challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const cookie = browser.cookie("cromdb-login");
      expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect([params["state"], params["nonce"]]).not.toContain(cookie);
    });
  });

  describe("the ID token", () => {
    const invalid = async (make: (nonce: string, original: string) => Promise<string>, reason: RegExp) => {
      const { response, browser, before } = await withIdToken(make);
      expectRefused(response, browser, 400, /expired or was not valid/, reason, before);
    };

    it("refuses a token issued to another client", async () => {
      await invalid((nonce) => idTokenFrom(h.issuer, h.otherClient, h.users.admin, nonce), /aud|audience|azp/);
    });

    it("refuses a token from another issuer", async () => {
      await invalid((nonce) => idTokenFrom(h.otherIssuer, h.client, h.users.admin, nonce), /iss|issuer|signature|key/i);
    });

    it("refuses a token whose signature was changed", async () => {
      await invalid(async (_nonce, original) => {
        const [header, payload, signature = ""] = original.split(".");
        const bytes = Buffer.from(signature, "base64url");
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        return `${header}.${payload}.${bytes.toString("base64url")}`;
      }, /signature/i);
    });

    it("refuses an earlier login's token (nonce)", async () => {
      await admin();
      const earlier = String(t.tokens.responses.at(-1)?.["id_token"]);
      await invalid(async () => earlier, /nonce/);
    });

    it("refuses an expired token", async () => {
      await invalid(async (_nonce, original) => {
        t.clockMs = (ID_TOKEN_SECONDS + 61) * 1000;
        return original;
      }, /exp/);
    });

    it("refuses an unsigned token (alg none)", async () => {
      await invalid(async (_nonce, original) => {
        const [, payload] = original.split(".");
        return `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
      }, /alg/);
    });

    it("refuses a token signed with the client secret (HS256)", async () => {
      await invalid(async (_nonce, original) => {
        const claims = decodeJwt(original)?.claims ?? {};
        return new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(new TextEncoder().encode(h.client.secret));
      }, /alg/);
    });

    describe("claims a provider can be made to sign (fake provider only)", () => {
      const signed = (change: (claims: Record<string, unknown>) => Record<string, unknown>) => async (_nonce: string, original: string) => {
        if (h.sign === undefined) throw new Error("unreachable");
        return h.sign(change(decodeJwt(original)?.claims ?? {}));
      };
      const maybe = (name: string, fn: () => Promise<void>) =>
        it(name, async (context) => {
          if (h.sign === undefined) context.skip();
          await fn();
        });

      maybe("refuses two audiences without azp", () => invalid(signed(({ azp: _, ...c }) => ({ ...c, aud: [h.client.clientId, "someone-else"] })), /aud/));
      maybe("refuses azp naming another client", () => invalid(signed((c) => ({ ...c, aud: [h.client.clientId, h.otherClient.clientId], azp: h.otherClient.clientId })), /azp/));
      maybe("refuses a token issued in the future", () => invalid(signed((c) => ({ ...c, iat: Math.floor(Date.now() / 1000) + 3600 })), /iat/));
      maybe("refuses a token with no email", () => invalid(signed(({ email: _, ...c }) => c), /no email/));
      maybe("refuses a token whose issuer differs from the configured one", () => invalid(signed((c) => ({ ...c, iss: h.otherIssuer })), /iss/));
      maybe("refuses email_verified sent as text", async () => {
        const { response, browser, before } = await withIdToken(signed((c) => ({ ...c, email_verified: "true" })));
        expectRefused(response, browser, 403, /not verified/, /email_verified/, before);
      });
    });
  });

  describe("logout and the provider", () => {
    it("ends the session here, then sends the browser to the provider's logout", async () => {
      const browser = await admin();
      expect(t.server.sessions.size).toBe(1);
      const response = await browser.request("/auth/logout", { method: "POST" });
      expect(response.status).toBe(303);
      const target = new URL(response.headers.get("location") ?? "");
      expect(target.searchParams.get("client_id")).toBe(h.client.clientId);
      expect(target.searchParams.get("post_logout_redirect_uri")).toBe(`${PUBLIC_URL}/`);
      expect(target.searchParams.has("id_token_hint")).toBe(false);
      expect(browser.cookie("cromdb-session")).toBeUndefined();
      expect(t.server.sessions.size).toBe(0);
      expect((await browser.api("GET", "/api/v0/me")).status).toBe(401);
    });

    it("says so when the provider can't be reached, and recovers", async () => {
      t.offline = true;
      const browser = t.browser();
      const response = await browser.request("/auth/login");
      expect(response.status).toBe(502);
      expect(response.text).toContain("can&#39;t be reached");
      expect(browser.cookie("cromdb-login")).toBeUndefined();
      t.offline = false;
      expect((await browser.login(h, h.users.admin)).status).toBe(302);
    });

    it("says so when the provider can't be reached for the code, and writes nothing", async () => {
      const browser = t.browser();
      const callback = await h.authorize(await browser.startLogin(), h.users.admin);
      t.offline = true;
      const before = people();
      expectRefused(await browser.request(callback), browser, 502, /can&#39;t be reached/, /\(unavailable\): TypeError: fetch failed/, before);
      t.offline = false;
      expect((await browser.login(h, h.users.admin)).status).toBe(302);
    });

    it("logs no cookie, token, code, state, nonce or callback query string", async () => {
      const secrets: string[] = [h.client.secret];
      const browser = t.browser();
      const authorize = new URL(await browser.startLogin("/after?q=1"));
      secrets.push(...["state", "nonce", "code_challenge"].map((p) => authorize.searchParams.get(p) ?? ""), browser.cookie("cromdb-login") ?? "");
      const callback = new URL(await h.authorize(authorize.href, h.users.admin));
      secrets.push(callback.search, callback.search.slice(1), ...[...callback.searchParams.values()]);
      await browser.request(callback.href);
      secrets.push(browser.cookie("cromdb-session") ?? "");
      // A refused one, and a tampered one.
      const stranger = t.browser();
      await stranger.login(h, h.users.uninvited);
      const { browser: tampered } = await withIdToken(async (_n, original) => `${original}x`);
      void tampered;
      await browser.request("/auth/logout", { method: "POST" });
      for (const response of t.tokens.responses) {
        for (const key of ["access_token", "refresh_token", "id_token", "session_state"]) {
          if (typeof response[key] === "string") secrets.push(response[key]);
        }
        const idToken = response["id_token"];
        if (typeof idToken === "string") secrets.push(...idToken.split("."));
      }
      const logs = t.logs.join("\n");
      expect(logs.length).toBeGreaterThan(0);
      for (const secret of secrets.filter((s) => s.length >= 8)) {
        expect(logs.includes(secret), `the log holds ${secret.slice(0, 12)}...`).toBe(false);
      }
      expect(logs).toContain("GET /auth/callback 302");
      expect(logs).not.toMatch(/callback\?/);
    });
  });
}
