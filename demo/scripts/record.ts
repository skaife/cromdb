// Records both scenes for the README: the page with captions, played by
// clicking at a human pace against three real replica processes, on the
// default ports. Run with npm run record in demo/ (it builds the page
// first). Not part of the tests.
//
// Usage: node scripts/record.ts [--out <directory>]   (default: demo/recording)
//
// Writes demo.webm (Playwright's recording), and made from it with ffmpeg:
// scene-1.gif (steps 1 to 7) and scene-2.gif (step 8 to the closing caption),
// demo.mp4 (both scenes), and a PNG frame from the GIFs at a few moments, for
// checking the result.
// The pointer is drawn by this script, since the recording has none.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Locator, type Page } from "playwright";
import { DEFAULT_PAGE_PORT, DEFAULT_PORTS, REPLICA_NAMES } from "../server/identities.ts";
import { startDemo } from "../test/helpers.ts";

const demoDir = join(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string", default: join(demoDir, "recording") } } });
const outDir = resolve(values.out);

const WIDTH = 1280;
const HEIGHT = 800;
const GIF_FPS = 12;
const TYPING_MS = 60;
/** After clicking Next, before the step's action. */
const BEFORE_ACTION_MS = 1500;
/** Between two actions in one step. */
const BETWEEN_ACTIONS_MS = 1000;

const captions = JSON.parse(readFileSync(join(demoDir, "web", "src", "captions.json"), "utf8")) as { text: string }[];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  fail("ffmpeg is needed to make the GIF and MP4. On Ubuntu: sudo apt install ffmpeg");
}
for (const port of [DEFAULT_PAGE_PORT, ...REPLICA_NAMES.map((name) => DEFAULT_PORTS[name])]) {
  if (!(await portFree(port))) {
    fail(`Port ${port} is in use (is npm run demo running?). The recording needs ports 4000 to 4003.`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long enough to read a caption. */
const readingMs = (text: string) => Math.min(2500 + 50 * text.length, 6000);

// Draws the pointer where the mouse is, with a ripple on each click. Runs in
// the page.
function drawPointer(): void {
  const install = () => {
    const pointer = document.createElement("div");
    pointer.innerHTML =
      '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25 L14.5 23.5 L11 16 L18 16 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    Object.assign(pointer.style, {
      position: "fixed",
      left: "-2px",
      top: "-2px",
      zIndex: "2147483647",
      pointerEvents: "none",
      display: "none",
    });
    document.body.append(pointer);
    document.addEventListener(
      "mousemove",
      (event) => {
        pointer.style.display = "block";
        pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        const ripple = document.createElement("div");
        Object.assign(ripple.style, {
          position: "fixed",
          left: `${event.clientX - 18}px`,
          top: `${event.clientY - 18}px`,
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          border: "3px solid rgba(29, 36, 48, 0.55)",
          boxSizing: "border-box",
          zIndex: "2147483646",
          pointerEvents: "none",
        });
        document.body.append(ripple);
        ripple
          .animate([{ transform: "scale(0.3)", opacity: 1 }, { transform: "scale(1)", opacity: 0 }], { duration: 450, easing: "ease-out" })
          .finished.then(() => ripple.remove());
      },
      true,
    );
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
}

mkdirSync(outDir, { recursive: true });
const demo = await startDemo({ page: true, defaultPorts: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  recordVideo: { dir: outDir, size: { width: WIDTH, height: HEIGHT } },
});
await context.addInitScript(drawPointer);
const page = await context.newPage();
// The recording starts with the page.
const recordingStart = performance.now();
page.setDefaultTimeout(15_000);

/** Moments in the recording, in seconds from its start. */
const marks = new Map<string, number>();
const mark = (name: string, delayMs = 0) => marks.set(name, (performance.now() - recordingStart + delayMs) / 1000);

let mouse = { x: WIDTH / 2, y: HEIGHT / 2 };

/** Moves the pointer smoothly to the middle of the element. */
async function moveTo(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error(`Not visible: ${locator}`);
  }
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const distance = Math.hypot(target.x - mouse.x, target.y - mouse.y);
  const steps = Math.max(1, Math.round(Math.min(Math.max(distance * 0.7, 250), 750) / 16));
  const from = mouse;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (target.x - from.x) * eased, from.y + (target.y - from.y) * eased);
    await sleep(16);
  }
  mouse = target;
}

/** Clicks with the press held briefly, so the ripple shows before the click's result does. */
async function click(locator: Locator): Promise<void> {
  // Waits until the element can be clicked, without clicking it.
  await locator.click({ trial: true });
  await moveTo(locator);
  await sleep(150);
  await page.mouse.down();
  await sleep(150);
  await page.mouse.up();
  await sleep(250);
}

/** Types into a field as a person would: adding to the end if the new text starts with the old, otherwise replacing it. */
async function type(field: Locator, text: string): Promise<void> {
  await click(field);
  const current = await field.inputValue();
  if (current !== "" && text.startsWith(current)) {
    await page.keyboard.press("ControlOrMeta+End");
    text = text.slice(current.length);
  } else if (current !== "") {
    await page.keyboard.press("ControlOrMeta+A");
    await sleep(400);
  }
  await field.pressSequentially(text, { delay: TYPING_MS });
  await sleep(300);
}

const pane = (name: string): Locator => page.getByRole("region", { name: `Replica ${name}` });
const card = (name: string, title: string): Locator => pane(name).getByRole("listitem", { name: title });

async function shows(locator: Locator, text: string): Promise<void> {
  await locator.getByText(text, { exact: true }).first().waitFor();
}

async function createNote(name: string, title: string, text: string): Promise<void> {
  const p = pane(name);
  await click(p.getByRole("button", { name: "New note" }));
  await type(p.getByLabel("Title"), title);
  await type(p.getByLabel("Text"), text);
  await click(p.getByRole("button", { name: "Add note" }));
  await shows(card(name, title), text);
}

async function editNote(name: string, title: string, text: string): Promise<void> {
  const c = card(name, title);
  await click(c.getByRole("button", { name: "Edit" }));
  await type(c.getByLabel("Text"), text);
  await click(c.getByRole("button", { name: "Save" }));
  await c.getByRole("button", { name: "Save" }).waitFor({ state: "detached" });
  await shows(c.locator(".note-text"), text);
}

/** Clicks a link's Sync button and waits for its result. */
async function sync(link: string, syncingMark?: string): Promise<void> {
  const button = page.getByRole("button", { name: `Sync ${link}` });
  const status = page.locator(".link-control", { has: button }).getByRole("status");
  await click(button);
  await status.getByText("Syncing...").waitFor();
  if (syncingMark !== undefined) {
    mark(syncingMark, 450);
  }
  await status.getByText("Syncing...").waitFor({ state: "detached" });
}

async function setOnline(name: string, online: boolean): Promise<void> {
  const toggle = pane(name).getByRole("switch", { name: "Online" });
  await click(toggle);
  await page.waitForFunction(
    ([element, value]) => (element as Element).getAttribute("aria-checked") === value,
    [await toggle.elementHandle(), String(online)] as const,
  );
}

let shown = 0;

/** Clicks Next, checks the caption is the next one, and waits before the step's action. */
async function next(): Promise<void> {
  await click(page.getByRole("button", { name: "Next" }));
  shown++;
  const caption = page.getByTestId("caption");
  await page.waitForFunction(
    ([element, text]) => (element as Element).textContent === text,
    [await caption.elementHandle(), captions[shown]?.text] as const,
  );
  mark(`caption-${String(shown + 1).padStart(2, "0")}`);
  await sleep(BEFORE_ACTION_MS);
}

/** Holds on the step's result, long enough to read its caption unless told otherwise. */
async function hold(ms = readingMs(captions[shown]?.text ?? "")): Promise<void> {
  mark(`step-${String(shown + 1).padStart(2, "0")}`, ms / 2);
  await sleep(ms);
  mark(`step-${String(shown + 1).padStart(2, "0")}-end`);
}

/** Plays both scenes, from opening the page to the end of the closing caption. */
async function playScenes(): Promise<void> {
  await page.goto(`http://localhost:${DEFAULT_PAGE_PORT}/?captions`);
  for (const name of REPLICA_NAMES) {
    await pane(name).getByText("Signed in as", { exact: false }).waitFor();
  }
  await page.getByTestId("caption").getByText(captions[0]?.text ?? "", { exact: true }).waitFor();
  // Starts clean: no notes anywhere, and nothing in the log.
  if ((await page.getByRole("log", { name: "Activity" }).locator(".entry-text").count()) !== 0) {
    throw new Error("The activity log is not empty at the start");
  }
  for (const name of REPLICA_NAMES) {
    if ((await pane(name).getByRole("listitem").count()) !== 0) {
      throw new Error(`Replica ${name} has notes at the start; the recording needs fresh databases`);
    }
  }
  // Show the pointer from the start, near the Next button.
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  await moveTo(page.getByRole("button", { name: "Next" }));
  await sleep(300);
  mark("start");

  // Scene 1.
  await hold();

  await next();
  await createNote("A", "Picnic", "Sandwiches.");
  await hold();

  await next();
  await sync("A and B", "step-03-syncing");
  await shows(card("B", "Picnic"), "Sandwiches.");
  await hold();

  await next();
  await editNote("B", "Picnic", "Sandwiches. Lemonade.");
  await hold();

  await next();
  await sync("B and C");
  await shows(card("C", "Picnic"), "Sandwiches. Lemonade.");
  await hold();

  await next();
  await editNote("C", "Picnic", "Sandwiches. Lemonade. A blanket.");
  await hold();

  await next();
  await sync("A and C");
  await shows(card("A", "Picnic"), "Sandwiches. Lemonade. A blanket.");
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("B and C");
  await shows(card("B", "Picnic"), "Sandwiches. Lemonade. A blanket.");
  await hold();

  // Scene 2.
  await next();
  await createNote("A", "Meeting", "Tuesday.");
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("A and B");
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("A and C");
  for (const name of REPLICA_NAMES) {
    await shows(card(name, "Meeting"), "Tuesday.");
  }
  await hold();

  await next();
  await setOnline("B", false);
  await sleep(BETWEEN_ACTIONS_MS);
  await setOnline("C", false);
  await hold();

  await next();
  await editNote("B", "Meeting", "Tuesday at 10.");
  await sleep(BETWEEN_ACTIONS_MS);
  await editNote("C", "Meeting", "Wednesday.");
  await hold();

  await next();
  await setOnline("B", true);
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("A and B");
  await shows(card("A", "Meeting"), "Tuesday at 10.");
  await hold();

  await next();
  await setOnline("C", true);
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("A and C");
  await shows(card("A", "Meeting"), "In conflict");
  await shows(card("C", "Meeting"), "In conflict");
  await hold();

  await next();
  await sync("A and B");
  await shows(card("B", "Meeting"), "In conflict");
  await hold(6000);

  await next();
  await click(card("A", "Meeting").getByRole("button", { name: "Resolve" }));
  const dialog = page.getByRole("dialog");
  await shows(dialog, "Wednesday.");
  // Looks at the two versions, which also keeps the pointer off Delete the note.
  await sleep(500);
  await moveTo(dialog.locator(".version").first());
  await sleep(700);
  await moveTo(dialog.locator(".version").nth(1));
  await sleep(700);
  await click(dialog.getByRole("button", { name: "Write a new version" }));
  await type(dialog.getByLabel("Text"), "Wednesday at 10.");
  mark("step-14-dialog", 500);
  await sleep(1000);
  await click(dialog.getByRole("button", { name: "Save new version" }));
  await dialog.waitFor({ state: "detached" });
  await shows(card("A", "Meeting"), "Wednesday at 10.");
  await hold();

  await next();
  await sync("A and B");
  await sleep(BETWEEN_ACTIONS_MS);
  await sync("A and C");
  for (const name of REPLICA_NAMES) {
    await shows(card(name, "Meeting"), "Wednesday at 10.");
  }
  await hold();

  // The closing caption.
  await next();
  await hold(5000);
  mark("end");
}

// Stops the browser and the replicas even if a step fails.
try {
  await playScenes();
} finally {
  await context.close();
  await browser.close();
  await demo.stop();
}
const video = await page.video()?.path();
if (video === undefined) {
  fail("Playwright saved no recording");
}

const webm = join(outDir, "demo.webm");
renameSync(video, webm);

function ffmpeg(...args: string[]): void {
  const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`ffmpeg ${args.join(" ")} failed`);
  }
}

/**
 * Writes the recording at GIF_FPS, losslessly, with its compression noise
 * taken out: each 8 x 8 block keeps its last pixels unless a pixel in it
 * changed by more than MAX_CHANGE, or the block by more than MEAN_CHANGE on
 * average. Measured on a still stretch of a recording, the noise stays at or
 * under 15 and 2.1; the page's faintest changes (the pink of a note in
 * conflict, the dialog's backdrop) move a whole block by more. The last steps
 * of a click ripple fading out are smaller, so once a block has been still
 * (no pixel changing by more than STILL_CHANGE) for SETTLE_FRAMES, it is
 * copied as it is. Without this nearly every pixel of every GIF frame differs
 * from the one before.
 */
async function steady(start: string, end: string, output: string): Promise<void> {
  const MAX_CHANGE = 20;
  const MEAN_CHANGE = 3;
  const SETTLE_FRAMES = GIF_FPS / 2;
  const STILL_CHANGE = 8;
  const BLOCK = 8;
  const frameSize = WIDTH * HEIGHT * 3;
  const size = `${WIDTH}x${HEIGHT}`;
  const decoder = spawn("ffmpeg", ["-loglevel", "error", "-ss", start, "-to", end, "-i", webm, "-vf", `fps=${GIF_FPS}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const encoder = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", size, "-r", String(GIF_FPS), "-i", "-", "-c:v", "ffv1", output], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const encoded = new Promise((resolve) => encoder.on("exit", resolve));

  /** How much a block differs between two frames: its largest change, and its mean. */
  function change(a: Buffer, b: Buffer, bx: number, by: number): { max: number; mean: number } {
    const rows = Math.min(BLOCK, HEIGHT - by);
    const length = Math.min(BLOCK, WIDTH - bx) * 3;
    let max = 0;
    let sum = 0;
    for (let y = by; y < by + rows; y++) {
      const offset = (y * WIDTH + bx) * 3;
      for (let i = offset; i < offset + length; i++) {
        const difference = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
        sum += difference;
        max = Math.max(max, difference);
      }
    }
    return { max, mean: sum / (rows * length) };
  }

  let held: Buffer | undefined;
  let previous: Buffer | undefined;
  // For each block, how many frames it has been still for.
  const still = new Int32Array(Math.ceil(WIDTH / BLOCK) * Math.ceil(HEIGHT / BLOCK));
  let pending = Buffer.alloc(0);
  for await (const chunk of decoder.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameSize) {
      const frame = Buffer.from(pending.subarray(0, frameSize));
      pending = pending.subarray(frameSize);
      if (held === undefined || previous === undefined) {
        held = Buffer.from(frame);
      } else {
        let block = 0;
        for (let by = 0; by < HEIGHT; by += BLOCK) {
          for (let bx = 0; bx < WIDTH; bx += BLOCK, block++) {
            const stillFor = change(frame, previous, bx, by).max <= STILL_CHANGE ? (still[block] ?? 0) + 1 : 0;
            still[block] = stillFor;
            const fromHeld = change(frame, held, bx, by);
            if (fromHeld.max > MAX_CHANGE || fromHeld.mean > MEAN_CHANGE || (stillFor === SETTLE_FRAMES && fromHeld.max > 0)) {
              const length = Math.min(BLOCK, WIDTH - bx) * 3;
              for (let y = by; y < Math.min(by + BLOCK, HEIGHT); y++) {
                const offset = (y * WIDTH + bx) * 3;
                frame.copy(held, offset, offset, offset + length);
              }
            }
          }
        }
      }
      previous = frame;
      if (!encoder.stdin.write(Buffer.from(held))) {
        await once(encoder.stdin, "drain");
      }
    }
  }
  encoder.stdin.end();
  if ((await encoded) !== 0) {
    fail("ffmpeg failed to write the steadied recording");
  }
}

/**
 * When the caption text changed in the recording, nearest to the given time
 * there (within a second and a half).
 */
function captionChange(near: number): number {
  const from = Math.max(0, near - 1.5);
  // The caption's text only: the pointer's way to Next stays right of it.
  const result = spawnSync(
    "ffmpeg",
    ["-ss", String(from), "-t", "3", "-i", webm, "-vf", "crop=1050:60:96:30,select='gt(scene,0.02)',showinfo", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const times = [...result.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => from + Number(match[1]));
  const nearest = times.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0];
  if (nearest === undefined) {
    fail(`No caption change in the recording near ${near.toFixed(2)} s`);
  }
  return nearest;
}

// The marks come from this script's clock, and the recording's first frame
// comes a little after the page opens. Where a caption changed in the
// recording gives the difference; it should be the same for any caption.
const markAt = (name: string) => marks.get(name) ?? fail(`No mark ${name}`);
const offset = captionChange(markAt("caption-08")) - markAt("caption-08");
const check = captionChange(markAt("caption-02")) - markAt("caption-02");
if (Math.abs(offset - check) > 0.15) {
  fail(`The recording's timing is uneven: ${offset.toFixed(2)} s at step 8, ${check.toFixed(2)} s at step 2`);
}
const at = (name: string) => markAt(name) + offset;

// Scene 1: from when the page is ready to the end of step 7's hold. Scene 2:
// from step 8's caption to the end of the closing caption's hold.
const scenes = [
  { file: join(outDir, "scene-1.gif"), start: at("start"), end: at("step-07-end"), frames: ["step-03-syncing", "step-07"] },
  { file: join(outDir, "scene-2.gif"), start: at("caption-08"), end: at("end"), frames: ["step-13", "step-14-dialog", "step-15", "step-16"] },
];
const mp4 = join(outDir, "demo.mp4");
const work = mkdtempSync(join(tmpdir(), "cromdb-record-"));
for (const [i, scene] of scenes.entries()) {
  const steadied = join(work, `steady-${i}.mkv`);
  const palette = join(work, `palette-${i}.png`);
  await steady(String(scene.start), String(scene.end), steadied);
  // Two passes: a palette for the whole scene, then the GIF.
  ffmpeg("-i", steadied, "-vf", "palettegen=stats_mode=diff", palette);
  ffmpeg("-i", steadied, "-i", palette, "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", scene.file);
  // Taken from the GIF, to show what it looks like.
  for (const name of scene.frames) {
    ffmpeg("-i", scene.file, "-ss", String(at(name) - scene.start), "-frames:v", "1", join(outDir, `${name}.png`));
  }
}
ffmpeg("-ss", String(at("start")), "-to", String(at("end")), "-i", webm, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4);
rmSync(work, { recursive: true, force: true });

const megabytes = (file: string) => (statSync(file).size / 1024 / 1024).toFixed(1);
console.log(`Recording timing: ${offset.toFixed(2)} s from the script's clock (${check.toFixed(2)} s at step 2)`);
for (const scene of scenes) {
  console.log(`${basename(scene.file)}: ${megabytes(scene.file)} MB, ${(scene.end - scene.start).toFixed(1)} s at ${GIF_FPS} fps`);
}
console.log(`demo.mp4: ${megabytes(mp4)} MB, ${(at("end") - at("start")).toFixed(1)} s`);
console.log(`Written to ${outDir}`);
