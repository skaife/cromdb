// The model as a System for programs.ts.

import { randomUUID } from "node:crypto";
import type { Outcome, System } from "./programs.js";
import { DAY, Model, documentState, type ModelFaults, type ModelReplica } from "./sync-model.js";

export class ModelSystem implements System {
  readonly model: Model;
  readonly replicas: ModelReplica[];

  /** Founds replica 0 with purgeAfterDays days, copies it to the others, and lets every replica pull from every other once. */
  constructor(
    readonly replicaCount: number,
    start: number,
    days: number,
    faults: ModelFaults = {},
    ids: readonly string[] = Array.from({ length: replicaCount }, () => randomUUID()),
  ) {
    this.model = new Model("admin", faults);
    const first = this.model.found(ids[0] as string);
    this.model.setPurgeAfterDays(first, days, start);
    this.replicas = [first];
    for (let r = 1; r < replicaCount; r++) {
      this.replicas.push(this.model.copy(first, ids[r] as string, start));
    }
    // So every replica knows every other, as the engine's registrations need.
    for (let r = 1; r < replicaCount; r++) {
      this.model.pull(this.#at(r), first, start);
    }
  }

  #at(r: number): ModelReplica {
    return this.replicas[r] as ModelReplica;
  }

  async create(r: number, now: number, id: string = randomUUID()): Promise<{ outcome: Outcome; id?: string }> {
    const outcome = this.model.create(this.#at(r), id, now);
    return outcome === "ok" ? { outcome, id } : { outcome: "readOnly" };
  }

  async write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome> {
    if (this.#at(r).stale !== undefined) {
      return "readOnly";
    }
    return this.model.write(this.#at(r), id, deleted, now);
  }

  async pull(y: number, x: number, now: number): Promise<Outcome> {
    return this.model.pull(this.#at(y), this.#at(x), now);
  }

  async pullSome(y: number, x: number, limit: number, now: number): Promise<Outcome> {
    return this.model.pull(this.#at(y), this.#at(x), now, limit);
  }

  async purge(r: number, now: number): Promise<Outcome> {
    return this.model.purge(this.#at(r), now);
  }

  async setDays(r: number, days: number, now: number): Promise<Outcome> {
    const outcome = this.model.setPurgeAfterDays(this.#at(r), days, now);
    return outcome === "ok" ? "ok" : "readOnly";
  }

  editable(r: number): string[] {
    const replica = this.#at(r);
    return [...replica.live().keys()].filter((id) => this.model.editable(replica, id)).sort();
  }

  documentState(r: number): Map<string, string> {
    return documentState(this.#at(r));
  }

  isStale(r: number): boolean {
    return this.#at(r).stale !== undefined;
  }
}

export { DAY };
