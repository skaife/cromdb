// A question over the page that needs an answer before going on: Delete this
// document? Discard your changes? Focus starts on the safe choice, Tab stays
// in the dialog, Escape is the safe choice, and focus goes back where it was.
// It is drawn at the top of the page (a portal into body), so a panel it is
// opened from can't clip or offset it.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    cancel.current?.focus();
    return () => {
      if (before !== undefined && before.isConnected) before.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab" || box.current === null) return;
    const buttons = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="overlay">
      <div ref={box} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} onKeyDown={onKeyDown}>
        <h2 id={`${id}-title`}>{title}</h2>
        <div id={`${id}-text`}>{children}</div>
        <div className="actions">
          <button type="button" className={danger ? "button danger-solid" : "button primary"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
          <button ref={cancel} type="button" className="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
