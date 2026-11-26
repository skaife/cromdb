// The server pages: Settings, Status and Servers, as Ada, the server admin.
// The dev server is one for every test, so a test that saves settings puts
// them back before it ends, and none changes the server's name, which the
// sign-in screen shows. The dev server can't restart itself (nothing would
// start it again), so the settings page asks for a restart instead of
// offering Restart now.

import { expect, test, type Page } from "@playwright/test";
import { checkScreen, logIn, openMenu, watch } from "./helpers.ts";

async function openPage(page: Page, link: "Settings" | "Status" | "Servers", heading: string) {
  await (await openMenu(page)).getByRole("link", { name: link }).click();
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

const field = (page: Page, name: string) => page.getByRole("textbox", { name, exact: true });

async function saveSettings(page: Page) {
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Saved\./ })).toBeVisible();
}

test("Settings shows every group, with the restart ones tagged and the secret never shown", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  for (const group of ["General", "Network and HTTPS", "Login", "Sessions", "Maintenance"]) {
    await expect(page.getByRole("group", { name: group })).toBeVisible();
  }
  await expect(field(page, "Server name")).toHaveValue("dev-server");
  await expect(page.getByText("Public address restart")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Off (plain HTTP, trusted networks only)" })).toBeChecked();
  await expect(page.getByText("Set (never shown)")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Nightly maintenance at" })).toHaveValue("3");
  await expect(page.getByText(/^Last run: Today, /)).toBeVisible();
  await checkScreen(page, info, "server-settings", watched);
});

test("Settings saves a live setting at once and keeps a restart one for the next start", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  const clientId = field(page, "Client ID restart");
  const was = await clientId.inputValue();
  await field(page, "Longest session (days)").fill("8");
  await clientId.fill(`${was}-next`);
  await saveSettings(page);
  await expect(page.getByText(`Saved, waiting for a restart. Running now: ${was}.`)).toBeVisible();
  await expect(page.getByText(/restart the server to apply them/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart now" })).toHaveCount(0);
  await checkScreen(page, info, "server-settings-waiting", watched);
  await page.reload();
  await expect(field(page, "Longest session (days)")).toHaveValue("8");
  // Back as they were, for the other tests.
  await field(page, "Longest session (days)").fill("7");
  await clientId.fill(was);
  await saveSettings(page);
  await expect(page.getByText(/^Saved, waiting for a restart/)).toHaveCount(0);
});

test("Settings says what is wrong at the setting, from the page and from the server", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  await field(page, "Log out after idle (minutes)").fill("2");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Give a whole number from 5 to 43200.")).toBeVisible();
  await field(page, "Log out after idle (minutes)").fill("720");
  await field(page, "Time zone").fill("Mars/Base");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/maintenanceTimeZone must be an IANA time zone/)).toBeVisible();
  await expect(field(page, "Time zone")).toHaveAttribute("aria-invalid", "true");
  // The browser logs the 400 that refused it; it's expected here.
  watched.problems.splice(0);
  await checkScreen(page, info, "server-settings-problem", watched);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(field(page, "Time zone")).toHaveValue("");
});

test("Settings asks before saving a plain http address that leaves the machine", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  await field(page, "Public address restart").fill("http://cromdb.example.com");
  await page.getByRole("button", { name: "Save settings" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Use plain HTTP?" });
  await expect(dialog).toContainText("unencrypted");
  watched.problems.splice(0);
  await checkScreen(page, info, "server-settings-plain-http", watched);
  await dialog.getByRole("button", { name: "Go back" }).click();
  await page.getByRole("button", { name: "Discard changes" }).click();
});

test("Settings shows the certificate files when the server serves HTTPS itself", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  await page.getByRole("radio", { name: "Served by this server" }).check();
  await expect(field(page, "Certificate file restart")).toBeVisible();
  await expect(field(page, "Key file restart")).toBeVisible();
  await checkScreen(page, info, "server-settings-https", watched);
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(field(page, "Certificate file restart")).toHaveCount(0);
});

test("the client secret is only ever written: Replace opens a password field", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Settings", "Server settings");
  await page.getByRole("button", { name: "Replace the client secret" }).click();
  const secret = page.getByLabel("Client secret restart");
  await expect(secret).toHaveAttribute("type", "password");
  await checkScreen(page, info, "server-settings-secret", watched);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Set (never shown)")).toBeVisible();
});

test("Status shows the server, its databases and the last maintenance", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Status", "Server status");
  await expect(page.getByRole("region", { name: "Server", exact: true })).toContainText("dev-server");
  await expect(page.getByRole("region", { name: "Databases", exact: true })).toContainText(/\d+ available, 0 unavailable/);
  await expect(page.getByRole("region", { name: "Last maintenance", exact: true })).toContainText(/^Last maintenanceToday, /);
  const runs = page.getByRole("region", { name: "Maintenance by database", exact: true }).getByRole("row");
  await expect(runs.filter({ hasText: "the server database" })).toContainText("removed");
  await expect(runs.filter({ hasText: 'database "Sales tickets"' })).toBeVisible();
  await checkScreen(page, info, "server-status", watched);
});

test("Servers lists this server, and says what comes with syncing", async ({ page }, info) => {
  const watched = await watch(page);
  await logIn(page, "ada");
  await openPage(page, "Servers", "Servers");
  const row = page.getByRole("table", { name: "The servers in this deployment" }).getByRole("row").nth(1);
  await expect(row).toContainText("dev-server (this server)");
  await expect(row).toContainText("Running");
  await checkScreen(page, info, "servers", watched);
});

test("someone who isn't a server admin can't open the server pages", async ({ page }) => {
  const watched = await watch(page);
  await logIn(page, "bob", "/server/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Server admins only" })).toBeVisible();
  await page.goto("/server/status");
  await expect(page.getByRole("heading", { level: 1, name: "Server admins only" })).toBeVisible();
  expect(watched.problems).toEqual([]);
});
