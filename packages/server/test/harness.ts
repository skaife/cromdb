// What the HTTP tests drive the server with: a test browser with a cookie
// jar, a check of every server response against the route table, a running
// server with a fetch the tests can tamper with, and the login harness the
// scenarios use. The scenarios (login-scenarios.ts) see only LoginHarness,
// so the same suite can run against the fake provider and against Keycloak.

import type { Driver } from "@cromdb/driver";
import { expect } from "vitest";
import type { Fetch } from "../src/auth/oidc.js";
import { main } from "../src/cli/main.js";
import { allResponses, type Route } from "../src/http/route.js";
import { ROUTES } from "../src/http/routes.js";
import { ErrorBody } from "../src/http/schemas.js";
import { createAjv } from "../src/http/validate.js";
import { startServer, type RunningServer } from "../src/server.js";
import { fakeProvider, type FakeProvider } from "./fake-provider.js";
import { scriptedIo, tempDir } from "./helpers.js";

/** Where the browser thinks the server is. Redirect URIs are registered for it. */
export const PUBLIC_URL = "http://localhost:8080";

// ---------------------------------------------------------------------------
// Responses against the route table

const ajv = createAjv();

function routeFor(method: string, path: string): Route | undefined {
  return ROUTES.find((route) => {
    if (route.method !== method.toLowerCase()) return false;
    const pattern = new RegExp(`^${route.path.replace(/\{[A-Za-z0-9_]+\}/g, "[^/]+")}$`);
    return pattern.test(path);
  });
}

/** (operationId, status) pairs seen in this test file. */
export const seen = new Set<string>();

/**
 * Checks one response against the route table: the status is documented,
 * the body fits the documented schema exactly (closed objects), and the
 * documented headers are there. Records it for the coverage check.
 */
export function checkResponse(method: string, path: string, response: Response, text: string): void {
  const route = routeFor(method, path);
  const where = `${method} ${path} -> ${response.status}`;
  if (route === undefined) {
    expect(response.status, `${where}: a path outside the table`).toBe(404);
    expect(ajv.validate(ErrorBody, JSON.parse(text)), `${where}: ${ajv.errorsText()}`).toBe(true);
    return;
  }
  const doc = allResponses(route)[response.status];
  expect(doc, `${where}: status not documented for ${route.operationId}`).toBeDefined();
  if (doc === undefined) return;
  seen.add(`${route.operationId} ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (doc.json !== undefined) {
    expect(type, where).toMatch(/^application\/json/);
    const body: unknown = JSON.parse(text);
    expect(ajv.validate(doc.json, body), `${where}: ${ajv.errorsText()} in ${text.slice(0, 500)}`).toBe(true);
  } else if (doc.html === true) {
    expect(type, where).toMatch(/^text\/html/);
  } else {
    expect(text, `${where}: no body documented`).toBe("");
  }
  expect(response.headers.has("etag"), `${where}: ETag`).toBe(doc.etag === true);
  if (doc.etag === true) expect(response.headers.get("etag"), where).toMatch(/^"[^"]+"$/);
  expect(response.headers.has("location"), `${where}: Location`).toBe(doc.redirect === true || doc.location === true);
  if (doc.setsCookie !== true && !(response.status === 401 && route.auth !== "none")) {
    expect(response.headers.getSetCookie(), `${where}: Set-Cookie not documented`).toEqual([]);
  }
}

/** The documented (operationId, status) pairs, for these routes, that no test produced. */
export function missingCoverage(routes: readonly Route[], allowed: (route: Route, status: number) => boolean): string[] {
  const missing: string[] = [];
  for (const route of routes) {
    for (const status of Object.keys(allResponses(route)).map(Number)) {
      if (!seen.has(`${route.operationId} ${status}`) && !allowed(route, status)) {
        missing.push(`${route.method.toUpperCase()} ${route.path} ${status}`);
      }
    }
  }
  return missing;
}

/** 500 is only produced by a fault in the server; the error handler is tested on its own. */
export const ONLY_ON_FAULTS = (_route: Route, status: number) => status === 500;

// ---------------------------------------------------------------------------
// The browser

interface StoredCookie {
  value: string;
  path: string;
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** Origin to send on non-GET requests: the public origin by default; null sends none. */
  readonly origin?: string | null;
}

/**
 * A browser that knows the server as PUBLIC_URL (as redirect URIs are
 * registered) but reaches it at its real address. It keeps cookies by name
 * and path, never follows redirects, and checks every server response
 * against the route table.
 */
export class TestBrowser {
  readonly #jar = new Map<string, StoredCookie>();
  readonly serverUrl: string;
  readonly publicUrl: string;

  constructor(serverUrl: string, publicUrl: string) {
    this.serverUrl = serverUrl;
    this.publicUrl = publicUrl;
  }

  cookie(name: string): string | undefined {
    return this.#jar.get(name)?.value;
  }

  setCookie(name: string, value: string, path = "/"): void {
    this.#jar.set(name, { value, path });
  }

  clearCookies(): void {
    this.#jar.clear();
  }

  #cookieHeader(path: string): string | undefined {
    const pairs = [...this.#jar.entries()].filter(([, cookie]) => path === cookie.path || path.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`));
    return pairs.length === 0 ? undefined : pairs.map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
  }

  #store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      const path = attributes.find((a) => a.startsWith("Path="))?.slice(5) ?? "/";
      const maxAge = attributes.find((a) => a.startsWith("Max-Age="));
      if (maxAge === "Max-Age=0") {
        this.#jar.delete(name);
      } else {
        this.#jar.set(name, { value, path });
      }
    }
  }

  /** A request to the server: target is a path, or a URL at the public URL. */
  async request(target: string, options: RequestOptions = {}): Promise<Response & { text: string }> {
    const publicTarget = new URL(target, this.publicUrl);
    if (publicTarget.origin !== new URL(this.publicUrl).origin) {
      throw new Error(`The test browser only goes to the server, not ${publicTarget.origin}`);
    }
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { ...options.headers };
    const cookie = this.#cookieHeader(publicTarget.pathname);
    if (cookie !== undefined && headers["cookie"] === undefined) headers["cookie"] = cookie;
    const origin = options.origin === undefined ? new URL(this.publicUrl).origin : options.origin;
    if (method !== "GET" && origin !== null) headers["origin"] = origin;
    const response = await fetch(`${this.serverUrl}${publicTarget.pathname}${publicTarget.search}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: "manual",
    });
    const text = await response.text();
    this.#store(response);
    checkResponse(method, publicTarget.pathname, response, text);
    return Object.assign(response, { text });
  }

  /** A JSON request to the API. */
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await this.request(path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.text === "" ? undefined : (JSON.parse(response.text) as any), headers: response.headers };
  }

  /** Starts a login; returns the provider's authorize URL. */
  async startLogin(returnTo = "/"): Promise<string> {
    const response = await this.request(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    expect(response.status, response.text).toBe(302);
    return response.headers.get("location") ?? "";
  }

  /** Logs in as a user through the provider; returns the callback's response. */
  async login(harness: LoginHarness, user: TestUser, returnTo = "/"): Promise<Response & { text: string }> {
    const authorize = await this.startLogin(returnTo);
    return this.request(await harness.authorize(authorize, user));
  }
}

// ---------------------------------------------------------------------------
// The login harness

export interface TestUser {
  readonly username: string;
  readonly password: string;
  readonly email: string;
  readonly name?: string;
}

export interface TestClient {
  readonly clientId: string;
  readonly secret: string;
}

export interface LoginHarness {
  readonly name: string;
  readonly issuer: string;
  /** The same client and users in a second realm: another issuer, other keys. */
  readonly otherIssuer: string;
  readonly client: TestClient;
  /** A second client in the same realm, also allowed to redirect to the server. */
  readonly otherClient: TestClient;
  readonly users: {
    /** The admin setup invites. */
    readonly admin: TestUser;
    /** Verified; the tests invite this email. */
    readonly invited: TestUser;
    /** email_verified false. */
    readonly unverified: TestUser;
    /** Verified, never invited. */
    readonly uninvited: TestUser;
    /** Another account with the invited user's email, verified. */
    readonly secondAccount: TestUser;
  };
  /**
   * Follows a provider's authorize URL as the user would in a browser,
   * logging in; returns where the provider sends the browser back.
   */
  authorize(url: string, user: TestUser): Promise<string>;
  /** Signs any claims with the issuer's key. Only a fake can. */
  readonly sign?: (claims: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
  close(): Promise<void>;
}

const user = (username: string, email: string, name?: string): TestUser => ({ username, password: `${username}-password`, email, ...(name === undefined ? {} : { name }) });

/** The fake provider as a login harness. */
export async function fakeHarness(options: { alg?: "RS256" | "ES256" } = {}): Promise<LoginHarness & { provider: FakeProvider }> {
  const users = {
    admin: user("admin", "admin@example.com", "Ada Admin"),
    invited: user("ivy", "ivy@example.com", "Ivy Invited"),
    unverified: user("una", "una@example.com", "Una Unverified"),
    uninvited: user("sam", "sam@example.com", "Sam Stranger"),
    secondAccount: user("ivy2", "IVY@example.com", "Ivy Again"),
  };
  const fakeUsers = [
    { username: "admin", sub: "sub-admin", email: users.admin.email, emailVerified: true, name: "Ada Admin" },
    { username: "ivy", sub: "sub-ivy", email: users.invited.email, emailVerified: true, name: "Ivy Invited" },
    { username: "una", sub: "sub-una", email: users.unverified.email, emailVerified: false, name: "Una Unverified" },
    { username: "sam", sub: "sub-sam", email: users.uninvited.email, emailVerified: true, name: "Sam Stranger" },
    { username: "ivy2", sub: "sub-ivy2", email: users.secondAccount.email, emailVerified: true, name: "Ivy Again" },
  ];
  const client = { clientId: "cromdb", secret: "s3cret" };
  const otherClient = { clientId: "other", secret: "other-s3cret" };
  const clients = [client, otherClient].map((c) => ({
    clientId: c.clientId,
    secret: c.secret,
    redirectUris: [`${PUBLIC_URL}/auth/callback`, "https://localhost:8443/auth/callback"],
    postLogoutRedirectUris: [`${PUBLIC_URL}/`, "https://localhost:8443/"],
  }));
  const provider = await fakeProvider([
    { name: "cromdb", ...(options.alg === undefined ? {} : { alg: options.alg }), clients, users: fakeUsers },
    { name: "other", clients, users: fakeUsers },
  ]);
  return {
    name: "fake provider",
    provider,
    issuer: provider.issuer("cromdb"),
    otherIssuer: provider.issuer("other"),
    client,
    otherClient,
    users,
    async authorize(url, who) {
      const response = await fetch(url, { headers: { "x-fake-login": who.username }, redirect: "manual" });
      if (response.status !== 302) {
        throw new Error(`The provider didn't log ${who.username} in: ${response.status} ${await response.text()}`);
      }
      return response.headers.get("location") ?? "";
    },
    sign: (claims, header) => provider.sign("cromdb", claims, header),
    close: () => provider.close(),
  };
}

// ---------------------------------------------------------------------------
// The server under test

export interface TokenTap {
  /** Changes the provider's token response before the server sees it. */
  tamper: ((body: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) | undefined;
  /** Every token response the provider sent, unchanged. */
  readonly responses: Record<string, unknown>[];
}

export interface TestServer {
  readonly harness: LoginHarness;
  server: RunningServer;
  readonly dataDir: string;
  readonly logs: string[];
  /** How far the server's clock is ahead of the real one. */
  clockMs: number;
  /** When true, the server can't reach the provider. */
  offline: boolean;
  readonly tokens: TokenTap;
  browser(): TestBrowser;
  /** Stops and starts the server on the same data directory, doing between (if given) while it is stopped. */
  restart(between?: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Sets up a data directory for the harness's provider and client (the
 * harness's admin is setup's admin), and starts a server on it.
 */
export async function startTestServer(harness: LoginHarness, options: { publicUrl?: string; driver?: () => Driver } = {}): Promise<TestServer> {
  const publicUrl = options.publicUrl ?? PUBLIC_URL;
  const dir = tempDir();
  const dataDir = dir.join("data");
  const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: harness.client.secret } });
  const flags = [
    "setup",
    "--data",
    dataDir,
    "--deployment",
    "new",
    "--server-name",
    "Test <Server>",
    "--public-url",
    publicUrl,
    ...(publicUrl.startsWith("https:") ? ["--no-tls"] : []),
    "--trust-proxy",
    "no",
    "--listen",
    "127.0.0.1:0",
    "--issuer",
    harness.issuer,
    "--client-id",
    harness.client.clientId,
    "--admin-email",
    harness.users.admin.email,
  ];
  const status = await main(flags, io);
  if (status !== 0) throw new Error(`setup failed: ${io.text()}`);

  const logs: string[] = [];
  const tokens: TokenTap = { tamper: undefined, responses: [] };
  const test: TestServer = {
    harness,
    server: undefined as unknown as RunningServer,
    dataDir,
    logs,
    clockMs: 0,
    offline: false,
    tokens,
    browser: () => new TestBrowser(test.server.url, publicUrl),
    async restart(between) {
      await test.server.close();
      await between?.();
      test.server = await start();
    },
    async close() {
      await test.server.close();
      dir.remove();
    },
  };
  const serverFetch: Fetch = async (input, init) => {
    if (test.offline) throw new TypeError("fetch failed");
    const response = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/protocol/openid-connect/token") || response.status !== 200) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    tokens.responses.push(body);
    const sent = tokens.tamper === undefined ? body : await tokens.tamper(body);
    return new Response(JSON.stringify(sent), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  };
  const start = () =>
    startServer({
      dataDir,
      log: (line) => logs.push(line),
      fetch: serverFetch,
      now: () => new Date(Date.now() + test.clockMs),
      ...(options.driver === undefined ? {} : { driver: options.driver() }),
    });
  test.server = await start();
  return test;
}
