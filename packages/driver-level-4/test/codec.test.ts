import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DriverError, JsonObject } from "@cromdb/driver";
import { decodeContent, encodeContent } from "../src/codec.js";

const key = fc.oneof(fc.string({ maxLength: 5 }), fc.constantFrom("__proto__", "constructor", "toString", "", "a/b", "~", "~1"));
const date = fc.date({ min: new Date("0001-01-01T00:00:00.000Z"), max: new Date("9999-12-31T23:59:59.999Z"), noInvalidDate: true });
const { tree } = fc.letrec<{ tree: unknown; value: unknown }>((tie) => ({
  tree: fc.dictionary(key, tie("value"), { maxKeys: 4 }),
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (n === 0 ? 0 : n)),
    fc.string(),
    date,
    fc.array(tie("value"), { maxLength: 3 }),
    tie("tree"),
  ),
}));

function failure(fn: () => unknown): DriverError {
  try {
    fn();
  } catch (error) {
    return error as DriverError;
  }
  throw new Error("expected a failure");
}

describe("the content codec", () => {
  it("round-trips content with Dates through JSON and fieldTypes", () => {
    fc.assert(
      fc.property(tree, (value) => {
        const content = value as Record<string, unknown>;
        const encoded = encodeContent(content);
        const wire = JSON.parse(JSON.stringify(encoded)) as { content: JsonObject; fieldTypes: Record<string, "datetime"> };
        expect(wire).toEqual(encoded);
        expect(decodeContent(wire.content, wire.fieldTypes)).toEqual(content);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses fieldTypes that don't fit the content", () => {
    const content = { due: "2026-01-02T03:04:05.000Z", n: 1, list: ["2026-01-02T03:04:05.000Z"], short: "2026-01-02", local: "2026-01-02T03:04:05.000+01:00" };
    for (const [pointer, problem] of [
      ["/missing", "no such field"],
      ["/n", "not an ISO string"],
      ["/short", "not an ISO string"],
      ["/local", "not an ISO string"],
      ["", "no such field"],
      ["/list/00", "no such field"],
      ["/list/1", "no such field"],
    ] as const) {
      const error = failure(() => decodeContent(content, { [pointer]: "datetime" }));
      expect([error.code, error.details?.["path"]]).toEqual(["INVALID_INPUT", pointer]);
      expect(error.message).toContain(problem);
    }
    expect(decodeContent(content, { "/list/0": "datetime" })["list"]).toEqual([new Date("2026-01-02T03:04:05.000Z")]);
  });
});
