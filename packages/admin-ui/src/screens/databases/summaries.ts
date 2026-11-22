// Each database's counts for the list (GET .../summary), asked for one at a
// time once the list shows, so a slow count holds up no other row.

import { useEffect, useState } from "react";
import { api } from "../../api/client.ts";
import type { Schemas } from "../../api/schema.ts";
import { errorMessage } from "../../app/format.ts";

export type Summary =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly counts: Schemas["DatabaseSummary"] };

export function useSummaries(databaseIds: readonly string[]): ReadonlyMap<string, Summary> {
  const key = databaseIds.join(",");
  const [summaries, setSummaries] = useState<ReadonlyMap<string, Summary>>(new Map());
  useEffect(() => {
    let live = true;
    const ids = key === "" ? [] : key.split(",");
    setSummaries(new Map(ids.map((id) => [id, { kind: "loading" }])));
    const set = (id: string, summary: Summary) => live && setSummaries((current) => new Map(current).set(id, summary));
    void (async () => {
      for (const databaseId of ids) {
        if (!live) return;
        try {
          const { data } = await api("getDatabaseSummary", { params: { databaseId } });
          set(databaseId, { kind: "loaded", counts: data });
        } catch (error) {
          set(databaseId, { kind: "failed", message: errorMessage(error) });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [key]);
  return summaries;
}
