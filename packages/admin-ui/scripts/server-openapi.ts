// The server's openapi.json, from its built route table. The admin UI doesn't
// depend on the server package (the server depends on it, to serve it), so
// this reaches the server's build in the repository directly.

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { JsonObject } from "./api-types.ts";

export async function serverOpenApi(): Promise<JsonObject> {
  const entry = join(import.meta.dirname, "..", "..", "server", "dist", "index.js");
  const server = (await import(pathToFileURL(entry).href)) as {
    openApiDocument: (routes: unknown, info: { version: string; sessionCookie: string }) => JsonObject;
    ROUTES: unknown;
  };
  // A fixed version and cookie name: the types don't depend on either.
  return server.openApiDocument(server.ROUTES, { version: "0", sessionCookie: "cromdb-session" });
}
