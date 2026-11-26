// The Access tab, for the database's admins: who may do what, as a grid of
// the ACL's five lists, saved all at once with the version read (If-Match).
// The server's row is locked; "*" can't be an admin or locked out; and the
// person logged in can't save a grid that would take away their own admin.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { EVERYONE, SERVER_PRINCIPAL, useNames, type NameBook } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { usePageTitle } from "../../app/title.ts";
import { useUnsavedChanges } from "../../app/useUnsavedChanges.tsx";
import { applies, editable, gridLists, gridRows, LIST_LABELS, LISTS, listsOf, newRow, rowNote, rowWarns, sameLists, saveProblem, setBox, type GridRow, type ListName } from "./grid.ts";
import { usePeopleSearch } from "./people-search.ts";

type Loaded = { readonly kind: "loaded"; readonly acl: Schemas["Acl"]; readonly version: string };
type State = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string; readonly denied: boolean } | Loaded;

export function AccessScreen({ database }: { database: Schemas["Database"] }) {
  usePageTitle(`${database.name}: Access`);
  const me = useMe();
  const { databaseId } = database;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [rows, setRows] = useState<GridRow[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    let live = true;
    api("getAcl", { params: { databaseId } }).then(
      ({ data, version }) => {
        if (!live) return;
        setState({ kind: "loaded", acl: data, version: version ?? data.version });
        setRows(gridRows(listsOf(data), me.personId));
        setStale(false);
        setProblem(undefined);
      },
      (error: unknown) => live && setState({ kind: "failed", message: errorMessage(error), denied: error instanceof ApiError && error.code === "ACCESS_DENIED" }),
    );
    return () => {
      live = false;
    };
  }, [databaseId, me.personId]);
  useEffect(load, [load]);

  const book = useNames(rows.map((row) => row.id));
  const baseline = state.kind === "loaded" ? listsOf(state.acl) : undefined;
  const lists = gridLists(rows, baseline);
  const dirty = baseline !== undefined && !sameLists(lists, baseline);
  const blocked = saveProblem(rows, me.personId);

  const unsaved = useUnsavedChanges(dirty, "the access lists");

  if (state.kind !== "loaded") {
    return (
      <div className="tab-body">
        <h2>Access</h2>
        {state.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : (
          <p role="alert" className={state.denied ? "muted" : "error"}>
            {state.denied ? "Only the database's admins can see who has access to it." : state.message}
          </p>
        )}
      </div>
    );
  }

  const shown = filterRows(rows, filter, book, me.personId);

  async function save() {
    if (state.kind !== "loaded" || blocked !== undefined) return;
    setBusy(true);
    setProblem(undefined);
    setNotice(undefined);
    try {
      const { data, version } = await api("saveAcl", { params: { databaseId }, body: { admins: [...lists.admins], creators: [...lists.creators], writers: [...lists.writers], readers: [...lists.readers], noAccess: [...lists.noAccess] }, ifMatch: state.version });
      setState({ kind: "loaded", acl: data, version: version ?? data.version });
      setRows(gridRows(listsOf(data), me.personId));
      setNotice("Saved. Every replica gets the new access when it syncs.");
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_VERSION") setStale(true);
      else setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tab-body access">
      <div className="toolbar">
        <h2>Access</h2>
        <label className="filter-box">
          <span className="visually-hidden">Filter the names</span>
          <input type="search" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>
      <p className="muted small">
        The database sets the most anyone can do; each document&apos;s own readers and writers can only narrow it. Visible to database admins only.
      </p>
      {stale ? (
        <div className="banner warning" role="status">
          Someone changed the access since you opened this page. Reload to see it as it is now; until then your changes stay on screen, to copy, and can&apos;t be saved.{" "}
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
      <div className="table-box access-box">
        <table className="access-table">
          <caption className="visually-hidden">Who may do what in {database.name}</caption>
          <thead>
            <tr>
              <th scope="col">Who</th>
              {LISTS.map((list) => (
                <th key={list} scope="col" className="box-col">
                  {LIST_LABELS[list]}
                </th>
              ))}
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <AccessRow
                key={row.id}
                row={row}
                rows={rows}
                book={book}
                me={me.personId}
                disabled={busy || stale}
                onChange={(list, value) => {
                  setRows((current) => setBox(current, row.id, list, value));
                  setNotice(undefined);
                }}
              />
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={LISTS.length + 2} className="muted">
                  No names match the filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <AddPerson
        rows={rows}
        disabled={busy || stale}
        onAdd={(id) => {
          setRows((current) => [...current, newRow(id)]);
          setNotice(undefined);
        }}
      />
      {blocked === undefined ? null : (
        <p className="field-error" role="alert">
          {blocked}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="button" className="button primary" onClick={() => void save()} disabled={busy || stale || !dirty || blocked !== undefined}>
          {busy ? "Saving…" : "Save access"}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !dirty}
          onClick={() => {
            setRows(gridRows(listsOf(state.acl), me.personId));
            setProblem(undefined);
          }}
        >
          Discard changes
        </button>
      </div>
      <p className="muted small">Saved only if nobody changed access since you opened this page. A row with no box ticked is removed when you save.</p>
      {unsaved.dialog}
    </div>
  );
}

/** The rows whose name or ID has the filter's text, any case. */
function filterRows(rows: readonly GridRow[], filter: string, book: NameBook, me: string): readonly GridRow[] {
  const text = filter.trim().toLowerCase();
  if (text === "") return rows;
  return rows.filter((row) => row.id.toLowerCase().includes(text) || whoText(row.id, book, me).toLowerCase().includes(text));
}

function whoText(id: string, book: NameBook, me: string): string {
  if (id === SERVER_PRINCIPAL) return "The server";
  if (id === EVERYONE) return "Everyone who logs in";
  const label = book.label(id, undefined);
  return id === me ? `${label.text} (you)` : label.text;
}

function AccessRow({
  row,
  rows,
  book,
  me,
  disabled,
  onChange,
}: {
  row: GridRow;
  rows: readonly GridRow[];
  book: NameBook;
  me: string;
  disabled: boolean;
  onChange: (list: ListName, value: boolean) => void;
}) {
  const who = whoText(row.id, book, me);
  const note = rowNote(rows, row.id, me);
  const warns = rowWarns(rows, row.id, me);
  const detail = row.id === SERVER_PRINCIPAL ? `${SERVER_PRINCIPAL} · locked` : row.id === EVERYONE ? '"*"' : undefined;
  const title = row.id === SERVER_PRINCIPAL || row.id === EVERYONE ? undefined : book.label(row.id, undefined).title;
  return (
    <tr className={warns ? "warns" : undefined}>
      <th scope="row" className="who">
        <span title={title}>{who}</span>
        {detail === undefined ? null : <span className="muted small mono who-detail">{detail}</span>}
      </th>
      {LISTS.map((list) => (
        <td key={list} className="box-col">
          {applies(row.id, list) ? (
            <input
              type="checkbox"
              aria-label={`${LIST_LABELS[list]}: ${who}`}
              checked={row.in[list]}
              disabled={disabled || !editable(row.id, list)}
              onChange={(event) => onChange(list, event.target.checked)}
            />
          ) : (
            <span className="muted small" aria-label={`${LIST_LABELS[list]}: doesn't apply to ${who}`}>
              n/a
            </span>
          )}
        </td>
      ))}
      <td className={warns ? "note warn-text" : "note muted small"}>{note}</td>
    </tr>
  );
}

function AddPerson({ rows, disabled, onAdd }: { rows: readonly GridRow[]; disabled: boolean; onAdd: (id: string) => void }) {
  const me = useMe();
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const found = usePeopleSearch(me.serverAdmin ? text : "");
  const listed = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);

  function add(entry: string) {
    const value = entry.trim();
    if (value === "") return;
    if (value.toLowerCase() === "anonymous") {
      setProblem('The server has no anonymous sessions. Use "*" for everyone who logs in.');
      return;
    }
    if (listed.has(value)) {
      setProblem("That name has a row already.");
      return;
    }
    onAdd(value);
    setText("");
    setProblem(undefined);
  }

  return (
    <div className="principal-add access-add">
      <label htmlFor={`${id}-add`} className="small">
        Add person: {me.serverAdmin ? "search by name or email, or paste a person ID" : "paste a person ID (a server admin can look it up)"}, or * for everyone who logs in
      </label>
      <div className="inline-form">
        <input
          id={`${id}-add`}
          type="text"
          value={text}
          autoComplete="off"
          disabled={disabled}
          aria-describedby={problem === undefined ? undefined : `${id}-problem`}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(text);
            }
          }}
        />
        <button type="button" className="button small-button" disabled={disabled} onClick={() => add(text)}>
          Add
        </button>
      </div>
      {problem === undefined ? null : (
        <div id={`${id}-problem`} className="field-error">
          {problem}
        </div>
      )}
      {found.length > 0 ? (
        <ul className="found-people" aria-label="People found">
          {found
            .filter((person) => !listed.has(person.personId))
            .map((person) => (
              <li key={person.personId}>
                <button type="button" className="link-button" disabled={disabled} onClick={() => add(person.personId)}>
                  Add {person.displayName ?? person.email}
                  {person.displayName === null ? "" : ` (${person.email})`}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
