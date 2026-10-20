import { isAuthorizedVersion } from "./acl.js";
import type { DocumentEnvelope } from "./envelope.js";
import { canonicalCompare, totalEdits } from "./vector-clock.js";

// The rules that rank concurrent versions of a document, so every replica
// picks the same interim primary. Replicas must use the same policy to sync.
// The policy is local state on each replica and never replicates.

/** Ranks two concurrent versions. Negative: a ranks higher. 0: the policy can't tell them apart. */
export interface ConflictPolicy {
  readonly name: string;
  compare(a: DocumentEnvelope, b: DocumentEnvelope): number;
}

export const DEFAULT_POLICY = "default@1";

/** Highest first: authorized, live, more total edits, later updatedAt, higher updatedOn. */
const defaultPolicy: ConflictPolicy = {
  name: DEFAULT_POLICY,
  compare(a, b) {
    const authorized = Number(isAuthorizedVersion(b)) - Number(isAuthorizedVersion(a));
    if (authorized !== 0) {
      return authorized;
    }
    const live = Number(a.deleted) - Number(b.deleted);
    if (live !== 0) {
      return live;
    }
    const edits = totalEdits(b.vectorClock) - totalEdits(a.vectorClock);
    if (edits !== 0) {
      return edits;
    }
    // Compared as instants, not strings, so years past 9999 still order.
    const updated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updated !== 0) {
      return updated;
    }
    if (a.updatedOn !== b.updatedOn) {
      return a.updatedOn > b.updatedOn ? -1 : 1;
    }
    return 0;
  },
};

const POLICIES: ReadonlyMap<string, ConflictPolicy> = new Map([[DEFAULT_POLICY, defaultPolicy]]);

export function isKnownPolicy(name: string): boolean {
  return POLICIES.has(name);
}

/** Throws TypeError for a name isKnownPolicy refuses. */
export function policyNamed(name: string): ConflictPolicy {
  const policy = POLICIES.get(name);
  if (policy === undefined) {
    throw new TypeError(`Unknown conflict policy ${JSON.stringify(name)}`);
  }
  return policy;
}

/**
 * The engine's rank order: the policy's, then the canonical order of the
 * clocks (the higher canonical form ranks higher), so the order is strict and
 * total for different clocks whatever the policy does. Negative: a ranks
 * higher.
 */
export function compareRank(policy: ConflictPolicy, a: DocumentEnvelope, b: DocumentEnvelope): number {
  const byPolicy = Math.sign(policy.compare(a, b));
  if (byPolicy !== 0) {
    return byPolicy;
  }
  return canonicalCompare(b.vectorClock, a.vectorClock);
}
