// The page's one route: every path renders the page given (App, whose own
// <Routes> pick the screen), under a data router so a screen with unsaved
// edits can ask before the page moves on. A render error shows our own
// page, never the error's text.

import type { ReactNode } from "react";
import type { RouteObject } from "react-router";
import { ErrorPage } from "./ErrorPage.tsx";

export function pageRoutes(page: ReactNode): RouteObject[] {
  return [{ path: "*", element: page, errorElement: <ErrorPage /> }];
}
