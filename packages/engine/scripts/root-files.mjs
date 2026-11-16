// The README and LICENSE live at the repository root, where GitHub shows
// them. npm takes them from the package folder, so packing copies them in
// first (prepack) and removes the copies afterward (postpack).
//
// Usage: node scripts/root-files.mjs copy|remove

import { copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(packageDir, "..", "..");
const FILES = ["README.md", "LICENSE"];

const action = process.argv[2];
if (action === "copy") {
  for (const name of FILES) {
    copyFileSync(join(repoDir, name), join(packageDir, name));
  }
} else if (action === "remove") {
  for (const name of FILES) {
    rmSync(join(packageDir, name), { force: true });
  }
} else {
  console.error("Usage: node scripts/root-files.mjs copy|remove");
  process.exit(2);
}
