// Random programs for the purge and staleness properties, the systems they
// run on (the model, or the engine through an adapter in purge-engine.test.ts),
// and the properties themselves.

import fc from "fast-check";
import { compare, type VectorClock } from "../../src/vector-clock.js";
import { HOUR } from "./sync-model.js";

export type Command =
  | { readonly op: "create"; readonly r: number }
  | { readonly op: "edit" | "delete"; readonly r: number; readonly pick: number }
  | { readonly op: "pull"; readonly y: number; readonly x: number }
  | { readonly op: "pullSome"; readonly y: number; readonly x: number; readonly limit: number }
  | { readonly op: "ring" }
  | { readonly op: "purge"; readonly r: number }
  | { readonly op: "days"; readonly r: number; readonly days: number }
  | { readonly op: "wait"; readonly hours: number }
  | { readonly op: "syncAll" };

export type Outcome = "ok" | "stale" | "readOnly" | "skipped";

/** What a program runs on. Replicas are numbered from 0. */
export interface System {
  readonly replicaCount: number;
  create(r: number, now: number): Promise<{ outcome: Outcome; id?: string }>;
  write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome>;
  pull(y: number, x: number, now: number): Promise<Outcome>;
  /** One batch of at most limit documents. */
  pullSome(y: number, x: number, limit: number, now: number): Promise<Outcome>;
  purge(r: number, now: number): Promise<Outcome>;
  setDays(r: number, days: number, now: number): Promise<Outcome>;
  /** IDs a test may edit or delete at r (live, not in conflict), sorted. */
  editable(r: number): string[];
  /** Each kind "document" row: ID to [conflictOf, deleted, clock]. */
  documentState(r: number): Map<string, string>;
  isStale(r: number): boolean;
}

export interface ProgramOptions {
  readonly replicas: number;
  readonly maxCommands: number;
  /** Include "days" commands. */
  readonly days: boolean;
  /** Longest wait, in hours. */
  readonly maxWaitHours: number;
}

export function commandArbitrary(options: ProgramOptions): fc.Arbitrary<Command> {
  const r = fc.integer({ min: 0, max: options.replicas - 1 });
  const pair = fc
    .tuple(r, fc.integer({ min: 1, max: options.replicas - 1 }))
    .map(([y, offset]) => ({ y, x: (y + offset) % options.replicas }));
  const choices: fc.WeightedArbitrary<Command>[] = [
    { weight: 4, arbitrary: r.map((i) => ({ op: "create" as const, r: i })) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant("edit" as const), r, pick: fc.nat(50) }) },
    { weight: 3, arbitrary: fc.record({ op: fc.constant("delete" as const), r, pick: fc.nat(50) }) },
    { weight: 6, arbitrary: pair.map(({ y, x }) => ({ op: "pull" as const, y, x })) },
    {
      weight: 2,
      arbitrary: fc.tuple(pair, fc.integer({ min: 1, max: 3 })).map(([{ y, x }, limit]) => ({ op: "pullSome" as const, y, x, limit })),
    },
    { weight: 3, arbitrary: r.map((i) => ({ op: "purge" as const, r: i })) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: options.maxWaitHours }).map((hours) => ({ op: "wait" as const, hours })) },
    { weight: 1, arbitrary: fc.constant({ op: "syncAll" as const }) },
  ];
  if (options.days) {
    choices.push({ weight: 1, arbitrary: fc.record({ op: fc.constant("days" as const), r, days: fc.integer({ min: 1, max: 4 }) }) });
  }
  return fc.oneof(...choices);
}

export function programArbitrary(options: ProgramOptions): fc.Arbitrary<Command[]> {
  // fast-check keeps arrays short unless told otherwise; purge needs time.
  return fc.array(commandArbitrary(options), { minLength: Math.min(20, options.maxCommands), maxLength: options.maxCommands, size: "max" });
}

/**
 * A replica that joins late: the last replica takes no part in the first
 * half of the program, so it still holds no documents when it first pulls,
 * often after others have purged. This is how a new replica made from a
 * ticket starts.
 */
export function lateJoinerArbitrary(options: ProgramOptions): fc.Arbitrary<Command[]> {
  const without = programArbitrary({ ...options, replicas: options.replicas - 1 });
  const all = programArbitrary(options);
  return fc.tuple(without, all).map(([before, after]) => [...before, { op: "wait" as const, hours: 72 }, ...after]);
}

/** What a run recorded, for the properties. */
export interface Trace {
  /** Every version any write made, by document: [clock, deleted]. */
  readonly history: Map<string, { clock: VectorClock; deleted: boolean }[]>;
  /** For each step, for each replica, its document state after the step. */
  readonly states: Map<string, string>[][];
  /** Every outcome, in order, with its command. */
  readonly outcomes: { command: string; outcome: Outcome }[];
}

function parseRow(text: string): { conflictOf: string | null; deleted: boolean; clock: VectorClock } {
  const [conflictOf, deleted, entries] = JSON.parse(text) as [string | null, boolean, [string, number][]];
  return { conflictOf, deleted, clock: Object.fromEntries(entries) };
}

/**
 * Runs a program. Every command first moves the clock on an hour, so each
 * one falls in its own checkpoint window. step(command, outcome) is called
 * after each command, for a side-by-side comparison.
 */
export async function runProgram(
  system: System,
  program: readonly Command[],
  start: number,
  step?: (command: Command, outcome: Outcome, now: number) => Promise<void> | void,
): Promise<{ trace: Trace; now: number }> {
  let now = start;
  const trace: Trace = { history: new Map(), states: [], outcomes: [] };
  const record = (r: number, id: string) => {
    const text = system.documentState(r).get(id);
    if (text === undefined) {
      return;
    }
    const row = parseRow(text);
    const versions = trace.history.get(id) ?? [];
    versions.push({ clock: row.clock, deleted: row.deleted });
    trace.history.set(id, versions);
  };
  const run = async (command: Command): Promise<Outcome> => {
    switch (command.op) {
      case "create": {
        const { outcome, id } = await system.create(command.r, now);
        if (id !== undefined) {
          record(command.r, id);
        }
        return outcome;
      }
      case "edit":
      case "delete": {
        const ids = system.editable(command.r);
        const id = ids[command.pick % Math.max(1, ids.length)];
        if (id === undefined) {
          return "skipped";
        }
        const outcome = await system.write(command.r, id, command.op === "delete", now);
        if (outcome === "ok") {
          record(command.r, id);
        }
        return outcome;
      }
      case "pull":
        return system.pull(command.y, command.x, now);
      case "pullSome":
        return system.pullSome(command.y, command.x, command.limit, now);
      case "ring": {
        // Each replica pulls from the one before it, last first, so news
        // moves one replica further each round.
        let worst: Outcome = "ok";
        for (let y = system.replicaCount - 1; y >= 0; y--) {
          const outcome = await system.pull(y, (y + system.replicaCount - 1) % system.replicaCount, now);
          if (outcome === "stale") {
            worst = "stale";
          }
          now += 1;
        }
        return worst;
      }
      case "purge":
        return system.purge(command.r, now);
      case "days":
        return system.setDays(command.r, command.days, now);
      case "wait":
        now += command.hours * HOUR;
        return "ok";
      case "syncAll": {
        let worst: Outcome = "ok";
        for (let y = 0; y < system.replicaCount; y++) {
          for (let x = 0; x < system.replicaCount; x++) {
            if (x !== y) {
              const outcome = await system.pull(y, x, now);
              if (outcome === "stale") {
                worst = "stale";
              }
              now += 1;
            }
          }
        }
        return worst;
      }
    }
  };
  for (const command of program) {
    now += HOUR;
    const outcome = await run(command);
    trace.outcomes.push({ command: JSON.stringify(command), outcome });
    trace.states.push(Array.from({ length: system.replicaCount }, (_, r) => system.documentState(r)));
    await step?.(command, outcome, now);
  }
  return { trace, now };
}

/**
 * NO RESURRECTION. A tombstone that is after (or equal to) every version ever
 * written of its document is final. Once a replica has held it, that
 * document is never live there again.
 */
export function resurrections(trace: Trace, replicaCount: number): string[] {
  const problems: string[] = [];
  for (const [id, versions] of trace.history) {
    const final = versions.find(
      (candidate) =>
        candidate.deleted && versions.every((other) => ["before", "equal"].includes(compare(other.clock, candidate.clock))),
    );
    if (final === undefined) {
      continue;
    }
    for (let r = 0; r < replicaCount; r++) {
      let held = false;
      trace.states.forEach((states, index) => {
        const text = states[r]?.get(id);
        const row = text === undefined ? undefined : parseRow(text);
        if (row !== undefined && row.conflictOf === null && compare(row.clock, final.clock) === "equal") {
          held = true;
        } else if (held && row !== undefined && row.conflictOf === null && !row.deleted) {
          problems.push(`replica ${r} shows ${id} live again at step ${index} (${trace.outcomes[index]?.command})`);
        }
      });
    }
  }
  return problems;
}

/** Pulls every pair, rounds times, so every replica that can sync has. */
export async function heal(system: System, now: number, rounds: number): Promise<number> {
  let time = now;
  for (let round = 0; round < rounds; round++) {
    for (let y = 0; y < system.replicaCount; y++) {
      for (let x = 0; x < system.replicaCount; x++) {
        if (x !== y) {
          time += HOUR;
          await system.pull(y, x, time);
        }
      }
    }
  }
  return time;
}

/**
 * What a replica shows: its rows without the tombstones that aren't in a
 * conflict, since one replica may have purged a tombstone another still holds.
 */
export function visibleState(state: Map<string, string>): string {
  const rows = [...state].map(([id, text]) => [id, parseRow(text)] as const);
  const conflicted = new Set(rows.flatMap(([, row]) => (row.conflictOf === null ? [] : [row.conflictOf])));
  return JSON.stringify(
    rows
      .filter(([id, row]) => !(row.conflictOf === null && row.deleted && !conflicted.has(id)))
      .map(([id]) => [id, state.get(id)])
      .sort(),
  );
}

/** CONVERGENCE: replicas that aren't stale show the same documents. */
export function divergence(system: System): string[] {
  const fresh = Array.from({ length: system.replicaCount }, (_, r) => r).filter((r) => !system.isStale(r));
  const [first, ...rest] = fresh;
  if (first === undefined) {
    return [];
  }
  const expected = visibleState(system.documentState(first));
  return rest.filter((r) => visibleState(system.documentState(r)) !== expected).map((r) => `replica ${r} differs from replica ${first}`);
}
