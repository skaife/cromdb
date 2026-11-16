import { AGE_RANGES } from "./derived-age.js";
import { CATEGORY_RANGES, type GeneralCategory } from "./general-category.js";

function findRange<T>(ranges: readonly (readonly [number, number, T])[], codePoint: number): T | undefined {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle] as readonly [number, number, T];
    if (codePoint < range[0]) {
      high = middle - 1;
    } else if (codePoint > range[1]) {
      low = middle + 1;
    } else {
      return range[2];
    }
  }
  return undefined;
}

/** The Unicode version a code point was assigned in ("1.1", "17.0"), or undefined if unassigned. */
export function ageOf(codePoint: number): string | undefined {
  return findRange(AGE_RANGES, codePoint);
}

/**
 * The general category, for the categories in the generated table only
 * (Cc, Cf, Cs, Co, Cn, Zl, Zp, Zs). Undefined for every other code point.
 */
export function generalCategoryOf(codePoint: number): GeneralCategory | undefined {
  return findRange(CATEGORY_RANGES, codePoint);
}
