// Tying the manifest, the resolver, the lockfile and the cache together.
// This is what the CLI and module resolution both talk to.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

import { type Manifest, parseManifest } from "./manifest.ts";
import { type Lockfile, LOCK_FORMAT, formatLock, parseLock } from "./lock.ts";
import { type Selection, resolve as mvs } from "./resolve.ts";
import { Registry, packageDir } from "./registry.ts";
import { formatVersion, type Version } from "./semver.ts";

export const MANIFEST_NAME = "halka.pkg";
export const LOCK_NAME = "halka.lock";

/**
 * Module names the prelude already occupies. A dependency may not take one.
 *
 * Without this rule `import json` means the built-in module when the package
 * is not installed and the package once it is, so identical source would do
 * two different things depending on the state of a cache. Refusing the name
 * is the only version of this that cannot quietly surprise someone.
 */
export const BUILTIN_MODULES = new Set([
  "math", "strings", "lists", "maps", "io", "time", "os", "json",
]);

export interface Project {
  dir: string;
  manifest: Manifest;
  lock: Lockfile | null;
}

export class ProjectError extends Error {}

/** Walk up from `from` looking for a manifest. Returns null outside a project. */
export function findProjectDir(from: string): string | null {
  let dir = resolvePath(from);
  for (;;) {
    if (existsSync(join(dir, MANIFEST_NAME))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadProject(dir: string): Project {
  const manifestPath = join(dir, MANIFEST_NAME);
  const { manifest, errors } = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
  if (!manifest) {
    const lines = errors.map((e) => `  ${MANIFEST_NAME}:${e.line}: ${e.message}`);
    throw new ProjectError(`${manifestPath} could not be read:\n${lines.join("\n")}`);
  }

  const shadowing = manifest.deps.filter((d) => BUILTIN_MODULES.has(d.name));
  if (shadowing.length > 0) {
    throw new ProjectError(
      `${manifestPath} depends on ${shadowing.map((d) => `\`${d.name}\``).join(", ")}, ` +
      `which ${shadowing.length === 1 ? "is the name of a built-in module" : "are names of built-in modules"}.\n` +
      `  A package cannot take a name the prelude already uses — \`import ${shadowing[0]!.name}\` ` +
      `would mean different things depending on whether the package happened to be installed.`,
    );
  }

  const lockPath = join(dir, LOCK_NAME);
  let lock: Lockfile | null = null;
  if (existsSync(lockPath)) {
    const parsed = parseLock(readFileSync(lockPath, "utf8"), lockPath);
    if (!parsed.lock) {
      const lines = parsed.errors.map((e) => `  ${LOCK_NAME}:${e.line}: ${e.message}`);
      throw new ProjectError(
        `${lockPath} could not be read:\n${lines.join("\n")}\n` +
        `  Delete it and run \`halka install\` to write a fresh one.`,
      );
    }
    lock = parsed.lock;
  }
  return { dir, manifest, lock };
}

export interface ResolvedDep {
  name: string;
  version: Version;
  /** Where its source lives, once installed. */
  dir: string;
  source: "registry" | "path";
  sha256: string;
}

export interface SyncOptions {
  /** Include `dev-deps`. */
  dev: boolean;
  /** Never touch the network; fail if something is missing from the cache. */
  offline: boolean;
  /** Resolve afresh rather than honouring the lockfile's pins. */
  update: boolean;
  registry?: Registry;
}

/**
 * Bring the cache in line with the manifest and return where each dependency
 * landed. Writes `halka.lock` when resolution produced something new.
 */
export async function sync(project: Project, opts: SyncOptions): Promise<ResolvedDep[]> {
  const registry = opts.registry ?? new Registry(undefined, opts.offline);
  const wanted = project.manifest.deps.filter((d) => opts.dev || !d.dev);

  const out: ResolvedDep[] = [];
  const pathDeps = wanted.filter((d) => d.path !== null);
  for (const d of pathDeps) {
    const dir = isAbsolute(d.path!) ? d.path! : resolvePath(project.dir, d.path!);
    if (!existsSync(join(dir, MANIFEST_NAME))) {
      throw new ProjectError(
        `\`${d.name}\` points at ${dir}, which has no ${MANIFEST_NAME}.\n` +
        `  A path dependency must be a Halka project directory.`,
      );
    }
    const sub = loadProject(dir);
    if (sub.manifest.name !== d.name) {
      throw new ProjectError(
        `\`${d.name}\` points at ${dir}, but the package there is called \`${sub.manifest.name}\`.`,
      );
    }
    out.push({ name: d.name, version: sub.manifest.version, dir, source: "path", sha256: "" });
  }

  const registryDeps = wanted.filter((d) => d.path === null);
  if (registryDeps.length === 0) {
    writeLock(project, out);
    return out;
  }

  // Honour the lockfile unless asked to update: a build should not change
  // because someone published something.
  const pinned = new Map<string, { version: Version; sha256: string }>();
  if (project.lock && !opts.update) {
    for (const e of project.lock.entries) {
      if (e.source === "registry") pinned.set(e.name, { version: e.version, sha256: e.sha256 });
    }
  }

  let selections: Selection[];
  const allPinned = registryDeps.every((d) => pinned.has(d.name));
  if (allPinned && project.lock && !opts.update) {
    // Everything the manifest asks for is already pinned; take the lockfile
    // wholesale so transitive pins are honoured too.
    selections = project.lock.entries
      .filter((e) => e.source === "registry")
      .map((e) => ({ name: e.name, version: e.version }));
  } else {
    const failures = (await registry.prefetch(registryDeps.map((d) => d.name))).failures;
    if (failures.length > 0) {
      throw new ProjectError(`could not read the registry:\n${failures.map((f) => `  ${f}`).join("\n")}`);
    }
    // Transitive names are not known until resolution walks the graph, so it
    // runs against the prefetched set and asks for more as it discovers them.
    let result = mvs(registryDeps.map((d) => ({ name: d.name, req: d.req! })), registry);
    for (let round = 0; round < 16 && result.errors.length > 0; round++) {
      const missing = result.errors
        .map((e) => /^no package named `([^`]+)`/.exec(e.message)?.[1])
        .filter((n): n is string => !!n);
      if (missing.length === 0) break;
      const more = await registry.prefetch(missing);
      if (more.failures.length === missing.length) break;
      result = mvs(registryDeps.map((d) => ({ name: d.name, req: d.req! })), registry);
    }
    if (result.errors.length > 0) {
      throw new ProjectError(result.errors.map((e) => e.message).join("\n\n"));
    }
    selections = result.selections;
  }

  for (const s of selections) {
    const expected = pinned.get(s.name)?.sha256 ?? registry.entry(s.name, s.version)?.sha256 ?? null;
    const got = await registry.fetchPackage(s.name, s.version, expected);
    out.push({ name: s.name, version: s.version, dir: got.dir, source: "registry", sha256: got.sha256 });
  }

  writeLock(project, out);
  return out;
}

function writeLock(project: Project, deps: ResolvedDep[]): void {
  const lock: Lockfile = {
    format: LOCK_FORMAT,
    entries: deps.map((d) => ({
      name: d.name,
      version: d.version,
      source: d.source,
      sha256: d.sha256,
      path: d.source === "path" ? d.dir : "",
    })),
  };
  const text = formatLock(lock);
  const lockPath = join(project.dir, LOCK_NAME);
  // Avoid rewriting an identical file so builds do not dirty the worktree.
  if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === text) return;
  writeFileSync(lockPath, text);
}

/**
 * The directories module resolution should search for a project's
 * dependencies: each package's `src`, or its root if it has no `src`.
 */
export function moduleSearchPath(deps: ResolvedDep[]): string[] {
  const out: string[] = [];
  for (const d of deps) {
    const src = join(d.dir, "src");
    out.push(existsSync(src) ? src : d.dir);
  }
  return out;
}

/** The search path for a source file, when it happens to sit in a project. */
export function projectSearchPath(file: string): string[] {
  const dir = findProjectDir(dirname(resolvePath(file)));
  if (!dir) return [];
  let project: Project;
  try {
    project = loadProject(dir);
  } catch {
    return []; // a broken manifest is reported by `halka check`, not here
  }
  if (!project.lock) return [join(dir, "src")].filter((p) => existsSync(p));

  const dirs: string[] = [];
  const src = join(dir, "src");
  if (existsSync(src)) dirs.push(src);
  for (const e of project.lock.entries) {
    const base = e.source === "path" ? e.path : packageDir(e.name, e.version);
    if (!base) continue;
    const pkgSrc = join(base, "src");
    if (existsSync(pkgSrc)) dirs.push(pkgSrc);
    else if (existsSync(base)) dirs.push(base);
  }
  return dirs;
}

/**
 * Dependencies the lockfile names that are not in the cache. A fresh clone
 * has this state, and without a check for it an `import` quietly falls back
 * to whatever else the search path can reach, which is far worse than an
 * error message.
 */
export function missingPackages(file: string): { names: string[]; projectDir: string } | null {
  const dir = findProjectDir(dirname(resolvePath(file)));
  if (!dir) return null;
  let project: Project;
  try {
    project = loadProject(dir);
  } catch {
    return null; // a broken manifest is reported by its own diagnostic
  }
  if (!project.lock) {
    // No lockfile at all, but dependencies are declared: nothing is installed.
    const declared = project.manifest.deps.filter((d) => !d.dev).map((d) => d.name);
    return declared.length ? { names: declared, projectDir: dir } : null;
  }
  const names: string[] = [];
  for (const e of project.lock.entries) {
    const base = e.source === "path" ? e.path : packageDir(e.name, e.version);
    if (!base || !existsSync(base)) names.push(e.name);
  }
  return names.length ? { names, projectDir: dir } : null;
}

export function describeSelection(deps: ResolvedDep[]): string {
  if (deps.length === 0) return "no dependencies";
  return deps
    .map((d) => `${d.name} ${formatVersion(d.version)}${d.source === "path" ? " (path)" : ""}`)
    .join(", ");
}
