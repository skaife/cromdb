import type { Document } from "./document.js";

/**
 * Documents found by Database.find or Document.getChildren. Which documents
 * belong is fixed when the set is loaded; to pick up later changes, call find
 * again.
 *
 * Each iteration loads each document fresh, with the same rules as
 * Database.get. A document deleted or made unreadable since the set was
 * loaded is skipped, and count doesn't change. A document edited so that it
 * no longer matches the filter's "where" is still yielded, with its current
 * content. Each new iteration starts over from the first document.
 */
export class DocumentSet<T extends Record<string, unknown>> {
  /** How many documents belonged to the set when it was loaded. */
  readonly count: number;

  readonly #ids: readonly string[];
  readonly #load: (id: string) => Promise<Document<T> | undefined>;

  /** @internal Sets come from Database.find and Document.getChildren. */
  constructor(ids: readonly string[], load: (id: string) => Promise<Document<T> | undefined>) {
    this.#ids = Object.freeze([...ids]);
    this.#load = load;
    this.count = this.#ids.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Document<T>> {
    for (const id of this.#ids) {
      const doc = await this.#load(id);
      if (doc !== undefined) {
        yield doc;
      }
    }
  }
}
