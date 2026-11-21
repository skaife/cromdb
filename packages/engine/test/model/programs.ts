// Random programs for the purge, staleness and recovery properties, the
// systems they run on (the model, or the engine through an adapter in
// purge-engine.test.ts and recovery-engine.test.ts), and the properties
// themselves.

import fc from "fast-check";
import type { DocumentEnvelope } from "../../src/envelope.js";
import { canonicalString, compare, type VectorClock } from "../../src/vector-clock.js";
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
  | { readonly op: "syncAll" }
  // Recovery: a file copy of a replica, kept to restore later (a rewind);
  // restoring one, after which the replica syncs with every other; a backup;
  // replacing a replica with a new one made from a ticket by x, which
  // recovers from the old one; retiring a replica's current ID; deciding a
  // suspect; recovering again from the same old copy; trying to use a backup.
  | { readonly op: "fileCopy"; readonly r: number }
  | { readonly op: "restore"; readonly r: number; readonly pick: number }
  | { readonly op: "backup"; readonly r: number }
  | { readonly op: "reinstance"; readonly r: number; readonly x: number }
  | { readonly op: "retire"; readonly by: number; readonly r: number }
  | { readonly op: "decide"; readonly r: number; readonly pick: number; readonly accept: boolean }
  | { readonly op: "recoverAgain"; readonly r: number }
  | { readonly op: "useBackup"; readonly pick: number };

export type Outcome = "ok" | "stale" | "readOnly" | "skipped" | "refused" | "rewound";

/** A replica's permanent and passing states. */
export interface Flags {
  readonly stale: boolean;
  readonly backup: boolean;
  readonly rewound: boolean;
  readonly retired: boolean;
}

/** Whether a replica with these flags may never write or sync. */
export function blocked(flags: Flags): boolean {
  return flags.backup || flags.rewound || flags.retired;
}

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

/** A System that also does recovery. */
export interface RecoverySystem extends System {
  fileCopy(r: number): void;
  /** Puts back one of r's file copies, then r pulls from every other replica and every other from r. */
  restore(r: number, pick: number, now: number): Promise<Outcome>;
  backup(r: number, now: number): Promise<Outcome>;
  /** r is replaced by a new replica from x's ticket, pulled from x, recovering from the old one; x retires the old ID. */
  reinstance(r: number, x: number, now: number): Promise<Outcome>;
  retire(by: number, r: number, now: number): Promise<Outcome>;
  /** Decides pending suspect number pick at r, sorted by key. */
  decide(r: number, pick: number, accept: boolean, now: number): Promise<{ outcome: Outcome; id?: string; key?: string }>;
  /** Recovers again from r's last old copy: how many suspects were new. */
  recoverAgain(r: number, now: number): Promise<number | "skipped">;
  /** Tries a write on a backup and a pull from it and to it: "refused" when all three are refused. */
  useBackup(pick: number, now: number): Promise<Outcome>;
  /** Every suspect at r: "key reason state", sorted. */
  suspects(r: number): string[];
  flags(r: number): Flags;
  /** Whether r holds the registration of x's current instance ID as retired. */
  knowsRetired(y: number, x: number): boolean;
  /** Whether y holds x's current instance ID as an active replica. */
  knowsActive(y: number, x: number): boolean;
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

/** Commands for recovery programs: those of commandArbitrary, and the recovery ones. */
export function recoveryCommandArbitrary(options: ProgramOptions): fc.Arbitrary<Command> {
  const r = fc.integer({ min: 0, max: options.replicas - 1 });
  const pair = fc
    .tuple(r, fc.integer({ min: 1, max: options.replicas - 1 }))
    .map(([y, x]) => ({ y, x: (y + x) % options.replicas }));
  return fc.oneof(
    { weight: 12, arbitrary: commandArbitrary(options) },
    { weight: 2, arbitrary: r.map((i) => ({ op: "fileCopy" as const, r: i })) },
    { weight: 1, arbitrary: fc.record({ op: fc.constant("restore" as const), r, pick: fc.nat(5) }) },
    { weight: 1, arbitrary: r.map((i) => ({ op: "backup" as const, r: i })) },
    { weight: 1, arbitrary: pair.map(({ y, x }) => ({ op: "reinstance" as const, r: y, x })) },
    { weight: 1, arbitrary: pair.map(({ y, x }) => ({ op: "retire" as const, by: x, r: y })) },
    { weight: 2, arbitrary: fc.record({ op: fc.constant("decide" as const), r, pick: fc.nat(20), accept: fc.boolean() }) },
    { weight: 1, arbitrary: r.map((i) => ({ op: "recoverAgain" as const, r: i })) },
    { weight: 1, arbitrary: fc.nat(5).map((pick) => ({ op: "useBackup" as const, pick })) },
  );
}

export function recoveryProgramArbitrary(options: ProgramOptions): fc.Arbitrary<Command[]> {
  return fc.array(recoveryCommandArbitrary(options), { minLength: Math.min(20, options.maxCommands), maxLength: options.maxCommands, size: "max" });
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
  /** For each step, the replicas whose storage it replaced (restore, reinstance). */
  readonly replaced: Set<number>[];
  /** Broken rules seen while running: a blocked replica that wrote or synced, a retired one accepted, a backup used. */
  readonly violations: string[];
}

/** The clock in a suspect's key (document ID, "|", canonical clock). */
export function suspectClockOf(key: string): VectorClock {
  return JSON.parse(`{${key.slice(key.indexOf("|") + 1)}}`) as VectorClock;
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
  const trace: Trace = { history: new Map(), states: [], outcomes: [], replaced: [], violations: [] };
  const recovery = "flags" in system ? (system as RecoverySystem) : undefined;
  let replaced = new Set<number>();
  /** A pull, checked: a blocked replica never syncs, and a retired one is never accepted. */
  const pull = async (y: number, x: number): Promise<Outcome> => {
    const before = recovery === undefined ? undefined : { y: recovery.flags(y), x: recovery.flags(x), retired: recovery.knowsRetired(y, x) };
    const outcome = await system.pull(y, x, now);
    if (before !== undefined && outcome === "ok") {
      if (blocked(before.y) || blocked(before.x)) {
        trace.violations.push(`${y} pulled from ${x} with one of them blocked`);
      }
      if (before.retired) {
        trace.violations.push(`${y} pulled from ${x}, which it holds as retired`);
      }
    }
    return outcome;
  };
  /** A write, checked: a blocked replica never writes. */
  const wrote = (r: number, flags: Flags | undefined, outcome: Outcome): Outcome => {
    if (flags !== undefined && blocked(flags) && outcome === "ok") {
      trace.violations.push(`blocked replica ${r} wrote`);
    }
    return outcome;
  };
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
        const flags = recovery?.flags(command.r);
        const { outcome, id } = await system.create(command.r, now);
        if (id !== undefined) {
          record(command.r, id);
        }
        return wrote(command.r, flags, outcome);
      }
      case "edit":
      case "delete": {
        const ids = system.editable(command.r);
        const id = ids[command.pick % Math.max(1, ids.length)];
        if (id === undefined) {
          return "skipped";
        }
        const flags = recovery?.flags(command.r);
        const outcome = await system.write(command.r, id, command.op === "delete", now);
        if (outcome === "ok") {
          record(command.r, id);
        }
        return wrote(command.r, flags, outcome);
      }
      case "pull":
        return pull(command.y, command.x);
      case "pullSome":
        return system.pullSome(command.y, command.x, command.limit, now);
      case "ring": {
        // Each replica pulls from the one before it, last first, so news
        // moves one replica further each round.
        let worst: Outcome = "ok";
        for (let y = system.replicaCount - 1; y >= 0; y--) {
          const outcome = await pull(y, (y + system.replicaCount - 1) % system.replicaCount);
          if (outcome === "stale") {
            worst = "stale";
          }
          now += 1;
        }
        return worst;
      }
      case "purge":
        return system.purge(command.r, now);
      case "days": {
        const flags = recovery?.flags(command.r);
        return wrote(command.r, flags, await system.setDays(command.r, command.days, now));
      }
      case "wait":
        now += command.hours * HOUR;
        return "ok";
      case "fileCopy":
        recovery?.fileCopy(command.r);
        return "ok";
      case "restore": {
        if (recovery === undefined) return "skipped";
        const outcome = await recovery.restore(command.r, command.pick, now);
        if (outcome !== "skipped") replaced.add(command.r);
        now += 2 * system.replicaCount;
        return outcome;
      }
      case "backup":
        return recovery === undefined ? "skipped" : recovery.backup(command.r, now);
      case "reinstance": {
        if (recovery === undefined) return "skipped";
        const outcome = await recovery.reinstance(command.r, command.x, now);
        if (outcome !== "skipped") replaced.add(command.r);
        return outcome;
      }
      case "retire":
        return recovery === undefined || command.by === command.r ? "skipped" : wrote(command.by, recovery.flags(command.by), await recovery.retire(command.by, command.r, now));
      case "decide": {
        if (recovery === undefined) return "skipped";
        const flags = recovery.flags(command.r);
        const beforeState = system.documentState(command.r);
        const { outcome, id, key } = await recovery.decide(command.r, command.pick, command.accept, now);
        if (command.accept && outcome === "ok" && id !== undefined && key !== undefined) {
          record(command.r, id);
          wrote(command.r, flags, outcome);
          // The accepted version wins here: one version, after the suspect's.
          const state = system.documentState(command.r);
          const text = state.get(id);
          if (text !== undefined) {
            const primary = parseRow(text);
            const rows = [...state.values()].map(parseRow).filter((row) => row.conflictOf === id);
            const suspectClock = suspectClockOf(key);
            const earlier = [...beforeState].map(([, row]) => parseRow(row)).filter((row) => row.conflictOf === id);
            const earlierPrimary = beforeState.get(id);
            const previous = [...earlier, ...(earlierPrimary === undefined ? [] : [parseRow(earlierPrimary)])];
            if (rows.length > 0 || compare(primary.clock, suspectClock) !== "after" || previous.some((row) => compare(primary.clock, row.clock) !== "after")) {
              trace.violations.push(`accepting ${key} at ${command.r} left ${rows.length} conflict rows, or a version not after the suspect or what was there`);
            }
          }
        }
        return outcome;
      }
      case "recoverAgain": {
        if (recovery === undefined) return "skipped";
        const added = await recovery.recoverAgain(command.r, now);
        if (added !== "skipped" && added > 0) {
          trace.violations.push(`recovering again at ${command.r} found ${added} new suspects`);
        }
        return added === "skipped" ? "skipped" : "ok";
      }
      case "useBackup": {
        if (recovery === undefined) return "skipped";
        const outcome = await recovery.useBackup(command.pick, now);
        if (outcome !== "refused" && outcome !== "skipped") {
          trace.violations.push(`a backup was used: ${outcome}`);
        }
        return outcome;
      }
      case "syncAll": {
        let worst: Outcome = "ok";
        for (let y = 0; y < system.replicaCount; y++) {
          for (let x = 0; x < system.replicaCount; x++) {
            if (x !== y) {
              const outcome = await pull(y, x);
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
    replaced = new Set();
    const outcome = await run(command);
    trace.replaced.push(replaced);
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
        // Another storage now: a restored file copy, or a new replica.
        if (trace.replaced[index]?.has(r)) {
          held = false;
        }
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

/**
 * What an admin does to bring every replica back: picks a hub (a healthy
 * replica that syncs cleanly with the most others), and replaces every
 * replica that can't pull from the hub, or be pulled by it, cleanly (blocked,
 * stuck stale, gone back, unknown to it, or not knowing it) with a new one
 * from the hub's ticket, recovering from the old. Then decides every pending
 * suspect (accepting every other one). Repeats until every replica syncs both
 * ways with the hub, so heal can bring everyone together through it.
 */
export async function rescue(system: RecoverySystem, now: number): Promise<number> {
  let time = now;
  const all = Array.from({ length: system.replicaCount }, (_, i) => i);
  const healthy = (i: number) => !blocked(system.flags(i)) && !system.flags(i).stale;
  const probe = async (y: number, x: number): Promise<boolean> => {
    time += HOUR;
    return (await system.pull(y, x, time)) === "ok";
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    let hub: number | undefined;
    let best = -1;
    for (const candidate of all.filter(healthy)) {
      let clean = 0;
      for (const r of all) {
        if (r !== candidate && healthy(r) && (await probe(candidate, r)) && (await probe(r, candidate))) {
          clean++;
        }
      }
      if (clean > best) {
        best = clean;
        hub = candidate;
      }
    }
    if (hub === undefined) {
      break;
    }
    const replace: number[] = [];
    for (const r of all) {
      if (r !== hub && !(healthy(r) && (await probe(hub, r)) && (await probe(r, hub)))) {
        replace.push(r);
      }
    }
    if (replace.length === 0) {
      break;
    }
    for (const r of replace) {
      time += HOUR;
      await system.reinstance(r, hub, time);
    }
    for (let r = 0; r < system.replicaCount; r++) {
      for (let round = 0; system.suspects(r).some((line) => line.endsWith(" pending")) && round < 200; round++) {
        time += HOUR;
        await system.decide(r, 0, round % 2 === 0, time);
      }
    }
  }
  return time;
}

/** CONVERGENCE: replicas that aren't stale, or blocked, show the same documents. */
export function divergence(system: System): string[] {
  const recovery = "flags" in system ? (system as RecoverySystem) : undefined;
  const fresh = Array.from({ length: system.replicaCount }, (_, r) => r).filter(
    (r) => !system.isStale(r) && (recovery === undefined || !blocked(recovery.flags(r))),
  );
  const [first, ...rest] = fresh;
  if (first === undefined) {
    return [];
  }
  const expected = visibleState(system.documentState(first));
  return rest.filter((r) => visibleState(system.documentState(r)) !== expected).map((r) => `replica ${r} differs from replica ${first}`);
}

/**
 * The keys of the versions only old has, worked out from the raw rows alone:
 * every version (primary or conflict row) whose clock no version of the same
 * document on fresh reaches. What recover must find, exactly.
 */
export function onlyOn(old: readonly DocumentEnvelope[], fresh: readonly DocumentEnvelope[]): string[] {
  const versions = (rows: readonly DocumentEnvelope[]) => {
    const byPrimary = new Map<string, DocumentEnvelope[]>();
    for (const row of rows) {
      if (row.kind === "document") {
        const id = row.conflictOf ?? row.id;
        byPrimary.set(id, [...(byPrimary.get(id) ?? []), row]);
      }
    }
    return byPrimary;
  };
  const here = versions(fresh);
  const keys: string[] = [];
  for (const [id, rows] of versions(old)) {
    for (const row of rows) {
      if (!(here.get(id) ?? []).some((mine) => ["before", "equal"].includes(compare(row.vectorClock, mine.vectorClock)))) {
        keys.push(`${id}|${canonicalString(row.vectorClock)}`);
      }
    }
  }
  return keys.sort();
}

/** The keys of the suspects a replica holds other than known ones, from RecoverySystem.suspects lines. */
export function suspectKeys(lines: readonly string[]): string[] {
  return lines
    .filter((line) => !line.endsWith(" known"))
    .map((line) => line.split(" ")[0] as string)
    .sort();
}
