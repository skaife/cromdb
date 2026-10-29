// Serves the built page (web/dist) and its config on localhost. The page
// holds no data: it calls each replica's own /api directly, on the replica's
// own port, found through /config.json.
//
// Usage:
//   node server/page.ts [--port 4000] [--replica A=4001 --replica B=4002 ...]
//
// Without --replica, A, B and C are on their default ports.

import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import express from "express";
import { DEFAULT_PAGE_PORT, DEFAULT_PORTS, REPLICA_NAMES } from "./identities.ts";

const HOST = "127.0.0.1";
const distDir = join(import.meta.dirname, "..", "web", "dist");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseReplica(value: string): { name: string; port: number } {
  const at = value.indexOf("=");
  const port = Number(value.slice(at + 1));
  if (at < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail(`--replica takes NAME=PORT, got ${JSON.stringify(value)}`);
  }
  return { name: value.slice(0, at), port };
}

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    replica: { type: "string", multiple: true },
  },
});
const port = values.port === undefined ? DEFAULT_PAGE_PORT : Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  fail(`--port must be a port number, got ${JSON.stringify(values.port)}`);
}
if (!existsSync(join(distDir, "index.html"))) {
  fail(`No built page in ${distDir}; run npm run build:web in demo/ first`);
}
const replicas = values.replica?.map(parseReplica) ?? REPLICA_NAMES.map((name) => ({ name, port: DEFAULT_PORTS[name] }));

const app = express();
// The page builds each replica's URL from these ports and its own hostname,
// so it works opened as localhost or 127.0.0.1.
app.get("/config.json", (_req, res) => {
  res.json({ replicas });
});
app.use(express.static(distDir));

const server = app.listen(port, HOST, (error?: Error) => {
  if (error !== undefined) {
    fail(`The page could not listen on ${HOST}:${port}: ${error.message}`);
  }
  const listening = (server.address() as AddressInfo).port;
  console.log(`Page listening on http://${HOST}:${listening}. Open http://localhost:${listening}`);
});

function stop(): void {
  server.close();
  server.closeAllConnections();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
