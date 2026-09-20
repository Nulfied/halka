// Incremental builds: skipping work that provably has not changed.
//
// Not separate compilation. R23.5 links every module into one unit before
// any C is emitted, which is what lets generics monomorphise and names be
// rewritten across module boundaries; splitting the output into per-module
// object files would undo that. So the granularity available here is the
// whole build, and the question is whether it can be skipped.
//
// It can, when every input is identical to last time. "Every input" has to
// be complete or the cache is worse than none: the sources, the runtime C
// that gets compiled alongside them, the flags, and the compiler's own
// version, because a new compiler emits different C from the same source.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readRuntimeSource } from "../backend/c/build.ts";

/**
 * A digest of the compiler's own source.
 *
 * The version number alone is not enough. It changes once per release,
 * while the emitter changes many times in between — so editing the backend
 * and rebuilding handed back the binary from *before* the edit and called
 * it up to date. Anyone working on the compiler hits that within a minute,
 * which is exactly how it was found.
 */
let compilerDigest: string | null = null;

function digestCompiler(): string {
  if (compilerDigest) return compilerDigest;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) {
        h.update(e.name);
        h.update(readFileSync(full));
      }
    }
  };
  try {
    walk(root);
  } catch {
    // An installed build may ship compiled output rather than sources; the
    // version then carries the difference on its own.
    h.update("no-sources");
  }
  compilerDigest = h.digest("hex");
  return compilerDigest;
}

/** Everything that, if changed, must produce a different binary. */
export interface BuildInputs {
  /** Every module's source, keyed by absolute path. */
  sources: Map<string, string>;
  /** The flags the binary was built with, in a stable order. */
  flags: string[];
  /** The compiler version: a new one emits different C from the same input. */
  version: string;
}

export function stampFor(inputs: BuildInputs): string {
  const h = createHash("sha256");
  h.update("halka-build-v2\n");
  h.update(inputs.version + "\n");
  h.update(digestCompiler() + "\n");
  for (const f of [...inputs.flags].sort()) h.update("flag:" + f + "\n");
  // Sorted, so the order modules happened to be discovered in does not
  // change the stamp.
  for (const path of [...inputs.sources.keys()].sort()) {
    h.update("src:" + path + "\n");
    h.update(inputs.sources.get(path) ?? "");
    h.update("\n");
  }
  const rt = readRuntimeSource();
  h.update("runtime.h\n");
  h.update(rt.h);
  h.update("runtime.c\n");
  h.update(rt.c);
  return h.digest("hex");
}

function stampPath(out: string): string { return out + ".halka-build"; }

/**
 * Is the binary at `out` already the product of exactly these inputs?
 *
 * The binary itself has to exist and be newer than nothing else — the stamp
 * is only trusted alongside a real output, so deleting the binary forces a
 * rebuild the way anyone would expect.
 */
export function isUpToDate(out: string, stamp: string): boolean {
  const p = stampPath(out);
  if (!existsSync(out) || !existsSync(p)) return false;
  try {
    if (readFileSync(p, "utf8").trim() !== stamp) return false;
    // A zero-length binary is a failed link someone interrupted.
    return statSync(out).size > 0;
  } catch {
    return false;
  }
}

export function writeStamp(out: string, stamp: string): void {
  try {
    writeFileSync(stampPath(out), stamp + "\n", "utf8");
  } catch {
    // A build that succeeded must not fail because the stamp could not be
    // written; the only cost is that the next build repeats the work.
  }
}
