// Publishing: packing a project, and building a registry index from the
// archives. spec/PACKAGES.md P5.
//
// The fetch side has been tested since the package manager was written.
// This is the other half, and it is the half where a mistake is permanent:
// a version in a registry is immutable because lockfiles record its hash,
// so anything wrong in an archive is wrong for as long as the registry
// exists. Most of what follows is a check that something is *refused*.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { readTarGz, stripRootDir, writeTarGz } from "../src/pkg/archive.ts";
import { packProject, PackError } from "../src/pkg/pack.ts";
import { buildRegistry, checkRegistry } from "../src/pkg/registry-build.ts";
import { sha256 } from "../src/pkg/registry.ts";

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const GOOD_MANIFEST =
  "package:\n    name: demo,\n    version: 1.2.0,\n    license: MIT,\n    description: A demonstration\n";

/** A project directory that packs cleanly, with `over` applied on top. */
function project(dir: string, over: Record<string, string | null> = {}): string {
  rmSync(dir, { recursive: true, force: true });
  const files: Record<string, string | null> = {
    "halka.pkg": GOOD_MANIFEST,
    "README.md": "# demo\n",
    "src/demo.hk": 'tag(): string,\n    give "demo"\n',
    ...over,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (text !== null) write(join(dir, rel), text);
  }
  return dir;
}

export function suiteRegistry(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
): void {
  const base = join(tmpdir(), `halka-registry-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const check = (name: string, cond: boolean, detail: string): void => {
    if (cond) ok("registry", name); else bad("registry", name, detail);
  };

  /** Pack and report the error message, or null when it succeeded. */
  const refuses = (name: string, over: Record<string, string | null>, want: RegExp): void => {
    const dir = project(join(base, "refuse", name.replace(/\W+/g, "-")), over);
    try {
      packProject(dir);
      bad("registry", `pack refuses ${name}`, "it was packed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof PackError)) bad("registry", `pack refuses ${name}`, `wrong error type: ${msg}`);
      else if (!want.test(msg)) bad("registry", `pack refuses ${name}`, `the message does not explain why:\n${msg}`);
      else ok("registry", `pack refuses ${name}`);
    }
  };

  // ---- the tar writer ---------------------------------------------------

  const entries = [
    { path: "a-1.0.0/src/z.hk", data: Buffer.from("give 1\n") },
    { path: "a-1.0.0/halka.pkg", data: Buffer.from(GOOD_MANIFEST) },
  ];
  const once = writeTarGz(entries);
  check("an archive round-trips through the reader",
    JSON.stringify(stripRootDir(readTarGz(once)).map((e) => e.path)) === JSON.stringify(["halka.pkg", "src/z.hk"]),
    JSON.stringify(readTarGz(once).map((e) => e.path)));
  // The hash is the whole trust model, so it cannot depend on the order the
  // files happened to be read in, or on when.
  check("and hashes the same whatever order it was given in",
    sha256(once) === sha256(writeTarGz([...entries].reverse())), "the two hashes differ");
  check("and carries no timestamp",
    once[4] === 0 && once[5] === 0 && once[6] === 0 && once[7] === 0,
    "the gzip header has an mtime in it");
  check("and no platform", once[9] === 0xff, `the gzip header says OS ${once[9]}`);

  // ---- packing ----------------------------------------------------------

  const packed = packProject(project(join(base, "demo")));
  check("a project packs", packed.manifest.name === "demo", packed.manifest.name);
  check("the archive is laid out under one directory named for the release",
    packed.files.every((f) => f.startsWith("demo-1.2.0/")), JSON.stringify(packed.files));
  check("it holds the manifest, the readme and the source",
    JSON.stringify(packed.files) === JSON.stringify(["demo-1.2.0/README.md", "demo-1.2.0/halka.pkg", "demo-1.2.0/src/demo.hk"]),
    JSON.stringify(packed.files));

  // What is *not* in it matters more. A published archive cannot be
  // withdrawn, so a file swept in by accident is public permanently.
  const withJunk = packProject(project(join(base, "junk"), {
    ".env": "SECRET=hunter2",
    "notes.txt": "private",
    "build/out.exe": "binary",
    "src/.env": "SECRET=also-this",
    "src/sub/real.hk": "give 2\n",
  }));
  const junkNames = withJunk.files.join(" ");
  check("nothing else at the root is published",
    !junkNames.includes(".env") && !junkNames.includes("notes.txt") && !junkNames.includes("build"),
    junkNames);
  check("nor a dotfile inside src", !withJunk.files.some((f) => f.endsWith("/.env")), junkNames);
  check("but source in a subdirectory is", junkNames.includes("src/sub/real.hk"), junkNames);

  refuses("a path dependency", { "halka.pkg": GOOD_MANIFEST + "\ndeps:\n    other: path ../other\n" },
    /path.*means nothing/s);
  refuses("no license", { "halka.pkg": "package:\n    name: demo,\n    version: 1.2.0,\n    description: d\n" },
    /license/);
  refuses("no description", { "halka.pkg": "package:\n    name: demo,\n    version: 1.2.0,\n    license: MIT\n" },
    /description/);
  refuses("no src directory", { "src/demo.hk": null }, /src/);
  refuses("a manifest that does not parse", { "halka.pkg": "package:\n    name: Demo!\n" }, /halka\.pkg/);

  // ---- building the index -----------------------------------------------

  const reg = join(base, "reg");
  const publish = (name: string, version: string, over: Record<string, string | null> = {}): Buffer => {
    const p = packProject(project(join(base, "src", `${name}-${version}`), {
      "halka.pkg": `package:\n    name: ${name},\n    version: ${version},\n    license: MIT,\n    description: d\n`,
      "src/demo.hk": null,
      [`src/${name}.hk`]: 'tag(): string,\n    give "x"\n',
      ...over,
    }));
    const path = join(reg, "pkg", name, `${version}.tar.gz`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, p.archive);
    return p.archive;
  };

  const csvGz = publish("demo", "1.2.0");
  publish("demo", "1.10.0");
  publish("other", "0.1.0", {
    "halka.pkg": "package:\n    name: other,\n    version: 0.1.0,\n    license: MIT,\n    description: d\n\ndeps:\n    demo: 1.2.0\n\ndev-deps:\n    testing-only: 9.9.9\n",
  });

  const built = buildRegistry(reg);
  check("a registry of sound archives has no problems", built.problems.length === 0, built.problems.join("; "));
  check("every package gets an index file",
    JSON.stringify([...built.files.keys()].sort()) === JSON.stringify(["index/demo.json", "index/other.json"]),
    JSON.stringify([...built.files.keys()]));

  const demo = built.packages.find((p) => p.name === "demo");
  check("the index records the archive's own hash",
    demo?.versions.some((v) => v.sha256 === sha256(csvGz)) === true, JSON.stringify(demo?.versions.map((v) => v.sha256)));
  // 1.10.0 sorts after 1.2.0 as versions and before it as strings, which is
  // the sort that looks right until the tenth release.
  check("versions are ordered as versions, not as text",
    JSON.stringify(demo?.versions.map((v) => `${v.version.major}.${v.version.minor}.${v.version.patch}`)) ===
      JSON.stringify(["1.2.0", "1.10.0"]),
    JSON.stringify(demo?.versions.map((v) => v.version)));

  const other = built.packages.find((p) => p.name === "other");
  check("dependencies reach the index", other?.versions[0]?.deps["demo"] === "1.2.0", JSON.stringify(other?.versions[0]?.deps));
  // Nobody installing `other` builds its tests, so its dev dependencies are
  // not part of anyone else's graph.
  check("dev dependencies do not", other?.versions[0]?.deps["testing-only"] === undefined,
    JSON.stringify(other?.versions[0]?.deps));

  // ---- what the index refuses -------------------------------------------

  const rejects = (name: string, make: (dir: string) => void, want: RegExp): void => {
    const dir = join(base, "reject", name.replace(/\W+/g, "-"));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "pkg"), { recursive: true });
    make(dir);
    const problems = buildRegistry(dir).problems;
    if (!problems.length) bad("registry", `the index refuses ${name}`, "it was accepted");
    else if (!problems.some((p) => want.test(p))) bad("registry", `the index refuses ${name}`, problems.join("; "));
    else ok("registry", `the index refuses ${name}`);
  };

  const manifestFor = (name: string, version: string) =>
    `package:\n    name: ${name},\n    version: ${version},\n    license: MIT,\n    description: d\n`;
  const archiveOf = (root: string, manifest: string, extra: Record<string, string> = {}) =>
    writeTarGz([
      { path: `${root}/halka.pkg`, data: Buffer.from(manifest) },
      { path: `${root}/src/a.hk`, data: Buffer.from("give 1\n") },
      ...Object.entries(extra).map(([p, d]) => ({ path: `${root}/${p}`, data: Buffer.from(d) })),
    ]);

  // The path a package is served from is what a client asks for, so an
  // archive filed under the wrong name is a client fetching one thing and
  // getting another.
  rejects("an archive filed under the wrong name", (dir) => {
    write(join(dir, "pkg", "demo", "1.0.0.tar.gz"), "");
    writeFileSync(join(dir, "pkg", "demo", "1.0.0.tar.gz"), archiveOf("sneaky-1.0.0", manifestFor("sneaky", "1.0.0")));
  }, /filed under/);

  rejects("an archive filed under the wrong version", (dir) => {
    write(join(dir, "pkg", "demo", "9.9.9.tar.gz"), "");
    writeFileSync(join(dir, "pkg", "demo", "9.9.9.tar.gz"), archiveOf("demo-1.0.0", manifestFor("demo", "1.0.0")));
  }, /filed as/);

  rejects("an archive with no manifest", (dir) => {
    write(join(dir, "pkg", "demo", "1.0.0.tar.gz"), "");
    writeFileSync(join(dir, "pkg", "demo", "1.0.0.tar.gz"),
      writeTarGz([{ path: "demo-1.0.0/src/a.hk", data: Buffer.from("give 1\n") }]));
  }, /no halka\.pkg/);

  rejects("an archive with no source", (dir) => {
    write(join(dir, "pkg", "demo", "1.0.0.tar.gz"), "");
    writeFileSync(join(dir, "pkg", "demo", "1.0.0.tar.gz"),
      writeTarGz([{ path: "demo-1.0.0/halka.pkg", data: Buffer.from(manifestFor("demo", "1.0.0")) }]));
  }, /no \.hk files/);

  rejects("something that is not an archive", (dir) => {
    write(join(dir, "pkg", "demo", "1.0.0.tar.gz"), "this is not gzip");
  }, /gzip/);

  rejects("a file that is not a version", (dir) => {
    write(join(dir, "pkg", "demo", "latest.tar.gz"), "");
  }, /not a version/);

  // ---- the check CI runs -------------------------------------------------

  for (const [file, text] of built.files) write(join(reg, file), text);
  check("a freshly built index passes the check", checkRegistry(reg, buildRegistry(reg)).length === 0,
    checkRegistry(reg, buildRegistry(reg)).join("; "));

  // The point of deriving the index: an edit to it cannot survive.
  const tampered = readFileSync(join(reg, "index", "demo.json"), "utf8")
    .replace(/"sha256": "[0-9a-f]{64}"/, '"sha256": "' + "0".repeat(64) + '"');
  writeFileSync(join(reg, "index", "demo.json"), tampered);
  check("an index edited by hand does not", checkRegistry(reg, buildRegistry(reg)).length > 0,
    "a hash that matches no archive was accepted");

  writeFileSync(join(reg, "index", "ghost.json"), '{ "name": "ghost", "versions": [] }\n');
  check("nor an index file with no archives behind it",
    checkRegistry(reg, buildRegistry(reg)).some((w) => w.includes("ghost")),
    checkRegistry(reg, buildRegistry(reg)).join("; "));

  rmSync(base, { recursive: true, force: true });
}
