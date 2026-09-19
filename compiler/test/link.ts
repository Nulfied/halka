// The `link` suite — multi-module programs, interpreted and compiled.
//
// Each directory under test/multimodule/ is a program whose `main.hk`
// imports the modules beside it. Both engines must produce the same output,
// which is R23's contract applied across a module boundary.
//
// These go through the real CLI rather than the library, because the bugs
// this suite exists to catch all lived in the wiring: a dependency's imports
// were never bound, an import was invisible inside a function, and a
// `main()` function was never called by the compiled binary. Every one of
// them produced a working *library* and a wrong *program*.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "halka.mjs");
const CASES = join(HERE, "multimodule");

export interface Report {
  ok(name: string): void;
  bad(name: string, detail: string): void;
}

function clean(s: string): string {
  return s.split("\r\n").join("\n").replace(/\s+$/, "");
}

export function suiteLink(r: Report, canBuild: boolean): void {
  if (!existsSync(CASES)) return;

  for (const name of readdirSync(CASES).sort()) {
    const entry = join(CASES, name, "main.hk");
    if (!existsSync(entry)) continue;

    const run = spawnSync(process.execPath, [CLI, "run", entry], { encoding: "utf8" });
    if (run.status !== 0) {
      r.bad(`${name} (run)`, clean(run.stderr ?? "") || `exited with ${run.status}`);
      continue;
    }
    const interpreted = clean(run.stdout ?? "");
    if (interpreted === "") {
      r.bad(`${name} (run)`, "the program printed nothing, so there is nothing to compare");
      continue;
    }
    r.ok(`${name} (run)`);

    if (!canBuild) continue;

    const exe = join(tmpdir(), `halka-link-${name}-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
    const build = spawnSync(process.execPath, [CLI, "build", entry, "-o", exe, "--quiet"], { encoding: "utf8" });
    if (build.status !== 0) {
      r.bad(`${name} (build)`, clean(build.stderr ?? "") || clean(build.stdout ?? ""));
      continue;
    }

    const native = spawnSync(exe, [], {
      encoding: "utf8",
      env: { ...process.env, HALKA_REPORT_LEAKS: "1" },
    });
    if (native.status !== 0) {
      r.bad(`${name} (native)`, `the binary exited with ${native.status}\n${native.stdout ?? ""}${native.stderr ?? ""}`);
      rmSync(exe, { force: true });
      continue;
    }

    const compiled = clean(native.stdout ?? "");
    if (compiled === interpreted) r.ok(`${name} (interpreter vs native)`);
    else r.bad(`${name} (interpreter vs native)`, `interpreter: ${JSON.stringify(interpreted)}\nnative:      ${JSON.stringify(compiled)}`);

    // M4 still applies once modules are linked together.
    const m = /halka: (\d+) heap object\(s\) still live at exit, of (\d+) allocated/.exec(native.stderr ?? "");
    if (!m) r.bad(`${name} (leaks)`, "the binary printed no allocation report");
    else if (m[1] === "0") r.ok(`${name} (no leaks, ${m[2]} allocations)`);
    else r.bad(`${name} (leaks)`, `${m[1]} heap object(s) still live at exit, of ${m[2]} allocated`);

    rmSync(exe, { force: true });
  }
}
