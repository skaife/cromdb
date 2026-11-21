import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { fakeFetch, unauthenticated, type Answer } from "./fake-server.ts";

const ADA = { personId: "p-ada", displayName: "Ada Admin", email: "ada@example.com", serverAdmin: true, serverName: "office-1" };
const IVY = { personId: "p-ivy", displayName: "Ivy Invited", email: "ivy@example.com", serverAdmin: false, serverName: "office-1" };

const full = { visible: true, read: true, write: true, create: true, admin: true };
const DATABASES = {
  databases: [
    { databaseId: "d-1", name: "Sales tickets", createdAt: "2026-11-12T10:00:00Z", createdBy: "p-ada", access: full },
    { databaseId: "d-2", name: "Suggestions box", createdAt: "2026-11-15T10:00:00Z", createdBy: "p-carol", access: { visible: true, read: false, write: false, create: true, admin: false } },
  ],
  unavailable: [{ databaseId: "d-3", name: "Old inventory", reason: "Level 2 database; this server hosts level 4 only" }],
};

let shownPath = "";
function Where() {
  shownPath = useLocation().pathname;
  return null;
}

function start(path: string, routes: Record<string, Answer | ((sent: { body: unknown }) => Answer)>) {
  const server = fakeFetch({
    "GET /api/v0/people/cards": { body: { people: [{ personId: "p-carol", displayName: "Carol Carter" }] } },
    "GET /api/v0/server/about": { body: { serverName: "office-1" } },
    ...routes,
  });
  vi.stubGlobal("fetch", server.fetch);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Where />
    </MemoryRouter>,
  );
  return server;
}

describe("logged out", () => {
  it("shows the server's name and a login that comes back to the same page", async () => {
    start("/databases?x=1", { "GET /api/v0/me": unauthenticated });
    expect(await screen.findByRole("heading", { name: "office-1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Log in" }).getAttribute("href")).toBe("/auth/login?returnTo=%2Fdatabases%3Fx%3D1");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("says so when the server can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("The server can't be reached. Check the connection and try again.");
  });
});

describe("the frame", () => {
  it("shows the server section of the menu to server admins only", async () => {
    start("/", { "GET /api/v0/me": { body: ADA }, "GET /api/v0/databases": { body: DATABASES } });
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    expect(within(menu).getAllByRole("link").map((link) => link.textContent)).toEqual(["Databases", "People", "Invitations", "Servers", "Settings", "Status"]);
    expect(screen.getByText("(server admin)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log out" }).closest("form")?.getAttribute("action")).toBe("/auth/logout");
    await waitFor(() => expect(shownPath).toBe("/databases"));
  });

  it("leaves it out for everyone else, and says so on a server page", async () => {
    start("/server/settings", { "GET /api/v0/me": { body: IVY } });
    const menu = await screen.findByRole("navigation", { name: "Main menu" });
    expect(within(menu).getAllByRole("link").map((link) => link.textContent)).toEqual(["Databases"]);
    expect(screen.getByRole("heading", { name: "Server admins only" })).toBeTruthy();
    expect(screen.queryByText("(server admin)")).toBeNull();
  });

  it("opens and closes the menu with its button", async () => {
    start("/server/status", { "GET /api/v0/me": { body: ADA } });
    const toggle = await screen.findByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByRole("link", { name: "Databases" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("covers the page with a dialog when the session ends", async () => {
    start("/databases", { "GET /api/v0/me": { body: ADA }, "GET /api/v0/databases": unauthenticated });
    const dialog = await screen.findByRole("alertdialog", { name: "Your session ended" });
    const link = within(dialog).getByRole("link", { name: "Log in again" });
    expect(link.getAttribute("href")).toBe("/auth/login?returnTo=%2Fdatabases");
    expect(document.activeElement).toBe(link);
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(true);
  });
});

describe("the Databases list", () => {
  it("shows access as badges, who made each, and unavailable ones", async () => {
    start("/databases", { "GET /api/v0/me": { body: ADA }, "GET /api/v0/databases": { body: DATABASES } });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "NameYour accessCreated",
      expect.stringMatching(/^Sales ticketsadminreadwritecreate.*12 by you$/),
      expect.stringMatching(/^Suggestions boxcreate\(depositor: can add, can't read back\).*15 by Carol Carter$/),
      "Old inventory UnavailableLevel 2 database; this server hosts level 4 only",
    ]);
    expect(within(table).getByRole("link", { name: "Sales tickets" }).getAttribute("href")).toBe("/databases/d-1/documents");
  });

  it("says when there's nothing to show", async () => {
    start("/databases", { "GET /api/v0/me": { body: IVY }, "GET /api/v0/databases": { body: { databases: [], unavailable: [] } } });
    expect(await screen.findByText("You can't see any databases yet. A database admin can give you access.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New database" })).toBeNull();
  });

  it("makes a new database and opens it", async () => {
    const { sent } = start("/databases", {
      "GET /api/v0/me": { body: ADA },
      "GET /api/v0/databases": { body: { databases: [], unavailable: [] } },
      "POST /api/v0/databases": (request) => ({
        status: 201,
        body: { databaseId: "d-new", name: (request.body as { name: string }).name, createdAt: "2026-11-21T10:00:00Z", createdBy: "p-ada", access: full },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "New database" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("Give the database a name.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(name, "  Support tickets ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(shownPath).toBe("/databases/d-new/documents"));
    expect(sent.find((request) => request.method === "POST")?.body).toEqual({ name: "Support tickets" });
  });

  it("shows the server's refusal at the field it names", async () => {
    start("/databases", {
      "GET /api/v0/me": { body: ADA },
      "GET /api/v0/databases": { body: { databases: [], unavailable: [] } },
      "POST /api/v0/databases": { status: 400, body: { error: { code: "INVALID_INPUT", message: "name must not be blank", details: { path: "/name" } } } },
    });
    await userEvent.click(await screen.findByRole("button", { name: "New database" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("name must not be blank")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });
});
