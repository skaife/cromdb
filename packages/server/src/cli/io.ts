// What the console commands read from and write to, so tests can drive them.

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Fetch } from "../oidc-discovery.js";

/** A mistake in how a command was called: exit status 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A refusal or failure to show as one message: exit status 1. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export interface Question {
  readonly text: string;
  /** The flag that answers it instead, named when there is no terminal to ask on. */
  readonly flag: string;
  readonly default?: string;
  /** Not echoed while typed. */
  readonly secret?: boolean;
}

export interface Prompter {
  /** Whether questions can be asked; when false, ask throws a UsageError naming the flag. */
  readonly interactive: boolean;
  ask(question: Question): Promise<string>;
  close(): void;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  readonly prompter: Prompter;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: Fetch;
  now(): Date;
  /** All of standard input, for a secret piped in. */
  readStdin(): Promise<string>;
}

/** Questions on the terminal, or none when standard input isn't one. */
export function terminalPrompter(): Prompter {
  if (!process.stdin.isTTY) {
    return {
      interactive: false,
      ask: async (question) => {
        throw new UsageError(`${question.flag} is needed: there is no terminal to ask "${question.text}" on`);
      },
      close: () => {},
    };
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  // Made on the first question, so commands that ask nothing don't hold
  // standard input open.
  let made: ReturnType<typeof createInterface> | undefined;
  const lines = () => (made ??= createInterface({ input: process.stdin, output, terminal: true }));
  return {
    interactive: true,
    async ask(question) {
      const prompt = `${question.text}${question.default === undefined ? "" : ` [${question.default}]`}: `;
      if (question.secret === true) {
        process.stdout.write(prompt);
        muted = true;
        try {
          return await lines().question("");
        } finally {
          muted = false;
          process.stdout.write("\n");
        }
      }
      const answer = (await lines().question(prompt)).trim();
      return answer === "" && question.default !== undefined ? question.default : answer;
    },
    close: () => made?.close(),
  };
}

export function processIo(): Io {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompter: terminalPrompter(),
    env: process.env,
    fetch,
    now: () => new Date(),
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
