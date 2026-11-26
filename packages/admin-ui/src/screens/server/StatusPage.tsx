// The server's status, for server admins: its name, address and versions;
// how many databases it serves and which it couldn't open; and what the
// last nightly maintenance did to each database. Peers come when servers
// sync with each other (S5).

import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatMoment } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";
import { hourLabel } from "./server-settings.ts";

type Status = Schemas["ServerStatus"];
type Result = Schemas["MaintenanceResult"];
type Loaded = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly status: Status };

/** Loads the status once. */
export function useServerStatus(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    api("getServerStatus", {}).then(
      ({ data }) => live && setLoaded({ kind: "ready", status: data }),
      (error: unknown) => live && setLoaded({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return loaded;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What one database's step did, in a few words. */
export function resultText(result: Result): string {
  if (!result.ok) return `Failed: ${result.error ?? "see the server's log"}`;
  const parts = [`${plural(result.tombstones ?? 0, "deletion")} removed`];
  if ((result.entries ?? 0) > 0) parts.push(`${plural(result.entries ?? 0, "change entry", "change entries")} dropped`);
  if (result.compactedAt !== undefined && result.compactedAt >= result.at.slice(0, 10)) parts.push("file compacted");
  return parts.join(", ");
}

/** The last run as a whole: every database's deletions, and any failures. */
export function runSummary(results: readonly Result[]): string {
  const failed = results.filter((result) => !result.ok).length;
  const removed = results.reduce((sum, result) => sum + (result.tombstones ?? 0), 0);
  const compacted = results.filter((result) => result.ok && result.compactedAt !== undefined && result.compactedAt >= result.at.slice(0, 10)).length;
  const parts = [`${plural(removed, "deletion")} removed`];
  if (compacted > 0) parts.push(`${plural(compacted, "file")} compacted`);
  if (failed > 0) parts.push(`${plural(failed, "database")} failed`);
  return parts.join(", ");
}

export function StatusPage() {
  usePageTitle("Server status");
  const loaded = useServerStatus();

  return (
    <section className="page wide" aria-labelledby="status-title">
      <h1 id="status-title">Server status</h1>
      {loaded.kind === "failed" ? (
        <p role="alert" className="error">
          {loaded.message}
        </p>
      ) : loaded.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : (
        <StatusBody status={loaded.status} />
      )}
    </section>
  );
}

function StatusBody({ status }: { status: Status }) {
  const { databases, maintenance, versions } = status;
  const failed = maintenance.databases.filter((result) => !result.ok).length;
  return (
    <>
      <div className="stat-cards">
        <section className="card stat-card" aria-labelledby="status-server">
          <h2 id="status-server" className="stat-label">
            Server
          </h2>
          <p className="stat-value">{status.serverName}</p>
          <p className="muted small wrap">{status.publicUrl}</p>
          <p className="muted small">
            Server {versions.server} · driver {versions.driver} · engine {versions.engine}
          </p>
          <p className="muted small">Started {formatMoment(status.startedAt)}</p>
        </section>
        <section className="card stat-card" aria-labelledby="status-databases">
          <h2 id="status-databases" className="stat-label">
            Databases
          </h2>
          <p className="stat-value">
            {databases.available} available, {databases.unavailable.length} unavailable
          </p>
          <p className="muted small">The directory and the server database are not counted.</p>
        </section>
        <section className="card stat-card" aria-labelledby="status-maintenance">
          <h2 id="status-maintenance" className="stat-label">
            Last maintenance
          </h2>
          <p className={failed > 0 ? "stat-value error" : "stat-value"}>{maintenance.lastRunAt === null ? "Not run yet" : formatMoment(maintenance.lastRunAt)}</p>
          {maintenance.lastRunAt === null ? null : <p className="muted small">{runSummary(maintenance.databases)}</p>}
          <p className="muted small">
            Next due {formatMoment(maintenance.nextDueAt)} (daily at {hourLabel(maintenance.hour)}, {maintenance.zone})
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="status-unavailable">
        <h2 id="status-unavailable" className="small-heading">
          Unavailable databases
        </h2>
        {databases.unavailable.length === 0 ? (
          <p className="muted small">None: the server opened every database it holds.</p>
        ) : (
          <div className="table-box plain" tabIndex={0} role="region" aria-label="The unavailable databases, scrollable">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Since</th>
                </tr>
              </thead>
              <tbody>
                {databases.unavailable.map((database) => (
                  <tr key={database.databaseId}>
                    <th scope="row" className="row-name">
                      {database.name}
                    </th>
                    <td>{database.reason}</td>
                    <td className="nowrap">Server start, {formatMoment(database.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="status-runs">
        <h2 id="status-runs" className="small-heading">
          Maintenance by database
        </h2>
        {maintenance.databases.length === 0 ? (
          <p className="muted small">Nothing yet: the first run comes when it is due.</p>
        ) : (
          <div className="table-box plain" tabIndex={0} role="region" aria-label="Maintenance by database, scrollable">
            <table>
              <thead>
                <tr>
                  <th scope="col">Database</th>
                  <th scope="col">Finished</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {maintenance.databases.map((result) => (
                  <tr key={result.databaseId} className={result.ok ? undefined : "failed"}>
                    <th scope="row" className="row-name">
                      {result.what}
                    </th>
                    <td className="nowrap">{formatMoment(result.at)}</td>
                    <td className={result.ok ? undefined : "error"}>{resultText(result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">Each night the server removes deletions older than each database keeps them, and compacts a file once enough has been removed.</p>
      </section>

      <p className="card later-note small">
        <strong>Peers</strong> <span className="muted">come when servers sync with each other: the other servers, when each last synced, how far behind it is, and Sync now.</span>
      </p>
    </>
  );
}
