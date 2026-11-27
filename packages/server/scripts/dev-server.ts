// A server for working on the admin UI and for its browser tests, with the
// fake login provider (test/fake-provider.ts) in the same process. Never part
// of the server's build: it lives here, beside the tests, and runs the built
// server from dist (run "npm run build" first).
//
// Usage: node scripts/dev-server.ts [flags]
//   --public-url URL     where the browser reaches the UI (default
//                        http://localhost:5173, the Vite dev server, which
//                        forwards /api and /auth here); Origin, cookies and
//                        the login callback all follow it
//   --listen HOST:PORT   where this server listens (default 127.0.0.1:8080)
//   --provider-port N    the fake provider's port (default 8180); the issuer
//                        is kept in the data directory, so keep it the same
//   --data DIR           the data directory (default: cromdb-dev-server in
//                        the system's temporary folder), made on first run
//   --backups DIR        the backups folder (default: the data directory's
//                        name with -backups, beside it)
//   --fresh              remove the data directory and the backups folder
//                        first
//
// Logging in shows the fake provider's page of people to pick from. Ada
// Admin is the server admin; Ivy, Ned and Bob are invited, not admins. Frank
// and Gina (a server admin) are invited too but aren't on that page, so they
// stay invited. A new data directory gets sample databases of Ada's
// (scripts/dev-data.ts). The update check, when turned on, uses made-up tags
// and never asks GitHub.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { startServer } from "../dist/index.js";
import { fakeProvider } from "../test/fake-provider.ts";
import { makeDevData } from "./dev-data.ts";

const { values } = parseArgs({
  options: {
    "public-url": { type: "string", default: "http://localhost:5173" },
    listen: { type: "string", default: "127.0.0.1:8080" },
    "provider-port": { type: "string", default: "8180" },
    data: { type: "string", default: join(tmpdir(), "cromdb-dev-server") },
    backups: { type: "string" },
    fresh: { type: "boolean", default: false },
  },
});
const publicUrl = values["public-url"].replace(/\/$/, "");
const dataDir = values.data;
const backupsDir = values.backups ?? `${dataDir.replace(/[\\/]+$/, "")}-backups`;
const serverDir = join(import.meta.dirname, "..");

const DEV_PEOPLE = [
  { username: "ada", sub: "sub-ada", email: "ada@example.com", emailVerified: true, name: "Ada Admin" },
  { username: "ivy", sub: "sub-ivy", email: "ivy@example.com", emailVerified: true, name: "Ivy Invited" },
  { username: "ned", sub: "sub-ned", email: "ned@example.com", emailVerified: true, name: "Ned Newcomer" },
  { username: "bob", sub: "sub-bob", email: "bob@example.com", emailVerified: true, name: "Bob Baker" },
];
const CLIENT = { clientId: "cromdb", secret: "dev-secret" };

const provider = await fakeProvider(
  [
    {
      name: "dev",
      clients: [{ ...CLIENT, redirectUris: [`${publicUrl}/auth/callback`], postLogoutRedirectUris: [`${publicUrl}/`] }],
      users: DEV_PEOPLE,
    },
  ],
  { pickUser: true, port: Number(values["provider-port"]) },
);

if (values.fresh) {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(backupsDir, { recursive: true, force: true });
}
const made = !existsSync(dataDir);
if (made) {
  // Not spawnSync: setup checks the issuer, which this process serves.
  const child = spawn(
    process.execPath,
    [
      join(serverDir, "dist", "cli", "main.js"),
      "setup",
      "--data",
      dataDir,
      "--deployment",
      "new",
      "--server-name",
      "dev-server",
      "--public-url",
      publicUrl,
      ...(publicUrl.startsWith("https:") ? ["--no-tls"] : []),
      "--trust-proxy",
      "no",
      "--listen",
      values.listen,
      "--issuer",
      provider.issuer("dev"),
      "--client-id",
      CLIENT.clientId,
      "--admin-email",
      "ada@example.com",
    ],
    { stdio: "inherit", env: { ...process.env, CROMDB_CLIENT_SECRET: CLIENT.secret } },
  );
  const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (status !== 0) {
    await provider.close();
    process.exit(status ?? 1);
  }
}

// The update check never asks GitHub here: its tags are this version and the
// next minor one, so turning it on in Settings shows a newer version on the
// Status page two seconds later.
const VERSION = (JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as { version: string }).version;
const [major = 0, minor = 0] = VERSION.split(".").map(Number);
const server = await startServer({
  dataDir,
  backupsDir,
  listen: values.listen,
  updateSource: async () => [`server-v${VERSION}`, `server-v${major}.${minor + 1}.0`],
  updateFirstCheckMs: 2_000,
});
if (made) {
  for (const email of ["ivy@example.com", "ned@example.com", "bob@example.com"]) {
    await server.directory.invite({ email, serverAdmin: false, by: "console", now: new Date() });
  }
  const ada = server.directory.index.byEmail("ada@example.com")[0];
  if (ada === undefined) throw new Error("Setup made no Ada Admin");
  const ned = server.directory.index.byEmail("ned@example.com")[0];
  if (ned === undefined) throw new Error("No Ned Newcomer");
  const bob = server.directory.index.byEmail("bob@example.com")[0];
  if (bob === undefined) throw new Error("No Bob Baker");
  // Invitations nobody uses: no one by these emails is on the fake provider's page.
  await server.directory.invite({ email: "frank@example.com", serverAdmin: false, by: ada.person.personId, now: new Date() });
  await server.directory.invite({ email: "gina@example.com", serverAdmin: true, by: ada.person.personId, now: new Date() });
  await makeDevData(server, ada.person.personId, new Date(), ned.person.personId, bob.person.personId);
  // A first maintenance run now, so the Status and Backups pages have results to show.
  await server.maintenance.runNow();
}
console.log(`Dev server: ${server.url}, reached at ${publicUrl}; data in ${dataDir}, backups in ${backupsDir}; login provider ${provider.issuer("dev")}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  await provider.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
