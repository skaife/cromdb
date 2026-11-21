// The databases the person can see, with their access, and for server
// admins the ones the server couldn't open and a way to make a new one.
// The Replicas and Conflicts counts come with the database tabs.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../api/client.ts";
import { useNames } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatDay } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { usePageTitle } from "../../app/title.ts";
import { Name } from "../../components/Name.tsx";
import { accessBadges } from "./access.ts";
import { NewDatabasePanel } from "./NewDatabasePanel.tsx";

type List = Schemas["DatabaseList"];
type State = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly list: List };

export function DatabasesPage() {
  usePageTitle("Databases");
  const me = useMe();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    let live = true;
    api("listDatabases", {}).then(
      ({ data }) => live && setState({ kind: "loaded", list: data }),
      (error: unknown) => live && setState({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(load, [load]);

  const list = state.kind === "loaded" ? state.list : undefined;
  const book = useNames(list?.databases.map((database) => database.createdBy) ?? []);

  return (
    <section className="page" aria-labelledby="databases-title">
      <div className="page-head">
        <h1 id="databases-title">Databases</h1>
        {me.serverAdmin && !creating ? (
          <button type="button" className="button primary" onClick={() => setCreating(true)}>
            New database
          </button>
        ) : null}
      </div>
      <p className="muted small">
        Only databases you can see are listed.{me.serverAdmin ? " Databases the server couldn't open are shown to server admins only." : ""}
      </p>
      {creating ? (
        <NewDatabasePanel
          onCancel={() => setCreating(false)}
          onCreated={(database) => navigate(`/databases/${encodeURIComponent(database.databaseId)}/documents`)}
        />
      ) : null}
      {state.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="error">
          {state.message}
        </p>
      ) : state.list.databases.length === 0 && state.list.unavailable.length === 0 ? (
        <div className="card empty">
          <p>{me.serverAdmin ? "There are no databases yet. Make one with New database." : "You can't see any databases yet. A database admin can give you access."}</p>
        </div>
      ) : (
        <div className="table-box">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Your access</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {state.list.databases.map((database) => {
                const { badges, note } = accessBadges(database.access);
                return (
                  <tr key={database.databaseId}>
                    <td>
                      <Link className="strong" to={`/databases/${encodeURIComponent(database.databaseId)}/documents`}>
                        {database.name}
                      </Link>
                    </td>
                    <td>
                      <span className="badges">
                        {badges.map((badge) => (
                          <span key={badge} className={badge === "admin" ? "badge blue" : "badge green"}>
                            {badge}
                          </span>
                        ))}
                        {note === undefined ? null : <span className="muted small">({note})</span>}
                      </span>
                    </td>
                    <td>
                      {formatDay(database.createdAt)} by <Name label={book.label(database.createdBy, me.personId)} />
                    </td>
                  </tr>
                );
              })}
              {state.list.unavailable.map((database) => (
                <tr key={database.databaseId} className="unavailable">
                  <td>
                    <span className="strong">{database.name}</span> <span className="badge grey">Unavailable</span>
                  </td>
                  <td colSpan={2}>{database.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
