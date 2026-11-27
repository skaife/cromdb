// The engine's recovery (retirement, rewinds caught at hello, backups,
// recovering suspects), against the reference model in test/model: the same
// random programs on both, step by step, with the same results required; and
// the properties, run on the engine directly, with an independent check that
// recover finds exactly the versions only the old copy had.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineSystem } from "./model/engine-system.js";
import { ModelSystem } from "./model/model-system.js";
import {
  divergence,
  heal,
  onlyOn,
  recoveryProgramArbitrary,
  rescue,
  resurrections,
  runProgram,
  suspectKeys,
  type Command,
  type Flags,
  type Outcome,
  type RecoverySystem,
} from "./model/programs.js";
import type { TestAdapter } from "./helpers.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const DAYS = 2;

/** Runs every command on the engine and the model, and requires the same outcome. */
class SideBySide implements RecoverySystem {
  constructor(
    readonly engine: EngineSystem,
    readonly model: ModelSystem,
  ) {}

  get replicaCount(): number {
    return this.engine.replicaCount;
  }

  #same<T>(what: string, engine: T, model: T): T {
    expect(engine, `${what}: engine ${String(engine)}, model ${String(model)}`).toEqual(model);
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
    return this.#same(`editable on ${r}`, this.engine.editable(r), this.model.editable(r));
  }

  documentState(r: number): Map<string, string> {
    return this.engine.documentState(r);
  }

  isStale(r: number): boolean {
    return this.engine.isStale(r);
  }

  fileCopy(r: number): void {
    this.engine.fileCopy(r);
    this.model.fileCopy(r);
  }

  async restore(r: number, pick: number, now: number): Promise<Outcome> {
    return this.#same(`restore ${r}`, await this.engine.restore(r, pick, now), await this.model.restore(r, pick, now));
  }

  async backup(r: number, now: number): Promise<Outcome> {
    return this.#same(`backup of ${r}`, await this.engine.backup(r, now), await this.model.backup(r, now));
  }

  async reinstance(r: number, x: number, now: number): Promise<Outcome> {
    const engine = await this.engine.reinstance(r, x, now);
    if (engine !== "skipped") {
      this.model.nextIds.push(this.engine.instanceIds[r] as string);
    }
    return this.#same(`reinstance ${r} by ${x}`, engine, await this.model.reinstance(r, x, now));
  }

  async retire(by: number, r: number, now: number): Promise<Outcome> {
    return this.#same(`${by} retires ${r}`, await this.engine.retire(by, r, now), await this.model.retire(by, r, now));
  }

  async decide(r: number, pick: number, accept: boolean, now: number): Promise<{ outcome: Outcome; id?: string; key?: string }> {
    return this.#same(`decide at ${r}`, await this.engine.decide(r, pick, accept, now), await this.model.decide(r, pick, accept, now));
  }

  async recoverAgain(r: number, now: number): Promise<number | "skipped"> {
    return this.#same(`recover again at ${r}`, await this.engine.recoverAgain(r, now), await this.model.recoverAgain(r));
  }

  async useBackup(pick: number, now: number): Promise<Outcome> {
    return this.#same(`use backup ${pick}`, await this.engine.useBackup(pick, now), await this.model.useBackup(pick, now));
  }

  suspects(r: number): string[] {
    return this.engine.suspects(r);
  }

  flags(r: number): Flags {
    return this.engine.flags(r);
  }

  knowsActive(y: number, x: number): boolean {
    return this.#same(`${y} knows ${x} active`, this.engine.knowsActive(y, x), this.model.knowsActive(y, x));
  }

  knowsRetired(y: number, x: number): boolean {
    return this.#same(`${y} knows ${x} retired`, this.engine.knowsRetired(y, x), this.model.knowsRetired(y, x));
  }

  /** Every replica's documents, suspects and states, the same on both. */
  compare(after: string): void {
    for (let r = 0; r < this.replicaCount; r++) {
      expect([...this.engine.documentState(r)].sort(), `replica ${r} after ${after}`).toEqual([...this.model.documentState(r)].sort());
      expect(this.engine.suspects(r), `replica ${r} suspects after ${after}`).toEqual(this.model.suspects(r));
      expect(this.engine.flags(r), `replica ${r} flags after ${after}`).toEqual(this.model.flags(r));
    }
  }
}

const wholePulls = (replicas: number) =>
  recoveryProgramArbitrary({ replicas, maxCommands: 50, days: true, maxWaitHours: 96 }).map((program) =>
    program.filter((command) => command.op !== "pullSome"),
  );
const general = (replicas: number) => recoveryProgramArbitrary({ replicas, maxCommands: 50, days: true, maxWaitHours: 96 });

describe("the engine's recovery against the model", () => {
  it("gives the same outcome, documents, suspects and states on every replica after every step", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), wholePulls(n))), async ([n, program]) => {
        const engine = await EngineSystem.create(n, START, DAYS);
        try {
          const model = new ModelSystem(n, START, DAYS, {}, engine.instanceIds);
          const both = new SideBySide(engine, model);
          both.compare("setup");
          const { now } = await runProgram(both, program, START, (command: Command) => both.compare(JSON.stringify(command)));
          let time = await heal(both, now, n + 1);
          both.compare("healing");
          time = await rescue(both, time);
          both.compare("rescue");
          await heal(both, time, n + 1);
          both.compare("healing again");
        } finally {
          engine.close();
        }
      }),
      { numRuns: 120 },
    );
  }, 900_000);
});

/** The engine, checking each recover against onlyOn. */
class CheckedEngine extends EngineSystem {
  readonly problems: string[] = [];

  override async reinstance(r: number, x: number, now: number): Promise<Outcome> {
    const old = this.adapters[r] as TestAdapter;
    const oldRows = old.allDocuments();
    const outcome = await super.reinstance(r, x, now);
    if (outcome !== "skipped") {
      // recover ran right after the pull; nothing has changed on the new
      // replica since, so its rows are what recover compared with.
      const expected = onlyOn(oldRows, (this.adapters[r] as TestAdapter).allDocuments());
      const found = suspectKeys(this.suspects(r));
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        this.problems.push(`recover at ${r} found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
      }
    }
    await this.checkListings();
    return outcome;
  }

  override async retire(by: number, r: number, now: number): Promise<Outcome> {
    const outcome = await super.retire(by, r, now);
    await this.checkListings();
    return outcome;
  }

  override async decide(r: number, pick: number, accept: boolean, now: number): Promise<{ outcome: Outcome; id?: string; key?: string }> {
    const decided = await super.decide(r, pick, accept, now);
    await this.checkListings();
    return decided;
  }

  /** Records where any replica's replicas() or suspect(key) disagrees with its storage. */
  async checkListings(): Promise<void> {
    for (let r = 0; r < this.dbs.length; r++) {
      this.problems.push(...(await this.listingProblems(r)));
    }
  }
}

describe("the recovery properties, on the engine", () => {
  it("keeps every rule, partial pulls included, and recover finds exactly what only the old copy had", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }).chain((n) => fc.tuple(fc.constant(n), general(n))), async ([n, program]) => {
        const engine = await CheckedEngine.create(n, START, DAYS);
        try {
          const { trace, now } = await runProgram(engine, program, START);
          let time = await heal(engine, now, n + 1);
          time = await rescue(engine, time);
          await heal(engine, time, n + 1);
          await engine.checkListings();
          expect([...engine.problems, ...trace.violations, ...resurrections(trace, n), ...divergence(engine)]).toEqual([]);
        } finally {
          engine.close();
        }
      }),
      { numRuns: 120 },
    );
  }, 900_000);
});
