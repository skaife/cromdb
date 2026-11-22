// People whose name or email has the text typed, for server admins (GET
// /api/v0/people?q=), asked a moment after typing stops. Disabled people are
// left out: they can't log in.

import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";

export function usePeopleSearch(text: string, limit = 8): readonly Schemas["Person"][] {
  const [found, setFound] = useState<readonly Schemas["Person"][]>([]);
  const query = text.trim();
  useEffect(() => {
    if (query.length < 2 || query === "*") {
      setFound([]);
      return undefined;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api("listPeople", { query: { q: query, limit } }).then(
        ({ data }) => live && setFound(data.people.filter((person) => person.status !== "disabled")),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, limit]);
  return found;
}
