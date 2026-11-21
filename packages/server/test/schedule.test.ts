// When maintenance is due: daylight-saving changes never skip a day or run
// one twice, and missed days run once at the next check.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isDue, isTimeZone, localDateHour, maintenanceDay, maintenanceTimeZone } from "../src/maintenance/schedule.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The runs a server checking at these instants makes, starting with none. */
function runsAt(ticks: readonly Date[], hour: number, zone: string): Date[] {
  const runs: Date[] = [];
  for (const tick of ticks) {
    if (isDue(runs.at(-1), tick, hour, zone)) {
      runs.push(tick);
    }
  }
  return runs;
}

/** Checks every hour at five past, from start (UTC) for the given number of hours. */
function hourly(start: string, hours: number): Date[] {
  const first = new Date(start).getTime();
  return Array.from({ length: hours }, (_, i) => new Date(first + i * HOUR_MS));
}

const iso = (dates: readonly Date[]) => dates.map((date) => date.toISOString());

describe("isDue across daylight-saving changes", () => {
  it("runs on the day the hour is skipped, at the first check after the jump", () => {
    // Los Angeles, 2026-03-08: 02:00 PST becomes 03:00 PDT (10:00 UTC).
    const runs = runsAt(hourly("2026-03-07T00:05:00.000Z", 72), 2, "America/Los_Angeles");
    expect(iso(runs)).toEqual([
      "2026-03-07T00:05:00.000Z", // the first check: no run yet
      "2026-03-07T10:05:00.000Z", // 02:05 PST on the 7th
      "2026-03-08T10:05:00.000Z", // 03:05 PDT on the 8th: 02:xx didn't exist
      "2026-03-09T09:05:00.000Z", // 02:05 PDT on the 9th
    ]);
  });

  it("runs once when the hour happens twice", () => {
    // Los Angeles, 2026-11-01: 02:00 PDT goes back to 01:00 PST (09:00 UTC),
    // so 01:xx happens at 08:xx UTC and again at 09:xx UTC.
    const runs = runsAt(hourly("2026-10-31T09:05:00.000Z", 72), 1, "America/Los_Angeles");
    expect(iso(runs)).toEqual([
      "2026-10-31T09:05:00.000Z", // the first check
      "2026-11-01T08:05:00.000Z", // 01:05 PDT; not again at 01:05 PST
      "2026-11-02T09:05:00.000Z", // 01:05 PST on the 2nd
    ]);
  });

  it("runs on a day whose midnight is skipped", () => {
    // Santiago, 2026-09-06: 00:00 becomes 01:00.
    const zone = "America/Santiago";
    const runs = runsAt(hourly("2026-09-04T12:05:00.000Z", 72), 0, zone);
    expect(runs.slice(1).map((run) => localDateHour(run, zone))).toEqual([
      { year: 2026, month: 9, day: 5, hour: 0 },
      { year: 2026, month: 9, day: 6, hour: 1 },
      { year: 2026, month: 9, day: 7, hour: 0 },
    ]);
  });

  it("runs once after missed days, at the first check", () => {
    const last = new Date("2026-06-01T10:30:00.000Z");
    expect(isDue(last, new Date("2026-06-04T09:00:00.000Z"), 3, "UTC")).toBe(true);
    expect(runsAt([last, ...hourly("2026-06-04T09:00:00.000Z", 10)], 3, "UTC").length).toBe(2);
  });

  it("isn't due again the same day, or before the hour the next day", () => {
    const run = new Date("2026-06-01T03:10:00.000Z");
    expect(isDue(run, new Date("2026-06-01T23:59:59.000Z"), 3, "UTC")).toBe(false);
    expect(isDue(run, new Date("2026-06-02T02:59:59.999Z"), 3, "UTC")).toBe(false);
    expect(isDue(run, new Date("2026-06-02T03:00:00.000Z"), 3, "UTC")).toBe(true);
    expect(isDue(undefined, run, 3, "UTC")).toBe(true);
  });

  it("reads the hour in the time zone", () => {
    // 03:00 in Kolkata (UTC+05:30) is 21:30 UTC the day before.
    expect(maintenanceDay(new Date("2026-06-01T21:29:00.000Z"), 3, "Asia/Kolkata")).toBe("2026-06-01");
    expect(maintenanceDay(new Date("2026-06-01T21:30:00.000Z"), 3, "Asia/Kolkata")).toBe("2026-06-02");
  });
});

// Zones with daylight saving, a half-hour change (Lord Howe), changes at
// midnight (Santiago, Havana), odd offsets, and none.
const ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/St_Johns",
  "America/Santiago",
  "America/Havana",
  "Europe/London",
  "Europe/Berlin",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
  "Asia/Kolkata",
  "Asia/Tehran",
];

describe("isDue, for any zone, hour and pattern of checks", () => {
  const scenario = fc.record({
    zone: fc.constantFrom(...ZONES),
    hour: fc.integer({ min: 0, max: 23 }),
    // Anywhere in 2026 and 2027, so every kind of change is crossed.
    start: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 1) }),
    // Gaps between checks: mostly about an hour, sometimes the server is down for days.
    gaps: fc.array(
      fc.oneof(
        { weight: 20, arbitrary: fc.integer({ min: 50 * 60_000, max: 70 * 60_000 }) },
        { weight: 1, arbitrary: fc.integer({ min: 2 * HOUR_MS, max: 5 * DAY_MS }) },
      ),
      { minLength: 24, maxLength: 1500 },
    ),
  });

  it("never runs twice for one day, and runs once for every day the server checked", () => {
    fc.assert(
      fc.property(scenario, ({ zone, hour, start, gaps }) => {
        const ticks: Date[] = [new Date(start)];
        for (const gap of gaps) ticks.push(new Date((ticks.at(-1) as Date).getTime() + gap));
        const runs = runsAt(ticks, hour, zone);
        const runDays = runs.map((run) => maintenanceDay(run, hour, zone));
        for (let i = 1; i < runDays.length; i++) {
          expect((runDays[i] as string) > (runDays[i - 1] as string), `${runDays[i - 1]} then ${runDays[i]}`).toBe(true);
        }
        expect(new Set(runDays)).toEqual(new Set(ticks.map((tick) => maintenanceDay(tick, hour, zone))));
      }),
      { numRuns: 200 },
    );
  });

  it("with hourly checks and no downtime, runs within the two hours after the hour", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ZONES),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 1) }),
        fc.integer({ min: 0, max: 59 }),
        (zone, hour, start, minute) => {
          const first = start - (start % HOUR_MS) + minute * 60_000;
          const ticks = Array.from({ length: 24 * 40 }, (_, i) => new Date(first + i * HOUR_MS));
          for (const run of runsAt(ticks, hour, zone).slice(1)) {
            const late = (localDateHour(run, zone).hour - hour + 24) % 24;
            expect(late, `${run.toISOString()} in ${zone} for hour ${hour}`).toBeLessThanOrEqual(2);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("the time zone", () => {
  it("is the setting, else the process's own, else UTC", () => {
    expect(maintenanceTimeZone("Europe/Paris", "Asia/Tokyo")).toEqual({ zone: "Europe/Paris", fallback: false });
    expect(maintenanceTimeZone(null, "Asia/Tokyo")).toEqual({ zone: "Asia/Tokyo", fallback: false });
    expect(maintenanceTimeZone(null, undefined)).toEqual({ zone: "UTC", fallback: true });
  });

  it("is checked as an IANA name", () => {
    for (const zone of ["UTC", "Europe/Paris", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(isTimeZone(zone), zone).toBe(true);
    for (const zone of ["", "Mars/Olympus", "+05:00", "Europe/", "/UTC", "America/Los Angeles", "../x"]) expect(isTimeZone(zone), zone).toBe(false);
  });

  it("of the process follows TZ, and is unknown for a TZ the runtime doesn't know", () => {
    const module = fileURLToPath(new URL("../dist/maintenance/schedule.js", import.meta.url));
    const zoneWith = (tz: string) => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { processTimeZone } from ${JSON.stringify(`file://${module.replaceAll("\\", "/").replace(/^(?!\/)/, "/")}`)}; console.log(JSON.stringify(processTimeZone() ?? null));`], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout) as string | null;
    };
    expect(zoneWith("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(zoneWith("Nowhere/Invalid")).toBe(null);
  });
});
