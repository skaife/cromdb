// One person in the side panel, for server admins: their details, and Make
// or Remove server admin and Disable or Enable, each with the version they
// were read at, so a change made meanwhile is refused, not overwritten.
// Making or removing a server admin and disabling ask first; enabling
// doesn't. The server refuses to disable or remove the last active server
// admin, and its reason is shown.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { names, useNames } from "../../api/names.ts";
import { errorMessage, formatDay } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Name } from "../../components/Name.tsx";
import { actorLabel, issuerLabel, personTitle, statusLine, type Person } from "./people.ts";

type Loaded = { readonly kind: "loading" } | { readonly kind: "missing" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly person: Person; readonly version: string };

type Change = "makeAdmin" | "removeAdmin" | "disable" | "enable";

const DONE: Readonly<Record<Change, string>> = {
  makeAdmin: "Made a server admin.",
  removeAdmin: "No longer a server admin.",
  disable: "Disabled. Their sessions have ended.",
  enable: "Enabled.",
};

export function PersonPanel({ personId, onClose, onChanged }: { personId: string; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const heading = useRef<HTMLHeadingElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [asking, setAsking] = useState<Change | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly kind: "notice" | "error"; readonly text: string } | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api("getPerson", { params: { personId } }).then(
      ({ data, version }) => {
        if (!live) return;
        names.remember([data]);
        setLoaded({ kind: "ready", person: data, version: version ?? "" });
      },
      (error: unknown) => {
        if (!live) return;
        setLoaded(error instanceof ApiError && error.code === "NOT_FOUND" ? { kind: "missing" } : { kind: "failed", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [personId, reloads]);

  // Opening a person puts focus on the panel's heading.
  useEffect(() => {
    heading.current?.focus();
  }, [personId]);

  const person = loaded.kind === "ready" ? loaded.person : undefined;
  const book = useNames(person === undefined ? [] : [person.invitedBy, person.statusBy]);
  const isMe = person?.personId === me.personId;

  async function change(what: Change) {
    if (loaded.kind !== "ready") return;
    setAsking(undefined);
    setBusy(true);
    setMessage(undefined);
    const call = { params: { personId }, ifMatch: loaded.version };
    try {
      const { data, version } =
        what === "disable"
          ? await api("disablePerson", call)
          : what === "enable"
            ? await api("enablePerson", call)
            : await api("setServerAdmin", { ...call, body: { serverAdmin: what === "makeAdmin" } });
      if (what === "removeAdmin" && isMe) {
        // The server pages are no longer this person's to see.
        window.location.assign("/databases");
        return;
      }
      names.remember([data]);
      setLoaded({ kind: "ready", person: data, version: version ?? "" });
      setMessage({ kind: "notice", text: DONE[what] });
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_VERSION") {
        setMessage({ kind: "error", text: "This person changed since the panel opened, so nothing was changed. This is them now; try again if you still want to." });
        setReloads((n) => n + 1);
        onChanged();
      } else {
        setMessage({ kind: "error", text: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div className="panel-head">
      <h2 ref={heading} tabIndex={-1}>
        {person === undefined ? "Person" : personTitle(person)}
        {isMe ? <span className="muted"> (you)</span> : null}
      </h2>
      <div className="panel-head-actions">
        <button type="button" className="button small-button hide-on-phone" onClick={onClose}>
          Hide
        </button>
        <button type="button" className="button small-button phone-only" onClick={onClose}>
          Back
        </button>
      </div>
    </div>
  );

  if (person === undefined) {
    return (
      <div className="inspector">
        {head}
        {loaded.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : (
          <p role="alert" className={loaded.kind === "missing" ? "muted" : "error"}>
            {loaded.kind === "missing" ? "There is no such person on this server." : loaded.kind === "failed" ? loaded.message : null}
          </p>
        )}
      </div>
    );
  }

  const title = personTitle(person);
  const actor = (id: string) => <Name label={actorLabel(book, id, me.personId)} />;

  return (
    <div className="inspector">
      {head}
      <dl className="envelope person-facts">
        <dt>Email</dt>
        <dd className="wrap">{person.email}</dd>
        <dt>Person ID</dt>
        <dd className="mono wrap">{person.personId}</dd>
        <dt>Status</dt>
        <dd>
          {statusLine(person)}
          {person.status === "disabled" ? <> by {actor(person.statusBy)}</> : null}
        </dd>
        <dt>Invited by</dt>
        <dd>
          {actor(person.invitedBy)}, {formatDay(person.invitedAt)}
        </dd>
        <dt>Logins</dt>
        <dd>
          {person.logins.length === 0 ? (
            <span className="muted">None yet: they haven&apos;t logged in.</span>
          ) : (
            <ul className="plain-list">
              {person.logins.map((login) => (
                <li key={`${login.issuer} ${login.subject}`} title={`${login.issuer}, subject ${login.subject}`}>
                  {issuerLabel(login.issuer)}, linked {formatDay(login.addedAt)}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>Server admin</dt>
        <dd>{person.serverAdmin ? "Yes" : "No"}</dd>
      </dl>

      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={() => setAsking(person.serverAdmin ? "removeAdmin" : "makeAdmin")}>
          {person.serverAdmin ? "Remove server admin" : "Make server admin"}
        </button>
        {person.status === "disabled" ? (
          <button type="button" className="button" disabled={busy} onClick={() => void change("enable")}>
            Enable
          </button>
        ) : (
          <button type="button" className="button danger" disabled={busy} onClick={() => setAsking("disable")}>
            Disable
          </button>
        )}
      </div>
      {message === undefined ? null : (
        <p className={message.kind === "error" ? "error" : "notice"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <p className="muted small">
        Disabling ends all of their sessions at once. Enabling makes them active again, or invited again if they never logged in. The last active server admin can&apos;t be disabled or stop
        being a server admin.
      </p>

      {asking === "makeAdmin" ? (
        <ConfirmDialog title={`Make ${title} a server admin?`} confirmLabel="Make server admin" onConfirm={() => void change("makeAdmin")} onCancel={() => setAsking(undefined)}>
          <p>Server admins manage the people on this server, its databases and its settings.</p>
        </ConfirmDialog>
      ) : null}
      {asking === "removeAdmin" ? (
        <ConfirmDialog title={`Remove ${isMe ? "yourself" : title} as a server admin?`} confirmLabel="Remove server admin" danger onConfirm={() => void change("removeAdmin")} onCancel={() => setAsking(undefined)}>
          <p>{isMe ? "This is you: the server pages close for you at once, and another server admin must give the role back." : "They can no longer manage the people on this server, make databases or change its settings."}</p>
        </ConfirmDialog>
      ) : null}
      {asking === "disable" ? (
        <ConfirmDialog title={`Disable ${isMe ? "yourself" : title}?`} confirmLabel="Disable" danger onConfirm={() => void change("disable")} onCancel={() => setAsking(undefined)}>
          <p>
            {isMe
              ? "This is you: your sessions end at once, this one too, and another server admin must enable you again."
              : "All of their sessions end at once, and they can't log in until a server admin enables them again."}
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
