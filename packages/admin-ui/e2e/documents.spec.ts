// The documents view and the inspector, on the dev server's sample data
// ("Sales tickets" with a document in conflict, an orphan and a child;
// "Paging" with 120 documents). Tests that change things make their own
// documents, named per project, so the runs in each browser and width don't
// meet.

import { expect, test, type Page } from "@playwright/test";
import { checkScreen, logIn, unique, watch } from "./helpers.ts";

const isPhone = (name: string) => name.endsWith("-phone");

async function openDatabase(page: Page, name: string): Promise<string> {
  await page.getByRole("link", { name, exact: true }).click();
  await page.waitForURL(/\/databases\/[^/]+\/documents$/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  return page.url();
}

/** The API, as the person logged in in this page, from the page's own origin (the server checks Origin). */
function asPage(page: Page) {
  const origin = new URL(page.url()).origin;
  return {
    get: (path: string) => page.request.get(path),
    put: (path: string, body: unknown, version: string) => page.request.put(path, { data: body, headers: { origin, "if-match": `"${version}"` } }),
  };
}

test("the view marks the document in conflict, adds columns, filters and pages", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  const table = page.getByRole("table", { name: "Documents, oldest created first" });
  const chairs = table.getByRole("row").filter({ hasText: "Quote for 40 chairs" });
  await expect(chairs.getByRole("img", { name: "In conflict" })).toBeVisible();
  await expect(chairs).toHaveClass(/conflict/);
  await expect(table.getByRole("columnheader")).toHaveText(["Title", "Created", "Updated", "Updated by"]);
  await checkScreen(page, info, "documents", watched);

  await page.getByRole("button", { name: "+ Column" }).click();
  await page.getByRole("textbox", { name: "Column for the field" }).fill("status");
  await page.getByRole("button", { name: "Add column" }).click();
  await expect(table.getByRole("columnheader")).toHaveText(["Title", "status×", "Created", "Updated", "Updated by"]);
  await expect(table.getByRole("row").filter({ hasText: "Wrong invoice address" })).toContainText("closed");

  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("textbox", { name: "Field of condition 1" }).fill("status");
  await page.getByRole("textbox", { name: "Value of condition 1" }).fill("closed");
  await checkScreen(page, info, "filter", watched);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/\?field=status&type=text&value=closed$/);
  await expect(table.getByRole("link")).toHaveText(["Wrong invoice address"]);

  // The filter is in the address: a reload keeps it; the columns are kept in the browser.
  await page.reload();
  await expect(table.getByRole("link")).toHaveText(["Wrong invoice address"]);
  await expect(table.getByRole("columnheader").nth(1)).toHaveText("status×");
  await page.getByRole("button", { name: "Remove the column status" }).click();

  await page.getByRole("button", { name: "Filter (on)" }).click();
  await page.getByRole("button", { name: "Remove condition 1" }).click();
  await page.getByRole("checkbox", { name: /Orphans/ }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(table.getByRole("link")).toHaveText(["Book the van"]);
  await page.getByRole("button", { name: "Filter (on)" }).click();
  await page.getByRole("checkbox", { name: /Orphans/ }).uncheck();
  await page.getByRole("checkbox", { name: "In conflict" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(table.getByRole("link")).toHaveText(["Quote for 40 chairs"]);
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page).toHaveURL(/\/documents$/);

  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Databases" }).click();
  await openDatabase(page, "Paging");
  // Oldest created first; documents made in the same millisecond come in ID order.
  const titles = () => table.getByRole("link").allTextContents();
  await expect(table.getByRole("link")).toHaveCount(50);
  const first = await titles();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(table.getByRole("link").first()).not.toHaveText(first[0] ?? "");
  await expect(table.getByRole("link")).toHaveCount(50);
  const second = await titles();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(table.getByRole("link")).toHaveCount(20);
  const third = await titles();
  const all = [...first, ...second, ...third];
  expect(new Set(all).size).toBe(120);
  expect([...all].sort()).toEqual(Array.from({ length: 120 }, (_, n) => `Item ${String(n + 1).padStart(3, "0")}`));
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await checkScreen(page, info, "last-page", watched);
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(table.getByRole("link")).toHaveText(second);
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(table.getByRole("link")).toHaveText(first);
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
});

/** Back to the list from the panel: at phone width the panel covers it. */
async function backToList(page: Page, phone: boolean): Promise<void> {
  if (phone) await page.getByRole("complementary", { name: "Document" }).getByRole("button", { name: "Back" }).click();
}

test("the inspector shows a document's envelope, its fields with their types, and dates kept inside JSON", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  await page.getByRole("link", { name: "Renewal: Harbor Cafe" }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  await expect(panel.getByRole("heading", { name: "Document" })).toBeFocused();
  await expect(panel.getByRole("combobox", { name: "Type of contact" })).toHaveValue("json");
  await expect(panel.getByText("Dates inside, kept as they are:")).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Type of priority" })).toHaveValue("number");
  await checkScreen(page, info, "inspector", watched);

  await panel.getByRole("button", { name: "Show the children of this document" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("link")).toHaveText(["Call back about the renewal"]);
  await expect(page.getByText(/Filtered: children of/)).toBeVisible();

  await page.getByRole("button", { name: "Clear filter" }).click();
  await page.getByRole("link", { name: "Printer jams on tray 2" }).click();
  await expect(panel.getByRole("combobox", { name: "Type of due" })).toHaveValue("date");
  // The browser runs in UTC here.
  await expect(panel.getByRole("textbox", { name: "Value of due" })).toHaveValue("2026-11-24 17:00");
  await expect(panel.getByRole("combobox", { name: "Type of urgent" })).toHaveValue("boolean");
  await expect(panel.getByRole("combobox", { name: "Type of assignee" })).toHaveValue("empty");

  // A type change that would guess is refused.
  await panel.getByRole("combobox", { name: "Type of title" }).selectOption("number");
  await expect(panel.getByRole("alert")).toHaveText('"Printer jams on tray 2" can\'t become a number.');
  await expect(panel.getByRole("combobox", { name: "Type of title" })).toHaveValue("text");

  await backToList(page, isPhone(info.project.name));
  await page.getByRole("link", { name: "Quote for 40 chairs" }).click();
  // A document in conflict opens on its versions (resolving is tested in conflicts.spec.ts).
  await expect(panel.getByRole("heading", { name: "Conflict" })).toBeVisible();
  await expect(panel.getByRole("table", { name: "The versions, side by side" })).toBeVisible();
});

test("a document is made, edited, refused when stale with the edits kept, and deleted after asking", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  const title = unique(info, "Ticket from the browser test");

  await page.getByRole("link", { name: "New document" }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  await expect(panel.getByRole("heading", { name: "New document" })).toBeVisible();
  await panel.getByRole("button", { name: "Add field" }).click();
  await panel.getByRole("textbox", { name: "Name of the new field" }).fill("title");
  await panel.getByRole("textbox", { name: "Value of title" }).fill(title);
  await panel.getByRole("button", { name: "Add field" }).click();
  await panel.getByRole("textbox", { name: "Name of the new field" }).last().fill("due");
  await panel.getByRole("combobox", { name: "Type of due" }).selectOption("date");
  await panel.getByRole("textbox", { name: "Value of due" }).fill("2026-12-01 09:30");
  await checkScreen(page, info, "new-document", watched);
  await panel.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/documents\/(?!new)[^/?]+$/);
  const documentId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  if (!isPhone(info.project.name)) await expect(page.getByRole("table").getByRole("link", { name: title })).toBeVisible();

  const api = asPage(page);
  const path = `${new URL(page.url()).pathname.replace(/\/documents\/.*$/, "").replace("/databases/", "/api/v0/databases/")}/documents/${documentId}`;
  const stored = await (await api.get(path)).json();
  expect(stored.content).toEqual({ title, due: "2026-12-01T09:30:00.000Z" });
  expect(stored.fieldTypes).toEqual({ "/due": "datetime" });

  // Edit and save.
  await panel.getByRole("button", { name: "Add field" }).click();
  await panel.getByRole("textbox", { name: "Name of the new field" }).fill("status");
  await panel.getByRole("textbox", { name: "Value of status" }).fill("open");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText("Saved.")).toBeVisible();

  // Someone else saves it meanwhile: this save is refused, and the edits stay.
  await panel.getByRole("textbox", { name: "Value of status" }).fill("mine");
  const now = await (await api.get(path)).json();
  const theirs = await api.put(path, { content: { ...now.content, status: "theirs" }, fieldTypes: now.fieldTypes }, now.version);
  expect(theirs.status()).toBe(200);
  await panel.getByRole("button", { name: "Save" }).click();
  const banner = panel.getByRole("status");
  await expect(banner).toContainText("This document changed since you opened it (by you");
  await expect(panel.getByRole("textbox", { name: "Value of status" })).toHaveValue("mine");
  await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
  // The 412 is logged by the browser; it's expected here.
  watched.problems.splice(0);
  await banner.scrollIntoViewIfNeeded();
  await checkScreen(page, info, "stale", watched);
  await banner.getByRole("button", { name: "Reload" }).click();
  await expect(panel.getByRole("textbox", { name: "Value of status" })).toHaveValue("theirs");

  // Leaving with unsaved edits asks first.
  await panel.getByRole("textbox", { name: "Value of status" }).fill("unsaved");
  await panel.getByRole("button", { name: isPhone(info.project.name) ? "Back" : "Hide" }).click();
  const ask = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(ask.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(panel.getByRole("textbox", { name: "Value of status" })).toHaveValue("unsaved");
  await panel.getByRole("button", { name: "Discard changes" }).click();
  await expect(panel.getByRole("textbox", { name: "Value of status" })).toHaveValue("theirs");

  // Delete, after asking.
  await panel.getByRole("button", { name: "Delete document" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this document?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await checkScreen(page, info, "delete-confirm", watched);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("table").getByRole("link", { name: title })).toHaveCount(0);
  expect((await api.get(path)).status()).toBe(404);
});

test("the side panel resizes by dragging and from the keyboard, remembers its width, and hides", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "at phone width the panel covers the view; see the next test");
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  await page.getByRole("link", { name: "Wrong invoice address" }).click();
  const separator = page.getByRole("separator", { name: "Resize the document panel" });
  const start = Number(await separator.getAttribute("aria-valuenow"));
  const box = await separator.boundingBox();
  if (box === null) throw new Error("no separator on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + 100, { steps: 6 });
  await page.mouse.up();
  const dragged = Number(await separator.getAttribute("aria-valuenow"));
  expect(dragged).toBeGreaterThanOrEqual(start + 110);
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", String(dragged - 16));
  await page.keyboard.press("Home");
  await expect(separator).toHaveAttribute("aria-valuenow", "320");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "384");

  await page.reload();
  await expect(page.getByRole("separator", { name: "Resize the document panel" })).toHaveAttribute("aria-valuenow", "384");
  const panel = page.getByRole("complementary", { name: "Document" });
  await panel.getByRole("button", { name: "Hide" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Wrong invoice address" })).toBeFocused();
  await page.getByRole("link", { name: "Wrong invoice address" }).click();
  await expect(page.getByRole("separator", { name: "Resize the document panel" })).toHaveAttribute("aria-valuenow", "384");
  expect(watched.problems).toEqual([]);
});

test("at phone width the document covers the list, and Back returns to it", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone width only");
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  await page.getByRole("link", { name: "Wrong invoice address" }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();
  await expect(panel.getByRole("button", { name: "Hide" })).toBeHidden();
  await checkScreen(page, info, "inspector-phone", watched);
  await panel.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Wrong invoice address" })).toBeFocused();
});

test("someone without access to a database is told so", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "ivy");
  await page.goto("/databases/no-such-database/documents");
  await expect(page.getByRole("heading", { name: "Database not found" })).toBeVisible();
  // The 404 that says so is logged by the browser; it's expected here.
  expect(watched.problems.filter((problem) => !/status of 404/.test(problem))).toEqual([]);
});
