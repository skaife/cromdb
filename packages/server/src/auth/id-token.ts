// The server's own checks on an ID token's header and claims. Pure.
//
// openid-client has already checked the signature against the issuer's keys
// and most of the claims below by the time this runs. The server checks them
// again itself, on its own clock, so that each rule is written down in one
// place, tested on its own, and doesn't depend on a library default.

/** Signing algorithms the server accepts. Never "none", never HS*. */
export const ID_TOKEN_ALGORITHMS: readonly string[] = ["RS256", "ES256"];

/** Seconds of clock difference allowed on exp and iat. */
export const CLOCK_TOLERANCE_SECONDS = 60;

/** Who logged in, from a token that passed every check. */
export interface LoginIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  /** The "name" claim, when the provider sends a usable one. */
  readonly name: string | undefined;
}

export type IdTokenCheck =
  | { readonly ok: true; readonly identity: LoginIdentity }
  /** "unverified": the token is good but its email isn't verified. "invalid": anything else. */
  | { readonly ok: false; readonly refusal: "invalid" | "unverified"; readonly reason: string };

export interface IdTokenExpectations {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  /** Now, in seconds since 1970. */
  readonly now: number;
}

function own(object: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

const invalid = (reason: string): IdTokenCheck => ({ ok: false, refusal: "invalid", reason });

export function checkIdToken(header: Readonly<Record<string, unknown>>, claims: Readonly<Record<string, unknown>>, expected: IdTokenExpectations): IdTokenCheck {
  const alg = own(header, "alg");
  if (typeof alg !== "string" || !ID_TOKEN_ALGORITHMS.includes(alg)) {
    return invalid(`the ID token is signed with ${JSON.stringify(alg)}, not ${ID_TOKEN_ALGORITHMS.join(" or ")}`);
  }
  if (own(claims, "iss") !== expected.issuer) {
    return invalid("the ID token's issuer (iss) is not the configured issuer");
  }
  const aud = own(claims, "aud");
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((a) => typeof a === "string") ? (aud as string[]) : undefined;
  if (audiences === undefined || !audiences.includes(expected.clientId)) {
    return invalid("the ID token's audience (aud) does not include this server's client ID");
  }
  const azp = own(claims, "azp");
  if (audiences.length > 1 && azp === undefined) {
    return invalid("the ID token has more than one audience and no authorized party (azp)");
  }
  if (azp !== undefined && azp !== expected.clientId) {
    return invalid("the ID token's authorized party (azp) is not this server's client ID");
  }
  const exp = own(claims, "exp");
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return invalid("the ID token has no expiry (exp)");
  }
  if (expected.now > exp + CLOCK_TOLERANCE_SECONDS) {
    return invalid("the ID token has expired (exp)");
  }
  const iat = own(claims, "iat");
  if (typeof iat !== "number" || !Number.isFinite(iat)) {
    return invalid("the ID token has no issue time (iat)");
  }
  if (iat > expected.now + CLOCK_TOLERANCE_SECONDS) {
    return invalid("the ID token was issued in the future (iat)");
  }
  if (own(claims, "nonce") !== expected.nonce) {
    return invalid("the ID token's nonce is not this login's");
  }
  const sub = own(claims, "sub");
  if (typeof sub !== "string" || sub === "") {
    return invalid("the ID token has no subject (sub)");
  }
  const email = own(claims, "email");
  if (typeof email !== "string" || email.trim() === "") {
    return invalid('the ID token has no email; the client needs the "email" scope');
  }
  // Exactly true: a string "true" is not a verified email.
  if (own(claims, "email_verified") !== true) {
    return { ok: false, refusal: "unverified", reason: "the ID token's email is not verified (email_verified)" };
  }
  const name = own(claims, "name");
  const usableName = typeof name === "string" && name.trim() !== "" && !/\p{Cc}/u.test(name) ? name.trim().slice(0, 200) : undefined;
  return { ok: true, identity: { issuer: expected.issuer, subject: sub, email, name: usableName } };
}

/** The header and claims of a compact JWS, without checking anything. */
export function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"));
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    return isRecord(header) && isRecord(claims) ? { header, claims } : undefined;
  } catch {
    return undefined;
  }
}
