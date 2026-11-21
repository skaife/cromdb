// A database's documents: the view (find, 50 a page, oldest created first,
// with Previous and Next by the pages already seen), the filter, extra
// columns, and the inspector in the side panel.
//
// The address holds what can be linked: the document open in the panel
// (…/documents/<id>, or …/documents/new) and the filter (?field=…). The page
// of the list isn't in it: find pages forward from a cursor, so Previous goes
// back through the cursors this view has used, and a reload starts again at
// the first page.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../api/client.ts";
import { shortId, useNames } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatWhen } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { usePageTitle } from "../../app/title.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { ConflictIcon } from "../../components/ConflictIcon.tsx";
import { Name } from "../../components/Name.tsx";
import { SidePanel } from "../../components/SidePanel.tsx";
import { cellOf, loadColumns, saveColumns, titleOf } from "./columns.ts";
import { DocumentInspector } from "./DocumentInspector.tsx";
import { describeFilter, filterFromSearch, filterToSearch, isFiltered, toFindFilter, type Filter } from "./filter.ts";
import { FilterPanel } from "./FilterPanel.tsx";

export const PAGE_SIZE = 50;
const NEW = "new";

type Document = Schemas["Document"];
type Page = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly documents: readonly Document[]; readonly next: string | null };

export function DocumentsScreen({ database }: { database: Schemas["Database"] }) {
  usePageTitle(`${database.name}: Documents`);
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  const rest = useParams()["*"] ?? "";
  const selected = rest === "" ? undefined : decodeURIComponent(rest);
  const base = `/databases/${encodeURIComponent(database.databaseId)}/documents`;

  // The filter, from the address. The new-child parent isn't part of it.
  const filterSearch = new URLSearchParams(search);
  filterSearch.delete("childOf");
  const filterKey = filterSearch.toString();
  const filter = useMemo(() => filterFromSearch(new URLSearchParams(filterKey)), [filterKey]);
  const listSearch = filterToSearch(filter).toString();
  const withFilter = (pathname: string, extra?: Record<string, string>) => {
    const query = new URLSearchParams(listSearch);
    for (const [key, value] of Object.entries(extra ?? {})) query.set(key, value);
    const text = query.toString();
    return { pathname, search: text === "" ? "" : `?${text}` };
  };

  // Pages: the cursor each page seen started at; the last is the one shown.
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [page, setPage] = useState<Page>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  useEffect(() => setCursors([undefined]), [filterKey]);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    const checked = toFindFilter(filter);
    if (!checked.ok) {
      setPage({ kind: "failed", message: "The filter in the address isn't one find can use. Open Filter to fix it." });
      return undefined;
    }
    let live = true;
    setPage((before) => (before.kind === "loaded" ? before : { kind: "loading" }));
    api("findDocuments", {
      params: { databaseId: database.databaseId },
      body: { limit: PAGE_SIZE, ...(checked.filter === undefined ? {} : { filter: checked.filter }), ...(cursor === undefined ? {} : { after: cursor }) },
    }).then(
      ({ data }) => live && setPage({ kind: "loaded", documents: data.documents, next: data.next }),
      (error: unknown) => live && setPage({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [database.databaseId, filter, cursor, reloads]);

  // Unsaved edits in the panel: anything that would replace them asks first.
  const dirty = useRef(false);
  const onDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const [pending, setPending] = useState<(() => void) | undefined>(undefined);
  const guard = (action: () => void) => {
    if (dirty.current) setPending(() => action);
    else action();
  };
  const guardLink = (event: MouseEvent, action: () => void) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    guard(action);
  };

  // Back from the panel: focus goes to the row it was opened from.
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
      const link = [...window.document.querySelectorAll<HTMLElement>("[data-document-link]")].find((element) => element.dataset["documentLink"] === id);
      link?.focus();
    });
  }, [selected]);

  const [columns, setColumns] = useState<string[]>(() => loadColumns(database.databaseId));
  const [addingColumn, setAddingColumn] = useState(false);
  const [filtering, setFiltering] = useState(false);

  function keepColumns(next: string[]) {
    setColumns(next);
    saveColumns(database.databaseId, next);
  }

  const open = (id: string) => navigate(withFilter(`${base}/${encodeURIComponent(id)}`));
  const close = () => navigate(withFilter(base));
  const applyFilter = (next: Filter) => {
    setFiltering(false);
    const text = filterToSearch(next).toString();
    navigate({ pathname: selected === undefined ? base : location.pathname, search: text === "" ? "" : `?${text}` });
  };

  const documents = page.kind === "loaded" ? page.documents : [];
  const book = useNames(documents.map((document) => document.updatedBy));
  const parts = describeFilter(filter);

  const list = (
    <div className="documents-view">
      <div className="toolbar">
        <button type="button" className="button" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}>
          Filter{isFiltered(filter) ? " (on)" : ""}
        </button>
        <button type="button" className="button" aria-expanded={addingColumn} onClick={() => setAddingColumn(!addingColumn)}>
          + Column
        </button>
        {database.access.create ? (
          <Link className="button primary" to={withFilter(`${base}/${NEW}`)} onClick={(event) => guardLink(event, () => navigate(withFilter(`${base}/${NEW}`)))}>
            New document
          </Link>
        ) : null}
      </div>
      {addingColumn ? <AddColumn columns={columns} onAdd={(field) => keepColumns([...columns, field])} onClose={() => setAddingColumn(false)} /> : null}
      {filtering ? <FilterPanel filter={filter} onApply={applyFilter} onClose={() => setFiltering(false)} /> : null}
      {isFiltered(filter) ? (
        <p className="filter-summary small">
          <span className="muted">Filtered: </span>
          {filter.parentId === undefined ? null : (
            <span>
              children of{" "}
              <Link to={withFilter(`${base}/${encodeURIComponent(filter.parentId)}`)} className="mono" title={filter.parentId}>
                {shortId(filter.parentId)}
              </Link>
              {parts.length > 0 ? ", " : ""}
            </span>
          )}
          {parts.join(", ")}{" "}
          <button type="button" className="link-button" onClick={() => applyFilter({ conditions: [], inConflict: false, topLevel: false, orphaned: false, parentId: undefined })}>
            Clear filter
          </button>
        </p>
      ) : null}

      {page.kind === "failed" ? (
        <p role="alert" className="error">
          {page.message}
        </p>
      ) : page.kind === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : documents.length === 0 ? (
        <div className="card empty">
          <p>
            {isFiltered(filter)
              ? "No documents you can read match the filter."
              : database.access.read
                ? `There are no documents you can read yet.${database.access.create ? " Make one with New document." : ""}`
                : "You can't read documents in this database."}
          </p>
        </div>
      ) : (
        <div className="table-box">
          <table className="documents-table">
            <caption className="visually-hidden">Documents, oldest created first</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                {columns.map((column) => (
                  <th scope="col" key={column}>
                    <span className="column-head">
                      {column}
                      <button type="button" className="link-button column-remove" aria-label={`Remove the column ${column}`} onClick={() => keepColumns(columns.filter((other) => other !== column))}>
                        ×
                      </button>
                    </span>
                  </th>
                ))}
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
                <th scope="col">Updated by</th>
              </tr>
            </thead>
            <tbody aria-busy={page.kind !== "loaded" || undefined}>
              {documents.map((document) => {
                const title = titleOf(document);
                const isSelected = document.id === selected;
                const className = [document.inConflict ? "conflict" : "", isSelected ? "selected" : ""].filter((name) => name !== "").join(" ");
                return (
                  <tr key={document.id} className={className === "" ? undefined : className} aria-current={isSelected || undefined} onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a, button") === null) guard(() => open(document.id));
                  }}>
                    <td>
                      <span className="title-cell">
                        {document.inConflict ? <ConflictIcon /> : null}
                        <Link
                          to={withFilter(`${base}/${encodeURIComponent(document.id)}`)}
                          data-document-link={document.id}
                          className={title === undefined ? "mono" : undefined}
                          title={title === undefined ? document.id : undefined}
                          onClick={(event) => guardLink(event, () => open(document.id))}
                        >
                          {title ?? shortId(document.id)}
                        </Link>
                      </span>
                    </td>
                    {columns.map((column) => {
                      const cell = cellOf(document, column);
                      return (
                        <td key={column} className={cell.muted === true ? "muted" : undefined}>
                          {cell.text}
                        </td>
                      );
                    })}
                    <td className="nowrap">{formatWhen(document.createdAt)}</td>
                    <td className="nowrap">{formatWhen(document.updatedAt)}</td>
                    <td>
                      <Name label={book.label(document.updatedBy, me.personId)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page.kind === "loaded" && (documents.length > 0 || cursors.length > 1) ? (
        <nav className="pager small" aria-label="Pages">
          <span className="muted">
            Page {cursors.length} · {documents.length} shown · {PAGE_SIZE} per page · oldest created first
          </span>
          <span className="pager-buttons">
            <button type="button" className="button small-button" disabled={cursors.length <= 1} onClick={() => setCursors(cursors.slice(0, -1))}>
              Previous page
            </button>
            <button type="button" className="button small-button" disabled={page.next === null} onClick={() => page.next !== null && setCursors([...cursors, page.next])}>
              Next page
            </button>
          </span>
        </nav>
      ) : null}
    </div>
  );

  const isNew = selected === NEW;
  const panel =
    selected === undefined ? undefined : (
      <DocumentInspector
        key={`${selected}|${isNew ? (search.get("childOf") ?? "") : ""}`}
        databaseId={database.databaseId}
        documentId={isNew ? undefined : selected}
        newParentId={isNew ? (search.get("childOf") ?? undefined) : undefined}
        onClose={() => guard(close)}
        onCreated={(id) => {
          dirty.current = false;
          open(id);
        }}
        onChanged={() => setReloads((n) => n + 1)}
        onDeleted={() => {
          dirty.current = false;
          close();
        }}
        onOpen={(id) => guard(() => open(id))}
        onShowChildren={(id) =>
          guard(() => {
            const text = filterToSearch({ conditions: [], inConflict: false, topLevel: false, orphaned: false, parentId: id }).toString();
            navigate({ pathname: base, search: `?${text}` });
          })
        }
        onNewChild={(id) => guard(() => navigate(withFilter(`${base}/${NEW}`, { childOf: id })))}
        onDirty={onDirty}
      />
    );

  return (
    <div className="tab-body">
      <h2 className="visually-hidden">Documents</h2>
      <SidePanel main={list} panel={panel} label="Document" storageKey="documentPanelWidth" />
      {pending === undefined ? null : (
        <ConfirmDialog
          title="Discard your changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => {
            const action = pending;
            setPending(undefined);
            dirty.current = false;
            action();
          }}
          onCancel={() => setPending(undefined)}
        >
          <p>The document open in the panel has changes that aren't saved.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function AddColumn({ columns, onAdd, onClose }: { columns: readonly string[]; onAdd: (field: string) => void; onClose: () => void }) {
  const [field, setField] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);

  function add() {
    const name = field.trim();
    if (name === "") {
      setProblem("Name a top-level field.");
      return;
    }
    if (columns.includes(name)) {
      setProblem(`${name} is a column already.`);
      return;
    }
    onAdd(name);
    setField("");
    setProblem(undefined);
    onClose();
  }

  return (
    <div className="card add-column" role="group" aria-label="Add a column">
      <label htmlFor="add-column-field">Column for the field</label>
      <div className="inline-form">
        <input
          ref={input}
          id="add-column-field"
          type="text"
          value={field}
          autoComplete="off"
          aria-invalid={problem !== undefined || undefined}
          aria-describedby={`add-column-help${problem === undefined ? "" : " add-column-problem"}`}
          onChange={(event) => setField(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
            if (event.key === "Escape") onClose();
          }}
        />
        <button type="button" className="button small-button" onClick={add}>
          Add column
        </button>
        <button type="button" className="button small-button" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div id="add-column-help" className="muted small">
        A top-level field. Columns are kept in this browser, for this database.
      </div>
      {problem === undefined ? null : (
        <div id="add-column-problem" className="field-error">
          {problem}
        </div>
      )}
    </div>
  );
}
