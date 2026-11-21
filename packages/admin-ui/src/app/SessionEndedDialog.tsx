// Shown over the page when a call finds the session has ended. The page
// under it is inert; logging in again comes back to the same page, but
// anything not saved on it is lost by the round trip.

import { useEffect, useRef, type KeyboardEvent } from "react";
import { useLocation } from "react-router";
import { loginHref } from "./loginLink.ts";

export function SessionEndedDialog() {
  const location = useLocation();
  const link = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    link.current?.focus();
  }, []);

  // The link is the only thing to go to: Tab and Shift+Tab stay on it,
  // rather than leaving the page for the browser's own controls.
  function keepFocus(event: KeyboardEvent) {
    if (event.key === "Tab") {
      event.preventDefault();
      link.current?.focus();
    }
  }

  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-ended-title" aria-describedby="session-ended-text" onKeyDown={keepFocus}>
        <h2 id="session-ended-title">Your session ended</h2>
        <p id="session-ended-text">Log in again to go on. Anything you haven't saved on this page will be lost.</p>
        <div className="actions">
          <a ref={link} className="button primary" href={loginHref(location)}>
            Log in again
          </a>
        </div>
      </div>
    </div>
  );
}
