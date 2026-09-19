// The package registry and the on-disk cache. spec/PACKAGES.md P5 and P6.
//
// The registry is a static file tree, which is why it costs nothing to host:
//
//   <registry>/index/<name>.json        every published version
//   <registry>/pkg/<name>/<ver>.tar.gz  the archive
//
// Nothing here executes anything on a package's behalf. There is no install
// script, no build script and no post-install hook, because that is the most
// reliably exploited part of every ecosystem that has one.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Req, type Version, formatVersion, parseReq, parseVersion } from "./semver.ts";
import type { PackageSource } from "./resolve.ts";
import { extractTo, readTarGz, stripRootDir } from "./archive.ts";

export const DEFAULT_REGISTRY = "https://nulfied.github.io/halka-registry";

export interface IndexVersion {
  version: Version;
  sha256: string;
  deps: { name: string; req: Req }[];
}

export interface PackageIndex {
  name: string;
  versions: IndexVersion[];
}

export function registryRoot(): string {
  return process.env["HALKA_REGISTRY"] ?? DEFAULT_REGISTRY;
}

export function cacheRoot(): string {
  return process.env["HALKA_CACHE"] ?? join(homedir(), ".halka", "cache");
}

export function packageDir(name: string, version: Version): string {
  return join(cacheRoot(), "pkg", name, formatVersion(version));
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Parse the JSON an index file holds, rejecting anything malformed. */
export function parseIndex(text: string, name: string): PackageIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { name?: unknown; versions?: unknown };
  if (obj.name !== name || !Array.isArray(obj.versions)) return null;

  const versions: IndexVersion[] = [];
  for (const entry of obj.versions) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as { version?: unknown; sha256?: unknown; deps?: unknown };
    if (typeof e.version !== "string" || typeof e.sha256 !== "string") return null;
    const version = parseVersion(e.version);
    if (!version) return null;
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) return null;

    const deps: { name: string; req: Req }[] = [];
    if (e.deps !== undefined) {
      if (typeof e.deps !== "object" || e.deps === null || Array.isArray(e.deps)) return null;
      for (const [dep, spec] of Object.entries(e.deps as Record<string, unknown>)) {
        if (typeof spec !== "string") return null;
        const req = parseReq(spec);
        if (!req) return null;
        deps.push({ name: dep, req });
      }
    }
    versions.push({ version, sha256: e.sha256, deps });
  }
  return { name, versions };
}

/**
 * Reads index files, over the network or from a local directory, and caches
 * what it reads for the life of the process.
 *
 * `HALKA_REGISTRY` may be a `file:` URL or a plain path, which is how the
 * tests run against a fixture registry without touching the network.
 */
export class Registry implements PackageSource {
  private root: string;
  private indexes = new Map<string, PackageIndex | null>();
  private offline: boolean;

  constructor(root = registryRoot(), offline = false) {
    this.root = root.replace(/\/+$/, "");
    this.offline = offline;
  }

  private localPath(rel: string): string | null {
    if (/^https?:\/\//.test(this.root)) return null;
    const base = this.root.startsWith("file:") ? new URL(this.root).pathname.replace(/^\/([A-Za-z]:)/, "$1") : this.root;
    return join(base, rel);
  }

  /** Index reads are synchronous; `prefetch` fills the cache before resolving. */
  index(name: string): PackageIndex | null {
    if (this.indexes.has(name)) return this.indexes.get(name) ?? null;
    const rel = join("index", `${name}.json`);
    const local = this.localPath(rel);
    let text: string | null = null;
    if (local !== null) {
      text = existsSync(local) ? readFileSync(local, "utf8") : null;
    } else {
      text = readCachedIndex(this.root, name);
    }
    const parsed = text === null ? null : parseIndex(text, name);
    this.indexes.set(name, parsed);
    return parsed;
  }

  versions(name: string): Version[] | null {
    const ix = this.index(name);
    return ix ? ix.versions.map((v) => v.version) : null;
  }

  requirements(name: string, version: Version): { name: string; req: Req }[] | null {
    const ix = this.index(name);
    if (!ix) return null;
    const want = formatVersion(version);
    const found = ix.versions.find((v) => formatVersion(v.version) === want);
    return found ? found.deps : null;
  }

  entry(name: string, version: Version): IndexVersion | null {
    const ix = this.index(name);
    if (!ix) return null;
    const want = formatVersion(version);
    return ix.versions.find((v) => formatVersion(v.version) === want) ?? null;
  }

  /** Download index files for these names, so `index()` can stay synchronous. */
  async prefetch(names: string[]): Promise<{ failures: string[] }> {
    const failures: string[] = [];
    if (this.localPath("index") !== null) return { failures };
    for (const name of names) {
      if (cachedIndexPath(this.root, name) && readCachedIndex(this.root, name) !== null) continue;
      if (this.offline) { failures.push(`${name} (offline, and it is not in the cache)`); continue; }
      try {
        const res = await fetch(`${this.root}/index/${encodeURIComponent(name)}.json`);
        if (!res.ok) { failures.push(`${name} (the registry answered ${res.status})`); continue; }
        writeCachedIndex(this.root, name, await res.text());
      } catch (e) {
        failures.push(`${name} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return { failures };
  }

  /**
   * Put a package in the cache, verifying it against `expected` if given.
   * Returns the directory it was extracted to.
   */
  async fetchPackage(name: string, version: Version, expected: string | null): Promise<{ dir: string; sha256: string }> {
    const dir = packageDir(name, version);
    const stamp = join(dir, ".halka-sha256");
    if (existsSync(stamp)) {
      const have = readFileSync(stamp, "utf8").trim();
      if (expected === null || have === expected) return { dir, sha256: have };
      // A cached copy that does not match the lockfile is discarded rather
      // than trusted; the hash is the thing that decides, not the cache.
      rmSync(dir, { recursive: true, force: true });
    }

    const rel = join("pkg", name, `${formatVersion(version)}.tar.gz`);
    const local = this.localPath(rel);
    let buf: Buffer;
    if (local !== null) {
      if (!existsSync(local)) throw new Error(`\`${name}\` ${formatVersion(version)} is not in the registry at ${this.root}`);
      buf = readFileSync(local);
    } else {
      if (this.offline) throw new Error(`\`${name}\` ${formatVersion(version)} is not in the cache, and --offline was given`);
      const url = `${this.root}/pkg/${encodeURIComponent(name)}/${encodeURIComponent(formatVersion(version))}.tar.gz`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`could not download \`${name}\` ${formatVersion(version)}: the registry answered ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    }

    const digest = sha256(buf);
    if (expected !== null && digest !== expected) {
      throw new Error(
        `\`${name}\` ${formatVersion(version)} does not match the lockfile.\n` +
        `  expected sha256 ${expected}\n` +
        `  got      sha256 ${digest}\n` +
        `  The archive in the registry is not the one this project was locked against. ` +
        `Nothing has been installed.`,
      );
    }

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    extractTo(stripRootDir(readTarGz(buf)), dir);
    writeFileSync(stamp, digest + "\n");
    return { dir, sha256: digest };
  }
}

// ---------------------------------------------------------------------------
// index cache on disk
// ---------------------------------------------------------------------------

function registryKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function cachedIndexPath(root: string, name: string): string {
  return join(cacheRoot(), "index", registryKey(root), `${name}.json`);
}

function readCachedIndex(root: string, name: string): string | null {
  const p = cachedIndexPath(root, name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function writeCachedIndex(root: string, name: string, text: string): void {
  const p = cachedIndexPath(root, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

/** Forget every downloaded index, so the next resolve sees new publishes. */
export function clearIndexCache(): void {
  const dir = join(cacheRoot(), "index");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Every package version currently in the cache, for `halka pkg cache`. */
export function cachedPackages(): { name: string; version: string }[] {
  const base = join(cacheRoot(), "pkg");
  if (!existsSync(base)) return [];
  const out: { name: string; version: string }[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    for (const version of readdirSync(dir)) out.push({ name, version });
  }
  return out;
}
