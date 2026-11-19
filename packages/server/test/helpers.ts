import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createLevel2Driver } from "@cromdb/driver-level-2";
import type { Io, Question } from "../src/cli/io.js";
import { main } from "../src/cli/main.js";

/** A temporary directory, and a way to remove it. */
export function tempDir(): { path: string; join(...names: string[]): string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "cromdb-server-"));
  return {
    path,
    join: (...names) => join(path, ...names),
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface ScriptedIo extends Io {
  readonly lines: string[];
  readonly errors: string[];
  readonly asked: Question[];
  /** Everything written, out and err, in order. */
  text(): string;
}

/**
 * An Io whose questions are answered from answers in order (none: not a
 * terminal, as when run without one), at a fixed time.
 */
export function scriptedIo(options: { answers?: string[]; env?: Record<string, string>; stdin?: string; now?: Date } = {}): ScriptedIo {
  const answers = options.answers === undefined ? undefined : [...options.answers];
  const lines: string[] = [];
  const errors: string[] = [];
  const all: string[] = [];
  const asked: Question[] = [];
  return {
    lines,
    errors,
    asked,
    text: () => all.join("\n"),
    out: (line) => {
      lines.push(line);
      all.push(line);
    },
    err: (line) => {
      errors.push(line);
      all.push(line);
    },
    prompter: {
      interactive: answers !== undefined,
      async ask(question) {
        asked.push(question);
        if (answers === undefined) {
          const { UsageError } = await import("../src/cli/io.js");
          throw new UsageError(`${question.flag} is needed: there is no terminal to ask "${question.text}" on`);
        }
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`No scripted answer for "${question.text}"`);
        }
        return answer === "" && question.default !== undefined ? question.default : answer;
      },
      close: () => {},
    },
    env: options.env ?? {},
    fetch,
    now: () => options.now ?? new Date("2026-11-19T12:00:00.000Z"),
    readStdin: async () => options.stdin ?? "",
  };
}

export interface FakeIssuer {
  readonly issuer: string;
  /** Changes what the issuer serves: the discovery document and the keys. */
  discovery: Record<string, unknown>;
  jwks: Record<string, unknown>;
  close(): Promise<void>;
}

/** A provider that serves only discovery and keys, enough for setup's checks. Login comes with S3b's fake. */
export async function fakeIssuer(realm = "cromdb"): Promise<FakeIssuer> {
  let fake: FakeIssuer;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = path === `/realms/${realm}/.well-known/openid-configuration` ? fake.discovery : path === `/realms/${realm}/certs` ? fake.jwks : undefined;
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/${realm}`;
  fake = {
    issuer,
    discovery: {
      issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      jwks_uri: `${issuer}/certs`,
      end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
      response_types_supported: ["code", "id_token", "code id_token"],
      code_challenge_methods_supported: ["plain", "S256"],
      id_token_signing_alg_values_supported: ["RS256", "ES256", "PS256"],
    },
    jwks: { keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "k1", n: "AQAB-test-modulus", e: "AQAB" }] },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return fake;
}

/** The flags for a complete non-interactive setup. */
export function setupFlags(dataDir: string, issuer: string, extra: string[] = []): string[] {
  return [
    "setup",
    "--data",
    dataDir,
    "--deployment",
    "new",
    "--server-name",
    "Test Server",
    "--public-url",
    "http://localhost:8080",
    "--trust-proxy",
    "no",
    "--listen",
    "127.0.0.1:0",
    "--issuer",
    issuer,
    "--client-id",
    "cromdb",
    "--admin-email",
    " Admin@Example.COM ",
    ...extra,
  ];
}

/** Runs a complete setup into dataDir. */
export async function setUp(dataDir: string, issuer: string, extra: string[] = []): Promise<ScriptedIo> {
  const io = scriptedIo({ env: { CROMDB_CLIENT_SECRET: "s3cret\n" } });
  const status = await main(setupFlags(dataDir, issuer, extra), io);
  if (status !== 0) {
    throw new Error(`setup failed with ${status}: ${io.text()}`);
  }
  return io;
}

export { createLevel2Driver };
