// Invitations, for server admins: invite someone by email (as a server
// admin or not), and the people invited who haven't logged in yet, filtered
// by email, with Revoke. No email is sent: the person is admitted when they
// first log in with a verified matching email.
//
// The list has no versions, so Revoke reads the person first and revokes
// with the version it read; someone who logged in meanwhile is refused.

import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, ApiError } from "../../api/client.ts";
import { useNames } from "../../api/names.ts";
import { errorMessage, formatDay } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { usePageTitle } from "../../app/title.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Name } from "../../components/Name.tsx";
import { actorLabel, inviteEmailProblem, type Person } from "../people/people.ts";
import { PEOPLE_PAGE_SIZE, usePeopleList } from "../people/people-list.ts";
import { Pager } from "../people/Pager.tsx";

type Message = { readonly kind: "notice" | "error"; readonly text: string; readonly personId?: string | undefined };

export function InvitationsPage() {
  usePageTitle("Invitations");
  const me = useMe();
  const id = useId();
  const [email, setEmail] = useState("");
  const [serverAdmin, setServerAdmin] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [inviting, setInviting] = useState(false);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [filter, setFilter] = useState("");
  const [reloads, setReloads] = useState(0);
  const [revoking, setRevoking] = useState<Person | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const list = usePeopleList("invitations", filter, undefined, reloads);
  const { page } = list;
  const book = useNames(page.kind === "loaded" ? page.people.map((person) => person.invitedBy) : []);

  async function invite(event: FormEvent) {
    event.preventDefault();
    const found = inviteEmailProblem(email);
    setProblem(found);
    setMessage(undefined);
    if (found !== undefined) return;
    setInviting(true);
    try {
      const { data } = await api("invite", { body: { email: email.trim(), serverAdmin } });
      setMessage({ kind: "notice", text: `Invited ${data.email}${data.serverAdmin ? " as a server admin" : ""}.` });
      setEmail("");
      setServerAdmin(false);
      setReloads((n) => n + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_INPUT") {
        setProblem(error.message);
      } else {
        const personId = error instanceof ApiError && error.code === "PERSON_EXISTS" && typeof error.details?.["personId"] === "string" ? error.details["personId"] : undefined;
        setMessage({ kind: "error", text: errorMessage(error), personId });
      }
    } finally {
      setInviting(false);
    }
  }

  async function revoke(person: Person) {
    setBusy(true);
    setMessage(undefined);
    try {
      const { version } = await api("getPerson", { params: { personId: person.personId } });
      await api("revokeInvitation", { params: { personId: person.personId }, ifMatch: version ?? "" });
      setMessage({ kind: "notice", text: `Revoked the invitation for ${person.email}.` });
    } catch (error) {
      const text =
        error instanceof ApiError && error.code === "NOT_INVITED"
          ? `${person.email} is no longer invited: they have logged in, or the invitation was revoked or disabled meanwhile.`
          : errorMessage(error);
      setMessage({ kind: "error", text, personId: person.personId });
    } finally {
      setBusy(false);
      setRevoking(undefined);
      setReloads((n) => n + 1);
    }
  }

  const problemId = `${id}-problem`;
  return (
    <section className="page" aria-labelledby="invitations-title">
      <h1 id="invitations-title">Invitations</h1>

      <form className="card invite-form" onSubmit={(event) => void invite(event)} noValidate>
        <h2 className="small-heading">Invite someone</h2>
        <div className="invite-fields">
          <label className="invite-email">
            <span>Email to invite</span>
            <input
              type="email"
              value={email}
              autoComplete="off"
              maxLength={320}
              aria-invalid={problem !== undefined || undefined}
              aria-describedby={`${id}-help${problem === undefined ? "" : ` ${problemId}`}`}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={serverAdmin} onChange={(event) => setServerAdmin(event.target.checked)} />
            Server admin
          </label>
          <button type="submit" className="button primary" disabled={inviting}>
            Invite
          </button>
        </div>
        {problem === undefined ? null : (
          <div id={problemId} className="field-error">
            {problem}
          </div>
        )}
        <p id={`${id}-help`} className="muted small">
          No email is sent. The person logs in with a verified matching email to accept, and then appears under People.
        </p>
      </form>

      <div aria-live="polite">
        {message === undefined ? null : (
          <p className={message.kind === "error" ? "error" : "notice"} role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
            {message.personId === undefined ? null : (
              <>
                {" "}
                <Link to={`/server/people/${encodeURIComponent(message.personId)}`}>Open them in People</Link>
              </>
            )}
          </p>
        )}
      </div>

      <div className="toolbar">
        <h2>Waiting to log in</h2>
        <label className="filter-box">
          <span className="visually-hidden">Filter by email</span>
          <input type="search" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>
      {page.kind === "failed" ? (
        <p role="alert" className="error">
          {page.message}
        </p>
      ) : page.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : page.people.length === 0 ? (
        <div className="card empty">
          <p>{list.searched ? "No invitations match the filter." : "No one is waiting to log in. Invite someone above."}</p>
        </div>
      ) : (
        <div className="table-box">
          <table>
            <caption className="visually-hidden">Invitations not yet used, in email order</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Server admin</th>
                <th scope="col">Invited</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.people.map((person) => (
                <tr key={person.personId}>
                  <th scope="row" className="wrap row-name">
                    <Link to={`/server/people/${encodeURIComponent(person.personId)}`}>{person.email}</Link>
                  </th>
                  <td>{person.serverAdmin ? "Yes" : "No"}</td>
                  <td>
                    {formatDay(person.invitedAt)} by <Name label={actorLabel(book, person.invitedBy, me.personId)} />
                  </td>
                  <td className="row-actions">
                    <button type="button" className="button small-button danger" disabled={busy} aria-label={`Revoke the invitation for ${person.email}`} onClick={() => setRevoking(person)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.kind === "loaded" && (page.people.length > 0 || list.number > 1) ? (
        <Pager number={list.number} shown={page.people.length} size={PEOPLE_PAGE_SIZE} order="email order" previous={list.previous} next={list.next} />
      ) : null}

      {revoking === undefined ? null : (
        <ConfirmDialog
          title={`Revoke the invitation for ${revoking.email}?`}
          confirmLabel="Revoke"
          danger
          busy={busy}
          onConfirm={() => void revoke(revoking)}
          onCancel={() => setRevoking(undefined)}
        >
          <p>They can&apos;t log in with it any more. They stay under People as disabled, where a server admin can enable the invitation again.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
