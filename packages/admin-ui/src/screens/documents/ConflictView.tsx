// A document in conflict: its versions side by side, field by field, with the
// rows that differ marked, and three ways to resolve it: keep one version,
// save new content (starting from the version shown now), or delete the
// document. Every choice sends the conflict's version as If-Match, so a
// version that arrived meanwhile refuses it rather than being lost.
//
// Only the versions the person can read are listed; the engine says nothing
// of the others. A resolve says whether some stay in conflict
// (editedThroughConflict), and the inspector tells the person then. At phone
// width the versions are shown one at a time.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client.ts";
import { shortId, useNames, type NameBook } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatDateTime } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Name } from "../../components/Name.tsx";
import { useWindowWidth } from "../../components/SidePanel.tsx";
import { conflictRows, orderVersions, sameNames } from "./conflict.ts";
import { blankRow, contentToRows, rowsSignature, rowsToContent, type FieldRow } from "./fields.ts";
import { FieldRows } from "./FieldRows.tsx";
import { PrincipalList } from "./PrincipalList.tsx";

type Conflict = Schemas["Conflict"];
type Version = Schemas["ConflictVersion"];

const PHONE = 720;

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly conflict: Conflict; readonly version: string };

interface Draft {
  readonly rows: readonly FieldRow[];
  readonly readers: readonly string[];
  readonly writers: readonly string[];
}

type Asking = { readonly kind: "keep"; readonly version: Version; readonly n: number } | { readonly kind: "delete" };

export function versionLabel(version: Version, n: number): string {
  return version.isPrimary ? `Version ${n} (shown now)` : `Version ${n}`;
}

function names(ids: readonly string[], book: NameBook, me: string): string {
  return ids.map((id) => (id === "*" ? "Everyone with access" : book.label(id, me).text)).join(", ");
}

export function ConflictView({
  databaseId,
  documentId,
  head,
  onResolved,
  onEditAnyway,
  onDirty,
}: {
  databaseId: string;
  documentId: string;
  /** The panel's head (Hide or Back), from the inspector. */
  head: (title: string) => ReactNode;
  /** deleted: it was resolved by deleting the document. */
  onResolved: (editedThroughConflict: boolean, deleted: boolean) => void;
  onEditAnyway: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const me = useMe();
  const phone = useWindowWidth() <= PHONE;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [shown, setShown] = useState(0);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [draftBase, setDraftBase] = useState("");
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [asking, setAsking] = useState<Asking | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const editor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api("getConflict", { params: { databaseId, documentId } }).then(
      ({ data, version }) => {
        if (!live) return;
        setLoaded({ kind: "ready", conflict: data, version: version ?? data.version });
        setStale(false);
      },
      (error: unknown) => {
        if (!live) return;
        setLoaded(error instanceof ApiError && error.code === "NOT_FOUND" ? { kind: "gone" } : { kind: "failed", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [databaseId, documentId, reloads]);

  const versions = loaded.kind === "ready" ? orderVersions(loaded.conflict.versions) : [];
  const book = useNames(versions.flatMap((v) => [v.document.updatedBy, ...v.document.readers, ...v.document.writers]).concat(draft === undefined ? [] : [...draft.readers, ...draft.writers]));

  const dirty = draft !== undefined && JSON.stringify([rowsSignature(draft.rows), draft.readers, draft.writers]) !== draftBase;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  useEffect(() => {
    if (draft !== undefined) editor.current?.querySelector<HTMLElement>("h3")?.focus();
    // Only when the editor opens.
  }, [draft === undefined]);

  async function resolve(body: Schemas["Resolution"]) {
    if (loaded.kind !== "ready") return;
    setBusy(true);
    setMessage(undefined);
    try {
      const { data } = await api("resolveConflict", { params: { databaseId, documentId }, body, ifMatch: loaded.version });
      setAsking(undefined);
      onDirty(false);
      onResolved(data.editedThroughConflict, "delete" in body);
    } catch (error) {
      setAsking(undefined);
      setBusy(false);
      if (error instanceof ApiError && error.code === "STALE_VERSION") setStale(true);
      else if (error instanceof ApiError && error.code === "NOT_FOUND") setLoaded({ kind: "gone" });
      else setMessage(errorMessage(error));
    }
  }

  function startDraft() {
    const primary = versions.find((v) => v.isPrimary) ?? versions[0];
    if (primary === undefined) return;
    const next = { rows: contentToRows(primary.document.content, primary.document.fieldTypes), readers: [...primary.document.readers], writers: [...primary.document.writers] };
    setDraft(next);
    setDraftBase(JSON.stringify([rowsSignature(next.rows), next.readers, next.writers]));
    setProblems(new Map());
  }

  function saveDraft() {
    if (draft === undefined) return;
    const built = rowsToContent(draft.rows);
    if (!built.ok) {
      setProblems(built.problems);
      setMessage(built.problems.size === 1 ? "One field needs fixing first." : `${built.problems.size} fields need fixing first.`);
      return;
    }
    setProblems(new Map());
    void resolve({ content: built.content, fieldTypes: built.fieldTypes, readers: [...draft.readers], writers: [...draft.writers] });
  }

  if (loaded.kind !== "ready") {
    return (
      <div className="inspector">
        {head("Conflict")}
        {loaded.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : loaded.kind === "gone" ? (
          <>
            <p role="status">This document is no longer in conflict: someone resolved it, or you can no longer read it.</p>
            <div className="actions">
              <button type="button" className="button" onClick={() => onResolved(false, false)}>
                Show the document
              </button>
            </div>
          </>
        ) : (
          <p role="alert" className="error">
            {loaded.message}
          </p>
        )}
      </div>
    );
  }

  const rows = conflictRows(versions);
  const columns = phone ? versions.slice(shown, shown + 1) : versions;
  const offset = phone ? shown : 0;
  const cell = (index: number) => index + offset;
  const anyUnauthorized = versions.some((v) => !v.authorized);
  const kept = versions.filter((v) => !v.deleted);
  const differs = {
    by: new Set(versions.map((v) => v.document.updatedBy)).size > 1,
    on: new Set(versions.map((v) => v.document.updatedOn)).size > 1,
    readers: kept.some((v) => !sameNames(v.document.readers, kept[0]?.document.readers ?? [])),
    writers: kept.some((v) => !sameNames(v.document.writers, kept[0]?.document.writers ?? [])),
  };
  const marker = (on: boolean) => (on ? <span className="badge amber">differs</span> : null);

  if (versions.length < 2) {
    return (
      <div className="inspector">
        {head("Conflict")}
        <p>
          This document is in conflict, but only one of its versions is one you can read. Someone who can read the others must resolve it.
        </p>
        <div className="actions">
          <button type="button" className="link-button" onClick={onEditAnyway}>
            Edit the document as it is
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector conflict-view">
      {head("Conflict")}
      <p>
        This document has {versions.length} versions you can read, side by side below; the rows that differ are marked. Keep one, save new content, or delete the document. Versions
        you can't read aren't shown.
      </p>
      <p className="small">
        <button type="button" className="link-button" onClick={onEditAnyway}>
          Edit the document as it is instead
        </button>{" "}
        <span className="muted">(saving keeps the conflict)</span>
      </p>

      {phone ? (
        <nav className="version-pager" aria-label="Versions">
          <button type="button" className="button small-button" disabled={shown === 0} onClick={() => setShown(shown - 1)}>
            Previous version
          </button>
          <span aria-live="polite">
            {shown + 1} of {versions.length}
          </span>
          <button type="button" className="button small-button" disabled={shown >= versions.length - 1} onClick={() => setShown(shown + 1)}>
            Next version
          </button>
        </nav>
      ) : null}

      <div className="table-box">
        <table className="conflict-table">
          <caption className="visually-hidden">The versions, side by side</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              {columns.map((version, index) => (
                <th scope="col" key={version.document.id}>
                  {versionLabel(version, cell(index) + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="envelope-row">
              <th scope="row">Updated</th>
              {columns.map((version) => (
                <td key={version.document.id}>{formatDateTime(version.document.updatedAt)}</td>
              ))}
            </tr>
            <tr className={differs.by ? "envelope-row differs" : "envelope-row"}>
              <th scope="row">By {marker(differs.by)}</th>
              {columns.map((version) => (
                <td key={version.document.id}>
                  <Name label={book.label(version.document.updatedBy, me.personId)} />
                </td>
              ))}
            </tr>
            <tr className={differs.on ? "envelope-row differs" : "envelope-row"}>
              <th scope="row">On {marker(differs.on)}</th>
              {columns.map((version) => (
                <td key={version.document.id} className="mono" title={`Replica ${version.document.updatedOn}`}>
                  {shortId(version.document.updatedOn)}
                </td>
              ))}
            </tr>
            {anyUnauthorized ? (
              <tr className="envelope-row differs">
                <th scope="row">Writer allowed {marker(true)}</th>
                {columns.map((version) => (
                  <td key={version.document.id}>{version.authorized ? "yes" : "no: its writer wasn't among its writers"}</td>
                ))}
              </tr>
            ) : null}
            <tr className={differs.readers ? "envelope-row differs" : "envelope-row"}>
              <th scope="row">Readers {marker(differs.readers)}</th>
              {columns.map((version) => (
                <td key={version.document.id}>{version.deleted ? "" : names(version.document.readers, book, me.personId)}</td>
              ))}
            </tr>
            <tr className={differs.writers ? "envelope-row differs" : "envelope-row"}>
              <th scope="row">Writers {marker(differs.writers)}</th>
              {columns.map((version) => (
                <td key={version.document.id}>{version.deleted ? "" : names(version.document.writers, book, me.personId)}</td>
              ))}
            </tr>
            {versions.some((v) => v.deleted) ? (
              <tr className="differs">
                <th scope="row">Deleted {marker(true)}</th>
                {columns.map((version) => (
                  <td key={version.document.id}>{version.deleted ? "This version deletes the document" : "no"}</td>
                ))}
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.field} className={row.differs ? "differs" : undefined}>
                <th scope="row">
                  <span className="mono-ish">{row.field === "" ? "(no name)" : row.field}</span> {marker(row.differs)}
                </th>
                {columns.map((version, index) => {
                  const value = row.cells[cell(index)];
                  return (
                    <td key={version.document.id} className={[value?.muted === true ? "muted" : "", value?.json === true ? "mono" : ""].filter((c) => c !== "").join(" ") || undefined}>
                      {value?.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              {columns.map((version, index) => (
                <td key={version.document.id}>
                  {version.deleted ? (
                    <span className="muted small">To keep this one, delete the document below.</span>
                  ) : (
                    <button
                      type="button"
                      className="button small-button"
                      disabled={busy || stale}
                      onClick={() => setAsking({ kind: "keep", version, n: cell(index) + 1 })}
                    >
                      Keep {versionLabel(version, cell(index) + 1).replace(" (shown now)", "").toLowerCase()}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {stale ? (
        <div className="banner warning" role="status">
          <p>The conflict changed since you opened it: another version arrived, or someone resolved it. Reload to see it as it is now{draft === undefined ? "" : "; your new content stays on screen"}.</p>
          <button type="button" className="button small-button" onClick={() => setReloads(reloads + 1)}>
            Reload
          </button>
        </div>
      ) : null}

      {draft === undefined ? (
        <div className="actions">
          <button type="button" className="button" onClick={startDraft} disabled={busy || stale}>
            Save new content…
          </button>
          <button type="button" className="button danger" onClick={() => setAsking({ kind: "delete" })} disabled={busy || stale}>
            Delete the document
          </button>
        </div>
      ) : (
        <div className="conflict-editor" ref={editor}>
          <h3 className="section-label" tabIndex={-1}>
            New content, starting from the version shown now
          </h3>
          <div className="principals-pair">
            <PrincipalList label="Readers" ids={draft.readers} book={book} readOnly={false} onChange={(readers) => setDraft({ ...draft, readers })} />
            <PrincipalList label="Writers" ids={draft.writers} book={book} readOnly={false} onChange={(writers) => setDraft({ ...draft, writers })} />
          </div>
          <FieldRows rows={draft.rows} problems={problems} readOnly={false} focusKey={focusKey} onChange={(rows) => setDraft({ ...draft, rows })} />
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                const row = blankRow();
                setDraft({ ...draft, rows: [...draft.rows, row] });
                setFocusKey(row.key);
              }}
            >
              Add field
            </button>
            <button type="button" className="button primary" onClick={saveDraft} disabled={busy || stale}>
              {busy ? "Saving…" : "Save as the resolution"}
            </button>
            <button type="button" className="button" onClick={() => setDraft(undefined)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div aria-live="polite">
        {message === undefined ? null : (
          <p role="alert" className="error">
            {message}
          </p>
        )}
      </div>

      {asking?.kind === "keep" ? (
        <ConfirmDialog
          title={`Keep version ${asking.n}?`}
          confirmLabel={busy ? "Keeping…" : `Keep version ${asking.n}`}
          busy={busy}
          onConfirm={() => void resolve({ chooseId: asking.version.document.id })}
          onCancel={() => setAsking(undefined)}
        >
          <p>It becomes the document, on every replica when they sync. The other versions you can read are replaced by it.</p>
        </ConfirmDialog>
      ) : asking?.kind === "delete" ? (
        <ConfirmDialog title="Delete this document?" confirmLabel={busy ? "Deleting…" : "Delete"} danger busy={busy} onConfirm={() => void resolve({ delete: true })} onCancel={() => setAsking(undefined)}>
          <p>That resolves the conflict by deleting the document, on every replica when they sync. Its children, if it has any, are kept and become orphans.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
