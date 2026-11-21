// The fake provider must refuse what Keycloak refuses, or the login tests
// would pass against a provider more forgiving than the real one.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProvider, type FakeProvider } from "./fake-provider.js";
import { fakeHarness } from "./harness.js";
import { KEYCLOAK_VERSION } from "./keycloak-harness.js";
import { providerShapes, recordingFile, type ProviderShapes } from "./provider-shapes.js";

const REDIRECT = "http://localhost:8080/auth/callback";
let fake: FakeProvider;
let base: string;

beforeAll(async () => {
  fake = await fakeProvider([
    {
      name: "r",
      clients: [{ clientId: "c", secret: "s", redirectUris: [REDIRECT], postLogoutRedirectUris: ["http://localhost:8080/"] }],
      users: [{ username: "u", sub: "sub-u", email: "u@example.com", emailVerified: true }],
    },
  ]);
  base = `${fake.issuer("r")}/protocol/openid-connect`;
});
afterAll(() => fake.close());

function authorizeUrl(params: Record<string, string | undefined>): string {
  const verifier = "v".repeat(43);
  const defaults: Record<string, string> = {
    client_id: "c",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid email",
    state: "st",
    nonce: "no",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  };
  const merged = Object.fromEntries(Object.entries({ ...defaults, ...params }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return `${base}/auth?${new URLSearchParams(merged).toString()}`;
}

async function authorize(params: Record<string, string | undefined> = {}) {
  const response = await fetch(authorizeUrl(params), { headers: { "x-fake-login": "u" }, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), text: await response.text() };
}

async function code(): Promise<string> {
  const { location } = await authorize();
  return new URL(location ?? "").searchParams.get("code") ?? "";
}

async function token(params: Record<string, string>, auth?: string) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(auth === undefined ? {} : { authorization: auth }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const good = (codeText: string) => ({ grant_type: "authorization_code", code: codeText, redirect_uri: REDIRECT, code_verifier: "v".repeat(43), client_id: "c", client_secret: "s" });

describe("the fake provider", () => {
  it("logs in and issues an ID token for a good request", async () => {
    const { location } = await authorize();
    const back = new URL(location ?? "");
    expect(back.searchParams.get("state")).toBe("st");
    expect(back.searchParams.get("iss")).toBe(fake.issuer("r"));
    const response = await token(good(back.searchParams.get("code") ?? ""));
    expect(response.status).toBe(200);
    expect(response.body["id_token"]).toEqual(expect.any(String));
  });

  it("shows a login page without a user, and refuses an unknown client or redirect URI without redirecting", async () => {
    expect((await fetch(authorizeUrl({}), { redirect: "manual" })).status).toBe(200);
    for (const params of [{ client_id: "nobody" }, { redirect_uri: "http://localhost:8080/elsewhere" }, { redirect_uri: "https://evil.example/auth/callback" }]) {
      const response = await authorize(params);
      expect(response.status, JSON.stringify(params)).toBe(400);
      expect(response.location).toBeNull();
    }
  });

  it("sends back an error without PKCE S256, without openid, or for another response type", async () => {
    for (const params of [{ code_challenge_method: "plain" }, { code_challenge_method: undefined }, { code_challenge: undefined }, { scope: "email" }, { response_type: "token" }]) {
      const response = await authorize(params);
      expect(response.status, JSON.stringify(params)).toBe(302);
      expect(new URL(response.location ?? "").searchParams.get("error"), JSON.stringify(params)).toMatch(/invalid_request|invalid_scope|unsupported_response_type/);
    }
  });

  it("refuses a wrong secret, a wrong verifier, another redirect URI, and a code used twice", async () => {
    expect((await token({ ...good(await code()), client_secret: "wrong" })).status).toBe(401);
    expect((await token({ ...good(await code()), client_id: "nobody" })).status).toBe(401);
    expect((await token({ ...good(await code()), code_verifier: "w".repeat(43) })).body["error"]).toBe("invalid_grant");
    const { code_verifier: _, ...noVerifier } = good(await code());
    expect((await token(noVerifier)).body["error"]).toBe("invalid_grant");
    expect((await token({ ...good(await code()), redirect_uri: "http://localhost:8080/other" })).body["error"]).toBe("invalid_grant");
    const once = await code();
    expect((await token(good(once))).status).toBe(200);
    expect((await token(good(once))).body["error"]).toBe("invalid_grant");
    expect((await token(good(randomBytes(24).toString("base64url")))).body["error"]).toBe("invalid_grant");
    expect((await token({ ...good(await code()), grant_type: "password" })).body["error"]).toBe("unsupported_grant_type");
  });

  it("takes the client's credentials by HTTP Basic too", async () => {
    const { client_id: _, client_secret: __, ...rest } = good(await code());
    expect((await token(rest, `Basic ${Buffer.from("c:s").toString("base64")}`)).status).toBe(200);
    expect((await token(rest, `Basic ${Buffer.from("c:x").toString("base64")}`)).status).toBe(401);
  });

  it("ignores login_as unless asked to show a page of users", async () => {
    const response = await fetch(`${authorizeUrl({})}&login_as=u`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in to your account");
  });

  it("with pickUser, lists the users as links, and a link logs that user in", async () => {
    const picker = await fakeProvider(
      [
        {
          name: "r",
          clients: [{ clientId: "c", secret: "s", redirectUris: [REDIRECT], postLogoutRedirectUris: [] }],
          users: [
            { username: "u", sub: "sub-u", email: "u@example.com", emailVerified: true, name: "Una <U>" },
            { username: "v", sub: "sub-v" },
          ],
        },
      ],
      { pickUser: true },
    );
    try {
      const url = authorizeUrl({}).replace(fake.origin, picker.origin);
      const page = await (await fetch(url, { redirect: "manual" })).text();
      expect(page).toContain("<h1>Log in as</h1>");
      expect(page).toContain(">Una &#60;U&#62; (u@example.com)</a>");
      const href = /href="([^"]+login_as=u)"/.exec(page)?.[1]?.replaceAll("&#38;", "&") ?? "";
      const back = await fetch(new URL(href, picker.origin), { redirect: "manual" });
      expect(back.status).toBe(302);
      expect(new URL(back.headers.get("location") ?? "").searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]+$/);
      const nobody = await fetch(`${url}&login_as=nobody`, { redirect: "manual" });
      expect(await nobody.text()).toContain("Invalid username or password.");
    } finally {
      await picker.close();
    }
  });

  it("logs out only to a registered address", async () => {
    const ok = await fetch(`${base}/logout?client_id=c&post_logout_redirect_uri=${encodeURIComponent("http://localhost:8080/")}`, { redirect: "manual" });
    expect(ok.status).toBe(302);
    const bad = await fetch(`${base}/logout?client_id=c&post_logout_redirect_uri=${encodeURIComponent("https://evil.example/")}`, { redirect: "manual" });
    expect(bad.status).toBe(400);
  });
});

describe("the fake's shapes, against Keycloak's recorded ones", () => {
  it("has only discovery fields Keycloak has, at Keycloak's paths, and sends what Keycloak sends", async () => {
    const recorded = JSON.parse(readFileSync(recordingFile(KEYCLOAK_VERSION), "utf8")) as ProviderShapes;
    const h = await fakeHarness();
    try {
      const fakeShapes = await providerShapes(h);
      expect(fakeShapes.discoveryFields.filter((field) => !recorded.discoveryFields.includes(field))).toEqual([]);
      for (const [field, path] of Object.entries(fakeShapes.endpoints)) {
        expect(path, field).toBe(recorded.endpoints[field]);
      }
      // What the server reads from discovery is in the fake.
      for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri", "end_session_endpoint", "authorization_response_iss_parameter_supported"]) {
        expect(fakeShapes.discoveryFields).toContain(field);
      }
      expect(fakeShapes.callbackParams).toEqual(recorded.callbackParams);
      expect(fakeShapes.tokenResponseFields).toEqual(recorded.tokenResponseFields);
      expect(fakeShapes.idTokenHeader).toEqual(recorded.idTokenHeader);
      expect(fakeShapes.idTokenClaims).toEqual(recorded.idTokenClaims);
    } finally {
      await h.close();
    }
  });
});
