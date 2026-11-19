// Checks an OpenID Connect provider before the server is set up to use it:
// its discovery document and its signing keys. Login itself comes later.

const TIMEOUT_MS = 10_000;
const SIGNING_ALGORITHMS = ["RS256", "ES256"];

export type Fetch = typeof fetch;

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

async function getJson(fetchFn: Fetch, url: string, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new DiscoveryError(`Couldn't fetch ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new DiscoveryError(`Fetching ${what} from ${url} gave HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoveryError(`${what} at ${url} is not JSON`);
  }
  const object = record(body);
  if (object === undefined) {
    throw new DiscoveryError(`${what} at ${url} is not a JSON object`);
  }
  return object;
}

function list(document: Record<string, unknown>, key: string): unknown[] {
  const value = own(document, key);
  return Array.isArray(value) ? value : [];
}

function isUsableKey(key: unknown): boolean {
  const jwk = record(key);
  if (jwk === undefined) return false;
  const use = own(jwk, "use");
  const alg = own(jwk, "alg");
  if (use !== undefined && use !== "sig") return false;
  if (own(jwk, "kty") === "RSA") {
    return (alg === undefined || alg === "RS256") && typeof own(jwk, "n") === "string" && typeof own(jwk, "e") === "string";
  }
  if (own(jwk, "kty") === "EC") {
    return (alg === undefined || alg === "ES256") && own(jwk, "crv") === "P-256";
  }
  return false;
}

/**
 * Fetches the issuer's discovery document and its keys, and checks the
 * provider can do what the server's login needs: the authorization code flow
 * with PKCE (S256), ID tokens signed with RS256 or ES256, and a usable key.
 * The issuer it states must equal the one given, exactly.
 */
export async function checkIssuer(issuer: string, fetchFn: Fetch = fetch): Promise<void> {
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const url = `${base}/.well-known/openid-configuration`;
  const document = await getJson(fetchFn, url, "the discovery document");
  const stated = own(document, "issuer");
  if (stated !== issuer) {
    throw new DiscoveryError(`The provider's issuer is ${JSON.stringify(stated)}, not ${JSON.stringify(issuer)}. Use its issuer exactly.`);
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const value = own(document, key);
    if (typeof value !== "string" || !URL.canParse(value)) {
      throw new DiscoveryError(`The discovery document has no ${key}`);
    }
  }
  if (!list(document, "response_types_supported").includes("code")) {
    throw new DiscoveryError('The provider doesn\'t support the authorization code flow (response type "code")');
  }
  if (!list(document, "code_challenge_methods_supported").includes("S256")) {
    throw new DiscoveryError("The provider doesn't list PKCE with S256 (code_challenge_methods_supported)");
  }
  const algorithms = list(document, "id_token_signing_alg_values_supported");
  if (!SIGNING_ALGORITHMS.some((alg) => algorithms.includes(alg))) {
    throw new DiscoveryError(`The provider doesn't sign ID tokens with ${SIGNING_ALGORITHMS.join(" or ")}`);
  }
  const jwks = await getJson(fetchFn, own(document, "jwks_uri") as string, "the provider's keys");
  if (!list(jwks, "keys").some(isUsableKey)) {
    throw new DiscoveryError(`The provider's keys include no ${SIGNING_ALGORITHMS.join(" or ")} signing key`);
  }
}
