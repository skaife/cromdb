// The frame of every logged-in page: the menu on the left (a Menu button at
// phone width), the header with the server and the person, and the screen.

import { useEffect, useId, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { useMe } from "./session.ts";

const MENU: readonly { to: string; label: string }[] = [{ to: "/databases", label: "Databases" }];
const SERVER_MENU: readonly { to: string; label: string }[] = [
  { to: "/server/people", label: "People" },
  { to: "/server/invitations", label: "Invitations" },
  { to: "/server/servers", label: "Servers" },
  { to: "/server/settings", label: "Settings" },
  { to: "/server/status", label: "Status" },
];

function MenuLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "menu-link active" : "menu-link")}>
      {label}
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const menuId = useId();

  // A link followed on a phone closes the menu.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <nav className="menu" aria-label="Main menu">
        <div className="menu-top">
          <div className="brand">CromDB</div>
          <button type="button" className="menu-toggle" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
            Menu
          </button>
        </div>
        <div id={menuId} className={open ? "menu-links open" : "menu-links"}>
          {MENU.map((item) => (
            <MenuLink key={item.to} {...item} />
          ))}
          {me.serverAdmin ? (
            <>
              <div className="menu-section" id={`${menuId}-server`}>
                Server
              </div>
              <div role="group" aria-labelledby={`${menuId}-server`} className="menu-group">
                {SERVER_MENU.map((item) => (
                  <MenuLink key={item.to} {...item} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </nav>
      <div className="main-column">
        <header className="top-bar">
          <div className="server-name">
            Server: <strong>{me.serverName}</strong>
          </div>
          <div className="person">
            <span>
              {me.displayName ?? me.email}
              {me.serverAdmin ? <span className="muted"> (server admin)</span> : null}
            </span>
            <form method="post" action="/auth/logout">
              <button type="submit" className="button">
                Log out
              </button>
            </form>
          </div>
        </header>
        <main className="content" id="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
