// Logins in progress, in memory only: a restart in the middle of a login
// means logging in again. Each is kept under the hash of the ID in the
// browser's login cookie, lasts 10 minutes, and can be taken once.

import { hashId, randomId } from "./secrets.js";

export const LOGIN_STATE_SECONDS = 10 * 60;
/** At most this many logins in progress; past it the oldest is dropped. */
export const MAX_LOGIN_STATES = 10_000;

export interface LoginState {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  /** Milliseconds since 1970. */
  readonly expiresAt: number;
}

export class LoginStates {
  // A Map keeps insertion order, so the first entry is the oldest.
  readonly #byHash = new Map<string, LoginState>();
  readonly #max: number;

  constructor(max = MAX_LOGIN_STATES) {
    this.#max = max;
  }

  /** Stores a new login; returns the ID for the cookie. */
  add(state: Omit<LoginState, "expiresAt">, now: Date): string {
    this.#prune(now);
    while (this.#byHash.size >= this.#max) {
      const oldest = this.#byHash.keys().next();
      if (oldest.done === true) break;
      this.#byHash.delete(oldest.value);
    }
    const id = randomId();
    this.#byHash.set(hashId(id), { ...state, expiresAt: now.getTime() + LOGIN_STATE_SECONDS * 1000 });
    return id;
  }

  /** Takes the login out: a second take of the same ID finds nothing. Expired logins are never returned. */
  take(id: string, now: Date): LoginState | undefined {
    const hash = hashId(id);
    const found = this.#byHash.get(hash);
    this.#byHash.delete(hash);
    return found !== undefined && found.expiresAt > now.getTime() ? found : undefined;
  }

  #prune(now: Date): void {
    for (const [hash, state] of this.#byHash) {
      if (state.expiresAt <= now.getTime()) this.#byHash.delete(hash);
    }
  }

  get size(): number {
    return this.#byHash.size;
  }
}
