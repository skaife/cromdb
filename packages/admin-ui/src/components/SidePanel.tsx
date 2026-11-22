// A view with a panel beside it on the right: the documents view and its
// inspector, later People and a person. A bar between them resizes the panel,
// by dragging or from the keyboard (it is a separator with a value: arrows,
// Home and End). The width is kept in the browser, between 320 pixels and
// 70% of the window. At phone width the panel covers the view instead.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { readStored, writeStored } from "../app/storage.ts";

export const PANEL_MIN = 320;
export const PANEL_DEFAULT = 460;
const STEP = 16;
const BIG_STEP = 64;

/** The widest the panel may be for a window this wide. */
export function panelMax(windowWidth: number): number {
  return Math.max(PANEL_MIN, Math.floor(windowWidth * 0.7));
}

export function clampWidth(width: number, windowWidth: number): number {
  return Math.round(Math.min(Math.max(width, PANEL_MIN), panelMax(windowWidth)));
}

/** The width kept for a panel, or the default. */
export function storedWidth(storageKey: string, fallback: number = PANEL_DEFAULT): number {
  const stored = Number(readStored(storageKey));
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

/** What a key does to the width, or undefined for a key the separator doesn't take. The panel is on the right: left widens it. */
export function widthAfterKey(key: string, shift: boolean, width: number, windowWidth: number): number | undefined {
  const step = shift ? BIG_STEP : STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width + step, windowWidth);
    case "ArrowRight":
      return clampWidth(width - step, windowWidth);
    case "Home":
      return PANEL_MIN;
    case "End":
      return panelMax(windowWidth);
    default:
      return undefined;
  }
}

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export function SidePanel({
  main,
  panel,
  label,
  storageKey,
  defaultWidth = PANEL_DEFAULT,
}: {
  main: ReactNode;
  /** Nothing: the view takes the whole width. */
  panel: ReactNode | undefined;
  /** What the panel is, for its landmark and its separator ("Document"). */
  label: string;
  /** Where its width is kept. A panel can change it, to open at another kept width (wider for a conflict). */
  storageKey: string;
  defaultWidth?: number;
}) {
  const windowWidth = useWindowWidth();
  const [wanted, setWanted] = useState(() => storedWidth(storageKey, defaultWidth));
  useEffect(() => setWanted(storedWidth(storageKey, defaultWidth)), [storageKey, defaultWidth]);
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const width = clampWidth(wanted, windowWidth);

  function keep(next: number) {
    setWanted(next);
    writeStored(storageKey, String(next));
  }

  function onKeyDown(event: KeyboardEvent) {
    const next = widthAfterKey(event.key, event.shiftKey, width, windowWidth);
    if (next === undefined) return;
    event.preventDefault();
    keep(next);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current === undefined) return;
    setWanted(clampWidth(drag.current.startWidth + (drag.current.startX - event.clientX), windowWidth));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current === undefined) return;
    drag.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
    keep(width);
  }

  const open = panel !== undefined;
  return (
    <div className={open ? "split with-panel" : "split"} style={{ "--panel-width": `${width}px` } as CSSProperties}>
      <div className="split-main">{main}</div>
      {open ? (
        <>
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize the ${label.toLowerCase()} panel`}
            aria-valuenow={width}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={panelMax(windowWidth)}
            aria-valuetext={`${width} pixels wide`}
            tabIndex={0}
            title="Drag to resize"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <span />
          </div>
          <aside className="side-panel" aria-label={label}>
            {panel}
          </aside>
        </>
      ) : null}
    </div>
  );
}
