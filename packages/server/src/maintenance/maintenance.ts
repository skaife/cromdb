// The daily maintenance: purge each database the server holds, and compact
// one whose file has enough free space to give back. Runs as "cromdb-server", the
// server's own principal, which is an admin of every database the server
// holds: it is housekeeping the server does on its own schedule, for no
// person, and it returns nothing to anyone.

import type { Driver } from "@cromdb/driver";
import { SERVER_PRINCIPAL } from "../directory/directory.js";
import type { MaintenanceEntry, MaintenanceRecord, ServerDb } from "../store/server-db.js";
import { isDue } from "./schedule.js";

/** Compact a file once at least this share of it is free space... */
export const COMPACT_FREE_SHARE = 0.25;
/** ...and at least this much. */
export const COMPACT_FREE_BYTES = 64 * 1024 * 1024;

/** Whether a file this big, with this much free, is worth compacting. */
export function worthCompacting(space: { readonly totalBytes: number; readonly freeBytes: number }): boolean {
  return space.freeBytes >= COMPACT_FREE_BYTES && space.freeBytes >= space.totalBytes * COMPACT_FREE_SHARE;
}
/** The first check after start, then one every hour. */
export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 3_600_000;

/** A database maintenance looks after: its ID, how the log names it, and its open handle. */
export interface MaintainedDatabase {
  readonly databaseId: string;
  readonly what: string;
  readonly handle: string;
}

export interface MaintenanceOptions {
  readonly driver: Driver;
  readonly serverDb: ServerDb;
  /** The databases of a run, in order, read when the run starts. Unavailable ones are left out by the caller. */
  readonly databases: () => readonly MaintainedDatabase[];
  /** Databases the caller leaves out, for the log line saying so. */
  readonly skipped: () => readonly string[];
  readonly hour: number;
  readonly zone: string;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How far ahead nextDueAt looks, and in what steps: every quarter hour covers zones with odd offsets. */
const LOOK_AHEAD_MS = 2 * 86_400_000;
const LOOK_STEP_MS = 15 * 60_000;

export class Maintenance {
  #options: MaintenanceOptions;
  #running: Promise<MaintenanceRecord> | undefined;
  #stopping = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: MaintenanceOptions) {
    this.#options = options;
  }

  /** Checks one minute from now and every hour after that, without keeping the process alive. */
  start(): void {
    const tick = () => {
      this.check().catch((error: unknown) => this.#options.log(`Maintenance failed: ${message(error)}`));
    };
    this.#timer = setTimeout(() => {
      tick();
      this.#timer = setInterval(tick, CHECK_EVERY_MS);
      this.#timer.unref();
    }, FIRST_CHECK_MS);
    this.#timer.unref();
  }

  /** A new schedule, from settings saved while the server runs. The next hourly check uses it. */
  setSchedule(hour: number, zone: string): void {
    this.#options = { ...this.#options, hour, zone };
  }

  /** The last run's record, or undefined before the first. */
  get lastRun(): MaintenanceRecord | undefined {
    return this.#options.serverDb.maintenance;
  }

  get hour(): number {
    return this.#options.hour;
  }

  get zone(): string {
    return this.#options.zone;
  }

  /**
   * When the next run becomes due: now if it is due already, else the first
   * quarter hour at which it is. The run itself starts at the hourly check
   * after that.
   */
  get nextDueAt(): Date {
    const { now, hour, zone } = this.#options;
    const last = this.#options.serverDb.maintenance?.lastRunAt;
    const lastRun = last === undefined ? undefined : new Date(last);
    const start = now();
    if (isDue(lastRun, start, hour, zone)) return start;
    const first = Math.ceil(start.getTime() / LOOK_STEP_MS) * LOOK_STEP_MS;
    for (let at = first; at <= start.getTime() + LOOK_AHEAD_MS; at += LOOK_STEP_MS) {
      if (isDue(lastRun, new Date(at), hour, zone)) return new Date(at);
    }
    return new Date(start.getTime() + LOOK_AHEAD_MS);
  }

  /** Whether a run is due now. */
  get due(): boolean {
    const last = this.#options.serverDb.maintenance?.lastRunAt;
    return isDue(last === undefined ? undefined : new Date(last), this.#options.now(), this.#options.hour, this.#options.zone);
  }

  /** Runs if due and none is running. Resolves to the run's record, or undefined if none ran. */
  async check(): Promise<MaintenanceRecord | undefined> {
    if (this.#running !== undefined || this.#stopping || !this.due) {
      return undefined;
    }
    return this.runNow();
  }

  /** Runs now, due or not; joins the run already going, if there is one. */
  runNow(): Promise<MaintenanceRecord> {
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Stops the timer, and waits for the current database's step of a run, which then stops. */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#timer);
    clearInterval(this.#timer);
    await this.#running?.catch(() => undefined);
  }

  async #run(): Promise<MaintenanceRecord> {
    const { driver, serverDb, log, now } = this.#options;
    const startedAt = now();
    const previous = serverDb.maintenance?.databases ?? {};
    const databases: Record<string, MaintenanceEntry> = {};
    const info = await driver.call("driver.info", {});
    const canMeasure = info.capabilities.includes("space");
    for (const skipped of this.#options.skipped()) {
      log(`Maintenance skips ${skipped}`);
    }
    for (const database of this.#options.databases()) {
      if (this.#stopping) {
        log("Maintenance stopped for shutdown");
        break;
      }
      const on = { handle: database.handle, principal: SERVER_PRINCIPAL };
      const before = previous[database.databaseId];
      const sinceCompact = before?.sinceCompact ?? 0;
      const kept = before?.compactedAt === undefined ? {} : { compactedAt: before.compactedAt };
      const began = Date.now();
      let result;
      try {
        result = await driver.call("database.purge", on);
      } catch (error) {
        log(`Purging ${database.what} (${database.databaseId}) failed: ${message(error)}`);
        databases[database.databaseId] = { what: database.what, at: now().toISOString(), ok: false, sinceCompact, ...kept, error: message(error) };
        continue;
      }
      log(`Purged ${database.what} (${database.databaseId}): ${result.tombstones} tombstones, ${result.entries} entries, horizon ${result.horizon}, ${Date.now() - began} ms`);
      const entry: MaintenanceEntry = { what: database.what, at: now().toISOString(), ok: true, ...result, sinceCompact: sinceCompact + result.entries, ...kept };
      databases[database.databaseId] = entry;
      if (!canMeasure) {
        continue;
      }
      let space;
      try {
        space = await driver.call("database.space", { handle: database.handle });
      } catch (error) {
        log(`Measuring ${database.what} (${database.databaseId}) failed: ${message(error)}`);
        continue;
      }
      databases[database.databaseId] = { ...entry, totalBytes: space.totalBytes, freeBytes: space.freeBytes };
      if (worthCompacting(space)) {
        const compacting = Date.now();
        try {
          await driver.call("database.compact", { handle: database.handle });
          const after = await driver.call("database.space", { handle: database.handle });
          log(
            `Compacted ${database.what} (${database.databaseId}): ${mb(space.totalBytes)} to ${mb(after.totalBytes)}, ${entry.sinceCompact} entries purged since the last compact, ${((Date.now() - compacting) / 1000).toFixed(1)} s`,
          );
          databases[database.databaseId] = { ...entry, sinceCompact: 0, compactedAt: now().toISOString(), totalBytes: after.totalBytes, freeBytes: after.freeBytes };
        } catch (error) {
          log(`Compacting ${database.what} (${database.databaseId}) failed: ${message(error)}`);
          databases[database.databaseId] = { ...entry, ok: false, error: message(error) };
        }
      }
    }
    // Databases this run didn't reach keep what the last run recorded. A run
    // stopped for shutdown doesn't count as the day's run: the next start
    // runs again.
    const finished = !this.#stopping;
    const lastRunAt = finished ? startedAt.toISOString() : serverDb.maintenance?.lastRunAt;
    const record: MaintenanceRecord | undefined = lastRunAt === undefined ? undefined : { lastRunAt, databases: { ...previous, ...databases } };
    if (record !== undefined) {
      await serverDb.saveMaintenance(record);
    }
    if (finished) {
      log(`Maintenance finished: ${Object.keys(databases).length} databases in ${now().getTime() - startedAt.getTime()} ms`);
    }
    return record ?? { lastRunAt: startedAt.toISOString(), databases };
  }
}
