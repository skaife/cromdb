// Checks the package installs and works the way a user would get it: packs
// it, installs the .tgz into a new project in a temporary directory, and runs
// a small script there that imports from "cromdb". Run `npm run build` first.
//
// Usage: node scripts/check-package.mjs

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The script the new project runs.
const CHECK = `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SqliteAdapter, VERSION } from "cromdb";

const dir = mkdtempSync(join(tmpdir(), "cromdb-check-db-"));
try {
  const adapter = SqliteAdapter.open(join(dir, "check.db"));
  const db = await Session.named("alice").openDatabase(adapter);
  const created = await db.create({ hello: "world" });
  const read = await db.get(created.id);
  if (read === undefined || read.content.hello !== "world") {
    throw new Error("the document did not read back");
  }
  console.log(\`cromdb \${VERSION}: \${JSON.stringify(read.content)}\`);
  adapter.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
`;

/** Runs a command in cwd, showing its output unless quiet, and returns its stdout. Throws if it fails. */
function run(cwd, quiet, command, ...args) {
  console.log(`> ${[command, ...args].join(" ")}`);
  // npm is a .cmd file on Windows, which needs a shell. No argument here has
  // spaces or quotes, so none needs escaping.
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (!quiet || result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
  }
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.error ?? `exit code ${result.status}`}`);
  }
  return result.stdout;
}

const project = mkdtempSync(join(tmpdir(), "cromdb-check-"));
try {
  const tarball = JSON.parse(run(root, true, "npm", "pack", "--json"))[0].filename;
  copyFileSync(join(root, tarball), join(project, tarball));
  rmSync(join(root, tarball));

  run(project, true, "npm", "init", "-y");
  run(project, false, "npm", "pkg", "set", "type=module");
  run(project, false, "npm", "install", `./${tarball}`);
  writeFileSync(join(project, "check.mjs"), CHECK);
  run(project, false, "node", "check.mjs");
} finally {
  rmSync(project, { recursive: true, force: true });
}
