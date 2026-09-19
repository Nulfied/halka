#!/usr/bin/env node
// Halka benchmark harness.
//
// Compiles each kernel three ways — Halka native, hand-written C with the same
// compiler and flags, and Python — runs each several times, and reports the
// best wall-clock time. Best-of-N rather than mean, because we are measuring
// the machine's capability, not the scheduler's noise.
//
//   node bench/run.mjs            all kernels
//   node bench/run.mjs fib loop   selected kernels
//   node bench/run.mjs --runs 7   more samples

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const HALKA = join(ROOT, "compiler", "bin", "halka.mjs");
const EXE = process.platform === "win32" ? ".exe" : "";

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const RUNS = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const only = args.filter((a) => !a.startsWith("--") && a !== String(RUNS));

const KERNELS = [
  { name: "fib", what: "recursive calls", detail: "fib(35), 30M calls" },
  { name: "loop", what: "integer arithmetic", detail: "200M iterations of `i % 7`" },
  { name: "mandel", what: "floating point", detail: "900x900, 500 iterations" },
  { name: "infer", what: "dense-layer inference", detail: "4096x512 -> 32, 67M MACs" },
];

const selected = only.length ? KERNELS.filter((k) => only.includes(k.name)) : KERNELS;

// ---------------------------------------------------------------------------

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
}

function timeIt(fn) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    const out = fn();
    const t1 = process.hrtime.bigint();
    if (out === null) return { ms: null, output: null };
    times.push(Number(t1 - t0) / 1e6);
  }
  return { ms: Math.min(...times), output: null };
}

/** Kernels print their checksum first and may print timings after it. */
function checksumOf(out) {
  return out === null ? null : String(out).split(String.fromCharCode(10))[0].trim();
}

function runBinary(path) {
  const r = spawnSync(path, [], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/** Build the hand-written C with the same toolchain the Halka backend used. */
function buildC(name) {
  const src = join(HERE, `${name}.c`);
  const out = join(HERE, `${name}_c${EXE}`);
  if (!existsSync(src)) return null;

  if (process.platform === "win32") {
    // Reuse the compiler's own MSVC discovery so the flags match exactly.
    const probe = sh(process.execPath, [HALKA, "toolchain"]);
    if (!/MSVC/.test(probe.stdout ?? "")) return null;
    const bat = join(HERE, "_buildc.bat");
    const vcvars = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat";
    const installer = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer";
    const lines = [
      "@echo off",
      `set "PATH=${installer};%PATH%"`,
      `call "${vcvars}" >nul 2>&1`,
      `cd /d "${HERE}"`,
      `cl /nologo /std:c11 /O2 /DNDEBUG /Fe:${name}_c.exe ${name}.c >nul`,
      "",
    ].join("\r\n");
    writeFileSync(bat, lines, "ascii");
    const r = sh(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", bat]);
    rmSync(bat, { force: true });
    if (r.status !== 0) return null;
    return out;
  }

  const cc = process.env.CC ?? "cc";
  const r = sh(cc, ["-std=c99", "-O2", "-DNDEBUG", src, "-o", out, "-lm"]);
  if (r.status !== 0) return null;
  return out;
}

function buildHalka(name) {
  const src = join(HERE, `${name}.hk`);
  const out = join(HERE, `${name}${EXE}`);
  const r = sh(process.execPath, [HALKA, "build", "--release", src, "-o", out]);
  if (r.status !== 0) {
    process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
    return null;
  }
  return out;
}

function findPython() {
  for (const p of ["python", "python3", "py"]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------

const python = findPython();
const rows = [];
const outputs = new Map();

process.stdout.write(`Halka benchmarks — best of ${RUNS}, wall clock including process start\n`);
process.stdout.write(`platform: ${process.platform} ${process.arch}\n\n`);

for (const k of selected) {
  process.stdout.write(`building ${k.name}... `);
  const hk = buildHalka(k.name);
  const c = buildC(k.name);
  process.stdout.write("done\n");

  const row = { kernel: k.name, what: k.what, detail: k.detail };

  if (hk) {
    const first = runBinary(hk);
    outputs.set(`${k.name}:halka`, first);
    row.halka = timeIt(() => runBinary(hk)).ms;
  }
  if (c) {
    const first = runBinary(c);
    outputs.set(`${k.name}:c`, first);
    row.c = timeIt(() => runBinary(c)).ms;
  }
  if (python) {
    const src = join(HERE, `${k.name}.py`);
    if (existsSync(src)) {
      const r = spawnSync(python, [src], { encoding: "utf8" });
      outputs.set(`${k.name}:python`, (r.stdout ?? "").trim());
      row.python = timeIt(() => {
        const rr = spawnSync(python, [src], { encoding: "utf8" });
        return rr.status === 0 ? "" : null;
      }).ms;
    }
  }
  rows.push(row);
}

// ---- correctness before performance ---------------------------------------

process.stdout.write("\ncorrectness\n");
let mismatch = false;
for (const k of selected) {
  // A kernel may print timings after its checksum; only the checksum has to
  // match, and the timings are the whole point of printing them.
  const got = ["halka", "c", "python"]
    .map((l) => [l, checksumOf(outputs.get(`${k.name}:${l}`) ?? null)])
    .filter(([, v]) => v);
  const first = got[0]?.[1];
  const same = got.every(([, v]) => v === first);
  if (!same) mismatch = true;
  process.stdout.write(`  ${same ? "ok  " : "DIFF"} ${k.name.padEnd(8)} ${got.map(([l, v]) => `${l}=${JSON.stringify(v)}`).join("  ")}\n`);
}
if (mismatch) {
  process.stderr.write("\nimplementations disagree — the timings below are meaningless until this is fixed\n");
  process.exit(1);
}

// ---- results ---------------------------------------------------------------

const fmt = (v) => (v === undefined || v === null ? "  —  " : `${v.toFixed(0)} ms`);
const ratio = (a, b) => (a && b ? `${(a / b).toFixed(2)}x` : "—");

process.stdout.write("\n");
const head = ["kernel", "measures", "Halka", "C (/O2)", "Python", "vs C", "vs Python"];
const widths = [10, 20, 10, 10, 11, 8, 10];
process.stdout.write(head.map((h, i) => h.padEnd(widths[i])).join("") + "\n");
process.stdout.write(widths.map((w) => "-".repeat(w - 1) + " ").join("") + "\n");

for (const r of rows) {
  const cells = [
    r.kernel,
    r.what,
    fmt(r.halka),
    fmt(r.c),
    fmt(r.python),
    ratio(r.halka, r.c),
    r.python ? `${(r.python / r.halka).toFixed(0)}x faster` : "—",
  ];
  process.stdout.write(cells.map((c, i) => String(c).padEnd(widths[i])).join("") + "\n");
}

process.stdout.write("\n");
process.stdout.write("`vs C` below 1.00x means Halka was faster than the hand-written C.\n");
process.stdout.write("Both were compiled by the same C compiler with the same flags, so this\n");
process.stdout.write("measures the quality of the code Halka generates, not the compiler.\n");
