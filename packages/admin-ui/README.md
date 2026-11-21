# @cromdb/admin-ui

> **Status: 0.x, private.** This package isn't published. It is the admin
> UI that CromDB Server serves at `/`. It has only its first screens so far:
> logging in, the list of databases, and a database's documents with an
> inspector to read and edit them. Not for production use.

A React page, built with Vite into `dist/`, which the server serves beside
its API. How the server serves it, and how to run it while working on it,
is in the server's README under The admin UI
([../server/README.md](../server/README.md)).

## Scripts

- `npm run build`: builds `dist/`.
- `npm run dev`: the Vite dev server on http://localhost:5173, passing
  `/api` and `/auth` on to a running server (by default
  `npm run dev:server -w @cromdb/server`).
- `npm run typecheck`
- `npm test`: the component tests (vitest, in jsdom).
- `npm run test:browser`: the browser tests (Playwright), against the
  server's dev server with its fake login provider. Build everything first
  (`npm run build` at the root). Set `CROMDB_SCREENS` to a folder to save a
  screenshot of each screen.
- `npm run gen:api`: writes `src/api/schema.ts`, the API's types, from the
  server's route table. Run it after changing a route; a test fails while
  the file differs from what the route table gives.

## Browsers

The browser tests run every screen in Chromium at desktop and phone width.
Firefox runs only the shell tests (logging in, the menu, the Databases
list). With Playwright 1.65.1, the Firefox build Playwright ships crashes
during the documents tests in some runs: a segfault in Firefox's content
process, not an error in the page. Chromium never does. This is to be
revisited when Playwright updates.
