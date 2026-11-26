// The person logged in, for every screen under the logged-in page.

import { createContext, useContext } from "react";
import type { Schemas } from "../api/schema.ts";

export type Me = Schemas["Me"];

export const MeContext = createContext<Me | undefined>(undefined);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (me === undefined) throw new Error("useMe outside a logged-in page");
  return me;
}

/** Reads the person logged in again, for a screen that changed what the header shows (the server's name). */
export const RefreshMeContext = createContext<() => Promise<void>>(async () => {});

export function useRefreshMe(): () => Promise<void> {
  return useContext(RefreshMeContext);
}
