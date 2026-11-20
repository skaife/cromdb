// The engine's purge and staleness, against the reference model in
// test/model: the same random programs run on both, step by step, with the
// same results required; and the model's properties, run on the engine
// directly, partial pulls included.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineSystem } from "./model/engine-system.js";
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
  type Outcome,
  type System,
} from "./model/programs.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const DAYS = 2;

/** Runs every command on the engine and the model, and requires the same outcome. */
class SideBySide implements System {
  constructor(
    readonly engine: EngineSystem,
    readonly model: ModelSystem,
  ) {}

  get replicaCount(): number {
    return this.engine.replicaCount;
  }

  #same(what: string, engine: Outcome, model: Outcome): Outcome {
    expect(engine, `${what}: engine ${engine}, model ${model}`).toBe(model);
    return engine;
  }

  async create(r: number, now: number): Promise<{ outcome: Outcome; id?: string }> {
    const engine = await this.engine.create(r, now);
    const model = await this.model.create(r, now, engine.id);
    this.#same(`create on ${r}`, engine.outcome, model.outcome);
    return engine;
  }

  async write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome> {
    return this.#same(`write on ${r}`, await this.engine.write(r, id, deleted, now), await this.model.write(r, id, deleted, now));
  }

  async pull(y: number, x: number, now: number): Promise<Outcome> {
    return this.#same(`${y} pulls from ${x}`, await this.engine.pull(y, x, now), await this.model.pull(y, x, now));
  }

  async pullSome(): Promise<Outcome> {
    throw new Error("partial pulls choose different documents in the engine and the model");
  }

  async purge(r: number, now: number): Promise<Outcome> {
    return this.#same(`purge on ${r}`, await this.engine.purge(r, now), await this.model.purge(r, now));
  }

  async setDays(r: number, days: number, now: number): Promise<Outcome> {
    return this.#same(`settings on ${r}`, await this.engine.setDays(r, days, now), await this.model.setDays(r, days, now));
  }

  editable(r: number): string[] {
    const ids = this.engine.editable(r);
    expect(ids).toEqual(this.model.editable(r));
    return ids;
  }

  documentState(r: number): Map<string, string> {
    return this.engine.documentState(r);
  }

  isStale(r: number): boolean {
    return this.engine.isStale(r);
  }

  /** Every replica's documents and stale state, the same on both. */
  compare(after: string): void {
    for (let r = 0; r < this.replicaCount; r++) {
      expect([...this.engine.documentState(r)].sort(), `replica ${r} after ${after}`).toEqual([...this.model.documentState(r)].sort());
      expect(this.engine.isStale(r), `replica ${r} stale after ${after}`).toBe(this.model.isStale(r));
    }
  }
}

/** Programs without partial pulls, sometimes with a replica joining late. */
function wholePulls(replicas: number): fc.Arbitrary<Command[]> {
  const options = { replicas, maxCommands: 50, days: true, maxWaitHours: 96 };
  const noPartial = (program: Command[]) => program.filter((command) => command.op !== "pullSome");
  return fc.oneof(programArbitrary(options), lateJoinerArbitrary(options)).map(noPartial);
}

const general = (replicas: number) => {
  const options = { replicas, maxCommands: 50, days: true, maxWaitHours: 96 };
  return fc.oneof(programArbitrary(options), lateJoinerArbitrary(options));
};

function connected(replicas: number): fc.Arbitrary<Command[]> {
  const busy = commandArbitrary({ replicas, maxCommands: 0, days: false, maxWaitHours: 1 }).filter(
    (command) => command.op !== "wait" && command.op !== "syncAll",
  );
  return fc
    .array(fc.array(busy, { minLength: 0, maxLength: 8, size: "max" }), { minLength: 6, maxLength: 16, size: "max" })
    .map((blocks) => blocks.flatMap((block) => [...block, { op: "ring" as const }]));
}

describe("the engine against the model", () => {
  it("gives the same outcome and the same documents on every replica after every step", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), wholePulls(n))), async ([n, program]) => {
        const engine = await EngineSystem.create(n, START, DAYS);
        try {
          const model = new ModelSystem(n, START, DAYS, {}, engine.instanceIds);
          const both = new SideBySide(engine, model);
          both.compare("setup");
          const { now } = await runProgram(both, program, START, (command) => both.compare(JSON.stringify(command)));
          await heal(both, now, n + 1);
          both.compare("healing");
        } finally {
          engine.close();
        }
      }),
      { numRuns: 120 },
    );
  }, 600_000);
});

describe("the properties, on the engine", () => {
  it("never shows a finally deleted document live again on a replica that held its tombstone", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), general(n))), async ([n, program]) => {
        const engine = await EngineSystem.create(n, START, DAYS);
        try {
          const { trace, now } = await runProgram(engine, program, START);
          await heal(engine, now, n + 1);
          expect(resurrections(trace, n)).toEqual([]);
          expect(divergence(engine)).toEqual([]);
        } finally {
          engine.close();
        }
      }),
      { numRuns: 150 },
    );
  }, 600_000);

  it("never refuses a replica that keeps covering the others within the purge time", async () => {
    await fc.assert(
      fc.asyncProperty(connected(4), async (program) => {
        const engine = await EngineSystem.create(4, START, DAYS);
        try {
          const { trace, now } = await runProgram(engine, program, START);
          expect(trace.outcomes.filter(({ outcome }) => outcome === "stale")).toEqual([]);
          await heal(engine, now, 2);
          expect(divergence(engine)).toEqual([]);
        } finally {
          engine.close();
        }
      }),
      { numRuns: 100 },
    );
  }, 600_000);
});
