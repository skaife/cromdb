// The server's backups, for server admins: whether backups are on and where
// they go, Back up now, the last run, the free space where they are kept,
// and every set in the backups folder, newest first.
//
// Back up now starts a run and the server answers at once; the page then
// asks every POLL_MS whether it is still running, and says how it went from
// the last run's record. A run already going when the page opens is
// followed the same way.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatBytes, formatMoment } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";

type List = Schemas["BackupList"];
type BackupSet = Schemas["BackupSet"];
type Run = Schemas["BackupRun"];
type Space = Schemas["Space"];

const GUIDE = "https://github.com/skaife/cromdb/blob/main/docker/README.md#backups";

/** How often the page asks whether a run has finished. */
export const POLL_MS = 1500;

type Loaded = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly list: List };

/** What made a set or a run, in a word or two. */
export function triggerLabel(trigger: BackupSet["trigger"]): string {
  return trigger === "scheduled" ? "Nightly" : trigger === "manual" ? "Back up now" : "Backup command";
}

/** The last run under its time: the set's size and what it left out, or when and why it failed. */
export function lastRunText(run: Run): string {
  if (!run.ok) return `${formatMoment(run.at)}: ${run.error ?? "see the server's log"}`;
  const left = run.skipped ?? 0;
  return `${formatBytes(run.bytes ?? 0)}${left > 0 ? `, ${left} ${left === 1 ? "database" : "databases"} left out` : ""}`;
}

/** What a finished run says, from its record. */
export function outcomeOf(run: Run | null): { readonly ok: boolean; readonly text: string } {
  if (run === null) return { ok: false, text: "The backup ended without a record; see the server's log." };
  if (!run.ok) return { ok: false, text: `The backup failed: ${run.error ?? "see the server's log"}` };
  return { ok: true, text: `Backed up: ${run.name ?? ""}, ${formatBytes(run.bytes ?? 0)}.` };
}

/** Free space as people read it: "12.3 GB free of 50.0 GB". */
export function spaceText(space: Space): string {
  return `${formatBytes(space.freeBytes)} free of ${formatBytes(space.totalBytes)}`;
}

export function BackupsPage() {
  usePageTitle("Backups");
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [starting, setStarting] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | undefined>(undefined);
  // Whether this page saw a run going, so it says how it ended.
  const following = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api("listBackups", {});
      if (data.running) {
        following.current = true;
      } else if (following.current) {
        following.current = false;
        setOutcome(outcomeOf(data.last));
      }
      setLoaded({ kind: "ready", list: data });
    } catch (error) {
      setLoaded({ kind: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = loaded.kind === "ready" && loaded.list.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [running, loaded, load]);

  const backUpNow = async () => {
    setStarting(true);
    setOutcome(undefined);
    try {
      await api("backUpNow", {});
      following.current = true;
    } catch (error) {
      setOutcome({ ok: false, text: errorMessage(error) });
    } finally {
      setStarting(false);
      await load();
    }
  };

  return (
    <section className="page wide" aria-labelledby="backups-title">
      <h1 id="backups-title">Backups</h1>
      {loaded.kind === "failed" ? (
        <p role="alert" className="error">
          {loaded.message}
        </p>
      ) : loaded.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : loaded.list.enabled ? (
        <BackupsBody list={loaded.list} busy={starting || loaded.list.running} outcome={outcome} onBackUp={() => void backUpNow()} />
      ) : (
        <Off />
      )}
    </section>
  );
}

function Off() {
  return (
    <section className="card" aria-labelledby="backups-off">
      <h2 id="backups-off" className="small-heading">
        Backups are off
      </h2>
      <p className="small">The server has no backups folder. With Docker Compose, the compose.yaml from the guide gives it one (the cromdb-backups volume, at /backups). Without Docker, start the server with --backups and a folder, or set CROMDB_BACKUPS.</p>
      <p className="small">
        <a href={GUIDE} target="_blank" rel="noopener noreferrer">
          The guide&apos;s Backups section
        </a>
      </p>
    </section>
  );
}

function BackupsBody({ list, busy, outcome, onBackUp }: { list: List; busy: boolean; outcome: { ok: boolean; text: string } | undefined; onBackUp: () => void }) {
  return (
    <>
      <div className="stat-cards">
        <section className="card stat-card" aria-labelledby="backups-last">
          <h2 id="backups-last" className="stat-label">
            Last backup
          </h2>
          <p className={list.last !== null && !list.last.ok ? "stat-value error" : "stat-value"}>{list.last === null ? "None yet" : list.last.ok ? formatMoment(list.last.at) : "Failed"}</p>
          {list.last === null ? null : <p className="muted small">{lastRunText(list.last)}</p>}
        </section>
        <section className="card stat-card" aria-labelledby="backups-where">
          <h2 id="backups-where" className="stat-label">
            Kept in
          </h2>
          <p className="stat-value wrap">{list.folder}</p>
          <p className="muted small">{list.space === null ? "Free space unknown" : spaceText(list.space)}</p>
          <p className="muted small">
            The newest {list.keep} kept (<Link to="/server/settings">Settings</Link>)
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="backups-now">
        <h2 id="backups-now" className="small-heading">
          Back up now
        </h2>
        <p className="small">
          Each night&apos;s maintenance starts with a backup. Back up now makes one at once: the server&apos;s settings, the people, and every database, as one set. The server keeps serving meanwhile; a large database may pause it for a moment.
        </p>
        <div className="actions">
          <button type="button" className="button primary" disabled={busy} onClick={onBackUp}>
            {busy ? "Backing up…" : "Back up now"}
          </button>
        </div>
        {list.running ? (
          <p className="muted small" role="status">
            A backup is running{list.current === null ? "" : ` (${list.current.name}, started ${formatMoment(list.current.startedAt)})`}. The server keeps serving meanwhile; you can leave this page.
          </p>
        ) : outcome === undefined ? null : outcome.ok ? (
          <p className="notice" role="status">
            {outcome.text}
          </p>
        ) : (
          <p className="error" role="alert">
            {outcome.text}
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="backups-sets">
        <h2 id="backups-sets" className="small-heading">
          Sets
        </h2>
        {list.sets.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <div className="table-box plain" tabIndex={0} role="region" aria-label="The backup sets, scrollable">
            <table>
              <thead>
                <tr>
                  <th scope="col">Set</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Made by</th>
                  <th scope="col">Databases</th>
                  <th scope="col">Size</th>
                </tr>
              </thead>
              <tbody>
                {list.sets.map((set) => (
                  <tr key={set.name}>
                    <th scope="row" className="row-name">
                      <span className="nowrap">{set.name}</span>
                    </th>
                    <td className="nowrap">{formatMoment(set.finishedAt)}</td>
                    <td>{triggerLabel(set.trigger)}</td>
                    <td>
                      {set.databases}
                      {set.skipped.length === 0 ? null : (
                        <span className="error small">
                          {" "}
                          ({set.skipped.length} left out: {set.skipped.map((skipped) => skipped.name).join(", ")})
                        </span>
                      )}
                    </td>
                    <td className="nowrap">{formatBytes(set.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="backups-keep-safe">
        <h2 id="backups-keep-safe" className="small-heading">
          Keeping backups safe
        </h2>
        <p className="small">
          A backup holds everything the server does, the login client secret included, and isn&apos;t encrypted. Anyone who can read it can read every database and every person&apos;s details, so keep it as safe as the data itself.
        </p>
        <p className="small">
          The backups folder is on the same machine as the data. It helps after a mistake or a damaged file, not after losing the machine. Copy the sets somewhere else regularly; the guide shows how, and how to restore one.
        </p>
        <p className="small">
          <a href={GUIDE} target="_blank" rel="noopener noreferrer">
            The guide&apos;s Backups section
          </a>
        </p>
      </section>
    </>
  );
}
