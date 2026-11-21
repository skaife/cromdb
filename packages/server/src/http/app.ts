// The HTTP application. Every route comes from the route table (routes.ts).
//
// In order, for every request: security headers and the request log; the
// body (a body needs application/json, 415, and must fit the limit, 413);
// the session from its cookie. Then, for a route: a session if it needs one
// (401); Origin on anything but GET (403 BAD_ORIGIN); server admin if it
// needs it (403); query and body against their schemas (400); If-Match if
// it needs it (428). Then the handler. Paths outside the route table go to
// the admin UI (static.ts), and what it doesn't answer is a JSON 404.

import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
import { originAllowed, publicOrigin } from "../auth/checks.js";
import { parseCookies, serializeCookie } from "../auth/cookies.js";
import type { PersonEntry } from "../directory/directory.js";
import { ApiError } from "./errors.js";
import { allResponses, expressPath, type Context, type Reply, type Route, type Services } from "./route.js";
import { adminUiHandler, NOTHING_CSP, pageCsp, type AdminUi } from "./static.js";
import { checkBody, checkQuery } from "./validate.js";

/** Bodies larger than this are refused (413). */
export const BODY_LIMIT_BYTES = 1024 * 1024;

export interface AppOptions {
  readonly trustProxy: boolean;
  readonly routes: readonly Route[];
  readonly services: Services;
  /** The built admin UI, or undefined when it isn't built. */
  readonly adminUi?: AdminUi | undefined;
}

interface Locals {
  person?: PersonEntry;
  sessionIds: string[];
  loginIds: string[];
}

function locals(res: Response): Locals {
  return res.locals as Locals;
}

/**
 * Headers on every response. Nothing is cached and nothing may run or load,
 * unless the admin UI's handler says otherwise for its page and assets.
 */
const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", NOTHING_CSP);
  res.setHeader("Cache-Control", "no-store");
  next();
};

/** The login service's origin, which logging out is sent on to. */
function loginOrigin(issuer: string): string | undefined {
  try {
    return new URL(issuer).origin;
  } catch {
    return undefined;
  }
}

/**
 * One line per request: method, path (never the query string), status,
 * time and the person. Never cookies, tokens or codes.
 */
function requestLog(log: (message: string) => void): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const person = locals(res).person;
      log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms${person === undefined ? "" : ` person=${person.person.personId}`}`);
    });
    next();
  };
}

function hasBody(req: Request): boolean {
  const length = req.headers["content-length"];
  return req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

/** A body must be JSON. GET and HEAD bodies are never read. */
const jsonOnly: RequestHandler = (req, _res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || !hasBody(req)) {
    next();
    return;
  }
  if (req.is("application/json") === false) {
    next(new ApiError("UNSUPPORTED_MEDIA_TYPE", "A request body must be application/json"));
    return;
  }
  next();
};

/** The session from its cookie: a live session of an active person. */
function session(services: Services): RequestHandler {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const local = locals(res);
    local.sessionIds = cookies.get(services.cookies.session) ?? [];
    local.loginIds = cookies.get(services.cookies.login) ?? [];
    for (const id of local.sessionIds) {
      const found = services.sessions.use(id);
      if (found === undefined) continue;
      const entry = services.directory.index.get(found.personId);
      if (entry !== undefined && entry.person.status === "active") {
        local.person = entry;
        break;
      }
    }
    next();
  };
}

function send(res: Response, route: Route, reply: Reply, log: (message: string) => void): void {
  if (!Object.hasOwn(allResponses(route), reply.status)) {
    log(`${route.method.toUpperCase()} ${route.path} answered ${reply.status}, which the route table doesn't document`);
  }
  for (const cookie of reply.cookies ?? []) {
    res.append("Set-Cookie", cookie);
  }
  if (reply.etag !== undefined) {
    res.setHeader("ETag", `"${reply.etag}"`);
  }
  res.status(reply.status);
  if (reply.location !== undefined) {
    res.setHeader("Location", reply.location);
  }
  if (reply.html !== undefined) {
    res.type("html").send(reply.html);
  } else if (reply.json !== undefined) {
    res.json(reply.json);
  } else {
    res.end();
  }
}

/** The version in If-Match: exactly one strong tag. */
function parseIfMatch(value: string | undefined): string {
  if (value === undefined) {
    throw new ApiError("IF_MATCH_REQUIRED", "Send the version from ETag in If-Match");
  }
  const match = /^\s*"([^"]*)"\s*$/.exec(value);
  if (match === null || match[1] === undefined || match[1] === "") {
    throw new ApiError("INVALID_INPUT", 'If-Match must be one version from ETag, in quotes', { header: "If-Match" });
  }
  return match[1];
}

function handlerFor(route: Route, services: Services, expectedOrigin: string): RequestHandler {
  return async (req, res) => {
    const local = locals(res);
    if (route.auth !== "none" && local.person === undefined) {
      // A cookie that names no live session is removed.
      const cookies = local.sessionIds.length > 0 ? [serializeCookie(services.cookies.session, "", { path: "/", maxAge: 0, secure: services.secure })] : [];
      for (const cookie of cookies) res.append("Set-Cookie", cookie);
      throw new ApiError("UNAUTHENTICATED", "Log in first");
    }
    if (route.method !== "get" && !originAllowed({ origin: req.headers.origin, secFetchSite: req.get("sec-fetch-site") }, expectedOrigin)) {
      throw new ApiError("BAD_ORIGIN", "The request must come from this server's own pages");
    }
    if (route.auth === "serverAdmin" && local.person?.person.serverAdmin !== true) {
      throw new ApiError("ACCESS_DENIED", "Only server admins may do this", { reason: "serverAdmin" });
    }
    const rawQuery = new URL(req.originalUrl, "http://x").searchParams;
    const query = route.strictQuery === true ? checkQuery(route.query ?? {}, req.query as Record<string, unknown>) : (req.query as Record<string, unknown>);
    if (route.body !== undefined) {
      checkBody(route.body, req.body);
    }
    const ifMatch = route.ifMatch === true ? parseIfMatch(req.get("if-match")) : undefined;
    const context: Context = {
      services,
      person: local.person,
      params: req.params as Record<string, string>,
      query,
      body: req.body,
      ifMatch,
      sessionIds: local.sessionIds,
      loginIds: local.loginIds,
      rawQuery,
    };
    send(res, route, await route.handler(context), services.log);
  };
}

export function createApp(options: AppOptions): Express {
  const { services } = options;
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", options.trustProxy);
  app.set("query parser", "simple");
  app.use(securityHeaders);
  app.use(requestLog(services.log));
  app.use(jsonOnly);
  app.use(express.json({ limit: BODY_LIMIT_BYTES, strict: true, type: "application/json" }));
  app.use(session(services));

  const expectedOrigin = publicOrigin(services.settings.publicUrl);
  for (const route of options.routes) {
    app[route.method](expressPath(route.path), handlerFor(route, services, expectedOrigin));
  }
  app.use(adminUiHandler({ ui: options.adminUi, csp: pageCsp(loginOrigin(services.settings.oidcIssuer)), serverName: () => services.settings.serverName }));

  app.use((req, res) => {
    res.status(404).json(new ApiError("NOT_FOUND", `No route for ${req.method} ${req.path}`).body);
  });

  const onError: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) {
      services.log(`${req.method} ${req.path} failed after answering: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let apiError: ApiError;
    if (error instanceof ApiError) {
      apiError = error;
    } else if (error?.type === "entity.too.large") {
      apiError = new ApiError("TOO_LARGE", `A request body may be at most ${BODY_LIMIT_BYTES} bytes`);
    } else if (error?.type === "charset.unsupported" || error?.type === "encoding.unsupported") {
      apiError = new ApiError("UNSUPPORTED_MEDIA_TYPE", "A request body must be JSON in UTF-8");
    } else if (error?.type === "entity.parse.failed") {
      apiError = new ApiError("INVALID_INPUT", "The body is not valid JSON", { path: "" });
    } else if (typeof error?.status === "number" && error.status >= 400 && error.status < 500) {
      // Another refusal Express raises while reading the request.
      apiError = new ApiError("INVALID_INPUT", "The request could not be read");
    } else {
      services.log(`${req.method} ${req.path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      apiError = new ApiError("INTERNAL", "Something went wrong on the server");
    }
    res.status(apiError.status).json(apiError.body);
  };
  app.use(onError);
  return app;
}
