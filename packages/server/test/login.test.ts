// Login against the fake provider: the scenario suite, then what only the
// fake can show (an ES256 provider) and an https public URL's cookies.
// Last, every documented response of the browser routes must have been seen.

import { afterAll, describe, expect, it } from "vitest";
import { ROUTES } from "../src/http/routes.js";
import { fakeHarness, missingCoverage, ONLY_ON_FAULTS, startTestServer } from "./harness.js";
import { loginScenarios } from "./login-scenarios.js";

describe("login with the fake provider", () => {
  loginScenarios(() => fakeHarness());
});

describe("a provider that signs with ES256", () => {
  it("logs in", async () => {
    const h = await fakeHarness({ alg: "ES256" });
    const t = await startTestServer(h);
    try {
      const browser = t.browser();
      expect((await browser.login(h, h.users.admin)).status).toBe(302);
      expect((await browser.api("GET", "/api/v0/me")).status).toBe(200);
    } finally {
      await t.close();
      await h.close();
    }
  });
});

describe("an https public URL", () => {
  it("uses __Host- and __Secure- cookies, Secure, and https redirect URIs", async () => {
    const h = await fakeHarness();
    const t = await startTestServer(h, { publicUrl: "https://localhost:8443" });
    try {
      const browser = t.browser();
      const authorize = new URL(await browser.startLogin());
      expect(authorize.searchParams.get("redirect_uri")).toBe("https://localhost:8443/auth/callback");
      expect(browser.cookie("__Secure-cromdb-login")).toBeDefined();
      const response = await browser.request(await h.authorize(authorize.href, h.users.admin));
      expect(response.status).toBe(302);
      const cookies = response.headers.getSetCookie();
      expect(cookies).toContainEqual(expect.stringMatching(/^__Host-cromdb-session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/));
      expect(cookies).toContainEqual("__Secure-cromdb-login=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
      expect((await browser.api("GET", "/api/v0/me")).status).toBe(200);
      // A request from the http origin is another origin.
      const fromHttp = await browser.request("/auth/logout", { method: "POST", origin: "http://localhost:8443" });
      expect(fromHttp.status).toBe(403);
      const logout = await browser.request("/auth/logout", { method: "POST" });
      expect(logout.status).toBe(303);
      expect(new URL(logout.headers.get("location") ?? "").searchParams.get("post_logout_redirect_uri")).toBe("https://localhost:8443/");
    } finally {
      await t.close();
      await h.close();
    }
  });
});

describe("the browser routes", () => {
  it("refuse a logout with a body that isn't JSON, or too large", async () => {
    const h = await fakeHarness();
    const t = await startTestServer(h);
    try {
      const browser = t.browser();
      const form = await browser.request("/auth/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
      expect(form.status).toBe(415);
      const large = await browser.request("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(1024 * 1024) }) });
      expect(large.status).toBe(413);
      // The bare page's form sends no fields, so no body: accepted.
      const empty = await browser.request("/auth/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(empty.status).toBe(303);
    } finally {
      await t.close();
      await h.close();
    }
  });
});

afterAll(() => {
  const browserRoutes = ROUTES.filter((route) => route.tag === "browser");
  expect(missingCoverage(browserRoutes, ONLY_ON_FAULTS)).toEqual([]);
});
