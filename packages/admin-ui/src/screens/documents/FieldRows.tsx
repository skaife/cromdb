// The inspector's content: one row per field, with its name, its type and its
// value, and a Remove button. Read-only for someone who can't change the
// document.

import { useEffect, useRef, useState } from "react";
import { changeType, FIELD_TYPES, formatDate, type FieldRow, type FieldType } from "./fields.ts";

export function FieldRows({
  rows,
  problems,
  readOnly,
  focusKey,
  onChange,
}: {
  rows: readonly FieldRow[];
  /** What is wrong with a row, by key, from the last Save. */
  problems: ReadonlyMap<string, string>;
  readOnly: boolean;
  /** A row just added: its name gets the focus. */
  focusKey: string | undefined;
  onChange: (rows: FieldRow[]) => void;
}) {
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusKey === undefined) return;
    box.current?.querySelector<HTMLElement>(`[data-row="${focusKey}"] [data-focus]`)?.focus();
  }, [focusKey]);

  function update(key: string, change: (row: FieldRow) => FieldRow) {
    onChange(rows.map((row) => (row.key === key ? change(row) : row)));
    if (refusals.has(key)) {
      const next = new Map(refusals);
      next.delete(key);
      setRefusals(next);
    }
  }

  function setType(row: FieldRow, type: FieldType) {
    const changed = changeType(row, type);
    if (changed.ok) {
      update(row.key, () => changed.row);
    } else {
      setRefusals(new Map(refusals).set(row.key, changed.message));
    }
  }

  if (rows.length === 0) {
    return <p className="muted small">{readOnly ? "This document has no fields." : "No fields yet. Add one with Add field."}</p>;
  }

  return (
    <div className="field-rows" ref={box}>
      <div className="field-row field-head" aria-hidden="true">
        <span>Field</span>
        <span>Type</span>
        <span>Value</span>
        <span />
      </div>
      {rows.map((row) => {
        const shown = row.name !== "" ? row.name : row.added ? "new field" : "the field with no name";
        const message = refusals.get(row.key) ?? problems.get(row.key);
        const messageId = `${row.key}-message`;
        const describedBy = message === undefined ? undefined : messageId;
        return (
          <div key={row.key} className={message === undefined ? "field-row" : "field-row has-problem"} data-row={row.key} role="group" aria-label={`Field ${shown}`}>
            <div className="field-name">
              {row.added && !readOnly ? (
                <input type="text" aria-label="Name of the new field" value={row.name} data-focus autoComplete="off" onChange={(event) => update(row.key, (r) => ({ ...r, name: event.target.value }))} />
              ) : (
                <span className="mono-ish">{row.name === "" ? <span className="muted">(no name)</span> : row.name}</span>
              )}
            </div>
            <div className="field-type">
              {readOnly ? (
                <span className="muted">{FIELD_TYPES.find((entry) => entry.type === row.type)?.label}</span>
              ) : (
                <select aria-label={`Type of ${shown}`} value={row.type} onChange={(event) => setType(row, event.target.value as FieldType)}>
                  {FIELD_TYPES.map((entry) => (
                    <option key={entry.type} value={entry.type}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field-value">
              <ValueEditor row={row} shown={shown} readOnly={readOnly} describedBy={describedBy} invalid={message !== undefined} onText={(text) => update(row.key, (r) => ({ ...r, text }))} />
              {row.nestedDates.length > 0 ? (
                <div className="muted small nested-dates">
                  Dates inside, kept as they are:{" "}
                  {row.nestedDates.map((pointer, index) => (
                    <span key={pointer}>
                      {index > 0 ? ", " : ""}
                      <code>{pointer}</code>
                    </span>
                  ))}
                </div>
              ) : null}
              {message === undefined ? null : (
                <div id={messageId} className="field-error" role={refusals.has(row.key) ? "alert" : undefined}>
                  {message}
                </div>
              )}
            </div>
            <div className="field-remove">
              {readOnly ? null : (
                <button type="button" className="link-button danger" aria-label={`Remove field ${shown}`} onClick={() => onChange(rows.filter((r) => r.key !== row.key))}>
                  Remove
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ValueEditor({
  row,
  shown,
  readOnly,
  describedBy,
  invalid,
  onText,
}: {
  row: FieldRow;
  shown: string;
  readOnly: boolean;
  describedBy: string | undefined;
  invalid: boolean;
  onText: (text: string) => void;
}) {
  if (readOnly) {
    if (row.type === "empty") return <span className="muted">(empty)</span>;
    return <span className={row.type === "json" ? "mono read-value" : "read-value"}>{row.text}</span>;
  }
  const common = { "aria-label": `Value of ${shown}`, "aria-describedby": describedBy, "aria-invalid": invalid || undefined };
  switch (row.type) {
    case "empty":
      return <span className="muted">(empty)</span>;
    case "boolean":
      return (
        <select aria-label={common["aria-label"]} aria-describedby={describedBy} aria-invalid={invalid || undefined} value={row.text} onChange={(event) => onText(event.target.value)}>
          {row.text === "" ? <option value="">Choose…</option> : null}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "json":
      return <textarea {...common} className="mono" rows={Math.min(8, Math.max(2, Math.ceil(row.text.length / 40)))} value={row.text} spellCheck={false} onChange={(event) => onText(event.target.value)} />;
    case "text":
      if (row.text.includes("\n")) {
        return <textarea {...common} rows={Math.min(8, row.text.split("\n").length)} value={row.text} onChange={(event) => onText(event.target.value)} />;
      }
      return <input {...common} type="text" value={row.text} onChange={(event) => onText(event.target.value)} />;
    case "number":
      return <input {...common} type="text" inputMode="decimal" value={row.text} onChange={(event) => onText(event.target.value)} />;
    case "date":
      return <input {...common} type="text" placeholder={formatDate(new Date(2026, 0, 31, 17, 0).toISOString())} value={row.text} onChange={(event) => onText(event.target.value)} />;
  }
}
