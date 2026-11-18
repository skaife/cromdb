import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { DriverError } from "./errors.js";
import { checkPlainJson } from "./json.js";
import { OPERATION_NAMES, type OperationName } from "./operations.js";
import { SCHEMAS } from "./schemas.js";

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, discriminator: true, allErrors: false });

interface Validators {
  readonly input: ValidateFunction;
  readonly output: ValidateFunction;
}

// Compiled once, when the module loads.
const VALIDATORS = new Map<OperationName, Validators>(
  OPERATION_NAMES.map((op) => [op, { input: ajv.compile(SCHEMAS[op].input), output: ajv.compile(SCHEMAS[op].output) }]),
);

function validators(op: OperationName): Validators {
  const found = VALIDATORS.get(op);
  if (found === undefined) {
    throw new Error(`No schemas for ${op}`);
  }
  return found;
}

/** One line for the first schema error, naming where it is as a JSON Pointer. */
function explain(what: string, error: ErrorObject | undefined): { message: string; path: string } {
  if (error === undefined) {
    return { message: `${what} is not valid`, path: "" };
  }
  let path = error.instancePath;
  let problem = error.message ?? "is not valid";
  if (error.keyword === "additionalProperties") {
    const extra = String((error.params as { additionalProperty: unknown }).additionalProperty);
    path = `${path}/${extra.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    problem = "is not allowed here";
  } else if (error.keyword === "required") {
    const missing = String((error.params as { missingProperty: unknown }).missingProperty);
    path = `${path}/${missing.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    problem = "is required";
  }
  return { message: `${what} at "${path}" ${problem}`, path };
}

/**
 * Throws INVALID_INPUT unless input is plain JSON that fits the operation's
 * input schema. details.path is a JSON Pointer to the first problem.
 */
export function validateInput(op: OperationName, input: unknown): void {
  checkPlainJson(input);
  const validate = validators(op).input;
  if (!validate(input)) {
    const { message, path } = explain(`${op} input`, validate.errors?.[0] ?? undefined);
    throw new DriverError("INVALID_INPUT", message, { path });
  }
}

/**
 * Whether output is plain JSON that fits the operation's output schema
 * exactly; if not, what is wrong. For tests: a driver's outputs aren't
 * checked at run time.
 */
export function checkOutput(op: OperationName, output: unknown): string | undefined {
  try {
    checkPlainJson(output);
  } catch (error) {
    return `${op} output is not plain JSON: ${(error as Error).message.replace(/^the input|^input/, "output")}`;
  }
  const validate = validators(op).output;
  if (!validate(output)) {
    return explain(`${op} output`, validate.errors?.[0] ?? undefined).message;
  }
  return undefined;
}
