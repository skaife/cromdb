// The engine as a System for programs.ts: replicas of one level-4 database,
// each on its own in-memory adapter, all opened by the same admin.

import type { Database } from "../../src/database.js";
import { CromDBError } from "../../src/errors.js";
import { Session } from "../../src/session.js";
import type { StoredSuspect } from "../../src/storage/adapter.js";
import { registrationDocId } from "../../src/system-docs.js";
import { TestAdapter } from "../helpers.js";
import type { Flags, Outcome, RecoverySystem } from "./programs.js";
import { describeRow, writeTag } from "./sync-model.js";

export const ADMIN = "admin";

export class EngineSystem implements RecoverySystem {
  readonly adapters: TestAdapter[] = [];
  readonly dbs: Database[] = [];
  /** For each replica, its file copies, oldest first. */
  readonly files: TestAdapter[][] = [];
  readonly backups: TestAdapter[] = [];
  /** For each replica, the storage it replaced when it was last reinstanced. */
  readonly old: (TestAdapter | undefined)[] = [];
  /** Every adapter made, to close. */
  readonly #all: TestAdapter[] = [];
  #time = 0;
  readonly #now = () => new Date(this.#time);

  constructor(readonly replicaCount: number) {}

  /**
   * Founds replica 0 with purgeAfterDays days, copies it to the others with
   * createReplica, and lets every replica pull from replica 0 once, so all
   * know each other. The model does the same (ModelSystem).
   */
  static async create<T extends EngineSystem>(this: new (replicaCount: number) => T, replicaCount: number, start: number, days: number): Promise<T> {
    const system = new this(replicaCount);
    system.#time = start;
    const now = () => new Date(system.#time);
    const session = Session.withId(ADMIN);
    const first = new TestAdapter();
    system.adapters.push(first);
    const founder = await session.openDatabase(first, { now });
    await founder.saveSettings({ purgeAfterDays: days });
    system.dbs.push(founder);
    for (let r = 1; r < replicaCount; r++) {
      const adapter = new TestAdapter();
      await founder.createReplica(adapter);
      system.adapters.push(adapter);
      system.dbs.push(await session.openDatabase(adapter, { now }));
    }
    for (let r = 1; r < replicaCount; r++) {
      await (system.dbs[r] as Database).pullFrom(founder);
    }
    for (let r = 0; r < replicaCount; r++) {
      system.files.push([]);
      system.old.push(undefined);
    }
    return system;
  }

  get instanceIds(): string[] {
    return this.dbs.map((db) => db.instanceId);
  }

  close(): void {
    for (const adapter of new Set([...this.adapters, ...this.#all, ...this.backups, ...this.files.flat(), ...this.old.filter((a) => a !== undefined)])) {
      try {
        adapter.close();
      } catch {
        // Already closed.
      }
    }
  }

  #db(r: number): Database {
    return this.dbs[r] as Database;
  }

  /** Runs body at time now, mapping the refusals a program expects to outcomes. */
  async #at(now: number, body: () => Promise<unknown>): Promise<Outcome> {
    this.#time = now;
    try {
      await body();
      return "ok";
    } catch (error) {
      if (error instanceof CromDBError && error.code === "STALE_REPLICA") {
        return "stale";
      }
      if (error instanceof CromDBError && error.code === "READ_ONLY") {
        return "readOnly";
      }
      if (error instanceof CromDBError && error.code === "REWIND_DETECTED") {
        return "rewound";
      }
      if (error instanceof CromDBError && error.code === "SYNC_MISMATCH") {
        return "refused";
      }
      throw error;
    }
  }

  async create(r: number, now: number): Promise<{ outcome: Outcome; id?: string }> {
    let id: string | undefined;
    const outcome = await this.#at(now, async () => {
      const db = this.#db(r);
      id = (await db.create(writeTag(db.instanceId, now), { readers: ["*"], writers: ["*"] })).id;
    });
    return id === undefined ? { outcome } : { outcome, id };
  }

  async write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome> {
    return this.#at(now, async () => {
      const db = this.#db(r);
      const doc = await db.get<{ w: string }>(id);
      if (doc === undefined) {
        throw new Error(`replica ${r} has no live ${id}`);
      }
      if (deleted) {
        await doc.delete();
      } else {
        doc.content = writeTag(db.instanceId, now);
        await doc.save();
      }
    });
  }

  async pull(y: number, x: number, now: number): Promise<Outcome> {
    return this.#at(now, () => this.#db(y).pullFrom(this.#db(x)));
  }

  async pullSome(y: number, x: number, limit: number, now: number): Promise<Outcome> {
    return this.#at(now, async () => {
      const puller = this.#db(y);
      const source = this.#db(x);
      await puller.checkPeer(await source.syncHello());
      await puller.applyChanges(await source.exportChanges({ since: await puller.syncPosition(source.instanceId), limit }));
    });
  }

  async purge(r: number, now: number): Promise<Outcome> {
    return this.#at(now, () => this.#db(r).purge());
  }

  async setDays(r: number, days: number, now: number): Promise<Outcome> {
    return this.#at(now, () => this.#db(r).saveSettings({ purgeAfterDays: days }));
  }

  editable(r: number): string[] {
    const adapter = this.adapters[r] as TestAdapter;
    return adapter
      .liveDocuments()
      .filter((doc) => adapter.conflictRows(doc.id).length === 0)
      .map((doc) => doc.id)
      .sort();
  }

  documentState(r: number): Map<string, string> {
    const adapter = this.adapters[r] as TestAdapter;
    return new Map(
      adapter
        .allDocuments()
        .filter((doc) => doc.kind === "document")
        .map((doc) => [doc.id, describeRow(doc)]),
    );
  }

  isStale(r: number): boolean {
    return this.flags(r).stale;
  }

  // ---- recovery ----

  #adapter(r: number): TestAdapter {
    return this.adapters[r] as TestAdapter;
  }

  #local(adapter: TestAdapter, key: string): boolean {
    const value = adapter.getLocal(key);
    return value !== undefined && value !== "";
  }

  fileCopy(r: number): void {
    this.files[r]?.push(this.#adapter(r).rawCopy());
  }

  async restore(r: number, pick: number, now: number): Promise<Outcome> {
    const files = this.files[r] ?? [];
    const file = files[pick % Math.max(1, files.length)];
    if (file === undefined) {
      return "skipped";
    }
    this.#time = now;
    const adapter = file.rawCopy();
    this.#all.push(this.#adapter(r));
    this.adapters[r] = adapter;
    this.dbs[r] = await Session.withId(ADMIN).openDatabase(adapter, { now: this.#now });
    this.old[r] = undefined;
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
    const target = new TestAdapter();
    const outcome = await this.#at(now, () => this.#db(r).backup(target));
    if (outcome === "ok") {
      this.backups.push(target);
    } else {
      this.#all.push(target);
    }
    return outcome;
  }

  async reinstance(r: number, x: number, now: number): Promise<Outcome> {
    const flags = this.flags(x);
    if (x === r || flags.backup || flags.rewound || flags.retired || flags.stale) {
      return "skipped";
    }
    this.#time = now;
    const introducer = this.#db(x);
    const old = this.#adapter(r);
    const oldId = this.#db(r).instanceId;
    const ticket = await introducer.registerReplica();
    const adapter = new TestAdapter();
    const fresh = await Session.withId(ADMIN).openDatabase(adapter, { now: this.#now, replicaOf: ticket });
    this.adapters[r] = adapter;
    this.dbs[r] = fresh;
    const pulled = await this.#at(now, () => fresh.pullFrom(introducer));
    await fresh.recover(old);
    try {
      await introducer.retireReplica(oldId);
    } catch (error) {
      if (!(error instanceof CromDBError && error.code === "NOT_FOUND")) throw error;
    }
    if (this.old[r] !== undefined) this.#all.push(this.old[r] as TestAdapter);
    this.old[r] = old;
    return pulled;
  }

  async retire(by: number, r: number, now: number): Promise<Outcome> {
    this.#time = now;
    try {
      return await this.#at(now, () => this.#db(by).retireReplica(this.#db(r).instanceId));
    } catch (error) {
      if (error instanceof CromDBError && error.code === "NOT_FOUND") return "skipped";
      throw error;
    }
  }

  async decide(r: number, pick: number, accept: boolean, now: number): Promise<{ outcome: Outcome; id?: string; key?: string }> {
    this.#time = now;
    const suspects = await this.#db(r).suspects({ limit: 10_000 });
    const suspect = suspects[pick % Math.max(1, suspects.length)];
    if (suspect === undefined) {
      return { outcome: "skipped" };
    }
    const outcome = await this.#at(now, async () => {
      if (accept) {
        await suspect.accept(suspect.current === undefined ? {} : { ifVersion: suspect.current });
      } else {
        await suspect.discard();
      }
    });
    return { outcome, id: suspect.documentId, key: suspect.key };
  }

  async recoverAgain(r: number, now: number): Promise<number | "skipped"> {
    const old = this.old[r];
    if (old === undefined) {
      return "skipped";
    }
    this.#time = now;
    try {
      return (await this.#db(r).recover(old)).suspects;
    } catch (error) {
      if (error instanceof CromDBError && (error.code === "READ_ONLY" || error.code === "SYNC_MISMATCH")) return "skipped";
      throw error;
    }
  }

  async useBackup(pick: number, now: number): Promise<Outcome> {
    const backup = this.backups[pick % Math.max(1, this.backups.length)];
    if (backup === undefined) {
      return "skipped";
    }
    this.#time = now;
    const db = await Session.withId(ADMIN).openDatabase(backup, { now: this.#now });
    const wrote = await this.#at(now, () => db.create({ n: 0 }));
    const pulled = await this.#at(now, () => db.pullFrom(this.#db(0)));
    const pulledFrom = await this.#at(now, () => this.#db(0).pullFrom(db));
    return wrote !== "ok" && pulled !== "ok" && pulledFrom !== "ok" ? "refused" : "ok";
  }

  suspects(r: number): string[] {
    const adapter = this.#adapter(r);
    const states: StoredSuspect["state"][] = ["pending", "accepted", "discarded", "superseded", "known"];
    return states
      .flatMap((state) => adapter.suspects?.(state, undefined, Number.MAX_SAFE_INTEGER) ?? [])
      .map((suspect) => `${suspect.key} ${suspect.reason} ${suspect.state}`)
      .sort();
  }

  flags(r: number): Flags {
    const adapter = this.#adapter(r);
    return {
      stale: this.#local(adapter, "stale"),
      backup: this.#local(adapter, "backup"),
      rewound: this.#local(adapter, "rewound"),
      retired: this.#local(adapter, "retired"),
    };
  }

  #statusAt(y: number, x: number): unknown {
    const registration = this.#adapter(y).getDocument(registrationDocId(this.#db(y).databaseId, this.#db(x).instanceId));
    return registration?.content["status"];
  }

  knowsActive(y: number, x: number): boolean {
    return this.#statusAt(y, x) === "active";
  }

  knowsRetired(y: number, x: number): boolean {
    return this.#statusAt(y, x) === "retired";
  }
}
