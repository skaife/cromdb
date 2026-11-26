// What a render error shows: a plain page with Reload. The error itself goes
// to the browser console only, never onto the page, where anyone looking
// could read its message or stack. It calls nothing on the server, so it
// works whether or not anyone is logged in.

import { useEffect } from "react";
import { useRouteError } from "react-router";

export function ErrorPage() {
  const error = useRouteError();
  useEffect(() => {
    console.error("The admin UI stopped on an error:", error);
  }, [error]);

  return (
    <main className="center-page">
      <div className="card narrow">
        <h1>Something went wrong</h1>
        <p>Reload the page. If it happens again, the server log or the browser console has the details.</p>
        <div className="actions">
          <button type="button" className="button primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}
