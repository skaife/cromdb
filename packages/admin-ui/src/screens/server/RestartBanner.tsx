// The top of the server settings page: settings tagged "restart" take effect
// when the server starts again. With saved changes waiting for one: Restart
// now, when something starts the server again after it stops, else a note
// to restart it. After Restart now the page waits for the server to answer
// again, then reloads.

import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { errorMessage } from "../../app/format.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";

/** How often to ask whether the server is back, and for how long. */
const POLL_MS = 1_000;
const GIVE_UP_MS = 120_000;

type State = { readonly kind: "idle" } | { readonly kind: "asking" } | { readonly kind: "restarting" } | { readonly kind: "slow" } | { readonly kind: "failed"; readonly message: string };

export function RestartBanner({ waiting, canRestart }: { waiting: boolean; canRestart: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (state.kind !== "restarting") return undefined;
    const started = Date.now();
    let seenDown = false;
    const timer = window.setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        window.clearInterval(timer);
        setState({ kind: "slow" });
        return;
      }
      api("health", {}).then(
        () => {
          // Back: it went away and answers again (or never seemed to go, after a few seconds).
          if (seenDown || Date.now() - started > 5_000) window.location.reload();
        },
        () => {
          seenDown = true;
        },
      );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  async function restart() {
    setState({ kind: "restarting" });
    try {
      await api("restartServer", {});
    } catch (error) {
      setState({ kind: "failed", message: errorMessage(error) });
    }
  }

  if (state.kind === "restarting" || state.kind === "slow") {
    return (
      <div className="banner warning" role="status" aria-live="polite">
        <p>
          {state.kind === "restarting"
            ? "Restarting. This page reloads when the server answers again."
            : "The server hasn't answered for two minutes. Check what supervises it, and its log; reload this page when it is back."}
        </p>
      </div>
    );
  }

  return (
    <div className="banner warning" role="status">
      <p>
        Saved changes marked <strong>restart</strong> take effect when the server restarts.
        {waiting && !canRestart ? " Some are waiting for one: restart the server to apply them." : ""}
      </p>
      {waiting && canRestart ? (
        <button type="button" className="button small-button" onClick={() => setState({ kind: "asking" })}>
          Restart now
        </button>
      ) : null}
      {state.kind === "failed" ? (
        <p role="alert" className="error">
          {state.message}
        </p>
      ) : null}
      {state.kind === "asking" ? (
        <ConfirmDialog title="Restart the server?" confirmLabel="Restart now" onConfirm={() => void restart()} onCancel={() => setState({ kind: "idle" })}>
          <p>The server stops and starts again with the saved settings. Requests wait or fail for a few seconds; sessions stay open.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
