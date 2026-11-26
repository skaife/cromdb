// The update check, off unless the updateCheck setting is on: about once a
// day the server asks GitHub for the repository's server-vX.Y.Z tags and
// says on the Status page when a newer version is published. It only reads
// that one reply. It never downloads or installs anything, and it sends
// nothing about this server beyond a plain web request.
//
// Its own timer, not maintenance: a first check a minute after the start
// (or after the setting is turned on), then every 24 hours. A failed check
// waits for the next day. The result is kept in memory only, so a restart
// checks again.

/** The tag names, such as "server-v0.4.0". The real one asks GitHub; tests give their own. */
export type UpdateSource = () => Promise<readonly string[]>;

export const UPDATE_FIRST_CHECK_MS = 60_000;
export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60_000;
export const UPDATE_TIMEOUT_MS = 10_000;

const REPOSITORY = "skaife/cromdb";
const TAG_PREFIX = "server-v";
const GITHUB_API = "https://api.github.com";

export type UpdateState = "off" | "pending" | "current" | "available" | "failed";

/** What GET /server/status says about updates. */
export interface UpdateStatus {
  readonly state: UpdateState;
  /** When the last check ended, or null before the first. */
  readonly checkedAt: string | null;
  /** The newest version above this one, when there is one. */
  readonly latest: string | null;
  /** Where that version's changes are listed, when there is one. */
  readonly changesUrl: string | null;
}

/** "0.4.0" as numbers; anything else (a suffix, a leading zero, a v) is not a version here. */
export function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The highest server-vX.Y.Z tag above the running version, as "X.Y.Z"; other tag names are ignored. */
export function newestAbove(tags: readonly string[], running: string): string | undefined {
  const current = parseVersion(running);
  if (current === undefined) return undefined;
  let best: readonly [number, number, number] | undefined;
  let bestText: string | undefined;
  for (const tag of tags) {
    if (!tag.startsWith(TAG_PREFIX)) continue;
    const text = tag.slice(TAG_PREFIX.length);
    const version = parseVersion(text);
    if (version === undefined || compare(version, current) <= 0) continue;
    if (best === undefined || compare(version, best) > 0) {
      best = version;
      bestText = text;
    }
  }
  return bestText;
}

/** The tag names in GitHub's reply to git/matching-refs: [{ "ref": "refs/tags/server-v0.4.0", ... }, ...]. */
export function tagsOfRefs(reply: unknown): string[] {
  if (!Array.isArray(reply)) throw new Error("GitHub's reply is not a list of refs");
  const tags: string[] = [];
  for (const entry of reply) {
    const ref = typeof entry === "object" && entry !== null && Object.hasOwn(entry, "ref") ? (entry as { ref: unknown }).ref : undefined;
    if (typeof ref === "string" && ref.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
  }
  return tags;
}

/** The page listing a version's changes, at its tag. */
export function changesUrl(version: string): string {
  return `https://github.com/${REPOSITORY}/blob/${TAG_PREFIX}${version}/packages/server/CHANGELOG.md`;
}

/**
 * The server-v tags from GitHub: one unauthenticated GET of the git refs
 * that start with server-v. The base address is for tests, which stand a
 * local server in for api.github.com.
 */
export function githubSource(base = GITHUB_API): UpdateSource {
  return async () => {
    const response = await fetch(`${base}/repos/${REPOSITORY}/git/matching-refs/tags/${TAG_PREFIX}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "cromdb-server" },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error(`GitHub answered ${response.status}`);
    return tagsOfRefs(await response.json());
  };
}

export interface UpdateCheckOptions {
  /** The running version. */
  readonly running: string;
  readonly enabled: boolean;
  readonly source: UpdateSource;
  readonly now: () => Date;
  readonly log: (message: string) => void;
  /** For tests and the dev server: how long after the start (or turning it on) the first check waits. */
  readonly firstCheckMs?: number;
}

type Result = { readonly kind: "current" | "failed"; readonly at: Date } | { readonly kind: "available"; readonly at: Date; readonly latest: string };

export class UpdateCheck {
  readonly #options: UpdateCheckOptions;
  #enabled = false;
  #timer: NodeJS.Timeout | undefined;
  #result: Result | undefined;
  /** Bumped when the setting changes, so a check still running then is dropped. */
  #generation = 0;
  #announced: string | undefined;

  constructor(options: UpdateCheckOptions) {
    this.#options = options;
    this.setEnabled(options.enabled);
  }

  /** Live: on starts the first check a minute later; off stops it and forgets the last result. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#generation += 1;
    this.#result = undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (enabled) this.#schedule(this.#options.firstCheckMs ?? UPDATE_FIRST_CHECK_MS);
  }

  get status(): UpdateStatus {
    if (!this.#enabled) return { state: "off", checkedAt: null, latest: null, changesUrl: null };
    const result = this.#result;
    if (result === undefined) return { state: "pending", checkedAt: null, latest: null, changesUrl: null };
    const checkedAt = result.at.toISOString();
    return result.kind === "available"
      ? { state: "available", checkedAt, latest: result.latest, changesUrl: changesUrl(result.latest) }
      : { state: result.kind, checkedAt, latest: null, changesUrl: null };
  }

  /** Checks now, as the timer does. For tests. */
  async checkNow(): Promise<void> {
    const generation = this.#generation;
    const { source, running, now, log } = this.#options;
    let result: Result;
    try {
      const latest = newestAbove(await source(), running);
      result = latest === undefined ? { kind: "current", at: now() } : { kind: "available", at: now(), latest };
    } catch (error) {
      result = { kind: "failed", at: now() };
      log(`The update check could not reach GitHub: ${error instanceof Error ? error.message : String(error)}. It tries again in a day.`);
    }
    if (generation !== this.#generation) return;
    this.#result = result;
    if (result.kind === "available" && result.latest !== this.#announced) {
      this.#announced = result.latest;
      log(`CromDB Server ${result.latest} is available (this server runs ${running}): ${changesUrl(result.latest)}`);
    }
  }

  close(): void {
    this.#enabled = false;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(ms: number): void {
    this.#timer = setTimeout(() => {
      const generation = this.#generation;
      void this.checkNow().finally(() => {
        if (generation === this.#generation && this.#enabled) this.#schedule(UPDATE_CHECK_EVERY_MS);
      });
    }, ms);
    this.#timer.unref();
  }
}
