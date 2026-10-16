import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { canAccess, validateAccessList, validatePrincipalName } from "../src/acl.js";
import { CromDBError } from "../src/errors.js";

const V = "17.0";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CromDBError);
    expect((error as CromDBError).code).toBe(code);
    return;
  }
  expect.fail(`expected CromDBError ${code}`);
}

// Simple valid names: letters and digits with single spaces inside.
const nameArbitrary = fc
  .array(fc.stringMatching(/^[A-Za-z0-9]{1,8}$/), { minLength: 1, maxLength: 3 })
  .map((words) => words.join(" "))
  .filter((name) => !["system", "anonymous"].includes(name.toLowerCase()));

describe("validatePrincipalName", () => {
  it.each([
    "System",
    "SYSTEM",
    "ｓｙｓｔｅｍ",
    "Anonymous",
    "ANONYMOUS",
    "*",
    "＊",
    "[Admin]",
    "［Admin]",
    "",
    " Scott",
    "Scott ",
    "Scott  Skaife",
    "Scott\u200BSkaife",
    "Scott\u00ADSkaife",
    "Scott\tSkaife",
    "Scott\nSkaife",
    "Scott\u2028Skaife",
    "Scott\u1680Skaife",
    "Scott\uE000",
    "Scott\uD800",
    "\uDC00Scott",
  ])("refuses %j", (name) => {
    expectCode(() => validatePrincipalName(name, V), "INVALID_PRINCIPAL");
  });

  it.each([undefined, null, 42, ["bob"], { name: "bob" }])("refuses non-string %j", (name) => {
    expectCode(() => validatePrincipalName(name, V), "INVALID_PRINCIPAL");
  });

  it.each(["Scott Skaife", "José", "Björk", "山田", "__proto__", "constructor", "toString", "Systems", "anonymous coward"])(
    "accepts %j",
    (name) => {
      expect(validatePrincipalName(name, V)).toBe(name);
    },
  );

  it("returns the NFKC form, keeping case", () => {
    expect(validatePrincipalName("Scott\u00A0Skaife", V)).toBe("Scott Skaife"); // no-break space
    expect(validatePrincipalName("Scott\u3000Skaife", V)).toBe("Scott Skaife"); // ideographic space
    expect(validatePrincipalName("Jose\u0301", V)).toBe("José");
    expect(validatePrincipalName("Ｓｃｏｔｔ", V)).toBe("Scott");
  });
});

describe("validateAccessList", () => {
  it.each([
    [[]],
    [["system"]],
    [["SYSTEM"]],
    [["[Admin]"]],
    [["bob", "bob"]],
    [["Scott Skaife", "scott skaife"]],
    [["*", "＊"]],
    [["anonymous", "Anonymous"]],
    [[" bob"]],
    [["bob", 1]],
    [[null]],
    ["bob"],
    [undefined],
    [{ 0: "bob", length: 1 }],
  ])("refuses %j", (list) => {
    expectCode(() => validateAccessList(list, "readers", V), "INVALID_ACCESS_LIST");
  });

  it.each([[["*"]], [["*", "anonymous"]], [["*", "alice"]], [["alice"]], [["__proto__", "constructor", "toString"]]])(
    "accepts %j",
    (list) => {
      expect(validateAccessList(list, "writers", V)).toEqual(list);
    },
  );

  it("returns a copy in NFKC form", () => {
    const list = ["Ｓｃｏｔｔ", "ANONYMOUS"];
    const result = validateAccessList(list, "readers", V);
    expect(result).toEqual(["Scott", "ANONYMOUS"]);
    expect(result).not.toBe(list);
  });

  it("names the field in the message", () => {
    expect(() => validateAccessList([], "writers", V)).toThrow(/writers/);
  });
});

describe("canAccess", () => {
  it('"*" never grants anonymous; "anonymous" in any case does', () => {
    expect(canAccess("anonymous", ["*"])).toBe(false);
    expect(canAccess("anonymous", ["*", "alice"])).toBe(false);
    expect(canAccess("anonymous", ["*", "anonymous"])).toBe(true);
    expect(canAccess("anonymous", ["*", "ANONYMOUS"])).toBe(true);
    expect(canAccess("anonymous", ["Anonymous"])).toBe(true);
  });

  it("compares names by canonical form", () => {
    expect(canAccess("scott skaife", ["Scott Skaife"])).toBe(true);
    expect(canAccess("Scott Skaife", ["SCOTT SKAIFE"])).toBe(true);
    expect(canAccess("strasse", ["Straße"])).toBe(true);
    expect(canAccess("Scott", ["Ｓｃｏｔｔ"])).toBe(true);
  });

  it("does not match cross-script lookalikes (deferred)", () => {
    expect(canAccess("Sc\u043Ett", ["Scott"])).toBe(false); // Cyrillic o
  });

  it("grants any named principal through *, and through its own name", () => {
    fc.assert(
      fc.property(nameArbitrary, (name) => {
        expect(canAccess(name, ["*"])).toBe(true);
        expect(canAccess(name, ["alice9 x", name])).toBe(true);
        expect(canAccess(name.toUpperCase(), [name.toLowerCase()])).toBe(true);
      }),
    );
  });

  it("refuses a named principal not in the list", () => {
    fc.assert(
      fc.property(nameArbitrary, fc.array(nameArbitrary), (name, others) => {
        const list = others.filter((other) => other.toLowerCase() !== name.toLowerCase());
        expect(canAccess(name, [...list, "anonymous"])).toBe(false);
      }),
    );
  });

  it("treats __proto__, constructor, and toString as ordinary names", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(canAccess(name, ["alice"])).toBe(false);
      expect(canAccess(name, [name])).toBe(true);
      expect(canAccess("alice", [name])).toBe(false);
    }
  });
});

describe("Unicode version", () => {
  // U+A7CF LATIN SMALL LETTER PHARYNGEAL VOICED FRICATIVE, new in 17.0.
  // U+A7CD LATIN SMALL LETTER S WITH DIAGONAL STROKE, new in 16.0.
  const new17 = "Bob\uA7CF";
  const new16 = "Bob\uA7CD";

  it("refuses a name with a character newer than the version", () => {
    expectCode(() => validatePrincipalName(new17, "16.0"), "INVALID_PRINCIPAL");
    expect(() => validatePrincipalName(new17, "16.0")).toThrow(/not assigned in Unicode 16\.0/);
    expectCode(() => validateAccessList(["alice", new17], "readers", "16.0"), "INVALID_ACCESS_LIST");
  });

  it("accepts it at that version or later", () => {
    expect(validatePrincipalName(new17, "17.0")).toBe(new17);
    expect(validatePrincipalName(new17, "17.0.0")).toBe(new17);
    expect(validatePrincipalName(new16, "16.0")).toBe(new16);
    expect(validateAccessList(["alice", new17], "readers", "17.0")).toEqual(["alice", new17]);
  });

  it("refuses unassigned code points and noncharacters", () => {
    for (const name of ["Bob\u0378", "Bob\uFDD0", "Bob\uFFFF", "Bob\u{10FFFF}"]) {
      expectCode(() => validatePrincipalName(name, V), "INVALID_PRINCIPAL");
    }
  });

  it("checks the name as given, not only its NFKC form", () => {
    // Fullwidth A (1.1) normalizes to A either way; an unassigned code point
    // is refused even if a newer normalize() could map it to something older.
    expect(validatePrincipalName("\uFF21lice", "1.1")).toBe("Alice");
    expectCode(() => validatePrincipalName("Alice\u0378", "1.1"), "INVALID_PRINCIPAL");
  });

  it("keeps * and anonymous special at any version", () => {
    expect(validateAccessList(["*", "anonymous"], "readers", "1.1")).toEqual(["*", "anonymous"]);
  });
});
