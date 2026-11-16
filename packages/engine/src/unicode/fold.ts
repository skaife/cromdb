import { CASE_FOLDING } from "./case-folding.js";

/**
 * Unicode full case folding (C and F mappings), the same on every machine:
 * no locale rules, so the Turkish dotless i mappings are not used.
 */
export function fold(s: string): string {
  let result = "";
  // for...of walks code points, so supplementary characters stay whole.
  for (const char of s) {
    const codePoint = char.codePointAt(0) as number;
    result += CASE_FOLDING.get(codePoint) ?? char;
  }
  return result;
}
