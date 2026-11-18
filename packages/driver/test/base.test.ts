import { describe, expect, it } from "vitest";
import { createDriver, DriverError, engineError, type DriverImplementation, type DriverInfo, type Handlers } from "../src/index.js";

const INFO: DriverInfo = {
  interface: 0,
  driver: { name: "fake", version: "0.0.0" },
  engine: { name: "none", version: "0.0.0" },
  levels: { min: 2, max: 2 },
  createsLevel: 2,
  capabilities: ["documents"],
  storage: ["memory"],
};

/** Stands for an engine's own error class. */
class FakeEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const seen: unknown[] = [];

function fake(handlers: Handlers = {}, info: DriverInfo = INFO): ReturnType<typeof createDriver> {
  const impl: DriverImplementation = {
    info,
    handlers: {
      "documents.get": async (input) => {
        seen.push(input);
        switch (input.id) {
          case "unknown-code":
            throw new FakeEngineError("FUTURE_CODE", "from a later engine");
          case "known-code":
            throw new FakeEngineError("STALE_DOCUMENT", "changed");
          case "plain":
            throw new Error("boom");
          case "driver-error":
            throw new DriverError("NOT_FOUND", "as thrown", { why: "test" });
          case "slow":
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { document: null };
          default:
            (input as { id: string }).id = "changed by the handler";
            return { document: null };
        }
      },
      ...handlers,
    },
    mapError: (error) => (error instanceof FakeEngineError ? engineError(error.code, error.message) : undefined),
    shutdown: async () => {},
  };
  return createDriver(impl);
}

const ON = { handle: "h", principal: { id: "alice" } };

async function failure(promise: Promise<unknown>): Promise<DriverError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DriverError);
    return error as DriverError;
  }
  throw new Error("expected a failure");
}

describe("createDriver", () => {
  it("refuses an unknown operation, naming it", async () => {
    for (const op of ["documents.frobnicate", "__proto__", "hasOwnProperty", "constructor", ""]) {
      const error = await failure(fake().callByName(op, {}));
      expect(error.toJSON()).toEqual({ code: "NOT_SUPPORTED", message: `${JSON.stringify(op)} is not an operation of this interface`, details: { operation: op } });
    }
  });

  it("refuses an undeclared capability before reading the input", async () => {
    for (const input of [{}, null, "not even an object"]) {
      const error = await failure(fake().callByName("sync.export", input));
      expect([error.code, error.details]).toEqual(["NOT_SUPPORTED", { operation: "sync.export", capability: "sync" }]);
    }
  });

  it("is INTERNAL for a declared capability with no handler", async () => {
    const error = await failure(fake().call("documents.find", { ...ON, limit: 1 }));
    expect(error.code).toBe("INTERNAL");
  });

  it("won't be created with a capability it doesn't know", () => {
    expect(() => fake({}, { ...INFO, capabilities: ["documents", "teleport"] })).toThrow(/Unknown capability "teleport"/);
  });

  it("checks the input against the operation's schema", async () => {
    const cases: [unknown, string][] = [
      [{ ...ON, id: "x", extra: 1 }, "/extra"],
      [{ ...ON }, "/id"],
      [{ ...ON, id: 1 }, "/id"],
      [{ ...ON, id: "x", principal: { id: "alice", group: "g" } }, "/principal/group"],
      [{ ...ON, id: "x", "a/b": 1 }, "/a~1b"],
      [{ ...ON, id: new Date() }, "/id"],
      [{ ...ON, id: "x", ifVersion: undefined }, "/ifVersion"],
    ];
    for (const [input, path] of cases) {
      const error = await failure(fake().callByName("documents.get", input));
      expect([error.code, error.details]).toEqual(["INVALID_INPUT", { path }]);
    }
  });

  it("passes an engine code it doesn't list on unchanged, marked unknown", async () => {
    const error = await failure(fake().call("documents.get", { ...ON, id: "unknown-code" }));
    expect(error.toJSON()).toEqual({ code: "FUTURE_CODE", message: "from a later engine", details: { known: false } });
  });

  it("passes a known engine code on without details", async () => {
    const error = await failure(fake().call("documents.get", { ...ON, id: "known-code" }));
    expect(error.toJSON()).toEqual({ code: "STALE_DOCUMENT", message: "changed" });
  });

  it("passes a DriverError through as thrown, and makes anything else INTERNAL", async () => {
    expect((await failure(fake().call("documents.get", { ...ON, id: "driver-error" }))).toJSON()).toEqual({
      code: "NOT_FOUND",
      message: "as thrown",
      details: { why: "test" },
    });
    expect((await failure(fake().call("documents.get", { ...ON, id: "plain" }))).toJSON()).toEqual({ code: "INTERNAL", message: "boom" });
  });

  it("gives the handler its own copy of the input", async () => {
    const input = { ...ON, id: "slow" };
    seen.length = 0;
    const pending = fake().call("documents.get", input);
    input.id = "changed by the caller";
    await pending;
    expect(seen).toEqual([{ ...ON, id: "slow" }]);

    const mine = { ...ON, id: "other" };
    await fake().call("documents.get", mine);
    expect(mine.id).toBe("other");
  });

  it("answers driver.info with a fresh copy each time", async () => {
    const driver = fake();
    const info = await driver.call("driver.info", {});
    expect(info).toEqual(INFO);
    (info.capabilities as string[]).push("sync");
    expect(await driver.call("driver.info", {})).toEqual(INFO);
    expect((await failure(driver.callByName("driver.info", { verbose: true }))).code).toBe("INVALID_INPUT");
  });
});

describe("engineError", () => {
  it("marks only codes this interface doesn't list", () => {
    expect(engineError("ACCESS_DENIED", "no").details).toBeUndefined();
    expect(engineError("INVALID_INPUT", "no").details).toBeUndefined();
    expect(engineError("SOMETHING_NEW", "no").details).toEqual({ known: false });
  });
});
