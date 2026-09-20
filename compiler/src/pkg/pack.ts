// Turning a project into a publishable archive. spec/PACKAGES.md P5.
//
// Publishing is the one moment where a mistake is permanent: a version in a
// registry is immutable, because a lockfile records its hash and thousands
// of builds may already be pinned to it. So this refuses more than it
// forgives. It will not pack a package that depends on a path, that has no
// license, that carries a file nobody asked for, or that is large enough to
// suggest something was swept in by accident.
//
// What goes in is decided by a list, not by exclusion. An ignore list gets
// this wrong the first time someone adds a directory nobody thought of --
// and the failure mode is a published archive with somebody's `.env` in it,
// which cannot be taken back.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { type ArchiveEntry, writeTarGz } from "./archive.ts";
import { type Manifest, parseManifest } from "./manifest.ts";
import { formatVersion } from "./semver.ts";

/** An archive this size is nearly always a mistake, so it is refused. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

/** And this many files. */
export const MAX_FILES = 500;

/**
 * Files taken from the project root, matched case-insensitively. Everything
 * else at the root is left out: a package is source code and the terms it
 * comes under, and nothing at all is executed on its behalf (P5).
 */
const ROOT_FILES = [
  /^halka\.pkg$/i,
  /^readme(\.md|\.txt)?$/i,
  /^licen[cs]e(-[a-z0-9]+)?(\.md|\.txt)?$/i,
  /^changelog(\.md|\.txt)?$/i,
];

export interface PackResult {
  manifest: Manifest;
  /** Paths inside the archive, each prefixed `<name>-<version>/`. */
  files: string[];
  archive: Buffer;
}

export class PackError extends Error {}

/** Every `.hk` file under `dir`, relative to it, in a fixed order. */
function sourceFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    // A dotfile in `src` is not source, and is the usual way a secret or an
    // editor's scratch file ends up somewhere it was never meant to go.
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full, base));
    else if (name.endsWith(".hk")) out.push(relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * Read the project at `dir` and build its archive.
 *
 * The archive lays the package out as `<name>-<version>/...`, which is what
 * the fetch path strips on extraction (`stripRootDir`), so an archive that
 * someone downloads and unpacks by hand lands in a directory named after
 * itself rather than all over their working directory.
 */
export function packProject(dir: string): PackResult {
  const manifestPath = join(dir, "halka.pkg");
  if (!existsSync(manifestPath)) {
    throw new PackError(`there is no halka.pkg in ${dir} — a package is packed from its project directory`);
  }
  const { manifest, errors } = parseManifest(readFileSync(manifestPath, "utf8"), manifestPath);
  if (!manifest || errors.length) {
    throw new PackError(
      `halka.pkg has errors, and a package is published exactly as it is read:\n` +
      errors.map((e) => `  line ${e.line}: ${e.message}`).join("\n"));
  }

  // A path dependency names a directory on the machine that built it, which
  // means nothing to anyone who downloads this (P5).
  const paths = manifest.deps.filter((d) => d.path !== null);
  if (paths.length) {
    throw new PackError(
      `\`${manifest.name}\` depends on ${paths.map((d) => `\`${d.name}\``).join(", ")} by path, ` +
      `which cannot be published — a path means nothing on anyone else's machine.\n` +
      `  Publish ${paths.length === 1 ? "it" : "those"} first, then depend on ${paths.length === 1 ? "a version" : "versions"}.`);
  }
  if (!manifest.license.trim()) {
    throw new PackError(
      `\`${manifest.name}\` has no \`license\` in halka.pkg.\n` +
      `  Without one nobody can tell what they are allowed to do with it.`);
  }
  if (!manifest.description.trim()) {
    throw new PackError(`\`${manifest.name}\` has no \`description\` in halka.pkg — it is the only thing a listing can show.`);
  }

  const srcDir = join(dir, "src");
  if (!existsSync(srcDir)) {
    throw new PackError(`\`${manifest.name}\` has no src/ directory — that is where a package's modules live (#33)`);
  }
  const sources = sourceFiles(srcDir);
  if (sources.length === 0) {
    throw new PackError(`\`${manifest.name}\` has no .hk files under src/`);
  }

  const root = `${manifest.name}-${formatVersion(manifest.version)}`;
  const entries: ArchiveEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!ROOT_FILES.some((re) => re.test(name))) continue;
    if (statSync(join(dir, name)).isDirectory()) continue;
    entries.push({ path: `${root}/${name}`, data: readFileSync(join(dir, name)) });
  }
  for (const rel of sources) {
    entries.push({ path: `${root}/src/${rel}`, data: readFileSync(join(srcDir, rel)) });
  }

  if (entries.length > MAX_FILES) {
    throw new PackError(`\`${manifest.name}\` would publish ${entries.length} files, which is past the limit of ${MAX_FILES}`);
  }
  const archive = writeTarGz(entries);
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new PackError(
      `the archive is ${(archive.length / 1024).toFixed(0)} KiB, past the limit of ${MAX_ARCHIVE_BYTES / 1024} KiB.\n` +
      `  A Halka package is source; something large is usually a file that was swept in by accident.`);
  }

  return { manifest, files: entries.map((e) => e.path), archive };
}
