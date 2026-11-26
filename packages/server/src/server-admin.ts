// What the server pages of the admin UI need from the running server: its
// settings as saved and as running, saving them (the live ones take effect
// at once), the client secret, restart, and what the status page shows.

import type { Fetch } from "./auth/oidc.js";
import type { Sessions } from "./auth/sessions.js";
import type { Maintenance } from "./maintenance/maintenance.js";
import { maintenanceTimeZone } from "./maintenance/schedule.js";
import { isLiveSetting, SETTING_KEYS, withLiveSettings, type Settings } from "./settings.js";
import type { ServerDb } from "./store/server-db.js";

export interface Versions {
  readonly server: string;
  readonly driver: string;
  readonly engine: string;
}

/** Refused because the settings changed since the version given. */
export class StaleSettingsError extends Error {
  constructor() {
    super("The settings have changed since you read them; read them again");
    this.name = "StaleSettingsError";
  }
}

export interface ServerAdminOptions {
  readonly serverDb: ServerDb;
  readonly sessions: Sessions;
  readonly maintenance: Maintenance;
  /** The settings the server started with (with listen as it was given). */
  readonly started: Settings;
  /** The listen address given when the server was started (--listen), which the setting doesn't change. */
  readonly listenFixed: string | undefined;
  readonly startedAt: Date;
  readonly versions: Versions;
  /** The process's own time zone, or undefined if it isn't known. */
  readonly processZone: string | undefined;
  /** Whether something starts the server again when it exits (CROMDB_RESTART_ON_EXIT=1). */
  readonly canRestart: boolean;
  /** Stops the server for a restart; called once, after the reply has gone. */
  readonly restart: () => void;
  readonly fetch: Fetch;
  readonly log: (message: string) => void;
}

export class ServerAdmin {
  readonly #options: ServerAdminOptions;
  #running: Settings;
  #queue: Promise<unknown> = Promise.resolve();
  #restarting = false;
  #secretReplaced = false;

  constructor(options: ServerAdminOptions) {
    this.#options = options;
    this.#running = options.started;
  }

  /** What is in effect now: what the server started with, and the live settings saved since. */
  get running(): Settings {
    return this.#running;
  }

  get saved(): Settings {
    return this.#options.serverDb.settings;
  }

  get version(): string {
    return this.#options.serverDb.settingsVersion;
  }

  get clientSecretSet(): boolean {
    return this.#options.serverDb.secret("oidcClientSecret") !== undefined;
  }

  /** Whether the client secret was replaced since this start: the new one is used from the next. */
  get clientSecretWaiting(): boolean {
    return this.#secretReplaced;
  }

  get listenFixed(): string | undefined {
    return this.#options.listenFixed;
  }

  get canRestart(): boolean {
    return this.#options.canRestart;
  }

  get startedAt(): Date {
    return this.#options.startedAt;
  }

  get versions(): Versions {
    return this.#options.versions;
  }

  get processZone(): string | undefined {
    return this.#options.processZone;
  }

  get maintenance(): Maintenance {
    return this.#options.maintenance;
  }

  get fetch(): Fetch {
    return this.#options.fetch;
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Saves settings already checked, if ifVersion is still the saved version,
   * and puts the live ones into effect. Throws StaleSettingsError.
   */
  save(settings: Settings, ifVersion: string, by: string): Promise<void> {
    return this.#serially(async () => {
      const { serverDb, sessions, maintenance, processZone, log } = this.#options;
      if (serverDb.settingsVersion !== ifVersion) {
        throw new StaleSettingsError();
      }
      const before = serverDb.settings;
      const changed = SETTING_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(settings[key]));
      await serverDb.saveSettings(settings);
      this.#running = withLiveSettings(this.#running, settings);
      sessions.setLimits({ idleMinutes: settings.sessionIdleMinutes, maxDays: settings.sessionMaxDays });
      maintenance.setSchedule(settings.maintenanceHour, maintenanceTimeZone(settings.maintenanceTimeZone, processZone).zone);
      const purge = await serverDb.applyPurgeSetting();
      if (purge !== undefined) {
        log(`The server database now keeps tombstones ${purge.to} days (serverDbPurgeAfterDays), not ${purge.from}`);
      }
      const live = changed.filter(isLiveSetting);
      const later = changed.filter((key) => !isLiveSetting(key));
      log(
        changed.length === 0
          ? `Settings saved by ${by} with no changes`
          : `Settings changed by ${by}: ${[...live.map((key) => `${key} (now)`), ...later.map((key) => `${key} (at restart)`)].join(", ")}`,
      );
    });
  }

  setClientSecret(secret: string, by: string): Promise<void> {
    return this.#serially(async () => {
      await this.#options.serverDb.setSecret("oidcClientSecret", secret);
      this.#secretReplaced = true;
      this.#options.log(`The client secret was replaced by ${by}; it is used from the next restart`);
    });
  }

  /** Starts a restart, once. Only when canRestart. */
  restart(by: string): void {
    if (this.#restarting) return;
    this.#restarting = true;
    this.#options.log(`Restart asked for by ${by}: stopping, to be started again`);
    // After the reply has gone out.
    setTimeout(this.#options.restart, 100);
  }
}
