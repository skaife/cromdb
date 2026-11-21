// The admin UI: the built files of @cromdb/admin-ui, served at "/" beside the
// API. Not in the route table, which describes the API only.
//
//   /assets/<file>  Vite's files, named by their content: cached for good.
//                   A file that isn't there is 404, never the page.
//   the page        index.html, for "/" and for any other GET or HEAD path
//                   outside /api/, /auth/ and /assets/ whose last segment
//                   has no dot, so a link into the UI survives a reload.
//                   Never cached: a new server must never serve an old page
//                   that names assets it no longer has. Its Referrer-Policy
//                   is same-origin, not no-referrer: with no-referrer,
//                   browsers send "Origin: null" on the page's own forms
//                   (Log out), which the server refuses. Nothing goes to
//                   other origins either way.
//
// If the UI isn't built, the page says so, and the API works as before.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { RequestHandler } from "express";
import { escapeHtml, page } from "./pages.js";

/** The CSP of the API, the login pages, the assets and the bare pages: nothing may run or load. */
export const NOTHING_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * The CSP of the admin UI's page: its own scripts, styles, fonts and API, and
 * nothing inline. Forms may also go to the login service, where logging out
 * ends up (browsers apply form-action to a form's redirects too).
 */
export function pageCsp(loginOrigin: string | undefined): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    `form-action 'self'${loginOrigin === undefined ? "" : ` ${loginOrigin}`}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

export const PAGE_CACHE = "no-store";
export const ASSET_CACHE = "public, max-age=31536000, immutable";

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** The built admin UI: its page and its assets, read once at start. */
export interface AdminUi {
  readonly page: Buffer;
  /** By file name under assets/. */
  readonly assets: ReadonlyMap<string, { readonly body: Buffer; readonly type: string }>;
}

/** Where the installed @cromdb/admin-ui keeps its build, whether or not it is built. */
export function adminUiDist(): string | undefined {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("@cromdb/admin-ui/package.json")), "dist");
  } catch {
    return undefined;
  }
}

/**
 * Reads a build: index.html and the files directly in assets/. Undefined,
 * with the reason logged, when there is none.
 */
export function loadAdminUi(dir: string | undefined, log: (message: string) => void): AdminUi | undefined {
  if (dir === undefined) {
    log("The admin UI is not installed (@cromdb/admin-ui); only the API is served");
    return undefined;
  }
  const index = join(dir, "index.html");
  if (!existsSync(index)) {
    log(`The admin UI is not built (no ${index}); only the API is served`);
    return undefined;
  }
  const assets = new Map<string, { body: Buffer; type: string }>();
  const assetDir = join(dir, "assets");
  if (existsSync(assetDir)) {
    for (const name of readdirSync(assetDir)) {
      const path = join(assetDir, name);
      const type = TYPES[extname(name).toLowerCase()];
      if (type !== undefined && statSync(path).isFile()) {
        assets.set(name, { body: readFileSync(path), type });
      }
    }
  }
  return { page: readFileSync(index), assets };
}

/** The page shown when the UI isn't built. */
export function notBuiltPage(serverName: string): string {
  return page(serverName, `<h1>${escapeHtml(serverName)}</h1>\n<p>The admin UI is not built. The API is at /api/v0.</p>`);
}

/** Whether a path is one the UI's page answers. */
export function isPagePath(path: string): boolean {
  if (path === "/") return true;
  if (path.startsWith("/api/") || path === "/api" || path.startsWith("/auth/") || path === "/auth" || path.startsWith("/assets/") || path === "/assets") {
    return false;
  }
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/** Serves the UI. Anything it doesn't answer goes on (to the JSON 404). */
export function adminUiHandler(options: { ui: AdminUi | undefined; csp: string; serverName: () => string }): RequestHandler {
  const { ui } = options;
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path.startsWith("/assets/")) {
      const name = req.path.slice("/assets/".length);
      // A Map: a name like "__proto__" or "toString" is just a name.
      const asset = ui?.assets.get(name);
      if (asset === undefined) {
        next();
        return;
      }
      res.setHeader("Cache-Control", ASSET_CACHE);
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.type(asset.type).send(asset.body);
      return;
    }
    if (!isPagePath(req.path)) {
      next();
      return;
    }
    res.setHeader("Cache-Control", PAGE_CACHE);
    if (ui === undefined) {
      res.type("html").send(notBuiltPage(options.serverName()));
      return;
    }
    res.setHeader("Content-Security-Policy", options.csp);
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.type("html").send(ui.page);
  };
}
