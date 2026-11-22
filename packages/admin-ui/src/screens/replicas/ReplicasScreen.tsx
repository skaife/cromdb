// The Replicas tab: every copy of the database that this server's copy
// knows of. Until servers sync with each other (S5) it shows only what the
// engine keeps: each replica's name and created date, whether this copy has
// anything from it yet, and whether this copy is stale. Which server holds a
// copy, sync times, how far behind, and retiring come with S5.

import { useEffect, useState } from "react";
import { shortId } from "../../api/names.ts";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatDay } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";

type List = Schemas["ReplicaList"];
type State = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly list: List };

/** A replica's name, or its shortened instance ID when it has none. */
export function replicaName(replica: { readonly name?: string; readonly instanceId: string }): string {
  return replica.name === undefined || replica.name === "" ? shortId(replica.instanceId) : replica.name;
}

export function ReplicasScreen({ database }: { database: Schemas["Database"] }) {
  usePageTitle(`${database.name}: Replicas`);
  const { databaseId } = database;
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    api("listReplicas", { params: { databaseId } }).then(
      ({ data }) => live && setState({ kind: "loaded", list: data }),
      (error: unknown) => live && setState({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [databaseId]);

  return (
    <div className="tab-body">
      <h2>Replicas</h2>
      <p className="muted small">Every copy of this database that this server&apos;s copy knows of. A copy learns of the others when it syncs.</p>
      {state.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="error">
          {state.message}
        </p>
      ) : (
        <Replicas list={state.list} />
      )}
      <p className="muted small">
        Which server holds each copy, when it last synced, how far behind it is, and retiring a copy come when servers sync with each other. Adding a copy on another
        server will be done from the Servers page.
      </p>
    </div>
  );
}

function Replicas({ list }: { list: List }) {
  const source = list.staleSource === undefined ? undefined : list.replicas.find((replica) => replica.instanceId === list.staleSource);
  return (
    <>
      {list.stale ? (
        <div className="banner warning" role="status">
          This server&apos;s copy is stale: it needs a resync, and takes no changes until then. It was found stale when it synced with{" "}
          {source === undefined ? (list.staleSource === undefined ? "another copy" : shortId(list.staleSource)) : replicaName(source)}, which had purged deletions this
          copy can&apos;t show it holds.
        </div>
      ) : null}
      {/* Focusable, so the table can be scrolled sideways from the keyboard on a narrow screen. */}
      <div className="table-box" tabIndex={0} role="region" aria-label="The replicas, scrollable">
        <table>
          <caption className="visually-hidden">The replicas</caption>
          <thead>
            <tr>
              <th scope="col">Replica</th>
              <th scope="col">Synced with this copy</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {list.replicas.map((replica) => (
              <tr key={replica.instanceId}>
                <th scope="row" className="who">
                  <span title={replica.instanceId}>{replicaName(replica)}</span>
                  {replica.thisCopy ? (
                    <>
                      <span className="muted small"> (this copy)</span>{" "}
                      {list.stale ? <span className="badge amber">Stale: needs a resync</span> : <span className="badge green">Active</span>}
                    </>
                  ) : null}
                </th>
                <td>{replica.thisCopy ? <span className="muted">n/a</span> : (replica.knownThrough ?? 0) > 0 ? "Yes" : "Not yet"}</td>
                <td>{formatDay(replica.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
