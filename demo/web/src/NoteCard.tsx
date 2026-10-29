import { useState } from "react";
import type { AddEntry } from "./ActivityLog.tsx";
import { ApiError, api } from "./api.ts";
import type { Note, ReplicaRef, VectorClock } from "./types.ts";

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "on B", in B's color, or "on another replica" for one the page hasn't heard from. */
export function OnReplica({ instanceId, instanceNames }: { instanceId: string; instanceNames: Record<string, string> }) {
  const name = Object.hasOwn(instanceNames, instanceId) ? instanceNames[instanceId] : undefined;
  return name === undefined ? <>on another replica</> : <span className={`on-replica replica-${name}`}>on {name}</span>;
}

type Message = { kind: "stale" | "warning" | "error"; text: string };

const STALE = "This note changed since you opened it.";

interface Props {
  replica: ReplicaRef;
  note: Note;
  instanceNames: Record<string, string>;
  /** Who is signed in on this replica, as its /api/info says. */
  person: string;
  onChanged: () => void;
  onLog: AddEntry;
  onOpenConflict: () => void;
}

export function NoteCard({ replica, note, instanceNames, person, onChanged, onLog, onOpenConflict }: Props) {
  const client = api(replica);
  // The draft keeps the clock of the version it was opened from, whatever
  // polling shows meanwhile, so a save can be refused as stale.
  const [draft, setDraft] = useState<{ title: string; text: string; vectorClock: VectorClock } | undefined>();
  const [message, setMessage] = useState<Message | undefined>();

  const open = () => {
    setMessage(undefined);
    setDraft({ title: note.content.title, text: note.content.text, vectorClock: note.vectorClock });
  };

  const on = { replica: replica.name };

  async function write(
    kind: "save" | "delete",
    action: () => Promise<{ note?: Note; editedThroughConflict: boolean }>,
  ): Promise<void> {
    setMessage(undefined);
    try {
      const { note: saved, editedThroughConflict } = await action();
      setDraft(undefined);
      if (saved !== undefined) {
        onLog([{ person: saved.updatedBy }, " edited ", saved.content.title, " on ", on, "."]);
      } else {
        onLog([{ person }, " deleted ", note.content.title, " on ", on, "."]);
      }
      if (editedThroughConflict) {
        const title = saved?.content.title ?? note.content.title;
        onLog([kind === "save" ? "Saved, but " : "Deleted, but ", title, " is still in conflict on ", on, "."]);
        setMessage({ kind: "warning", text: "Saved, but this note is still in conflict." });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_DOCUMENT") {
        onLog([{ person }, `'s ${kind} of `, note.content.title, " on ", on, " was refused: it changed since it was opened."]);
        setMessage({ kind: "stale", text: STALE });
      } else {
        setMessage({ kind: "error", text: e instanceof ApiError ? e.message : String(e) });
      }
    } finally {
      onChanged();
    }
  }

  return (
    <li className={note.inConflict ? "note in-conflict" : "note"} aria-label={note.deleted ? "Deleted note" : note.content.title}>
      {draft === undefined ? (
        <>
          <div className="note-head">
            <h3>{note.deleted ? "Deleted note" : note.content.title}</h3>
            {note.inConflict && <span className="badge conflict-badge">In conflict</span>}
          </div>
          {!note.deleted && <p className="note-text">{note.content.text}</p>}
          <div className="note-meta">
            last edited by {note.updatedBy} <OnReplica instanceId={note.updatedOn} instanceNames={instanceNames} />,{" "}
            {formatTime(note.updatedAt)}
          </div>
          <div className="buttons">
            {note.inConflict && (
              <button type="button" className="primary" onClick={onOpenConflict}>
                Resolve
              </button>
            )}
            {!note.deleted && (
              <>
                <button type="button" onClick={open}>
                  Edit
                </button>
                <button type="button" onClick={() => void write("delete", () => client.remove(note.id, note.vectorClock))}>
                  Delete
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <form
          className="note-form"
          onSubmit={(event) => {
            event.preventDefault();
            void write("save", () => client.save(note.id, draft.title, draft.text, draft.vectorClock));
          }}
        >
          <input aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <textarea aria-label="Text" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={2} />
          <div className="buttons">
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message !== undefined && (
        <div className={`message ${message.kind}`} role="alert">
          <span>{message.text}</span>
          {message.kind === "stale" && (
            // Editing: start again from the note as it is now. Deleting: the
            // card already shows it as it is now.
            <button type="button" onClick={draft === undefined ? () => setMessage(undefined) : open}>
              Reload
            </button>
          )}
          {message.kind !== "stale" && (
            <button type="button" onClick={() => setMessage(undefined)}>
              OK
            </button>
          )}
        </div>
      )}
    </li>
  );
}
