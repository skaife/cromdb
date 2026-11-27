// The contract suite: what every driver must do, whatever its engine. Each
// check is a plain async function, so it can run under any test runner (see
// registerContractTests) or directly (see runContractChecks).

import type { Capability, DriverInfo } from "../operations.js";
import { ContractContext, type ContractOptions } from "./context.js";
import { CORE_CHECKS } from "./core.js";
import { DOCUMENT_CHECKS } from "./documents.js";
import { COMPACT_CHECKS, PURGE_CHECKS, RAISE_CHECKS } from "./purge.js";
import { BACKUP_CHECKS, RECOVER_CHECKS, RETIRE_CHECKS, SPACE_CHECKS, STATE_CHECKS } from "./recovery.js";
import { ACL_CHECKS, REPLICATION_CHECKS } from "./replication.js";

export { ContractContext, type ContractOptions } from "./context.js";

export interface ContractCheck {
  /** Runs only when the driver declares all of these. */
  readonly capabilities: readonly Capability[];
  /** Runs only when the driver does NOT declare this one. */
  readonly absent?: Capability;
  readonly name: string;
  run(ctx: ContractContext): Promise<void>;
}

export const CONTRACT_CHECKS: readonly ContractCheck[] = [
  ...CORE_CHECKS,
  ...DOCUMENT_CHECKS,
  ...ACL_CHECKS,
  ...REPLICATION_CHECKS,
  ...PURGE_CHECKS,
  ...COMPACT_CHECKS,
  ...RAISE_CHECKS,
  ...BACKUP_CHECKS,
  ...RECOVER_CHECKS,
  ...RETIRE_CHECKS,
  ...STATE_CHECKS,
  ...SPACE_CHECKS,
];

/** Whether the check applies to a driver with this info. */
export function applies(check: ContractCheck, info: DriverInfo): boolean {
  const declared = new Set(info.capabilities);
  return check.capabilities.every((capability) => declared.has(capability)) && (check.absent === undefined || !declared.has(check.absent));
}

/** Runs one check with a new driver, shut down afterward. Resolves to false if the check doesn't apply. */
export async function runContractCheck(check: ContractCheck, options: ContractOptions): Promise<boolean> {
  const driver = await options.makeDriver();
  try {
    const info = (await driver.call("driver.info", {})) as DriverInfo;
    if (!applies(check, info)) {
      return false;
    }
    await check.run(new ContractContext(driver, info, options));
    return true;
  } finally {
    await driver.shutdown();
  }
}

export interface CheckResult {
  readonly name: string;
  readonly ran: boolean;
  readonly error?: unknown;
}

/** Runs every check, each with its own driver, and reports each one. */
export async function runContractChecks(options: ContractOptions): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CONTRACT_CHECKS) {
    try {
      results.push({ name: check.name, ran: await runContractCheck(check, options) });
    } catch (error) {
      results.push({ name: check.name, ran: true, error });
    }
  }
  return results;
}

/**
 * The parts of a test runner the suite needs, as in vitest. If the runner
 * passes a context with skip, as vitest does, a check that doesn't apply to
 * the driver is reported as skipped.
 */
export interface TestApi {
  describe(name: string, fn: () => void): unknown;
  it(name: string, fn: (context: { skip(): void }) => Promise<void>, timeout?: number): unknown;
}

/**
 * Registers every check as a test. A check that doesn't apply to the driver
 * is skipped, or passes without running if the runner can't skip.
 */
export function registerContractTests(test: TestApi, name: string, options: ContractOptions, timeout = 60_000): void {
  test.describe(`driver contract: ${name}`, () => {
    for (const check of CONTRACT_CHECKS) {
      test.it(
        check.name,
        async (context) => {
          if (!(await runContractCheck(check, options))) {
            context?.skip?.();
          }
        },
        timeout,
      );
    }
  });
}
