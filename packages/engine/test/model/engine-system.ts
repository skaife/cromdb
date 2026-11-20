// The engine as a System for programs.ts: replicas of one level-4 database,
// each on its own in-memory adapter, all opened by the same admin.

import type { Database } from "../../src/database.js";
import { CromDBError } from "../../src/errors.js";
import { Session } from "../../src/session.js";
import { TestAdapter } from "../helpers.js";
import type { Outcome, System } from "./programs.js";
import { describeRow } from "./sync-model.js";

export const ADMIN = "admin";

export class EngineSystem implements System {
  readonly adapters: TestAdapter[] = [];
  readonly dbs: Database[] = [];
  #time = 0;

  private constructor(readonly replicaCount: number) {}

  /**
   * Founds replica 0 with purgeAfterDays days, copies it to the others with
   * createReplica, and lets every replica pull from replica 0 once, so all
   * know each other. The model does the same (ModelSystem).
   */
  static async create(replicaCount: number, start: number, days: number): Promise<EngineSystem> {
    const system = new EngineSystem(replicaCount);
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
    return system;
  }

  get instanceIds(): string[] {
    return this.dbs.map((db) => db.instanceId);
  }

  close(): void {
    for (const adapter of this.adapters) {
      adapter.close();
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
      throw error;
    }
  }

  async create(r: number, now: number): Promise<{ outcome: Outcome; id?: string }> {
    let id: string | undefined;
    const outcome = await this.#at(now, async () => {
      id = (await this.#db(r).create({ n: 0 })).id;
    });
    return id === undefined ? { outcome } : { outcome, id };
  }

  async write(r: number, id: string, deleted: boolean, now: number): Promise<Outcome> {
    return this.#at(now, async () => {
      const doc = await this.#db(r).get<{ n: number }>(id);
      if (doc === undefined) {
        throw new Error(`replica ${r} has no live ${id}`);
      }
      if (deleted) {
        await doc.delete();
      } else {
        doc.content.n++;
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
    const stale = (this.adapters[r] as TestAdapter).getLocal("stale");
    return stale !== undefined && stale !== "";
  }
}
