// The admin UI as the server serves it: the page at "/" and at any path a
// link into the UI can have, its assets, and their headers; and the bare page
// when it isn't built. Uses a small build made here, not the real one (the
// browser tests in packages/admin-ui drive that).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUiDist, isPagePath, loadAdminUi, NOTHING_CSP, pageCsp } from "../src/http/static.js";
import { fakeHarness, startTestServer, type LoginHarness, type TestServer } from "./harness.js";
import { tempDir } from "./helpers.js";

const PAGE = '<!doctype html><html lang="en"><head><script type="module" src="/assets/index-AbC123.js"></script></head><body><div id="root"></div></body></html>';
const ASSETS: Readonly<Record<string, string>> = {
  "index-AbC123.js": "console.log('ui');",
  "index-AbC123.css": "body{margin:0}",
  "inter-latin-wght-normal-Xy9.woff2": "wOF2",
  "inter-LICENSE-Q1w2.txt": "SIL Open Font License",
};

let h: LoginHarness;
let t: TestServer;
let bare: TestServer;
const dir = tempDir();

beforeAll(async () => {
  h = await fakeHarness();
  const dist = dir.join("dist");
  mkdirSync(join(dist, "assets", "nested"), { recursive: true });
  writeFileSync(join(dist, "index.html"), PAGE);
  for (const [name, body] of Object.entries(ASSETS)) writeFileSync(join(dist, "assets", name), body);
  writeFileSync(join(dist, "assets", "tool.exe"), "MZ");
  writeFileSync(join(dist, "assets", "nested", "deep.js"), "x");
  writeFileSync(join(dist, "secret.txt"), "not an asset");
  t = await startTestServer(h, { adminUiDir: dist });
  mkdirSync(dir.join("empty"));
  bare = await startTestServer(h, { adminUiDir: dir.join("empty") });
});

afterAll(async () => {
  await t.close();
  await bare.close();
  await h.close();
  dir.remove();
});

describe("the admin UI's page", () => {
  it("answers / and every path a link into the UI can have, with the strict CSP, never cached", async () => {
    const loginOrigin = new URL(h.issuer).origin;
    for (const path of ["/", "/databases", "/databases/abc/documents/def", "/server/settings?tab=1", "/__proto__", "/constructor", "/a%2Fb"]) {
      const response = await t.browser().request(path);
      expect(response.status, path).toBe(200);
      expect(response.text, path).toBe(PAGE);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(
        `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' ${loginOrigin}; frame-ancestors 'none'`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
    }
  });

  it("is the same page logged in or not, and answers HEAD without a body", async () => {
    const browser = t.browser();
    expect((await browser.login(h, h.users.admin)).status).toBe(302);
    expect((await browser.request("/databases")).text).toBe(PAGE);
    const head = await t.browser().request("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.text).toBe("");
  });

  it("is never the answer under /api/, /auth/ or /assets/, for a file name, or for anything but GET and HEAD", async () => {
    for (const path of ["/api/v0/nothing", "/api", "/auth/nothing", "/auth", "/assets", "/assets/", "/assets/missing.js", "/favicon.ico", "/databases/x.json", "/secret.txt"]) {
      const response = await t.browser().request(path);
      expect(response.status, path).toBe(404);
      expect(JSON.parse(response.text).error.code, path).toBe("NOT_FOUND");
      expect(response.headers.get("content-security-policy"), path).toBe(NOTHING_CSP);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await t.browser().request("/databases", { method });
      expect(response.status, method).toBe(404);
    }
  });
});

describe("the admin UI's assets", () => {
  it("are served with their type, cached for good", async () => {
    const types: Readonly<Record<string, string>> = {
      "index-AbC123.js": "text/javascript; charset=utf-8",
      "index-AbC123.css": "text/css; charset=utf-8",
      "inter-latin-wght-normal-Xy9.woff2": "font/woff2",
      "inter-LICENSE-Q1w2.txt": "text/plain; charset=utf-8",
    };
    for (const [name, body] of Object.entries(ASSETS)) {
      const response = await t.browser().request(`/assets/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.text).toBe(body);
      expect(response.headers.get("content-type")).toBe(types[name]);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("content-security-policy")).toBe(NOTHING_CSP);
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    }
  });

  it("are only the known kinds of file directly in assets/", async () => {
    for (const path of ["/assets/tool.exe", "/assets/nested/deep.js", "/assets/nested", "/assets/%2e%2e%2findex.html", "/assets/..%2fsecret.txt", "/assets/__proto__", "/assets/toString"]) {
      const response = await t.browser().request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
  });
});

describe("without a built UI", () => {
  it("shows a bare page saying so, and the API works", async () => {
    const response = await bare.browser().request("/databases");
    expect(response.status).toBe(200);
    expect(response.text).toContain("<h1>Test &#60;Server&#62;</h1>");
    expect(response.text).toContain("The admin UI is not built.");
    expect(response.headers.get("content-security-policy")).toBe(NOTHING_CSP);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(bare.logs.join("\n")).toContain("The admin UI is not built (no ");
    expect((await bare.browser().api("GET", "/api/v0/health")).status).toBe(200);
    expect((await bare.browser().request("/assets/index-AbC123.js")).status).toBe(404);
  });

  it("says so when it isn't installed either", () => {
    const logs: string[] = [];
    expect(loadAdminUi(undefined, (line) => logs.push(line))).toBeUndefined();
    expect(logs).toEqual(["The admin UI is not installed (@cromdb/admin-ui); only the API is served"]);
  });
});

describe("the pieces", () => {
  it("find the installed admin UI's build folder", () => {
    expect(adminUiDist()?.replaceAll("\\", "/")).toMatch(/packages\/admin-ui\/dist$/);
  });

  it("allow forms to the login service only when there is one", () => {
    expect(pageCsp(undefined)).toContain("form-action 'self'; frame-ancestors 'none'");
    expect(pageCsp("https://login.example")).toContain("form-action 'self' https://login.example; frame-ancestors 'none'");
    expect(pageCsp("https://login.example")).not.toContain("unsafe");
  });

  it("send no path under /api/, /auth/ or /assets/ to the page", () => {
    fc.assert(
      fc.property(fc.constantFrom("/api/", "/auth/", "/assets/"), fc.string(), (prefix, rest) => {
        expect(isPagePath(`${prefix}${rest}`)).toBe(false);
      }),
    );
    expect(isPagePath("/")).toBe(true);
    expect(isPagePath("/apis")).toBe(true);
    expect(isPagePath("/databases/v1.2")).toBe(false);
  });
});
