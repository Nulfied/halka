// End-to-end package tests: resolve, fetch, verify, extract, and then
// actually run a program that imports what was installed.
//
// The unit tests in pkg.ts check each piece in isolation. This file exists
// because they all passed while a program still could not use a dependency
// that had a dependency of its own — the pieces were right and the wiring
// was not. Everything runs against a fixture registry on disk; nothing here
// touches the network.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { loadProject, sync } from "../src/pkg/project.ts";
import { Registry } from "../src/pkg/registry.ts";
import { parseLock } from "../src/pkg/lock.ts";
import { formatVersion } from "../src/pkg/semver.ts";
import { buildFixtureRegistry } from "./pkg.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "halka.mjs");

export interface Report {
  ok(name: string): void;
  bad(name: string, detail: string): void;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export async function suitePkgE2E(r: Report): Promise<void> {
  const base = join(tmpdir(), `halka-pkg-e2e-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const registryDir = join(base, "registry");
  const cacheDir = join(base, "cache");
  const projectDir = join(base, "app");

  // `codec` depends on `bytes`, so installing it exercises a transitive edge.
  buildFixtureRegistry(registryDir, [
    { name: "bytes", version: "0.3.0", body: 'hex(n: int): string,\n    give "0x{n}"\n' },
    { name: "bytes", version: "0.3.2", body: 'hex(n: int): string,\n    give "0x{n}"\n' },
    { name: "bytes", version: "0.4.0", body: 'hex(n: int): string,\n    give "nope"\n' },
    {
      name: "codec",
      version: "1.2.0",
      deps: { bytes: "0.3.0" },
      body: 'import bytes\n\nencode(n: int): string,\n    give bytes.hex(n)\n',
    },
  ]);

  // The cache location is read from the environment by the library, not
  // passed in, so this process needs it too — otherwise `sync` installs into
  // the developer's real ~/.halka/cache and the test both pollutes it and
  // silently passes off whatever is already there.
  const previousCache = process.env["HALKA_CACHE"];
  process.env["HALKA_CACHE"] = cacheDir;
  const env = { ...process.env, HALKA_REGISTRY: registryDir, HALKA_CACHE: cacheDir };
  write(join(projectDir, "halka.pkg"), "package:\n    name: app,\n    version: 0.1.0\n\ndeps:\n    codec: 1.2.0\n");
  write(join(projectDir, "src", "main.hk"), 'import codec\n\nsay "encoded = {codec.encode(255)}"\n');

  const registry = new Registry(registryDir, false);

  // ---- install ----------------------------------------------------------
  let installed;
  try {
    installed = await sync(loadProject(projectDir), { dev: false, offline: false, update: false, registry });
    r.ok("e2e: install resolves and fetches");
  } catch (e) {
    r.bad("e2e: install resolves and fetches", e instanceof Error ? e.message : String(e));
    return;
  }

  const names = installed.map((d) => `${d.name} ${formatVersion(d.version)}`).sort();
  if (JSON.stringify(names) === JSON.stringify(["bytes 0.3.0", "codec 1.2.0"])) {
    r.ok("e2e: the transitive dependency is installed at the selected version");
  } else {
    r.bad("e2e: the transitive dependency is installed at the selected version", JSON.stringify(names));
  }

  // MVS must not have taken bytes 0.4.0 just because it exists.
  if (installed.some((d) => formatVersion(d.version) === "0.4.0")) {
    r.bad("e2e: a newer version is not selected without being asked for", "bytes 0.4.0 was selected");
  } else {
    r.ok("e2e: a newer version is not selected without being asked for");
  }

  // ---- lockfile ---------------------------------------------------------
  const lockPath = join(projectDir, "halka.lock");
  if (!existsSync(lockPath)) {
    r.bad("e2e: a lockfile is written", "halka.lock does not exist");
  } else {
    r.ok("e2e: a lockfile is written");
    const parsed = parseLock(readFileSync(lockPath, "utf8"), lockPath);
    if (parsed.lock && parsed.lock.entries.length === 2 && parsed.lock.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))) {
      r.ok("e2e: the lockfile records a hash for every package");
    } else {
      r.bad("e2e: the lockfile records a hash for every package", JSON.stringify(parsed.errors));
    }
  }

  // ---- the point of all of it: the program runs -------------------------
  const run = spawnSync(process.execPath, [CLI, "run", join(projectDir, "src", "main.hk")], { encoding: "utf8", env });
  const out = (run.stdout ?? "").trim();
  if (out === "encoded = 0x255") {
    r.ok("e2e: a program can use a dependency that has a dependency");
  } else {
    r.bad(
      "e2e: a program can use a dependency that has a dependency",
      `stdout: ${JSON.stringify(out)}\nstderr: ${(run.stderr ?? "").trim()}`,
    );
  }

  // ---- the hash is what decides ----------------------------------------
  // Tamper with the published archive and re-install from a clean cache: the
  // lockfile's hash must reject it rather than the build silently changing.
  rmSync(cacheDir, { recursive: true, force: true });
  const archive = join(registryDir, "pkg", "bytes", "0.3.0.tar.gz");
  const bytes = readFileSync(archive);
  bytes[bytes.length - 8] ^= 0xff;
  writeFileSync(archive, bytes);

  try {
    await sync(loadProject(projectDir), {
      dev: false, offline: false, update: false, registry: new Registry(registryDir, false),
    });
    r.bad("e2e: a tampered archive is refused", "the install succeeded");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not match the lockfile")) r.ok("e2e: a tampered archive is refused");
    else r.bad("e2e: a tampered archive is refused", msg);
  }

  // ---- a fresh clone: lockfile committed, nothing installed -------------
  // This must be an error naming `halka install`. Before it was one, the
  // import quietly resolved to the built-in module of the same name.
  rmSync(cacheDir, { recursive: true, force: true });
  const fresh = spawnSync(process.execPath, [CLI, "run", join(projectDir, "src", "main.hk")], { encoding: "utf8", env });
  const freshErr = (fresh.stderr ?? "").trim();
  if (fresh.status !== 0 && freshErr.includes("not installed") && freshErr.includes("halka install")) {
    r.ok("e2e: an uninstalled dependency is an error that says what to run");
  } else {
    r.bad(
      "e2e: an uninstalled dependency is an error that says what to run",
      `status ${fresh.status}\nstdout: ${(fresh.stdout ?? "").trim()}\nstderr: ${freshErr}`,
    );
  }

  // ---- a Result from a dependency is usable ----------------------------

  // `Result` is the only way a library reports failure (#22, #23), so a
  // library whose Result cannot be read is a library nobody can use. The
  // payload used to be bound to the enum's own declared parameter when the
  // subject came from another module -- `T cannot be indexed`, about a type
  // the program never wrote. `halka build` links every module into one
  // before inferring and so accepted the same program, which left `run` and
  // `build` disagreeing about whether it was legal at all (R23).
  const resultDir = join(base, "result-app");
  write(join(resultDir, "halka.pkg"), "package:\n    name: rapp,\n    version: 0.1.0\n\ndeps:\n    parsy: 1.0.0\n");
  write(join(resultDir, "src", "main.hk"), [
    "import parsy",
    "",
    'match parsy.rows("a,b"),',
    "    Ok(fields),",
    "        say fields[0],",
    "        say fields.length,",
    "        for f in fields,",
    "            say f,",
    "    Error(message),",
    '        say "failed: {message}"',
    "",
  ].join("\n"));
  buildFixtureRegistry(registryDir, [
    { name: "parsy", version: "1.0.0", body: 'rows(text: string): Result<list(string)>,\n    give Ok(text.split(","))\n' },
  ]);
  await sync(loadProject(resultDir), { dev: false, offline: false, update: false, registry: new Registry(registryDir, false) });
  const used = spawnSync(process.execPath, [CLI, "run", join(resultDir, "src", "main.hk")], { encoding: "utf8", env });
  if ((used.stdout ?? "").trim().split(/\r?\n/).join("|") === "a|2|a|b") {
    r.ok("e2e: a Result from a dependency can be read, iterated and indexed");
  } else {
    r.bad("e2e: a Result from a dependency can be read, iterated and indexed",
      `status ${used.status}\nstdout: ${(used.stdout ?? "").trim()}\nstderr: ${(used.stderr ?? "").trim()}`);
  }

  // ---- `halka test` checks what `halka run` checks ----------------------

  // It looked only for parse errors, so a test file the compiler refuses
  // reported `1 passed`.
  //
  // The error here is in a function nothing calls, which is the case that
  // separates the two: an error on a line that *runs* fails the test either
  // way, and a first attempt at this test passed with the fix reverted for
  // exactly that reason.
  const badTestDir = join(base, "bad-test");
  write(join(badTestDir, "wrong_test.hk"), 'never_called(): int,\n    give "not an int"\n\nsay "reached"\n');
  const tested = spawnSync(process.execPath, [CLI, "test", badTestDir], { encoding: "utf8", env });
  const testedOut = `${tested.stdout ?? ""}${tested.stderr ?? ""}`;
  if (tested.status !== 0 && /FAIL/.test(testedOut) && /expected int, found string/.test(testedOut)) {
    r.ok("e2e: `halka test` fails a file the compiler would reject");
  } else {
    r.bad("e2e: `halka test` fails a file the compiler would reject", `status ${tested.status}\n${testedOut.trim()}`);
  }

  // ---- a package may not take a built-in module's name ------------------
  const shadowDir = join(base, "shadow");
  write(join(shadowDir, "halka.pkg"), "package:\n    name: app,\n    version: 0.1.0\n\ndeps:\n    json: 1.0.0\n");
  try {
    loadProject(shadowDir);
    r.bad("e2e: a dependency may not shadow a built-in module", "it was accepted");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("built-in module")) r.ok("e2e: a dependency may not shadow a built-in module");
    else r.bad("e2e: a dependency may not shadow a built-in module", msg);
  }

  rmSync(base, { recursive: true, force: true });
  if (previousCache === undefined) delete process.env["HALKA_CACHE"];
  else process.env["HALKA_CACHE"] = previousCache;
}
