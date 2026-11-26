// One document in the side panel: its envelope, its readers and writers, and
// its content as field rows; Save (with the version it was read at, so a
// change made meanwhile is refused, not overwritten), Discard changes, and
// Delete after a confirmation. With no document ID it makes a new one.
//
// When a save or delete is refused because the document changed, the edits
// stay on screen to copy, Save is off, and Reload brings the new version.

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client.ts";
import { shortId, useNames } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage, formatDateTime } from "../../app/format.ts";
import { useMe } from "../../app/session.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { ConflictIcon } from "../../components/ConflictIcon.tsx";
import { ConflictView } from "./ConflictView.tsx";
import { Name } from "../../components/Name.tsx";
import { blankRow, contentToRows, rowsSignature, rowsToContent, type FieldRow } from "./fields.ts";
import { FieldRows } from "./FieldRows.tsx";
import { PrincipalList } from "./PrincipalList.tsx";

type Document = Schemas["Document"];

interface Form {
  readonly rows: readonly FieldRow[];
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  /** New documents only. */
  readonly parentId: string;
}

const signature = (form: Form) => JSON.stringify([rowsSignature(form.rows), form.readers, form.writers, form.parentId]);

function formOf(document: Document): Form {
  return { rows: contentToRows(document.content, document.fieldTypes), readers: [...document.readers], writers: [...document.writers], parentId: "" };
}

type Loaded = { readonly kind: "loading" } | { readonly kind: "missing" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "ready"; readonly document: Document; readonly version: string };

/** Why a save or delete was refused because the document changed, and by whom. */
type Stale = { readonly gone: true } | { readonly gone: false; readonly by?: string; readonly at?: string };

export interface InspectorProps {
  readonly databaseId: string;
  /** Undefined: a new document. */
  readonly documentId: string | undefined;
  /** For a new document: the parent it is made under. */
  readonly newParentId?: string | undefined;
  readonly onClose: () => void;
  readonly onCreated: (documentId: string) => void;
  /** Saved or deleted: the list may have changed. */
  readonly onChanged: () => void;
  readonly onDeleted: () => void;
  readonly onOpen: (documentId: string) => void;
  readonly onShowChildren: (documentId: string) => void;
  readonly onNewChild: (documentId: string) => void;
  readonly onDirty: (dirty: boolean) => void;
  /** Whether the panel shows a conflict, which wants it wider. */
  readonly onWide?: (wide: boolean) => void;
}

export function DocumentInspector(props: InspectorProps) {
  const { databaseId, documentId, onDirty } = props;
  const isNew = documentId === undefined;
  const me = useMe();
  const heading = useRef<HTMLHeadingElement>(null);
  const [loaded, setLoaded] = useState<Loaded>(isNew ? { kind: "loading" } : { kind: "loading" });
  const [form, setForm] = useState<Form>({ rows: [], readers: ["*"], writers: ["*"], parentId: props.newParentId ?? "" });
  const [baseline, setBaseline] = useState(() => signature(form));
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const [parentProblem, setParentProblem] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ readonly kind: "notice" | "error"; readonly text: string } | undefined>(undefined);
  const [stale, setStale] = useState<Stale | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  // A document in conflict opens on its versions; this shows the document itself instead.
  const [editAnyway, setEditAnyway] = useState(false);
  const [conflictDirty, setConflictDirty] = useState(false);

  const dirty = signature(form) !== baseline || conflictDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const showConflict = loaded.kind === "ready" && loaded.document.inConflict && !editAnyway;
  const { onWide } = props;
  useEffect(() => onWide?.(showConflict), [showConflict, onWide]);
  useEffect(() => () => onWide?.(false), [onWide]);

  // The heading gets the focus when the panel opens and when it changes view.
  useEffect(() => {
    heading.current?.focus();
  }, [loaded.kind, showConflict]);

  function show(document: Document, version: string) {
    const next = formOf(document);
    setLoaded({ kind: "ready", document, version });
    setForm(next);
    setBaseline(signature(next));
    setProblems(new Map());
    setStale(undefined);
  }

  useEffect(() => {
    if (documentId === undefined) return undefined;
    let live = true;
    api("getDocument", { params: { databaseId, documentId } }).then(
      ({ data, version }) => live && show(data, version ?? data.version),
      (error: unknown) => {
        if (!live) return;
        setLoaded(error instanceof ApiError && error.code === "NOT_FOUND" ? { kind: "missing" } : { kind: "failed", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [databaseId, documentId, reloads]);

  const document = loaded.kind === "ready" ? loaded.document : undefined;
  const book = useNames(document === undefined ? [...form.readers, ...form.writers] : [document.createdBy, document.updatedBy, ...form.readers, ...form.writers]);

  async function refusedAsStale() {
    if (documentId === undefined) return;
    try {
      const { data } = await api("getDocument", { params: { databaseId, documentId } });
      setStale({ gone: false, by: data.updatedBy, at: data.updatedAt });
    } catch (error) {
      setStale(error instanceof ApiError && error.code === "NOT_FOUND" ? { gone: true } : { gone: false });
    }
  }

  function built() {
    const result = rowsToContent(form.rows);
    if (!result.ok) {
      setProblems(result.problems);
      setMessage({ kind: "error", text: result.problems.size === 1 ? "One field needs fixing before this can be saved." : `${result.problems.size} fields need fixing before this can be saved.` });
      return undefined;
    }
    setProblems(new Map());
    return result;
  }

  async function save() {
    setMessage(undefined);
    setParentProblem(undefined);
    const content = built();
    if (content === undefined) return;
    const body = { content: content.content, fieldTypes: content.fieldTypes, readers: [...form.readers], writers: [...form.writers] };
    setBusy(true);
    try {
      if (documentId === undefined) {
        const parentId = form.parentId.trim();
        const { data } = await api("createDocument", { params: { databaseId }, body: { ...body, ...(parentId === "" ? {} : { parentId }) } });
        setBaseline(signature(form));
        props.onChanged();
        props.onCreated(data.id);
        return;
      }
      if (loaded.kind !== "ready") return;
      const { data, version } = await api("saveDocument", { params: { databaseId, documentId }, body, ifMatch: loaded.version });
      show(data.document, version ?? data.document.version);
      setMessage({ kind: "notice", text: data.editedThroughConflict ? "Saved. The document is still in conflict." : "Saved." });
      props.onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.code === "STALE_VERSION") {
        await refusedAsStale();
      } else if (error instanceof ApiError && error.code === "NOT_FOUND" && !isNew) {
        setStale({ gone: true });
      } else if (error instanceof ApiError && error.code === "INVALID_INPUT" && error.details?.["path"] === "/parentId") {
        setParentProblem(error.message);
      } else {
        setMessage({ kind: "error", text: errorMessage(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (documentId === undefined || loaded.kind !== "ready") return;
    setBusy(true);
    try {
      await api("deleteDocument", { params: { databaseId, documentId }, ifMatch: loaded.version });
      setBaseline(signature(form));
      setAsking(false);
      props.onChanged();
      props.onDeleted();
    } catch (error) {
      setAsking(false);
      setBusy(false);
      if (error instanceof ApiError && error.code === "STALE_VERSION") {
        await refusedAsStale();
      } else if (error instanceof ApiError && error.code === "NOT_FOUND") {
        setStale({ gone: true });
      } else {
        setMessage({ kind: "error", text: errorMessage(error) });
      }
    }
  }

  function discard() {
    if (document === undefined) {
      const empty = { rows: [], readers: ["*"], writers: ["*"], parentId: props.newParentId ?? "" };
      setForm(empty);
      setBaseline(signature(empty));
    } else {
      show(document, loaded.kind === "ready" ? loaded.version : document.version);
    }
    setMessage(undefined);
  }

  function addField() {
    const row = blankRow();
    setForm({ ...form, rows: [...form.rows, row] });
    setFocusKey(row.key);
  }

  const headFor = (title: string) => (
    <div className="panel-head">
      <h2 ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <div className="panel-head-actions">
        <button type="button" className="button small-button hide-on-phone" onClick={props.onClose}>
          Hide
        </button>
        <button type="button" className="button small-button phone-only" onClick={props.onClose}>
          Back
        </button>
      </div>
    </div>
  );
  const head = headFor(isNew ? "New document" : "Document");
  const notice =
    message === undefined ? null : (
      <div aria-live="polite" className="inspector-message panel-note">
        <p className={message.kind === "error" ? "error" : "notice"} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      </div>
    );

  if (showConflict && documentId !== undefined) {
    return (
      <>
        <ConflictView
          // Fresh when the document is read again with a new version (a resolve
          // that left versions this person can't read), not before: asking for
          // a conflict that is gone is a 404.
          key={loaded.kind === "ready" ? loaded.version : ""}
          databaseId={databaseId}
          documentId={documentId}
          head={headFor}
          onEditAnyway={() => setEditAnyway(true)}
          onDirty={setConflictDirty}
          onResolved={(editedThroughConflict, deleted) => {
            if (deleted && !editedThroughConflict) {
              // Gone, as after Delete document: the panel closes.
              setConflictDirty(false);
              props.onChanged();
              props.onDeleted();
              return;
            }
            setMessage({
              kind: "notice",
              text: editedThroughConflict
                ? "Resolved the versions you can read. Other versions, which you can't read, are still in conflict; someone who can read them must resolve those."
                : "Resolved.",
            });
            setConflictDirty(false);
            setReloads((n) => n + 1);
            props.onChanged();
          }}
        />
        {notice}
      </>
    );
  }

  if (!isNew && loaded.kind !== "ready") {
    return (
      <div className="inspector">
        {head}
        {loaded.kind === "loading" ? (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        ) : (
          <p role="alert" className={loaded.kind === "missing" ? "muted" : "error"}>
            {loaded.kind === "missing" ? "This document doesn't exist, or you can't read it." : loaded.message}
          </p>
        )}
      </div>
    );
  }

  const canEdit = isNew || (document !== undefined && document.access.update && !document.deleted);
  const canDelete = document !== undefined && document.access.delete && !document.deleted;
  const name = (id: string) => <Name label={book.label(id, me.personId)} />;

  return (
    <div className="inspector">
      {head}
      {document === undefined ? null : (
        <>
          <h3 className="section-label">Envelope</h3>
          <dl className="envelope">
            <dt>ID</dt>
            <dd className="mono wrap">{document.id}</dd>
            <dt>Version</dt>
            <dd className="mono" title={document.version}>
              {shortId(document.version)}
            </dd>
            <dt>Created</dt>
            <dd>
              {formatDateTime(document.createdAt)} by {name(document.createdBy)}
            </dd>
            <dt>Updated</dt>
            <dd>
              {formatDateTime(document.updatedAt)} by {name(document.updatedBy)} on{" "}
              <span className="mono" title={`Replica ${document.updatedOn}`}>
                {shortId(document.updatedOn)}
              </span>
            </dd>
            <dt>Parent</dt>
            <dd>
              {document.parentId === document.id ? (
                "(top level)"
              ) : (
                <button type="button" className="link-button mono" title={document.parentId} onClick={() => props.onOpen(document.parentId)}>
                  {shortId(document.parentId)}
                </button>
              )}
            </dd>
            <dt>Children</dt>
            <dd className="inline-links">
              <button type="button" className="link-button" onClick={() => props.onShowChildren(document.id)}>
                Show the children of this document
              </button>
              {canEdit ? (
                <button type="button" className="link-button" onClick={() => props.onNewChild(document.id)}>
                  New child
                </button>
              ) : null}
            </dd>
            <dt>Conflict</dt>
            <dd>
              {document.inConflict ? (
                <span className="conflict-text">
                  <ConflictIcon /> In conflict.{" "}
                  <button type="button" className="link-button" onClick={() => setEditAnyway(false)}>
                    Show the versions
                  </button>
                </span>
              ) : (
                "none"
              )}
            </dd>
            {document.deleted ? (
              <>
                <dt>Deleted</dt>
                <dd>yes</dd>
              </>
            ) : null}
          </dl>
          {!canEdit ? <p className="muted small">You can read this document but not change it.</p> : null}
        </>
      )}

      {isNew ? (
        <div className="field">
          <label htmlFor="new-parent">Parent (optional)</label>
          <input
            id="new-parent"
            type="text"
            className="mono"
            value={form.parentId}
            autoComplete="off"
            placeholder="A document ID, for a child document"
            aria-invalid={parentProblem !== undefined || undefined}
            aria-describedby={parentProblem === undefined ? undefined : "new-parent-problem"}
            onChange={(event) => setForm({ ...form, parentId: event.target.value })}
          />
          {parentProblem === undefined ? null : (
            <div id="new-parent-problem" className="field-error">
              {parentProblem}
            </div>
          )}
        </div>
      ) : null}

      <div className="principals-pair">
        <PrincipalList label="Readers" ids={form.readers} book={book} readOnly={!canEdit} onChange={(readers) => setForm({ ...form, readers })} />
        <PrincipalList label="Writers" ids={form.writers} book={book} readOnly={!canEdit} onChange={(writers) => setForm({ ...form, writers })} />
      </div>
      {isNew ? <p className="muted small">You are always among the writers of a document you make.</p> : null}

      <h3 className="section-label">Content</h3>
      <FieldRows rows={form.rows} problems={problems} readOnly={!canEdit} focusKey={focusKey} onChange={(rows) => setForm({ ...form, rows })} />
      {canEdit && form.rows.some((row) => row.type === "date") ? (
        <p className="muted small">Dates are in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}), as YYYY-MM-DD HH:MM.</p>
      ) : null}

      {stale === undefined ? null : (
        <div className="banner warning" role="status">
          {stale.gone ? (
            <p>This document was deleted, or you can no longer read it, since you opened it. Your edits are kept on screen to copy.</p>
          ) : (
            <p>
              This document changed since you opened it
              {stale.by === undefined ? "" : <> (by {name(stale.by)}{stale.at === undefined ? "" : `, ${formatDateTime(stale.at)}`})</>}. Reload to see the new version; your edits are kept on screen to copy.
            </p>
          )}
          {stale.gone ? (
            <button type="button" className="button small-button" onClick={props.onClose}>
              Close
            </button>
          ) : (
            <button type="button" className="button small-button" onClick={() => setReloads(reloads + 1)}>
              Reload
            </button>
          )}
        </div>
      )}

      {canEdit ? (
        <div className="actions">
          <button type="button" className="button" onClick={addField} disabled={stale !== undefined}>
            Add field
          </button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={busy || stale !== undefined || (!isNew && !dirty)}>
            {busy ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
          <button type="button" className="button" onClick={discard} disabled={busy || !dirty}>
            Discard changes
          </button>
          {canDelete ? (
            <button type="button" className="button danger" onClick={() => setAsking(true)} disabled={busy || stale !== undefined}>
              Delete document
            </button>
          ) : null}
        </div>
      ) : canDelete ? (
        <div className="actions">
          <button type="button" className="button danger" onClick={() => setAsking(true)} disabled={busy || stale !== undefined}>
            Delete document
          </button>
        </div>
      ) : null}

      <div aria-live="polite" className="inspector-message">
        {message === undefined ? null : (
          <p className={message.kind === "error" ? "error" : "notice"} role={message.kind === "error" ? "alert" : undefined}>
            {message.text}
          </p>
        )}
      </div>

      {asking ? (
        <ConfirmDialog title="Delete this document?" confirmLabel={busy ? "Deleting…" : "Delete"} danger busy={busy} onConfirm={() => void remove()} onCancel={() => setAsking(false)}>
          <p>
            It is deleted on every replica when they sync.{dirty ? " Your unsaved edits are lost too." : ""} Its children, if it has any, are kept and become orphans.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
