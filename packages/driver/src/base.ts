import { DriverError } from "./errors.js";
import { copyJson, type JsonValue } from "./json.js";
import {
  CAPABILITIES,
  isOperationName,
  OPERATION_CAPABILITY,
  type Capability,
  type DriverInfo,
  type Input,
  type OperationName,
  type Output,
} from "./operations.js";
import { validateInput } from "./validate.js";

/**
 * What the server calls. Every call is async and message-shaped: plain JSON
 * in, plain JSON out, and errors are DriverError.
 */
export interface Driver {
  call<Op extends OperationName>(op: Op, input: NoInfer<Input<Op>>): Promise<Output<Op>>;
  /**
   * The same as call, for dispatching by a name known only at run time. (Not
   * an overload of call: TypeScript would then pick this signature for typed
   * calls whose input leaves out an optional field.)
   */
  callByName(op: string, input: unknown): Promise<unknown>;
  /** Closes every open database. Calls after this fail with UNKNOWN_HANDLE. */
  shutdown(): Promise<void>;
}

export type Handlers = { readonly [Op in OperationName]?: (input: Input<Op>) => Promise<Output<Op>> };

/** What a driver package supplies to createDriver. */
export interface DriverImplementation {
  /** What driver.info answers. capabilities must be names from CAPABILITIES. */
  readonly info: DriverInfo;
  /** One handler per operation of each declared capability, and of core. */
  readonly handlers: Handlers;
  /**
   * Turns anything a handler throws that isn't a DriverError into one, as
   * the engine's errors map (see engineError). Return undefined for INTERNAL.
   */
  mapError(error: unknown): DriverError | undefined;
  shutdown(): Promise<void>;
}

function toDriverError(error: unknown, impl: DriverImplementation): DriverError {
  if (error instanceof DriverError) {
    return error;
  }
  const mapped = impl.mapError(error);
  if (mapped !== undefined) {
    return mapped;
  }
  return new DriverError("INTERNAL", error instanceof Error ? error.message : String(error));
}

/**
 * The Driver every driver package returns, around its implementation. It
 * refuses an unknown operation, or one whose capability the driver doesn't
 * declare, with NOT_SUPPORTED, before looking at the input. Then it checks
 * the input strictly (INVALID_INPUT), hands the handler its own copy, and
 * turns whatever the handler throws into a DriverError.
 */
export function createDriver(impl: DriverImplementation): Driver {
  const declared = new Set<string>(impl.info.capabilities);
  for (const name of declared) {
    if (!(CAPABILITIES as readonly string[]).includes(name)) {
      throw new Error(`Unknown capability ${JSON.stringify(name)}`);
    }
  }
  const info = copyJson(impl.info as unknown as JsonValue) as unknown as DriverInfo;
  const handlers: Handlers = { ...impl.handlers, "driver.info": async () => copyJson(info as unknown as JsonValue) as unknown as DriverInfo };

  async function call(op: string, input: unknown): Promise<unknown> {
    if (!isOperationName(op)) {
      throw new DriverError("NOT_SUPPORTED", `${JSON.stringify(op)} is not an operation of this interface`, {
        operation: op,
      });
    }
    const capability: Capability | "core" = OPERATION_CAPABILITY[op];
    if (capability !== "core" && !declared.has(capability)) {
      throw new DriverError("NOT_SUPPORTED", `${op} needs the capability "${capability}", which this driver doesn't have`, {
        operation: op,
        capability,
      });
    }
    validateInput(op, input);
    const handler = handlers[op] as ((input: unknown) => Promise<unknown>) | undefined;
    if (handler === undefined) {
      throw new DriverError("INTERNAL", `This driver declares "${capability}" but has no handler for ${op}`);
    }
    try {
      return await handler(copyJson(input as JsonValue));
    } catch (error) {
      throw toDriverError(error, impl);
    }
  }

  return {
    call: call as Driver["call"],
    callByName: call,
    async shutdown() {
      try {
        await impl.shutdown();
      } catch (error) {
        throw toDriverError(error, impl);
      }
    },
  };
}
