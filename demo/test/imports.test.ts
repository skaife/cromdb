// The demo uses CromDB exactly as a user gets it: through the "cromdb"
// package and nothing else from this repo.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const demoDir = join(import.meta.dirname, "..");
const repoDir = join(demoDir, "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRS = new Set(["node_modules", "data", "dist"]);

interface PackageJson {
  private?: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackage(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
}

function dependencyNames(pkg: PackageJson): string[] {
  return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((deps) =>
    Object.keys(deps ?? {}),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".") ? [] : sourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

/** Every module specifier in the source: static and dynamic imports, re-exports and requires. */
function specifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] as string));
}

/** Why file may not import specifier, or undefined if it may. */
function importProblem(specifier: string, file: string, allowedPackages: readonly string[]): string | undefined {
  if (specifier.startsWith("node:")) {
    return undefined;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = relative(demoDir, resolve(dirname(file), specifier));
    // On Windows, a path on another drive comes back absolute.
    if (target.startsWith("..") || isAbsolute(target)) {
      return "reaches outside demo/";
    }
    if (target.split(sep).includes("node_modules")) {
      return "reaches into node_modules";
    }
    return undefined;
  }
  if (specifier.startsWith("/") || /^[a-zA-Z]:/.test(specifier) || specifier.startsWith("file:")) {
    return "is an absolute path";
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
  if (name === "cromdb" && specifier !== "cromdb") {
    return 'imports a path inside cromdb; use "cromdb" itself';
  }
  if (!allowedPackages.includes(name)) {
    return "is not a dependency of the demo";
  }
  return undefined;
}

describe("the demo's imports", () => {
  const pkg = readPackage(demoDir);
  const allowed = dependencyNames(pkg);

  it("come only from demo/, node: modules, cromdb and the demo's own dependencies", () => {
    const files = sourceFiles(demoDir);
    assert.ok(files.length >= 8, `found only ${files.length} files`);
    const problems = files.flatMap((file) =>
      specifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
        const problem = importProblem(specifier, file, allowed);
        return problem === undefined ? [] : [`${relative(demoDir, file)}: "${specifier}" ${problem}`];
      }),
    );
    assert.deepEqual(problems, []);
  });

  it("are checked by a rule that catches each way around it", () => {
    const file = join(demoDir, "server", "app.ts");
    const source = readFileSync(join(import.meta.dirname, "fixtures", "forbidden-imports.txt"), "utf8");
    const found = specifiers(source);
    assert.equal(found.length, 6);
    for (const specifier of found) {
      assert.notEqual(importProblem(specifier, file, allowed), undefined, specifier);
    }
    for (const specifier of ["cromdb", "express", "node:fs", "./sync.ts", "../server/identities.ts"]) {
      assert.equal(importProblem(specifier, file, allowed), undefined, specifier);
    }
  });

  it("resolve cromdb through the package's exports, to the built package", () => {
    assert.equal(import.meta.resolve("cromdb"), pathToFileURL(join(repoDir, "dist", "index.js")).href);
  });
});

describe("the demo's package", () => {
  const pkg = readPackage(demoDir);

  it("is private, an ES module, and links cromdb from this repo", () => {
    assert.equal(pkg.private, true);
    assert.equal(pkg.type, "module");
    assert.equal(pkg.dependencies?.cromdb, "file:..");
  });

  it("doesn't depend on better-sqlite3", () => {
    assert.ok(!dependencyNames(pkg).includes("better-sqlite3"));
  });

  it("adds none of its dependencies to cromdb's", () => {
    const library = readPackage(repoDir);
    const libraryDeps = [library.dependencies, library.peerDependencies, library.optionalDependencies].flatMap((deps) =>
      Object.keys(deps ?? {}),
    );
    for (const name of dependencyNames(pkg)) {
      assert.ok(!libraryDeps.includes(name), name);
    }
  });

  it("type checks only demo/", () => {
    const text = readFileSync(join(demoDir, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(text) as { include?: string[]; files?: string[]; compilerOptions?: Record<string, unknown> };
    for (const entry of [...(config.include ?? []), ...(config.files ?? [])]) {
      assert.ok(!resolve(demoDir, entry).startsWith(resolve(repoDir, "src")), entry);
      assert.ok(!relative(demoDir, resolve(demoDir, entry)).startsWith(".."), entry);
    }
    for (const option of ["paths", "baseUrl", "rootDirs"]) {
      assert.ok(!Object.hasOwn(config.compilerOptions ?? {}, option), option);
    }
  });
});
