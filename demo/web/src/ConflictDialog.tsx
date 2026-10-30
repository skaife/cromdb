import { useCallback, useEffect, useState } from "react";
import type { AddEntry, Part } from "./ActivityLog.tsx";
import { ApiError, api } from "./api.ts";
import { OnReplica, formatTime } from "./NoteCard.tsx";
import type { ConflictAnswer, ReplicaRef } from "./types.ts";

interface Props {
  replica: ReplicaRef;
  noteId: string;
  instanceNames: Record<string, string>;
  /** Who is signed in on this replica, as its /api/info says. */
  person: string;
  onLog: AddEntry;
  onClose: () => void;
}

/**
 * The versions of a note in conflict, side by side, on one replica. Loaded
 * once when opened, and again on "Look again": a resolve is always based on
 * versions the user has seen.
 */
export function ConflictDialog({ replica, noteId, instanceNames, person, onLog, onClose }: Props) {
  const client = api(replica);
  const [conflict, setConflict] = useState<ConflictAnswer | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [draft, setDraft] = useState<{ title: string; text: string } | undefined>();

  const load = useCallback(async () => {
    setProblem(undefined);
    setDraft(undefined);
    try {
      setConflict(await api(replica).conflict(noteId));
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    }
  }, [replica, noteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(choice: { with: number } | { content: { title: string; text: string } } | { delete: true }) {
    if (conflict?.inConflict !== true) {
      return;
    }
    const title = primary?.deleted === false ? (primary.content.title ?? "the note") : "the note";
    const on = { replica: replica.name };
    try {
      await client.resolve(noteId, { version: conflict.version, ...choice });
      let how: Part[];
      if ("with" in choice) {
        const kept = conflict.versions.find((v) => v.index === choice.with);
        how = [", by keeping ", { person: kept?.updatedBy ?? "" }, "'s version."];
      } else if ("content" in choice) {
        how = [", with a new version."];
      } else {
        how = [", by deleting it."];
      }
      onLog([{ person }, " resolved ", title, " on ", on, ...how]);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_DOCUMENT") {
        onLog([{ person }, "'s resolve of ", title, " on ", on, " was refused: the versions changed since they were opened."]);
        setProblem("The versions changed while you were looking. Look again before choosing.");
      } else if (e instanceof ApiError && e.code === "NOT_IN_CONFLICT") {
        setProblem("This note is no longer in conflict.");
      } else {
        setProblem(e instanceof ApiError ? e.message : String(e));
      }
    }
  }

  const primary = conflict?.inConflict === true ? conflict.versions.find((v) => v.isPrimary) : undefined;

  return (
    <div className="dialog-backdrop">
      <div className={`dialog replica-${replica.name}`} role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title">Note in conflict, on Replica {replica.name}</h2>
        {problem !== undefined && (
          <div className="message stale" role="alert">
            <span>{problem}</span>
            <button type="button" onClick={() => void load()}>
              Look again
            </button>
          </div>
        )}
        {conflict?.inConflict === false && <p>This note is not in conflict.</p>}
        {conflict?.inConflict === true && (
          <>
            <p className="dialog-intro">
              These versions were made without seeing each other. Nothing has been merged or thrown away. Choose what the
              note should be.
            </p>
            <div className="versions">
              {conflict.versions.map((version) => (
                <section key={version.id} className={version.isPrimary ? "version primary-version" : "version"} aria-label={`Version by ${version.updatedBy}`}>
                  <div className="version-label">
                    {version.isPrimary ? "Primary: shown everywhere until resolved" : "Other version"}
                  </div>
                  {version.deleted ? (
                    <p className="note-text">Deleted</p>
                  ) : (
                    <>
                      <h3>{version.content.title}</h3>
                      <p className="note-text">{version.content.text}</p>
                    </>
                  )}
                  <div className="note-meta">
                    by {version.updatedBy} <OnReplica instanceId={version.updatedOn} instanceNames={instanceNames} />,{" "}
                    {formatTime(version.updatedAt)}
                    {!version.authorized && " (not authorized)"}
                  </div>
                  <button type="button" disabled={version.deleted} onClick={() => void resolve({ with: version.index })}>
                    Keep this version
                  </button>
                </section>
              ))}
            </div>
            {draft === undefined ? (
              <div className="buttons">
                <button
                  type="button"
                  onClick={() => setDraft({ title: primary?.content.title ?? "", text: primary?.content.text ?? "" })}
                >
                  Write a new version
                </button>
                <button type="button" onClick={() => void resolve({ delete: true })}>
                  Delete the note
                </button>
              </div>
            ) : (
              <form
                className="note-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void resolve({ content: draft });
                }}
              >
                <input aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                <textarea aria-label="Text" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} rows={3} />
                <div className="buttons">
                  <button type="submit" className="primary">
                    Save new version
                  </button>
                  <button type="button" onClick={() => setDraft(undefined)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        <div className="dialog-close">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
