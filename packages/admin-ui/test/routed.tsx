// The page under a memory data router, with the same route as main.tsx puts
// under a browser one, so useBlocker and the error page work in the tests too.

import { useState, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { pageRoutes } from "../src/app/routes.tsx";

export function Routed({ path = "/", children }: { path?: string; children: ReactNode }) {
  const [router] = useState(() => createMemoryRouter(pageRoutes(children), { initialEntries: [path] }));
  return <RouterProvider router={router} />;
}
