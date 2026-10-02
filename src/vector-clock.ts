export type VectorClock = Readonly<Record<string, number>>;

export type ClockOrder = "equal" | "before" | "after" | "concurrent";

function countFor(clock: VectorClock, instanceId: string): number {
  return Object.hasOwn(clock, instanceId) ? (clock[instanceId] ?? 0) : 0;
}

export function normalize(clock: Record<string, number>): VectorClock {
  const entries: [string, number][] = [];

  for (const [instanceId, count] of Object.entries(clock)) {
    if (instanceId.length === 0) {
      throw new TypeError('Invalid counter for key "": instance ID must be non-empty');
    }

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(
        `Invalid counter for key "${instanceId}": expected a non-negative safe integer`,
      );
    }

    if (count > 0) {
      entries.push([instanceId, count]);
    }
  }

  return Object.fromEntries(entries);
}

export function increment(clock: VectorClock, instanceId: string): VectorClock {
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError("instanceId must be a non-empty string");
  }

  const currentCount = countFor(clock, instanceId);
  if (currentCount >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Counter for key "${instanceId}" exceeds the maximum safe integer`);
  }

  return { ...clock, [instanceId]: currentCount + 1 };
}

export function compare(a: VectorClock, b: VectorClock): ClockOrder {
  let aIsBefore = false;
  let aIsAfter = false;
  const instanceIds = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const instanceId of instanceIds) {
    const aCount = countFor(a, instanceId);
    const bCount = countFor(b, instanceId);

    if (aCount < bCount) {
      aIsBefore = true;
    } else if (aCount > bCount) {
      aIsAfter = true;
    }

    if (aIsBefore && aIsAfter) {
      return "concurrent";
    }
  }

  if (aIsBefore) {
    return "before";
  }
  if (aIsAfter) {
    return "after";
  }
  return "equal";
}

export function merge(a: VectorClock, b: VectorClock): VectorClock {
  const instanceIds = new Set([...Object.keys(a), ...Object.keys(b)]);
  const entries: [string, number][] = [];

  for (const instanceId of instanceIds) {
    const count = Math.max(countFor(a, instanceId), countFor(b, instanceId));
    if (count > 0) {
      entries.push([instanceId, count]);
    }
  }

  return Object.fromEntries(entries);
}

export function totalEdits(clock: VectorClock): number {
  return Object.values(clock).reduce((total, count) => total + count, 0);
}

function canonicalize(clock: VectorClock): string {
  // Quote IDs so commas and colons inside an ID cannot create serialization collisions.
  return Object.keys(clock)
    .filter((instanceId) => countFor(clock, instanceId) !== 0)
    .sort()
    .map((instanceId) => `${JSON.stringify(instanceId)}:${countFor(clock, instanceId)}`)
    .join(",");
}

export function canonicalCompare(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  const canonicalA = canonicalize(a);
  const canonicalB = canonicalize(b);

  if (canonicalA < canonicalB) {
    return -1;
  }
  if (canonicalA > canonicalB) {
    return 1;
  }
  return 0;
}