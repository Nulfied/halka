// Building a registry's index from its archives. spec/PACKAGES.md P5.
//
// The archives are the registry. Every index file is derived from them by
// reading each one's manifest and hashing its bytes, and nothing about a
// published version is written down anywhere else.
//
// That is the whole design. An index that is *maintained* alongside the
// archives can disagree with them -- a hash that was pasted wrong, a
// dependency edited in one place and not the other, a version listed that
// was never uploaded -- and every one of those disagreements is discovered
// by somebody's build failing. An index that is *derived* cannot disagree,
// and a submission is then one file: the archive.
//
// The same function serves `--check` in CI, which rebuilds the index and
// fails if what is committed differs.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readTarGz, stripRootDir } from "./archive.ts";
import { parseManifest } from "./manifest.ts";
import { formatReq } from "./semver.ts";
import { type Version, compareVersions, formatVersion, parseVersion } from "./semver.ts";
import { sha256 } from "./registry.ts";

export interface BuiltVersion {
  version: Version;
  sha256: string;
  deps: Record<string, string>;
  description: string;
  license: string;
}

export interface BuiltIndex {
  name: string;
  versions: BuiltVersion[];
}

export interface BuildResult {
  /** The index files to write, keyed by path relative to the registry root. */
  files: Map<string, string>;
  packages: BuiltIndex[];
  problems: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Read one archive and say what the index should record for it.
 *
 * Everything here is checked against the archive rather than against what
 * the submission claims, because the archive is the only thing a consumer
 * will ever download.
 */
function readArchive(
  buf: Buffer, name: string, version: Version, where: string, problems: string[],
): BuiltVersion | null {
  let entries;
  try {
    entries = stripRootDir(readTarGz(buf));
  } catch (e) {
    problems.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const manifestEntry = entries.find((f) => f.path === "halka.pkg");
  if (!manifestEntry) {
    problems.push(`${where}: the archive has no halka.pkg at its root`);
    return null;
  }
  const { manifest, errors } = parseManifest(manifestEntry.data.toString("utf8"), `${where}:halka.pkg`);
  if (!manifest || errors.length) {
    problems.push(`${where}: halka.pkg does not parse — ${errors.map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
    return null;
  }

  // The path a package is served from is what a client asks for, so the two
  // have to agree or the client fetches one thing and gets another.
  if (manifest.name !== name) {
    problems.push(`${where}: the archive says it is \`${manifest.name}\`, but it is filed under \`${name}\``);
    return null;
  }
  if (formatVersion(manifest.version) !== formatVersion(version)) {
    problems.push(`${where}: the archive says version ${formatVersion(manifest.version)}, but it is filed as ${formatVersion(version)}`);
    return null;
  }
  if (manifest.deps.some((d) => d.path !== null)) {
    problems.push(`${where}: it depends on a path, which means nothing on anyone else's machine`);
    return null;
  }
  if (!manifest.license.trim()) {
    problems.push(`${where}: no license`);
    return null;
  }
  if (!manifest.description.trim()) {
    problems.push(`${where}: no description`);
    return null;
  }
  if (!entries.some((f) => f.path.startsWith("src/") && f.path.endsWith(".hk"))) {
    problems.push(`${where}: the archive has no .hk files under src/`);
    return null;
  }

  // Only what a consumer needs. Nobody installing this package builds its
  // tests, so its dev dependencies are not part of anyone else's graph.
  const deps: Record<string, string> = {};
  for (const d of manifest.deps.filter((x) => !x.dev && x.req).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    deps[d.name] = formatReq(d.req!);
  }

  return {
    version,
    sha256: sha256(buf),
    deps,
    description: manifest.description,
    license: manifest.license,
  };
}

/** Serialise one package's index, in the shape the client parses (P5). */
export function indexJson(pkg: BuiltIndex): string {
  const versions = pkg.versions.map((v) => ({
    version: formatVersion(v.version),
    sha256: v.sha256,
    deps: v.deps,
    description: v.description,
    license: v.license,
  }));
  return JSON.stringify({ name: pkg.name, versions }, null, 2) + "\n";
}

/**
 * Rebuild every index file from the archives under `root/pkg`.
 *
 * Returns what the files should contain rather than writing them, so the
 * same call serves the build and the check.
 */
export function buildRegistry(root: string): BuildResult {
  const problems: string[] = [];
  const packages: BuiltIndex[] = [];
  const pkgRoot = join(root, "pkg");
  if (!existsSync(pkgRoot)) {
    return { files: new Map(), packages, problems: [`there is no pkg/ directory in ${root}`] };
  }

  for (const name of readdirSync(pkgRoot).sort()) {
    const dir = join(pkgRoot, name);
    if (!statSync(dir).isDirectory()) {
      problems.push(`pkg/${name}: not a directory; every package is a directory of archives`);
      continue;
    }
    if (!NAME_RE.test(name)) {
      problems.push(`pkg/${name}: not a valid package name (lowercase letters, digits and \`-\`, starting with a letter)`);
      continue;
    }

    const versions: BuiltVersion[] = [];
    for (const file of readdirSync(dir).sort()) {
      const where = `pkg/${name}/${file}`;
      const m = /^(.+)\.tar\.gz$/.exec(file);
      if (!m) {
        problems.push(`${where}: a registry holds only .tar.gz archives`);
        continue;
      }
      const version = parseVersion(m[1]!);
      if (!version) {
        problems.push(`${where}: \`${m[1]}\` is not a version`);
        continue;
      }
      const built = readArchive(readFileSync(join(dir, file)), name, version, where, problems);
      if (built) versions.push(built);
    }

    if (!versions.length) continue;
    versions.sort((a, b) => compareVersions(a.version, b.version));
    packages.push({ name, versions });
  }

  const files = new Map<string, string>();
  for (const p of packages) files.set(`index/${p.name}.json`, indexJson(p));
  return { files, packages, problems };
}

/**
 * Compare a built registry against what is on disk. Used by CI: an index
 * that was edited by hand, or a submission whose index was never rebuilt,
 * is a registry that lies about its own contents.
 */
export function checkRegistry(root: string, built: BuildResult): string[] {
  const wrong: string[] = [];
  for (const [rel, want] of built.files) {
    const path = join(root, rel);
    if (!existsSync(path)) { wrong.push(`${rel} is missing — rebuild the index`); continue; }
    if (readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== want) wrong.push(`${rel} is not what the archives say it should be`);
  }
  const indexDir = join(root, "index");
  if (existsSync(indexDir)) {
    for (const file of readdirSync(indexDir).sort()) {
      if (!built.files.has(`index/${file}`)) wrong.push(`index/${file} has no archives behind it`);
    }
  }
  return wrong;
}
