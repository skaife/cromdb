import { useState, type Ref } from "react";
import type { AddEntry } from "./ActivityLog.tsx";
import { ApiError, api } from "./api.ts";
import type { ReplicaState } from "./App.tsx";
import { NoteCard } from "./NoteCard.tsx";
import type { ReplicaRef } from "./types.ts";

interface Props {
  ref: Ref<HTMLElement>;
  replica: ReplicaRef;
  state: ReplicaState;
  instanceNames: Record<string, string>;
  onChanged: () => void;
  onLog: AddEntry;
  onOpenConflict: (noteId: string) => void;
}

export function ReplicaPane({ ref, replica, state, instanceNames, onChanged, onLog, onOpenConflict }: Props) {
  const { info, notes, running } = state;
  const client = api(replica);
  const [error, setError] = useState<string | undefined>();
  const offline = info?.online === false;

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      onChanged();
    }
  }

  const classes = ["pane", `replica-${replica.name}`];
  if (running === false) {
    classes.push("not-running");
  } else if (offline) {
    classes.push("offline");
  }

  return (
    <section ref={ref} className={classes.join(" ")} aria-label={`Replica ${replica.name}`}>
      <header className="pane-header">
        <div className="pane-title">
          <h2>
            Replica {replica.name}
            {offline && <span className="badge offline-badge">Offline</span>}
          </h2>
          {info !== undefined && (
            <button
              type="button"
              role="switch"
              aria-checked={info.online}
              aria-label="Online"
              className="switch"
              onClick={() => void act(() => client.setOnline(!info.online))}
            >
              <span className="switch-knob" />
              {info.online ? "Online" : "Offline"}
            </button>
          )}
        </div>
        {info !== undefined && (
          <>
            <div className="signed-in">Signed in as {info.person} (demo)</div>
            <div className="facts">
              port {info.port} · pid {info.pid} · {info.dataFile}
            </div>
          </>
        )}
      </header>

      {running === false ? (
        <div className="pane-message">Replica {replica.name} is not running</div>
      ) : (
        <div className="pane-body">
          {error !== undefined && (
            <div className="message error" role="alert">
              {error}
            </div>
          )}
          <NewNote
            onCreate={(title, text) =>
              act(async () => {
                const { note } = await client.create(title, text);
                onLog([{ person: note.createdBy }, " created ", note.content.title, " on ", { replica: replica.name }, "."]);
              })
            }
          />
          <ul className="notes">
            {notes.map((note) => (
              <NoteCard
                key={note.id}
                replica={replica}
                note={note}
                instanceNames={instanceNames}
                person={info?.person ?? ""}
                onChanged={onChanged}
                onLog={onLog}
                onOpenConflict={() => onOpenConflict(note.id)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function NewNote({ onCreate }: { onCreate: (title: string, text: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button type="button" className="new-note" onClick={() => setOpen(true)}>
        New note
      </button>
    );
  }
  return (
    <form
      className="note-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate(title, text).then((ok) => {
          if (ok) {
            setOpen(false);
            setTitle("");
            setText("");
          }
        });
      }}
    >
      <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <textarea aria-label="Text" placeholder="Text" value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      <div className="buttons">
        <button type="submit">Add note</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
