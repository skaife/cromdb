// When the daily maintenance is due. Pure: no clock, no I/O.
//
// Every instant belongs to a maintenance day: its date where the server is
// (in the time zone), or the day before while the hour there is still below
// maintenanceHour. A run is due when the maintenance day now is later than
// the last run's. So:
// - a day whose hour doesn't exist (clocks spring forward over it) still
//   gets its run, at the first check after the jump;
// - an hour that happens twice (clocks fall back) runs only the first time:
//   the second is the same maintenance day;
// - a server that was down, or asleep, at that hour runs at its first check
//   afterwards, once, however many days it missed.

/** Whether name is a time zone this runtime knows, as an IANA name such as "Europe/Paris" or "UTC". */
export function isTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(name)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The time zone the process runs in (TZ, or the system's), or undefined if it isn't known. */
export function processTimeZone(): string | undefined {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === "string" && zone !== "Etc/Unknown" && isTimeZone(zone) ? zone : undefined;
}

/**
 * The time zone maintenance uses: the setting, else the process's own
 * (processTimeZone()), else UTC. fallback says whether UTC was used because the process's is unknown.
 */
export function maintenanceTimeZone(setting: string | null, processZone: string | undefined): { zone: string; fallback: boolean } {
  if (setting !== null) {
    return { zone: setting, fallback: false };
  }
  return processZone === undefined ? { zone: "UTC", fallback: true } : { zone: processZone, fallback: false };
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let found = formats.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formats.set(zone, found);
  }
  return found;
}

/** The date and hour at instant in zone. */
export function localDateHour(instant: Date, zone: string): { year: number; month: number; day: number; hour: number } {
  const parts: Record<string, number> = {};
  for (const part of format(zone).formatToParts(instant)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }
  const { year, month, day, hour } = parts;
  if (year === undefined || month === undefined || day === undefined || hour === undefined) {
    throw new Error(`Can't read the local time in ${zone}`);
  }
  return { year, month, day, hour };
}

/** The maintenance day instant belongs to, as "YYYY-MM-DD", so later days compare greater as strings. */
export function maintenanceDay(instant: Date, hour: number, zone: string): string {
  const local = localDateHour(instant, zone);
  // Date.UTC only does the calendar arithmetic here; no time zone is involved.
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day - (local.hour < hour ? 1 : 0)));
  return date.toISOString().slice(0, 10);
}

/** Whether a run is due at now, after one at lastRunAt (none yet: undefined). */
export function isDue(lastRunAt: Date | undefined, now: Date, hour: number, zone: string): boolean {
  return lastRunAt === undefined || maintenanceDay(now, hour, zone) > maintenanceDay(lastRunAt, hour, zone);
}
