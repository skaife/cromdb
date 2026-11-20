import { existsSync } from "node:fs";
import { CAPABILITIES, INTERFACE_VERSION, OPERATION_CAPABILITY, OPERATION_NAMES, type Storage } from "../operations.js";
import { ContractContext, assert, assertEqual } from "./context.js";
import type { ContractCheck } from "./index.js";

const ALICE = { id: "alice" };

/** Inputs that aren't plain JSON or don't fit database.create's schema. */
function badCreateInputs(path: string): [string, unknown][] {
  const storage = { kind: "sqlite", path };
  class Box {
    kind = "sqlite";
    path = path;
  }
  const withSymbol = { storage, principal: ALICE, [Symbol("x")]: 1 };
  const withGetter = { storage, get principal() {
    return ALICE;
  } };
  const cycle: Record<string, unknown> = { storage, principal: ALICE };
  cycle["self"] = cycle;
  return [
    ["an unknown key", { storage, principal: ALICE, extra: 1 }],
    ["an unknown key in storage", { storage: { ...storage, extra: 1 }, principal: ALICE }],
    ["an unknown key in principal", { storage, principal: { id: "alice", extra: 1 } }],
    ["no storage", { principal: ALICE }],
    ["no principal", { storage }],
    ["an unknown storage kind", { storage: { kind: "nope" }, principal: ALICE }],
    ["a path that isn't a string", { storage: { kind: "sqlite", path: 1 }, principal: ALICE }],
    ["a replicaName that is a Date", { storage, principal: ALICE, replicaName: new Date() }],
    ["an undefined value", { storage, principal: ALICE, replicaName: undefined }],
    ["NaN", { storage, principal: { id: Number.NaN } }],
    ["a class instance", { storage: new Box(), principal: ALICE }],
    ["a symbol key", withSymbol],
    ["a getter", withGetter],
    ["a cycle", cycle],
    ["null", null],
    ["an array", [storage, ALICE]],
    ["a string", "alice"],
  ];
}

export const CORE_CHECKS: readonly ContractCheck[] = [
  {
    capabilities: [],
    name: "driver.info describes the driver",
    async run(ctx) {
      const info = await ctx.call("driver.info", {});
      assertEqual(info.interface, INTERFACE_VERSION, "interface");
      for (const name of info.capabilities) {
        assert((CAPABILITIES as readonly string[]).includes(name), `unknown capability ${JSON.stringify(name)}`);
      }
      assertEqual(new Set(info.capabilities).size, info.capabilities.length, "capabilities without repeats");
      assert(info.storage.length > 0, "at least one storage kind");
      for (const kind of Object.keys(info.storageOptions) as Storage["kind"][]) {
        assert(info.storage.includes(kind), `storageOptions for ${JSON.stringify(kind)}, a kind it doesn't handle`);
      }
      assert(info.levels.min <= info.levels.max, "levels.min <= levels.max");
      assert(info.createsLevel >= info.levels.min && info.createsLevel <= info.levels.max, "createsLevel is a level it serves");
    },
  },
  {
    capabilities: [],
    name: "an unknown operation is NOT_SUPPORTED",
    async run(ctx) {
      for (const op of ["documents.frobnicate", "", "__proto__", "toString", "constructor"]) {
        await ctx.fails("NOT_SUPPORTED", op, {}, { operation: op });
      }
    },
  },
  {
    capabilities: [],
    name: "database.create and database.info agree",
    async run(ctx) {
      const opened = await ctx.create(ALICE);
      assertEqual(opened.level, ctx.info.createsLevel, "level of a new database");
      const info = await ctx.call("database.info", { handle: opened.handle });
      assertEqual(info, { databaseId: opened.databaseId, instanceId: opened.instanceId, level: opened.level }, "database.info");
      const other = await ctx.create(ALICE);
      assert(other.handle !== opened.handle, "each database has its own handle");
      assert(other.databaseId !== opened.databaseId, "each new database has its own ID");
    },
  },
  {
    capabilities: [],
    name: "database.close ends the handle",
    async run(ctx) {
      const { handle } = await ctx.create(ALICE);
      assertEqual(await ctx.call("database.close", { handle }), {}, "database.close");
      await ctx.fails("UNKNOWN_HANDLE", "database.info", { handle });
      await ctx.fails("UNKNOWN_HANDLE", "database.close", { handle });
      await ctx.fails("UNKNOWN_HANDLE", "database.info", { handle: "no-such-handle" });
    },
  },
  {
    capabilities: [],
    name: "a database file reopens, and is open once at a time",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined) {
        return;
      }
      const storage = { kind: "sqlite" as const, path };
      const created = await ctx.call("database.create", { storage, principal: ALICE });
      await ctx.fails("ALREADY_OPEN", "database.open", { storage });
      await ctx.fails("ALREADY_OPEN", "database.create", { storage, principal: ALICE });
      await ctx.call("database.close", { handle: created.handle });
      const opened = await ctx.call("database.open", { storage });
      assertEqual(
        { databaseId: opened.databaseId, instanceId: opened.instanceId, level: opened.level },
        { databaseId: created.databaseId, instanceId: created.instanceId, level: created.level },
        "the reopened database",
      );
      await ctx.call("database.close", { handle: opened.handle });
      await ctx.fails("ALREADY_EXISTS", "database.create", { storage, principal: ALICE });
      // Refused, so the file is still free to open.
      await ctx.call("database.close", { handle: (await ctx.call("database.open", { storage })).handle });
    },
  },
  {
    capabilities: [],
    name: "an exclusive database file keeps every other opener out until it closes",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined || !(ctx.info.storageOptions["sqlite"] ?? []).includes("exclusive")) {
        return;
      }
      const storage = { kind: "sqlite" as const, path, exclusive: true };
      const created = await ctx.call("database.create", { storage, principal: ALICE });
      // Another driver, as another process would be: this one says ALREADY_OPEN first.
      const other = new ContractContext(await ctx.options.makeDriver(), ctx.info, ctx.options);
      try {
        await other.fails("STORAGE_LOCKED", "database.open", { storage });
        await ctx.call("database.close", { handle: created.handle });
        const opened = await other.call("database.open", { storage });
        assertEqual(opened.databaseId, created.databaseId, "the database, once the lock is free");
        await other.call("database.close", { handle: opened.handle });
      } finally {
        await other.driver.shutdown();
      }
    },
  },
  {
    capabilities: [],
    name: "database.open never creates a database",
    async run(ctx) {
      const path = ctx.filePath();
      if (path !== undefined) {
        await ctx.fails("NO_DATABASE", "database.open", { storage: { kind: "sqlite", path } });
        assert(!existsSync(path), "database.open made a file");
      }
      if (ctx.info.storage.includes("memory")) {
        await ctx.fails("NO_DATABASE", "database.open", { storage: { kind: "memory" } });
      }
    },
  },
  {
    capabilities: [],
    name: "a refused database.create leaves no file",
    async run(ctx) {
      const path = ctx.filePath();
      if (path === undefined) {
        return;
      }
      await ctx.fails("INVALID_PRINCIPAL", "database.create", { storage: { kind: "sqlite", path }, principal: { id: "has space" } });
      assert(!existsSync(path), "a refused database.create left a file");
    },
  },
  {
    capabilities: [],
    name: "database.create input is checked strictly",
    async run(ctx) {
      const path = ctx.filePath() ?? "unused.cromdb";
      for (const [what, input] of badCreateInputs(path)) {
        try {
          await ctx.fails("INVALID_INPUT", "database.create", input);
        } catch (error) {
          throw new Error(`with ${what}: ${(error as Error).message}`);
        }
      }
      assert(!existsSync(path), "a refused input made a file");
    },
  },
  ...CAPABILITIES.map(
    (capability): ContractCheck => ({
      capabilities: [],
      absent: capability,
      name: `without "${capability}", its operations are NOT_SUPPORTED before the input is read`,
      async run(ctx) {
        for (const op of OPERATION_NAMES.filter((name) => OPERATION_CAPABILITY[name] === capability)) {
          await ctx.fails("NOT_SUPPORTED", op, {}, { capability });
          await ctx.fails("NOT_SUPPORTED", op, { not: "valid" }, { capability });
        }
      },
    }),
  ),
];
