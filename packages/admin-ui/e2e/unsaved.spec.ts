// Leaving a screen with unsaved edits asks first: the menu, a tab and the
// back button, on each screen that edits something. Nothing here is saved,
// so the dev server's samples are used as they are.

import { expect, test, type Page } from "@playwright/test";
import { checkScreen, logIn, openMenu, watch } from "./helpers.ts";

const ask = (page: Page) => page.getByRole("alertdialog", { name: "Leave without saving?" });

async function toDatabases(page: Page) {
  await (await openMenu(page)).getByRole("link", { name: "Databases" }).click();
}

async function openTab(page: Page, database: string, tab: "Access" | "Settings") {
  await page.getByRole("link", { name: database, exact: true }).click();
  await page.getByRole("navigation", { name: "Database" }).getByRole("link", { name: tab }).click();
  await expect(page.getByRole("heading", { level: 2, name: tab === "Settings" ? "Database settings" : tab })).toBeVisible();
}

test("a document's unsaved edits: the menu and the back button ask, Stay keeps them, Leave goes", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await page.getByRole("link", { name: "Sales tickets", exact: true }).click();
  await page.getByRole("link", { name: "Wrong invoice address", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Document" });
  const status = panel.getByRole("textbox", { name: "Value of status" });
  await status.fill("unsaved");

  await toDatabases(page);
  await expect(ask(page)).toContainText("Your changes to this document will be lost.");
  await expect(ask(page).getByRole("button", { name: "Stay" })).toBeFocused();
  await checkScreen(page, info, "leave-dialog", watched);
  await ask(page).getByRole("button", { name: "Stay" }).click();
  await expect(ask(page)).toHaveCount(0);
  await expect(status).toHaveValue("unsaved");

  const here = page.url();
  await page.goBack();
  await expect(ask(page)).toBeVisible();
  await ask(page).getByRole("button", { name: "Stay" }).click();
  expect(page.url()).toBe(here);
  await expect(status).toHaveValue("unsaved");

  await toDatabases(page);
  await ask(page).getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Databases" })).toBeVisible();
  expect(watched.problems).toEqual([]);
});

test("the Access tab's unsaved changes: another tab asks", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openTab(page, "Sales tickets", "Access");
  await page.locator("input[type=checkbox]:not(:checked):not(:disabled)").first().check();
  await page.getByRole("navigation", { name: "Database" }).getByRole("link", { name: "Replicas" }).click();
  await expect(ask(page)).toContainText("Your changes to the access lists will be lost.");
  await ask(page).getByRole("button", { name: "Stay" }).click();
  await expect(page.getByRole("button", { name: "Discard changes" })).toBeEnabled();
  await page.getByRole("navigation", { name: "Database" }).getByRole("link", { name: "Replicas" }).click();
  await ask(page).getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Replicas" })).toBeVisible();
  expect(watched.problems).toEqual([]);
});

test("the database settings' unsaved changes: the menu asks", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openTab(page, "Sales tickets", "Settings");
  const name = page.getByRole("textbox", { name: "Name" });
  await name.fill("Sales tickets, renamed");
  await toDatabases(page);
  await expect(ask(page)).toContainText("Your changes to the database settings will be lost.");
  await ask(page).getByRole("button", { name: "Stay" }).click();
  await expect(name).toHaveValue("Sales tickets, renamed");
  await toDatabases(page);
  await ask(page).getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("link", { name: "Sales tickets", exact: true })).toBeVisible();
  expect(watched.problems).toEqual([]);
});

test("the server settings' unsaved changes: the menu asks", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await (await openMenu(page)).getByRole("link", { name: "Settings" }).click();
  const days = page.getByRole("textbox", { name: "Longest session (days)", exact: true });
  await days.fill("9");
  await (await openMenu(page)).getByRole("link", { name: "Status" }).click();
  await expect(ask(page)).toContainText("Your changes to the server settings will be lost.");
  await ask(page).getByRole("button", { name: "Stay" }).click();
  await expect(days).toHaveValue("9");
  await (await openMenu(page)).getByRole("link", { name: "Status" }).click();
  await ask(page).getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Status" })).toBeVisible();
  expect(watched.problems).toEqual([]);
});
