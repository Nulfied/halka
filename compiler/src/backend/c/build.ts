// `halka build` — emit C, find a C compiler, produce a native binary.
//
// No LLVM, no bundled toolchain, no build-system fragmentation: one command,
// one binary out, using whatever C compiler the machine already has.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = join(HERE, "runtime");

export interface Toolchain {
  kind: "msvc" | "unix";
  /** Human-readable name for diagnostics. */
  name: string;
  /** Compile+link: returns the command and args for a given source set. */
  compile(sources: string[], out: string, opts: { release: boolean; includeDirs: string[] }): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };
}

// ---------------------------------------------------------------------------
// toolchain discovery
// ---------------------------------------------------------------------------

function which(cmd: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

/** Locate MSVC and capture the environment `vcvars64.bat` sets up. */
function findMsvc(): Toolchain | null {
  if (process.platform !== "win32") return null;

  let installRoot: string | null = null;
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (existsSync(vswhere)) {
    try {
      installRoot = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).trim();
    } catch { /* fall through */ }
  }
  if (!installRoot) {
    for (const root of [
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
      "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
      "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional",
      "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
    ]) if (existsSync(root)) { installRoot = root; break; }
  }
  if (!installRoot) return null;

  const vcvars = join(installRoot, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!existsSync(vcvars)) return null;

  // Capture the developer environment once. vcvars shells out to vswhere, so
  // run it from a temp batch file rather than a quoted `cmd /c` string.
  let env: NodeJS.ProcessEnv | null = null;
  try {
    const installerDir = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer";
    const bat = join(tmpdir(), `halka-vcvars-${process.pid}.bat`);
    writeFileSync(bat, [
      "@echo off",
      `set "PATH=${installerDir};%PATH%"`,
      `call "${vcvars}" >nul 2>&1`,
      "set",
      "",
    ].join("\r\n"), "ascii");
    const out = execFileSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/c", bat], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    try { rmSync(bat, { force: true }); } catch { /* best effort */ }
    env = { ...process.env };
    for (const line of out.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!env["INCLUDE"] || !env["LIB"]) return null;
  } catch {
    return null;
  }

  return {
    kind: "msvc",
    name: `MSVC (${basename(installRoot)})`,
    compile(sources, out, opts) {
      const args = [
        "/nologo", "/std:c11", "/W3",
        opts.release ? "/O2" : "/Od", opts.release ? "/DNDEBUG" : "/Zi",
        ...opts.includeDirs.map((d) => `/I${d}`),
        ...sources,
        `/Fe:${out}`,
        `/Fo:${join(dirname(out), "")}\\`,
        "/link", "/INCREMENTAL:NO",
      ];
      return { cmd: "cl.exe", args, env: env ?? undefined };
    },
  };
}

function findUnixCc(): Toolchain | null {
  for (const cand of [process.env["CC"], "cc", "gcc", "clang", "zig"].filter(Boolean) as string[]) {
    const path = cand === "zig" ? which("zig") : which(cand);
    if (!path) continue;
    const isZig = cand === "zig";
    return {
      kind: "unix",
      name: isZig ? "zig cc" : cand,
      compile(sources, out, opts) {
        const flags = [
          "-std=c99", "-Wall",
          opts.release ? "-O2" : "-O0", opts.release ? "-DNDEBUG" : "-g",
          ...opts.includeDirs.map((d) => `-I${d}`),
          ...sources, "-o", out, "-lm",
        ];
        if (process.platform !== "win32") flags.push("-pthread");
        return isZig ? { cmd: path, args: ["cc", ...flags] } : { cmd: path, args: flags };
      },
    };
  }
  return null;
}

export function findToolchain(): Toolchain | null {
  return findUnixCc() ?? findMsvc();
}

export function describeToolchains(): string {
  const found: string[] = [];
  const unix = findUnixCc();
  if (unix) found.push(unix.name);
  const msvc = findMsvc();
  if (msvc) found.push(msvc.name);
  return found.length ? found.join(", ") : "none";
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Output binary path. */
  out: string;
  release: boolean;
  /** Keep the generated C next to the binary. */
  keepC: boolean;
  /** Print the C instead of compiling it. */
  emitOnly: boolean;
  quiet: boolean;
}

export interface BuildOutcome {
  ok: boolean;
  binary?: string;
  cFile?: string;
  message?: string;
  toolchain?: string;
}

export function buildNative(cSource: string, sourceName: string, opts: BuildOptions): BuildOutcome {
  const workDir = opts.keepC ? dirname(resolve(opts.out)) : mkdtemp();
  mkdirSync(workDir, { recursive: true });

  const cFile = join(workDir, basename(sourceName).replace(/\.hk$/, "") + ".c");
  writeFileSync(cFile, cSource, "utf8");

  if (opts.emitOnly) return { ok: true, cFile };

  const tc = findToolchain();
  if (!tc) {
    return {
      ok: false,
      cFile,
      message:
        "no C compiler found.\n" +
        "  Halka's native backend emits C99 and uses the compiler you already have.\n" +
        "  Install one of:\n" +
        "    Linux   apt install build-essential   (or: dnf install gcc)\n" +
        "    macOS   xcode-select --install\n" +
        "    Windows Visual Studio Build Tools, or `winget install zig.zig`\n" +
        `  The generated C is at ${cFile} if you want to compile it yourself.`,
    };
  }

  // Copy the runtime next to the generated C so include paths stay simple.
  const rtC = join(workDir, "halka.c");
  const rtH = join(workDir, "halka.h");
  copyFileSync(join(RUNTIME_DIR, "halka.c"), rtC);
  copyFileSync(join(RUNTIME_DIR, "halka.h"), rtH);

  const outPath = resolve(opts.out);
  const { cmd, args, env } = tc.compile([cFile, rtC], outPath, { release: opts.release, includeDirs: [workDir] });

  const r = spawnSync(cmd, args, { cwd: workDir, encoding: "utf8", env: env ?? process.env });
  if (r.error) {
    return { ok: false, cFile, toolchain: tc.name, message: `could not run ${cmd}: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      cFile,
      toolchain: tc.name,
      message: `${tc.name} failed:\n${indent((r.stdout ?? "") + (r.stderr ?? ""))}\n  generated C: ${cFile}`,
    };
  }

  if (!opts.keepC) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { ok: true, binary: outPath, cFile: opts.keepC ? cFile : undefined, toolchain: tc.name };
}

function mkdtemp(): string {
  return join(tmpdir(), `halka-build-${process.pid}-${Date.now()}`);
}

function indent(s: string): string {
  return s.split(/\r?\n/).filter((l) => l.trim()).map((l) => "    " + l).join("\n");
}

export function readRuntimeSource(): { h: string; c: string } {
  return {
    h: readFileSync(join(RUNTIME_DIR, "halka.h"), "utf8"),
    c: readFileSync(join(RUNTIME_DIR, "halka.c"), "utf8"),
  };
}
