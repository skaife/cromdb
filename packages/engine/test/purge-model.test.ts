// The purge and staleness properties, run on the reference model alone (see
// test/model). purge-engine.test.ts runs the same programs on the engine
// against the model.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ModelSystem } from "./model/model-system.js";
import {
  commandArbitrary,
  divergence,
  heal,
  lateJoinerArbitrary,
  programArbitrary,
  resurrections,
  runProgram,
  type Command,
} from "./model/programs.js";
import type { ModelFaults } from "./model/sync-model.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

/** Random programs: any order of writes, pulls, purges, waits and settings, sometimes with a replica joining late. */
const general = (replicas: number) => {
  const options = { replicas, maxCommands: 60, days: true, maxWaitHours: 96 };
  return fc.oneof(programArbitrary(options), lateJoinerArbitrary(options));
};

/**
 * Programs where every replica keeps covering every other well within the
 * purge time: blocks of at most 8 commands without waits or settings, each
 * followed by a ring round. With purgeAfterDays 2 (48 hours) and 4 replicas,
 * news reaches everyone within 4 rounds of about 10 hours.
 */
function connected(replicas: number): fc.Arbitrary<Command[]> {
  const busy = commandArbitrary({ replicas, maxCommands: 0, days: false, maxWaitHours: 1 }).filter(
    (command) => command.op !== "wait" && command.op !== "syncAll",
  );
  return fc
    .array(fc.array(busy, { minLength: 0, maxLength: 8, size: "max" }), { minLength: 6, maxLength: 16, size: "max" })
    .map((blocks) => blocks.flatMap((block) => [...block, { op: "ring" as const }]));
}

async function noResurrection(replicas: number, program: Command[], faults: ModelFaults = {}): Promise<string[]> {
  const system = new ModelSystem(replicas, START, 2, faults);
  const { trace, now } = await runProgram(system, program, START);
  const healed = await heal(system, now, replicas + 1);
  void healed;
  return resurrections(trace, replicas);
}

describe("the purge and staleness model", () => {
  it("never shows a finally deleted document live again on a replica that held its tombstone", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), general(n))), async ([n, program]) => {
        expect(await noResurrection(n, program)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });

  it("brings every replica that isn't stale to the same documents after pulls between every pair", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), general(n))), async ([n, program]) => {
        const system = new ModelSystem(n, START, 2);
        const { now } = await runProgram(system, program, START);
        await heal(system, now, n + 1);
        expect(divergence(system)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("never refuses a replica that keeps covering the others within the purge time", async () => {
    await fc.assert(
      fc.asyncProperty(connected(4), async (program) => {
        const system = new ModelSystem(4, START, 2);
        const { trace, now } = await runProgram(system, program, START);
        expect(trace.outcomes.filter(({ outcome }) => outcome === "stale")).toEqual([]);
        await heal(system, now, 2);
        expect(divergence(system)).toEqual([]);
        expect([0, 1, 2, 3].filter((r) => system.isStale(r))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("planted faults in the model", () => {
  // Each fault must make a property fail: the search reports a
  // counterexample instead of passing.
  // A replica joining late, after others purged, is the case horizons are
  // inherited for; the "late" search always has one.
  const late = (replicas: number) => lateJoinerArbitrary({ replicas, maxCommands: 60, days: true, maxWaitHours: 96 });

  async function caught(faults: ModelFaults, property: "resurrection" | "late" | "liveness"): Promise<boolean> {
    const programs = property === "late" ? late : general;
    const result =
      property !== "liveness"
        ? await fc.check(
            fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), programs(n))), async ([n, program]) => {
              const system = new ModelSystem(n, START, 2, faults);
              const { trace, now } = await runProgram(system, program, START);
              await heal(system, now, n + 1);
              return resurrections(trace, n).length === 0 && divergence(system).length === 0;
            }),
            { numRuns: 3000 },
          )
        : await fc.check(
            fc.asyncProperty(connected(4), async (program) => {
              const system = new ModelSystem(4, START, 2, faults);
              const { trace } = await runProgram(system, program, START);
              return trace.outcomes.every(({ outcome }) => outcome !== "stale");
            }),
            { numRuns: 2000 },
          );
    return result.failed;
  }

  it.each([
    ["check (i) skipped", { skipCheckI: true }, "resurrection"],
    ["check (ii) skipped", { skipCheckII: true }, "resurrection"],
    ["knowledge merged from a batch that isn't the last", { mergeKnowledgeEarly: true }, "resurrection"],
    ["purge horizons not inherited", { dontInheritHorizons: true }, "late"],
    ["a conflicted tombstone purged", { purgeConflicted: true }, "resurrection"],
    ["age taken from updatedAt", { ageByUpdatedAt: true }, "liveness"],
  ] as const)("%s", async (_name, faults, property) => {
    expect(await caught(faults, property)).toBe(true);
  }, 120_000);
});
