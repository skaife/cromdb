// The whole page: who is logged in decides what shows. Logged out: the
// sign-in screen. Logged in: the menu, the header and the screens. A session
// that ends while the page is open shows a dialog over it.

import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { api, ApiError, onSessionEnded } from "../api/client.ts";
import { lookupEmails, names } from "../api/names.ts";
import { DatabasePage } from "../screens/database/DatabasePage.tsx";
import { DatabasesPage } from "../screens/databases/DatabasesPage.tsx";
import { InvitationsPage } from "../screens/invitations/InvitationsPage.tsx";
import { PeoplePage } from "../screens/people/PeoplePage.tsx";
import { ServerSettingsPage } from "../screens/server/ServerSettingsPage.tsx";
import { ServersPage } from "../screens/server/ServersPage.tsx";
import { StatusPage } from "../screens/server/StatusPage.tsx";
import { errorMessage } from "./format.ts";
import { NotFoundPage, ServerAdminsOnly } from "./Placeholders.tsx";
import { SessionEndedDialog } from "./SessionEndedDialog.tsx";
import { Shell } from "./Shell.tsx";
import { MeContext, RefreshMeContext, type Me } from "./session.ts";
import { SignIn } from "./SignIn.tsx";

type State = { readonly kind: "loading" } | { readonly kind: "signedOut" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "signedIn"; readonly me: Me };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    let live = true;
    api("me", {}).then(
      ({ data }) => {
        if (!live) return;
        // Before any screen asks for names: server admins see the email of someone with no name yet.
        names.setEmailLookup(data.serverAdmin ? lookupEmails : undefined);
        setState({ kind: "signedIn", me: data });
      },
      (error: unknown) => {
        if (!live) return;
        setState(error instanceof ApiError && error.code === "UNAUTHENTICATED" ? { kind: "signedOut" } : { kind: "failed", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const { data } = await api("me", {});
      setState({ kind: "signedIn", me: data });
    } catch {
      // The header keeps what it showed; a session that ended says so on its own.
    }
  }, []);

  // Once logged in, a 401 means the session ended under the page.
  useEffect(() => {
    if (state.kind !== "signedIn") return undefined;
    onSessionEnded(() => setEnded(true));
    return () => onSessionEnded(undefined);
  }, [state.kind]);

  switch (state.kind) {
    case "loading":
      return (
        <main className="center-page" aria-busy="true">
          <p className="muted">Loading…</p>
        </main>
      );
    case "failed":
      return (
        <main className="center-page">
          <div className="card narrow">
            <h1>CromDB</h1>
            <p role="alert">{state.message}</p>
          </div>
        </main>
      );
    case "signedOut":
      return <SignIn />;
    case "signedIn":
      return (
        <MeContext.Provider value={state.me}>
          <RefreshMeContext.Provider value={refreshMe}>
            <div className="app" inert={ended}>
              <Shell>
                <Routes>
                  <Route path="/" element={<Navigate to="/databases" replace />} />
                  <Route path="/databases" element={<DatabasesPage />} />
                  <Route path="/databases/:databaseId/*" element={<DatabasePage />} />
                  <Route path="/server/people/*" element={<ServerAdminsOnly><PeoplePage /></ServerAdminsOnly>} />
                  <Route path="/server/invitations" element={<ServerAdminsOnly><InvitationsPage /></ServerAdminsOnly>} />
                  <Route path="/server/servers" element={<ServerAdminsOnly><ServersPage /></ServerAdminsOnly>} />
                  <Route path="/server/settings" element={<ServerAdminsOnly><ServerSettingsPage /></ServerAdminsOnly>} />
                  <Route path="/server/status" element={<ServerAdminsOnly><StatusPage /></ServerAdminsOnly>} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Shell>
            </div>
            {ended ? <SessionEndedDialog /> : null}
          </RefreshMeContext.Provider>
        </MeContext.Provider>
      );
  }
}
