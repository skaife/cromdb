// openapi.json, generated from the route table. Nothing here is written by
// hand per route: what Express serves and what this describes come from the
// same entries.

import { allResponses, type ResponseDoc, type Route } from "./route.js";
import { NAMED_SCHEMAS, type Schema } from "./schemas.js";

const NAMES = new Map<unknown, string>(Object.entries(NAMED_SCHEMAS).map(([name, schema]) => [schema, name]));

/** The schema with every named schema inside it (but not itself) replaced by a $ref. */
function withRefs(schema: unknown, top = true): unknown {
  const name = NAMES.get(schema);
  if (name !== undefined && !top) {
    return { $ref: `#/components/schemas/${name}` };
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => withRefs(item, false));
  }
  if (typeof schema === "object" && schema !== null) {
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, withRefs(value, false)]));
  }
  return schema;
}

const ref = (schema: Schema): unknown => withRefs(schema, false);

function response(doc: ResponseDoc, sessionCookie: string): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  if (doc.etag === true) headers["ETag"] = { description: "The version, quoted: send it in If-Match to change this.", schema: { type: "string" } };
  if (doc.location === true) headers["Location"] = { description: "Where the new resource is.", schema: { type: "string" } };
  if (doc.redirect === true) headers["Location"] = { description: "Where the browser goes next.", schema: { type: "string" } };
  if (doc.setsCookie === true) headers["Set-Cookie"] = { description: `Sets or removes ${sessionCookie} or the login cookie.`, schema: { type: "string" } };
  const content =
    doc.json !== undefined ? { "application/json": { schema: ref(doc.json) } } : doc.html === true ? { "text/html": { schema: { type: "string" } } } : undefined;
  return {
    description: doc.description,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(content === undefined ? {} : { content }),
  };
}

function operation(route: Route, sessionCookie: string): Record<string, unknown> {
  const parameters: unknown[] = [];
  for (const [name, description] of Object.entries(route.pathParams ?? {})) {
    parameters.push({ name, in: "path", required: true, description, schema: { type: "string" } });
  }
  for (const [name, schema] of Object.entries(route.query ?? {})) {
    parameters.push({ name, in: "query", required: false, schema });
  }
  if (route.ifMatch === true) {
    parameters.push({ name: "If-Match", in: "header", required: true, description: "The version from ETag, quoted.", schema: { type: "string" } });
  }
  const responses = Object.fromEntries(
    Object.entries(allResponses(route))
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([status, doc]) => [status, response(doc, sessionCookie)]),
  );
  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.tag],
    security: route.auth === "none" ? [] : [{ session: [] }],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.body === undefined ? {} : { requestBody: { required: true, content: { "application/json": { schema: ref(route.body) } } } }),
    responses,
    ...(route.auth === "serverAdmin" ? { "x-cromdb-server-admin": true } : {}),
  };
}

/** openapi.json for these routes. sessionCookie is the session cookie's name on this server. */
export function openApiDocument(routes: readonly Route[], info: { version: string; sessionCookie: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    (paths[route.path] ??= {})[route.method] = operation(route, info.sessionCookie);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "CromDB Server",
      version: info.version,
      description:
        "The CromDB Server API. Version 0: shapes may change in any 0.x release. Every request that changes something must come from this server's own pages (Origin), and bodies are JSON.",
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    tags: [
      { name: "browser", description: "Pages and login, for browsers." },
      { name: "server", description: "The server itself." },
      { name: "people", description: "People on this server." },
      { name: "invitations", description: "Inviting people." },
    ],
    paths,
    components: {
      schemas: Object.fromEntries(Object.entries(NAMED_SCHEMAS).map(([name, schema]) => [name, withRefs(schema, true)])),
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: info.sessionCookie, description: "The session cookie set by login." },
      },
    },
  };
}
