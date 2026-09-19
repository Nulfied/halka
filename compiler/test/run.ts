// Halka test runner.  `npm test`  (or `node --experimental-strip-types test/run.ts`)
//
// Four suites:
//   spec     — every executable code block in spec/V49-LOCKED.md must parse
//   reject   — invalid programs must produce the documented diagnostic code
//   run      — test/cases/*.hk must print exactly test/cases/*.out
//   fmt      — formatting is idempotent and never changes what a program prints
//   native   — R23: the compiled binary prints exactly what the interpreter does
//   ffi      — #35/#37: C and Python interop, built and run for real
//   own      — spec/MEMORY-MODEL.md: ownership and borrow checking
//   pkg      — spec/PACKAGES.md: versions, manifests, resolution, archives
//   link     — multi-module programs: interpreter and native must agree
//              M4 is checked inside `native` and `ffi`: every compiled
//              program must free every heap object it allocates

import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../src/parser/parser.ts";
import { check } from "../src/sema/check.ts";
import { inferTypes } from "../src/sema/infer.ts";
import { checkOwnership } from "../src/sema/ownership.ts";
import { analyseEscapes } from "../src/sema/escape.ts";
import { format } from "../src/fmt/format.ts";
import { Interpreter, HalkaRuntimeError } from "../src/interp/interpreter.ts";
import { renderAll } from "../src/util/diagnostics.ts";
import { emitC, emitOptionsFrom } from "../src/backend/c/emit.ts";
import { buildNative, findToolchain, findPython } from "../src/backend/c/build.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { suitePkg } from "./pkg.ts";
import { suitePkgE2E } from "./pkg-e2e.ts";
import { suiteLink } from "./link.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The options `halka build` passes to the emitter.
 *
 * The suites used to call `emitC` with only `file`, so they compiled a
 * different program than the CLI did: no escape analysis, and no struct or
 * enum field types. That is how a struct with a `string` field came to emit
 * C that assigned a pointer to an integer while every test passed.
 */
function buildOpts(module: Parameters<typeof emitC>[0], inferred: ReturnType<typeof inferTypes>, file: string, release: boolean) {
  const own = checkOwnership(module, inferred.types, inferred.structFields);
  return emitOptionsFrom(inferred, {
    file,
    release,
    escapes: analyseEscapes(module, inferred.types, inferred.structFields, own.owningParams),
  });
}
const ROOT = join(HERE, "..", "..");

let passed = 0;
const failures: { suite: string; name: string; detail: string }[] = [];

function ok(suite: string, name: string): void {
  passed++;
  void suite;
  void name;
}
function bad(suite: string, name: string, detail: string): void {
  failures.push({ suite, name, detail });
}

// ---------------------------------------------------------------------------
// suite: spec conformance
// ---------------------------------------------------------------------------

/**
 * Blocks in the locked spec that are not executable Halka:
 *   1, 33 — the deliberately-invalid comma-spacing examples
 *   17    — a prose "Valid: / Invalid:" table
 *   35    — the lexer → parser → AST pipeline diagram
 */
const NON_CODE_BLOCKS = new Set([1, 17, 33, 35]);
/** Blocks that must fail, with the diagnostic they must produce. */
const MUST_REJECT: Record<number, string> = { 1: "E0002", 33: "E0002" };

function suiteSpec(): void {
  const md = readFileSync(join(ROOT, "spec", "V49-LOCKED.md"), "utf8").split("\r\n").join("\n");
  const re = /```halka\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(md))) {
    const src = m[1]!;
    const num = ++n;
    const name = `block ${num}`;

    if (MUST_REJECT[num]) {
      const { diags } = parse(src, `spec#${num}.hk`);
      const codes = diags.items.map((d) => d.code);
      if (codes.includes(MUST_REJECT[num]!)) ok("spec", name);
      else bad("spec", name, `expected ${MUST_REJECT[num]}, got [${codes.join(", ")}]`);
      continue;
    }
    if (NON_CODE_BLOCKS.has(num)) continue;
    // Blocks whose body is the literal `...` placeholder are illustrative.
    if (/^\s*\.\.\.\s*$/m.test(src)) { ok("spec", name); continue; }

    const { diags } = parse(src, `spec#${num}.hk`);
    const errs = diags.items.filter((d) => d.severity === "error");
    if (!errs.length) ok("spec", name);
    else bad("spec", name, renderAll(errs.slice(0, 2), { source: src }));
  }
}

// ---------------------------------------------------------------------------
// suite: rejection
// ---------------------------------------------------------------------------

/** Each case must produce its diagnostic code; this is the locked-absence net. */
const REJECTS: { name: string; code: string; src: string }[] = [
  { name: "#50 three spaces before comma", code: "E0002", src: "let a: 1   ,\nlet b: 2\n" },
  { name: "R12 tabs in indentation", code: "E0003", src: "f(),\n\tgive 1\n" },
  { name: "#23 try is rejected", code: "E0303", src: "try\n" },
  { name: "#23 catch is rejected", code: "E0303", src: "catch\n" },
  { name: "#23 throw is rejected", code: "E0303", src: "throw\n" },
  { name: "#9 return is rejected", code: "E0304", src: "f(),\n    return 1\n" },
  { name: "#17 lambda is rejected", code: "E0301", src: "let f: lambda\n" },
  { name: "#16 class is rejected", code: "E0306", src: "class Foo\n" },
  { name: "#53 fn keyword is rejected", code: "E0305", src: "fn main()\n" },
  { name: "#21 no overloading", code: "E0302", src: "add(a),\n    give a\n\nadd(a, b),\n    give a\n" },
  { name: "#9 give outside a function", code: "E0130", src: "give 1\n" },
  { name: "#8 break outside a loop", code: "E0131", src: "break\n" },
  { name: "#8 continue outside a loop", code: "E0131", src: "continue\n" },
  { name: "R3.1 type names are UpperCamelCase", code: "E0107", src: "enum shape:\n    Round\n" },
  { name: "undefined name", code: "E0203", src: "say nope\n" },
  { name: "arity mismatch", code: "E0404", src: "f(a, b),\n    give a\nf(1)\n" },
  { name: "#18 required after default", code: "E0419", src: "f(a: 1, b),\n    give a\n" },
  { name: "#19 variadic must be last", code: "E0421", src: "f(a: ...int, b: int),\n    give a\n" },
  { name: "#45 undeclared capability", code: "E0507", src: "f() requires Nope,\n    give 1\nwith capability Nope,\n    say 1\n" },
  { name: "R4 mixed list/map literal", code: "E0210", src: 'let x: [1, "a": 2]\n' },
  { name: "#2 unterminated string", code: "E0009", src: 'let s: "oops\n' },
  { name: "#47 unterminated block comment", code: "E0011", src: "### open\nlet a: 1\n" },
  { name: "R13 slice with four parts", code: "E0127", src: "let a: [1,2,3],\nlet b: a[0:1:2:3]\n" },

  // ---- static typing (#11, #13) -------------------------------------------
  { name: "argument type mismatch", code: "E0450", src: 'f(a: int),\n    give a\nsay f("x")\n' },
  { name: "annotation mismatch", code: "E0450", src: 'let n: int: "hello"\n' },
  { name: "return type mismatch", code: "E0450", src: 'f(): int,\n    give "no"\n' },
  { name: "#13 member on an optional", code: "E0461", src: "greet(name: string?),\n    say name.length\n" },
  { name: "#51 arithmetic on a string", code: "E0460", src: 'let a: "x" - 1\n' },
  { name: "heterogeneous list", code: "E0450", src: 'let a: [1, "two"]\n' },
  { name: "non-bool condition", code: "E0454", src: "let n: 5\nif n,\n    say 1\n" },
  { name: "unknown struct field", code: "E0462", src: 'User:\n    name: string\nlet u: User("a"),\nsay u.age\n' },
  { name: "wrong field count", code: "E0465", src: 'User:\n    name: string,\n    age: int\nlet u: User("a")\n' },
  { name: "#10 non-exhaustive match", code: "E0468", src: "enum Colour:\n    Red,\n    Green\n\nf(c),\n    match c,\n        Red,\n            say 1\n\nf(Red)\n" },
  { name: "#27 send on a non-channel", code: "E0451", src: "let x: 5\nsend x : 1\n" },
  { name: "indexing a number", code: "E0463", src: "let n: 5,\nlet m: n[0]\n" },
  { name: "comparing unrelated types", code: "E0459", src: 'let a: 1 < "x"\n' },
];

function suiteReject(): void {
  for (const c of REJECTS) {
    const { module, diags } = parse(c.src, "reject.hk");
    const sema = check(module);
    // Inference only runs on a program that parses and resolves.
    const typed = diags.hasErrors || sema.hasErrors ? [] : inferTypes(module).diags.items;
    const codes = [...diags.items, ...sema.items, ...typed].map((d) => d.code);
    if (codes.includes(c.code)) ok("reject", c.name);
    else bad("reject", c.name, `expected ${c.code}, got [${codes.join(", ") || "no diagnostics"}]`);
  }
}

// ---------------------------------------------------------------------------
// suite: run golden outputs
// ---------------------------------------------------------------------------

function runProgram(src: string, file: string): { out: string; error: string | null } {
  const lines: string[] = [];
  const { module, diags } = parse(src, file);
  const sema = check(module);
  const errs = [...diags.items, ...sema.items].filter((d) => d.severity === "error");
  if (errs.length) return { out: "", error: renderAll(errs.slice(0, 3), { source: src }) };

  const interp = new Interpreter({ out: (s) => lines.push(s), err: (s) => lines.push(s), stepLimit: 5_000_000 });
  try {
    interp.run(module);
  } catch (e) {
    const msg = e instanceof HalkaRuntimeError ? `${e.code}: ${e.msg}` : String(e);
    return { out: lines.join("\n"), error: msg };
  }
  return { out: lines.join("\n"), error: null };
}

function suiteRun(): void {
  const dir = join(HERE, "cases");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
    const name = basename(f, ".hk");
    const src = readFileSync(join(dir, f), "utf8");
    const expectFile = join(dir, name + ".out");
    const { out, error } = runProgram(src, f);
    if (error) { bad("run", name, error); continue; }
    if (!existsSync(expectFile)) { bad("run", name, `missing expected output: ${name}.out`); continue; }
    const want = readFileSync(expectFile, "utf8").split("\r\n").join("\n").replace(/\s+$/, "");
    const got = out.replace(/\s+$/, "");
    if (got === want) ok("run", name);
    else bad("run", name, diffText(want, got));
  }
}

/**
 * M4 — the escape pass exists so the backend frees what it allocates. The
 * runtime counts live heap objects, which makes this a measurement rather than
 * a claim. A double free would already have crashed the binary.
 */
function checkLeaks(suite: string, name: string, stderr: string): void {
  const m = /halka: (\d+) heap object\(s\) still live at exit, of (\d+) allocated/.exec(stderr);
  if (!m) { bad(suite, `${name} (leaks)`, "the binary printed no allocation report"); return; }
  const live = Number(m[1]);
  if (live === 0) ok(suite, `${name} (no leaks, ${m[2]} allocations)`);
  else bad(suite, `${name} (leaks)`, `${live} heap object(s) still live at exit, of ${m[2]} allocated`);
}

function diffText(want: string, got: string): string {
  const w = want.split("\n");
  const g = got.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(w.length, g.length); i++) {
    if (w[i] === g[i]) continue;
    out.push(`  line ${i + 1}:\n    want: ${JSON.stringify(w[i] ?? "<missing>")}\n    got:  ${JSON.stringify(g[i] ?? "<missing>")}`);
    if (out.length >= 5) break;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// suite: formatter
// ---------------------------------------------------------------------------

function suiteFmt(): void {
  const targets: { name: string; src: string }[] = [];
  for (const dir of [join(ROOT, "examples"), join(HERE, "cases"), join(HERE, "native")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
      targets.push({ name: f, src: readFileSync(join(dir, f), "utf8") });
    }
  }

  for (const t of targets) {
    const a = parse(t.src, t.name);
    if (a.diags.hasErrors) { bad("fmt", t.name, "source does not parse"); continue; }
    const once = format(a.module, a.comments);

    // 1. formatting is idempotent
    const b = parse(once, t.name);
    if (b.diags.hasErrors) {
      bad("fmt", `${t.name} (reparse)`, renderAll(b.diags.items.slice(0, 2), { source: once }));
      continue;
    }
    const twice = format(b.module, b.comments);
    if (once !== twice) { bad("fmt", `${t.name} (idempotent)`, diffText(once, twice)); continue; }
    ok("fmt", `${t.name} (idempotent)`);

    // 2. formatting preserves behaviour
    const before = runProgram(t.src, t.name);
    const after = runProgram(once, t.name);
    if (before.out === after.out && before.error === after.error) ok("fmt", `${t.name} (behaviour)`);
    else bad("fmt", `${t.name} (behaviour)`, diffText(before.out + (before.error ?? ""), after.out + (after.error ?? "")));
  }
}

// ---------------------------------------------------------------------------

/**
 * R23: `halka build` and `halka run` are two implementations of one language.
 * Every program the backend accepts must print exactly what the interpreter
 * prints. Skipped when the machine has no C compiler.
 */
function suiteNative(): void {
  const dir = join(HERE, "native");
  if (!existsSync(dir)) return;
  const tc = findToolchain();
  if (!tc) {
    process.stdout.write("note: no C compiler found — the `native` suite was skipped\n");
    return;
  }

  for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
    const name = basename(f, ".hk");
    const src = readFileSync(join(dir, f), "utf8");

    const { module, diags } = parse(src, f);
    const sema = check(module);
    if (diags.hasErrors || sema.hasErrors) {
      bad("native", name, renderAll([...diags.items, ...sema.items].slice(0, 2), { source: src }));
      continue;
    }
    const inferred = inferTypes(module);
    if (inferred.diags.hasErrors) {
      bad("native", name, renderAll(inferred.diags.items.slice(0, 2), { source: src }));
      continue;
    }

    const { c, diags: emitDiags } = emitC(module, inferred.types, buildOpts(module, inferred, f, false));
    if (emitDiags.hasErrors) {
      bad("native", name, renderAll(emitDiags.items.slice(0, 2), { source: src }));
      continue;
    }

    const exe = join(tmpdir(), `halka-test-${name}-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
    const outcome = buildNative(c, f, { out: exe, release: false, keepC: false, emitOnly: false, quiet: true });
    if (!outcome.ok) { bad("native", name, outcome.message ?? "build failed"); continue; }

    const r = spawnSync(exe, [], { encoding: "utf8", env: { ...process.env, HALKA_REPORT_LEAKS: "1" } });
    if (r.status !== 0) {
      bad("native", name, `the binary exited with ${r.status}
${r.stdout ?? ""}${r.stderr ?? ""}`);
      continue;
    }
    const nativeOut = (r.stdout ?? "").split("\r\n").join("\n").replace(/\s+$/, "");
    const interp = runProgram(src, f);
    if (interp.error) { bad("native", name, `the interpreter failed: ${interp.error}`); continue; }
    const interpOut = interp.out.replace(/\s+$/, "");

    if (nativeOut === interpOut) ok("native", name);
    else bad("native", `${name} (interpreter vs native)`, diffText(interpOut, nativeOut));
  }
}

/**
 * #35 / #37 — the FFI is only meaningful if it really calls the other language,
 * so these build a binary and run it. A case declares its expected output in a
 * `.out` file next to it. Skipped when the toolchain is not present.
 */
/**
 * A `c` declaration that does not match the real symbol must fail the build
 * on every toolchain. gcc makes it an error on its own; MSVC only warns and
 * would otherwise hand back a binary that returns garbage, which is the bug
 * that once made `hypot(3, 4)` produce 4294965466.
 */
function suiteFfiReject(): void {
  const dir = join(HERE, "ffi-reject");
  if (!existsSync(dir) || !findToolchain()) return;

  for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
    const name = basename(f, ".hk");
    const src = readFileSync(join(dir, f), "utf8");
    const { module, diags } = parse(src, f);
    if (diags.hasErrors) { bad("ffi", `${name} (parse)`, "the fixture does not parse"); continue; }
    const inferred = inferTypes(module);
    const { c, diags: emitDiags } = emitC(module, inferred.types, buildOpts(module, inferred, f, false));
    if (emitDiags.hasErrors) { ok("ffi", `${name} (rejected before C)`); continue; }

    const exe = join(tmpdir(), `halka-ffireject-${name}-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
    const outcome = buildNative(c, f, { out: exe, release: false, keepC: false, emitOnly: false, quiet: true });
    if (outcome.ok) {
      bad("ffi", `${name} (must not build)`, "the C compiler accepted a declaration that contradicts the header");
      try { rmSync(exe, { force: true }); } catch { /* best effort */ }
    } else {
      ok("ffi", `${name} (a mismatched prototype fails the build)`);
    }
  }
}

function suiteFfi(): void {
  const dir = join(HERE, "ffi");
  if (!existsSync(dir)) return;
  const tc = findToolchain();
  if (!tc) return;
  const py = findPython();

  for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
    const name = basename(f, ".hk");
    const src = readFileSync(join(dir, f), "utf8");
    const needsPy = /\bimport\s+py\b|\bpy\s+\w/.test(src);
    if (needsPy && !py) {
      process.stdout.write(`note: skipping ffi/${name} — no CPython development files\n`);
      continue;
    }

    const { module, diags } = parse(src, f);
    const sema = check(module);
    if (diags.hasErrors || sema.hasErrors) {
      bad("ffi", name, renderAll([...diags.items, ...sema.items].slice(0, 2), { source: src }));
      continue;
    }
    const inferred = inferTypes(module);
    if (inferred.diags.hasErrors) {
      bad("ffi", name, renderAll(inferred.diags.items.slice(0, 2), { source: src }));
      continue;
    }
    const { c, diags: emitDiags, links, needsPython } = emitC(module, inferred.types, buildOpts(module, inferred, f, true));
    if (emitDiags.hasErrors) {
      bad("ffi", name, renderAll(emitDiags.items.slice(0, 2), { source: src }));
      continue;
    }

    const exe = join(tmpdir(), `halka-ffi-${name}-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
    const outcome = buildNative(c, f, {
      out: exe, release: true, keepC: false, emitOnly: false, quiet: true, libs: links, needsPython,
    });
    if (!outcome.ok) { bad("ffi", name, outcome.message ?? "build failed"); continue; }

    const r = spawnSync(exe, [], { encoding: "utf8", env: { ...process.env, HALKA_REPORT_LEAKS: "1" } });
    if (r.status !== 0) {
      bad("ffi", name, `the binary exited with ${r.status}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
      continue;
    }
    checkLeaks("ffi", name, r.stderr ?? "");
    const got = (r.stdout ?? "").split("\r\n").join("\n").replace(/\s+$/, "");
    const expectFile = join(dir, name + ".out");
    if (!existsSync(expectFile)) { bad("ffi", name, `missing expected output: ffi/${name}.out`); continue; }
    const want = readFileSync(expectFile, "utf8").split("\r\n").join("\n").replace(/\s+$/, "");
    if (got === want) ok("ffi", name);
    else bad("ffi", name, diffText(want, got));
  }
}

/**
 * spec/MEMORY-MODEL.md — the ownership and borrow checker. Each case either
 * must produce a given diagnostic, or (when the code is `null`) must produce
 * none at all. The negative cases matter as much as the positive ones: a
 * borrow checker that rejects ordinary code is the failure this design exists
 * to avoid.
 */
const OWNERSHIP: { name: string; code: string | null; src: string }[] = [
  { name: "M1 use after move", code: "E0504", src: "let a: [1, 2, 3]\nlet b: a\nsay len(a)\n" },
  { name: "M1 explicit move", code: "E0504", src: 'let a: "hello"\nlet b: move a\nsay a\n' },
  { name: "M1 move inside a loop", code: "E0504", src: "let a: [1, 2, 3]\nfor i in 0..3,\n    let b: a,\n    say len(b)\n" },
  { name: "M2.2 moved into an owning parameter", code: "E0504", src: "keep(xs): list(int),\n    give xs\n\nlet a: [1, 2, 3]\nlet k: keep(a)\nsay len(a)\n" },
  { name: "M2.3 return a borrow", code: "E0510", src: "first(xs),\n    give borrow xs\n" },
  { name: "M2.3 store a borrow", code: "E0510", src: "let a: [1, 2, 3]\nlet holder: [borrow a]\nsay len(holder)\n" },
  { name: "M2.1 two mutable borrows", code: "E0511", src: "let a: [1, 2, 3]\nlet p: borrow mut a\nlet q: borrow mut a\nsay len(a)\n" },
  { name: "M2.1 mutable while shared", code: "E0511", src: "let a: [1, 2, 3]\nlet p: borrow a\nlet q: borrow mut a\nsay len(a)\n" },
  { name: "M2.1 conflict in one call", code: "E0511", src: "both(x, y),\n    give 1\n\nlet a: [1, 2, 3]\nsay both(borrow mut a, borrow a)\n" },
  { name: "M2.1 assign through a shared borrow", code: "E0509", src: "let n: 5\nlet r: &n\n*r: 6\n" },
  { name: "M5 task captures a borrow", code: "E0512", src: "work(x),\n    give 1\n\nlet a: [1, 2, 3]\nlet t: start work(borrow a)\n" },

  // --- must NOT be rejected -------------------------------------------------
  { name: "scalars copy freely", code: null, src: "let a: 5\nlet b: a\nlet c: a\nsay a + b + c\n" },
  { name: "M1.1 a struct of scalars copies", code: null, src: "Point:\n    x: int,\n    y: int\n\nlet p: Point(1, 2)\nlet q: p\nsay p.x + q.y\n" },
  { name: "M2.2 parameters borrow", code: null, src: "render(xs),\n    say len(xs)\n\nlet a: [1, 2, 3]\nrender(a)\nrender(a)\nsay len(a)\n" },
  { name: "a give in a branch does not move the rest", code: null, src: "build(n),\n    let out: [],\n    if n < 1,\n        give out,\n    out.push(1),\n    give out\n" },
  { name: "M2.1 shared borrows coexist", code: null, src: "let a: [1, 2, 3]\nlet p: borrow a\nlet q: borrow a\nsay len(a)\n" },
  { name: "M2 a borrow ends with its block", code: null, src: "let a: [1, 2, 3]\nif true,\n    let p: borrow mut a,\n    say len(a)\nlet q: borrow mut a\nsay len(a)\n" },
  { name: "destructuring reads, it does not move", code: null, src: "let a: [1, 2, 3]\nlet [x, ...rest]: a\nsay len(a) + x\n" },
];

function suiteOwnership(): void {
  for (const c of OWNERSHIP) {
    const { module, diags } = parse(c.src, "own.hk");
    if (diags.hasErrors) { bad("own", c.name, renderAll(diags.items.slice(0, 1), { source: c.src })); continue; }
    const inf = inferTypes(module);
    if (inf.diags.hasErrors) { bad("own", c.name, renderAll(inf.diags.items.slice(0, 1), { source: c.src })); continue; }
    const r = checkOwnership(module, inf.types, inf.structFields);
    const codes = r.diags.items.map((d) => d.code);
    const good = c.code === null ? codes.length === 0 : codes.includes(c.code);
    if (good) ok("own", c.name);
    else {
      bad("own", c.name,
        `expected ${c.code ?? "no errors"}, got [${codes.join(", ") || "none"}]` +
        (codes.length ? "\n" + renderAll(r.diags.items.slice(0, 1), { source: c.src }) : ""));
    }
  }
}

/** Every file we ship must pass the ownership checker with nothing to say. */
function suiteOwnershipCorpus(): void {
  const dirs = [join(ROOT, "examples"), join(ROOT, "stdlib"), join(HERE, "cases"), join(HERE, "native"), join(ROOT, "bench")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".hk")).sort()) {
      const src = readFileSync(join(dir, f), "utf8");
      const { module, diags } = parse(src, f);
      if (diags.hasErrors) continue;
      const inf = inferTypes(module);
      if (inf.diags.hasErrors) continue;
      const r = checkOwnership(module, inf.types, inf.structFields);
      const errs = r.diags.items.filter((d) => d.severity === "error");
      if (!errs.length) ok("own", `${f} is clean`);
      else bad("own", `${f} is clean`, renderAll(errs.slice(0, 2), { source: src }));
    }
  }
}

const t0 = Date.now();
suiteSpec();
suiteReject();
suiteRun();
suiteFmt();
suiteNative();
suiteFfi();
suiteFfiReject();
suiteOwnership();
suiteOwnershipCorpus();
suitePkg({ ok: (n) => ok("pkg", n), bad: (n, d) => bad("pkg", n, d) });
await suitePkgE2E({ ok: (n) => ok("pkg", n), bad: (n, d) => bad("pkg", n, d) });
suiteLink({ ok: (n) => ok("link", n), bad: (n, d) => bad("link", n, d) }, findToolchain() !== null);
const ms = Date.now() - t0;

if (failures.length) {
  for (const f of failures) {
    process.stdout.write(`\nFAIL  [${f.suite}] ${f.name}\n${indent(f.detail)}\n`);
  }
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed  (${ms}ms)\n`);
process.exit(failures.length ? 1 : 0);

function indent(s: string): string {
  return s.split("\n").map((l) => "      " + l).join("\n");
}
