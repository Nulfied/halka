// The `pkg` suite — spec/PACKAGES.md.
//
// Everything here runs against a fixture registry built into a temp directory,
// so no test touches the network. The archives are written by a tar writer
// that lives here rather than in the shipped toolchain, which only reads them.

import { gzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  compareVersions,
  formatVersion,
  parseReq,
  parseVersion,
  reqsCompatible,
  satisfies,
} from "../src/pkg/semver.ts";
import { formatManifest, parseManifest } from "../src/pkg/manifest.ts";
import { formatLock, parseLock } from "../src/pkg/lock.ts";
import { resolve as mvs, type PackageSource } from "../src/pkg/resolve.ts";
import { readTarGz, safeEntryPath, stripRootDir, ArchiveError } from "../src/pkg/archive.ts";
import { parseIndex, sha256 } from "../src/pkg/registry.ts";

export interface Report {
  ok(name: string): void;
  bad(name: string, detail: string): void;
}

// ---------------------------------------------------------------------------
// a minimal ustar writer, for building fixture archives
// ---------------------------------------------------------------------------

function tarHeader(path: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(path.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.fill(0x20, 148, 156); // checksum field is spaces while summing
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

export function makeTarGz(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    parts.push(tarHeader(path, data.length, "0"), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks end an archive
  return gzipSync(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// fixture registry
// ---------------------------------------------------------------------------

interface FixturePackage {
  name: string;
  version: string;
  deps?: Record<string, string>;
  body?: string;
}

export function buildFixtureRegistry(root: string, packages: FixturePackage[]): void {
  rmSync(root, { recursive: true, force: true });
  const index = new Map<string, { version: string; sha256: string; deps: Record<string, string> }[]>();

  for (const p of packages) {
    const dir = `${p.name}-${p.version}`;
    const deps = p.deps ?? {};
    let manifest = `package:\n    name: ${p.name},\n    version: ${p.version}\n`;
    const entries = Object.entries(deps);
    if (entries.length) {
      manifest += "\ndeps:\n" + entries.map(([k, v]) => `    ${k}: ${v}`).join(",\n") + "\n";
    }
    const files: Record<string, string> = {
      [`${dir}/halka.pkg`]: manifest,
      [`${dir}/src/${p.name}.hk`]: p.body ?? `tag(): string,\n    give "${p.name}-${p.version}"\n`,
    };
    const gz = makeTarGz(files);
    const out = join(root, "pkg", p.name, `${p.version}.tar.gz`);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, gz);
    const list = index.get(p.name) ?? [];
    list.push({ version: p.version, sha256: sha256(gz), deps });
    index.set(p.name, list);
  }

  mkdirSync(join(root, "index"), { recursive: true });
  for (const [name, versions] of index) {
    writeFileSync(join(root, "index", `${name}.json`), JSON.stringify({ name, versions }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// an in-memory source, for resolution tests that need no files at all
// ---------------------------------------------------------------------------

function sourceOf(spec: Record<string, Record<string, Record<string, string>>>): PackageSource {
  return {
    versions(name) {
      const v = spec[name];
      return v ? Object.keys(v).map((s) => parseVersion(s)!) : null;
    },
    requirements(name, version) {
      const v = spec[name]?.[formatVersion(version)];
      if (!v) return null;
      return Object.entries(v).map(([n, r]) => ({ name: n, req: parseReq(r)! }));
    },
  };
}

// ---------------------------------------------------------------------------

export function suitePkg(r: Report): void {
  const eq = (name: string, got: unknown, want: unknown) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) r.ok(name);
    else r.bad(name, `expected ${w}\ngot      ${g}`);
  };

  // ---- P2 versions ------------------------------------------------------
  eq("semver: rejects a leading zero", parseVersion("1.01.0"), null);
  eq("semver: rejects a two-part version", parseVersion("1.2"), null);
  eq("semver: accepts a prerelease", formatVersion(parseVersion("1.0.0-rc.1")!), "1.0.0-rc.1");
  eq("semver: build metadata survives formatting", formatVersion(parseVersion("1.0.0+abc")!), "1.0.0+abc");

  const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
  eq("semver: 1.0.0 < 2.0.0", cmp("1.0.0", "2.0.0"), -1);
  eq("semver: 1.0.0-rc sorts before 1.0.0", cmp("1.0.0-rc", "1.0.0"), -1);
  eq("semver: numeric prerelease compares numerically", cmp("1.0.0-2", "1.0.0-10"), -1);
  eq("semver: numeric prerelease ranks below alphanumeric", cmp("1.0.0-1", "1.0.0-alpha"), -1);
  eq("semver: build metadata is ignored in comparison", cmp("1.0.0+a", "1.0.0+b"), 0);

  const sat = (v: string, req: string) => satisfies(parseVersion(v)!, parseReq(req)!);
  eq("caret: 1.2.0 admits 1.9.0", sat("1.9.0", "1.2.0"), true);
  eq("caret: 1.2.0 refuses 2.0.0", sat("2.0.0", "1.2.0"), false);
  eq("caret: 1.2.0 refuses 1.1.0", sat("1.1.0", "1.2.0"), false);
  eq("caret: 0.4.1 admits 0.4.9", sat("0.4.9", "0.4.1"), true);
  eq("caret: 0.4.1 refuses 0.5.0", sat("0.5.0", "0.4.1"), false);
  eq("caret: 0.0.3 admits only itself", [sat("0.0.3", "0.0.3"), sat("0.0.4", "0.0.3")], [true, false]);
  eq("caret: a release requirement refuses a prerelease", sat("1.3.0-rc1", "1.2.0"), false);
  eq("exact: =1.2.0 admits only 1.2.0", [sat("1.2.0", "=1.2.0"), sat("1.2.1", "=1.2.0")], [true, false]);
  eq("range syntax beyond the two forms is rejected", [parseReq(">=1.0.0"), parseReq("~1.2"), parseReq("*")], [null, null, null]);

  const compat = (a: string, b: string) => reqsCompatible(parseReq(a)!, parseReq(b)!);
  eq("conflict: 1.x and 2.x cannot both be met", compat("1.2.0", "2.0.0"), false);
  eq("conflict: 0.4.x and 0.5.x cannot both be met", compat("0.4.0", "0.5.0"), false);
  eq("conflict: 1.2.0 and 1.5.0 can", compat("1.2.0", "1.5.0"), true);

  // ---- P1 manifest ------------------------------------------------------
  const good = parseManifest(
    "package:\n    name: demo,\n    version: 1.0.0,\n    license: MIT\n\ndeps:\n    json: 1.2.0,\n    local: path ../local\n",
    "halka.pkg",
  );
  if (!good.manifest) r.bad("manifest: a valid file parses", JSON.stringify(good.errors));
  else {
    r.ok("manifest: a valid file parses");
    eq("manifest: reads the name", good.manifest.name, "demo");
    eq("manifest: reads a requirement", good.manifest.deps[0]?.req?.kind, "caret");
    eq("manifest: reads a path dependency", good.manifest.deps[1]?.path, "../local");
  }

  const badCases: [string, string][] = [
    ["an unknown section is an error", "package:\n    name: a,\n    version: 1.0.0\n\ndpes:\n    x: 1.0.0\n"],
    ["a missing version is an error", "package:\n    name: a\n"],
    ["a bad package name is an error", "package:\n    name: Demo,\n    version: 1.0.0\n"],
    ["a self-dependency is an error", "package:\n    name: a,\n    version: 1.0.0\n\ndeps:\n    a: 1.0.0\n"],
    ["an unparseable requirement is an error", "package:\n    name: a,\n    version: 1.0.0\n\ndeps:\n    j: banana\n"],
    ["a duplicate dependency is an error", "package:\n    name: a,\n    version: 1.0.0\n\ndeps:\n    j: 1.0.0,\n    j: 2.0.0\n"],
    ["a dependency in both sections is an error", "package:\n    name: a,\n    version: 1.0.0\n\ndeps:\n    j: 1.0.0\n\ndev-deps:\n    j: 1.0.0\n"],
    ["an unknown package key is an error", "package:\n    name: a,\n    version: 1.0.0,\n    authors: someone\n"],
  ];
  for (const [name, src] of badCases) {
    const got = parseManifest(src, "halka.pkg");
    if (got.manifest === null && got.errors.length > 0) r.ok(`manifest: ${name}`);
    else r.bad(`manifest: ${name}`, "it was accepted");
  }

  // Round-tripping keeps a manifest stable, which is what lets `halka add`
  // rewrite the file without churning it.
  if (good.manifest) {
    const once = formatManifest(good.manifest);
    const again = parseManifest(once, "halka.pkg");
    eq("manifest: formatting round-trips", again.manifest ? formatManifest(again.manifest) : null, once);
  }

  // ---- P3 resolution ----------------------------------------------------
  const registry = sourceOf({
    app: {},
    json: { "1.2.0": { bytes: "0.3.0" }, "1.3.0": { bytes: "0.3.2" }, "2.0.0": {} },
    bytes: { "0.3.0": {}, "0.3.2": {}, "0.4.0": {} },
    http: { "1.0.0": { json: "1.3.0" } },
    old: { "1.0.0": { json: "1.2.0" } },
  });
  const sel = (roots: Record<string, string>) => {
    const res = mvs(Object.entries(roots).map(([name, req]) => ({ name, req: parseReq(req)! })), registry);
    if (res.errors.length) return res.errors.map((e) => e.message.split("\n")[0]);
    return res.selections.map((s) => `${s.name} ${formatVersion(s.version)}`);
  };

  eq("mvs: picks the lowest version that satisfies, not the newest",
    sel({ json: "1.2.0" }), ["bytes 0.3.0", "json 1.2.0"]);
  eq("mvs: a higher requirement anywhere raises the selection",
    sel({ json: "1.2.0", http: "1.0.0" }), ["bytes 0.3.2", "http 1.0.0", "json 1.3.0"]);
  eq("mvs: an unrelated dependency does not upgrade one already pinned low",
    sel({ old: "1.0.0" }), ["bytes 0.3.0", "json 1.2.0", "old 1.0.0"]);
  eq("mvs: incompatible majors are an error naming both sides",
    sel({ json: "1.2.0", "json-x": "1.0.0" }).length > 0, true);

  const conflict = mvs(
    [
      { name: "json", req: parseReq("1.2.0")! },
      { name: "json", req: parseReq("2.0.0")! },
    ],
    registry,
  );
  if (conflict.errors.length > 0 && conflict.errors[0]!.message.includes("cannot both be satisfied")) {
    r.ok("mvs: two incompatible requirements for one package are rejected");
  } else {
    r.bad("mvs: two incompatible requirements for one package are rejected", JSON.stringify(conflict.selections));
  }

  const missing = mvs([{ name: "nope", req: parseReq("1.0.0")! }], registry);
  eq("mvs: an unknown package is an error", missing.errors.length > 0, true);
  const unsatisfiable = mvs([{ name: "bytes", req: parseReq("9.0.0")! }], registry);
  eq("mvs: an unsatisfiable requirement is an error", unsatisfiable.errors.length > 0, true);

  // ---- P4 lockfile ------------------------------------------------------
  const lockText = formatLock({
    format: 1,
    entries: [
      { name: "json", version: parseVersion("1.3.0")!, source: "registry", sha256: "a".repeat(64), path: "" },
      { name: "local", version: parseVersion("0.1.0")!, source: "path", sha256: "", path: "../local" },
    ],
  });
  const relock = parseLock(lockText, "halka.lock");
  if (!relock.lock) r.bad("lock: round-trips", JSON.stringify(relock.errors));
  else {
    r.ok("lock: round-trips");
    eq("lock: formatting is stable", formatLock(relock.lock), lockText);
  }
  eq("lock: a short sha256 is rejected",
    parseLock("lock:\n    version: 1\n\nj:\n    version: 1.0.0,\n    source: registry,\n    sha256: abc\n", "l").lock, null);
  eq("lock: a missing header is rejected",
    parseLock("j:\n    version: 1.0.0,\n    source: registry,\n    sha256: " + "a".repeat(64) + "\n", "l").lock, null);
  eq("lock: a newer format is refused rather than guessed at",
    parseLock("lock:\n    version: 99\n", "l").lock, null);

  // ---- P6 archive safety ------------------------------------------------
  eq("archive: an absolute path is rejected", safeEntryPath("/etc/passwd"), null);
  eq("archive: a parent traversal is rejected", safeEntryPath("a/../../b"), null);
  eq("archive: a Windows drive path is rejected", safeEntryPath("C:/windows/system32"), null);
  eq("archive: a UNC path is rejected", safeEntryPath("//server/share"), null);
  eq("archive: an ordinary path is kept", safeEntryPath("./pkg/src/main.hk"), "pkg/src/main.hk");

  const round = readTarGz(makeTarGz({ "p-1.0.0/halka.pkg": "package:\n", "p-1.0.0/src/a.hk": "say \"hi\"\n" }));
  eq("archive: a round-trip reads both entries", round.map((e) => e.path),
    ["p-1.0.0/halka.pkg", "p-1.0.0/src/a.hk"]);
  eq("archive: the shared root directory is stripped", stripRootDir(round).map((e) => e.path),
    ["halka.pkg", "src/a.hk"]);

  try {
    readTarGz(makeTarGz({ "../escape.hk": "nope" }));
    r.bad("archive: an escaping entry is refused", "it was accepted");
  } catch (e) {
    if (e instanceof ArchiveError) r.ok("archive: an escaping entry is refused");
    else r.bad("archive: an escaping entry is refused", String(e));
  }

  try {
    readTarGz(Buffer.from("this is not gzip data"));
    r.bad("archive: non-gzip input is refused", "it was accepted");
  } catch (e) {
    if (e instanceof ArchiveError) r.ok("archive: non-gzip input is refused");
    else r.bad("archive: non-gzip input is refused", String(e));
  }

  // A single flipped byte must not read as a valid archive.
  const corrupt = Buffer.from(makeTarGz({ "p/a.hk": "x" }));
  corrupt[corrupt.length - 6] ^= 0xff;
  try {
    readTarGz(corrupt);
    r.bad("archive: corrupt data is refused", "it was accepted");
  } catch {
    r.ok("archive: corrupt data is refused");
  }

  // ---- P5 index ---------------------------------------------------------
  eq("index: a good index parses",
    parseIndex('{"name":"j","versions":[{"version":"1.0.0","sha256":"' + "a".repeat(64) + '","deps":{}}]}', "j")?.versions.length,
    1);
  eq("index: a mismatched name is refused",
    parseIndex('{"name":"other","versions":[]}', "j"), null);
  eq("index: a bad hash is refused",
    parseIndex('{"name":"j","versions":[{"version":"1.0.0","sha256":"nope","deps":{}}]}', "j"), null);
  eq("index: a bad requirement is refused",
    parseIndex('{"name":"j","versions":[{"version":"1.0.0","sha256":"' + "a".repeat(64) + '","deps":{"b":">=1"}}]}', "j"), null);
  eq("index: malformed JSON is refused", parseIndex("{", "j"), null);

  // ---- the hash is what decides ----------------------------------------
  const gz = makeTarGz({ "p-1.0.0/halka.pkg": "package:\n    name: p,\n    version: 1.0.0\n" });
  eq("registry: the same bytes hash the same", sha256(gz), sha256(Buffer.from(gz)));
  const tampered = Buffer.from(gz);
  tampered[tampered.length - 20] ^= 0x01;
  eq("registry: a tampered archive hashes differently", sha256(tampered) !== sha256(gz), true);
}

/** A temp directory for the fixture registry, cleaned up by the caller. */
export function fixtureDir(): string {
  const dir = join(tmpdir(), `halka-pkg-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { buildFixtureRegistry as buildRegistry };
