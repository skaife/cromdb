// The sign-in screen, the frame (menu, header, logging out), the Databases
// list with New database, and a session that ends under the page.

import { expect, test } from "@playwright/test";
import { checkScreen, logIn, openMenu, unique, watch } from "./helpers.ts";

const isPhone = (name: string) => name.endsWith("-phone");

test("the sign-in screen names the server and comes back to the page asked for", async ({ page }, info) => {
  const watched = await watch(page);
  await page.goto("/server/status");
  await expect(page.getByRole("heading", { name: "dev-server" })).toBeVisible();
  await expect(page).toHaveTitle("dev-server: log in");
  await checkScreen(page, info, "sign-in", watched);
  await page.getByRole("link", { name: "Log in" }).click();
  await page.getByRole("link", { name: "Ada Admin (ada@example.com)" }).click();
  await page.waitForURL("**/server/status");
  await expect(page.getByRole("heading", { name: "Server status" })).toBeVisible();
});

test("a server admin sees the whole menu, makes a database and finds it listed", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await expect(page.getByRole("heading", { name: "Databases" })).toBeVisible();
  await expect(page.getByText("Ada Admin")).toBeVisible();
  await expect(page.getByText("(server admin)")).toBeVisible();
  if (isPhone(info.project.name)) {
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: "Databases" })).toBeHidden();
  }
  const menu = await openMenu(page);
  await expect(menu.getByRole("link")).toHaveText(["Databases", "People", "Invitations", "Servers", "Settings", "Status"]);
  if (isPhone(info.project.name)) {
    await checkScreen(page, info, "menu-open", watched);
    await menu.getByRole("button", { name: "Menu" }).click();
  }

  const name = unique(info, "Sales tickets");
  await page.getByRole("button", { name: "New database" }).click();
  const field = page.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Give the database a name.")).toBeVisible();
  await checkScreen(page, info, "new-database", watched);
  await field.fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/databases\/[^/]+\/documents$/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await (await openMenu(page)).getByRole("link", { name: "Databases" }).click();
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
  await expect(row).toContainText("adminreadwritecreate");
  await expect(row).toContainText("by you");
  await checkScreen(page, info, "databases", watched);
});

test("someone who isn't a server admin sees no server menu and can't make databases", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ivy");
  await expect(page.getByText("You can't see any databases yet. A database admin can give you access.")).toBeVisible();
  await expect(page.getByRole("button", { name: "New database" })).toHaveCount(0);
  await expect(page.getByText("(server admin)")).toHaveCount(0);
  await checkScreen(page, info, "databases-empty", watched);
  await page.goto("/server/settings");
  await expect(page.getByRole("heading", { name: "Server admins only" })).toBeVisible();
  const menu = await openMenu(page);
  await expect(menu.getByRole("link")).toHaveText(["Databases"]);
  await checkScreen(page, info, "server-admins-only", watched);
});

test("a session that ends under the page shows the dialog, and logging in comes back", async ({ page, context }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada", "/server/status");
  await context.clearCookies();
  await (await openMenu(page)).getByRole("link", { name: "Databases" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Your session ended" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Log in again" })).toBeFocused();
  // Tab stays in the dialog: the page under it is inert.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("link", { name: "Log in again" })).toBeFocused();
  // The 401 that ended it is logged by the browser; it's expected here.
  watched.problems.splice(0);
  await checkScreen(page, info, "session-ended", watched);
  await dialog.getByRole("link", { name: "Log in again" }).click();
  await page.getByRole("link", { name: "Ada Admin (ada@example.com)" }).click();
  await page.waitForURL("**/databases");
  await expect(page.getByRole("heading", { name: "Databases" })).toBeVisible();
});

test("keyboard: skip to content, then the menu in order", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "the menu is behind its button at phone width");
  const watched = await watch(page);
  await logIn(page, "ada");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Databases" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "People" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
  expect(watched.problems).toEqual([]);
});

test("logging out ends the session and shows the sign-in screen", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "ivy");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  const me = await page.request.get("/api/v0/me");
  expect(me.status()).toBe(401);
  expect(watched.problems).toEqual([]);
});

test("an unknown address says so", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await checkScreen(page, info, "not-found", watched);
});
