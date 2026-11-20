// A fake OpenID Connect provider for tests, shaped like Keycloak: realms at
// /realms/<name>, the same endpoint paths, discovery fields, ID token claims
// and error responses. It is strict where Keycloak is: an unknown client or
// redirect URI, PKCE missing or not S256, a wrong client secret, and an
// unknown, reused or expired code are all refused.
//
// Logging in: the authorize endpoint shows a page (Keycloak's login form)
// unless the request carries "x-fake-login: <username>", in which case that
// user is logged in at once and the browser is sent back with a code.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK, type JWTPayload } from "jose";

export interface FakeUser {
  readonly username: string;
  readonly sub: string;
  readonly email?: string;
  /** Sent as email_verified; anything, so tests can send a string "true". */
  readonly emailVerified?: unknown;
  readonly name?: string;
}

export interface FakeClient {
  readonly clientId: string;
  readonly secret: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris: readonly string[];
}

export interface FakeRealmOptions {
  readonly name: string;
  readonly alg?: "RS256" | "ES256";
  readonly clients: readonly FakeClient[];
  readonly users: readonly FakeUser[];
}

interface Code {
  readonly realm: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | undefined;
  readonly user: FakeUser;
  readonly expiresAt: number;
  used: boolean;
}

interface Realm {
  readonly options: FakeRealmOptions;
  readonly alg: "RS256" | "ES256";
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

/** Seconds an ID token lasts: Keycloak's default access token lifespan. */
export const TOKEN_SECONDS = 300;
const CODE_SECONDS = 60;

export interface FakeProvider {
  readonly origin: string;
  issuer(realm: string): string;
  /** Signs any claims with a realm's key, as its ID tokens are signed. */
  sign(realm: string, claims: JWTPayload, header?: Record<string, unknown>): Promise<string>;
  /** Every request's method and path (never its query). */
  readonly requests: string[];
  /** Codes issued, for tests that replay one. */
  readonly codes: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The name claims for "First Last": name, given_name and, when there is a last part, family_name. */
function nameClaims(name: string): Record<string, string> {
  const space = name.indexOf(" ");
  if (space === -1) return { name, given_name: name };
  return { name, given_name: name.slice(0, space), family_name: name.slice(space + 1) };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function sendPage(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Fake provider</title><p>${text}</p>`);
}

function redirectWith(res: ServerResponse, target: string, params: Record<string, string>): void {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  res.writeHead(302, { location: url.href }).end();
}

export async function fakeProvider(realms: readonly FakeRealmOptions[]): Promise<FakeProvider> {
  const byName = new Map<string, Realm>();
  for (const options of realms) {
    const alg = options.alg ?? "RS256";
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const kid = randomBytes(8).toString("hex");
    byName.set(options.name, { options, alg, kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } });
  }
  const codes = new Map<string, Code>();
  const requests: string[] = [];
  const issued: string[] = [];
  let origin = "";
  const issuer = (realm: string) => `${origin}/realms/${realm}`;

  function discovery(realm: string) {
    const base = `${issuer(realm)}/protocol/openid-connect`;
    return {
      issuer: issuer(realm),
      authorization_endpoint: `${base}/auth`,
      token_endpoint: `${base}/token`,
      introspection_endpoint: `${base}/token/introspect`,
      userinfo_endpoint: `${base}/userinfo`,
      end_session_endpoint: `${base}/logout`,
      jwks_uri: `${base}/certs`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code", "none", "id_token", "token", "id_token token", "code id_token", "code token", "code id_token token"],
      subject_types_supported: ["public", "pairwise"],
      id_token_signing_alg_values_supported: ["PS384", "RS384", "EdDSA", "ES384", "HS256", "HS512", "ES256", "RS256", "HS384", "ES512", "PS256", "PS512", "RS512"],
      code_challenge_methods_supported: ["plain", "S256"],
      token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic", "client_secret_post", "tls_client_auth", "client_secret_jwt"],
      scopes_supported: ["openid", "email", "profile"],
      claims_supported: ["aud", "sub", "iss", "auth_time", "name", "given_name", "family_name", "preferred_username", "email", "acr"],
      authorization_response_iss_parameter_supported: true,
      backchannel_logout_supported: true,
      frontchannel_logout_supported: true,
    };
  }

  async function sign(realmName: string, claims: JWTPayload, header: Record<string, unknown> = {}): Promise<string> {
    const realm = byName.get(realmName);
    if (realm === undefined) throw new Error(`No realm ${realmName}`);
    return new SignJWT(claims).setProtectedHeader({ alg: realm.alg, typ: "JWT", kid: realm.kid, ...header }).sign(realm.privateKey);
  }

  function authorize(realm: Realm, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const q = url.searchParams;
    const client = realm.options.clients.find((c) => c.clientId === q.get("client_id"));
    if (client === undefined) return sendPage(res, 400, "Client not found.");
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) return sendPage(res, 400, "Invalid parameter: redirect_uri");
    const state = q.get("state") ?? undefined;
    const back = (params: Record<string, string>) => redirectWith(res, redirectUri, { ...params, ...(state === undefined ? {} : { state }), iss: issuer(realm.options.name) });
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type", error_description: "Client is not allowed to initiate browser login with given response_type." });
    if (!(q.get("scope") ?? "").split(" ").includes("openid")) return back({ error: "invalid_scope", error_description: "Invalid scopes" });
    if (q.get("code_challenge_method") !== "S256") return back({ error: "invalid_request", error_description: "Invalid parameter: code challenge method is not matching the configured one" });
    const codeChallenge = q.get("code_challenge");
    if (codeChallenge === null || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return back({ error: "invalid_request", error_description: "Invalid parameter: code_challenge" });
    const username = req.headers["x-fake-login"];
    if (typeof username !== "string") return sendPage(res, 200, "Sign in to your account");
    const user = realm.options.users.find((u) => u.username === username);
    if (user === undefined) return sendPage(res, 200, "Invalid username or password.");
    const code = randomBytes(24).toString("base64url");
    issued.push(code);
    codes.set(code, {
      realm: realm.options.name,
      clientId: client.clientId,
      redirectUri,
      codeChallenge,
      nonce: q.get("nonce") ?? undefined,
      user,
      expiresAt: Date.now() + CODE_SECONDS * 1000,
      used: false,
    });
    back({ session_state: randomBytes(16).toString("hex"), code });
  }

  async function token(realm: Realm, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(req));
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
    if (basic?.[1] !== undefined) {
      const [id, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent);
      clientId = id ?? null;
      secret = pass ?? null;
    }
    const client = realm.options.clients.find((c) => c.clientId === clientId);
    if (client === undefined || secret !== client.secret) {
      return sendJson(res, 401, { error: "unauthorized_client", error_description: "Invalid client or Invalid client credentials" });
    }
    if (form.get("grant_type") !== "authorization_code") return sendJson(res, 400, { error: "unsupported_grant_type", error_description: "Unsupported grant_type" });
    const codeText = form.get("code") ?? "";
    const code = codes.get(codeText);
    if (code === undefined || code.used || code.expiresAt < Date.now() || code.realm !== realm.options.name || code.clientId !== client.clientId) {
      if (code !== undefined) code.used = true;
      return sendJson(res, 400, { error: "invalid_grant", error_description: "Code not valid" });
    }
    code.used = true;
    if (form.get("redirect_uri") !== code.redirectUri) return sendJson(res, 400, { error: "invalid_grant", error_description: "Incorrect redirect_uri" });
    const verifier = form.get("code_verifier");
    if (verifier === null) return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE code verifier not specified" });
    if (createHash("sha256").update(verifier).digest("base64url") !== code.codeChallenge) {
      return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed: Invalid code verifier" });
    }
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomBytes(32).toString("base64url");
    const { user } = code;
    const claims: JWTPayload = {
      exp: now + TOKEN_SECONDS,
      iat: now,
      auth_time: now,
      jti: randomBytes(16).toString("hex"),
      iss: issuer(realm.options.name),
      aud: client.clientId,
      sub: user.sub,
      typ: "ID",
      azp: client.clientId,
      ...(code.nonce === undefined ? {} : { nonce: code.nonce }),
      sid: randomBytes(16).toString("hex"),
      at_hash: createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url"),
      acr: "1",
      ...(user.emailVerified === undefined ? {} : { email_verified: user.emailVerified }),
      // Keycloak builds name from the first and last names and sends each
      // part as its own claim, family_name only when there is a last name.
      ...(user.name === undefined ? {} : nameClaims(user.name)),
      preferred_username: user.username,
      ...(user.email === undefined ? {} : { email: user.email }),
    };
    sendJson(res, 200, {
      access_token: accessToken,
      expires_in: TOKEN_SECONDS,
      refresh_expires_in: 1800,
      refresh_token: randomBytes(32).toString("base64url"),
      token_type: "Bearer",
      id_token: await sign(realm.options.name, claims),
      "not-before-policy": 0,
      session_state: randomBytes(16).toString("hex"),
      scope: "openid email profile",
    });
  }

  function logout(realm: Realm, url: URL, res: ServerResponse): void {
    const client = realm.options.clients.find((c) => c.clientId === url.searchParams.get("client_id"));
    const target = url.searchParams.get("post_logout_redirect_uri");
    if (client === undefined || target === null || !client.postLogoutRedirectUris.includes(target)) {
      return sendPage(res, 400, "Invalid redirect uri");
    }
    res.writeHead(302, { location: target }).end();
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    requests.push(`${req.method} ${url.pathname}`);
    const match = /^\/realms\/([^/]+)(\/.*)$/.exec(url.pathname);
    const realm = match?.[1] === undefined ? undefined : byName.get(match[1]);
    const path = match?.[2];
    if (realm === undefined || path === undefined) return sendPage(res, 404, "Realm does not exist");
    const handle = async () => {
      if (req.method === "GET" && path === "/.well-known/openid-configuration") return sendJson(res, 200, discovery(realm.options.name));
      if (req.method === "GET" && path === "/protocol/openid-connect/certs") return sendJson(res, 200, { keys: [realm.jwk] });
      if (req.method === "GET" && path === "/protocol/openid-connect/auth") return authorize(realm, url, req, res);
      if (req.method === "POST" && path === "/protocol/openid-connect/token") return token(realm, req, res);
      if (req.method === "GET" && path === "/protocol/openid-connect/logout") return logout(realm, url, res);
      sendPage(res, 404, "Not found");
    };
    handle().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    issuer,
    sign,
    requests,
    codes: issued,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
