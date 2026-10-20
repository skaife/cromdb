import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isAuthorizedVersion } from "../src/acl.js";
import { arrange, conflictRowId, latestCount, writerClock, writerKeyIndex, type Arrangement } from "../src/conflict.js";
import { DEFAULT_POLICY, compareRank, policyNamed } from "../src/conflict-policy.js";
import type { DocumentEnvelope } from "../src/envelope.js";
import { newId } from "../src/ids.js";
import { canonicalCompare, canonicalString, compare, merge, totalEdits, type VectorClock } from "../src/vector-clock.js";

const policy = policyNamed(DEFAULT_POLICY);
const DOC = newId();
const INSTANCES = ["a", "b", "c", "__proto__"];

function version(overrides: Partial<DocumentEnvelope>): DocumentEnvelope {
  return {
    id: DOC,
    parentId: DOC,
    kind: "document",
    vectorClock: { a: 1 },
    deleted: false,
    createdAt: "2026-10-19T12:00:00.000Z",
    createdBy: "alice",
    updatedAt: "2026-10-19T12:00:00.000Z",
    updatedBy: "alice",
    updatedOn: "a",
    readers: ["*"],
    writers: ["*"],
    content: {},
    fieldTypes: {},
    ...overrides,
  };
}

const clockArbitrary: fc.Arbitrary<VectorClock> = fc
  .tuple(...INSTANCES.map(() => fc.nat({ max: 3 })))
  .map((counts) =>
    Object.fromEntries(
      INSTANCES.flatMap((id, index): [string, number][] => {
        const count = counts[index] ?? 0;
        return count > 0 ? [[id, count]] : [];
      }),
    ),
  )
  .filter((clock) => Object.keys(clock).length > 0);

const versionArbitrary: fc.Arbitrary<DocumentEnvelope> = fc
  .record({
    vectorClock: clockArbitrary,
    deleted: fc.boolean(),
    authorized: fc.boolean(),
    minute: fc.nat({ max: 3 }),
    updatedOn: fc.constantFrom(...INSTANCES),
  })
  .map(({ vectorClock, deleted, authorized, minute, updatedOn }) =>
    version({
      vectorClock,
      deleted,
      ...(deleted ? { deletedAt: "2026-10-19T12:00:00.000Z" } : {}),
      writers: authorized ? ["*"] : ["bob"],
      updatedAt: new Date(Date.parse("2026-10-19T12:00:00.000Z") + minute * 60_000).toISOString(),
      updatedOn,
    }),
  );

/** Versions with distinct clocks, as stored versions always are. */
const versionsArbitrary = fc.uniqueArray(versionArbitrary, {
  minLength: 1,
  maxLength: 8,
  selector: (v) => canonicalString(v.vectorClock),
});

function clocks(arrangement: Arrangement): string[] {
  return [arrangement.primary, ...arrangement.others].map((v) => canonicalString(v.vectorClock));
}

function shuffle<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, index) => ({ item, key: keys[index] ?? index }))
    .sort((x, y) => x.key - y.key)
    .map(({ item }) => item);
}

describe("arrange", () => {
  it("is order-independent", () => {
    fc.assert(
      fc.property(versionsArbitrary, fc.array(fc.integer(), { minLength: 8, maxLength: 8 }), (versions, keys) => {
        expect(clocks(arrange(shuffle(versions, keys), policy))).toEqual(clocks(arrange(versions, policy)));
      }),
    );
  });

  it("gives the same result one version at a time, in any order, as all at once", () => {
    fc.assert(
      fc.property(versionsArbitrary, fc.array(fc.integer(), { minLength: 8, maxLength: 8 }), (versions, keys) => {
        const [first, ...rest] = shuffle(versions, keys) as [DocumentEnvelope, ...DocumentEnvelope[]];
        let state = arrange([first], policy);
        for (const next of rest) {
          state = arrange([state.primary, ...state.others, next], policy);
        }
        expect(clocks(state)).toEqual(clocks(arrange(versions, policy)));
      }),
    );
  });

  it("keeps exactly the versions no authorized version is after", () => {
    fc.assert(
      fc.property(versionsArbitrary, (versions) => {
        const result = arrange(versions, policy);
        const kept = [result.primary, ...result.others];
        for (const v of versions) {
          const superseded = versions.some((w) => isAuthorizedVersion(w) && compare(v.vectorClock, w.vectorClock) === "before");
          expect(kept.includes(v)).toBe(!superseded);
        }
        // Kept versions are concurrent, except that an unauthorized one may be after another.
        for (const x of kept) {
          for (const y of kept) {
            const order = compare(x.vectorClock, y.vectorClock);
            const allowed =
              x === y ||
              order === "concurrent" ||
              (order === "before" && !isAuthorizedVersion(y)) ||
              (order === "after" && !isAuthorizedVersion(x));
            expect(allowed).toBe(true);
          }
        }
      }),
    );
  });

  it("keeps an authorized ancestor of an unauthorized version, ranked above it", () => {
    const ancestor = version({ vectorClock: { a: 1 } });
    const forged = version({ vectorClock: { a: 5 }, writers: ["bob"] });
    expect(arrange([forged, ancestor], policy)).toEqual({ primary: ancestor, others: [forged] });
    // An authorized descendant still supersedes both.
    const next = version({ vectorClock: { a: 6 } });
    expect(arrange([forged, ancestor, next], policy)).toEqual({ primary: next, others: [] });
  });

  it("ranks the others highest first, below the primary", () => {
    fc.assert(
      fc.property(versionsArbitrary, (versions) => {
        const kept = (({ primary, others }) => [primary, ...others])(arrange(versions, policy));
        for (let index = 1; index < kept.length; index++) {
          expect(compareRank(policy, kept[index - 1] as DocumentEnvelope, kept[index] as DocumentEnvelope)).toBe(-1);
        }
      }),
    );
  });

  it("drops duplicate clocks, keeping the first given", () => {
    const first = version({ vectorClock: { a: 1 }, content: { n: 1 } });
    const second = version({ vectorClock: { a: 1, b: 0 }, content: { n: 2 } });
    const result = arrange([first, second], policy);
    expect(result.primary).toBe(first);
    expect(result.others).toEqual([]);
  });

  it("drops an ancestor even when it would rank higher", () => {
    const ancestor = version({ vectorClock: { a: 1 }, writers: ["*"] });
    const descendant = version({ vectorClock: { a: 2 }, deleted: true, deletedAt: "2026-10-19T12:00:00.000Z" });
    expect(arrange([ancestor, descendant], policy)).toEqual({ primary: descendant, others: [] });
  });

  it("needs at least one version", () => {
    expect(() => arrange([], policy)).toThrow(TypeError);
  });

  it("doesn't change its input", () => {
    const versions = [version({ vectorClock: { b: 1 } }), version({ vectorClock: { a: 1 } })];
    const copy = structuredClone(versions);
    arrange(versions, policy);
    expect(versions).toEqual(copy);
  });
});

describe("default@1 ranking", () => {
  const rank = (a: DocumentEnvelope, b: DocumentEnvelope): number => compareRank(policy, a, b);
  // a and b are concurrent and equal on every criterion; each case changes one.
  const a = { vectorClock: { a: 2, b: 1 } };
  const b = { vectorClock: { a: 1, b: 2 } };

  it("puts authorized above unauthorized, before anything else", () => {
    const authorized = version({ ...a, vectorClock: { a: 1, b: 1 }, deleted: true, deletedAt: "2026-10-19T12:00:00.000Z" });
    const unauthorized = version({ ...b, vectorClock: { b: 9 }, writers: ["bob"] });
    expect(rank(authorized, unauthorized)).toBe(-1);
    expect(rank(unauthorized, authorized)).toBe(1);
  });

  it("puts live above deleted, before edits", () => {
    const live = version({ vectorClock: { a: 1 } });
    const deleted = version({ vectorClock: { b: 9 }, deleted: true, deletedAt: "2026-10-19T12:00:00.000Z" });
    expect(rank(live, deleted)).toBe(-1);
  });

  it("puts more total edits higher, before updatedAt", () => {
    const more = version({ vectorClock: { a: 1, b: 2 } });
    const fewer = version({ vectorClock: { c: 2 }, updatedAt: "2026-10-19T13:00:00.000Z" });
    expect(rank(more, fewer)).toBe(-1);
  });

  it("puts the later updatedAt higher, compared as instants, before updatedOn", () => {
    const later = version({ ...a, updatedAt: "2026-10-19T12:00:01.000Z", updatedOn: "a" });
    const earlier = version({ ...b, updatedOn: "z" });
    expect(rank(later, earlier)).toBe(-1);
    const farFuture = version({ ...a, updatedAt: "+010000-01-01T00:00:00.000Z" });
    expect(rank(farFuture, earlier)).toBe(-1);
  });

  it("puts the higher updatedOn higher", () => {
    // b's clock has the lower canonical form, so updatedOn alone puts it first.
    expect(rank(version({ ...b, updatedOn: "b" }), version({ ...a, updatedOn: "a" }))).toBe(-1);
    expect(rank(version({ ...a, updatedOn: "a" }), version({ ...b, updatedOn: "b" }))).toBe(1);
  });

  it("falls back to the canonical clock order, higher form first", () => {
    const x = version(a);
    const y = version(b);
    expect(canonicalString(x.vectorClock) > canonicalString(y.vectorClock)).toBe(true);
    expect(rank(x, y)).toBe(-1);
    expect(rank(y, x)).toBe(1);
  });

  it("is a strict total order over different clocks", () => {
    fc.assert(
      fc.property(versionArbitrary, versionArbitrary, versionArbitrary, (x, y, z) => {
        const xy = rank(x, y);
        expect(xy + rank(y, x)).toBe(0);
        if (canonicalString(x.vectorClock) !== canonicalString(y.vectorClock)) {
          expect(xy).not.toBe(0);
        }
        if (xy < 0 && rank(y, z) < 0) {
          expect(rank(x, z)).toBe(-1);
        }
      }),
    );
  });
});

describe("conflictRowId", () => {
  it("is a UUID derived from the document and the clock alone", () => {
    fc.assert(
      fc.property(clockArbitrary, (clock) => {
        const id = conflictRowId(DOC, clock);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(conflictRowId(DOC, { ...clock })).toBe(id);
        expect(conflictRowId(DOC, { ...clock, unused: 0 })).toBe(id);
        expect(conflictRowId(newId(), clock)).not.toBe(id);
      }),
    );
  });

  it("differs for different clocks", () => {
    fc.assert(
      fc.property(clockArbitrary, clockArbitrary, (x, y) => {
        fc.pre(canonicalString(x) !== canonicalString(y));
        expect(conflictRowId(DOC, x)).not.toBe(conflictRowId(DOC, y));
      }),
    );
  });

  it("doesn't depend on key order", () => {
    expect(conflictRowId(DOC, { a: 1, b: 2 })).toBe(conflictRowId(DOC, { b: 2, a: 1 }));
  });
});

describe("writer keys", () => {
  const A = newId();
  const B = newId();

  it("parses this replica's keys only", () => {
    expect(writerKeyIndex(A, A)).toBe(0);
    expect(writerKeyIndex(A, `${A}/1`)).toBe(1);
    expect(writerKeyIndex(A, `${A}/10`)).toBe(10);
    for (const key of [B, `${B}/1`, `${A}/0`, `${A}/01`, `${A}/`, `${A}/1/2`, `${A}/-1`, `${A}/1.5`, `${A}/ 1`, `${A}x`, `${A}/99999999999999999999`]) {
      expect(writerKeyIndex(A, key)).toBeUndefined();
    }
  });

  it("increments plain instanceId when base has its latest count", () => {
    expect(writerClock(A, { [A]: 2, [B]: 1 }, [{ [A]: 2, [B]: 1 }])).toEqual({ vectorClock: { [A]: 3, [B]: 1 }, newKey: false });
    // A replica that never wrote the document: plain key at 1.
    expect(writerClock(A, { [B]: 1 }, [{ [B]: 1 }])).toEqual({ vectorClock: { [B]: 1, [A]: 1 }, newKey: false });
  });

  it('starts "A/1" when this replica\'s latest count is in a version base doesn\'t include (Alice\'s example)', () => {
    const lost = { [A]: 2 };
    const primary = { [A]: 1, [B]: 1 };
    expect(writerClock(A, primary, [primary, lost])).toEqual({ vectorClock: { ...primary, [`${A}/1`]: 1 }, newKey: true });
  });

  it("continues the lowest qualifying key, comparing n as a number", () => {
    const stored = [{ [A]: 5, [`${A}/2`]: 1, [`${A}/10`]: 1 }, { [`${A}/2`]: 3 }];
    // A/2's latest is 3 (not in base); A/10 qualifies.
    expect(writerClock(A, { [A]: 1, [`${A}/2`]: 1, [`${A}/10`]: 1 }, stored).vectorClock[`${A}/10`]).toBe(2);
    // Both qualify: A/2 is lower than A/10.
    const both = writerClock(A, { [A]: 1, [`${A}/2`]: 3, [`${A}/10`]: 1 }, stored);
    expect(both).toEqual({ vectorClock: { [A]: 1, [`${A}/2`]: 4, [`${A}/10`]: 1 }, newKey: false });
  });

  it("starts the smallest n absent from every stored clock", () => {
    const stored = [{ [A]: 3, [`${A}/1`]: 2 }, { [`${A}/3`]: 1 }, { [`${B}/2`]: 1 }];
    const result = writerClock(A, { [B]: 1 }, stored);
    expect(result).toEqual({ vectorClock: { [B]: 1, [`${A}/2`]: 1 }, newKey: true });
  });

  it("always gives a clock after base, and never after a stored version base doesn't include", () => {
    const key = fc.constantFrom(A, `${A}/1`, `${A}/2`, B, `${B}/1`);
    const clock = fc.dictionary(key, fc.integer({ min: 1, max: 4 }), { minKeys: 1 });
    fc.assert(
      fc.property(fc.array(clock, { minLength: 1, maxLength: 5 }), fc.nat(), (stored, pick) => {
        const base = stored[pick % stored.length] as VectorClock;
        const { vectorClock } = writerClock(A, base, stored);
        expect(compare(base, vectorClock)).toBe("before");
        expect(totalEdits(vectorClock)).toBe(totalEdits(base) + 1);
        for (const other of stored) {
          // A write supersedes only what it was made from.
          const order = compare(other, base);
          if (order !== "before" && order !== "equal") {
            expect(compare(other, vectorClock)).not.toBe("before");
          }
        }
        expect(latestCount(A, stored)).toBe(Math.max(0, ...stored.map((c) => c[A] ?? 0)));
      }),
    );
  });

  it('treats "/n" keys as plain strings in the clock functions, sorting "A/10" before "A/2" by code unit', () => {
    const x = { [`${A}/10`]: 1 };
    const y = { [`${A}/2`]: 1 };
    expect(canonicalString({ [`${A}/2`]: 1, [`${A}/10`]: 2 })).toBe(`${JSON.stringify(`${A}/10`)}:2,${JSON.stringify(`${A}/2`)}:1`);
    expect(canonicalCompare(x, y)).toBe(-1);
    expect(compare(x, y)).toBe("concurrent");
    expect(merge(x, y)).toEqual({ [`${A}/10`]: 1, [`${A}/2`]: 1 });
    expect(totalEdits({ [A]: 2, [`${A}/1`]: 3 })).toBe(5);
    expect(conflictRowId(DOC, { [A]: 1, [`${A}/1`]: 1 })).not.toBe(conflictRowId(DOC, { [A]: 1, [`${A}/2`]: 1 }));
    expect(conflictRowId(DOC, { [`${A}/2`]: 1, [`${A}/10`]: 1 })).toBe(conflictRowId(DOC, { [`${A}/10`]: 1, [`${A}/2`]: 1 }));
  });
});
