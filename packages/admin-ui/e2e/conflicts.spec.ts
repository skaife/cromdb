// Resolving conflicts, on the dev server's "Conflicts" database: twelve
// documents with two versions each, three for each browser and width (so the
// runs don't meet), one with three versions, and one with a version only Ned
// can read.

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { checkScreen, logIn, watch } from "./helpers.ts";

const PROJECTS = ["chromium-desktop", "chromium-phone", "firefox-desktop", "firefox-phone"];
const isPhone = (info: TestInfo) => info.project.name.endsWith("-phone");

/** This project's own conflicted documents: "Conflict 01" to "Conflict 12", three each. */
function mine(info: TestInfo, which: 0 | 1 | 2): string {
  const index = PROJECTS.indexOf(info.project.name);
  if (index < 0) throw new Error(`No conflicts set aside for ${info.project.name}`);
  return `Conflict ${String(index * 3 + which + 1).padStart(2, "0")}`;
}

async function openConflict(page: Page, title: string) {
  await page.getByRole("link", { name: "Conflicts", exact: true }).click();
  await page.waitForURL(/\/documents$/);
  await page.getByRole("link", { name: title, exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  await expect(panel.getByRole("heading", { name: "Conflict" })).toBeVisible();
  await expect(panel.getByRole("table", { name: "The versions, side by side" })).toBeVisible();
  return panel;
}

/** The API path of the document open in the panel. */
function apiPath(page: Page): string {
  return new URL(page.url()).pathname.replace("/databases/", "/api/v0/databases/");
}

test("the versions side by side, and keeping one after asking", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  const panel = await openConflict(page, mine(info, 0));
  const table = panel.getByRole("table", { name: "The versions, side by side" });
  if (isPhone(info)) {
    await expect(table.getByRole("columnheader")).toHaveText(["Field", "Version 1 (shown now)"]);
    await panel.getByRole("button", { name: "Next version" }).click();
    await expect(table.getByRole("columnheader")).toHaveText(["Field", "Version 2"]);
    await expect(panel.getByText("2 of 2")).toBeVisible();
  } else {
    await expect(table.getByRole("columnheader")).toHaveText(["Field", "Version 1 (shown now)", "Version 2"]);
  }
  const colour = table.getByRole("row", { name: /^colour differs/ });
  await expect(colour).toBeVisible();
  // Version 2's colour, to find after keeping it (the rank decides which is version 1).
  const kept = isPhone(info) ? await colour.getByRole("cell").first().textContent() : await colour.getByRole("cell").nth(1).textContent();
  await expect(table.getByRole("row", { name: /^title / })).not.toContainText("differs");
  await checkScreen(page, info, "conflict", watched);

  const path = apiPath(page);
  await panel.getByRole("button", { name: "Keep version 2" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Keep version 2?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await checkScreen(page, info, "keep-confirm", watched);
  await dialog.getByRole("button", { name: "Keep version 2" }).click();
  await expect(panel.getByText("Resolved.")).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Document" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Value of colour" })).toHaveValue(kept ?? "");
  await checkScreen(page, info, "resolved", watched);
  // The server agrees: no conflict left.
  expect((await page.request.get(`${path}/conflict`)).status()).toBe(404);
  // The 404 just asked for is logged by the browser; it's expected here.
  watched.problems.splice(0);
});

test("resolving with new content, starting from the version shown now", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  const panel = await openConflict(page, mine(info, 1));
  const path = apiPath(page);
  const shownNow = await panel.getByRole("table").getByRole("row", { name: /^colour differs/ }).getByRole("cell").first().textContent();
  await panel.getByRole("button", { name: "Save new content…" }).click();
  await expect(panel.getByRole("textbox", { name: "Value of colour" })).toHaveValue(shownNow ?? "");
  await panel.getByRole("textbox", { name: "Value of colour" }).fill("purple");
  await checkScreen(page, info, "new-content", watched);
  await panel.getByRole("button", { name: "Save as the resolution" }).click();
  await expect(panel.getByText("Resolved.")).toBeVisible();
  const stored = await (await page.request.get(path)).json();
  expect(stored.content.colour).toBe("purple");
  expect(stored.inConflict).toBe(false);
});

test("resolving by deleting the document, after asking", async ({ page }, info) => {
  await watch(page);
  await logIn(page, "ada");
  const title = mine(info, 2);
  const panel = await openConflict(page, title);
  const path = apiPath(page);
  await panel.getByRole("button", { name: "Delete the document" }).click();
  await page.getByRole("alertdialog", { name: "Delete this document?" }).getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);
  expect((await page.request.get(path)).status()).toBe(404);
});

test("three versions, one of which deletes the document", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  const panel = await openConflict(page, "Three versions");
  const table = panel.getByRole("table", { name: "The versions, side by side" });
  await expect(table.getByRole("row", { name: /^Deleted differs/ })).toContainText(isPhone(info) ? "no" : "This version deletes the document");
  await expect(table.getByRole("row", { name: /^where differs/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /^step / })).not.toContainText("differs");
  if (!isPhone(info)) {
    await expect(table.getByRole("columnheader")).toHaveText(["Field", "Version 1 (shown now)", "Version 2", "Version 3"]);
    await expect(panel.getByText("To keep this one, delete the document below.")).toBeVisible();
  } else {
    await expect(panel.getByText("1 of 3")).toBeVisible();
  }
  await checkScreen(page, info, "three-versions", watched);
});

test("a version the person can't read stays in conflict after a resolve, and they are told", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await page.getByRole("link", { name: "Conflicts", exact: true }).click();
  await page.getByRole("link", { name: "A version you can't read" }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  await expect(panel.getByRole("heading", { name: "Conflict" })).toBeVisible();
  // The first browser to get here resolves Ada's two versions; Ned's, which
  // she can't read, stays. After that, every run finds only Ned's left.
  const onlyOne = panel.getByText("only one of its versions is one you can read");
  const keep = panel.getByRole("button", { name: "Keep version 1" });
  await expect(onlyOne.or(keep)).toBeVisible();
  if (await keep.isVisible()) {
    await expect(panel.getByText("This document has 2 versions you can read")).toBeVisible();
    await keep.click();
    await page.getByRole("alertdialog", { name: "Keep version 1?" }).getByRole("button", { name: "Keep version 1" }).click();
    await expect(
      panel.getByText("Resolved the versions you can read. Other versions, which you can't read, are still in conflict; someone who can read them must resolve those."),
    ).toBeVisible();
  }
  await expect(onlyOne).toBeVisible();
  await checkScreen(page, info, "unreadable-left", watched);
});
