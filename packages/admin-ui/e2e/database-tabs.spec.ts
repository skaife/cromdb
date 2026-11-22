// The database tabs: Access, Replicas and Settings, and the databases list's
// counts. What a test changes is on a database it makes itself, named for
// its project, so the runs don't meet; the dev server's "Team access" and
// "Conflicts" databases are only looked at.

import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { checkScreen, logIn, openMenu, unique, watch } from "./helpers.ts";

/** Makes a database as Ada, from the list, and opens it on its Documents tab. */
async function newDatabase(page: Page, info: TestInfo, name: string): Promise<string> {
  const full = unique(info, name);
  await page.getByRole("button", { name: "New database" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(full);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/databases\/[^/]+\/documents$/);
  await expect(page.getByRole("heading", { name: full, level: 1 })).toBeVisible();
  return full;
}

/** Logs Bob, Ivy and Ned in once, in their own browsers: until someone logs in, the server knows no name for them. */
async function namesKnown(browser: Browser) {
  for (const who of ["bob", "ivy", "ned"] as const) {
    const context = await browser.newContext();
    await logIn(await context.newPage(), who);
    await context.close();
  }
}

async function openTab(page: Page, tab: "Documents" | "Access" | "Replicas" | "Settings") {
  await page.getByRole("navigation", { name: "Database" }).getByRole("link", { name: tab }).click();
  await expect(page.getByRole("heading", { level: 2, name: tab === "Settings" ? "Database settings" : tab })).toBeVisible();
}

async function openDatabase(page: Page, name: string) {
  await (await openMenu(page)).getByRole("link", { name: "Databases" }).click();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("the list counts each database's replicas and the conflicts you can read", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Sales tickets", exact: true }) });
  // One copy made for its sample conflict; the chairs conflict is never resolved by the tests.
  await expect(row.getByRole("cell").nth(2)).toHaveText("2");
  const link = row.getByRole("link", { name: "1 document in conflict: show them" });
  await expect(link).toBeVisible();
  const paging = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Paging", exact: true }) });
  await expect(paging.getByRole("cell").nth(2)).toHaveText("1");
  await expect(paging.getByRole("cell").nth(3)).toHaveText("0");
  await checkScreen(page, info, "databases-counts", watched);
  await link.click();
  await page.waitForURL(/\/documents\?conflict=1$/);
  await expect(page.getByRole("link", { name: "Quote for 40 chairs", exact: true })).toBeVisible();
});

test("Access shows who may do what, with its warnings", async ({ page, browser }, info) => {
  await namesKnown(browser);
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Team access");
  await openTab(page, "Access");
  const table = page.getByRole("table", { name: /who may do what/i });
  await expect(table.getByRole("rowheader")).toHaveText([/^The server/, "Ada Admin (you)", "Ned Newcomer", "Bob Baker"]);
  await expect(page.getByRole("checkbox", { name: "Admin: The server" })).toBeDisabled();
  await expect(table.getByRole("row", { name: /^Bob Baker/ })).toContainText("Writer without reader: can't edit anything");
  await expect(table.getByRole("row", { name: /^Ned Newcomer/ })).toContainText("Locked out.");
  await checkScreen(page, info, "access", watched);
});

test("Access is changed and saved, and you can't take away your own admin", async ({ page, browser }, info) => {
  await namesKnown(browser);
  const watched = await watch(page);
  await logIn(page, "ada");
  await newDatabase(page, info, "Access test");
  await openTab(page, "Access");
  await page.getByLabel(/^Add person/).fill("Bob");
  await page.getByRole("button", { name: "Add Bob Baker (bob@example.com)" }).click();
  await expect(page.getByRole("checkbox", { name: "Reader: Bob Baker" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Writer: Bob Baker" }).check();
  await page.getByRole("checkbox", { name: "Admin: Ada Admin (you)" }).uncheck();
  await expect(page.getByRole("alert")).toContainText("can't remove yourself from the admins");
  await expect(page.getByRole("button", { name: "Save access" })).toBeDisabled();
  await checkScreen(page, info, "access-self", watched);
  await page.getByRole("checkbox", { name: "Admin: Ada Admin (you)" }).check();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
  await checkScreen(page, info, "access-saved", watched);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Writer: Bob Baker" })).toBeChecked();
});

test("Replicas lists every copy this server's copy knows of", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openDatabase(page, "Sales tickets");
  await openTab(page, "Replicas");
  const table = page.getByRole("table", { name: "The replicas" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("rowheader").first()).toContainText("(this copy)");
  await expect(table.getByRole("rowheader").first()).toContainText("Active");
  await expect(table.getByRole("row").nth(2).getByRole("cell").first()).toHaveText("Yes");
  await checkScreen(page, info, "replicas", watched);
});

test("Settings renames the database and sets the purge days; others see them read-only", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  const name = await newDatabase(page, info, "Settings test");
  await openTab(page, "Settings");
  const nameBox = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(nameBox).toHaveValue(name);
  await expect(page.getByText("Level")).toBeVisible();
  await page.getByLabel("Purge deletions after (days)").fill("0");
  await expect(page.getByText("Give a whole number of days, from 1 to 3650.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await checkScreen(page, info, "settings-problem", watched);
  await page.getByLabel("Purge deletions after (days)").fill("14");
  await nameBox.fill(`${name} renamed`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${name} renamed`);
  await checkScreen(page, info, "settings", watched);
  await page.reload();
  await expect(page.getByLabel("Purge deletions after (days)")).toHaveValue("14");
  await expect(nameBox).toHaveValue(`${name} renamed`);
});

test("someone who doesn't admin a database sees its settings read-only and no Access tab", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "bob");
  await openDatabase(page, "Team access");
  await expect(page.getByRole("navigation", { name: "Database" }).getByRole("link")).toHaveText(["Documents", "Replicas", "Settings"]);
  await openTab(page, "Settings");
  await expect(page.getByText("Only the database's admins can change these.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await checkScreen(page, info, "settings-read-only", watched);
});
