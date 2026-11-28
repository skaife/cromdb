// The server's backups, for server admins: whether backups are on and where
// they go, Back up now, the last run, the free space where they are kept,
// every set in the backups folder, newest first, and restoring one database
// from a set while the server runs. A whole server is restored with the
// restore command, the server stopped; the page says so.
//
// Back up now starts a run and the server answers at once; the page then
// asks every POLL_MS whether it is still running, and says how it went from
// the last run's record. A run already going when the page opens is
// followed the same way.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { errorMessage, formatBytes, formatMoment } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";

type List = Schemas["BackupList"];
type BackupSet = Schemas["BackupSet"];
type Run = Schemas["BackupRun"];
type Space = Schemas["Space"];
type Detail = Schemas["BackupSetDetail"];
type Restored = Schemas["DatabaseRestored"];

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

/** What restoring one database did, in a sentence. */
export function restoredText(restored: Restored, set: string): string {
  if (restored.registered) return `Restored "${restored.name}" from ${set}. The server didn't have it, so it was added.`;
  return `Restored "${restored.name}" from ${set}.${restored.replaced === null ? "" : ` The file it replaced is kept as ${restored.replaced} for 30 days.`}`;
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
        <BackupsBody list={loaded.list} busy={starting || loaded.list.running} outcome={outcome} onBackUp={() => void backUpNow()} onRestored={() => void load()} />
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

function BackupsBody({
  list,
  busy,
  outcome,
  onBackUp,
  onRestored,
}: {
  list: List;
  busy: boolean;
  outcome: { ok: boolean; text: string } | undefined;
  onBackUp: () => void;
  onRestored: () => void;
}) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
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
                  <th scope="col">
                    <span className="visually-hidden">Restore</span>
                  </th>
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
                    <td>
                      <button type="button" className="button small-button" aria-label={`Restore from ${set.name}`} aria-expanded={chosen === set.name} onClick={() => setChosen(chosen === set.name ? undefined : set.name)}>
                        Restore…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {chosen === undefined ? null : <RestoreFrom key={chosen} name={chosen} onClose={() => setChosen(undefined)} onRestored={onRestored} />}

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

type DetailLoaded = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly detail: Detail };

/** The databases in one set, each with Restore, which asks first. */
function RestoreFrom({ name, onClose, onRestored }: { name: string; onClose: () => void; onRestored: () => void }) {
  const [loaded, setLoaded] = useState<DetailLoaded>({ kind: "loading" });
  const [asking, setAsking] = useState<Detail["contents"][number] | undefined>(undefined);
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const { data } = await api("getBackup", { params: { name } });
      setLoaded({ kind: "ready", detail: data });
    } catch (error) {
      setLoaded({ kind: "failed", message: errorMessage(error) });
    }
  }, [name]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (database: Detail["contents"][number]) => {
    setRestoring(true);
    try {
      const { data } = await api("restoreDatabase", { params: { name }, body: { databaseId: database.databaseId } });
      setOutcome({ ok: true, text: restoredText(data, name) });
      onRestored();
      await load();
    } catch (error) {
      setOutcome({ ok: false, text: errorMessage(error) });
    } finally {
      setRestoring(false);
      setAsking(undefined);
    }
  };

  const finished = loaded.kind === "ready" ? formatMoment(loaded.detail.finishedAt) : "";
  return (
    <section className="card" aria-labelledby="restore-from">
      <h2 id="restore-from" className="small-heading">
        Restore from {name}
      </h2>
      <p className="small">
        Restoring puts the set&apos;s copy of a database in place of the database as it is now, while the server keeps running. What was written to it since the backup isn&apos;t in the copy, and its access lists are as they were then. The file as it is now is kept aside for 30 days. To put the whole server back, use the restore command with the server stopped; the guide shows how.
      </p>
      {loaded.kind === "failed" ? (
        <p role="alert" className="error">
          {loaded.message}
        </p>
      ) : loaded.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : loaded.detail.contents.length === 0 ? (
        <p className="muted small">This set holds no databases.</p>
      ) : (
        <div className="table-box plain" tabIndex={0} role="region" aria-label={`The databases in ${name}, scrollable`}>
          <table>
            <thead>
              <tr>
                <th scope="col">Database</th>
                <th scope="col">Size</th>
                <th scope="col">On this server</th>
                <th scope="col">
                  <span className="visually-hidden">Restore</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loaded.detail.contents.map((database) => (
                <tr key={database.databaseId}>
                  <th scope="row" className="row-name">
                    {database.name}
                  </th>
                  <td className="nowrap">{formatBytes(database.bytes)}</td>
                  <td>{database.onServer ? "Yes" : "No: restoring adds it"}</td>
                  <td>
                    <button type="button" className="button small-button" disabled={restoring} aria-label={`Restore ${database.name}`} onClick={() => setAsking(database)}>
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {outcome === undefined ? null : outcome.ok ? (
        <p className="notice" role="status">
          {outcome.text}
        </p>
      ) : (
        <p className="error" role="alert">
          {outcome.text}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>
      {asking === undefined ? null : (
        <ConfirmDialog
          title={`Restore "${asking.name}" from ${name}?`}
          confirmLabel={restoring ? "Restoring…" : "Restore"}
          danger
          busy={restoring}
          onConfirm={() => void restore(asking)}
          onCancel={() => setAsking(undefined)}
        >
          {asking.onServer ? (
            <p>
              &quot;{asking.name}&quot; goes back to how it was when this backup finished, {finished}. What was written to it since then won&apos;t be in it, and its access lists go back to how they were then too: check them after restoring. The file as it is now is kept aside for 30 days. People using it see the restored copy at once.
            </p>
          ) : (
            <p>The server doesn&apos;t have &quot;{asking.name}&quot;. Restoring adds it, as it was when this backup finished, {finished}.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}
