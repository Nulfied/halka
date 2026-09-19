// Halka test runner.  `npm test`  (or `node --experimental-strip-types test/run.ts`)
//
// Four suites:
//   spec     — every executable code block in spec/V49-LOCKED.md must parse
//   reject   — invalid programs must produce the documented diagnostic code
//   run      — test/cases/*.hk must print exactly test/cases/*.out
//   fmt      — formatting is idempotent and never changes what a program prints

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "../src/parser/parser.ts";
import { check } from "../src/sema/check.ts";
import { format } from "../src/fmt/format.ts";
import { Interpreter, HalkaRuntimeError } from "../src/interp/interpreter.ts";
import { renderAll } from "../src/util/diagnostics.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
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
];

function suiteReject(): void {
  for (const c of REJECTS) {
    const { module, diags } = parse(c.src, "reject.hk");
    const sema = check(module);
    const codes = [...diags.items, ...sema.items].map((d) => d.code);
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
  for (const dir of [join(ROOT, "examples"), join(HERE, "cases")]) {
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

const t0 = Date.now();
suiteSpec();
suiteReject();
suiteRun();
suiteFmt();
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
