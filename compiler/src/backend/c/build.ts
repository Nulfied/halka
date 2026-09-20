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
  compile(sources: string[], out: string, opts: CompileOpts): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };
}

export interface CompileOpts {
  release: boolean;
  /**
   * Let the C compiler reassociate floating-point arithmetic, which is what
   * unlocks auto-vectorisation of a reduction like a dot product. It is off
   * by default and has to be asked for, because reassociation can change
   * results: R23 promises the compiled program behaves like the interpreted
   * one, and this is the one switch that can break that promise.
   */
  fastMath?: boolean;
  /**
   * Target the building machine's instruction set. Off by default because
   * the binary then requires those instructions to run, which is a
   * portability decision the person shipping it should make, not us.
   */
  nativeCpu?: boolean;
  includeDirs: string[];
  /**
   * Where intermediate object files go. This must be unique per build: MSVC
   * names an object after its source, so two builds sharing a directory both
   * write `halka.obj`, and one of them fails with a sharing violation.
   */
  objDir: string;
  /** Extra libraries, from `extern: link: "..."` (#38). */
  libs?: string[];
  /** CPython embedding, when the program uses `py` (#37). */
  python?: PythonConfig | null;
  /**
   * Build for another platform, as an LLVM target triple. Only toolchains
   * that carry their own sysroots can do this without one being supplied,
   * which in practice means `zig cc`; plain clang needs `--sysroot` and gcc
   * cannot at all, so `findToolchain` refuses them for a cross build rather
   * than letting the link fail with something unreadable.
   */
  target?: string;
}

export interface PythonConfig {
  include: string;
  /** sys.base_prefix, baked in so the embedded interpreter finds its stdlib. */
  prefix: string;
  /** Windows: the .lib to link. POSIX: the -L directory. */
  libDir: string;
  libName: string;
  version: string;
}

/** Locate the CPython development files needed to embed the interpreter. */
export function findPython(): PythonConfig | null {
  for (const exe of [process.env["HALKA_PYTHON"], "python", "python3", "py"].filter(Boolean) as string[]) {
    try {
      const out = execFileSync(exe, ["-c", PY_PROBE], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const cfg = JSON.parse(out.trim()) as PythonConfig & { ok: boolean };
      if (cfg && cfg.ok && existsSync(join(cfg.include, "Python.h"))) return cfg;
    } catch { /* try the next candidate */ }
  }
  return null;
}

const PY_PROBE = [
  "import json,os,sys,sysconfig",
  "inc=sysconfig.get_paths()['include']",
  "v='%d.%d'%sys.version_info[:2]",
  "if os.name=='nt':",
  "    d=os.path.join(sys.base_prefix,'libs'); n='python%d%d'%sys.version_info[:2]",
  "else:",
  "    d=sysconfig.get_config_var('LIBDIR') or ''; n='python'+v+(sysconfig.get_config_var('ABIFLAGS') or '')",
  "print(json.dumps({'ok':os.path.isdir(inc),'include':inc,'libDir':d,'libName':n,'version':v,'prefix':sys.base_prefix.replace(chr(92),'/')}))",
].join("\n");

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
      const py = opts.python;
      const args = [
        "/nologo", "/std:c11", "/W3",
        ...(opts.fastMath ? ["/fp:fast"] : []),
        ...(opts.nativeCpu ? ["/arch:AVX2"] : []),
        // A `c` declaration that contradicts the real symbol is a hole in
        // the safety claim, not a style issue: it silently produces garbage
        // at run time. gcc and clang reject it outright, MSVC only warns, so
        // these are promoted to errors to make every toolchain agree.
        //   C4028 parameter differs from declaration
        //   C4029 declared parameter list differs
        //   C4047 differing levels of indirection
        //   C4133 incompatible pointer types
        //   C4113 incompatible function pointer types
        "/we4028", "/we4029", "/we4047", "/we4133", "/we4113",
        opts.release ? "/O2" : "/Od", opts.release ? "/DNDEBUG" : "/Zi",
        ...opts.includeDirs.map((d) => `/I${d}`),
        ...(py ? [`/I${py.include}`, `/DHK_PYTHONHOME=\"${py.prefix}\"`] : []),
        ...sources,
        `/Fe:${out}`,
        `/Fo:${join(opts.objDir, "")}\\`,
        "/link", "/INCREMENTAL:NO",
        ...(py ? [`/LIBPATH:${py.libDir}`, `${py.libName}.lib`] : []),
        ...(opts.libs ?? []).map((l) => (l.endsWith(".lib") ? l : `${l}.lib`)),
      ];
      return { cmd: "cl.exe", args, env: env ?? undefined };
    },
  };
}

/**
 * The flags a clang-style driver needs. Split out from the toolchain so it
 * can be checked without one installed -- which matters for cross builds,
 * since the machine writing this had no compiler able to do one and an
 * untested code path is how a feature ships broken.
 */
export function unixFlags(sources: string[], out: string, opts: CompileOpts): string[] {
  const py = opts.python;
  const flags = [
    "-std=c99", "-Wall",
    ...(opts.target ? ["-target", opts.target] : []),
    ...(opts.fastMath ? ["-ffast-math"] : []),
    ...(opts.nativeCpu ? ["-march=native"] : []),
    // Same reasoning as the MSVC block: a `c` declaration that does not
    // match the real symbol must stop the build on every toolchain.
    "-Werror=implicit-function-declaration",
    "-Werror=incompatible-pointer-types",
    "-Werror=int-conversion",
    opts.release ? "-O2" : "-O0", opts.release ? "-DNDEBUG" : "-g",
    ...opts.includeDirs.map((d) => `-I${d}`),
    ...(py ? [`-I${py.include}`, `-DHK_PYTHONHOME="${py.prefix}"`] : []),
    ...sources, "-o", out, "-lm",
    ...(py ? [`-L${py.libDir}`, `-l${py.libName}`] : []),
    ...(opts.libs ?? []).map((l) => (l.startsWith("-") ? l : `-l${l}`)),
  ];
  // Threading follows the *target*, not the machine doing the build.
  if (!targetsWindows(opts.target)) flags.push("-pthread");
  return flags;
}

/** Does this triple name a Windows target? Absent means "this machine". */
export function targetsWindows(target?: string): boolean {
  return target ? /windows|msvc|mingw/i.test(target) : process.platform === "win32";
}

function findUnixCc(forTarget?: string): Toolchain | null {
  // For a cross build, prefer the toolchain that can actually do one: it
  // has to carry the target's headers and libraries, and gcc does not.
  const order = forTarget
    ? ["zig", "clang"]
    : [process.env["CC"], "cc", "gcc", "clang", "zig"].filter(Boolean) as string[];
  for (const cand of order) {
    const path = which(cand);
    if (!path) continue;
    const isZig = cand === "zig";
    return {
      kind: "unix",
      name: isZig ? "zig cc" : cand,
      compile(sources, out, opts) {
        const flags = unixFlags(sources, out, opts);
        return isZig ? { cmd: path, args: ["cc", ...flags] } : { cmd: path, args: flags };
      },
    };
  }
  return null;
}

export function findToolchain(forTarget?: string): Toolchain | null {
  // MSVC builds for this machine only, so it is not a candidate for a cross
  // build even when it is the only thing installed.
  if (forTarget) return findUnixCc(forTarget);
  return findUnixCc() ?? findMsvc();
}

/** Targets `zig cc` is known to carry a sysroot for, for the error message. */
export const COMMON_TARGETS = [
  "x86_64-linux-gnu", "x86_64-linux-musl", "aarch64-linux-gnu", "aarch64-linux-musl",
  "x86_64-windows-gnu", "aarch64-windows-gnu",
  "x86_64-macos", "aarch64-macos",
];

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
  /** `--fast-math`: reassociation, and the vectorisation it unlocks. */
  fastMath?: boolean;
  /** `--cpu-native`: target this machine's instruction set. */
  nativeCpu?: boolean;
  /** Libraries requested by `extern: link: "..."`. */
  libs?: string[];
  /** True when the program uses `py` and must embed CPython (#37). */
  needsPython?: boolean;
  /** Keep the generated C next to the binary. */
  keepC: boolean;
  /** Print the C instead of compiling it. */
  emitOnly: boolean;
  quiet: boolean;
  /** `--target`: build for another platform, as an LLVM target triple. */
  target?: string;
}

export interface BuildOutcome {
  ok: boolean;
  binary?: string;
  cFile?: string;
  message?: string;
  toolchain?: string;
  python?: PythonConfig | null;
  /** Warnings from the C compiler, which usually mean an FFI declaration is wrong. */
  warnings?: string[];
}

export function buildNative(cSource: string, sourceName: string, opts: BuildOptions): BuildOutcome {
  const workDir = opts.keepC ? dirname(resolve(opts.out)) : mkdtemp();
  mkdirSync(workDir, { recursive: true });

  const cFile = join(workDir, basename(sourceName).replace(/\.hk$/, "") + ".c");
  writeFileSync(cFile, cSource, "utf8");

  if (opts.emitOnly) return { ok: true, cFile };

  const tc = findToolchain(opts.target);
  if (!tc && opts.target) {
    return {
      ok: false,
      cFile,
      message:
        `no toolchain here can build for ${opts.target}.\n` +
        "  Cross-compiling needs a compiler carrying the target's own headers and\n" +
        "  libraries. `zig cc` does: `winget install zig.zig`, `brew install zig`,\n" +
        "  or https://ziglang.org/download/.\n" +
        `  Targets it ships: ${COMMON_TARGETS.join(", ")}\n` +
        `  The generated C is at ${cFile} if you want to compile it yourself.`,
    };
  }
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

  let python: PythonConfig | null = null;
  if (opts.needsPython) {
    python = findPython();
    if (!python) {
      return {
        ok: false,
        cFile,
        toolchain: tc.name,
        message:
          "this program uses `py` interop, but CPython's development headers were not found.\n" +
          "  Install them, then build again:\n" +
          "    Debian/Ubuntu  apt install python3-dev\n" +
          "    Fedora         dnf install python3-devel\n" +
          "    macOS          the python.org installer includes them\n" +
          "    Windows        the python.org installer includes them\n" +
          "  Set HALKA_PYTHON to pick a specific interpreter.",
      };
    }
  }

  const outPath = resolve(opts.out);
  const { cmd, args, env } = tc.compile([cFile, rtC], outPath, {
    objDir: workDir,
    fastMath: opts.fastMath,
    nativeCpu: opts.nativeCpu,
    target: opts.target,
    release: opts.release,
    includeDirs: [workDir],
    libs: opts.libs,
    python,
  });

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

  const warnings = collectWarnings((r.stdout ?? "") + (r.stderr ?? ""));

  if (!opts.keepC) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return {
    ok: true,
    binary: outPath,
    cFile: opts.keepC ? cFile : undefined,
    toolchain: tc.name,
    python,
    warnings,
  };
}

/** C compiler warnings worth showing — an FFI mismatch surfaces here first. */
function collectWarnings(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/\bwarning\b/i.test(line)) continue;
    // Noise from the platform headers is not the program's problem.
    if (/include[\\/].*\.h\(/i.test(line) && !/halka\.h/.test(line)) continue;
    out.push(line.trim());
  }
  return [...new Set(out)];
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
