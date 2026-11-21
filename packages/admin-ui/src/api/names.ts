// Person IDs to names. Every ID a screen shows is asked for at once, in
// batches of up to 100 (GET /api/v0/people/cards), and kept for the life of
// the page. A name is shown as the person's display name; "you" for the
// person logged in; and a shortened ID (the full one on hover) for an ID the
// server doesn't know or a person with no display name.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "./client.ts";

/** IDs that aren't people. */
export const SERVER_PRINCIPAL = "cromdb-server";
export const EVERYONE = "*";

const BATCH = 100;

export interface NameLabel {
  /** What to show. */
  readonly text: string;
  /** The full ID, when text isn't a name the ID can be told by. */
  readonly title?: string;
}

/** The first 8 characters of an ID and an ellipsis, or the ID if it's short. */
export function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

type Lookup = (ids: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;

const lookupCards: Lookup = async (ids) => {
  const { data } = await api("getPersonCards", { query: { ids: ids.join(",") } });
  return new Map(data.people.map((card) => [card.personId, card.displayName]));
};

/** Names already known, IDs being asked for, and who to tell when names arrive. */
export class NameBook {
  readonly #lookup: Lookup;
  /** By ID: the display name, null for a person with none, undefined for no such person. */
  readonly #known = new Map<string, string | null | undefined>();
  readonly #pending = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #scheduled = false;
  #version = 0;

  constructor(lookup: Lookup = lookupCards) {
    this.#lookup = lookup;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Changes whenever names arrive. */
  version = (): number => this.#version;

  /** Asks for the IDs not yet known or asked for. They are fetched together, after the current task. */
  want(ids: readonly string[]): void {
    for (const id of ids) {
      if (id === "" || id === SERVER_PRINCIPAL || id === EVERYONE || this.#known.has(id)) continue;
      this.#pending.add(id);
    }
    if (this.#pending.size > 0 && !this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => void this.#flush());
    }
  }

  async #flush(): Promise<void> {
    this.#scheduled = false;
    const ids = [...this.#pending];
    this.#pending.clear();
    for (const id of ids) this.#known.set(id, undefined);
    for (let start = 0; start < ids.length; start += BATCH) {
      const batch = ids.slice(start, start + BATCH);
      try {
        const found = await this.#lookup(batch);
        for (const id of batch) this.#known.set(id, found.has(id) ? (found.get(id) ?? null) : undefined);
      } catch {
        // Shown as IDs; asked again next time a screen wants them.
        for (const id of batch) this.#known.delete(id);
      }
    }
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  /** How to show an ID now. me is the person logged in. */
  label(id: string, me: string | undefined): NameLabel {
    if (id === me) return { text: "you" };
    if (id === SERVER_PRINCIPAL) return { text: "The server", title: id };
    if (id === EVERYONE) return { text: "Everyone who logs in", title: id };
    const name = this.#known.get(id);
    return typeof name === "string" && name !== "" ? { text: name, title: id } : { text: shortId(id), title: id };
  }
}

export const names = new NameBook();

/** Asks for the IDs, and re-renders when names arrive. */
export function useNames(ids: readonly string[], book: NameBook = names): NameBook {
  const key = ids.join(",");
  useEffect(() => {
    book.want(key === "" ? [] : key.split(","));
  }, [book, key]);
  useSyncExternalStore(book.subscribe, book.version);
  return book;
}
