import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  canonicalCompare,
  compare,
  increment,
  merge,
  normalize,
  totalEdits,
  type VectorClock,
} from "../src/vector-clock.js";

const instanceIds = ["A", "B", "C", "D", "E", "__proto__", "constructor", "toString"] as const;

const clockArbitrary = fc
  .dictionary(
    fc.constantFrom(...instanceIds),
    fc.integer({ min: 0, max: 10 }),
    { maxKeys: instanceIds.length },
  )
  .map(normalize);

describe("normalize", () => {
  it("returns a clean copy and drops zero entries", () => {
    const clock = { A: 1, B: 0 };

    expect(normalize(clock)).toEqual({ A: 1 });
    expect(normalize(clock)).not.toBe(clock);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid counter %s and names its key",
    (count) => {
      expect(() => normalize({ invalid: count })).toThrow(/invalid/);
    },
  );

  it("rejects an empty instance ID key", () => {
    expect(() => normalize({ "": 1 })).toThrow(TypeError);
  });
});

describe("increment", () => {
  it("starts a missing counter at one", () => {
    expect(increment({}, "A")).toEqual({ A: 1 });
  });

  it("increases an existing counter", () => {
    expect(increment({ A: 2 }, "A")).toEqual({ A: 3 });
  });

  it("rejects an empty instance ID", () => {
    expect(() => increment({}, "")).toThrow(TypeError);
  });

  it("rejects an increment that would exceed the safe integer range", () => {
    expect(() => increment({ A: Number.MAX_SAFE_INTEGER }, "A")).toThrow(RangeError);
  });

  it.each(["__proto__", "constructor", "toString"]) (
    "treats %s as a missing counter when incrementing",
    (instanceId) => {
      const result = increment({}, instanceId);

      expect(Object.hasOwn(result, instanceId)).toBe(true);
      expect(result[instanceId]).toBe(1);
    },
  );
});

describe("compare", () => {
  it("distinguishes equal, before, after, and concurrent clocks", () => {
    expect(compare({}, {})).toBe("equal");
    expect(compare({}, { A: 1 })).toBe("before");
    expect(compare({ A: 1 }, {})).toBe("after");
    expect(compare({ A: 2, B: 1 }, { A: 1, B: 2 })).toBe("concurrent");
    expect(compare({ A: 2, B: 1 }, { A: 2, B: 2 })).toBe("before");
  });

  it("treats explicit zeros as missing entries", () => {
    expect(compare({ A: 0 }, {})).toBe("equal");
  });

  it.each(["__proto__", "constructor", "toString"]) (
    "compares an own %s counter against a missing counter",
    (instanceId) => {
      const clock = Object.fromEntries([[instanceId, 1]]);

      expect(compare(clock, {})).toBe("after");
      expect(compare({}, clock)).toBe("before");
    },
  );
});

describe("merge", () => {
  it("takes the maximum count for every instance", () => {
    expect(merge({ A: 2, B: 1 }, { A: 1, C: 3 })).toEqual({ A: 2, B: 1, C: 3 });
  });

  it.each(["__proto__", "constructor", "toString"]) (
    "preserves an own %s counter when merging",
    (instanceId) => {
      const clock = Object.fromEntries([[instanceId, 2]]);
      const result = merge({}, clock);

      expect(Object.hasOwn(result, instanceId)).toBe(true);
      expect(result[instanceId]).toBe(2);
    },
  );
});

describe("totalEdits", () => {
  it("sums all counters", () => {
    expect(totalEdits({ A: 2, B: 3 })).toBe(5);
  });
});

describe("canonicalCompare", () => {
  it("uses a strict total order even when IDs contain delimiters", () => {
    const first = { A: 1, B: 2 };
    const second = { "A:1,B": 2 };

    expect(compare(first, second)).not.toBe("equal");
    expect(canonicalCompare(first, second)).not.toBe(0);
  });

  it("treats explicit zeros as missing entries", () => {
    expect(canonicalCompare({ A: 0 }, {})).toBe(0);
  });
});

describe("immutability", () => {
  it("does not mutate any input clock", () => {
    const a: VectorClock = Object.freeze({ A: 2, B: 1 });
    const b: VectorClock = Object.freeze({ A: 1, C: 3 });
    const raw = Object.freeze({ A: 2, B: 0 });

    expect(normalize(raw)).toEqual({ A: 2 });
    expect(increment(a, "C")).toEqual({ A: 2, B: 1, C: 1 });
    expect(compare(a, b)).toBe("concurrent");
    expect(merge(a, b)).toEqual({ A: 2, B: 1, C: 3 });
    expect(totalEdits(a)).toBe(3);
    expect(canonicalCompare(a, b)).toBe(-canonicalCompare(b, a));
    expect(raw).toEqual({ A: 2, B: 0 });
    expect(a).toEqual({ A: 2, B: 1 });
    expect(b).toEqual({ A: 1, C: 3 });
  });
});

describe("vector clock properties", () => {
  it("compares clocks reflexively and symmetrically", () => {
    fc.assert(
      fc.property(clockArbitrary, clockArbitrary, (a, b) => {
        expect(compare(a, a)).toBe("equal");

        const order = compare(a, b);
        const reverseOrder = compare(b, a);

        expect(order === "before").toBe(reverseOrder === "after");
        expect(order === "after").toBe(reverseOrder === "before");
        expect(order === "equal").toBe(reverseOrder === "equal");
        expect(order === "concurrent").toBe(reverseOrder === "concurrent");
      }),
    );
  });

  it("compares before transitively", () => {
    fc.assert(
      fc.property(clockArbitrary, clockArbitrary, clockArbitrary, (a, b, c) => {
        if (compare(a, b) === "before" && compare(b, c) === "before") {
          expect(compare(a, c)).toBe("before");
        }
      }),
    );
  });

  it("increments to a clock after the original and adds one edit", () => {
    fc.assert(
      fc.property(clockArbitrary, fc.constantFrom(...instanceIds), (clock, instanceId) => {
        const incremented = increment(clock, instanceId);

        expect(compare(clock, incremented)).toBe("before");
        expect(totalEdits(incremented)).toBe(totalEdits(clock) + 1);
      }),
    );
  });

  it("merges commutatively, associatively, idempotently, and above both inputs", () => {
    fc.assert(
      fc.property(clockArbitrary, clockArbitrary, clockArbitrary, (a, b, c) => {
        const merged = merge(a, b);

        expect(merged).toEqual(merge(b, a));
        expect(merge(merged, c)).toEqual(merge(a, merge(b, c)));
        expect(merge(a, a)).toEqual(a);
        expect(["before", "equal"]).toContain(compare(a, merged));
        expect(["before", "equal"]).toContain(compare(b, merged));
      }),
    );
  });

  it("canonicalizes clocks with an antisymmetric strict total order", () => {
    fc.assert(
      fc.property(clockArbitrary, clockArbitrary, clockArbitrary, (a, b, c) => {
        const order = canonicalCompare(a, b);

        expect(order === -canonicalCompare(b, a)).toBe(true);
        expect(order === 0).toBe(compare(a, b) === "equal");

        if (canonicalCompare(a, b) <= 0 && canonicalCompare(b, c) <= 0) {
          expect(canonicalCompare(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});