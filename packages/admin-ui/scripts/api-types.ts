// Writes src/api/schema.ts from the server's openapi.json: a type for each
// named schema, and for each API operation its method, path, inputs and
// responses. Pure: the caller gets the document and writes the file.
//
// It knows the JSON Schema keywords the server's schemas use, and throws on
// any other, so a schema it can't express fails here instead of being typed
// loosely.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Keywords that only narrow a value, which a TypeScript type can't say. */
const NARROWING = new Set(["description", "format", "minLength", "maxLength", "minimum", "maximum", "default", "pattern"]);
const KNOWN = new Set([...NARROWING, "$ref", "type", "const", "enum", "items", "properties", "required", "additionalProperties", "oneOf"]);

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(object: JsonObject, key: string): Json | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: Json): string {
  return JSON.stringify(value);
}

const pad = (depth: number) => "  ".repeat(depth);

/** The TypeScript type of a schema, written at an indentation depth. */
export function typeOf(schema: Json | undefined, depth: number, where: string): string {
  if (schema === undefined || schema === true) return "unknown";
  if (!isObject(schema)) throw new Error(`${where}: a schema must be an object`);
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`${where}: the keyword ${JSON.stringify(key)} is not handled`);
  }
  const ref = get(schema, "$ref");
  if (typeof ref === "string") {
    const match = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(ref);
    if (match?.[1] === undefined) throw new Error(`${where}: $ref ${ref} is not a named schema`);
    return `Schemas[${JSON.stringify(match[1])}]`;
  }
  const constant = get(schema, "const");
  if (constant !== undefined) return literal(constant);
  const choices = get(schema, "enum");
  if (Array.isArray(choices)) return choices.map(literal).join(" | ");
  const oneOf = get(schema, "oneOf");
  if (Array.isArray(oneOf)) return oneOf.map((item, i) => typeOf(item, depth, `${where}/oneOf/${i}`)).join(" | ");
  const type = get(schema, "type");
  if (Array.isArray(type)) {
    return type.map((one) => typeOf({ ...schema, type: one }, depth, where)).join(" | ");
  }
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = typeOf(get(schema, "items"), depth, `${where}/items`);
      return /^[A-Za-z0-9_[\]"]+$/.test(items) ? `${items}[]` : `(${items})[]`;
    }
    case "object":
      return objectType(schema, depth, where);
    case undefined:
      return "unknown";
    default:
      throw new Error(`${where}: type ${JSON.stringify(type)} is not handled`);
  }
}

function objectType(schema: JsonObject, depth: number, where: string): string {
  const properties = get(schema, "properties");
  const required = get(schema, "required");
  const additional = get(schema, "additionalProperties");
  const requiredNames = new Set(Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : []);
  const lines: string[] = [];
  if (isObject(properties)) {
    for (const name of Object.keys(properties)) {
      const optional = requiredNames.has(name) ? "" : "?";
      lines.push(`${pad(depth + 1)}${propertyName(name)}${optional}: ${typeOf(get(properties, name), depth + 1, `${where}/properties/${name}`)};`);
    }
  }
  if (additional !== false) {
    // Open: any other key, of the given schema's type or anything.
    lines.push(`${pad(depth + 1)}[key: string]: ${isObject(additional) ? typeOf(additional, depth + 1, `${where}/additionalProperties`) : "unknown"};`);
  }
  if (lines.length === 0) return "Record<string, never>";
  return `{\n${lines.join("\n")}\n${pad(depth)}}`;
}

interface Parameter {
  readonly name: string;
  readonly in: string;
  readonly schema: Json;
}

/** The whole of src/api/schema.ts for an openapi.json. */
export function generate(document: JsonObject): string {
  const components = get(document, "components");
  const schemas = isObject(components) ? get(components, "schemas") : undefined;
  const paths = get(document, "paths");
  if (!isObject(schemas) || !isObject(paths)) throw new Error("openapi.json has no components.schemas or paths");

  const out: string[] = [
    "// Generated from the server's openapi.json by scripts/gen-api.ts. Don't edit it:",
    '// after changing the route table, run "npm run gen:api -w @cromdb/admin-ui".',
    "// A test fails while it differs from what the route table gives.",
    "",
    "export interface Schemas {",
  ];
  for (const name of Object.keys(schemas)) {
    out.push(`  ${propertyName(name)}: ${typeOf(get(schemas, name), 1, `#/components/schemas/${name}`)};`);
  }
  out.push("}", "");

  const operations: { id: string; method: string; path: string; ifMatch: boolean; text: string[] }[] = [];
  for (const path of Object.keys(paths)) {
    if (!path.startsWith("/api/")) continue;
    const item = get(paths, path);
    if (!isObject(item)) continue;
    for (const method of Object.keys(item)) {
      const operation = get(item, method);
      if (!isObject(operation)) continue;
      const id = get(operation, "operationId");
      if (typeof id !== "string") throw new Error(`${method} ${path} has no operationId`);
      const where = `${method.toUpperCase()} ${path}`;
      const parameters = (Array.isArray(get(operation, "parameters")) ? (get(operation, "parameters") as Json[]) : []) as unknown as Parameter[];
      const pathParams = parameters.filter((p) => p.in === "path");
      const query = parameters.filter((p) => p.in === "query");
      const ifMatch = parameters.some((p) => p.in === "header" && p.name === "If-Match");
      const requestBody = get(operation, "requestBody");
      let body = "undefined";
      if (isObject(requestBody)) {
        const content = get(requestBody, "content");
        const json = isObject(content) ? get(content, "application/json") : undefined;
        body = typeOf(isObject(json) ? get(json, "schema") : undefined, 2, `${where} body`);
      }
      const responses = get(operation, "responses");
      const responseLines: string[] = [];
      if (isObject(responses)) {
        for (const status of Object.keys(responses)) {
          const response = get(responses, status);
          const content = isObject(response) ? get(response, "content") : undefined;
          const json = isObject(content) ? get(content, "application/json") : undefined;
          const type = isObject(json) ? typeOf(get(json, "schema"), 3, `${where} ${status}`) : "undefined";
          responseLines.push(`      ${status}: ${type};`);
        }
      }
      const params = pathParams.length === 0 ? "Record<string, never>" : `{ ${pathParams.map((p) => `${propertyName(p.name)}: string;`).join(" ")} }`;
      const queryType =
        query.length === 0 ? "Record<string, never>" : `{\n${query.map((p) => `      ${propertyName(p.name)}?: ${typeOf(p.schema, 3, `${where} ?${p.name}`)};`).join("\n")}\n    }`;
      operations.push({
        id,
        method,
        path,
        ifMatch,
        text: [
          `  ${propertyName(id)}: {`,
          `    params: ${params};`,
          `    query: ${queryType};`,
          `    body: ${body};`,
          `    ifMatch: ${ifMatch};`,
          "    responses: {",
          ...responseLines,
          "    };",
          "  };",
        ],
      });
    }
  }

  out.push("/** Each API operation's method and path. */", "export const OPERATIONS = {");
  for (const op of operations) {
    out.push(`  ${propertyName(op.id)}: { method: ${JSON.stringify(op.method.toUpperCase())}, path: ${JSON.stringify(op.path)}, ifMatch: ${op.ifMatch} },`);
  }
  out.push("} as const;", "", "export interface Operations {");
  for (const op of operations) out.push(...op.text);
  out.push("}", "");
  return out.join("\n");
}
