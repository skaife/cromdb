import fc from "fast-check";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical.js";
import type { DocumentEnvelope } from "../src/envelope.js";

const char = (codePoint: number): string => String.fromCodePoint(codePoint);
const BACKSLASH = char(0x5c);

/** The number whose IEEE 754 bits are the 16 hex digits given. */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

/** A deep copy with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reversedKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, reversedKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

describe("canonicalize: RFC 8785 examples", () => {
  it("writes the example of section 3.2.2", () => {
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: `${char(0x20ac)}$${char(0x0f)}${char(0x0a)}A'${char(0x42)}${char(0x22)}${char(0x5c)}${BACKSLASH}"/`,
      literals: [null, true, false],
    };
    const string = `"${char(0x20ac)}$${BACKSLASH}u000f${BACKSLASH}nA'B${BACKSLASH}"${BACKSLASH.repeat(4)}${BACKSLASH}"/"`;
    expect(canonicalize(input)).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":${string}}`,
    );
  });

  it("sorts keys by UTF-16 code units, as in section 3.2.3", () => {
    const keys = [char(0x20ac), "\r", char(0xfb33), "1", char(0x1f600), char(0x80), char(0xf6)];
    const input = Object.fromEntries(keys.map((key, index) => [key, index]));
    const sorted = ["\r", "1", char(0x80), char(0xf6), char(0x20ac), char(0x1f600), char(0xfb33)];
    const expected = `{${sorted.map((key) => `${JSON.stringify(key)}:${keys.indexOf(key)}`).join(",")}}`;
    expect(canonicalize(input)).toBe(expected);
    // The control character is escaped, everything else written as is.
    expect(expected.startsWith(`{"${BACKSLASH}r":1,"1":3,"${char(0x80)}":5,`)).toBe(true);
  });

  // Appendix B: the IEEE 754 bit pattern and the text it must give.
  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("writes the number with bits %s as %s", (bits, text) => {
    expect(canonicalize(fromBits(bits))).toBe(text);
  });

  it.each(["7ff8000000000000", "7ff0000000000000", "fff0000000000000"])("refuses NaN and infinities (%s)", (bits) => {
    expect(() => canonicalize(fromBits(bits))).toThrow(TypeError);
  });
});

describe("canonicalize: what isn't JSON", () => {
  it.each([
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a bigint", 1n],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["undefined in an object", { a: undefined }],
    ["a sparse array", [1, , 3]],
  ])("refuses %s", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it("refuses a lone surrogate in a value or a key", () => {
    expect(() => canonicalize(String.fromCharCode(0xd800))).toThrow(/lone surrogate/);
    expect(() => canonicalize(`a${String.fromCharCode(0xdc00)}`)).toThrow(/lone surrogate/);
    expect(() => canonicalize({ [String.fromCharCode(0xdbff)]: 1 })).toThrow(/lone surrogate/);
    expect(canonicalize(char(0x1f600))).toBe(`"${char(0x1f600)}"`);
  });

  it("accepts objects with a null prototype, and keys like __proto__", () => {
    const input = Object.create(null) as Record<string, unknown>;
    input["b"] = 1;
    input["a"] = 2;
    expect(canonicalize(input)).toBe('{"a":2,"b":1}');
    expect(canonicalize(JSON.parse('{"__proto__":1,"constructor":2,"toString":3}'))).toBe('{"__proto__":1,"constructor":2,"toString":3}');
  });
});

describe("canonicalize: properties", () => {
  const json = fc.jsonValue({ stringUnit: "grapheme" });

  it("doesn't depend on key order", () => {
    fc.assert(
      fc.property(json, (value) => {
        expect(canonicalize(reversedKeys(value))).toBe(canonicalize(value));
      }),
    );
  });

  it("is stable: the canonical text, parsed again, gives the same text", () => {
    fc.assert(
      fc.property(json, (value) => {
        const text = canonicalize(value);
        expect(canonicalize(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it("is JSON that parses back to the value, with keys sorted", () => {
    fc.assert(
      fc.property(json, (value) => {
        const text = canonicalize(value);
        // -0 is written as 0, as JSON.stringify writes it.
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
        expect(text).toBe(JSON.stringify(JSON.parse(text), (_key, item: unknown) =>
          typeof item === "object" && item !== null && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
            : item,
        ));
      }),
    );
  });

  it("throws exactly for strings that aren't well formed", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (value) => {
        if (isWellFormed(value)) {
          expect(canonicalize(value)).toBe(JSON.stringify(value));
        } else {
          expect(() => canonicalize(value)).toThrow(TypeError);
        }
      }),
    );
  });
});

describe("canonicalize: golden envelope", () => {
  // A fixed envelope and its exact canonical text and SHA-256. If this test
  // fails, the canonical form has changed, and anything hashed or signed with
  // the old form no longer matches. Change it only on purpose.
  const envelope: DocumentEnvelope = {
    id: "5b0f8e52-3c1d-4f7a-9e2b-6a4c8d1e0f93",
    parentId: "5b0f8e52-3c1d-4f7a-9e2b-6a4c8d1e0f93",
    kind: "document",
    vectorClock: {
      "d3a1c7e0-2b4f-4c8e-9a6d-1f5e7b3c9a20": 2,
      "0e9b4d2a-7c3f-4a1e-8b5d-6f2c9e1a7b34": 1,
      "0e9b4d2a-7c3f-4a1e-8b5d-6f2c9e1a7b34/2": 1,
    },
    deleted: false,
    createdAt: "2026-11-11T09:30:00.000Z",
    createdBy: "Ana Lúcia",
    updatedAt: "2026-11-11T10:15:42.250Z",
    updatedBy: "bob",
    updatedOn: "d3a1c7e0-2b4f-4c8e-9a6d-1f5e7b3c9a20",
    readers: ["*"],
    writers: ["Ana Lúcia", "bob"],
    content: {
      title: "Café menu",
      prices: [3.5, 12, 0.1, 1e21, -0],
      due: "2026-12-01T00:00:00.000Z",
      tags: { z: true, a: null, "Ä": "umlaut" },
      note: 'line one\nline "two"\ttabbed',
    },
    fieldTypes: { "/due": "datetime" },
  };

  const text =
    '{"content":{"due":"2026-12-01T00:00:00.000Z","note":"line one\\nline \\"two\\"\\ttabbed","prices":[3.5,12,0.1,1e+21,0],"tags":{"a":null,"z":true,"Ä":"umlaut"},"title":"Café menu"},' +
    '"createdAt":"2026-11-11T09:30:00.000Z","createdBy":"Ana Lúcia","deleted":false,"fieldTypes":{"/due":"datetime"},' +
    '"id":"5b0f8e52-3c1d-4f7a-9e2b-6a4c8d1e0f93","kind":"document","parentId":"5b0f8e52-3c1d-4f7a-9e2b-6a4c8d1e0f93",' +
    '"readers":["*"],"updatedAt":"2026-11-11T10:15:42.250Z","updatedBy":"bob","updatedOn":"d3a1c7e0-2b4f-4c8e-9a6d-1f5e7b3c9a20",' +
    '"vectorClock":{"0e9b4d2a-7c3f-4a1e-8b5d-6f2c9e1a7b34":1,"0e9b4d2a-7c3f-4a1e-8b5d-6f2c9e1a7b34/2":1,"d3a1c7e0-2b4f-4c8e-9a6d-1f5e7b3c9a20":2},' +
    '"writers":["Ana Lúcia","bob"]}';

  it("has the exact canonical text", () => {
    expect(canonicalize(envelope)).toBe(text);
  });

  it("has the exact SHA-256 over the UTF-8 bytes", () => {
    const bytes = Buffer.from(canonicalize(envelope), "utf8");
    expect(bytes.length).toBe(699);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("f557803b123bed92b2f9d775cb0e18d445050eef1728cf6e6df15a4e5be6a66e");
  });
});
