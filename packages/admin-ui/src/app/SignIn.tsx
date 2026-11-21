// The page for someone not logged in: the server's name and a way to log in.
// Never a redirect by itself: right after "Log out" that would log the person
// straight back in through the login service's own session.

import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { api } from "../api/client.ts";
import { loginHref } from "./loginLink.ts";

export function SignIn() {
  const location = useLocation();
  const [serverName, setServerName] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api("about", {}).then(
      ({ data }) => live && setServerName(data.serverName),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    document.title = serverName === undefined ? "CromDB: log in" : `${serverName}: log in`;
  }, [serverName]);

  return (
    <main className="center-page">
      <div className="card narrow sign-in">
        <div className="brand">CromDB</div>
        <h1>{serverName ?? "Log in"}</h1>
        <p className="muted">Log in to manage this server's databases.</p>
        <a className="button primary" href={loginHref(location)}>
          Log in
        </a>
      </div>
    </main>
  );
}
