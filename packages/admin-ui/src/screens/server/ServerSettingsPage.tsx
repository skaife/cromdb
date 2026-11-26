// The server's settings, for server admins, grouped as on the wireframe.
// Settings tagged "restart" take effect when the server starts again; the
// rest at once. A saved setting that isn't in effect yet says so, with what
// is running now, and the banner offers Restart now when something can
// start the server again, else asks for a restart.
//
// Saved with the version read (412 if someone saved meanwhile). A plain
// http address that leaves the machine is saved only after a question. A
// changed issuer is checked against its discovery document by the server
// before it is saved, which can take a few seconds. The client secret is
// write-only: Replace opens a field, and it is never shown.

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { api, ApiError } from "../../api/client.ts";
import { errorMessage, formatDay, formatMoment } from "../../app/format.ts";
import { usePageTitle } from "../../app/title.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { RestartBanner } from "./RestartBanner.tsx";
import {
  FIELD_SETTINGS,
  fieldOfPath,
  formOf,
  formProblems,
  hourLabel,
  settingsOf,
  shownValue,
  waitingForRestart,
  type FieldName,
  type Form,
  type Https,
  type SettingsView,
} from "./server-settings.ts";

type Loaded = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly view: SettingsView; readonly version: string };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function ServerSettingsPage() {
  usePageTitle("Server settings");
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [form, setForm] = useState<Form | undefined>(undefined);
  const [problems, setProblems] = useState<ReadonlyMap<FieldName, string>>(new Map());
  const [message, setMessage] = useState<{ readonly kind: "notice" | "error"; readonly text: string } | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askPlainHttp, setAskPlainHttp] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setStale(false);
    api("getServerSettings", {}).then(
      ({ data, version }) => {
        setLoaded({ kind: "ready", view: data, version: version ?? "" });
        setForm(formOf(data.saved));
        setProblems(new Map());
      },
      (error: unknown) => setLoaded({ kind: "failed", message: errorMessage(error) }),
    );
  }, []);
  useEffect(load, [load]);

  const view = loaded.kind === "ready" ? loaded.view : undefined;
  const dirty = view !== undefined && form !== undefined && JSON.stringify(form) !== JSON.stringify(formOf(view.saved));

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loaded.kind !== "ready" || view === undefined || form === undefined) {
    return (
      <section className="page" aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`}>Server settings</h1>
        {loaded.kind === "failed" ? (
          <p role="alert" className="error">
            {loaded.message}
          </p>
        ) : (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        )}
      </section>
    );
  }

  const issuerChanged = form.oidcIssuer.trim() !== view.saved.oidcIssuer;
  const waiting = new Set(waitingForRestart(view));
  const restartKeys = new Set(view.restartKeys);

  async function save(allowPlainHttp: boolean) {
    if (view === undefined || form === undefined || loaded.kind !== "ready") return;
    const found = formProblems(form);
    setProblems(found);
    setMessage(undefined);
    if (found.size > 0) {
      setMessage({ kind: "error", text: "Some settings need fixing first; each says why." });
      return;
    }
    setSaving(true);
    try {
      const { data, version } = await api("saveServerSettings", {
        body: { ...settingsOf(form, view.saved), ...(allowPlainHttp ? { allowPlainHttp: true } : {}) },
        ifMatch: loaded.version,
      });
      setLoaded({ kind: "ready", view: data, version: version ?? "" });
      setForm(formOf(data.saved));
      const later = waitingForRestart(data).length > 0;
      setMessage({ kind: "notice", text: later ? "Saved. Settings marked restart take effect when the server restarts; the rest are in effect now." : "Saved. In effect now." });
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_VERSION") {
        setStale(true);
      } else if (error instanceof ApiError && error.code === "INVALID_INPUT" && error.details?.["reason"] === "plainHttp") {
        setAskPlainHttp(error.message);
      } else if (error instanceof ApiError && error.code === "INVALID_INPUT" && fieldOfPath(error.details?.["path"]) !== undefined) {
        const field = fieldOfPath(error.details?.["path"]) as FieldName;
        setProblems(new Map([[field, error.message]]));
        setMessage({ kind: "error", text: "Not saved: a setting can't be used, and says why." });
      } else {
        setMessage({ kind: "error", text: errorMessage(error) });
      }
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void save(false);
  }

  const set = (field: FieldName) => (value: string) => setForm({ ...form, [field]: value });

  /** A label with its "restart" tag, the control, and what the field needs to say. */
  const row = (field: FieldName, label: string, control: (props: ControlProps) => ReactNode, help?: ReactNode) => {
    const restart = FIELD_SETTINGS[field].some((key) => restartKeys.has(key));
    const pending = FIELD_SETTINGS[field].filter((key) => waiting.has(key));
    const problem = problems.get(field);
    const helpId = `${id}-${field}-help`;
    const problemId = `${id}-${field}-problem`;
    const describedBy = [help === undefined ? "" : helpId, pending.length > 0 ? `${id}-${field}-pending` : "", problem === undefined ? "" : problemId].filter((x) => x !== "").join(" ");
    return (
      <div className="setting-row">
        <label htmlFor={`${id}-${field}`} className="setting-label">
          {label}
          {restart ? (
            <>
              {" "}
              <span className="restart-tag">restart</span>
            </>
          ) : null}
        </label>
        <div className="setting-control">
          {control({ id: `${id}-${field}`, describedBy: describedBy === "" ? undefined : describedBy, invalid: problem !== undefined })}
          {help === undefined ? null : (
            <div id={helpId} className="muted small">
              {help}
            </div>
          )}
          {pending.length > 0 ? (
            <div id={`${id}-${field}-pending`} className="pending small">
              Saved, waiting for a restart. Running now: {pending.map((key) => shownValue(view.running, key)).join("; ")}.
            </div>
          ) : null}
          {problem === undefined ? null : (
            <div id={problemId} className="field-error">
              {problem}
            </div>
          )}
        </div>
      </div>
    );
  };
  const text = (field: FieldName, options: { type?: string; inputMode?: "numeric"; className?: string; placeholder?: string; autoComplete?: string } = {}) =>
    function TextControl({ id: inputId, describedBy, invalid }: ControlProps) {
      return (
        <input
          id={inputId}
          type={options.type ?? "text"}
          inputMode={options.inputMode}
          className={options.className}
          placeholder={options.placeholder}
          autoComplete={options.autoComplete ?? "off"}
          spellCheck={false}
          value={form[field]}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => set(field)(event.target.value)}
        />
      );
    };

  const lastRun = view.lastMaintenance;
  return (
    <section className="page" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>Server settings</h1>
      <RestartBanner waiting={waiting.size > 0} canRestart={view.canRestart} />
      {stale ? (
        <div className="banner warning" role="status">
          <p>Someone saved the settings since you opened this page. Reload to see them as they are now; until then your changes stay on screen, to copy, and can&apos;t be saved.</p>
          <button type="button" className="button small-button" onClick={load}>
            Reload
          </button>
        </div>
      ) : null}

      <form className="server-settings" onSubmit={onSubmit} noValidate>
        <fieldset className="card settings-group">
          <legend>General</legend>
          {row("serverName", "Server name", text("serverName"))}
          {row("publicUrl", "Public address", text("publicUrl", { type: "url" }), "Where people reach the server, such as https://cromdb.example.org. Login and cookies follow it.")}
        </fieldset>

        <fieldset className="card settings-group">
          <legend>Network and HTTPS</legend>
          {row("listen", "Listen address", text("listen"), "host:port, such as 0.0.0.0:8443 or 127.0.0.1:8080.")}
          <div className="setting-row">
            <span className="setting-label" id={`${id}-https-label`}>
              HTTPS <span className="restart-tag">restart</span>
            </span>
            <div className="setting-control">
              <div role="radiogroup" aria-labelledby={`${id}-https-label`} aria-describedby={waiting.has("tls") || waiting.has("trustProxy") ? `${id}-https-pending` : undefined} className="radio-list">
                {(
                  [
                    ["server", "Served by this server"],
                    ["proxy", "By a reverse proxy in front"],
                    ["off", "Off (plain HTTP, trusted networks only)"],
                  ] as const satisfies readonly (readonly [Https, string])[]
                ).map(([value, label]) => (
                  <label key={value} className="radio-label">
                    <input type="radio" name={`${id}-https`} value={value} checked={form.https === value} onChange={() => setForm({ ...form, https: value })} />
                    {label}
                  </label>
                ))}
              </div>
              {waiting.has("tls") || waiting.has("trustProxy") ? (
                <div id={`${id}-https-pending`} className="pending small">
                  Saved, waiting for a restart. Running now: {shownValue(view.running, "tls")}, {shownValue(view.running, "trustProxy")}.
                </div>
              ) : null}
            </div>
          </div>
          {form.https === "server" ? (
            <>
              {row("certFile", "Certificate file", text("certFile", { placeholder: "/data/tls/fullchain.pem" }))}
              {row("keyFile", "Key file", text("keyFile", { placeholder: "/data/tls/privkey.pem" }))}
            </>
          ) : null}
          <p className="muted small group-note">
            {view.certificate === null
              ? form.https === "server"
                ? "Paths on the server. The files are checked when you save."
                : form.https === "proxy"
                  ? "The proxy serves HTTPS and tells the server who the client is (X-Forwarded-For and X-Forwarded-Proto)."
                  : "Without HTTPS, logins and sessions cross the network unencrypted. Use it only on a network you trust."
              : view.certificate.validUntil === null
                ? "The certificate in use can't be read now. Renewed files are picked up automatically within a minute."
                : `Certificate valid until ${formatDay(view.certificate.validUntil, new Date(0))}. Renewed files are picked up automatically within a minute.`}
          </p>
        </fieldset>

        <fieldset className="card settings-group">
          <legend>Login</legend>
          {row("oidcIssuer", "Issuer address", text("oidcIssuer", { type: "url" }))}
          {row("oidcClientId", "Client ID", text("oidcClientId"))}
          <ClientSecret set={view.clientSecretSet} />
          <p className="muted small group-note">Changing the issuer is checked against its discovery document before it is saved.</p>
        </fieldset>

        <fieldset className="card settings-group">
          <legend>Sessions</legend>
          {row("sessionIdleMinutes", "Log out after idle (minutes)", text("sessionIdleMinutes", { inputMode: "numeric", className: "number-input" }), "From 5 minutes to 30 days.")}
          {row("sessionMaxDays", "Longest session (days)", text("sessionMaxDays", { inputMode: "numeric", className: "number-input" }), "From 1 to 365. Sessions already open follow the new lengths from their next request.")}
        </fieldset>

        <fieldset className="card settings-group">
          <legend>Maintenance</legend>
          {row("maintenanceHour", "Nightly maintenance at", ({ id: selectId, describedBy }) => (
            <select id={selectId} aria-describedby={describedBy} value={form.maintenanceHour} onChange={(event) => set("maintenanceHour")(event.target.value)}>
              {HOURS.map((hour) => (
                <option key={hour} value={String(hour)}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          ))}
          {row(
            "maintenanceTimeZone",
            "Time zone",
            text("maintenanceTimeZone", { placeholder: `${view.serverTimeZone ?? "UTC"} (server's own)` }),
            `An IANA time zone, such as Europe/Paris. Leave it empty for the server's own (${view.serverTimeZone ?? "UTC, as the server's isn't known"}).`,
          )}
          {row("serverDbPurgeAfterDays", "Purge the server database after (days)", text("serverDbPurgeAfterDays", { inputMode: "numeric", className: "number-input" }), "How long ended sessions and other deletions are kept. From 1 to 3650.")}
          <p className="muted small group-note">
            {lastRun === null ? "Not run yet." : `Last run: ${formatMoment(lastRun.at)}, ${lastRun.ok ? "every database purged" : "with errors"}.`} Details on the{" "}
            <Link to="/server/status">Status</Link> page.
          </p>
        </fieldset>

        <div className="actions">
          <button type="submit" className="button primary" disabled={saving || stale}>
            {saving ? (issuerChanged ? "Checking the issuer…" : "Saving…") : "Save settings"}
          </button>
          <button type="button" className="button" disabled={saving || !dirty} onClick={() => {
            setForm(formOf(view.saved));
            setProblems(new Map());
            setMessage(undefined);
          }}>
            Discard changes
          </button>
        </div>
        <div aria-live="polite">
          {message === undefined ? null : (
            <p className={message.kind === "error" ? "error" : "notice"} role={message.kind === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          )}
        </div>
      </form>

      {askPlainHttp === undefined ? null : (
        <ConfirmDialog
          title="Use plain HTTP?"
          confirmLabel="Save with plain HTTP"
          cancelLabel="Go back"
          danger
          onConfirm={() => {
            setAskPlainHttp(undefined);
            void save(true);
          }}
          onCancel={() => setAskPlainHttp(undefined)}
        >
          <p>{askPlainHttp}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

interface ControlProps {
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
}

/** The client secret: whether it is set, and Replace. Never shown, never read back. */
function ClientSecret({ set }: { set: boolean }) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly kind: "notice" | "error"; readonly text: string } | undefined>(undefined);

  async function replace() {
    if (secret.trim() === "") {
      setMessage({ kind: "error", text: "Paste the new client secret." });
      return;
    }
    setBusy(true);
    try {
      await api("setClientSecret", { body: { secret } });
      setSecret("");
      setReplacing(false);
      setMessage({ kind: "notice", text: "Replaced. The server uses it from its next restart." });
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-row">
      <span className="setting-label" id={`${id}-label`}>
        Client secret <span className="restart-tag">restart</span>
      </span>
      <div className="setting-control">
        {replacing ? (
          <div className="inline-form">
            <input
              type="password"
              aria-labelledby={`${id}-label`}
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void replace();
                }
              }}
            />
            <button type="button" className="button small-button" disabled={busy} onClick={() => void replace()}>
              Save secret
            </button>
            <button type="button" className="button small-button" disabled={busy} onClick={() => {
              setReplacing(false);
              setSecret("");
              setMessage(undefined);
            }}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="inline-form">
            <span className="muted">{set ? "Set (never shown)" : "Not set"}</span>
            <button type="button" className="button small-button" aria-label="Replace the client secret" onClick={() => {
              setReplacing(true);
              setMessage(undefined);
            }}>
              Replace
            </button>
          </div>
        )}
        {message === undefined ? null : (
          <div className={message.kind === "error" ? "field-error" : "notice small"} role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}
