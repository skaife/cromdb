// Checks how the workspace packages depend on each other. Run after npm ci or
// npm install, from anywhere in the repository.
//
// Every dependency of one workspace package on another (cromdb, @cromdb/*)
// must be an exact version, equal to that package's current version, and must
// resolve to the workspace itself, not to a copy npm installed from the
// registry. npm falls back to the registry quietly when the versions stop
// matching, for example after the engine's version is raised; this makes that
// fail instead, so the pin is raised on purpose, with the driver's tests run
// against the new engine. Every workspace package except the engine must be
// private.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = new Set(["cromdb"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const workspaces = readJson(join(root, "package.json")).workspaces.map((dir) => {
  const pkg = readJson(join(root, dir, "package.json"));
  return { dir, name: pkg.name, version: pkg.version, private: pkg.private === true, pkg };
});
const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

const problems = [];
for (const workspace of workspaces) {
  if (!PUBLISHED.has(workspace.name) && !workspace.private) {
    problems.push(`${workspace.name} must be private`);
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(workspace.pkg[field] ?? {})) {
      const target = byName.get(name);
      if (target === undefined) {
        continue;
      }
      const where = `${workspace.name} ${field} ${name}`;
      if (spec !== target.version) {
        problems.push(`${where} is ${JSON.stringify(spec)}; it must be exactly ${target.version}, the workspace's version`);
      }
      const nested = join(root, workspace.dir, "node_modules", name);
      if (existsSync(nested)) {
        problems.push(`${where} resolves to ${nested}, a copy from the registry, not the workspace`);
        continue;
      }
      const hoisted = join(root, "node_modules", name);
      if (!existsSync(hoisted)) {
        problems.push(`${where} is not installed; run npm ci`);
      } else if (realpathSync(hoisted) !== realpathSync(join(root, target.dir))) {
        problems.push(`${where} resolves to ${realpathSync(hoisted)}, not the workspace ${target.dir}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Workspace pins are wrong:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Workspace pins are exact and resolve to the workspaces (${workspaces.map((w) => `${w.name} ${w.version}`).join(", ")}).`);
