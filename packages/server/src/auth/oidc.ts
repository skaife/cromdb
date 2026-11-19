// Login with the OpenID Connect provider, through openid-client: the
// authorization code flow with PKCE (S256), state and nonce. Only the ID
// token's claims are used. Access and refresh tokens are dropped at once:
// the server never calls the provider's APIs, so it never keeps a token.

import * as client from "openid-client";
import { CLOCK_TOLERANCE_SECONDS, checkIdToken, decodeJwt, type LoginIdentity } from "./id-token.js";
import type { LoginState } from "./login-states.js";
import { sameText } from "./secrets.js";

export type Fetch = typeof fetch;

/** Why a login ends without a session. The reason goes to the server log only. */
export class LoginError extends Error {
  readonly refusal: "invalid" | "unverified" | "unavailable";

  constructor(refusal: "invalid" | "unverified" | "unavailable", reason: string) {
    super(reason);
    this.name = "LoginError";
    this.refusal = refusal;
  }
}

export interface OidcOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** <publicUrl>/auth/callback: built from the settings, never from a request's Host. */
  readonly redirectUri: string;
  readonly fetch: Fetch;
  readonly now: () => Date;
}

export const SCOPE = "openid email profile";

/**
 * A short description of an error from openid-client for the log: the
 * class, its code and its message, then the message of the error it wraps
 * (which names the claim or check that failed). Never anything else from a
 * cause: the cause of a claim check holds the claims, and a response body
 * error holds the provider's response.
 */
function describe(error: unknown): string {
  if (error instanceof client.ResponseBodyError) {
    return `the provider refused the code: ${error.error}`;
  }
  if (error instanceof client.AuthorizationResponseError) {
    return `the provider returned an error: ${error.error}`;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const inner = error.cause instanceof Error && error.cause.message !== error.message ? ` (${error.cause.message})` : "";
    return `${error.name}${typeof code === "string" ? ` ${code}` : ""}: ${error.message}${inner}`;
  }
  return String(error);
}

/**
 * Whether an error means the provider couldn't be reached: fetch fails with
 * a plain TypeError, or times out. openid-client's own TypeErrors (a bad
 * argument) carry a code.
 */
function unreachable(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true;
  }
  return error instanceof TypeError && (error as { code?: unknown }).code === undefined;
}

export class OidcClient {
  readonly #options: OidcOptions;
  #metadata: Promise<client.ServerMetadata> | undefined;
  /** The provider's keys, kept from one login to the next. */
  #jwks: client.ExportedJWKSCache | undefined;

  constructor(options: OidcOptions) {
    this.#options = options;
  }

  #customFetch(): client.CustomFetch {
    const fetchFn = this.#options.fetch;
    return (url, options) => fetchFn(url, options as RequestInit);
  }

  /** The provider's metadata, fetched once. A failure is not kept, so the next login tries again. */
  #server(): Promise<client.ServerMetadata> {
    this.#metadata ??= (async () => {
      const insecure = new URL(this.#options.issuer).protocol === "http:";
      const config = await client.discovery(new URL(this.#options.issuer), this.#options.clientId, undefined, undefined, {
        [client.customFetch]: this.#customFetch(),
        ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
      });
      return config.serverMetadata();
    })();
    const pending = this.#metadata;
    pending.catch(() => {
      if (this.#metadata === pending) this.#metadata = undefined;
    });
    return pending;
  }

  async #config(): Promise<client.Configuration> {
    let metadata: client.ServerMetadata;
    try {
      metadata = await this.#server();
    } catch (error) {
      throw new LoginError("unavailable", `the provider's discovery document could not be read: ${describe(error)}`);
    }
    // openid-client checks times on its own clock; tell it how far the
    // server's clock (which tests can move) is from it.
    const skew = Math.round((this.#options.now().getTime() - Date.now()) / 1000);
    const config = new client.Configuration(
      metadata,
      this.#options.clientId,
      {
        client_secret: this.#options.clientSecret,
        [client.clockSkew]: skew,
        [client.clockTolerance]: CLOCK_TOLERANCE_SECONDS,
      },
      client.ClientSecretPost(this.#options.clientSecret),
    );
    config[client.customFetch] = this.#customFetch();
    if (metadata.issuer.startsWith("http:")) {
      client.allowInsecureRequests(config);
    }
    // openid-client trusts an ID token from the token endpoint because it
    // came over TLS, and doesn't check its signature unless asked. The
    // server always checks it against the provider's keys: TLS may end at a
    // proxy, and the issuer may be plain HTTP on a trusted network.
    client.enableNonRepudiationChecks(config);
    if (this.#jwks !== undefined) {
      client.setJwksCache(config, this.#jwks);
    }
    return config;
  }

  /** New random values for a login: state, nonce and the PKCE verifier. */
  static newLogin(): { state: string; nonce: string; codeVerifier: string } {
    return { state: client.randomState(), nonce: client.randomNonce(), codeVerifier: client.randomPKCECodeVerifier() };
  }

  /** Where to send the browser to log in. */
  async authorizationUrl(login: { state: string; nonce: string; codeVerifier: string }): Promise<URL> {
    const config = await this.#config();
    return client.buildAuthorizationUrl(config, {
      redirect_uri: this.#options.redirectUri,
      scope: SCOPE,
      state: login.state,
      nonce: login.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(login.codeVerifier),
      code_challenge_method: "S256",
    });
  }

  /**
   * Finishes a login from the callback's query string: checks state,
   * exchanges the code (with the PKCE verifier and the client secret),
   * checks the ID token, and returns who logged in.
   */
  async finish(query: URLSearchParams, login: LoginState): Promise<LoginIdentity> {
    const state = query.get("state");
    if (state === null || !sameText(state, login.state)) {
      throw new LoginError("invalid", "the callback's state is not this login's");
    }
    const error = query.get("error");
    if (error !== null) {
      throw new LoginError("invalid", `the provider returned an error: ${error.slice(0, 100)}`);
    }
    const config = await this.#config();
    const callback = new URL(this.#options.redirectUri);
    callback.search = query.toString();
    let idToken: string | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: login.codeVerifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      idToken = tokens.id_token;
    } catch (cause) {
      throw new LoginError(unreachable(cause) ? "unavailable" : "invalid", describe(cause));
    } finally {
      this.#jwks = client.getJwksCache(config) ?? this.#jwks;
    }
    const decoded = idToken === undefined ? undefined : decodeJwt(idToken);
    if (decoded === undefined) {
      throw new LoginError("invalid", "the provider sent no readable ID token");
    }
    const checked = checkIdToken(decoded.header, decoded.claims, {
      issuer: this.#options.issuer,
      clientId: this.#options.clientId,
      nonce: login.nonce,
      now: Math.floor(this.#options.now().getTime() / 1000),
    });
    if (!checked.ok) {
      throw new LoginError(checked.refusal, checked.reason);
    }
    return checked.identity;
  }

  /**
   * Where to send the browser after logout, so the provider ends its own
   * session too: its end_session_endpoint with client_id and the
   * post-logout redirect (RP-initiated logout allows client_id in place of
   * id_token_hint, so no ID token is kept). Undefined when the provider has
   * no such endpoint or can't be reached.
   */
  async endSessionUrl(postLogoutRedirectUri: string): Promise<URL | undefined> {
    try {
      const config = await this.#config();
      if (config.serverMetadata().end_session_endpoint === undefined) {
        return undefined;
      }
      return client.buildEndSessionUrl(config, { client_id: this.#options.clientId, post_logout_redirect_uri: postLogoutRedirectUri });
    } catch {
      return undefined;
    }
  }
}
