// Pages for what isn't there: screens a later step of the admin UI builds,
// server pages for someone who isn't a server admin, and unknown paths.

import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "./session.ts";
import { usePageTitle } from "./title.ts";

export function NotYetPage({ title, what }: { title: string; what: string }) {
  usePageTitle(title);
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{what} is not built yet. It comes in a later version of the admin UI.</p>
      <p>
        <Link to="/databases">Back to Databases</Link>
      </p>
    </section>
  );
}

/** The menu hides the server pages from other people; this is for someone who types the address. */
export function ServerAdminsOnly({ children }: { children: ReactNode }) {
  const me = useMe();
  usePageTitle("Server admins only");
  if (me.serverAdmin) return <>{children}</>;
  return (
    <section className="page">
      <h1>Server admins only</h1>
      <p className="muted">Only server admins can see this page.</p>
      <p>
        <Link to="/databases">Back to Databases</Link>
      </p>
    </section>
  );
}

export function NotFoundPage() {
  usePageTitle("Not found");
  return (
    <section className="page">
      <h1>Not found</h1>
      <p className="muted">There is no page at this address.</p>
      <p>
        <Link to="/databases">Back to Databases</Link>
      </p>
    </section>
  );
}
