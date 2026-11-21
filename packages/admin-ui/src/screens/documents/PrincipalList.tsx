// A document's readers or writers: each name with Remove, and one box to add
// to the list. "*" is everyone with access to the database. Server admins
// can search people by name or email; anyone can paste a person's ID.

import { useEffect, useId, useState } from "react";
import { api } from "../../api/client.ts";
import { EVERYONE, type NameBook } from "../../api/names.ts";
import type { Schemas } from "../../api/schema.ts";
import { useMe } from "../../app/session.ts";
import { Name } from "../../components/Name.tsx";

const EVERYONE_TEXT = "Everyone with access to the database";

export function PrincipalList({
  label,
  ids,
  book,
  readOnly,
  onChange,
}: {
  label: "Readers" | "Writers";
  ids: readonly string[];
  book: NameBook;
  readOnly: boolean;
  onChange: (ids: string[]) => void;
}) {
  const me = useMe();
  const id = useId();
  const [adding, setAdding] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [found, setFound] = useState<readonly Schemas["Person"][]>([]);
  const list = label.toLowerCase();

  // Server admins: people whose name or email has the text typed.
  const query = adding.trim();
  useEffect(() => {
    if (!me.serverAdmin || query.length < 2 || query === EVERYONE) {
      setFound([]);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api("listPeople", { query: { q: query, limit: 8 } }).then(
        ({ data }) => live && setFound(data.people.filter((person) => person.status !== "disabled")),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [me.serverAdmin, query]);

  function add(entry: string) {
    const value = entry.trim();
    if (value === "") return;
    if (value.toLowerCase() === "anonymous") {
      setProblem('The server has no anonymous sessions. Use "*" for everyone with access to the database.');
      return;
    }
    if (ids.includes(value)) {
      setProblem(`That is in the ${list} already.`);
      return;
    }
    onChange([...ids, value]);
    setAdding("");
    setFound([]);
    setProblem(undefined);
  }

  return (
    <fieldset className="principals">
      <legend>{label}</legend>
      {ids.length === 0 ? (
        <p className="muted small">{label === "Readers" ? "Nobody listed: only the writers can read it." : "Nobody listed."}</p>
      ) : (
        <ul className="principal-list">
          {ids.map((entry) => {
            const name = entry === EVERYONE ? { text: EVERYONE_TEXT, title: "*" } : book.label(entry, me.personId);
            return (
              <li key={entry}>
                <Name label={name} />
                {readOnly ? null : (
                  <button type="button" className="link-button danger" aria-label={`Remove ${name.text} from the ${list}`} onClick={() => onChange(ids.filter((other) => other !== entry))}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {readOnly ? null : (
        <div className="principal-add">
          {/* Enter adds; it never saves the document. */}
          <div className="inline-form">
            <input
              id={`${id}-add`}
              type="text"
              aria-label={`Add to the ${list}`}
              aria-describedby={`${id}-help${problem === undefined ? "" : ` ${id}-problem`}`}
              value={adding}
              autoComplete="off"
              placeholder={me.serverAdmin ? "Name, email, person ID or *" : "Person ID, or *"}
              onChange={(event) => {
                setAdding(event.target.value);
                setProblem(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add(adding);
                }
              }}
            />
            <button type="button" className="button small-button" onClick={() => add(adding)}>
              Add
            </button>
          </div>
          <div id={`${id}-help`} className="muted small">
            {me.serverAdmin ? "Type to search people, or paste an ID." : "Paste the person's ID; a server admin can look it up."} * is everyone with access to the database.
          </div>
          {problem === undefined ? null : (
            <div id={`${id}-problem`} className="field-error">
              {problem}
            </div>
          )}
          {found.length > 0 ? (
            <ul className="found-people" aria-label="People found">
              {found.map((person) => (
                <li key={person.personId}>
                  <button type="button" className="link-button" onClick={() => add(person.personId)}>
                    Add {person.displayName ?? person.email}
                    {person.displayName === null ? "" : ` (${person.email})`}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}
