// The servers of this deployment. Until servers sync with each other (S5)
// there is one: this server, with its address, that it is running, and its
// version. The list from the replicated directory, reachability, sync
// times, Sync now and join requests come with S5.

import { usePageTitle } from "../../app/title.ts";
import { useServerStatus } from "./StatusPage.tsx";

export function ServersPage() {
  usePageTitle("Servers");
  const loaded = useServerStatus();

  return (
    <section className="page" aria-labelledby="servers-title">
      <h1 id="servers-title">Servers</h1>
      <p className="muted small">Every server in this deployment. For now that is this server only.</p>
      {loaded.kind === "failed" ? (
        <p role="alert" className="error">
          {loaded.message}
        </p>
      ) : loaded.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : (
        <div className="table-box">
          <table>
            <caption className="visually-hidden">The servers in this deployment</caption>
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Address</th>
                <th scope="col">Status</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="row-name">
                  <span className="strong">{loaded.status.serverName}</span> <span className="muted small">(this server)</span>
                </th>
                <td className="wrap">{loaded.status.publicUrl}</td>
                <td>
                  <span className="badge green">Running</span>
                </td>
                <td>{loaded.status.versions.server}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="card later-note small">
        <span className="muted">
          The other servers come when servers sync with each other: the list shared by every server, whether each can be reached, when each last synced, Sync now, and
          join requests (a new server asks to join, and an admin approves it after comparing the key fingerprint shown on both screens).
        </span>
      </p>
    </section>
  );
}
