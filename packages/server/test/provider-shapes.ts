// The shape of a provider's answers, to keep the fake provider honest: the
// discovery document's fields and endpoint paths, and the names of what a
// login sends back (callback parameters, token response, ID token header and
// claims). keycloak.test.ts records Keycloak's into fixtures/keycloak, and
// fake-provider.test.ts checks the fake's against that recording on every OS.

import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "../src/auth/id-token.js";
import { PUBLIC_URL, type LoginHarness } from "./harness.js";

export interface ProviderShapes {
  /** Every field of the discovery document. */
  readonly discoveryFields: string[];
  /** Each endpoint's path after the issuer, such as "/protocol/openid-connect/token". */
  readonly endpoints: Record<string, string>;
  /** The parameters the provider adds to the redirect URI after a login. */
  readonly callbackParams: string[];
  readonly tokenResponseFields: string[];
  readonly idTokenHeader: string[];
  /** For a user with a name and a verified email, scopes "openid email profile". */
  readonly idTokenClaims: string[];
}

const sorted = (names: Iterable<string>) => [...names].sort();

/** The recording's file name for a Keycloak version. */
export const recordingFile = (version: string) => new URL(`./fixtures/keycloak/recorded-${version}.json`, import.meta.url);

/** One login by the harness's admin at its issuer, with its client, reduced to shapes. */
export async function providerShapes(h: LoginHarness): Promise<ProviderShapes> {
  const discovery = (await (await fetch(`${h.issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
  const endpoints: Record<string, string> = {};
  for (const [field, value] of Object.entries(discovery)) {
    if (typeof value === "string" && value.startsWith(`${h.issuer}/`)) endpoints[field] = value.slice(h.issuer.length);
  }
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = `${PUBLIC_URL}/auth/callback`;
  const authorize = new URL(String(discovery["authorization_endpoint"]));
  authorize.search = new URLSearchParams({
    client_id: h.client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: "s",
    nonce: "n",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const callback = new URL(await h.authorize(authorize.href, h.users.admin));
  const response = await fetch(String(discovery["token_endpoint"]), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: h.client.clientId,
      client_secret: h.client.secret,
    }).toString(),
  });
  const tokens = (await response.json()) as Record<string, unknown>;
  const decoded = decodeJwt(String(tokens["id_token"]));
  if (decoded === undefined) throw new Error(`No ID token: ${JSON.stringify(tokens)}`);
  return {
    discoveryFields: sorted(Object.keys(discovery)),
    endpoints,
    callbackParams: sorted(callback.searchParams.keys()),
    tokenResponseFields: sorted(Object.keys(tokens)),
    idTokenHeader: sorted(Object.keys(decoded.header)),
    idTokenClaims: sorted(Object.keys(decoded.claims)),
  };
}
