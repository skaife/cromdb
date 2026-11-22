// People and Invitations, as Ada, the server admin. What a test changes is
// someone it invites itself, with an email named for its project, so the
// runs don't meet; the dev server's own people are only looked at. Frank
// and Gina are invited by the dev server and never log in.

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { checkScreen, logIn, openMenu, watch } from "./helpers.ts";

/** An email of the test's own, per project. */
function emailFor(info: TestInfo, name: string): string {
  return `${name}-${info.project.name}@example.com`;
}

async function openPage(page: Page, name: "People" | "Invitations") {
  await (await openMenu(page)).getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function invite(page: Page, email: string, serverAdmin = false) {
  await page.getByRole("textbox", { name: "Email to invite" }).fill(email);
  if (serverAdmin) await page.getByRole("checkbox", { name: "Server admin" }).check();
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Invited ${email}` })).toBeVisible();
}

test("People lists everyone, filtered by name or email and by status", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "People");
  const table = page.getByRole("table", { name: "People, in email order" });
  await expect(table.getByRole("row", { name: /ada@example\.com/ })).toContainText("Active");
  await expect(table.getByRole("row", { name: /frank@example\.com/ })).toContainText("No name yet");
  await checkScreen(page, info, "people", watched);
  await page.getByRole("combobox", { name: "Status" }).selectOption("Invited");
  await page.getByRole("searchbox", { name: "Filter by name or email" }).fill("gina");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row").nth(1)).toContainText("gina@example.com");
  await expect(table.getByRole("row").nth(1)).toContainText("Yes");
});

test("a person opens in the panel, and is made a server admin, disabled and enabled", async ({ page }, info) => {
  const watched = await watch(page);
  const email = emailFor(info, "panel");
  await logIn(page, "ada");
  await openPage(page, "Invitations");
  await invite(page, email);
  await openPage(page, "People");
  await page.getByRole("searchbox", { name: "Filter by name or email" }).fill(email);
  await page.getByRole("link", { name: `No name yet: ${email}` }).click();
  await page.waitForURL(/\/server\/people\/[^/]+$/);
  const panel = page.getByRole("complementary", { name: "Person" });
  await expect(panel.getByRole("heading", { level: 2, name: email })).toBeVisible();
  await expect(panel).toContainText("None yet: they haven't logged in.");
  await expect(panel).toContainText("Invited byyou");

  await panel.getByRole("button", { name: "Make server admin" }).click();
  const dialog = page.getByRole("alertdialog", { name: `Make ${email} a server admin?` });
  await checkScreen(page, info, "person-make-admin", watched);
  await dialog.getByRole("button", { name: "Make server admin" }).click();
  await expect(panel.getByText("Made a server admin.")).toBeVisible();
  await panel.getByRole("button", { name: "Remove server admin" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove server admin" }).click();
  await expect(panel.getByText("No longer a server admin.")).toBeVisible();

  await panel.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("alertdialog", { name: `Disable ${email}?` }).getByRole("button", { name: "Disable" }).click();
  await expect(panel.getByText("Disabled. Their sessions have ended.")).toBeVisible();
  await expect(panel).toContainText(/Disabled \w+ \d+ by you/);
  await checkScreen(page, info, "person-disabled", watched);
  await panel.getByRole("button", { name: "Enable" }).click();
  await expect(panel.getByText("Enabled.")).toBeVisible();
  // Never logged in: enabled means invited again.
  await expect(panel).toContainText(/StatusInvited/);
});

test("the last active server admin can't disable themselves", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "People");
  await page.getByRole("link", { name: "Ada Admin", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Person" });
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Ada Admin (you)");
  await checkScreen(page, info, "person", watched);
  await panel.getByRole("button", { name: "Disable" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Disable yourself?" });
  await expect(dialog).toContainText("This is you");
  await dialog.getByRole("button", { name: "Disable" }).click();
  await expect(panel.getByRole("alert")).toContainText(/server admin/);
  await expect(panel.getByRole("button", { name: "Disable" })).toBeVisible();
});

test("Invitations invites, refuses an email already there, and revokes", async ({ page }, info) => {
  const watched = await watch(page);
  const email = emailFor(info, "revoke");
  await logIn(page, "ada");
  await openPage(page, "Invitations");
  await page.getByRole("textbox", { name: "Email to invite" }).fill("not an email");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Give one email address, like name@example.com.")).toBeVisible();
  await checkScreen(page, info, "invitations-problem", watched);
  await invite(page, email, true);
  const table = page.getByRole("table", { name: "Invitations not yet used, in email order" });
  const row = table.getByRole("row", { name: new RegExp(email) });
  await expect(row).toContainText("Yes");
  await expect(row).toContainText("by you");
  await checkScreen(page, info, "invitations", watched);

  await page.getByRole("textbox", { name: "Email to invite" }).fill(email.toUpperCase());
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("alert")).toContainText("already invited");
  await expect(page.getByRole("alert").getByRole("link", { name: "Open them in People" })).toBeVisible();
  // The browser logs the 409 that refused it; it's expected here.
  watched.problems.splice(0);

  await row.getByRole("button", { name: `Revoke the invitation for ${email}` }).click();
  await checkScreen(page, info, "invitations-revoke", watched);
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Revoked the invitation for ${email}.` })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("server admins see the email of someone invited who hasn't logged in, not an ID", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await page.getByRole("button", { name: "New database" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(`Invited names (${info.project.name})`);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/databases\/[^/]+\/documents$/);
  await page.getByRole("navigation", { name: "Database" }).getByRole("link", { name: "Access" }).click();
  await page.getByLabel(/^Add person/).fill("frank");
  await page.getByRole("button", { name: /^Add frank@example\.com/ }).click();
  await expect(page.getByRole("table", { name: /who may do what/i }).getByRole("rowheader", { name: /frank@example\.com/ })).toBeVisible();
  await checkScreen(page, info, "access-invited", watched);
});
