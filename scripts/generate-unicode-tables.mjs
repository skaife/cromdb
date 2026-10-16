// Generates CromDB's Unicode tables in src/unicode/ from Unicode Character
// Database files, so name handling comes from pinned data and not from the
// Unicode version of whatever Node runs it.
//
// Usage: node scripts/generate-unicode-tables.mjs <directory>
//
// The directory holds three files of the same Unicode version, downloaded
// from https://www.unicode.org/Public/<version>/ucd/ to a place outside the
// repo:
//
//   CaseFolding.txt
//   DerivedAge.txt
//   extracted/DerivedGeneralCategory.txt
//
// It writes:
//
//   src/unicode/case-folding.ts      full case folding (status C and F only;
//                                    simple S and Turkish T are skipped)
//   src/unicode/derived-age.ts       the version each code point was assigned in
//   src/unicode/general-category.ts  ranges for the categories names refuse

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`;

// General categories written to general-category.ts. Cn covers unassigned
// code points and noncharacters.
const CATEGORIES = ["Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp", "Zs"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [directory] = process.argv.slice(2);
if (directory === undefined) {
  fail("Usage: node scripts/generate-unicode-tables.mjs <directory>");
}

const hex = (codePoint) => codePoint.toString(16).toUpperCase().padStart(4, "0");

/** Reads a UCD file, checks its header, and returns its version and data lines. */
function readUcdFile(relativePath) {
  const name = relativePath.split("/").at(-1).replace(/\.txt$/, "");
  const lines = readFileSync(join(directory, relativePath), "utf8").split("\n");
  const header = /^# (.+)-(\d+\.\d+\.\d+)\.txt$/.exec(lines[0]?.trim() ?? "");
  if (header === null || header[1] !== name) {
    fail(`${relativePath}: expected a first line like "# ${name}-<version>.txt", got "${lines[0]}"`);
  }
  const data = [];
  for (const [index, line] of lines.entries()) {
    const content = line.split("#", 1)[0].trim();
    if (content !== "") {
      data.push({ number: index + 1, line, fields: content.split(";").map((field) => field.trim()) });
    }
  }
  return { version: header[2], fileName: `${name}-${header[2]}.txt`, data };
}

function parseCodePoint(text, where) {
  if (!/^[0-9A-F]{4,6}$/.test(text)) {
    fail(`${where}: bad code point "${text}"`);
  }
  return Number.parseInt(text, 16);
}

/** Parses "XXXX" or "XXXX..YYYY". */
function parseRange(text, where) {
  const [start, end = start] = text.split("..");
  const range = [parseCodePoint(start, where), parseCodePoint(end, where)];
  if (range[0] > range[1]) {
    fail(`${where}: range ends before it starts`);
  }
  return range;
}

/** Sorts [start, end, value] ranges, refuses overlaps, and merges neighbors with the same value. */
function sortAndMerge(ranges, fileName) {
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) {
      fail(`${fileName}: overlapping ranges at U+${hex(range[0])}`);
    }
    if (last !== undefined && range[0] === last[1] + 1 && range[2] === last[2]) {
      last[1] = range[1];
    } else {
      merged.push([...range]);
    }
  }
  return merged;
}

const caseFolding = readUcdFile("CaseFolding.txt");
const derivedAge = readUcdFile("DerivedAge.txt");
const generalCategory = readUcdFile("extracted/DerivedGeneralCategory.txt");

const version = caseFolding.version;
for (const file of [derivedAge, generalCategory]) {
  if (file.version !== version) {
    fail(`${file.fileName} does not match CaseFolding-${version}.txt; all three files must be the same version`);
  }
}

// CaseFolding.txt: <code>; <status>; <mapping>;
const foldings = [];
const folded = new Set();
for (const { number, line, fields } of caseFolding.data) {
  const where = `${caseFolding.fileName} line ${number}`;
  if (fields.length !== 4 || fields[3] !== "") {
    fail(`${where}: unexpected format: ${line}`);
  }
  const [code, status, mapping] = fields;
  if (!["C", "F", "S", "T"].includes(status)) {
    fail(`${where}: unknown status "${status}"`);
  }
  if (status !== "C" && status !== "F") {
    continue;
  }
  const codePoint = parseCodePoint(code, where);
  const target = mapping.split(" ").map((part) => parseCodePoint(part, where));
  if (folded.has(codePoint)) {
    fail(`${where}: more than one C or F mapping for U+${hex(codePoint)}`);
  }
  folded.add(codePoint);
  foldings.push([codePoint, target]);
}

// DerivedAge.txt: <range>; <age>
const ageRanges = [];
for (const { number, line, fields } of derivedAge.data) {
  const where = `${derivedAge.fileName} line ${number}`;
  if (fields.length !== 2 || !/^\d+\.\d+$/.test(fields[1])) {
    fail(`${where}: unexpected format: ${line}`);
  }
  ageRanges.push([...parseRange(fields[0], where), fields[1]]);
}
const ages = sortAndMerge(ageRanges, derivedAge.fileName);

// DerivedGeneralCategory.txt: <range>; <category>
const categoryRanges = [];
for (const { number, line, fields } of generalCategory.data) {
  const where = `${generalCategory.fileName} line ${number}`;
  if (fields.length !== 2 || !/^[A-Z][a-z]$/.test(fields[1])) {
    fail(`${where}: unexpected format: ${line}`);
  }
  if (CATEGORIES.includes(fields[1])) {
    categoryRanges.push([...parseRange(fields[0], where), fields[1]]);
  }
}
const categories = sortAndMerge(categoryRanges, generalCategory.fileName);

const licenseComment = LICENSE.split("\n")
  .map((line) => (line === "" ? "//" : `// ${line}`))
  .join("\n");

function header(fileName, description) {
  return `// GENERATED FILE. DO NOT EDIT.
//
// ${description}
// Source: ${fileName}, Unicode ${version}.
//
// Regenerate with:
//   node scripts/generate-unicode-tables.mjs <directory with the Unicode ${version} files>
//
// Derived from the Unicode Character Database, used under this notice:
//
${licenseComment}
`;
}

const rangeLines = (ranges) =>
  ranges.map(([start, end, value]) => `  [0x${hex(start)}, 0x${hex(end)}, "${value}"],`).join("\n");

const outputs = {
  "case-folding.ts": `${header(
    caseFolding.fileName,
    "Unicode full case folding (status C and F). Simple (S) and Turkish (T) mappings are not included.",
  )}
/** The Unicode version of every generated table in src/unicode/. */
export const UNICODE_VERSION = "${version}";

export const CASE_FOLDING: ReadonlyMap<number, string> = new Map<number, string>([
${foldings.map(([codePoint, target]) => `  [0x${hex(codePoint)}, "${target.map((part) => `\\u{${hex(part)}}`).join("")}"],`).join("\n")}
]);
`,
  "derived-age.ts": `${header(
    derivedAge.fileName,
    "The Unicode version each code point was assigned in, as sorted [start, end, age] ranges.",
  )}
export const AGE_RANGES: readonly (readonly [number, number, string])[] = [
${rangeLines(ages)}
];
`,
  "general-category.ts": `${header(
    generalCategory.fileName,
    `General category ranges for ${CATEGORIES.join(", ")} only, as sorted [start, end, category] ranges.`,
  )}
export type GeneralCategory = ${CATEGORIES.map((category) => `"${category}"`).join(" | ")};

export const CATEGORY_RANGES: readonly (readonly [number, number, GeneralCategory])[] = [
${rangeLines(categories)}
];
`,
};

const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "unicode");
for (const [fileName, output] of Object.entries(outputs)) {
  writeFileSync(join(outputDirectory, fileName), output);
}
console.log(`Unicode ${version}:`);
console.log(`  case-folding.ts      ${foldings.length} entries`);
console.log(`  derived-age.ts       ${ages.length} ranges`);
console.log(`  general-category.ts  ${categories.length} ranges`);
