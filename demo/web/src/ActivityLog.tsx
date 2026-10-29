// What the replicas reported, newest first. Every entry comes from an answer
// a replica gave: an action's response, or a change seen while polling.

import type { CSSProperties } from "react";

/** A piece of an entry: plain text, a person or a replica (shown in its color). */
export type Part = string | { person: string } | { replica: string };

export interface Entry {
  id: number;
  /** When the page got the answer. */
  time: string;
  parts: Part[];
}

export type AddEntry = (parts: Part[]) => void;

/** The entry as plain text, as the link status shows a sync failure. */
export function plain(parts: Part[]): string {
  return parts.map((part) => (typeof part === "string" ? part : "person" in part ? part.person : part.replica)).join("");
}

/** "A", "A and B", "A, B and C". */
export function joined(items: Part[][]): Part[] {
  return items.flatMap((item, i) => [...(i === 0 ? [] : i === items.length - 1 ? [" and "] : [", "]), ...item]);
}

/** people maps each person to the replica they're signed in on, for the color. */
export function ActivityLog({ entries, people, style }: { entries: Entry[]; people: Record<string, string>; style: CSSProperties }) {
  return (
    <section className="activity" aria-label="Activity" style={style}>
      <h2>Activity</h2>
      <ol className="activity-entries" role="log" aria-label="Activity">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="entry-time">{entry.time}</span>{" "}
            <span className="entry-text">
              {entry.parts.map((part, i) => {
                if (typeof part === "string") {
                  return part;
                }
                const replica = "person" in part ? (Object.hasOwn(people, part.person) ? people[part.person] : undefined) : part.replica;
                const text = "person" in part ? part.person : part.replica;
                return (
                  <span key={i} className={replica === undefined ? "entry-name" : `entry-name replica-${replica}`}>
                    {text}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ol>
      {entries.length === 0 && <p className="activity-empty">Nothing yet. What the replicas report shows up here.</p>}
    </section>
  );
}
