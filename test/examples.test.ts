import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as basic } from "../examples/basic.js";
import { main as conflicts } from "../examples/conflicts.js";
import { main as customTransport } from "../examples/custom-transport.js";
import { main as replication } from "../examples/replication.js";

const EXAMPLES = ["basic", "replication", "conflicts", "custom-transport"] as const;

async function output(main: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  await main();
  return lines;
}

function fileLines(path: string): string[] {
  // Git may check files out with CRLF line endings (on Windows, for one).
  return readFileSync(new URL(path, import.meta.url), "utf8").split(/\r?\n/);
}

function dedent(lines: readonly string[]): string[] {
  const indent = Math.min(...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent));
}

/** The ```ts blocks of the README, each as lines, with "cromdb" imports pointed at the source. */
function readmeBlocks(): string[][] {
  const blocks: string[][] = [];
  let block: string[] | undefined;
  for (const line of fileLines("../README.md")) {
    if (block === undefined) {
      if (line === "```ts") {
        block = [];
      }
    } else if (line === "```") {
      blocks.push(block);
      block = undefined;
    } else {
      block.push(line.replace(/ from "cromdb";$/, ' from "../src/index.js";'));
    }
  }
  return blocks;
}

/**
 * Whether the block comes from the file: its leading import lines are lines
 * of the file, and the rest appears as consecutive lines, up to indentation.
 */
function appearsIn(block: readonly string[], file: readonly string[]): boolean {
  let first = 0;
  while (block[first]?.startsWith("import ") === true) {
    if (!file.includes(block[first] as string)) {
      return false;
    }
    first++;
  }
  while (block[first] === "") {
    first++;
  }
  const rest = block.slice(first);
  if (rest.length === 0) {
    return true;
  }
  const wanted = dedent(rest).join("\n");
  for (let start = 0; start + rest.length <= file.length; start++) {
    if (dedent(file.slice(start, start + rest.length)).join("\n") === wanted) {
      return true;
    }
  }
  return false;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("examples", () => {
  it("basic", async () => {
    const lines = await output(basic);
    expect(lines[0]).toMatch(/^alice created [0-9a-f-]{36}$/);
    expect(lines.slice(1)).toEqual(["items now: milk, eggs", "alice sees 1 open note(s)", "bob sees: Groceries", "bob sees: Bob's list"]);
  });

  it("replication", async () => {
    const lines = await output(replication);
    expect(lines[0]).toMatch(/^replica [0-9a-f-]{36} of database [0-9a-f-]{36}$/);
    expect(lines.slice(1)).toEqual(["a has 2 documents, b has 2", "b applied 1 change(s) in 1 batch(es)"]);
  });

  it("conflicts", async () => {
    const lines = await output(conflicts);
    expect(lines[0]).toBe("documents in conflict: 1");
    // Which edit is primary depends on the replicas' random IDs; the primary is listed first.
    expect(lines[1]).toMatch(/^primary : (done|blocked)$/);
    expect(lines[2]).toMatch(/^conflict: (done|blocked)$/);
    expect(new Set([lines[1]?.slice(10), lines[2]?.slice(10)])).toEqual(new Set(["done", "blocked"]));
    expect(lines.slice(3)).toEqual(["edited through conflict: true", "on b: done, in conflict: false"]);
  });

  it("custom transport", async () => {
    const lines = await output(customTransport);
    expect(lines).toEqual(["b applied 1 change(s) from a", "a applied 1 change(s) from b", "a has 2 documents, b has 2"]);
  });

  it("every code block in the README comes from an example", () => {
    const files = EXAMPLES.map((name) => fileLines(`../examples/${name}.ts`));
    const blocks = readmeBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(files.some((file) => appearsIn(block, file)), block.join("\n")).toBe(true);
    }
  });
});
