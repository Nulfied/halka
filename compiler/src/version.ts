// The toolchain's version, read from package.json so there is one source.
//
// It used to be written out in three places — here, the VS Code extension,
// and the language server — and they drifted: the README announced v0.2
// while every one of them still said 0.1.0. A number copied by hand is a
// number that goes stale, so this reads the real one.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/version.ts and dist/version.js sit at different depths.
  for (const rel of [["..", "package.json"], ["..", "..", "package.json"]]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, ...rel), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "halka-lang" && pkg.version) return pkg.version;
    } catch { /* try the next layout */ }
  }
  // Reachable only if the package metadata is missing, which means someone
  // is running from a tree that was not installed. Better than throwing.
  return "0.0.0-unknown";
}

export const VERSION = readVersion();
