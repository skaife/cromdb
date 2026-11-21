// @vitest-environment node
// src/api/schema.ts must be what the route table gives today: after changing
// a route, run "npm run gen:api -w @cromdb/admin-ui". Needs the server built.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, typeOf } from "../scripts/api-types.ts";
import { serverOpenApi } from "../scripts/server-openapi.ts";

describe("the API types", () => {
  it("are what the server's route table gives", async () => {
    const committed = readFileSync(join(import.meta.dirname, "..", "src", "api", "schema.ts"), "utf8");
    expect(generate(await serverOpenApi()), 'src/api/schema.ts is out of date: run "npm run gen:api -w @cromdb/admin-ui"').toBe(committed);
  });

  it("write each kind of schema as its type", () => {
    expect(typeOf({ type: ["string", "null"] }, 0, "x")).toBe("string | null");
    expect(typeOf({ enum: ["a", "b"] }, 0, "x")).toBe('"a" | "b"');
    expect(typeOf({ const: true }, 0, "x")).toBe("true");
    expect(typeOf({ type: "array", items: { $ref: "#/components/schemas/Person" } }, 0, "x")).toBe('Schemas["Person"][]');
    expect(typeOf({ type: "array", items: { type: ["string", "null"] } }, 0, "x")).toBe("(string | null)[]");
    expect(typeOf({ type: "object" }, 0, "x")).toBe("{\n  [key: string]: unknown;\n}");
    expect(typeOf({ type: "object", properties: { "a-b": { type: "integer" } }, required: [], additionalProperties: false }, 0, "x")).toBe('{\n  "a-b"?: number;\n}');
  });

  it("refuse a schema they can't express", () => {
    expect(() => typeOf({ type: "string", allOf: [] }, 0, "#/x")).toThrow('#/x: the keyword "allOf" is not handled');
    expect(() => typeOf({ $ref: "https://elsewhere" }, 0, "#/x")).toThrow("is not a named schema");
  });
});
