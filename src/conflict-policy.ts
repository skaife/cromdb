// The rules that rank conflicting versions. Replicas must use the same policy
// to sync. The policy is local state on each replica and never replicates.
// The ranking itself is not built yet; for now only the name matters, so
// batches and replicas can be matched.

export const DEFAULT_POLICY = "default@1";

const KNOWN_POLICIES: ReadonlySet<string> = new Set([DEFAULT_POLICY]);

export function isKnownPolicy(name: string): boolean {
  return KNOWN_POLICIES.has(name);
}
