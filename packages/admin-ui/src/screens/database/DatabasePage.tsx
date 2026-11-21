// One database: its name, the tabs (Documents, Access for its admins,
// Replicas, Settings) and the tab's screen. Access, Replicas and Settings
// come with the database tabs, in a later version.

import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useParams } from "react-router";
import { api, ApiError } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";
import { DocumentsScreen } from "../documents/DocumentsScreen.tsx";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly database: Schemas["Database"] };

export function DatabasePage() {
  const databaseId = useParams()["databaseId"] ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    api("getDatabase", { params: { databaseId } }).then(
      ({ data }) => live && setState({ kind: "loaded", database: data }),
      (error: unknown) => {
        if (!live) return;
        setState(error instanceof ApiError && error.code === "NOT_FOUND" ? { kind: "missing" } : { kind: "failed", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [databaseId]);

  if (state.kind !== "loaded") {
    return <DatabaseProblem state={state} />;
  }
  const { database } = state;
  // Absolute: in a route ending in /*, a relative link resolves against the whole address.
  const base = `/databases/${encodeURIComponent(database.databaseId)}`;
  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? "tab active" : "tab");
  return (
    <section className="page wide database-page" aria-labelledby="database-title">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/databases">Databases</Link> <span aria-hidden="true">/</span>
      </nav>
      <h1 id="database-title">{database.name}</h1>
      <nav aria-label="Database" className="tabs">
        <NavLink to={`${base}/documents`} className={tab}>
          Documents
        </NavLink>
        {database.access.admin ? (
          <NavLink to={`${base}/access`} className={tab}>
            Access
          </NavLink>
        ) : null}
        <NavLink to={`${base}/replicas`} className={tab}>
          Replicas
        </NavLink>
        <NavLink to={`${base}/settings`} className={tab}>
          Settings
        </NavLink>
      </nav>
      <Routes>
        <Route index element={<Navigate to={`${base}/documents`} replace />} />
        <Route path="documents/*" element={<DocumentsScreen database={database} />} />
        <Route path="access" element={<NotYetTab database={database} title="Access" what="Editing who may do what in the database" />} />
        <Route path="replicas" element={<NotYetTab database={database} title="Replicas" what="The database's replicas" />} />
        <Route path="settings" element={<NotYetTab database={database} title="Settings" what="The database's settings" />} />
        <Route path="*" element={<p className="muted">There is no such page for a database.</p>} />
      </Routes>
    </section>
  );
}

function DatabaseProblem({ state }: { state: Exclude<State, { kind: "loaded" }> }) {
  usePageTitle(state.kind === "loading" ? "Database" : "Database not found");
  return (
    <section className="page">
      {state.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : (
        <>
          <h1>{state.kind === "missing" ? "Database not found" : "Database"}</h1>
          <p role="alert" className={state.kind === "missing" ? "muted" : "error"}>
            {state.kind === "missing" ? "There is no such database, or you can no longer see it." : state.message}
          </p>
          <p>
            <Link to="/databases">Back to Databases</Link>
          </p>
        </>
      )}
    </section>
  );
}

function NotYetTab({ database, title, what }: { database: Schemas["Database"]; title: string; what: string }) {
  usePageTitle(`${database.name}: ${title}`);
  return (
    <div className="tab-body">
      <h2>{title}</h2>
      <p className="muted">{what} is not built yet. It comes in a later version of the admin UI.</p>
    </div>
  );
}
