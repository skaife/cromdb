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
