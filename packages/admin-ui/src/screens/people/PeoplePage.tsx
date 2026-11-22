// Everyone on this server, for server admins: filtered by name or email and
// by status, 50 a page in email order. Selecting a person opens them in the
// side panel, at /server/people/<personId>, as a document opens in the
// documents view.

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { usePageTitle } from "../../app/title.ts";
import { SidePanel } from "../../components/SidePanel.tsx";
import { STATUS_LABEL, STATUSES, type Status } from "./people.ts";
import { PEOPLE_PAGE_SIZE, usePeopleList } from "./people-list.ts";
import { PersonPanel } from "./PersonPanel.tsx";
import { Pager } from "./Pager.tsx";

const BASE = "/server/people";

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function PeoplePage() {
  usePageTitle("People");
  const navigate = useNavigate();
  const rest = useParams()["*"] ?? "";
  const selected = rest === "" ? undefined : decodeURIComponent(rest);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  const list = usePeopleList("people", filter, status, reloads);
  const { page } = list;

  // Back from the panel: focus goes to the person it was opened for.
  const lastOpened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selected !== undefined) {
      lastOpened.current = selected;
      return;
    }
    const id = lastOpened.current;
    lastOpened.current = undefined;
    if (id === undefined) return;
    window.requestAnimationFrame(() => {
      const link = [...document.querySelectorAll<HTMLElement>("[data-person-link]")].find((element) => element.dataset["personLink"] === id);
      link?.focus();
    });
  }, [selected]);

  const open = (id: string) => navigate(`${BASE}/${encodeURIComponent(id)}`);
  const onRowClick = (event: MouseEvent, id: string) => {
    if ((event.target as HTMLElement).closest("a, button") === null) open(id);
  };

  const main = (
    <div className="people-view">
      <div className="toolbar">
        <label className="filter-box">
          <span className="visually-hidden">Filter by name or email</span>
          <input type="search" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <label className="select-box">
          <span className="visually-hidden">Status</span>
          <select value={status ?? ""} onChange={(event) => setStatus(isStatus(event.target.value) ? event.target.value : undefined)}>
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Invited people who haven&apos;t logged in yet are also on the <Link to="/server/invitations">Invitations</Link> page, where invitations are made and revoked.
      </p>
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
          <p>{list.searched || status !== undefined ? "No one matches the filter." : "There is no one on this server yet."}</p>
        </div>
      ) : (
        <div className="table-box">
          <table className="people-table">
            <caption className="visually-hidden">People, in email order</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col">Server admin</th>
              </tr>
            </thead>
            <tbody>
              {page.people.map((person) => {
                const isSelected = person.personId === selected;
                const named = person.displayName !== null && person.displayName !== "";
                return (
                  <tr key={person.personId} className={isSelected ? "selected" : undefined} aria-current={isSelected || undefined} onClick={(event) => onRowClick(event, person.personId)}>
                    <td>
                      <Link
                        to={`${BASE}/${encodeURIComponent(person.personId)}`}
                        data-person-link={person.personId}
                        className={named ? "strong" : "muted"}
                        aria-label={named ? undefined : `No name yet: ${person.email}`}
                      >
                        {named ? person.displayName : "No name yet"}
                      </Link>
                    </td>
                    <td className="wrap">{person.email}</td>
                    <td>
                      <span className={person.status === "active" ? "badge green" : person.status === "invited" ? "badge blue" : "badge grey"}>{STATUS_LABEL[person.status]}</span>
                    </td>
                    <td>{person.serverAdmin ? "Yes" : "No"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page.kind === "loaded" && (page.people.length > 0 || list.number > 1) ? (
        <Pager number={list.number} shown={page.people.length} size={PEOPLE_PAGE_SIZE} order="email order" previous={list.previous} next={list.next} />
      ) : null}
    </div>
  );

  const panel =
    selected === undefined ? undefined : (
      <PersonPanel key={selected} personId={selected} onClose={() => navigate(BASE)} onChanged={() => setReloads((n) => n + 1)} />
    );

  return (
    <section className="page wide" aria-labelledby="people-title">
      <h1 id="people-title">People</h1>
      <SidePanel main={main} panel={panel} label="Person" storageKey="personPanelWidth" />
    </section>
  );
}
