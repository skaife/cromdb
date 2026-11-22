// A page of people (all of them, or the invited) for the People and
// Invitations pages: searched on the server as the filter is typed, 50 a
// page in email order, with Previous and Next by the pages already seen, as
// on the documents view.

import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import { names } from "../../api/names.ts";
import { errorMessage } from "../../app/format.ts";
import type { Person, Status } from "./people.ts";

export const PEOPLE_PAGE_SIZE = 50;
const TYPING_PAUSE_MS = 250;

export type PeoplePage = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string } | { readonly kind: "loaded"; readonly people: readonly Person[]; readonly next: string | null };

/** The value, once it has stopped changing for a moment. */
export function useSettled<T>(value: T, ms: number = TYPING_PAUSE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePeopleList(which: "people" | "invitations", filter: string, status: Status | undefined, reloads: number) {
  const q = useSettled(filter.trim());
  const key = `${which}|${q}|${status ?? ""}`;
  const [cursors, setCursors] = useState<{ readonly key: string; readonly list: readonly (string | undefined)[] }>({ key, list: [undefined] });
  // A new search starts again at the first page.
  const list = cursors.key === key ? cursors.list : [undefined];
  const cursor = list[list.length - 1];
  const [page, setPage] = useState<PeoplePage>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    const query = { limit: PEOPLE_PAGE_SIZE, ...(q === "" ? {} : { q }), ...(cursor === undefined ? {} : { after: cursor }) };
    const request = which === "people" ? api("listPeople", { query: { ...query, ...(status === undefined ? {} : { status }) } }) : api("listInvitations", { query });
    request.then(
      ({ data }) => {
        if (!live) return;
        names.remember(data.people);
        setPage({ kind: "loaded", people: data.people, next: data.next });
      },
      (error: unknown) => live && setPage({ kind: "failed", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [which, q, status, cursor, reloads]);

  return {
    page,
    /** 1 for the first page. */
    number: list.length,
    searched: q !== "",
    previous: list.length > 1 ? () => setCursors({ key, list: list.slice(0, -1) }) : undefined,
    next: page.kind === "loaded" && page.next !== null ? () => setCursors({ key, list: [...list, page.next ?? undefined] }) : undefined,
  };
}
