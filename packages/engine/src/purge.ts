import type { DocumentEnvelope } from "./envelope.js";
import { canonicalString, countFor, merge } from "./vector-clock.js";

// Purge and staleness, the pure parts. Database does the reads and writes.
//
// Knowledge: for each other replica, the position in its change log up to
// which this replica is known to hold everything it held (or later versions).
// It grows directly, by applying that replica's batches, and transitively,
// when a pull from a replica finishes: this replica then holds everything
// the source held, so it takes the larger of its own and the source's
// knowledge of every replica.
//
// Purge horizons: for each replica, the position in its change log up to
// which it may have removed tombstones, its own and those it inherited with
// the knowledge of the replicas it pulled from (a replica that took over a
// source's knowledge lacks whatever the source purged, just as the source
// does).
//
// A pull is refused as stale when the puller can't show it holds everything
// below the source's purge horizons (check i), or when the source can't show
// it holds everything below the puller's (check ii). Neither check proves a
// tombstone is missing; they prove it can't be shown present, so a refusal
// may be unnecessary, but a pull they let through can't bring a purged
// document back.

/** A position in each replica's change log, by instance ID. */
export type SeqMap = Readonly<Record<string, number>>;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** @internal How long one checkpoint covers at most. */
export const CHECKPOINT_WINDOW_MS = HOUR_MS;
/** @internal Above this many closed checkpoints, every other older one is dropped. */
export const MAX_CHECKPOINTS = 1000;

/**
 * When this replica recorded the entries of its change log, coarsely: each
 * closed checkpoint [seq, at] says every entry up to seq was recorded at or
 * before at. The open one is the latest window, still growing.
 */
export interface Checkpoints {
  readonly closed: readonly (readonly [number, number])[];
  readonly open?: { readonly seq: number; readonly at: number; readonly since: number };
}

/**
 * Records that the log reached seq at time now. Times never go backwards: a
 * clock that jumps back is taken as standing still.
 */
export function noteCheckpoint(checkpoints: Checkpoints, seq: number, now: number): Checkpoints {
  const open = checkpoints.open;
  if (open === undefined) {
    return { closed: checkpoints.closed, open: { seq, at: now, since: now } };
  }
  if (now - open.since >= CHECKPOINT_WINDOW_MS) {
    let closed = [...checkpoints.closed, [open.seq, open.at] as const];
    if (closed.length > MAX_CHECKPOINTS) {
      // Dropping a checkpoint only makes the entries before it look newer.
      closed = closed.filter((_, index) => index % 2 === 1 || index === closed.length - 1);
    }
    return { closed, open: { seq, at: Math.max(now, open.at), since: now } };
  }
  return { closed: checkpoints.closed, open: { seq, at: Math.max(now, open.at), since: open.since } };
}

/** The highest position whose entries were all recorded at or before cutoff, or 0. */
export function purgeCandidate(checkpoints: Checkpoints, cutoff: number): number {
  const points: (readonly [number, number])[] = [...checkpoints.closed];
  if (checkpoints.open !== undefined) {
    points.push([checkpoints.open.seq, checkpoints.open.at]);
  }
  return Math.max(0, ...points.filter(([, at]) => at <= cutoff).map(([seq]) => seq));
}

/** Drops closed checkpoints at or before cutoff except the newest: later purges have later cutoffs. */
export function trimCheckpoints(checkpoints: Checkpoints, cutoff: number): Checkpoints {
  const old = checkpoints.closed.filter(([, at]) => at <= cutoff);
  const newestOld = old.at(-1);
  return { ...checkpoints, closed: checkpoints.closed.filter((point) => point[1] > cutoff || point === newestOld) };
}

/** Each entry the larger of the two, leaving out skip. */
export function maxMerge(a: SeqMap, b: SeqMap, skip?: string): SeqMap {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key !== skip && value > (out[key] ?? 0)) {
      out[key] = value;
    }
  }
  if (skip !== undefined) {
    delete out[skip];
  }
  return out;
}

/**
 * The entries of horizons that knowledge doesn't reach, leaving out the
 * replicas in exempt (a replica holds everything of its own log, and a
 * source can't send back what it purged itself). Empty when covered.
 */
export function uncovered(knowledge: SeqMap, horizons: SeqMap, exempt: readonly string[]): [string, number, number][] {
  return Object.entries(horizons)
    .filter(([replica, horizon]) => !exempt.includes(replica) && (knowledge[replica] ?? 0) < horizon)
    .map(([replica, horizon]) => [replica, knowledge[replica] ?? 0, horizon]);
}

/**
 * @internal The order a merged system version's stamps come from: updatedAt,
 * then updatedOn, then updatedBy, then the clock's canonical form. It doesn't
 * depend on clocks' sizes, so merging is associative.
 */
export function compareStamps(a: DocumentEnvelope, b: DocumentEnvelope): number {
  const key = (row: DocumentEnvelope) => [row.updatedAt, row.updatedOn, row.updatedBy, canonicalString(row.vectorClock)];
  const [x, y] = [key(a), key(b)];
  for (let index = 0; index < x.length; index++) {
    const p = x[index] as string;
    const q = y[index] as string;
    if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @internal Two concurrent versions of a system document that merges, as one
 * version every replica computes the same way: the clock is both clocks'
 * entry by entry maximum; the stamps, readers and writers come from the
 * version that is later by compareStamps; the content from content(a, b).
 */
export function mergeSystemVersions(
  a: DocumentEnvelope,
  b: DocumentEnvelope,
  content: (a: DocumentEnvelope, b: DocumentEnvelope) => DocumentEnvelope["content"],
): DocumentEnvelope {
  const stamps = compareStamps(a, b) >= 0 ? a : b;
  return { ...stamps, vectorClock: merge(a.vectorClock, b.vectorClock), content: content(a, b) };
}

/** @internal Settings: the larger purgeAfterDays, the safer one. */
export function mergeSettingsContent(a: DocumentEnvelope, b: DocumentEnvelope): DocumentEnvelope["content"] {
  const days = (version: DocumentEnvelope) => version.content["purgeAfterDays"] as number;
  return { ...(days(a) >= days(b) ? a.content : b.content) };
}

/**
 * @internal A registration: the fields the replica writes about itself from
 * the version with more of that replica's own writes (its writes are in
 * order), and status "retired" if either version says so.
 */
export function mergeRegistrationContent(a: DocumentEnvelope, b: DocumentEnvelope): DocumentEnvelope["content"] {
  const owner = a.content["instanceId"] as string;
  const ownCount = (version: DocumentEnvelope) => countFor(version.vectorClock, owner);
  const base = ownCount(a) > ownCount(b) ? a : ownCount(b) > ownCount(a) ? b : compareStamps(a, b) >= 0 ? a : b;
  const retired = a.content["status"] === "retired" || b.content["status"] === "retired";
  return { ...base.content, status: retired ? "retired" : "active" };
}
