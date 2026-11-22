// The Settings tab: the database's name on this server and how long its
// deletions are kept, which its admins can change, and its level and ID.
// Saved with the version read (If-Match), as everywhere else.

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";

type Settings = Schemas["DatabaseSettings"];
type State = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly settings: Settings; readonly version: string };

export const PURGE_DAYS = { min: 1, max: 3650 } as const;

/** Why the purge days typed can't be saved, if they can't. */
export function purgeDaysProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return `Give a whole number of days, from ${PURGE_DAYS.min} to ${PURGE_DAYS.max}.`;
  const days = Number(trimmed);
  return days < PURGE_DAYS.min || days > PURGE_DAYS.max ? `Give a whole number of days, from ${PURGE_DAYS.min} to ${PURGE_DAYS.max}.` : undefined;
}

export function DatabaseSettingsScreen({ database, onRenamed }: { database: Schemas["Database"]; onRenamed: (name: string) => void }) {
  usePageTitle(`${database.name}: Settings`);
  const id = useId();
  const { databaseId } = database;
  const admin = database.access.admin;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    let live = true;
    api("getDatabaseSettings", { params: { databaseId } }).then(
      ({ data, version }) => {
        if (!live) return;
        setState({ kind: "loaded", settings: data, version: version ?? "" });
        setName(data.name);
        setDays(String(data.purgeAfterDays));
        setStale(false);
        setProblem(undefined);
      },
      (error: unknown) => live && setState({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [databaseId]);
  useEffect(load, [load]);

  const loaded = state.kind === "loaded" ? state.settings : undefined;
  const dirty = loaded !== undefined && (name.trim() !== loaded.name || days.trim() !== String(loaded.purgeAfterDays));
  const nameProblem = name.trim() === "" ? "Give the database a name." : undefined;
  const daysProblem = purgeDaysProblem(days);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (state.kind !== "loaded") {
    return (
      <div className="tab-body">
        <h2>Database settings</h2>
        {state.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : (
          <p role="alert" className="error">
            {state.message}
          </p>
        )}
      </div>
    );
  }
  const { settings } = state;

  async function save() {
    if (state.kind !== "loaded" || nameProblem !== undefined || daysProblem !== undefined) return;
    setBusy(true);
    setProblem(undefined);
    setNotice(undefined);
    try {
      const { data, version } = await api("saveDatabaseSettings", {
        params: { databaseId },
        body: { name: name.trim(), purgeAfterDays: Number(days.trim()) },
        ifMatch: state.version,
      });
      setState({ kind: "loaded", settings: data, version: version ?? "" });
      setName(data.name);
      setDays(String(data.purgeAfterDays));
      setNotice("Saved.");
      if (data.name !== database.name) onRenamed(data.name);
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_VERSION") setStale(true);
      else setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(settings.databaseId);
      setCopied("Copied.");
    } catch {
      setCopied("Couldn't copy here; select the ID and copy it.");
    }
  }

  const off = !admin || busy || stale;
  return (
    <div className="tab-body settings-form">
      <h2>Database settings</h2>
      {admin ? null : <p className="muted small">Only the database&apos;s admins can change these.</p>}
      {stale ? (
        <div className="banner warning" role="status">
          Someone changed these settings since you opened this page. Reload to see them as they are now; until then your changes stay on screen and can&apos;t be saved.{" "}
          <button type="button" className="button small-button" onClick={load}>
            Reload
          </button>
        </div>
      ) : null}
      {notice === undefined ? null : (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          type="text"
          value={name}
          maxLength={200}
          readOnly={!admin}
          disabled={busy || stale}
          aria-invalid={nameProblem !== undefined}
          aria-describedby={`${id}-name-help${nameProblem === undefined ? "" : ` ${id}-name-problem`}`}
          onChange={(event) => {
            setName(event.target.value);
            setNotice(undefined);
          }}
        />
        <div id={`${id}-name-help`} className="muted small">
          The name on this server only.
        </div>
        {nameProblem === undefined || !admin ? null : (
          <div id={`${id}-name-problem`} className="field-error">
            {nameProblem}
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-days`}>Purge deletions after (days)</label>
        <input
          id={`${id}-days`}
          type="text"
          inputMode="numeric"
          className="days-input"
          value={days}
          readOnly={!admin}
          disabled={busy || stale}
          aria-invalid={daysProblem !== undefined}
          aria-describedby={`${id}-days-help${daysProblem === undefined ? "" : ` ${id}-days-problem`}`}
          onChange={(event) => {
            setDays(event.target.value);
            setNotice(undefined);
          }}
        />
        <div id={`${id}-days-help`} className="muted small">
          Shared by every copy of this database. A copy out of touch for longer than this needs a resync. If two admins change it at the same time, the larger value
          wins.
        </div>
        {daysProblem === undefined || !admin ? null : (
          <div id={`${id}-days-problem`} className="field-error">
            {daysProblem}
          </div>
        )}
      </div>
      <dl className="envelope settings-facts">
        <dt>Level</dt>
        <dd>{settings.level}</dd>
        <dt>Database ID</dt>
        <dd>
          <span className="mono wrap">{settings.databaseId}</span>{" "}
          <button type="button" className="button small-button" onClick={() => void copyId()}>
            Copy
          </button>{" "}
          {copied === undefined ? null : (
            <span className="muted small" role="status">
              {copied}
            </span>
          )}
        </dd>
      </dl>
      {problem === undefined ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {admin ? (
        <div className="actions">
          <button type="button" className="button primary" onClick={() => void save()} disabled={off || !dirty || nameProblem !== undefined || daysProblem !== undefined}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || !dirty}
            onClick={() => {
              setName(settings.name);
              setDays(String(settings.purgeAfterDays));
              setProblem(undefined);
            }}
          >
            Discard changes
          </button>
        </div>
      ) : null}
    </div>
  );
}
