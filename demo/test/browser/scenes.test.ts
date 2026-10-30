// The page in a real browser: both scenes played by clicking, as the
// captions describe them, against three real replica processes. Run with
// npm run test:browser in demo/ (it builds the page first).
//
// Set CROMDB_DEMO_SCREENS to a directory to save a screenshot at each
// caption step there, plus two of the page without captions.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { startDemo, type Demo } from "../helpers.ts";

const captions = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "captions.json"), "utf8")) as {
  scene: string;
  text: string;
}[];
const screens = process.env.CROMDB_DEMO_SCREENS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let demo: Demo;
let browser: Browser;

before(async () => {
  demo = await startDemo({ page: true });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await demo?.stop();
});

async function openPage(query = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${demo.pagePort}/${query}`);
  return page;
}

function screenshot(page: Page, name: string): Promise<unknown> | undefined {
  if (screens === undefined) {
    return undefined;
  }
  mkdirSync(screens, { recursive: true });
  return page.screenshot({ path: join(screens, `${name}.png`) });
}

const pane = (page: Page, name: string): Locator => page.getByRole("region", { name: `Replica ${name}` });
const card = (page: Page, name: string, title: string): Locator => pane(page, name).getByRole("listitem", { name: title });

async function shows(locator: Locator, text: string): Promise<void> {
  await locator.getByText(text, { exact: true }).first().waitFor();
}

async function lacks(locator: Locator, text: string): Promise<void> {
  await locator.getByText(text, { exact: true }).first().waitFor({ state: "detached" });
}

async function createNote(page: Page, name: string, title: string, text: string): Promise<void> {
  const p = pane(page, name);
  await p.getByRole("button", { name: "New note" }).click();
  await p.getByLabel("Title").fill(title);
  await p.getByLabel("Text").fill(text);
  await p.getByRole("button", { name: "Add note" }).click();
  await shows(card(page, name, title), text);
}

async function editNote(page: Page, name: string, title: string, text: string): Promise<void> {
  const c = card(page, name, title);
  await c.getByRole("button", { name: "Edit" }).click();
  await c.getByLabel("Text").fill(text);
  await c.getByRole("button", { name: "Save" }).click();
  // The editor's own textarea holds the text too, so wait for it to close.
  await c.getByRole("button", { name: "Save" }).waitFor({ state: "detached" });
  await shows(c.locator(".note-text"), text);
}

/** Clicks a link's Sync button and waits for its result. Returns the result text. */
async function sync(page: Page, link: string): Promise<string> {
  const button = page.getByRole("button", { name: `Sync ${link}` });
  const status = page.locator(".link-control", { has: button }).getByRole("status");
  await button.click();
  await status.getByText("Syncing...").waitFor();
  await status.getByText("Syncing...").waitFor({ state: "detached" });
  return (await status.textContent()) ?? "";
}

async function setOnline(page: Page, name: string, online: boolean): Promise<void> {
  const toggle = pane(page, name).getByRole("switch", { name: "Online" });
  await toggle.click();
  await page.waitForFunction(
    ([element, value]) => (element as Element).getAttribute("aria-checked") === value,
    [await toggle.elementHandle(), String(online)] as const,
  );
}

const activity = (page: Page): Locator => page.getByRole("log", { name: "Activity" });

/** Waits for an activity log entry with exactly this text (without its time). */
async function logged(page: Page, text: string | RegExp): Promise<void> {
  const entries = activity(page).locator(".entry-text");
  await (typeof text === "string" ? entries.getByText(text, { exact: true }) : entries.filter({ hasText: text })).first().waitFor();
}

async function notLogged(page: Page, text: RegExp): Promise<void> {
  assert.equal(await activity(page).locator(".entry-text").filter({ hasText: text }).count(), 0);
}

async function metaOf(page: Page, name: string, title: string): Promise<string> {
  return (await card(page, name, title).locator(".note-meta").textContent()) ?? "";
}

/** Checks the caption shown is step index, saves a screenshot if asked, then moves on with Next. */
async function step(page: Page, index: number, extra?: string): Promise<void> {
  const caption = captions[index];
  assert.ok(caption !== undefined);
  assert.equal(await page.getByTestId("caption").textContent(), caption.text);
  await screenshot(page, `step-${String(index + 1).padStart(2, "0")}${extra === undefined ? "" : `-${extra}`}`);
  if (extra === undefined && index < captions.length - 1) {
    await page.getByRole("button", { name: "Next" }).click();
  }
}

describe("the page", () => {
  it("shows the caption bar only with ?captions", async () => {
    for (const query of ["", "?caption", "?other=captions"]) {
      const page = await openPage(query);
      await shows(pane(page, "A"), "Signed in as Alice Anderson (demo)");
      await activity(page).waitFor();
      assert.equal(await page.getByTestId("caption").count(), 0, query);
      assert.equal(await page.getByRole("button", { name: "Next" }).count(), 0, query);
      await page.close();
    }
    for (const query of ["?captions", "?captions=1"]) {
      const page = await openPage(query);
      assert.equal(await page.getByTestId("caption").textContent(), captions[0]?.text);
      await page.close();
    }
  });

  it("plays both scenes, step by step", async () => {
    const page = await openPage("?captions");
    // The same page without captions, open alongside. Its log shows only what
    // it sees by polling: the clicks are on the other page.
    const plainPage = await openPage();

    // 1. Three replicas: separate processes, ports and files.
    for (const name of ["A", "B", "C"] as const) {
      const p = pane(page, name);
      await shows(p, `port ${(await demo.call(name, "GET", "/api/info")).body.port} · pid ${demo.pids[name]} · ${name.toLowerCase()}.db`);
    }
    await shows(pane(page, "A"), "Signed in as Alice Anderson (demo)");
    await shows(pane(page, "B"), "Signed in as Bob Baker (demo)");
    await shows(pane(page, "C"), "Signed in as Carol Carter (demo)");
    await step(page, 0);

    // 2. Alice creates a note on A.
    await createNote(page, "A", "Picnic", "Sandwiches.");
    assert.match(await metaOf(page, "A", "Picnic"), /last edited by Alice Anderson on A, \d\d:\d\d:\d\d/);
    await lacks(pane(page, "B"), "Picnic");
    await step(page, 1);

    // 3. B syncs with A. The note arrives on B.
    const button = page.getByRole("button", { name: "Sync A and B" });
    const answered = page.waitForResponse((response) => response.url().endsWith("/api/sync"));
    await button.click();
    await page.locator(".link-control", { has: button }).getByText("Syncing...").waitFor();
    // The sync has answered, but its result shows only once the dot has
    // travelled: logged then, not before.
    await answered;
    await sleep(200);
    assert.equal(await page.locator(".link-control", { has: button }).getByText("Syncing...").count(), 1);
    await notLogged(page, /synced/);
    await step(page, 2, "syncing");
    await page.locator(".link-control", { has: button }).getByText("Syncing...").waitFor({ state: "detached" });
    await shows(card(page, "B", "Picnic"), "Sandwiches.");
    assert.match(await metaOf(page, "B", "Picnic"), /by Alice Anderson on A,/);
    await logged(page, "Alice Anderson created Picnic on A.");
    await logged(page, "B and A synced: B got 1 change, A got 0.");
    await step(page, 2);

    // 4. Bob edits it on B.
    await editNote(page, "B", "Picnic", "Sandwiches. Lemonade.");
    assert.match(await metaOf(page, "B", "Picnic"), /by Bob Baker on B,/);
    await step(page, 3);

    // 5. C syncs with B. Bob's edit arrives on C.
    assert.match(await sync(page, "B and C"), /got 1 change/);
    await shows(card(page, "C", "Picnic"), "Sandwiches. Lemonade.");
    assert.match(await metaOf(page, "C", "Picnic"), /by Bob Baker on B,/);
    await step(page, 4);

    // 6. Carol edits it on C.
    await editNote(page, "C", "Picnic", "Sandwiches. Lemonade. A blanket.");
    assert.match(await metaOf(page, "C", "Picnic"), /by Carol Carter on C,/);
    await step(page, 5);

    // 7. A syncs with C, then B syncs with C. All three have Carol's
    // version, with no conflict.
    await sync(page, "A and C");
    await shows(card(page, "A", "Picnic"), "Sandwiches. Lemonade. A blanket.");
    await sync(page, "B and C");
    for (const name of ["A", "B", "C"]) {
      await shows(card(page, name, "Picnic"), "Sandwiches. Lemonade. A blanket.");
      assert.match(await metaOf(page, name, "Picnic"), /last edited by Carol Carter on C,/);
    }
    await page.getByText("In conflict", { exact: true }).waitFor({ state: "detached" });
    await step(page, 6);

    // 8. Alice creates a second note. B and C sync with A.
    await createNote(page, "A", "Meeting", "Tuesday.");
    await sync(page, "A and B");
    await sync(page, "A and C");
    for (const name of ["A", "B", "C"]) {
      await shows(card(page, name, "Meeting"), "Tuesday.");
    }
    await step(page, 7);

    // 9. B and C go offline.
    await setOnline(page, "B", false);
    await setOnline(page, "C", false);
    await pane(page, "B").locator(".offline-badge").waitFor();
    await pane(page, "C").locator(".offline-badge").waitFor();
    await step(page, 8);

    // 10. Bob and Carol both edit the note.
    await editNote(page, "B", "Meeting", "Tuesday at 10.");
    await editNote(page, "C", "Meeting", "Wednesday.");
    await step(page, 9);

    // 11. B comes back and syncs with A. No conflict yet.
    await setOnline(page, "B", true);
    await sync(page, "A and B");
    await shows(card(page, "A", "Meeting"), "Tuesday at 10.");
    await lacks(pane(page, "A"), "In conflict");
    await step(page, 10);

    // 12. C comes back and syncs with A. A and C detect the conflict.
    await setOnline(page, "C", true);
    await sync(page, "A and C");
    await shows(card(page, "A", "Meeting"), "In conflict");
    await shows(card(page, "C", "Meeting"), "In conflict");
    await lacks(pane(page, "B"), "In conflict");
    const between = "between (Bob Baker on B and Carol Carter on C|Carol Carter on C and Bob Baker on B)";
    await logged(page, new RegExp(`^Conflict on A: Meeting, ${between}\\.$`));
    await logged(page, new RegExp(`^Conflict on C: Meeting, ${between}\\.$`));
    await notLogged(page, /^Conflict on B/);
    await step(page, 11);

    // 13. B syncs again. All three show the same conflict and the same version.
    await sync(page, "A and B");
    const texts = [];
    for (const name of ["A", "B", "C"]) {
      await shows(card(page, name, "Meeting"), "In conflict");
      texts.push(await card(page, name, "Meeting").locator(".note-text").textContent());
    }
    assert.equal(new Set(texts).size, 1);
    assert.ok(["Tuesday at 10.", "Wednesday."].includes(texts[0] ?? ""));
    await lacks(card(page, "A", "Picnic"), "In conflict");
    await logged(page, new RegExp(`^Conflict on B: Meeting, ${between}\\.$`));
    await logged(plainPage, new RegExp(`^Conflict on B: Meeting, ${between}\\.$`));
    await screenshot(plainPage, "step-13-no-captions");
    await step(page, 12);

    // 14. Alice resolves it on A.
    await card(page, "A", "Meeting").getByRole("button", { name: "Resolve" }).click();
    const dialog = page.getByRole("dialog");
    await shows(dialog, "Primary: shown everywhere until resolved");
    await shows(dialog, "Tuesday at 10.");
    await shows(dialog, "Wednesday.");
    await dialog.getByRole("region", { name: "Version by Bob Baker" }).getByText("on B").waitFor();
    await dialog.getByRole("region", { name: "Version by Carol Carter" }).getByText("on C").waitFor();
    await dialog.getByRole("button", { name: "Write a new version" }).click();
    await dialog.getByLabel("Text").fill("Wednesday at 10.");
    await step(page, 13, "dialog");
    await dialog.getByRole("button", { name: "Save new version" }).click();
    await dialog.waitFor({ state: "detached" });
    await shows(card(page, "A", "Meeting"), "Wednesday at 10.");
    await lacks(pane(page, "A"), "In conflict");
    await logged(page, "Alice Anderson resolved Meeting on A, with a new version.");
    await step(page, 13);

    // 15. B and C sync. All three agree again.
    await sync(page, "A and B");
    await sync(page, "A and C");
    for (const name of ["A", "B", "C"]) {
      await shows(card(page, name, "Meeting"), "Wednesday at 10.");
      assert.match(await metaOf(page, name, "Meeting"), /by Alice Anderson on A,/);
    }
    await page.getByText("In conflict", { exact: true }).waitFor({ state: "detached" });
    await logged(page, "Conflict on B is gone: Meeting.");
    await logged(page, "Conflict on C is gone: Meeting.");
    await logged(plainPage, "Conflict on C is gone: Meeting.");
    await screenshot(plainPage, "step-15-no-captions");
    await step(page, 14);

    // The closing caption.
    await step(page, 15);
    await page.close();
    await plainPage.close();
  });

  it("refuses a save based on an old version, and reloads it", async () => {
    const page = await openPage();
    const created = await demo.call("B", "POST", "/api/notes", { title: "Stale", text: "One." });
    const c = card(page, "B", "Stale");
    await c.getByRole("button", { name: "Edit" }).click();
    // Someone else saves the note meanwhile.
    const { note } = created.body;
    await demo.call("B", "PUT", `/api/notes/${note.id}`, { title: "Stale", text: "Two.", vectorClock: note.vectorClock });
    await c.getByLabel("Text").fill("Three.");
    await c.getByRole("button", { name: "Save" }).click();
    await shows(c, "This note changed since you opened it.");
    await logged(page, "Bob Baker's save of Stale on B was refused: it changed since it was opened.");
    await c.getByRole("button", { name: "Reload" }).click();
    assert.equal(await c.getByLabel("Text").inputValue(), "Two.");
    await page.close();
  });

  it("greys out a replica that isn't running, until it is back", async () => {
    const page = await openPage();
    await shows(pane(page, "C"), "Signed in as Carol Carter (demo)");
    await setOnline(page, "C", false);
    await logged(page, "C went offline.");
    assert.match(await sync(page, "A and C"), /C is offline/);
    await logged(page, "Sync A and C failed: C is offline.");
    await setOnline(page, "C", true);
    await logged(page, "C is back online.");
    await demo.kill("C");
    await shows(pane(page, "C"), "Replica C is not running");
    await logged(page, "C is not running.");
    assert.match(await sync(page, "A and C"), /C is not running/);
    assert.match(await sync(page, "B and C"), /C is not running/);
    await logged(page, "Sync B and C failed: C is not running.");
    await demo.restart("C");
    await shows(pane(page, "C"), "Signed in as Carol Carter (demo)");
    await lacks(pane(page, "C"), "Replica C is not running");
    await logged(page, "C is running again.");
    assert.match(await sync(page, "A and C"), /got/);
    await page.close();
  });
});
