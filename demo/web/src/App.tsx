import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityLog, joined, plain, type Entry, type Part } from "./ActivityLog.tsx";
import { ApiError, api } from "./api.ts";
import { CaptionBar } from "./CaptionBar.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { connector, type Anchor, type Rect, type Segment } from "./geometry.ts";
import { formatTime } from "./NoteCard.tsx";
import { ReplicaPane } from "./ReplicaPane.tsx";
import type { Info, Note, ReplicaRef } from "./types.ts";

/** What the page last heard from one replica. Nothing here is kept once the replica stops answering. */
export interface ReplicaState {
  info: Info | undefined;
  notes: Note[];
  /** undefined until the first answer or failure. */
  running: boolean | undefined;
}

// Each link has one Sync button. It always asks the same replica to run the
// sync, so one link can't be synced from both ends at once. Each line runs
// between the given points on the two panes' edges, clear of the panes.
const LINKS: readonly { initiator: string; peer: string; initiatorAnchor: Anchor; peerAnchor: Anchor }[] = [
  // From A's left side down to the top of B.
  { initiator: "B", peer: "A", peerAnchor: { side: "left", at: 0.25 }, initiatorAnchor: { side: "top", at: 0.5 } },
  // Across, below A and the activity log, from B to C.
  { initiator: "C", peer: "B", peerAnchor: { side: "right", at: 0.9 }, initiatorAnchor: { side: "left", at: 0.9 } },
  // From A's right side down to the top of C.
  { initiator: "A", peer: "C", peerAnchor: { side: "top", at: 0.5 }, initiatorAnchor: { side: "right", at: 0.25 } },
];

type LinkStatus = { phase: "idle" } | { phase: "syncing" } | { phase: "done"; ok: boolean; text: string };

/** "A and B": the sync goes both ways, so the button names the link, not who starts it. */
function linkName(link: { initiator: string; peer: string }): string {
  return [link.initiator, link.peer].sort().join(" and ");
}

const POLL_MS = 1000;
// A sync takes a few milliseconds; show it travelling for at least this long.
const SYNC_SHOWN_MS = 900;
const RESULT_SHOWN_MS = 4000;

function changes(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}

function syncError(error: unknown, initiator: string, peer: string): Part[] {
  if (!(error instanceof ApiError)) {
    return [String(error)];
  }
  switch (error.code) {
    case "NOT_RUNNING":
      return [{ replica: initiator }, " is not running"];
    case "OFFLINE":
      return [{ replica: initiator }, " is offline"];
    case "PEER_OFFLINE":
      return [{ replica: peer }, " is offline"];
    case "PEER_UNREACHABLE":
      return [{ replica: peer }, " is not running"];
    default:
      return [`${error.code}: ${error.message}`];
  }
}

/** What the log last heard from one replica, to tell what changed. */
interface Seen {
  running: boolean;
  online: boolean | undefined;
  /** Notes in conflict there, with their titles. undefined until it first answers. */
  conflicts: Map<string, string> | undefined;
}

export function noteTitle(note: Note): string {
  return note.deleted ? "a deleted note" : note.content.title;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** captions: show the caption bar, for following the two scenes step by step. */
export function App({ replicas, captions }: { replicas: ReplicaRef[]; captions: boolean }) {
  const [states, setStates] = useState<Record<string, ReplicaState>>(() =>
    Object.fromEntries(replicas.map((r) => [r.name, { info: undefined, notes: [], running: undefined }])),
  );
  // Instance IDs seen in each replica's /api/info, to name the replica a note was edited on.
  const [instanceNames, setInstanceNames] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, LinkStatus>>({});
  const [conflict, setConflict] = useState<{ replica: string; noteId: string } | undefined>();
  const [entries, setEntries] = useState<Entry[]>([]);

  const nextEntry = useRef(0);
  const addEntry = useCallback((parts: Part[]) => {
    const entry = { id: nextEntry.current++, time: formatTime(new Date().toISOString()), parts };
    setEntries((prev) => [entry, ...prev].slice(0, 200));
  }, []);

  // The same as instanceNames, for use outside rendering.
  const names = useRef<Record<string, string>>({});
  const onReplica = (instanceId: string): Part =>
    Object.hasOwn(names.current, instanceId) ? { replica: names.current[instanceId] ?? "" } : "another replica";

  // Compares a replica's answer with the last one and logs what changed. The
  // first answer is where the log starts: nothing before it is reported.
  const seen = useRef(new Map<string, Seen>());
  const observe = useCallback(
    (replica: ReplicaRef, answer: { info: Info; notes: Note[] } | undefined) => {
      const name = replica.name;
      const before = seen.current.get(name);
      if (answer === undefined) {
        seen.current.set(name, { running: false, online: before?.online, conflicts: before?.conflicts });
        if (before?.running === true) {
          addEntry([{ replica: name }, " is not running."]);
        }
        return;
      }
      const { info, notes } = answer;
      const conflicts = new Map(notes.filter((note) => note.inConflict).map((note) => [note.id, noteTitle(note)]));
      seen.current.set(name, { running: true, online: info.online, conflicts });
      if (before === undefined) {
        return;
      }
      if (!before.running) {
        addEntry([{ replica: name }, " is running again."]);
      }
      if (before.online !== undefined && before.online !== info.online) {
        addEntry([{ replica: name }, info.online ? " is back online." : " went offline."]);
      }
      if (before.conflicts === undefined) {
        return;
      }
      for (const [id, title] of conflicts) {
        if (!before.conflicts.has(id)) {
          void logConflict(replica, id, title);
        }
      }
      for (const [id, title] of before.conflicts) {
        if (!conflicts.has(id)) {
          addEntry(["Conflict on ", { replica: name }, " is gone: ", title, "."]);
        }
      }
    },
    [addEntry],
  );

  // Who made the versions in conflict, as the replica lists them.
  async function logConflict(replica: ReplicaRef, id: string, title: string): Promise<void> {
    const head: Part[] = ["Conflict on ", { replica: replica.name }, ": ", title];
    try {
      const answer = await api(replica).conflict(id);
      if (answer.inConflict) {
        const versions = answer.versions.map((v): Part[] => [{ person: v.updatedBy }, " on ", onReplica(v.updatedOn)]);
        addEntry([...head, ", between ", ...joined(versions), "."]);
        return;
      }
    } catch {
      // Logged without the versions below.
    }
    addEntry([...head, "."]);
  }

  const inFlight = useRef(new Set<string>());
  const refresh = useCallback(
    async (name: string) => {
      const replica = replicas.find((r) => r.name === name);
      if (replica === undefined || inFlight.current.has(name)) {
        return;
      }
      inFlight.current.add(name);
      try {
        const client = api(replica);
        const [info, notes] = await Promise.all([client.info(), client.notes()]);
        setStates((prev) => ({ ...prev, [name]: { info, notes, running: true } }));
        names.current[info.instanceId] = name;
        setInstanceNames((prev) => (prev[info.instanceId] === name ? prev : { ...prev, [info.instanceId]: name }));
        observe(replica, { info, notes });
      } catch {
        setStates((prev) => ({ ...prev, [name]: { info: undefined, notes: [], running: false } }));
        observe(replica, undefined);
      } finally {
        inFlight.current.delete(name);
      }
    },
    [replicas, observe],
  );

  useEffect(() => {
    const all = () => replicas.forEach((r) => void refresh(r.name));
    all();
    const timer = setInterval(all, POLL_MS);
    return () => clearInterval(timer);
  }, [replicas, refresh]);

  async function runSync(initiator: string, peer: string): Promise<void> {
    const key = initiator + peer;
    const replica = replicas.find((r) => r.name === initiator);
    if (replica === undefined) {
      return;
    }
    setLinks((prev) => ({ ...prev, [key]: { phase: "syncing" } }));
    const shown = sleep(SYNC_SHOWN_MS);
    let status: LinkStatus;
    try {
      const { pulled, pushed } = await api(replica).sync(peer);
      status = { phase: "done", ok: true, text: `${initiator} got ${changes(pulled.applied)}, ${peer} got ${changes(pushed.applied)}` };
      addEntry([
        { replica: initiator },
        " and ",
        { replica: peer },
        " synced: ",
        { replica: initiator },
        ` got ${changes(pulled.applied)}, `,
        { replica: peer },
        ` got ${pushed.applied}.`,
      ]);
    } catch (error) {
      const reason = syncError(error, initiator, peer);
      status = { phase: "done", ok: false, text: plain(reason) };
      const [first, second] = [initiator, peer].sort();
      addEntry(["Sync ", { replica: first ?? initiator }, " and ", { replica: second ?? peer }, " failed: ", ...reason, "."]);
    }
    await shown;
    setLinks((prev) => ({ ...prev, [key]: status }));
    void refresh(initiator);
    void refresh(peer);
    await sleep(RESULT_SHOWN_MS);
    setLinks((prev) => (prev[key] === status ? { ...prev, [key]: { phase: "idle" } } : prev));
  }

  // Where each pane is, for drawing the links between them.
  const stageRef = useRef<HTMLDivElement>(null);
  const paneRefs = useRef(new Map<string, HTMLElement>());
  const [rects, setRects] = useState<Record<string, Rect>>({});
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) {
      return;
    }
    const measure = () => {
      const origin = stage.getBoundingClientRect();
      const next: Record<string, Rect> = {};
      for (const [name, element] of paneRefs.current) {
        const r = element.getBoundingClientRect();
        next[name] = { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
      }
      setRects(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const segments = LINKS.map((link) => {
    // From the peer to the initiator, the way a sync's pull goes.
    const peer = rects[link.peer];
    const initiator = rects[link.initiator];
    return peer === undefined || initiator === undefined
      ? undefined
      : connector(peer, link.peerAnchor, initiator, link.initiatorAnchor);
  });

  // The log goes under A, as wide as A, and ends clear of the B and C link's
  // button. The button and the status line under it are centred on the line
  // together, so the button's top is about 32 px above it.
  const a = rects.A;
  const across = segments[1];
  const logTop = a === undefined ? 0 : a.y + a.height + 16;
  const logBox =
    a === undefined || across === undefined
      ? undefined
      : { left: a.x, width: a.width, top: logTop, height: Math.max(0, Math.min(across.y1, across.y2) - 42 - logTop) };

  const isUsable = (name: string) => states[name]?.running === true && states[name]?.info?.online === true;
  const conflictReplica = conflict === undefined ? undefined : replicas.find((r) => r.name === conflict.replica);
  const people: Record<string, string> = {};
  for (const [name, state] of Object.entries(states)) {
    if (state.info !== undefined) {
      people[state.info.person] = name;
    }
  }

  return (
    <div className="app">
      {captions && <CaptionBar />}
      <div className="stage" ref={stageRef}>
        <svg className="links" aria-hidden="true">
          {LINKS.map((link, i) => {
            const segment = segments[i];
            if (segment === undefined) {
              return null;
            }
            const status = links[link.initiator + link.peer] ?? { phase: "idle" };
            const usable = isUsable(link.initiator) && isUsable(link.peer);
            return (
              <g key={link.initiator + link.peer} className={usable ? "link" : "link link-unusable"}>
                <line x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
                {status.phase === "syncing" && <TravellingDot segment={segment} initiator={link.initiator} />}
              </g>
            );
          })}
        </svg>
        {replicas.map((replica) => (
          <ReplicaPane
            key={replica.name}
            ref={(element) => {
              if (element === null) {
                paneRefs.current.delete(replica.name);
              } else {
                paneRefs.current.set(replica.name, element);
              }
            }}
            replica={replica}
            state={states[replica.name] ?? { info: undefined, notes: [], running: undefined }}
            instanceNames={instanceNames}
            onChanged={() => void refresh(replica.name)}
            onLog={addEntry}
            onOpenConflict={(noteId) => setConflict({ replica: replica.name, noteId })}
          />
        ))}
        {logBox !== undefined && <ActivityLog entries={entries} people={people} style={logBox} />}
        {LINKS.map((link, i) => {
          const segment = segments[i];
          if (segment === undefined) {
            return null;
          }
          const status = links[link.initiator + link.peer] ?? { phase: "idle" };
          const usable = isUsable(link.initiator) && isUsable(link.peer);
          return (
            <div
              key={link.initiator + link.peer}
              className={usable ? "link-control" : "link-control link-unusable"}
              style={{ left: (segment.x1 + segment.x2) / 2, top: (segment.y1 + segment.y2) / 2 }}
            >
              <button
                type="button"
                className="sync-button"
                disabled={status.phase === "syncing"}
                onClick={() => void runSync(link.initiator, link.peer)}
              >
                Sync {linkName(link)}
              </button>
              <div className="link-status" role="status">
                {status.phase === "syncing" && "Syncing..."}
                {status.phase === "done" && <span className={status.ok ? "ok" : "failed"}>{status.text}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {conflict !== undefined && conflictReplica !== undefined && (
        <ConflictDialog
          replica={conflictReplica}
          noteId={conflict.noteId}
          instanceNames={instanceNames}
          person={states[conflict.replica]?.info?.person ?? ""}
          onLog={addEntry}
          onClose={() => {
            setConflict(undefined);
            void refresh(conflict.replica);
          }}
        />
      )}
    </div>
  );
}

/** A dot going from one end of the link to the other and back: pull, then push. In the color of the replica running the sync. */
function TravellingDot({ segment, initiator }: { segment: Segment; initiator: string }) {
  const path = `M ${segment.x1} ${segment.y1} L ${segment.x2} ${segment.y2}`;
  return (
    <circle r="10" className="dot" style={{ fill: `var(--accent-${initiator})` }}>
      <animateMotion path={path} dur={`${SYNC_SHOWN_MS}ms`} repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" />
    </circle>
  );
}
