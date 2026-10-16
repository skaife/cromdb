import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { canonicalName } from "../src/acl.js";
import { CASE_FOLDING, UNICODE_VERSION } from "../src/unicode/case-folding.js";
import { fold } from "../src/unicode/fold.js";

// 50 C and F lines from CaseFolding-17.0.0.txt, picked with a fixed seed
// (comments dropped). Checked against the source text, not the table.
const SAMPLE_LINES = [
  "015A; C; 015B",
  "0164; C; 0165",
  "01B3; C; 01B4",
  "01D9; C; 01DA",
  "0241; C; 0242",
  "0422; C; 0442",
  "0425; C; 0445",
  "0478; C; 0479",
  "0490; C; 0491",
  "04C5; C; 04C6",
  "04F2; C; 04F3",
  "04F4; C; 04F5",
  "04F6; C; 04F7",
  "1C97; C; 10D7",
  "1CA3; C; 10E3",
  "1E3E; C; 1E3F",
  "1F1C; C; 1F14",
  "1F6B; C; 1F63",
  "1FAE; F; 1F66 03B9",
  "1FB2; F; 1F70 03B9",
  "1FBE; C; 03B9",
  "2161; C; 2171",
  "24B7; C; 24D1",
  "24C4; C; 24DE",
  "2C0D; C; 2C3D",
  "2C1C; C; 2C4C",
  "2CDC; C; 2CDD",
  "A736; C; A737",
  "A74C; C; A74D",
  "A75C; C; A75D",
  "A7B3; C; AB53",
  "A7BE; C; A7BF",
  "A7C4; C; A794",
  "AB8E; C; 13BE",
  "ABA2; C; 13D2",
  "ABA9; C; 13D9",
  "FF2C; C; FF4C",
  "FF31; C; FF51",
  "10415; C; 1043D",
  "1041A; C; 10442",
  "104B2; C; 104DA",
  "104BE; C; 104E6",
  "10C94; C; 10CD4",
  "10D56; C; 10D76",
  "16E42; C; 16E62",
  "16E54; C; 16E74",
  "16EAC; C; 16EC7",
  "1E908; C; 1E92A",
  "1E90E; C; 1E930",
  "1E921; C; 1E943",
];

function fromHex(codePoints: string): string {
  return String.fromCodePoint(...codePoints.split(" ").map((part) => Number.parseInt(part, 16)));
}

const same = (a: string, b: string): boolean => canonicalName(a) === canonicalName(b);

describe("case folding table", () => {
  it("is for Unicode 17.0.0", () => {
    expect(UNICODE_VERSION).toBe("17.0.0");
  });

  it("has the C and F entries of CaseFolding-17.0.0.txt", () => {
    expect(CASE_FOLDING.size).toBe(1585);
  });
});

describe("fold", () => {
  it.each(SAMPLE_LINES)("folds as CaseFolding.txt says: %s", (line) => {
    const [code, , mapping] = line.split("; ");
    expect(fold(fromHex(code ?? ""))).toBe(fromHex(mapping ?? ""));
  });

  it("uses full (F) mappings, not simple (S) or Turkish (T) ones", () => {
    expect(fold("ß")).toBe("ss");
    expect(fold("\u1E9E")).toBe("ss"); // capital sharp s: S would give ß
    expect(fold("I")).toBe("i"); // T would give dotless ı
    expect(fold("\u0130")).toBe("i\u0307"); // T would give plain i
  });

  it("leaves unmapped characters alone", () => {
    expect(fold("scott 123 山田 😀")).toBe("scott 123 山田 😀");
  });

  it("works by code point, keeping supplementary characters whole", () => {
    expect(fold("A😀B")).toBe("a😀b");
    expect(fold("\u{10400}")).toBe("\u{10428}"); // Deseret capital long I
  });
});

describe("canonicalName", () => {
  it("ignores case", () => {
    expect(same("Scott Skaife", "scott skaife")).toBe(true);
    expect(same("Scott Skaife", "SCOTT SKAIFE")).toBe(true);
  });

  it("folds ß to ss", () => {
    expect(same("STRASSE", "straße")).toBe(true);
  });

  it("treats final sigma like sigma", () => {
    expect(same("ΟΔΟΣ", "οδοσ")).toBe(true);
    expect(same("ΟΔΟΣ", "οδος")).toBe(true);
  });

  it("expands the fi ligature", () => {
    expect(same("\uFB01le", "FILE")).toBe(true);
  });

  it("maps fullwidth letters (NFKC)", () => {
    expect(same("Ｓｃｏｔｔ", "scott")).toBe(true);
  });

  it("treats composed and decomposed forms alike", () => {
    expect(same("\u00E9", "e\u0301")).toBe(true);
  });

  it("keeps supplementary characters and maps mathematical letters", () => {
    expect(canonicalName("Bob 😀")).toBe("bob 😀");
    expect(canonicalName("\u{1D412}")).toBe("s");
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = canonicalName(s);
        expect(canonicalName(once)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });

  it("is idempotent for every single code point", () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
      const once = canonicalName(String.fromCodePoint(codePoint));
      if (canonicalName(once) !== once) {
        expect.fail(`not idempotent for U+${codePoint.toString(16).toUpperCase()}`);
      }
    }
  });
});
