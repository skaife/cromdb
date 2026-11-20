// openapi.json and the route table: the description is a valid OpenAPI 3.1
// document, every schema in it compiles and is closed, and the routes
// Express serves are exactly the table's.

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { openApiDocument } from "../src/http/openapi.js";
import { allResponses, expressPath, type Services } from "../src/http/route.js";
import { ROUTES } from "../src/http/routes.js";
import { NAMED_SCHEMAS, OPEN_SCHEMAS, OpenApiDocument, type Schema } from "../src/http/schemas.js";
import { createAjv } from "../src/http/validate.js";

const document = openApiDocument(ROUTES, { version: "0.1.0", sessionCookie: "cromdb-session" });

/** The OpenAPI 3.1 schema, with its dynamic references made plain (see the fixture's README). */
function openApiSchema(): Record<string, unknown> {
  const text = readFileSync(new URL("./fixtures/openapi-3.1/schema.json", import.meta.url), "utf8");
  return JSON.parse(text.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')) as Record<string, unknown>;
}

describe("openapi.json", () => {
  it("is a valid OpenAPI 3.1 document", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(openApiSchema());
    expect(validate(document), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it("the check catches a broken document", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(openApiSchema());
    const broken = JSON.parse(JSON.stringify(document)) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    (broken.paths["/api/v0/me"] as Record<string, Record<string, unknown>>)["get"]!["responses"] = { "200": { content: {} } };
    expect(validate(broken)).toBe(false);
  });

  it("names every operation once, and resolves every $ref", () => {
    const ids = ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = JSON.stringify(document).match(/"#\/components\/schemas\/[A-Za-z]+"/g) ?? [];
    const names = Object.keys((document["components"] as { schemas: Record<string, unknown> }).schemas);
    for (const ref of refs) {
      expect(names).toContain(ref.slice('"#/components/schemas/'.length, -1));
    }
    expect(refs.length).toBeGreaterThan(10);
  });

  it("documents every route's responses, sorted, with a body or a header where the route gives one", () => {
    const paths = document["paths"] as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    for (const route of ROUTES) {
      const responses = paths[route.path]?.[route.method]?.responses ?? {};
      expect(Object.keys(responses), route.operationId).toEqual(Object.keys(allResponses(route)));
    }
  });
});

describe("the schemas", () => {
  /** Every object schema in a schema, wherever it is nested. */
  function objects(schema: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(schema)) {
      for (const item of schema) objects(item, found);
    } else if (typeof schema === "object" && schema !== null) {
      const record = schema as Record<string, unknown>;
      if (record["type"] === "object") found.push(record);
      for (const value of Object.values(record)) objects(value, found);
    }
    return found;
  }

  it("compile under Ajv's strict mode", () => {
    const ajv = createAjv();
    for (const route of ROUTES) {
      for (const doc of Object.values(allResponses(route))) {
        if (doc.json !== undefined) ajv.compile(doc.json);
      }
      if (route.body !== undefined) ajv.compile(route.body);
      for (const schema of Object.values(route.query ?? {})) ajv.compile(schema);
    }
  });

  it("are closed: no response or body object takes fields it doesn't document", () => {
    // Open on purpose: openapi.json itself, an error's details, which differ
    // by code, and user data (content, fieldTypes, a filter's where).
    const open = new Set<unknown>([
      OpenApiDocument,
      (NAMED_SCHEMAS["Error"] as { properties: { error: { properties: { details: Schema } } } }).properties.error.properties.details,
      ...OPEN_SCHEMAS,
    ]);
    for (const schema of Object.values(NAMED_SCHEMAS)) {
      for (const object of objects(schema)) {
        if (open.has(object)) continue;
        expect(object["additionalProperties"], JSON.stringify(object).slice(0, 100)).toBe(false);
      }
    }
  });
});

describe("the routes Express serves", () => {
  it("are exactly the route table's", () => {
    const app = createApp({ trustProxy: false, routes: ROUTES, services: { settings: { publicUrl: "http://localhost:8080" } } as unknown as Services });
    const router = (app as unknown as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router;
    const registered = router.stack
      .filter((layer) => layer.route !== undefined)
      .flatMap((layer) => Object.keys(layer.route?.methods ?? {}).map((method) => `${method} ${layer.route?.path}`))
      .sort();
    const table = ROUTES.map((route) => `${route.method} ${expressPath(route.path)}`).sort();
    expect(registered).toEqual(table);
  });
});
