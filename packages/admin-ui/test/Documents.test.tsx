import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schemas } from "../src/api/schema.ts";
import { App } from "../src/app/App.tsx";
import { fakeFetch, type Answer, type Sent } from "./fake-server.ts";

const ADA = { personId: "p-ada", displayName: "Ada Admin", email: "ada@example.com", serverAdmin: true, serverName: "office-1" };
const full = { visible: true, read: true, write: true, create: true, admin: true };
const DB = { databaseId: "d-1", name: "Sales tickets", createdAt: "2026-11-12T10:00:00Z", createdBy: "p-ada", access: full };
const BASE = "/api/v0/databases/d-1";

function doc(id: string, content: Record<string, unknown>, extra: Partial<Schemas["Document"]> = {}): Schemas["Document"] {
  return {
    id,
    parentId: id,
    version: `${id}-v1`,
    deleted: false,
    content,
    fieldTypes: {},
    readers: ["*"],
    writers: ["*"],
    createdAt: "2026-11-19T14:03:00.000Z",
    createdBy: "p-bob",
    updatedAt: "2026-11-20T10:42:00.000Z",
    updatedBy: "p-bob",
    updatedOn: "instance-office-1",
    inConflict: false,
    access: { read: true, update: true, delete: true },
    ...extra,
  };
}

const PRINTER = doc("doc-printer", { title: "Printer jams", status: "open", priority: 2 });
const CHAIRS = doc("doc-chairs", { title: "Quote for 40 chairs", status: "open" }, { inConflict: true });

let where = "";
function Where() {
  const location = useLocation();
  where = `${location.pathname}${location.search}`;
  return null;
}

function start(path: string, routes: Record<string, Answer | ((sent: Sent) => Answer)>) {
  const server = fakeFetch({
    "GET /api/v0/me": { body: ADA },
    "GET /api/v0/people/cards": { body: { people: [{ personId: "p-bob", displayName: "Bob Baker" }] } },
    [`GET ${BASE}`]: { body: DB },
    [`POST ${BASE}/find`]: { body: { documents: [PRINTER, CHAIRS], next: null } },
    [`GET ${BASE}/documents/doc-printer`]: { body: PRINTER, headers: { etag: '"doc-printer-v1"' } },
    [`GET ${BASE}/documents/doc-chairs`]: { body: CHAIRS, headers: { etag: '"doc-chairs-v1"' } },
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

const finds = (sent: readonly Sent[]) => sent.filter((s) => s.method === "POST" && s.url.endsWith("/find")).map((s) => s.body);

afterEach(() => window.localStorage.clear());

describe("the documents view", () => {
  it("lists documents oldest first, with the conflict row marked, and the database's tabs", async () => {
    const server = start("/databases/d-1", {});
    expect(await screen.findByRole("heading", { name: "Sales tickets", level: 1 })).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Database" });
    expect(within(tabs).getAllByRole("link").map((link) => link.textContent)).toEqual(["Documents", "Access", "Replicas", "Settings"]);
    await waitFor(() => expect(where).toBe("/databases/d-1/documents"));
    expect(within(tabs).getByRole("link", { name: "Documents" }).getAttribute("aria-current")).toBe("page");
    const table = await screen.findByRole("table", { name: "Documents, oldest created first" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Title", "Created", "Updated", "Updated by"]);
    const chairs = within(table).getByRole("row", { name: /Quote for 40 chairs/ });
    expect(chairs.className).toContain("conflict");
    expect(within(chairs).getByRole("img", { name: "In conflict" })).toBeTruthy();
    expect(await within(table).findAllByText("Bob Baker")).toHaveLength(2);
    expect(finds(server.sent)).toEqual([{ limit: 50 }]);
  });

  it("pages forward by the next cursor and back through the cursors it used", async () => {
    const pages: Record<string, { documents: Schemas["Document"][]; next: string | null }> = {
      first: { documents: [PRINTER], next: "c2" },
      c2: { documents: [CHAIRS], next: "c3" },
      c3: { documents: [doc("doc-3", { title: "Third" })], next: null },
    };
    const server = start("/databases/d-1/documents", {
      [`POST ${BASE}/find`]: (sent) => ({ body: pages[(sent.body as { after?: string }).after ?? "first"] }),
    });
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Printer jams" });
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "Quote for 40 chairs" });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("link", { name: "Third" });
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Page 3 · 1 shown · 50 per page/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByRole("link", { name: "Quote for 40 chairs" });
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByRole("link", { name: "Printer jams" });
    expect(finds(server.sent).map((body) => (body as { after?: string }).after)).toEqual([undefined, "c2", "c3", "c2", undefined]);
  });

  it("filters by typed conditions and the checkboxes, and keeps the filter in the address", async () => {
    const server = start("/databases/d-1/documents", {});
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Printer jams" });
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.type(screen.getByRole("textbox", { name: "Field of condition 1" }), "priority");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type of condition 1" }), "number");
    await user.type(screen.getByRole("textbox", { name: "Value of condition 1" }), "two");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Give a number.")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Value of condition 1" }));
    await user.type(screen.getByRole("textbox", { name: "Value of condition 1" }), "2");
    await user.click(screen.getByRole("checkbox", { name: "In conflict" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(finds(server.sent).at(-1)).toEqual({ limit: 50, filter: { where: { priority: 2 }, inConflict: true } }));
    expect(where).toBe("/databases/d-1/documents?field=priority&type=number&value=2&conflict=1");
    expect(screen.getByText(/priority = 2, in conflict/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter (on)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents"));
    expect(finds(server.sent).at(-1)).toEqual({ limit: 50 });
  });

  it("adds and removes columns, kept for the database", async () => {
    start("/databases/d-1/documents", {});
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Printer jams" });
    await user.click(screen.getByRole("button", { name: "+ Column" }));
    await user.type(screen.getByRole("textbox", { name: "Column for the field" }), "status{Enter}");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Title", "status×", "Created", "Updated", "Updated by"]);
    expect(within(within(table).getByRole("row", { name: /Printer jams/ })).getByText("open")).toBeTruthy();
    expect(window.localStorage.getItem("cromdb.columns.d-1")).toBe('["status"]');
    await user.click(screen.getByRole("button", { name: "Remove the column status" }));
    expect(window.localStorage.getItem("cromdb.columns.d-1")).toBeNull();
  });
});

describe("the inspector", () => {
  it("shows the envelope and the fields, and saves with the version it read", async () => {
    const saved = doc("doc-printer", { title: "Printer jams", status: "closed", priority: 2 }, { version: "doc-printer-v2" });
    const server = start("/databases/d-1/documents/doc-printer", {
      [`PUT ${BASE}/documents/doc-printer`]: { body: { document: saved, editedThroughConflict: false }, headers: { etag: '"doc-printer-v2"' } },
    });
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    expect(await within(panel).findByText("doc-printer")).toBeTruthy();
    expect(within(panel).getByText("(top level)")).toBeTruthy();
    expect(within(panel).getByText("none")).toBeTruthy();
    expect(within(panel).getAllByText("Everyone with access to the database")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    const status = within(panel).getByRole("textbox", { name: "Value of status" });
    await user.clear(status);
    await user.type(status, "closed");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByText("Saved.")).toBeTruthy();
    const put = server.sent.find((s) => s.method === "PUT");
    expect(put?.headers["if-match"]).toBe('"doc-printer-v1"');
    expect(put?.body).toEqual({ content: { title: "Printer jams", status: "closed", priority: 2 }, fieldTypes: {}, readers: ["*"], writers: ["*"] });
    // The list is asked again, and the next save would send the new version.
    expect(finds(server.sent)).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("keeps the edits on screen when the document changed meanwhile, until Reload", async () => {
    const newer = doc("doc-printer", { title: "Printer fixed", status: "closed" }, { version: "doc-printer-v2", updatedBy: "p-bob", updatedAt: "2026-11-21T10:44:00.000Z" });
    let current = PRINTER;
    start("/databases/d-1/documents/doc-printer", {
      [`GET ${BASE}/documents/doc-printer`]: () => ({ body: current, headers: { etag: `"${current.version}"` } }),
      [`PUT ${BASE}/documents/doc-printer`]: { status: 412, body: { error: { code: "STALE_VERSION", message: "The document changed; read it again" } } },
    });
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    const status = await within(panel).findByRole("textbox", { name: "Value of status" });
    await user.clear(status);
    await user.type(status, "mine");
    current = newer;
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    const banner = await within(panel).findByRole("status");
    expect(banner.textContent).toMatch(/This document changed since you opened it \(by Bob Baker, .+\)\. Reload to see the new version; your edits are kept on screen to copy\./);
    expect((within(panel).getByRole("textbox", { name: "Value of status" }) as HTMLInputElement).value).toBe("mine");
    expect(within(panel).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    await user.click(within(banner).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect((within(panel).getByRole("textbox", { name: "Value of title" }) as HTMLInputElement).value).toBe("Printer fixed"));
    expect(within(panel).queryByRole("status")).toBeNull();
  });

  it("refuses a type change that would guess, and saves a date as a date", async () => {
    const server = start("/databases/d-1/documents/doc-printer", {
      [`PUT ${BASE}/documents/doc-printer`]: (sent) => ({ body: { document: { ...PRINTER, ...(sent.body as object), version: "v2" }, editedThroughConflict: false } }),
    });
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    await user.selectOptions(await within(panel).findByRole("combobox", { name: "Type of status" }), "number");
    expect((await within(panel).findByRole("alert")).textContent).toBe('"open" can\'t become a number.');
    expect((within(panel).getByRole("combobox", { name: "Type of status" }) as HTMLSelectElement).value).toBe("text");
    await user.click(within(panel).getByRole("button", { name: "Add field" }));
    const name = within(panel).getByRole("textbox", { name: "Name of the new field" });
    expect(document.activeElement).toBe(name);
    await user.type(name, "due");
    await user.selectOptions(within(panel).getByRole("combobox", { name: "Type of due" }), "date");
    await user.type(within(panel).getByRole("textbox", { name: "Value of due" }), "2026-11-24T17:00:00Z");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await within(panel).findByText("Saved.");
    const put = server.sent.find((s) => s.method === "PUT")?.body as { content: Record<string, unknown>; fieldTypes: Record<string, string> };
    expect(put.content["due"]).toBe("2026-11-24T17:00:00.000Z");
    expect(put.fieldTypes).toEqual({ "/due": "datetime" });
  });

  it("deletes only after asking, with the version it read", async () => {
    const server = start("/databases/d-1/documents/doc-printer", {
      [`DELETE ${BASE}/documents/doc-printer`]: { body: { editedThroughConflict: false } },
    });
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    const remove = await within(panel).findByRole("button", { name: "Delete document" });
    await user.click(remove);
    const dialog = screen.getByRole("alertdialog", { name: "Delete this document?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(server.sent.some((s) => s.method === "DELETE")).toBe(false);
    await user.click(remove);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents"));
    expect(server.sent.find((s) => s.method === "DELETE")?.headers["if-match"]).toBe('"doc-printer-v1"');
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("asks before unsaved edits are dropped for another document", async () => {
    start("/databases/d-1/documents/doc-printer", {});
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    await user.type(await within(panel).findByRole("textbox", { name: "Value of status" }), "!");
    await user.click(screen.getByRole("link", { name: "Quote for 40 chairs" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(where).toBe("/databases/d-1/documents/doc-printer");
    expect((within(panel).getByRole("textbox", { name: "Value of status" }) as HTMLInputElement).value).toBe("open!");
    await user.click(screen.getByRole("link", { name: "Quote for 40 chairs" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents/doc-chairs"));
    expect(await screen.findByText(/In conflict. Resolving it comes in a later version/)).toBeTruthy();
  });

  it("makes a new document, with its parent when it is a child", async () => {
    const made = doc("doc-new", { title: "Call back" }, { parentId: "doc-printer" });
    const server = start("/databases/d-1/documents/doc-printer", {
      [`POST ${BASE}/documents`]: { status: 201, body: made, headers: { etag: '"doc-new-v1"' } },
      [`GET ${BASE}/documents/doc-new`]: { body: made, headers: { etag: '"doc-new-v1"' } },
    });
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    await user.click(await within(panel).findByRole("button", { name: "New child" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents/new?childOf=doc-printer"));
    const fresh = await screen.findByRole("complementary", { name: "Document" });
    expect(within(fresh).getByRole("heading", { name: "New document" })).toBeTruthy();
    expect((within(fresh).getByRole("textbox", { name: "Parent (optional)" }) as HTMLInputElement).value).toBe("doc-printer");
    await user.click(within(fresh).getByRole("button", { name: "Add field" }));
    await user.type(within(fresh).getByRole("textbox", { name: "Name of the new field" }), "title");
    await user.type(within(fresh).getByRole("textbox", { name: "Value of title" }), "Call back");
    await user.click(within(fresh).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents/doc-new"));
    expect(server.sent.find((s) => s.method === "POST" && s.url.endsWith("/documents"))?.body).toEqual({
      content: { title: "Call back" },
      fieldTypes: {},
      readers: ["*"],
      writers: ["*"],
      parentId: "doc-printer",
    });
  });

  it("shows a document read-only to someone who can't change it", async () => {
    const readOnly = doc("doc-printer", { title: "Printer jams" }, { access: { read: true, update: false, delete: false } });
    start("/databases/d-1/documents/doc-printer", { [`GET ${BASE}/documents/doc-printer`]: { body: readOnly, headers: { etag: '"x"' } } });
    const panel = await screen.findByRole("complementary", { name: "Document" });
    expect(await within(panel).findByText("You can read this document but not change it.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Delete document" })).toBeNull();
    expect(within(panel).queryAllByRole("textbox").map((box) => box.getAttribute("aria-label"))).toEqual([]);
  });

  it("says so when the document isn't there, and the separator resizes the panel from the keyboard", async () => {
    start("/databases/d-1/documents/gone", {});
    const user = userEvent.setup();
    const panel = await screen.findByRole("complementary", { name: "Document" });
    expect((await within(panel).findByRole("alert")).textContent).toBe("This document doesn't exist, or you can't read it.");
    const separator = screen.getByRole("separator", { name: "Resize the document panel" });
    const before = Number(separator.getAttribute("aria-valuenow"));
    separator.focus();
    await user.keyboard("{ArrowLeft}");
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(before + 16);
    expect(window.localStorage.getItem("cromdb.documentPanelWidth")).toBe(String(before + 16));
    await user.click(within(panel).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(where).toBe("/databases/d-1/documents"));
  });
});

describe("a database that isn't there", () => {
  it("says so, with the way back", async () => {
    start("/databases/nope/documents", {});
    expect(await screen.findByRole("heading", { name: "Database not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Databases" })).toBeTruthy();
  });
});
