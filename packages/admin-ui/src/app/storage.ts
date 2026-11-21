// Small things the browser remembers for this person: the documents view's
// extra columns, the side panel's width. The page works the same without
// them (a private window, blocked storage): every read and write is guarded.

const PREFIX = "cromdb.";

export function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(PREFIX + key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: string | undefined): void {
  try {
    if (value === undefined) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Not remembered, that's all.
  }
}
