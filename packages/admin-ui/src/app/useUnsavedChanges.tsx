// Unsaved edits on a screen: leaving asks first. Closing or reloading the tab
// gets the browser's own question (beforeunload); moving inside the page (the
// menu, a tab, a link, the back button, another document) gets ours. Only a
// move to another path asks: a change to the query alone (a filter) keeps the
// screen and its edits.

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";

export interface UnsavedChanges {
  /** The dialog to draw, or null when nothing is asking. */
  readonly dialog: ReactNode;
  /** Lets the next move go without asking, for a move that comes after a save or a delete. */
  readonly allowNext: () => void;
}

/** `what` finishes the sentence "Your changes to ... will be lost.", such as "this document". */
export function useUnsavedChanges(dirty: boolean, what: string): UnsavedChanges {
  const allowed = useRef(false);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (allowed.current) {
      allowed.current = false;
      return false;
    }
    return dirty && currentLocation.pathname !== nextLocation.pathname;
  });

  // Saved meanwhile (or discarded): a question still showing has no reason left.
  useEffect(() => {
    if (!dirty && blocker.state === "blocked") blocker.reset();
  }, [dirty, blocker]);

  const allowNext = useCallback(() => {
    allowed.current = true;
  }, []);

  const dialog =
    blocker.state === "blocked" ? (
      <ConfirmDialog title="Leave without saving?" confirmLabel="Leave" cancelLabel="Stay" danger onConfirm={() => blocker.proceed()} onCancel={() => blocker.reset()}>
        <p>Your changes to {what} will be lost.</p>
      </ConfirmDialog>
    ) : null;

  return { dialog, allowNext };
}
