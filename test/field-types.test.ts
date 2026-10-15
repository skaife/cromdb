import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decodeContent, encodeContent } from "../src/field-types.js";

const keyPool = fc.oneof(
  fc.constantFrom("__proto__", "constructor", "toString", "a/b", "~x", "", "0", "items"),
  fc.string(),
);

const leaf = fc.oneof(
  fc.string(),
  // -0 is normalized to 0 by encodeContent; it has its own test below.
  fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => (n === 0 ? 0 : n)),
  fc.boolean(),
  fc.constant(null),
  fc.date({ noInvalidDate: true }),
);

const { content } = fc.letrec<{ value: unknown; content: Record<string, unknown> }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("value"), { maxLength: 4 }),
    tie("content"),
  ),
  // Object.fromEntries creates own properties, even for "__proto__".
  content: fc
    .array(fc.tuple(keyPool, tie("value")), { maxLength: 5 })
    .map((entries) => Object.fromEntries(entries) as Record<string, unknown>),
}));

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("encodeContent and decodeContent", () => {
  it("round-trips generated content", () => {
    fc.assert(
      fc.property(content, (input) => {
        const encoded = encodeContent(input);
        expect(decodeContent(encoded.content, encoded.fieldTypes)).toEqual(input);
      }),
    );
  });

  it("produces output that survives JSON", () => {
    fc.assert(
      fc.property(content, (input) => {
        const encoded = encodeContent(input);
        expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
      }),
    );
  });

  it("does not mutate its input", () => {
    fc.assert(
      fc.property(content, (input) => {
        const encoded = deepFreeze(encodeContent(deepFreeze(input)));
        decodeContent(encoded.content, encoded.fieldTypes);
      }),
    );
  });

  it("records dates at nested pointers", () => {
    const due = new Date("2026-01-02T03:04:05.006Z");
    const encoded = encodeContent({ due, items: [{ shippedAt: due }, "x"] });
    expect(encoded.content).toEqual({ due: due.toISOString(), items: [{ shippedAt: due.toISOString() }, "x"] });
    expect(encoded.fieldTypes).toEqual({ "/due": "datetime", "/items/0/shippedAt": "datetime" });
  });

  it("escapes pointer segments", () => {
    const encoded = encodeContent({ "a/b~c": new Date(0), "": { "": new Date(0) } });
    expect(encoded.fieldTypes).toEqual({ "/a~1b~0c": "datetime", "//": "datetime" });
  });

  it("drops undefined properties", () => {
    expect(encodeContent({ a: 1, b: undefined }).content).toEqual({ a: 1 });
    expect(Object.keys(encodeContent({ a: 1, b: undefined }).content)).toEqual(["a"]);
  });

  it("stores -0 as 0", () => {
    expect(Object.is(encodeContent({ n: -0 }).content.n, 0)).toBe(true);
  });

  it("ignores symbol keys", () => {
    expect(encodeContent({ a: 1, [Symbol("s")]: 2 }).content).toEqual({ a: 1 });
  });

  it("accepts objects with a null prototype", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { a: new Date(5) });
    const encoded = encodeContent(input);
    expect(decodeContent(encoded.content, encoded.fieldTypes)).toEqual({ a: new Date(5) });
  });

  it("keeps __proto__ as an own property without changing prototypes", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true, "at": 1}}') as Record<string, unknown>;
    (input["__proto__"] as Record<string, unknown>)["at"] = new Date(7);
    const encoded = encodeContent(input);

    expect(Object.hasOwn(encoded.content, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(encoded.content)).toBe(Object.prototype);
    expect(encoded.fieldTypes).toEqual({ "/__proto__/at": "datetime" });

    const decoded = decodeContent(encoded.content, encoded.fieldTypes);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value).toEqual({ polluted: true, at: new Date(7) });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  describe("encode errors", () => {
    class Point {
      x = 1;
    }
    const cases: [string, unknown, typeof TypeError | typeof RangeError, string][] = [
      ["NaN", NaN, TypeError, "/a/b/1"],
      ["Infinity", Infinity, TypeError, "/a/b/1"],
      ["-Infinity", -Infinity, TypeError, "/a/b/1"],
      ["bigint", 1n, TypeError, "/a/b/1"],
      ["symbol", Symbol("s"), TypeError, "/a/b/1"],
      ["function", () => 1, TypeError, "/a/b/1"],
      ["Map", new Map(), TypeError, "/a/b/1"],
      ["Set", new Set(), TypeError, "/a/b/1"],
      ["RegExp", /x/, TypeError, "/a/b/1"],
      ["invalid Date", new Date(NaN), RangeError, "/a/b/1"],
      ["class instance", new Point(), TypeError, "/a/b/1"],
      ["undefined array element", [undefined], TypeError, "/a/b/1/0"],
      ["sparse array", [1, , 2], TypeError, "/a/b/1"],
    ];

    it.each(cases)("rejects %s and names the pointer", (_name, bad, errorType, pointer) => {
      const input = { a: { b: [1, bad] } };
      expect(() => encodeContent(input)).toThrow(errorType);
      expect(() => encodeContent(input)).toThrow(`"${pointer}"`);
    });

    it("rejects a top-level value that is not a plain object", () => {
      expect(() => encodeContent([] as unknown as Record<string, unknown>)).toThrow(TypeError);
      expect(() => encodeContent(new Point() as unknown as Record<string, unknown>)).toThrow(TypeError);
      expect(() => encodeContent(null as unknown as Record<string, unknown>)).toThrow(TypeError);
    });
  });

  describe("decode errors", () => {
    it("throws on a pointer that does not resolve", () => {
      expect(() => decodeContent({ a: "2026-01-01T00:00:00.000Z" }, { "/b": "datetime" })).toThrow('"/b"');
      expect(() => decodeContent({ a: ["2026-01-01T00:00:00.000Z"] }, { "/a/1": "datetime" })).toThrow(TypeError);
      expect(() => decodeContent({ a: { b: "x" } }, { "/a/b/c": "datetime" })).toThrow(TypeError);
      expect(() => decodeContent({}, { "": "datetime" })).toThrow(TypeError);
    });

    it("accepts only canonical array indexes", () => {
      const content = { a: ["2026-01-01T00:00:00.000Z"] };
      expect(decodeContent(content, { "/a/0": "datetime" })).toEqual({ a: [new Date("2026-01-01T00:00:00.000Z")] });
      for (const pointer of ["/a/00", "/a/-0", "/a/+0", "/a/-", "/a/ 0"]) {
        expect(() => decodeContent(content, { [pointer]: "datetime" })).toThrow(`"${pointer}"`);
      }
    });

    it("does not resolve inherited properties", () => {
      expect(() => decodeContent({}, { "/toString": "datetime" })).toThrow('"/toString"');
      expect(() => decodeContent({}, { "/__proto__": "datetime" })).toThrow('"/__proto__"');
    });

    it("throws on a datetime value that is not a valid date string", () => {
      expect(() => decodeContent({ a: "not a date" }, { "/a": "datetime" })).toThrow('"/a"');
      expect(() => decodeContent({ a: 0 }, { "/a": "datetime" })).toThrow(TypeError);
      expect(() => decodeContent({ a: null }, { "/a": "datetime" })).toThrow(TypeError);
      expect(() => decodeContent({ a: {} }, { "/a": "datetime" })).toThrow(TypeError);
    });

    it("accepts only the exact toISOString form", () => {
      for (const value of [
        "2026-10-10",
        "10/10/2026",
        "2026-10-10T12:00:00",
        "2026-10-10T12:00:00Z",
        "2026-10-10T12:00:00.000+00:00",
      ]) {
        expect(() => decodeContent({ a: value }, { "/a": "datetime" })).toThrow(/not a valid datetime string/);
      }
      expect(decodeContent({ a: "2026-10-10T12:00:00.000Z" }, { "/a": "datetime" })).toEqual({
        a: new Date("2026-10-10T12:00:00.000Z"),
      });
      expect(decodeContent({ a: "+010000-01-01T00:00:00.000Z" }, { "/a": "datetime" })).toEqual({
        a: new Date("+010000-01-01T00:00:00.000Z"),
      });
    });

    it("throws on an unknown field type", () => {
      expect(() => decodeContent({ a: "x" }, { "/a": "bogus" } as never)).toThrow('"/a"');
    });
  });
});
