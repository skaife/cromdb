// Proves the contract suite catches a misbehaving driver: each mutant wraps
// the level-3 driver with one deliberate fault, and the named check must fail
// for it. The unchanged wrapper passes every check.

import { afterAll, describe, expect, it } from "vitest";
import { DriverError, SCHEMAS, isOperationName, type Driver, type DriverInfo } from "@cromdb/driver";
import { runContractChecks } from "@cromdb/driver/contract";
import { contractOptions, tempDir } from "./helpers.js";

type Next = (op: string, input: unknown) => Promise<unknown>;
type Around = (op: string, input: unknown, next: Next) => Promise<unknown>;

function mutate(around: Around) {
  return (driver: Driver): Driver => {
    const callByName = (op: string, input: unknown) => around(op, input, (o, i) => driver.callByName(o, i));
    return { call: callByName as Driver["call"], callByName, shutdown: () => driver.shutdown() };
  };
}

type Record_ = Record<string, unknown>;
const record = (value: unknown) => value as Record_;

async function codeOf(promise: Promise<unknown>): Promise<{ code?: string; value?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { code: (error as DriverError).code };
  }
}

/** Sets the value at a JSON Pointer to a Date. */
function dateAt(content: Record_, pointer: string): void {
  const segments = pointer.split("/").slice(1).map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  const last = segments.pop();
  let at: unknown = content;
  for (const segment of segments) at = record(at)[segment];
  if (last !== undefined && typeof at === "object" && at !== null) {
    const holder = record(at);
    holder[last] = new Date(String(holder[last]));
  }
}

const MUTANTS: readonly { readonly fault: string; readonly caughtBy: string; readonly around: Around }[] = [
  {
    fault: "ignores input keys it doesn't know",
    caughtBy: "database.create input is checked strictly",
    around: (op, input, next) => {
      if (isOperationName(op) && typeof input === "object" && input !== null && !Array.isArray(input)) {
        const known = Object.keys(record(SCHEMAS[op].input)["properties"] as Record_);
        return next(op, Object.fromEntries(Object.entries(input).filter(([key]) => known.includes(key))));
      }
      return next(op, input);
    },
  },
  {
    fault: "skips the ifVersion check on save",
    caughtBy: "documents are created, read, saved and deleted with versions",
    around: async (op, input, next) => {
      if (op === "documents.save") {
        const { handle, principal, id } = record(input);
        const current = record(await next("documents.get", { handle, principal, id }))["document"];
        if (current !== null) {
          return next(op, { ...record(input), ifVersion: record(current)["version"] });
        }
      }
      return next(op, input);
    },
  },
  {
    fault: "drops noAccess in acl.save, keeping the stored list",
    caughtBy: "the database's lists bound every document's, and noAccess overrides them",
    around: async (op, input, next) => {
      if (op === "acl.save") {
        const { handle, principal } = record(input);
        const stored = record(record(await next("acl.get", { handle, principal }))["acl"]);
        return next(op, { ...record(input), noAccess: stored["noAccess"] });
      }
      return next(op, input);
    },
  },
  {
    fault: "says every principal can see the database",
    caughtBy: "creators, readers and writers are enforced",
    around: async (op, input, next) => {
      const output = await next(op, input);
      return op === "access.mine" ? { ...record(output), visible: true } : output;
    },
  },
  {
    fault: "returns the old two-list ACL",
    caughtBy: "the ACL is read and saved with versions, by admins only",
    around: async (op, input, next) => {
      const output = await next(op, input);
      if (op === "acl.get" || op === "acl.save") {
        const { writers: _w, readers: _r, noAccess: _n, ...rest } = record(record(output)["acl"]);
        return { acl: rest };
      }
      return output;
    },
  },
  {
    fault: "returns a Date in content",
    caughtBy: "datetimes and any content keys round-trip",
    around: async (op, input, next) => {
      const output = await next(op, input);
      const document = op === "documents.get" ? record(output)["document"] : undefined;
      if (document !== undefined && document !== null) {
        const [pointer] = Object.keys(record(record(document)["fieldTypes"]));
        if (pointer !== undefined) dateAt(record(record(document)["content"]), pointer);
      }
      return output;
    },
  },
  {
    fault: "reports a known engine code as INTERNAL",
    caughtBy: "documents are created, read, saved and deleted with versions",
    around: async (op, input, next) => {
      try {
        return await next(op, input);
      } catch (error) {
        if ((error as DriverError).code === "STALE_DOCUMENT") throw new DriverError("INTERNAL", (error as Error).message);
        throw error;
      }
    },
  },
  {
    fault: "turns NOT_SUPPORTED into an empty success",
    caughtBy: "an unknown operation is NOT_SUPPORTED",
    around: async (op, input, next) => {
      const result = await codeOf(next(op, input));
      if (result.code === "NOT_SUPPORTED") return {};
      if (result.code !== undefined) return next(op, input);
      return result.value;
    },
  },
  {
    fault: 'declares "tickets" but refuses replicas.register',
    caughtBy: "tickets are for admins and are checked",
    around: (op, input, next) => {
      if (op === "replicas.register") {
        throw new DriverError("NOT_SUPPORTED", "no tickets here", { capability: "tickets" });
      }
      return next(op, input);
    },
  },
  {
    fault: 'leaves "conflicts" undeclared but serves it',
    caughtBy: 'without "conflicts", its operations are NOT_SUPPORTED before the input is read',
    around: async (op, input, next) => {
      const output = await next(op, input);
      if (op === "driver.info") {
        const info = output as DriverInfo;
        return { ...info, capabilities: info.capabilities.filter((name) => name !== "conflicts") };
      }
      return output;
    },
  },
  {
    fault: "adds a field to its output",
    caughtBy: "documents are created, read, saved and deleted with versions",
    around: async (op, input, next) => {
      const output = await next(op, input);
      return op === "documents.get" ? { ...record(output), cached: true } : output;
    },
  },
  {
    fault: "find ignores where",
    caughtBy: "find filters by parent, top level, orphans and where",
    around: (op, input, next) => {
      if (op === "documents.find" && record(input)["filter"] !== undefined) {
        const { where: _where, whereTypes: _types, ...filter } = record(record(input)["filter"]);
        return next(op, { ...record(input), filter });
      }
      return next(op, input);
    },
  },
  {
    fault: "drops the last document of each page that has a next",
    caughtBy: "find pages through every document once",
    around: async (op, input, next) => {
      const output = await next(op, input);
      if (op === "documents.find" && record(output)["next"] !== null) {
        return { ...record(output), documents: (record(output)["documents"] as unknown[]).slice(0, -1) };
      }
      return output;
    },
  },
  {
    fault: "returns the old version after a save",
    caughtBy: "documents are created, read, saved and deleted with versions",
    around: async (op, input, next) => {
      const output = await next(op, input);
      if (op === "documents.save") {
        const document = { ...record(record(output)["document"]), version: record(input)["ifVersion"] };
        return { ...record(output), document };
      }
      return output;
    },
  },
  {
    fault: "lets a non-admin export changes",
    caughtBy: "sync is for admins, and the engine checks what arrives",
    around: async (op, input, next) => {
      const result = await codeOf(next(op, input));
      if (op === "sync.export" && result.code === "ACCESS_DENIED") return { batch: {} };
      if (result.code !== undefined) return next(op, input);
      return result.value;
    },
  },
  {
    fault: "database.open creates a database when there is none",
    caughtBy: "database.open never creates a database",
    around: async (op, input, next) => {
      const result = await codeOf(next(op, input));
      if (op === "database.open" && result.code === "NO_DATABASE") {
        return next("database.create", { storage: record(input)["storage"], principal: { id: "mutant" } });
      }
      if (result.code !== undefined) return next(op, input);
      return result.value;
    },
  },
  {
    fault: "returns every version from conflicts.get, readable or not",
    caughtBy: "unreadable conflict versions stay in conflict",
    around: (() => {
      // Reads each conflict with the rights of whoever made the database, an admin who reads everything here.
      const makers = new Map<unknown, unknown>();
      return async (op: string, input: unknown, next: Next) => {
        if (op === "conflicts.get") {
          return next(op, { ...record(input), principal: makers.get(record(input)["handle"]) ?? record(input)["principal"] });
        }
        const output = await next(op, input);
        if (op === "database.create" || op === "database.createFromTicket") {
          makers.set(record(output)["handle"], record(input)["principal"]);
        }
        return output;
      };
    })(),
  },
  {
    fault: "database.close leaves the handle open",
    caughtBy: "database.close ends the handle",
    around: (op, input, next) => (op === "database.close" ? Promise.resolve({}) : next(op, input)),
  },
];

const dir = tempDir();
afterAll(() => dir.remove());

describe("the contract suite", () => {
  it("passes the level-3 driver through an unchanged wrapper", async () => {
    const results = await runContractChecks(contractOptions(dir, mutate((op, input, next) => next(op, input)), 5));
    expect(results.filter((result) => result.error !== undefined).map((result) => result.name)).toEqual([]);
  }, 60_000);

  for (const mutant of MUTANTS) {
    it(`catches a driver that ${mutant.fault}`, async () => {
      const results = await runContractChecks(contractOptions(dir, mutate(mutant.around), 5));
      const failed = results.filter((result) => result.error !== undefined).map((result) => result.name);
      expect(failed).toContain(mutant.caughtBy);
    }, 60_000);
  }
});
