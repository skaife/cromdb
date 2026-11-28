// What a route in the route table is. Express registers routes only from the
// table (app.ts) and openapi.json is generated only from it (openapi.ts), so
// the two can't drift apart.

import type { Sessions } from "../auth/sessions.js";
import type { LoginStates } from "../auth/login-states.js";
import type { OidcClient } from "../auth/oidc.js";
import type { Backups } from "../backups/backups.js";
import type { Databases } from "../databases.js";
import type { Directory, PersonEntry } from "../directory/directory.js";
import type { ServerAdmin } from "../server-admin.js";
import type { Settings } from "../settings.js";
import { ErrorBody, type Schema } from "./schemas.js";

export type Method = "get" | "post" | "put" | "delete";

/** none: anyone. person: an active person with a session. serverAdmin: a server admin with a session. */
export type Auth = "none" | "person" | "serverAdmin";

export interface ResponseDoc {
  readonly description: string;
  /** A JSON body with this schema. */
  readonly json?: Schema;
  /** An HTML page. */
  readonly html?: true;
  /** A redirect: Location is set. */
  readonly redirect?: true;
  /** The ETag header is set: the version to send back in If-Match. */
  readonly etag?: true;
  /** The Location header names the new resource. */
  readonly location?: true;
  /** Set-Cookie is sent. */
  readonly setsCookie?: true;
}

export interface CookieNames {
  readonly session: string;
  readonly login: string;
}

/** What handlers use. */
export interface Services {
  /** The settings in effect: read on every request, as the live ones change when saved. */
  readonly settings: Settings;
  /** The server's settings, restart and status, for the server-admin routes. */
  readonly admin: ServerAdmin;
  /** The backups folder's sets, and Back up now. */
  readonly backups: Backups;
  readonly directory: Directory;
  /** The databases the server serves. */
  readonly databases: Databases;
  readonly sessions: Sessions;
  readonly loginStates: LoginStates;
  readonly oidc: OidcClient;
  readonly cookies: CookieNames;
  /** Cookies get Secure, and __Host-/__Secure- names, when the public URL is https. */
  readonly secure: boolean;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  /** openapi.json, as served. */
  readonly openapi: Readonly<Record<string, unknown>>;
}

export interface Context {
  readonly services: Services;
  /** The person logged in, if any; always set on person and serverAdmin routes. */
  readonly person: PersonEntry | undefined;
  readonly params: Readonly<Record<string, string>>;
  /** Query parameters, checked against the route's query schema when it has strictQuery. */
  readonly query: Readonly<Record<string, unknown>>;
  /** The JSON body, checked against the route's body schema. */
  readonly body: unknown;
  /** The version in If-Match, without quotes; set on routes with ifMatch. */
  readonly ifMatch: string | undefined;
  /** The session cookie's values, as sent. */
  readonly sessionIds: readonly string[];
  /** The login cookie's values, as sent. */
  readonly loginIds: readonly string[];
  /** The query string as sent, for the login callback only. */
  readonly rawQuery: URLSearchParams;
}

export interface Reply {
  readonly status: number;
  readonly json?: unknown;
  readonly html?: string;
  readonly location?: string;
  /** The version for ETag, without quotes. */
  readonly etag?: string;
  readonly cookies?: readonly string[];
}

export interface Route {
  readonly method: Method;
  /** OpenAPI form: /api/v0/people/{personId}. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tag: "browser" | "server" | "administration" | "people" | "invitations" | "databases" | "documents";
  readonly auth: Auth;
  /** If-Match is required (428 without it). */
  readonly ifMatch?: boolean;
  /** Query parameters, all optional. */
  readonly query?: Readonly<Record<string, Schema>>;
  /** Unknown or malformed query parameters are refused (400). Browser routes are lenient. */
  readonly strictQuery?: boolean;
  /** Path parameter names with what they are. */
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly body?: Schema;
  /** The route's own responses; generic ones are added by allResponses. */
  readonly responses: Readonly<Record<number, ResponseDoc>>;
  readonly handler: (context: Context) => Promise<Reply> | Reply;
}

const error = (description: string): ResponseDoc => ({ description, json: ErrorBody });

/**
 * Every response a route can give: its own, and the ones that follow from
 * what it is (needs a session, changes state, takes a body, needs If-Match).
 */
export function allResponses(route: Route): Readonly<Record<number, ResponseDoc>> {
  const responses: Record<number, ResponseDoc> = {};
  const add = (status: number, doc: ResponseDoc) => {
    const before = responses[status];
    responses[status] = before === undefined ? doc : { ...doc, description: `${before.description} ${doc.description}` };
  };
  const changes = route.method !== "get";
  if (route.body !== undefined || route.strictQuery === true || route.ifMatch === true) {
    add(400, error("INVALID_INPUT: the body, a query parameter or If-Match is not valid."));
  }
  if (route.auth !== "none") {
    add(401, error("UNAUTHENTICATED: no session, or it has expired."));
  }
  if (changes) {
    add(403, error("BAD_ORIGIN: the request doesn't come from this server's pages (Origin, Sec-Fetch-Site)."));
  }
  if (route.auth === "serverAdmin") {
    add(403, error("ACCESS_DENIED: only server admins may do this (details.reason \"serverAdmin\")."));
  }
  if (route.ifMatch === true) {
    add(412, error("STALE_VERSION: If-Match is not the current version."));
    add(428, error("IF_MATCH_REQUIRED: send the version from ETag in If-Match."));
  }
  if (changes) {
    add(413, error("TOO_LARGE: the body is over the limit."));
    add(415, error("UNSUPPORTED_MEDIA_TYPE: a body must be application/json."));
  }
  add(500, error("INTERNAL: a fault in the server; it is logged."));
  if (route.path.includes("{databaseId}")) {
    add(503, error("DATABASE_RESTORING: a restore holds the database; try again after Retry-After seconds."));
  }
  for (const [status, doc] of Object.entries(route.responses)) {
    responses[Number(status)] = doc;
  }
  return responses;
}

/** The Express form of an OpenAPI path: {name} becomes :name. */
export function expressPath(path: string): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");
}
