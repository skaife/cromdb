import { UNICODE_VERSION } from "./case-folding.js";

const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?$/;

/** True for "17.0" or "17.0.0" forms. */
export function isUnicodeVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

function parse(version: string): [number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new TypeError(`Not a Unicode version: ${JSON.stringify(version)}`);
  }
  return [Number(match[1]), Number(match[2])];
}

/** Compares major then minor. "17.0" and "17.0.0" are equal. */
export function compareUnicodeVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMajor, aMinor] = parse(a);
  const [bMajor, bMinor] = parse(b);
  if (aMajor !== bMajor) {
    return aMajor < bMajor ? -1 : 1;
  }
  if (aMinor !== bMinor) {
    return aMinor < bMinor ? -1 : 1;
  }
  return 0;
}

/** The "major.minor" form. */
export function shortUnicodeVersion(version: string): string {
  return parse(version).join(".");
}

/**
 * The lower of the two versions, in "major.minor" form: names can only be
 * handled with characters both the generated tables and Node's normalize()
 * know.
 */
export function effectiveUnicodeVersion(tableVersion: string, runtimeVersion: string): string {
  return shortUnicodeVersion(compareUnicodeVersions(tableVersion, runtimeVersion) <= 0 ? tableVersion : runtimeVersion);
}

function runtimeUnicodeVersion(): string {
  const version = process.versions.unicode;
  if (!isUnicodeVersion(version)) {
    throw new Error("CromDB needs a Node built with ICU (process.versions.unicode is missing)");
  }
  return version;
}

/** This engine's effective Unicode version. */
export const ENGINE_UNICODE_VERSION = effectiveUnicodeVersion(UNICODE_VERSION, runtimeUnicodeVersion());
