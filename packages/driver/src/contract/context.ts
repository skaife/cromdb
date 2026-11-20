import { AssertionError } from "node:assert/strict";
import type { Driver } from "../base.js";
import { isKnownErrorCode, type DriverError } from "../errors.js";
import { isPlainJson } from "../json.js";
import {
  isOperationName,
  type AclData,
  type AclLists,
  type Capability,
  type DriverInfo,
  type Input,
  type OperationName,
  type Output,
  type Principal,
  type Storage,
} from "../operations.js";
import { checkOutput } from "../validate.js";

/** What a driver's test file gives the contract suite. */
export interface ContractOptions {
  /** A new driver for each check. Each is shut down after its check. */
  makeDriver(): Driver | Promise<Driver>;
  /** New, empty storage of a kind the driver handles, for each database a check makes. */
  freshStorage(): Storage;
  /**
   * A path where no file exists yet, in a directory that does, for checks of
   * database files. Leave it out if the driver doesn't handle "sqlite"
   * storage; those checks then pass without running.
   */
  freshFilePath?(): string;
  /** Runs for each property-based check (default 20). */
  numRuns?: number;
}

/** What each check runs with: one driver, its info, and checked calls. */
export class ContractContext {
  readonly driver: Driver;
  readonly info: DriverInfo;
  readonly options: ContractOptions;
  readonly numRuns: number;

  constructor(driver: Driver, info: DriverInfo, options: ContractOptions) {
    this.driver = driver;
    this.info = info;
    this.options = options;
    this.numRuns = options.numRuns ?? 20;
  }

  has(capability: Capability): boolean {
    return this.info.capabilities.includes(capability);
  }

  storage(): Storage {
    return this.options.freshStorage();
  }

  filePath(): string | undefined {
    return this.options.freshFilePath?.();
  }

  /**
   * Calls the driver and checks what comes back: an output must fit the
   * operation's output schema exactly and be plain JSON; an error must be
   * shaped like a DriverError with a known code, or an unknown one marked
   * details.known false.
   */
  async call<Op extends OperationName>(op: Op, input: NoInfer<Input<Op>>): Promise<Output<Op>> {
    return (await this.#checked(op, () => this.driver.call(op, input))) as Output<Op>;
  }

  /** As call, through Driver.callByName, for any name and input, as a server dispatching by name would. */
  async callByName(op: string, input: unknown): Promise<unknown> {
    return this.#checked(op, () => this.driver.callByName(op, input));
  }

  async #checked(op: string, run: () => Promise<unknown>): Promise<unknown> {
    let output: unknown;
    try {
      output = await run();
    } catch (error) {
      checkErrorShape(op, error);
      throw error;
    }
    if (isOperationName(op)) {
      const problem = checkOutput(op, output);
      if (problem !== undefined) {
        throw new AssertionError({ message: problem });
      }
    }
    return output;
  }

  /** Expects the call to fail with this code and, if given, these details. */
  async fails(code: string, op: string, input: unknown, details?: Readonly<Record<string, unknown>>): Promise<DriverError> {
    let output: unknown;
    try {
      output = await this.callByName(op, input);
    } catch (error) {
      const failed = error as DriverError;
      if (failed.code !== code) {
        throw new AssertionError({
          message: `${op} failed with ${String(failed.code)} (${String(failed.message)}), expected ${code}`,
        });
      }
      for (const [key, value] of Object.entries(details ?? {})) {
        if (failed.details?.[key] !== value) {
          throw new AssertionError({
            message: `${op} failed with ${code} but details.${key} is ${JSON.stringify(failed.details?.[key])}, expected ${JSON.stringify(value)}`,
          });
        }
      }
      return failed;
    }
    throw new AssertionError({ message: `${op} succeeded with ${JSON.stringify(output)}, expected ${code}` });
  }

  /** A new database made by principal, on fresh storage. */
  async create(principal: Principal): Promise<Output<"database.create">> {
    return this.call("database.create", { storage: this.storage(), principal });
  }

  /** Changes the lists given in the database's ACL, as admin, keeping the others. */
  async setAcl(admin: { handle: string; principal: Principal }, lists: Partial<AclLists>): Promise<AclData> {
    const { acl } = await this.call("acl.get", admin);
    const { admins, creators, writers, readers, noAccess } = { ...acl, ...lists };
    return (await this.call("acl.save", { ...admin, ifVersion: acl.version, admins, creators, writers, readers, noAccess })).acl;
  }
}

function checkErrorShape(op: string, error: unknown): void {
  const fail = (problem: string) => {
    throw new AssertionError({ message: `${op} rejected with ${problem}: ${String(error)}` });
  };
  if (!(error instanceof Error)) {
    fail("something that isn't an Error");
  }
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (typeof code !== "string") {
    fail("an error without a string code");
  }
  if (details !== undefined && (typeof details !== "object" || details === null || Array.isArray(details) || !isPlainJson(details))) {
    fail("details that aren't a plain JSON object");
  }
  const known = (details as { known?: unknown } | undefined)?.known;
  if (!isKnownErrorCode(code as string) && known !== false) {
    fail(`the unknown code ${String(code)} without details.known false`);
  }
  if (isKnownErrorCode(code as string) && known === false) {
    fail(`the known code ${String(code)} marked details.known false`);
  }
}

export function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(sortKeys(actual)) !== JSON.stringify(sortKeys(expected))) {
    throw new AssertionError({ message: `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` });
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError({ message });
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return Object.fromEntries(keys.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}
