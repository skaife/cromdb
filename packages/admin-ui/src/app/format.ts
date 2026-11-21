// How dates and errors are shown.

import { ApiError } from "../api/client.ts";

/** "Nov 12", or "Nov 12, 2025" outside the current year, in the browser's language. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** One sentence for a refusal, for people. The server's own message where it says more than the code. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Something went wrong in this page. Reload it to try again.";
  }
  switch (error.code) {
    case "NETWORK":
      return error.message;
    case "UNAUTHENTICATED":
      return "Your session ended. Log in again.";
    case "NOT_FOUND":
      return "This no longer exists, or you can no longer see it.";
    case "STALE_VERSION":
      return "This changed since you opened it. Reload to see the new version.";
    case "READ_ONLY":
      return `This database takes no changes right now: ${error.message}`;
    case "BAD_ORIGIN":
      return "The server refused the request because it didn't come from its own page. Reload the page and try again.";
    case "INTERNAL":
      return "Something went wrong on the server. It is in the server's log.";
    case "ACCESS_DENIED":
    case "INVALID_INPUT":
    case "LAST_ADMIN":
    case "PERSON_EXISTS":
    case "NOT_INVITED":
      return error.message;
    default:
      return `${error.message} (${error.code})`;
  }
}

/** "14:03" today, "Yesterday", else "Nov 12" (with the year outside this one). */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return formatDay(iso, now);
}

/** "Nov 19, 14:03" (with the year outside this one). */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatDay(iso, now)}, ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
