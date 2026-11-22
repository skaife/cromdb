import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { fakeFetch, type Answer, type Sent } from "./fake-server.ts";

const ADA = { personId: "p-ada", displayName: "Ada Admin", email: "ada@example.com", serverAdmin: true, serverName: "office-1" };
const full = { visible: true, read: true, write: true, create: true, admin: true };
const readOnly = { visible: true, read: true, write: false, create: false, admin: false };
const DB = { databaseId: "d-1", name: "Sales tickets", createdAt: "2026-11-12T10:00:00Z", createdBy: "p-ada", access: full };
const BASE = "/api/v0/databases/d-1";
const ACL = {
  admins: ["p-ada", "cromdb-server"],
  creators: ["p-ada", "p-bob"],
  writers: ["p-ada", "p-bob", "p-carol"],
  readers: ["p-ada", "p-bob"],
  noAccess: [],
  version: "acl-v1",
  createdAt: "2026-11-12T10:00:00Z",
  createdBy: "p-ada",
  updatedAt: "2026-11-12T10:00:00Z",
  updatedBy: "p-ada",
};
const SETTINGS = { databaseId: "d-1", name: "Sales tickets", purgeAfterDays: 30, level: 4 };
const CARDS = { people: [{ personId: "p-bob", displayName: "Bob Baker" }, { personId: "p-carol", displayName: "Carol Carter" }, { personId: "p-ada", displayName: "Ada Admin" }] };

function start(path: string, routes: Record<string, Answer | ((sent: Sent) => Answer)>, database = DB) {
  const server = fakeFetch({
    "GET /api/v0/me": { body: ADA },
    "GET /api/v0/people/cards": { body: CARDS },
    [`GET ${BASE}`]: { body: database },
    [`POST ${BASE}/find`]: { body: { documents: [], next: null } },
    [`GET ${BASE}/acl`]: { body: ACL, headers: { etag: '"acl-v1"' } },
    [`GET ${BASE}/settings`]: { body: SETTINGS, headers: { etag: '"settings-v1"' } },
    ...routes,
  });
  vi.stubGlobal("fetch", server.fetch);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return server;
}

const box = (name: RegExp | string) => screen.getByRole("checkbox", { name });
const puts = (sent: readonly Sent[], suffix: string) => sent.filter((s) => s.method === "PUT" && s.url.endsWith(suffix));

afterEach(() => window.localStorage.clear());

describe("the Access tab", () => {
  it("shows the lists as a grid, with the server locked and the warnings in each row", async () => {
    start("/databases/d-1/access", {});
    const table = await screen.findByRole("table", { name: /who may do what/i });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(["The servercromdb-server · locked", "Ada Admin (you)", "Bob Baker", "Carol Carter"]);
    expect(box("Admin: The server")).toHaveProperty("checked", true);
    expect(box("Admin: The server")).toHaveProperty("disabled", true);
    expect(within(rows[3] as HTMLElement).getByText("Writer without reader: can't edit anything")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("You can't lock yourself out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save access" })).toHaveProperty("disabled", true);
  });

  it("saves every list at once, with the version read", async () => {
    const user = userEvent.setup();
    const server = start("/databases/d-1/access", {
      [`PUT ${BASE}/acl`]: (sent) => ({ body: { ...ACL, ...(sent.body as object), version: "acl-v2" }, headers: { etag: '"acl-v2"' } }),
    });
    await user.click(await screen.findByRole("checkbox", { name: "Reader: Carol Carter" }));
    expect(screen.queryByText("Writer without reader: can't edit anything")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByText(/^Saved\./);
    const [put] = puts(server.sent, "/acl");
    expect(put?.headers["if-match"]).toBe('"acl-v1"');
    expect(put?.body).toEqual({ ...pickLists(ACL), readers: ["p-ada", "p-bob", "p-carol"] });
  });

  it("adds a person by ID as a reader, and refuses anonymous", async () => {
    const user = userEvent.setup();
    const server = start("/databases/d-1/access", { [`PUT ${BASE}/acl`]: (sent) => ({ body: { ...ACL, ...(sent.body as object) }, headers: { etag: '"acl-v2"' } }) });
    const add = await screen.findByLabelText(/^Add person/);
    await user.type(add, "anonymous{Enter}");
    expect(screen.getByText(/no anonymous sessions/)).toBeTruthy();
    await user.clear(add);
    await user.type(add, "p-dana{Enter}");
    expect(box(/^Reader: p-dana/)).toHaveProperty("checked", true);
    await user.click(screen.getByRole("button", { name: "Save access" }));
    await screen.findByText(/^Saved\./);
    expect(puts(server.sent, "/acl")[0]?.body).toMatchObject({ readers: ["p-ada", "p-bob", "p-dana"] });
  });

  it("won't save a grid that takes away your own admin", async () => {
    const user = userEvent.setup();
    const server = start("/databases/d-1/access", {});
    await user.click(await screen.findByRole("checkbox", { name: "Admin: Ada Admin (you)" }));
    expect((screen.getByRole("alert")).textContent).toMatch(/can't remove yourself from the admins/);
    expect(screen.getByRole("button", { name: "Save access" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(box("Admin: Ada Admin (you)")).toHaveProperty("checked", true);
    expect(puts(server.sent, "/acl")).toEqual([]);
  });

  it("keeps the changes on screen when someone else saved first, until Reload", async () => {
    const user = userEvent.setup();
    let reads = 0;
    start("/databases/d-1/access", {
      [`GET ${BASE}/acl`]: () => {
        reads += 1;
        return reads === 1 ? { body: ACL, headers: { etag: '"acl-v1"' } } : { body: { ...ACL, readers: [...ACL.readers, "p-carol"], version: "acl-v2" }, headers: { etag: '"acl-v2"' } };
      },
      [`PUT ${BASE}/acl`]: { status: 412, body: { error: { code: "STALE_VERSION", message: "stale" } } },
    });
    await user.click(await screen.findByRole("checkbox", { name: "Creator: Carol Carter" }));
    await user.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByText(/Someone changed the access/)).toBeTruthy();
    expect(box("Creator: Carol Carter")).toHaveProperty("checked", true);
    expect(box("Creator: Carol Carter")).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(box("Reader: Carol Carter")).toHaveProperty("checked", true));
    expect(box("Creator: Carol Carter")).toHaveProperty("checked", false);
    expect(screen.queryByText(/Someone changed the access/)).toBeNull();
  });

  it("filters the rows by name", async () => {
    const user = userEvent.setup();
    start("/databases/d-1/access", {});
    await screen.findByRole("table", { name: /who may do what/i });
    await user.type(screen.getByRole("searchbox", { name: "Filter the names" }), "car");
    const table = screen.getByRole("table", { name: /who may do what/i });
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Carol Carter"]);
  });

  it("isn't offered to someone who doesn't admin the database", async () => {
    start("/databases/d-1/documents", {}, { ...DB, access: readOnly });
    await screen.findByRole("link", { name: "Replicas" });
    expect(screen.queryByRole("link", { name: "Access" })).toBeNull();
  });
});

function pickLists(acl: typeof ACL) {
  const { admins, creators, writers, readers, noAccess } = acl;
  return { admins, creators, writers, readers, noAccess };
}

describe("the Replicas tab", () => {
  it("lists every copy, this one marked, and whether this copy has anything from each other one", async () => {
    start("/databases/d-1/replicas", {
      [`GET ${BASE}/replicas`]: {
        body: {
          replicas: [
            { instanceId: "i-office", name: "office-1", createdAt: "2026-11-12T10:00:00Z", thisCopy: true },
            { instanceId: "i-warehouse", name: "warehouse", createdAt: "2026-11-13T10:00:00Z", thisCopy: false, knownThrough: 12 },
            { instanceId: "i-0123456789abcdef", createdAt: "2026-11-14T10:00:00Z", thisCopy: false, knownThrough: 0 },
          ],
          stale: false,
          purgedThrough: 0,
        },
      },
    });
    const table = await screen.findByRole("table", { name: "The replicas" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent)).toEqual(["n/a", "Yes", "Not yet"]);
    expect((within(rows[0] as HTMLElement).getByRole("rowheader")).textContent).toMatch("office-1 (this copy) Active");
    expect((within(rows[2] as HTMLElement).getByRole("rowheader")).textContent).toMatch("i-012345…");
    expect(screen.getByText(/come when servers sync with each other/)).toBeTruthy();
  });

  it("says when this copy is stale, and which copy found it", async () => {
    start("/databases/d-1/replicas", {
      [`GET ${BASE}/replicas`]: {
        body: {
          replicas: [
            { instanceId: "i-office", name: "office-1", createdAt: "2026-11-12T10:00:00Z", thisCopy: true },
            { instanceId: "i-east", name: "branch-east", createdAt: "2026-08-02T10:00:00Z", thisCopy: false, knownThrough: 3 },
          ],
          stale: true,
          staleSource: "i-east",
          purgedThrough: 0,
        },
      },
    });
    expect((await screen.findByText(/This server's copy is stale/)).textContent).toMatch("when it synced with branch-east");
    expect(screen.getByText("Stale: needs a resync")).toBeTruthy();
  });
});

describe("the Settings tab", () => {
  it("saves a new name and purge days with the version read, and the page shows the new name", async () => {
    const user = userEvent.setup();
    const server = start("/databases/d-1/settings", {
      [`PUT ${BASE}/settings`]: (sent) => ({ body: { ...SETTINGS, ...(sent.body as object) }, headers: { etag: '"settings-v2"' } }),
    });
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, " Tickets ");
    const days = screen.getByLabelText("Purge deletions after (days)");
    await user.clear(days);
    await user.type(days, "45");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const [put] = puts(server.sent, "/settings");
    expect(put?.headers["if-match"]).toBe('"settings-v1"');
    expect(put?.body).toEqual({ name: "Tickets", purgeAfterDays: 45 });
    expect((screen.getByRole("heading", { level: 1 })).textContent).toMatch("Tickets");
  });

  it("refuses a blank name and purge days outside 1 to 3650", async () => {
    const user = userEvent.setup();
    start("/databases/d-1/settings", {});
    const days = await screen.findByLabelText("Purge deletions after (days)");
    for (const text of ["0", "3651", "1.5", "ten"]) {
      await user.clear(days);
      await user.type(days, text);
      expect(screen.getByText(/whole number of days, from 1 to 3650/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    }
    await user.clear(days);
    await user.type(days, "3650");
    await user.clear(screen.getByLabelText("Name"));
    expect(screen.getByText("Give the database a name.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("shows the level and the ID, and is read-only to someone who doesn't admin the database", async () => {
    start("/databases/d-1/settings", {}, { ...DB, access: readOnly });
    expect(await screen.findByText("Only the database's admins can change these.")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toHaveProperty("readOnly", true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("d-1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("says when someone else saved first", async () => {
    const user = userEvent.setup();
    start("/databases/d-1/settings", { [`PUT ${BASE}/settings`]: { status: 412, body: { error: { code: "STALE_VERSION", message: "stale" } } } });
    const days = await screen.findByLabelText("Purge deletions after (days)");
    await user.clear(days);
    await user.type(days, "60");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Someone changed these settings/)).toBeTruthy();
    expect(days).toHaveProperty("value", "60");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });
});

describe("the databases list's counts", () => {
  it("shows each database's replicas and conflicts once counted, conflicts linked to them, a capped count as 1000+", async () => {
    start("/databases", {
      "GET /api/v0/databases": {
        body: {
          databases: [DB, { ...DB, databaseId: "d-2", name: "Big" }],
          unavailable: [],
        },
      },
      [`GET ${BASE}/summary`]: { body: { replicas: 3, conflicts: 2, conflictsCapped: false } },
      "GET /api/v0/databases/d-2/summary": { body: { replicas: 1, conflicts: 1000, conflictsCapped: true } },
    });
    const link = await screen.findByRole("link", { name: "2 documents in conflict: show them" });
    expect(link.getAttribute("href")).toBe("/databases/d-1/documents?conflict=1");
    expect(await screen.findByRole("link", { name: "1000+ documents in conflict: show them" })).toBeTruthy();
    const row = screen.getByRole("link", { name: "Sales tickets" }).closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toContain("3");
  });
});
