import { isAuthorizedVersion } from "./acl.js";
import { compareRank, type ConflictPolicy } from "./conflict-policy.js";
import type { DocumentEnvelope } from "./envelope.js";
import { derivedId } from "./ids.js";
import { canonicalString, compare, countFor, type VectorClock } from "./vector-clock.js";

// How a document's versions are stored: the highest-ranked one in the
// document's own row (the primary), each other concurrent one in a conflict
// row. Everything here is pure; Database does the reads and writes.

/** The ID of the conflict row holding the version with this clock. Every replica computes the same one. */
export function conflictRowId(primaryId: string, clock: VectorClock): string {
  return derivedId(primaryId, `conflict:${canonicalString(clock)}`);
}

export interface Arrangement {
  readonly primary: DocumentEnvelope;
  /** By rank, highest first. */
  readonly others: readonly DocumentEnvelope[];
}

/**
 * Drops duplicate clocks (keeping the first given) and every version that is
 * before an authorized version, then ranks the rest. An unauthorized version
 * never supersedes anything, so a forged descendant can't wipe out the
 * version it claims to follow: both stay. The result depends only on the set
 * of clocks given, not on their order. Throws TypeError for an empty list.
 */
export function arrange(versions: readonly DocumentEnvelope[], policy: ConflictPolicy): Arrangement {
  const unique: DocumentEnvelope[] = [];
  for (const version of versions) {
    if (!unique.some((kept) => compare(kept.vectorClock, version.vectorClock) === "equal")) {
      unique.push(version);
    }
  }
  const current = unique.filter(
    (version) =>
      !unique.some((other) => isAuthorizedVersion(other) && compare(version.vectorClock, other.vectorClock) === "before"),
  );
  const [primary, ...others] = current.sort((a, b) => compareRank(policy, a, b));
  if (primary === undefined) {
    throw new TypeError("arrange needs at least one version");
  }
  return { primary, others };
}

// Writer keys. A replica writes a document's clock with its instance ID, or
// with "<instanceId>/<n>". A vector clock means exact causality only while
// each key's writes form a chain, each written from the previous one. A
// replica holding its own earlier version as a conflict, and writing from
// another version, would break its chain; it starts a new key instead.

const KEY_INDEX = /^[1-9][0-9]*$/;

/** 0 for instanceId itself, n for "instanceId/n", undefined for any other key. */
export function writerKeyIndex(instanceId: string, key: string): number | undefined {
  if (key === instanceId) {
    return 0;
  }
  const prefix = `${instanceId}/`;
  if (!key.startsWith(prefix)) {
    return undefined;
  }
  const rest = key.slice(prefix.length);
  if (!KEY_INDEX.test(rest)) {
    return undefined;
  }
  const index = Number(rest);
  return Number.isSafeInteger(index) ? index : undefined;
}

/** The highest count for key among the document's stored clocks, or 0. */
export function latestCount(key: string, stored: readonly VectorClock[]): number {
  return Math.max(0, ...stored.map((clock) => countFor(clock, key)));
}

/**
 * The clock for a write by instanceId made from base (the clock of what the
 * writer read), given every stored clock of the document. Increments an own
 * key whose latest count is base's count for it: instanceId if it
 * qualifies, else the lowest qualifying n. If none does, starts the smallest
 * "instanceId/n" absent from every stored clock, at 1.
 */
export function writerClock(instanceId: string, base: VectorClock, stored: readonly VectorClock[]): VectorClock {
  const indexes = new Set<number>([0]);
  for (const clock of stored) {
    for (const key of Object.keys(clock)) {
      const index = writerKeyIndex(instanceId, key);
      if (index !== undefined) {
        indexes.add(index);
      }
    }
  }
  const keyFor = (index: number): string => (index === 0 ? instanceId : `${instanceId}/${index}`);
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const key = keyFor(index);
    const count = countFor(base, key);
    if (count === latestCount(key, stored)) {
      if (count >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`Counter for key "${key}" exceeds the maximum safe integer`);
      }
      return { ...base, [key]: count + 1 };
    }
  }
  let next = 1;
  while (indexes.has(next)) {
    next++;
  }
  return { ...base, [keyFor(next)]: 1 };
}
