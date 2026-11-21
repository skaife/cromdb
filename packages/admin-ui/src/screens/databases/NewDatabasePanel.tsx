// Making a database: a name, then Create. Server admins only (the server
// checks; the button shows only for them).

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage } from "../../app/format.ts";

export function NewDatabasePanel({ onCancel, onCreated }: { onCancel: () => void; onCreated: (database: Schemas["Database"]) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: boolean; message: string } | undefined>(undefined);

  useEffect(() => {
    input.current?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setProblem({ field: true, message: "Give the database a name." });
      input.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const { data } = await api("createDatabase", { body: { name: name.trim() } });
      onCreated(data);
    } catch (error) {
      const field = error instanceof ApiError && error.code === "INVALID_INPUT" && error.details?.["path"] === "/name";
      setProblem({ field, message: errorMessage(error) });
      setBusy(false);
      if (field) input.current?.focus();
    }
  }

  return (
    <form className="card form-card" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
      <h2 id={`${id}-title`}>New database</h2>
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        ref={input}
        id={`${id}-name`}
        type="text"
        value={name}
        maxLength={200}
        autoComplete="off"
        aria-invalid={problem?.field === true}
        aria-describedby={`${id}-help${problem?.field === true ? ` ${id}-problem` : ""}`}
        onChange={(event) => setName(event.target.value)}
      />
      {problem?.field === true ? (
        <div id={`${id}-problem`} className="field-error">
          {problem.message}
        </div>
      ) : null}
      <div id={`${id}-help`} className="muted small">
        You become its first admin, creator, writer and reader. The server is added to admins for sync.
      </div>
      {problem !== undefined && !problem.field ? (
        <p role="alert" className="error">
          {problem.message}
        </p>
      ) : null}
      <div className="actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
