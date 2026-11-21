// The recovery properties, run on the reference model alone (see
// test/model): retirement, rewinds caught at hello, backups and recovering
// suspects, mixed with purge and staleness. recovery-engine.test.ts runs the
// same programs on the engine against the model.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ModelSystem } from "./model/model-system.js";
import { divergence, heal, recoveryProgramArbitrary, rescue, resurrections, runProgram, type Command } from "./model/programs.js";
import type { ModelFaults, ModelReplica } from "./model/sync-model.js";
import { compare, type VectorClock } from "../src/vector-clock.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

const programs = (replicas: number) => recoveryProgramArbitrary({ replicas, maxCommands: 70, days: true, maxWaitHours: 96 });
const sized = fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), programs(n)));

/** Runs a program, heals, replaces every blocked or stale replica, decides every suspect and heals again. The problems found. */
async function problems(n: number, program: Command[], faults: ModelFaults = {}): Promise<string[]> {
  const system = new ModelSystem(n, START, 2, faults);
  const { trace, now } = await runProgram(system, program, START);
  let time = await heal(system, now, n + 1);
  time = await rescue(system, time);
  await heal(system, time, n + 1);
  return [...system.problems, ...trace.violations, ...resurrections(trace, n), ...divergence(system)];
}

describe("the recovery model", () => {
  it("keeps every rule: no resurrection but by an accepted suspect, blocked replicas never write or sync, retired IDs never accepted, recover finds nothing twice, and everyone converges after replacing the blocked", async () => {
    await fc.assert(
      fc.asyncProperty(sized, async ([n, program]) => {
        expect(await problems(n, program)).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });
});

describe("planted faults in the recovery model", () => {
  async function caught(faults: ModelFaults): Promise<boolean> {
    const result = await fc.check(
      fc.asyncProperty(sized, async ([n, program]) => (await problems(n, program, faults)).length === 0),
      { numRuns: 3000 },
    );
    return result.failed;
  }

  it.each([
    ["recover leaving out absent documents", { recoverSkipsAbsent: true }],
    ["recover taking known versions", { recoverTakesKnown: true }],
  ] as const)("%s", async (_name, faults) => {
    expect(await caught(faults)).toBe(true);
  }, 300_000);

  // Concurrent versions of one registration, one retired, are too rare in
  // random programs to catch this fault, so it has its own case: a new
  // replica records its engine's level in its own registration while
  // another replica, which saw only the introducer's version, retires it.
  async function retiredRace(faults: ModelFaults): Promise<string | undefined> {
    const system = new ModelSystem(3, START, 2, faults);
    const [a, b] = system.replicas as [ModelReplica, ModelReplica];
    const fresh = system.model.fromTicket(a, "8d7c1f7e-9a4b-4c6d-8e2f-1a2b3c4d5e6f", START) as ModelReplica;
    expect(system.model.pull(b, a, START + 1)).toBe("ok");
    expect(system.model.retire(b, fresh.id, START + 2)).toBe("ok");
    expect(system.model.pull(a, fresh, START + 3)).toBe("ok");
    expect(system.model.pull(a, b, START + 4)).toBe("ok");
    return a.status(fresh.id);
  }

  // A copy restored from an old file that writes past where it was before
  // it pulls: only the tip its peer saw shows it went back. The document
  // check alone can't, since its own later writes are after the ones it lost.
  async function restoredWritesPast(faults: ModelFaults): Promise<{ outcome: string; rewound: boolean }> {
    const system = new ModelSystem(2, START, 2, faults);
    const [a, b] = system.replicas as [ModelReplica, ModelReplica];
    const id = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    system.model.create(a, id, START + 1);
    expect(system.model.pull(b, a, START + 2)).toBe("ok");
    const file = a.clone();
    system.model.write(a, id, false, START + 3);
    expect(system.model.pull(b, a, START + 4)).toBe("ok");
    const restored = file.clone();
    system.model.write(restored, id, false, START + 5);
    system.model.write(restored, id, false, START + 6);
    const outcome = system.model.pull(restored, b, START + 7);
    return { outcome, rewound: restored.rewound };
  }

  it("catches a restored copy that wrote past where it was", async () => {
    expect(await restoredWritesPast({})).toEqual({ outcome: "rewound", rewound: true });
  });

  it("the rewind check at hello skipped (planted)", async () => {
    expect(await restoredWritesPast({ skipRewindCheck: true })).toEqual({ outcome: "ok", rewound: false });
  });

  // An accepted "concurrent" suspect must supersede what is here: one
  // version after, no conflict left. Random programs reach this only now and
  // then, so it has its own case.
  async function acceptConcurrent(faults: ModelFaults): Promise<{ conflictRows: number; after: boolean }> {
    const system = new ModelSystem(2, START, 2, faults);
    const [a, b] = system.replicas as [ModelReplica, ModelReplica];
    const id = "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e";
    system.model.create(a, id, START + 1);
    expect(system.model.pull(b, a, START + 2)).toBe("ok");
    system.model.write(a, id, false, START + 3);
    system.model.write(b, id, false, START + 4);
    const fresh = system.model.fromTicket(a, "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f", START + 5) as ModelReplica;
    expect(system.model.pull(fresh, a, START + 6)).toBe("ok");
    expect(system.model.recover(fresh, b)).toBe(1);
    const [suspect] = system.model.pending(fresh);
    expect(suspect?.reason).toBe("concurrent");
    const before = (fresh.rows.get(id) as { vectorClock: VectorClock }).vectorClock;
    expect(system.model.accept(fresh, (suspect as { key: string }).key, START + 7)).toBe("ok");
    const rows = [...fresh.rows.values()].filter((row) => row.conflictOf === id).length;
    const primary = fresh.rows.get(id);
    const suspectClock = (suspect as { version: { vectorClock: VectorClock } }).version.vectorClock;
    // After the suspect's version and after what was here, so no replica
    // still holding either keeps it as a conflict.
    const after = primary !== undefined && compare(primary.vectorClock, suspectClock) === "after" && compare(primary.vectorClock, before) === "after";
    return { conflictRows: rows, after };
  }

  it("an accepted concurrent suspect supersedes what is here", async () => {
    expect(await acceptConcurrent({})).toEqual({ conflictRows: 0, after: true });
  });

  it("an accepted suspect not merged with what's here (planted)", async () => {
    expect(await acceptConcurrent({ acceptWithoutMerge: true })).not.toEqual({ conflictRows: 0, after: true });
  });

  it("retired wins over a concurrent active", async () => {
    expect(await retiredRace({})).toBe("retired");
  });

  it("a retirement undone by a concurrent active (planted)", async () => {
    expect(await retiredRace({ activeWins: true })).toBe("active");
  });

  it("adopt keeping the backed-up replica's ID (planted)", () => {
    for (const [faults, keeps] of [
      [{}, false],
      [{ adoptKeepsId: true }, true],
    ] as const) {
      const system = new ModelSystem(1, START, 2, faults);
      const only = system.replicas[0] as ModelReplica;
      const backup = system.model.backup(only, START + 1) as ModelReplica;
      const adopted = system.model.adopt(backup, "0b1c2d3e-4f50-4a3e-9a9e-2f6f0c4e4d7b", START + 2) as ModelReplica;
      expect(adopted.id === only.id).toBe(keeps);
      expect(adopted.writable).toBe(true);
    }
  });
});
