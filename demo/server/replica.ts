// Runs one replica: its database file, its person and service, and its HTTP
// API on localhost.
//
// Usage:
//   node server/replica.ts --name B [--port 4002] [--data data/b.db]
//     [--peer A=http://127.0.0.1:4001 --peer C=http://127.0.0.1:4003]
//     [--page-port 4000]
//
// Name is A, B or C. Without --peer, the other two are peers on their
// default ports. --page-port is where the page is served: browser requests
// are allowed from that port on localhost or 127.0.0.1, and nowhere else.

import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Session, SqliteAdapter } from "cromdb";
import { createApp } from "./app.ts";
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PAGE_PORT,
  DEFAULT_PORTS,
  REPLICA_NAMES,
  dataFileName,
  isReplicaName,
  personFor,
  serviceFor,
} from "./identities.ts";
import type { Peer } from "./sync.ts";

const HOST = "127.0.0.1";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parsePeer(value: string): Peer {
  const at = value.indexOf("=");
  if (at < 1) {
    fail(`--peer takes NAME=URL, got ${JSON.stringify(value)}`);
  }
  return { name: value.slice(0, at), url: value.slice(at + 1) };
}

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    port: { type: "string" },
    data: { type: "string" },
    peer: { type: "string", multiple: true },
    "page-port": { type: "string" },
  },
});

const name = values.name ?? "";
if (!isReplicaName(name)) {
  fail(`--name must be one of ${REPLICA_NAMES.join(", ")}`);
}
const port = values.port === undefined ? DEFAULT_PORTS[name] : Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  fail(`--port must be a port number, got ${JSON.stringify(values.port)}`);
}
const pagePort = values["page-port"] === undefined ? DEFAULT_PAGE_PORT : Number(values["page-port"]);
if (!Number.isSafeInteger(pagePort) || pagePort < 1 || pagePort > 65535) {
  fail(`--page-port must be a port number, got ${JSON.stringify(values["page-port"])}`);
}
const dataFile = values.data ?? join(DEFAULT_DATA_DIR, dataFileName(name));
// Opening a missing file would create an empty database, not a replica.
if (!existsSync(dataFile)) {
  fail(`No database at ${dataFile}; run npm run demo:reset first`);
}
const peers =
  values.peer?.map(parsePeer) ??
  REPLICA_NAMES.filter((other) => other !== name).map((other) => ({
    name: other,
    url: `http://${HOST}:${DEFAULT_PORTS[other]}`,
  }));

const adapter = SqliteAdapter.open(dataFile);
const person = await Session.named(personFor(name)).openDatabase(adapter);
const service = await Session.named(serviceFor(name)).openDatabase(adapter);

let listening: number | undefined;
const app = createApp({
  name,
  person,
  service,
  dataFile: basename(dataFile),
  peers,
  port: () => listening,
  pageOrigins: [`http://localhost:${pagePort}`, `http://127.0.0.1:${pagePort}`],
});
const server = app.listen(port, HOST, (error?: Error) => {
  if (error !== undefined) {
    fail(`Replica ${name} could not listen on ${HOST}:${port}: ${error.message}`);
  }
  listening = (server.address() as AddressInfo).port;
  console.log(`Replica ${name} (${personFor(name)}) listening on http://${HOST}:${listening}, data ${dataFile}`);
});

function stop(): void {
  server.close();
  server.closeAllConnections();
  adapter.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
