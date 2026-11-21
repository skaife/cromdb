// The documents filter, opened from the Filter button: field = value rows
// with a type each, and In conflict, Top-level only and Orphans. Apply puts
// it in the address; the list goes back to its first page.

import { useEffect, useId, useRef, useState } from "react";
import { CONDITION_TYPES, NO_FILTER, toFindFilter, type Condition, type ConditionType, type Filter } from "./filter.ts";

export function FilterPanel({ filter, onApply, onClose }: { filter: Filter; onApply: (filter: Filter) => void; onClose: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Filter>(filter.conditions.length === 0 ? { ...filter, conditions: [{ field: "", type: "text", value: "" }] } : filter);
  const [problems, setProblems] = useState<ReadonlyMap<number, string>>(new Map());
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, []);

  function setCondition(index: number, change: Partial<Condition>) {
    setDraft({ ...draft, conditions: draft.conditions.map((condition, at) => (at === index ? { ...condition, ...change } : condition)) });
    setProblems(new Map());
  }

  function apply() {
    // A row left blank is no condition.
    const conditions = draft.conditions.filter((condition) => condition.field !== "" || (condition.value !== "" && condition.type !== "empty"));
    const next = { ...draft, conditions };
    const checked = toFindFilter(next);
    if (!checked.ok) {
      setDraft(next);
      setProblems(checked.problems);
      return;
    }
    onApply(next);
  }

  return (
    <div className="card filter-panel" role="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="small-heading">
        Filter
      </h2>
      <p className="muted small">Each condition is a top-level field and its exact value. A document must meet all of them.</p>
      {draft.conditions.map((condition, index) => {
        const problem = problems.get(index);
        const n = index + 1;
        return (
          <div key={index} className="condition" role="group" aria-label={`Condition ${n}`}>
            <input
              ref={index === 0 ? first : undefined}
              type="text"
              aria-label={`Field of condition ${n}`}
              placeholder="field"
              value={condition.field}
              autoComplete="off"
              onChange={(event) => setCondition(index, { field: event.target.value })}
            />
            <span aria-hidden="true">=</span>
            <select aria-label={`Type of condition ${n}`} value={condition.type} onChange={(event) => setCondition(index, { type: event.target.value as ConditionType, ...(event.target.value === "boolean" ? { value: "true" } : {}) })}>
              {CONDITION_TYPES.map((entry) => (
                <option key={entry.type} value={entry.type}>
                  {entry.label}
                </option>
              ))}
            </select>
            {condition.type === "empty" ? (
              <span className="muted condition-value">(empty)</span>
            ) : condition.type === "boolean" ? (
              <select className="condition-value" aria-label={`Value of condition ${n}`} value={condition.value} onChange={(event) => setCondition(index, { value: event.target.value })}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className="condition-value"
                type="text"
                aria-label={`Value of condition ${n}`}
                placeholder={condition.type === "date" ? "YYYY-MM-DD HH:MM" : "value"}
                value={condition.value}
                autoComplete="off"
                aria-invalid={problem !== undefined || undefined}
                aria-describedby={problem === undefined ? undefined : `${id}-problem-${index}`}
                onChange={(event) => setCondition(index, { value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") apply();
                }}
              />
            )}
            <button type="button" className="link-button danger" aria-label={`Remove condition ${n}`} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_c, at) => at !== index) })}>
              Remove
            </button>
            {problem === undefined ? null : (
              <div id={`${id}-problem-${index}`} className="field-error condition-problem">
                {problem}
              </div>
            )}
          </div>
        );
      })}
      <div>
        <button type="button" className="link-button" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "", type: "text", value: "" }] })}>
          Add condition
        </button>
      </div>
      <div className="checks">
        <label>
          <input type="checkbox" checked={draft.inConflict} onChange={(event) => setDraft({ ...draft, inConflict: event.target.checked })} /> In conflict
        </label>
        <label>
          <input type="checkbox" checked={draft.topLevel} onChange={(event) => setDraft({ ...draft, topLevel: event.target.checked })} /> Top-level only
        </label>
        <label>
          <input type="checkbox" checked={draft.orphaned} onChange={(event) => setDraft({ ...draft, orphaned: event.target.checked })} /> Orphans (their parent was deleted)
        </label>
      </div>
      <div className="actions">
        <button type="button" className="button primary" onClick={apply}>
          Apply
        </button>
        <button type="button" className="button" onClick={() => onApply(NO_FILTER)}>
          Clear filter
        </button>
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
