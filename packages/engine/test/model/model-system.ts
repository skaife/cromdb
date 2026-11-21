// The model as a System for programs.ts.

import { randomUUID } from "node:crypto";
import { onlyOn, suspectKeys, type Flags, type Outcome, type RecoverySystem } from "./programs.js";
import { DAY, Model, documentState, type ModelFaults, type ModelReplica } from "./sync-model.js";

export class ModelSystem implements RecoverySystem {
  readonly model: Model;
  readonly replicas: ModelReplica[];
  /** For each replica, its file copies, oldest first. */
  readonly files: ModelReplica[][];
  readonly backups: ModelReplica[] = [];
  /** For each replica, the storage it replaced when it was last reinstanced. */
  readonly old: (ModelReplica | undefined)[];
  /** Every recover that didn't find exactly the versions only the old copy had. */
  readonly problems: string[] = [];
  /** Instance IDs to use for new replicas, as the engine chose them; random if none. */
  readonly nextIds: string[] = [];

  /** Founds replica 0 with purgeAfterDays days, copies it to the others, and lets every replica pull from every other once. */
  constructor(
    readonly replicaCount: number,
    start: number,
    days: number,
    faults: ModelFaults = {},
    ids: readonly string[] = Array.from({ length: replicaCount }, () => randomUUID()),
  ) {
    this.model = new Model("admin", faults);
    const first = this.model.found(ids[0] as string, start);
    this.model.setPurgeAfterDays(first, days, start);
    this.replicas = [first];
    for (let r = 1; r < replicaCount; r++) {
      this.replicas.push(this.model.copy(first, ids[r] as string, start));
    }
    // Each copy's first open records its engine's highest level.
    for (let r = 1; r < replicaCount; r++) {
      this.model.opened(this.#at(r), start);
    }
    // So every replica knows every other, as the engine's registrations need.
    for (let r = 1; r < replicaCount; r++) {
      this.model.pull(this.#at(r), first, start);
    }
    this.files = Array.from({ length: replicaCount }, () => []);
    this.old = Array.from({ length: replicaCount }, () => undefined);
  }

  #newId(): string {
    return this.nextIds.shift() ?? randomUUID();
  }

  #at(r: number): ModelReplica {
    return this.replicas[r] as ModelReplica;
  }

  async create(r: number, now: number, id: string = randomUUID()): Promise<{ outcome: Outcome; id?: string }> {
    const outcome = this.model.create(this.#at(r), id, now);
    return outcome === "ok" ? { outcome, id } : { outcome: "readOnly" };
  }

  async write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome> {
    if (!this.#at(r).writable) {
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

  // ---- recovery ----

  fileCopy(r: number): void {
    this.files[r]?.push(this.#at(r).clone());
  }

  async restore(r: number, pick: number, now: number): Promise<Outcome> {
    const files = this.files[r] ?? [];
    const file = files[pick % Math.max(1, files.length)];
    if (file === undefined) {
      return "skipped";
    }
    this.replicas[r] = file.clone();
    // Another replica's storage now, which never recovered from anything.
    this.old[r] = undefined;
    this.model.opened(this.#at(r), now);
    return this.#detect(r, pick, now);
  }

  /** After a restore: r pulls from every other replica and every other from r, in an order pick chooses. The worst outcome. */
  async #detect(r: number, pick: number, now: number): Promise<Outcome> {
    let worst: Outcome = "ok";
    const note = (outcome: Outcome) => {
      if (outcome === "rewound" || (outcome !== "ok" && worst === "ok")) worst = outcome;
    };
    // pick chooses what happens next: the restored copy pulls first, the
    // others pull from it first, or nothing yet (it may write before anyone
    // syncs with it).
    if (pick % 3 === 2) {
      return "ok";
    }
    const first = pick % 3 === 0;
    for (const puller of first ? ["r", "others"] : ["others", "r"]) {
      for (let x = 0; x < this.replicaCount; x++) {
        if (x !== r) note(puller === "r" ? await this.pull(r, x, now) : await this.pull(x, r, now));
      }
    }
    return worst;
  }

  async backup(r: number, now: number): Promise<Outcome> {
    const copy = this.model.backup(this.#at(r), now);
    if (copy === undefined) {
      return "readOnly";
    }
    this.backups.push(copy);
    return "ok";
  }

  async reinstance(r: number, x: number, now: number): Promise<Outcome> {
    const introducer = this.#at(x);
    if (x === r || !introducer.writable) {
      return "skipped";
    }
    const old = this.#at(r);
    const fresh = this.model.fromTicket(introducer, this.#newId(), now);
    if (fresh === undefined) {
      return "skipped";
    }
    const pulled = this.model.pull(fresh, introducer, now);
    const expected = onlyOn([...old.rows.values()], [...fresh.rows.values()]);
    this.model.recover(fresh, old);
    const found = suspectKeys([...fresh.suspects.values()].map((suspect) => `${suspect.key} ${suspect.reason} ${suspect.state}`));
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      this.problems.push(`recover at ${r} found ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}`);
    }
    this.model.retire(introducer, old.id, now);
    this.replicas[r] = fresh;
    this.old[r] = old;
    return pulled === "ok" ? "ok" : pulled;
  }

  async retire(by: number, r: number, now: number): Promise<Outcome> {
    return this.model.retire(this.#at(by), this.#at(r).id, now);
  }

  async decide(r: number, pick: number, accept: boolean, now: number): Promise<{ outcome: Outcome; id?: string; key?: string }> {
    const replica = this.#at(r);
    const pending = this.model.pending(replica);
    const suspect = pending[pick % Math.max(1, pending.length)];
    if (suspect === undefined) {
      return { outcome: "skipped" };
    }
    const outcome = accept ? this.model.accept(replica, suspect.key, now) : this.model.discard(replica, suspect.key);
    return { outcome, id: suspect.primaryId, key: suspect.key };
  }

  async recoverAgain(r: number): Promise<number | "skipped"> {
    const old = this.old[r];
    if (old === undefined) {
      return "skipped";
    }
    const added = this.model.recover(this.#at(r), old);
    return added === "refused" ? "skipped" : added;
  }

  async useBackup(pick: number, now: number): Promise<Outcome> {
    const backup = this.backups[pick % Math.max(1, this.backups.length)];
    if (backup === undefined) {
      return "skipped";
    }
    const wrote = this.model.create(backup, randomUUID(), now);
    const pulled = this.model.pull(backup, this.#at(0), now);
    const pulledFrom = this.model.pull(this.#at(0), backup, now);
    return wrote !== "ok" && pulled !== "ok" && pulledFrom !== "ok" ? "refused" : "ok";
  }

  suspects(r: number): string[] {
    return [...this.#at(r).suspects.values()].map((suspect) => `${suspect.key} ${suspect.reason} ${suspect.state}`).sort();
  }

  flags(r: number): Flags {
    const replica = this.#at(r);
    return { stale: replica.stale !== undefined, backup: replica.backupOf !== undefined, rewound: replica.rewound, retired: replica.retired };
  }

  knowsActive(y: number, x: number): boolean {
    return this.#at(y).status(this.#at(x).id) === "active";
  }

  knowsRetired(y: number, x: number): boolean {
    return this.#at(y).status(this.#at(x).id) === "retired";
  }
}

export { DAY };
