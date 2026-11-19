// The HTTP application. In this release it serves only the health check;
// login and the API come next.

import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";

export interface AppOptions {
  readonly trustProxy: boolean;
  readonly log: (message: string) => void;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Headers on every response. The server's pages need no script, style or framing. */
const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
};

export function createApp(options: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy);
  app.use(securityHeaders);

  app.get("/api/v0/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use((req, res) => {
    res.status(404).json(errorBody("NOT_FOUND", `No route for ${req.method} ${req.path}`));
  });

  const onError: ErrorRequestHandler = (error, req, res, _next) => {
    options.log(`${req.method} ${req.path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    if (res.headersSent) {
      return;
    }
    // Express sets status on errors it raises itself (a body it can't parse).
    const status = typeof error?.status === "number" && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json(status === 500 ? errorBody("INTERNAL", "Something went wrong on the server") : errorBody("BAD_REQUEST", "The request could not be read"));
  };
  app.use(onError);
  return app;
}
