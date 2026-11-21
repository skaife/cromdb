// What the browser tests share: logging in through the fake provider's page,
// and the checks every screen gets (accessibility, no sideways page scroll,
// no CSP violations or console errors), with a screenshot when asked.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const PEOPLE = {
  ada: "Ada Admin (ada@example.com)",
  ivy: "Ivy Invited (ivy@example.com)",
  ned: "Ned Newcomer (ned@example.com)",
} as const;

/** Records CSP violations and console errors from the start of every page load. */
export async function watch(page: Page): Promise<{ problems: string[] }> {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const list = ((window as unknown as { __csp?: string[] }).__csp ??= []);
      list.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on("console", (message) => {
    // A 401 from GET /api/v0/me is how the page learns nobody is logged in;
    // the browser logs every failed request as a console error.
    if (message.type() === "error" && !/status of 401/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  return { problems };
}

/** Logs in from the sign-in screen as one of the dev server's people. */
export async function logIn(page: Page, who: keyof typeof PEOPLE, path = "/databases"): Promise<void> {
  await page.goto(path);
  await page.getByRole("link", { name: "Log in" }).click();
  await page.getByRole("link", { name: PEOPLE[who] }).click();
  await page.waitForURL((url) => url.pathname === path);
  await page.getByRole("navigation", { name: "Main menu" }).waitFor();
}

/**
 * The checks every screen gets: no accessibility violation of serious or
 * critical impact under WCAG 2.1 A and AA; nothing wider than the window;
 * no CSP violation and no console error. Then a screenshot, if asked.
 */
export async function checkScreen(page: Page, info: TestInfo, name: string, watched: { problems: string[] }): Promise<void> {
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = axe.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(
    serious.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`),
    `${name}: accessibility`,
  ).toEqual([]);
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: document.documentElement.clientWidth }));
  expect(widths.page, `${name}: the page is wider than the window`).toBeLessThanOrEqual(widths.window);
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  expect(csp, `${name}: CSP violations`).toEqual([]);
  expect(watched.problems, `${name}: console`).toEqual([]);
  const folder = process.env["CROMDB_SCREENS"];
  if (folder !== undefined && folder !== "") {
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, `${info.project.name}-${name}.png`), fullPage: true });
  }
}

/** The main menu, opened first at phone width, where it is behind its Menu button. */
export async function openMenu(page: Page) {
  const menu = page.getByRole("navigation", { name: "Main menu" });
  const toggle = menu.getByRole("button", { name: "Menu" });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
  return menu;
}

/** The project's own name for things it makes, so desktop and phone runs don't collide. */
export function unique(info: TestInfo, name: string): string {
  return `${name} (${info.project.name})`;
}
