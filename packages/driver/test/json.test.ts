import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkPlainJson, copyJson, isPlainJson, type DriverError } from "../src/index.js";

function pathOf(value: unknown): unknown {
  try {
    checkPlainJson(value);
  } catch (error) {
    expect((error as DriverError).code).toBe("INVALID_INPUT");
    return (error as DriverError).details?.["path"];
  }
  return "accepted";
}

describe("checkPlainJson", () => {
  it("accepts any JSON value, and copies it exactly", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(isPlainJson(value)).toBe(true);
        const parsed = JSON.parse(JSON.stringify(value)) as unknown;
        expect(copyJson(parsed as never)).toEqual(parsed);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts null-prototype objects, -0, and keys like __proto__", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare["a"] = 1;
    expect(pathOf({ bare, zero: -0 })).toBe("accepted");
    expect(pathOf(JSON.parse('{"__proto__":{"constructor":[1]}}'))).toBe("accepted");
  });

  it("refuses what JSON can't hold, saying where", () => {
    const holes = [1, , 3];
    const extra = Object.assign([1], { tag: "x" });
    const cycle: Record<string, unknown> = {};
    cycle["me"] = { again: cycle };
    const hidden = {};
    Object.defineProperty(hidden, "secret", { value: 1, enumerable: false });
    const cases: [unknown, string][] = [
      [{ a: undefined }, "/a"],
      [{ a: { b: Number.NaN } }, "/a/b"],
      [{ a: [0, Number.POSITIVE_INFINITY] }, "/a/1"],
      [{ a: new Date() }, "/a"],
      [{ a: new Map() }, "/a"],
      [{ a: () => 1 }, "/a"],
      [{ a: 1n }, "/a"],
      [{ "x/y": { "~": Symbol("s") } }, "/x~1y/~0"],
      [{ [Symbol("k")]: 1 }, ""],
      [{ get a() { return 1; } }, "/a"],
      [{ list: holes }, "/list"],
      [{ list: extra }, "/list"],
      [cycle, "/me/again"],
      [hidden, "/secret"],
      [undefined, ""],
    ];
    for (const [value, path] of cases) {
      expect(pathOf(value)).toBe(path);
    }
  });
});
