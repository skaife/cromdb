// Checking request bodies and query parameters against the route table's
// schemas, with Ajv. Compiled once per schema.

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isIsoTime } from "../text.js";
import { ApiError } from "./errors.js";
import type { Schema } from "./schemas.js";

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: false, allowUnionTypes: true });
  ajv.addFormat("date-time", { type: "string", validate: isIsoTime });
  return ajv;
}

const ajv = createAjv();
const compiled = new Map<Schema, ValidateFunction>();

function validator(schema: Schema): ValidateFunction {
  let found = compiled.get(schema);
  if (found === undefined) {
    found = ajv.compile(schema);
    compiled.set(schema, found);
  }
  return found;
}

function pointerPart(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Where the first problem is (a JSON Pointer) and what it is. */
export function explain(error: ErrorObject | undefined): { path: string; problem: string } {
  if (error === undefined) {
    return { path: "", problem: "is not valid" };
  }
  if (error.keyword === "additionalProperties") {
    return { path: `${error.instancePath}/${pointerPart(String((error.params as { additionalProperty: unknown }).additionalProperty))}`, problem: "is not allowed" };
  }
  if (error.keyword === "required") {
    return { path: `${error.instancePath}/${pointerPart(String((error.params as { missingProperty: unknown }).missingProperty))}`, problem: "is required" };
  }
  return { path: error.instancePath, problem: error.message ?? "is not valid" };
}

/** Throws INVALID_INPUT unless body fits schema. details.path is a JSON Pointer into the body. */
export function checkBody(schema: Schema, body: unknown): void {
  if (body === undefined) {
    throw new ApiError("INVALID_INPUT", "The request needs a JSON body", { path: "" });
  }
  const validate = validator(schema);
  if (!validate(body)) {
    // A body with several forms: the first error is about the first form,
    // which may not be the one meant, so name them all.
    if (typeof schema["description"] === "string" && (validate.errors ?? []).some((error) => error.keyword === "oneOf" && error.instancePath === "")) {
      throw new ApiError("INVALID_INPUT", `The body must be ${schema["description"]}`, { path: "" });
    }
    const { path, problem } = explain(validate.errors?.[0] ?? undefined);
    throw new ApiError("INVALID_INPUT", `The body at "${path}" ${problem}`, { path });
  }
}

/**
 * The query parameters as their schemas' types (integers from text), or
 * INVALID_INPUT naming the parameter: unknown, repeated, or not fitting.
 */
export function checkQuery(schemas: Readonly<Record<string, Schema>>, query: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(query)) {
    if (!Object.hasOwn(schemas, name)) {
      throw new ApiError("INVALID_INPUT", `Unknown query parameter ${JSON.stringify(name)}`, { parameter: name });
    }
    const schema = schemas[name] as Schema;
    if (typeof raw !== "string") {
      throw new ApiError("INVALID_INPUT", `The query parameter ${JSON.stringify(name)} must be given once`, { parameter: name });
    }
    const value = schema["type"] === "integer" && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
    const validate = validator(schema);
    if (!validate(value)) {
      throw new ApiError("INVALID_INPUT", `The query parameter ${JSON.stringify(name)} ${explain(validate.errors?.[0] ?? undefined).problem}`, { parameter: name });
    }
    values[name] = value;
  }
  return values;
}
