import { describe, expect, it } from "vitest";
import { CAPABILITIES, checkOutput, OPERATION_CAPABILITY, OPERATION_NAMES, SCHEMAS, validateInput } from "../src/index.js";
import { content, enginePayload, fieldTypes } from "../src/schemas.js";

type Node = Record<string, unknown>;

/** Every object schema in a schema, by path. */
function objects(schema: unknown, path: string, out: [string, Node][] = []): [string, Node][] {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => objects(item, `${path}/${index}`, out));
  } else if (typeof schema === "object" && schema !== null) {
    const node = schema as Node;
    if (node["type"] === "object") {
      out.push([path, node]);
    }
    for (const [key, value] of Object.entries(node)) {
      objects(value, `${path}/${key}`, out);
    }
  }
  return out;
}

describe("schemas", () => {
  it("cover every operation, and every capability has operations", () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...OPERATION_NAMES].sort());
    for (const capability of CAPABILITIES) {
      expect(OPERATION_NAMES.some((op) => OPERATION_CAPABILITY[op] === capability)).toBe(true);
    }
  });

  it("close every object except content, fieldTypes, where and engine payloads", () => {
    for (const op of OPERATION_NAMES) {
      for (const side of ["input", "output"] as const) {
        for (const [path, node] of objects(SCHEMAS[op][side], `${op}.${side}`)) {
          if (Array.isArray(node["oneOf"])) {
            // Its branches are closed; it only picks one by a tag.
            expect(node["additionalProperties"], path).toBeUndefined();
          } else if (node === content || node === enginePayload) {
            expect(node["additionalProperties"], path).toBeUndefined();
          } else if (node === fieldTypes || path.endsWith("/where")) {
            expect(typeof node["additionalProperties"], path).toBe("object");
          } else {
            expect(node["additionalProperties"], path).toBe(false);
          }
        }
      }
    }
  });

  it("check outputs exactly", () => {
    expect(checkOutput("database.info", { databaseId: "d", instanceId: "i", level: 2 })).toBeUndefined();
    expect(checkOutput("database.info", { databaseId: "d", instanceId: "i", level: 2, extra: 1 })).toMatch(/"\/extra" is not allowed/);
    expect(checkOutput("database.info", { databaseId: "d", instanceId: "i" })).toMatch(/"\/level" is required/);
    expect(checkOutput("sync.hello", { hello: { when: new Date() } })).toMatch(/not plain JSON/);
    expect(checkOutput("documents.find", { documents: [], next: null })).toBeUndefined();
  });

  it("name the field at fault in a storage descriptor", () => {
    const cases: [unknown, string][] = [
      [{ kind: "memory", path: "x" }, "/storage/path"],
      [{ kind: "sqlite" }, "/storage/path"],
      [{ kind: "sqlite", path: "" }, "/storage/path"],
      [{ kind: "nope" }, "/storage"],
      [{ path: "x" }, "/storage"],
    ];
    for (const [storage, path] of cases) {
      expect(() => validateInput("database.open", { storage })).toThrow(expect.objectContaining({ code: "INVALID_INPUT", details: { path } }));
    }
  });
});
