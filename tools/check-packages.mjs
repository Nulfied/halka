// Every package in `packages/` must still pack to the archive the registry
// serves for it.
//
//   node tools/check-packages.mjs
//
// docs/registry/README.md tells people they can rebuild an archive from its
// source and get the same hash. That claim stops being true the moment
// somebody edits a package without publishing a new version -- and the
// edit looks completely harmless, because the archive people download does
// not change. This makes that drift a build failure instead.
//
// A version that is not in the registry yet is reported, not failed: that
// is what an unpublished change looks like, and it is fine until it is
// claimed to be published.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packProject } from "../compiler/src/pkg/pack.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "docs", "registry");
const sha = (b) => createHash("sha256").update(b).digest("hex");

let failed = 0;
let checked = 0;
const dir = join(ROOT, "packages");
for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
  if (!statSync(join(dir, name)).isDirectory()) continue;
  let packed;
  try {
    packed = packProject(join(dir, name));
  } catch (e) {
    process.stdout.write(`::error::packages/${name} does not pack: ${e.message}\n`);
    process.stderr.write(`packages/${name} does not pack:\n  ${e.message}\n`);
    failed++;
    continue;
  }

  const version = `${packed.manifest.version.major}.${packed.manifest.version.minor}.${packed.manifest.version.patch}`;
  const published = join(REGISTRY, "pkg", packed.manifest.name, `${version}.tar.gz`);
  if (!existsSync(published)) {
    process.stdout.write(`  ${packed.manifest.name} ${version} is not published yet\n`);
    checked++;
    continue;
  }

  const want = readFileSync(published);
  if (sha(want) === sha(packed.archive)) {
    process.stdout.write(`  ${packed.manifest.name} ${version} reproduces its archive (${sha(want).slice(0, 12)})\n`);
  } else {
    const detail = `packages/${name} no longer packs to what the registry serves.%0A`
      + `published sha256 ${sha(want)}%0Arebuilt   sha256 ${sha(packed.archive)}%0A`
      + `A published version is immutable: bump the version and publish it.`;
    process.stdout.write(`::error::${detail}\n`);
    process.stderr.write(detail.replace(/%0A/g, "\n") + "\n");
    failed++;
  }
  checked++;
}

process.stdout.write(`${checked} package(s), ${failed} problem(s)\n`);
process.exit(failed ? 1 : 0);
