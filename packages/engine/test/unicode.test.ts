import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { AGE_RANGES } from "../src/unicode/derived-age.js";
import { CATEGORY_RANGES } from "../src/unicode/general-category.js";
import { ageOf, generalCategoryOf } from "../src/unicode/properties.js";
import {
  ENGINE_UNICODE_VERSION,
  compareUnicodeVersions,
  effectiveUnicodeVersion,
  isUnicodeVersion,
  shortUnicodeVersion,
} from "../src/unicode/version.js";

const CATEGORIES = ["Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp", "Zs"] as const;

const hex = (codePoint: number): string => codePoint.toString(16).toUpperCase().padStart(4, "0");

// Test cases as [hex label, expected value, code point], so names read "U+20AC is 2.1".
function cases<T>(entries: readonly (readonly [number, T])[]): [string, T, number][] {
  return entries.map(([codePoint, value]) => [hex(codePoint), value, codePoint]);
}

function isNoncharacter(codePoint: number): boolean {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xfffe) === 0xfffe;
}

describe("generated tables", () => {
  it.each([
    ["AGE_RANGES", AGE_RANGES],
    ["CATEGORY_RANGES", CATEGORY_RANGES],
  ] as const)("%s ranges are sorted and don't overlap", (_, ranges) => {
    let previousEnd = -1;
    for (const [start, end] of ranges) {
      expect(start).toBeGreaterThan(previousEnd);
      expect(end).toBeGreaterThanOrEqual(start);
      previousEnd = end;
    }
    expect(previousEnd).toBeLessThanOrEqual(0x10ffff);
  });

  it("have the expected sizes for Unicode 17.0.0", () => {
    expect(AGE_RANGES).toHaveLength(1788);
    expect(CATEGORY_RANGES).toHaveLength(771);
  });

  // Node's own property escapes are an independent source, when Node uses
  // the same Unicode version as the tables.
  it.runIf(process.versions.unicode === "17.0")("agree with Node's Unicode 17.0 for every code point", () => {
    const patterns = CATEGORIES.map((category) => [category, new RegExp(`^\\p{${category}}$`, "u")] as const);
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      const char = String.fromCodePoint(codePoint);
      const expected = patterns.find(([, pattern]) => pattern.test(char))?.[0];
      if (generalCategoryOf(codePoint) !== expected) {
        expect.fail(`category of U+${hex(codePoint)}`);
      }
      const assigned = expected !== "Cn" || isNoncharacter(codePoint);
      if ((ageOf(codePoint) !== undefined) !== assigned) {
        expect.fail(`age of U+${hex(codePoint)}`);
      }
    }
  });
});

describe("ageOf", () => {
  it.each(
    cases([
      [0x0041, "1.1"],
      [0x20ac, "2.1"],
      [0xa7cd, "16.0"], // LATIN SMALL LETTER S WITH DIAGONAL STROKE
      [0xa7cf, "17.0"], // LATIN SMALL LETTER PHARYNGEAL VOICED FRICATIVE
      [0x10fffe, "2.0"], // noncharacters have an age in DerivedAge.txt
      [0x10ffff, "2.0"],
      [0xd800, "2.0"],
      [0xe000, "1.1"],
      [0x0378, undefined],
      [0x0380, undefined],
      [0xe0080, undefined],
    ]),
  )("U+%s is %s", (_, age, codePoint) => {
    expect(ageOf(codePoint)).toBe(age);
  });
});

describe("generalCategoryOf", () => {
  it.each(
    cases([
      [0x0000, "Cc"],
      [0x200b, "Cf"],
      [0x00ad, "Cf"],
      [0xd800, "Cs"],
      [0xe000, "Co"],
      [0x0378, "Cn"],
      [0xfdd0, "Cn"],
      [0x10ffff, "Cn"],
      [0x2028, "Zl"],
      [0x2029, "Zp"],
      [0x0020, "Zs"],
      [0x1680, "Zs"],
      [0x0041, undefined],
      [0x1f600, undefined],
    ]),
  )("U+%s is %s", (_, category, codePoint) => {
    expect(generalCategoryOf(codePoint)).toBe(category);
  });
});

describe("Unicode versions", () => {
  it("compares major then minor", () => {
    expect(compareUnicodeVersions("16.0", "17.0")).toBe(-1);
    expect(compareUnicodeVersions("17.0", "16.0")).toBe(1);
    expect(compareUnicodeVersions("15.1", "15.0")).toBe(1);
    expect(compareUnicodeVersions("9.0", "10.0")).toBe(-1);
    expect(compareUnicodeVersions("17.0", "17.0.0")).toBe(0);
    expect(compareUnicodeVersions("17.0.0", "17.0")).toBe(0);
  });

  it("is antisymmetric", () => {
    const version = fc.tuple(fc.nat(30), fc.nat(5)).map(([major, minor]) => `${major}.${minor}`);
    fc.assert(
      fc.property(version, version, (a, b) => {
        expect(compareUnicodeVersions(a, b)).toBe(-compareUnicodeVersions(b, a) || 0);
      }),
    );
  });

  it("recognizes version strings", () => {
    for (const valid of ["17.0", "17.0.0", "1.1", "10.0"]) {
      expect(isUnicodeVersion(valid)).toBe(true);
    }
    for (const invalid of ["17", "17.", "v17.0", "17.0.0.0", "", " 17.0", 17, null, undefined]) {
      expect(isUnicodeVersion(invalid)).toBe(false);
    }
    expect(() => compareUnicodeVersions("seventeen", "17.0")).toThrow(TypeError);
  });

  it("shortens to major.minor", () => {
    expect(shortUnicodeVersion("17.0.0")).toBe("17.0");
    expect(shortUnicodeVersion("15.1")).toBe("15.1");
  });

  it("takes the lower of the table and runtime versions", () => {
    expect(effectiveUnicodeVersion("17.0.0", "17.0")).toBe("17.0");
    expect(effectiveUnicodeVersion("17.0.0", "16.0")).toBe("16.0");
    expect(effectiveUnicodeVersion("17.0.0", "18.0")).toBe("17.0");
    expect(effectiveUnicodeVersion("16.0.0", "15.1")).toBe("15.1");
  });

  it("gives this engine the lower of its tables and this Node", () => {
    expect(ENGINE_UNICODE_VERSION).toBe(effectiveUnicodeVersion("17.0.0", process.versions.unicode ?? ""));
  });
});
