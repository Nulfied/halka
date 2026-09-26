// A fuzzer for ownership in the compiled backend.
//
// One real package found eight bugs by existing. Five of them were
// use-after-free or double-free -- a constructor that read its argument as
// borrowed and returned freed memory, a borrowed parameter handed straight
// back, an owning parameter fed something the caller only borrowed, a
// `give` that released what its expression was about to read, and a push of
// an element belonging to a list that was about to be released. The other
// three were leaks. Every one of them was invisible to `halka run`, because
// the interpreter is garbage collected and none of these questions arise
// there.
//
// That is the argument for this file. Ownership is where wrong code
// compiles silently: the program runs, prints something plausible, and is
// wrong in a way only a second engine or an allocation count can see. So
// generate programs and check both:
//
//   1. the compiled program prints exactly what the interpreter prints (R23)
//   2. it ends with no heap objects still live
//
// The shapes are the ones that broke -- a name stored in a container and
// then assigned again, a parameter given back on one path and not another,
// a Result matched with and without being bound first, a string built up in
// a loop, an element of one list passed to a function that keeps it. They
// are composed rather than enumerated, so the combinations are new even
// though the pieces are not.
//
// A C compile costs about a second, so the suite runs a handful and this
// file run directly is the soak:
//
//   node --experimental-strip-types test/fuzz-memory.ts 200

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parse } from "../src/parser/parser.ts";
import { check } from "../src/sema/check.ts";
import { inferTypes } from "../src/sema/infer.ts";
import { checkOwnership } from "../src/sema/ownership.ts";
import { analyseEscapes } from "../src/sema/escape.ts";
import { emitC, emitOptionsFrom } from "../src/backend/c/emit.ts";
import { buildNative, findToolchain } from "../src/backend/c/build.ts";
import { Interpreter, HalkaRuntimeError } from "../src/interp/interpreter.ts";
import { renderAll } from "../src/util/diagnostics.ts";

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------

/** mulberry32, so a failing seed is a program anyone can rebuild. */
function rngFor(seed: number): () => number {
  let a = (seed + 0x9e3779b9) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text to feed the generated parsers, chosen for separators and emptiness. */
const INPUTS = [
  "a,b,c", "a,,b", ",a", "a,", "", "one", "x,y\nz,w", "p\nq", "a,b\n",
  "long,er,fields,here", "é,क", "a,b,c,d,e,f",
];

export class MemGen {
  private rng: () => number;
  private out: string[] = [];
  private n = 0;
  /** Names in scope, by what they hold. */
  private strs: string[] = [];
  private lists: string[] = [];
  /**
   * Lists a `for` is walking right now. Pushing into one of those grows it
   * as fast as the loop reads it, and the program never ends -- a bug in
   * this file rather than in anything it is testing.
   */
  private iterating: string[] = [];
  /** Helper functions this program defines, and what they take. */
  private helpers: { name: string; takes: "str" | "list"; gives: "str" | "result" }[] = [];

  constructor(seed: number) {
    this.rng = rngFor(seed);
  }

  private int(n: number): number { return Math.floor(this.rng() * n); }
  private pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]!; }
  private chance(p: number): boolean { return this.rng() < p; }
  private fresh(p: string): string { return `${p}${this.n++}`; }
  private emit(d: number, s: string): void { this.out.push("    ".repeat(d) + s); }

  // ---- expressions ------------------------------------------------------

  /** A string, built rather than written where possible: a literal is a
   *  static with no count on it, and hides every question this asks. */
  private str(d: number): string {
    const forms: (() => string)[] = [
      () => `"${this.pick(INPUTS).replace(/\n/g, "\\n")}"`,
      () => `"piece{${this.int(9)}}"`,
    ];
    if (this.strs.length) {
      const v = this.pick(this.strs);
      forms.push(() => v, () => `${v} + "-"`, () => `"{${v}}!"`);
      if (d > 0) forms.push(() => `${v} + ${this.str(d - 1)}`);
    }
    if (this.lists.length) {
      const l = this.pick(this.lists);
      forms.push(() => `${l}.join("|")`, () => `"{${l}.length}"`);
    }
    // Only the ones that give a string back: a `Result` is not one, and
    // pushing it into a list of strings is a program that does not compile
    // rather than a program that compiles wrongly.
    const takesStr = this.helpers.filter((x) => x.takes === "str" && x.gives === "str");
    if (takesStr.length && this.strs.length && d > 0) {
      const f = this.pick(takesStr);
      const v = this.pick(this.strs);
      forms.push(() => `${f.name}(${v})`);
    }
    const takesList = this.helpers.filter((x) => x.takes === "list" && x.gives === "str");
    if (takesList.length && this.lists.length && d > 0) {
      const f = this.pick(takesList);
      const l = this.pick(this.lists);
      forms.push(() => `${f.name}(${l})`);
    }
    return this.pick(forms)();
  }

  // ---- statements -------------------------------------------------------

  private stmt(d: number, depth: number): void {
    const roll = this.rng();

    // A name bound to a built string, which later statements may store and
    // then assign again -- the shape the whole file exists for.
    if (roll < 0.18 || this.strs.length === 0) {
      const v = this.fresh("s");
      this.emit(d, `let ${v}: ${this.str(1)},`);
      this.strs.push(v);
      return;
    }

    if (roll < 0.3 || this.lists.length === 0) {
      const v = this.fresh("xs");
      this.emit(d, `let ${v}: [],`);
      this.lists.push(v);
      // A list literal starts empty, so give it something to hold. It is
      // brand new, so nothing can be walking it.
      this.emit(d, `${v}.push(${this.str(1)}),`);
      return;
    }

    // Store a name, then start it again. Read as a move this leaked one
    // value per store; read as a copy it would free one twice.
    if (roll < 0.5) {
      const targets = this.lists.filter((l) => !this.iterating.includes(l));
      if (!targets.length) { this.emit(d, `say ${this.str(0)},`); return; }
      const l = this.pick(targets);
      const v = this.pick(this.strs);
      this.emit(d, `${l}.push(${v}),`);
      if (this.chance(0.7)) {
        // Started again, so the name goes on being used -- the copy case.
        this.emit(d, `${v}: ${this.chance(0.5) ? '""' : this.str(0)},`);
      } else {
        // Left alone, so the name is finished with -- the move case. It is
        // dropped from scope here because reading it again is a use after
        // move, which ownership refuses (M2): a program that never reaches
        // the backend tests nothing here.
        const at = this.strs.indexOf(v);
        if (at >= 0) this.strs.splice(at, 1);
      }
      return;
    }

    // Reassign without storing: the accumulator.
    if (roll < 0.6) {
      const v = this.pick(this.strs);
      this.emit(d, `${v}: ${this.str(1)},`);
      return;
    }

    // A loop over a list, which borrows each element.
    if (roll < 0.72 && depth < 2) {
      const l = this.pick(this.lists);
      const it = this.fresh("e");
      this.emit(d, `for ${it} in ${l},`);
      const outer = this.strs;
      this.strs = [...outer, it];
      this.iterating.push(l);
      this.block(d + 1, depth + 1);
      this.iterating.pop();
      this.strs = outer;
      return;
    }

    // A counted loop, so anything unbalanced accumulates.
    if (roll < 0.82 && depth < 2) {
      const it = this.fresh("i");
      this.emit(d, `for ${it} in 0..${2 + this.int(4)},`);
      this.block(d + 1, depth + 1);
      return;
    }

    if (roll < 0.9 && depth < 2) {
      this.emit(d, `if ${this.cond()},`);
      this.block(d + 1, depth + 1);
      if (this.chance(0.6)) {
        this.emit(d, "else,");
        this.block(d + 1, depth + 1);
      }
      return;
    }

    this.emit(d, `say ${this.chance(0.4) && this.lists.length ? this.pick(this.lists) : this.str(1)},`);
  }

  private cond(): string {
    const v = this.strs.length ? this.pick(this.strs) : null;
    const l = this.lists.length ? this.pick(this.lists) : null;
    const forms: string[] = [];
    if (v) forms.push(`${v}.length > ${this.int(4)}`, `${v} == ""`, `${v}.contains(",")`);
    if (l) forms.push(`${l}.length > ${this.int(3)}`);
    return forms.length ? this.pick(forms) : "true";
  }

  private block(d: number, depth: number): void {
    // Copied rather than trimmed back by length: a statement may *remove* a
    // name -- one it moved away and must not read again -- and a length is
    // no longer enough to put the scope back.
    const strs = [...this.strs];
    const lists = [...this.lists];
    const n = 1 + this.int(3);
    for (let i = 0; i < n; i++) this.stmt(d, depth);
    // Always something printed, so a block that only allocates is still
    // compared rather than merely run.
    this.emit(d, `say ${this.str(0)},`);
    this.strs = strs;
    this.lists = lists;
  }

  // ---- helpers ----------------------------------------------------------

  /**
   * A function that hands a parameter back on one path and builds on the
   * other. One name needing two answers in one function is where `give`
   * went wrong: given back it must not be released, built around it must.
   */
  private giveParam(): string {
    const name = this.fresh("wrap");
    this.emit(0, `${name}(a: string): string,`);
    this.emit(1, `if a.length > ${this.int(3)},`);
    this.emit(2, "give a,");
    this.emit(1, `give "<" + a + ">"`);
    this.out.push("");
    this.helpers.push({ name, takes: "str", gives: "str" });
    return name;
  }

  /** A parser: builds a list, stores into it, gives it back in a Result. */
  private buildList(): string {
    const name = this.fresh("rows");
    this.emit(0, `${name}(text: string): Result<list(string)>,`);
    this.emit(1, "let out: [],");
    this.emit(1, 'let acc: "",');
    this.emit(1, "for ch in text.chars(),");
    this.emit(2, `if "{ch}" == "${this.pick([",", "\\n", ";"])}",`);
    this.emit(3, "out.push(acc),");
    this.emit(3, 'acc: "",');
    this.emit(2, "else,");
    this.emit(3, 'acc: acc + "{ch}",');
    this.emit(1, "out.push(acc),");
    if (this.chance(0.3)) {
      this.emit(1, "if out.length == 0,");
      this.emit(2, 'give Error("nothing at all")');
    }
    this.emit(1, "give Ok(out)");
    this.out.push("");
    this.helpers.push({ name, takes: "str", gives: "result" });
    return name;
  }

  /** Passes each element of a list it borrowed to a function that keeps it. */
  private mapList(over: string): string {
    const name = this.fresh("mapped");
    this.emit(0, `${name}(xs: list(string)): string,`);
    this.emit(1, "let parts: [],");
    this.emit(1, "for x in xs,");
    this.emit(2, `parts.push(${over}(x)),`);
    this.emit(1, 'give parts.join("|")');
    this.out.push("");
    this.helpers.push({ name, takes: "list", gives: "str" });
    return name;
  }

  // ---- the program ------------------------------------------------------

  program(): string {
    const wrap = this.giveParam();
    const rows = this.chance(0.85) ? this.buildList() : null;
    const mapped = this.chance(0.7) ? this.mapList(wrap) : null;

    this.emit(0, "main(),");
    const body = 2 + this.int(4);
    for (let i = 0; i < body; i++) this.stmt(1, 0);

    // The Result, matched both ways: bound to a name first, and straight
    // from the call with nobody holding it.
    if (rows) {
      const text = `"${this.pick(INPUTS).replace(/\n/g, "\\n")}"`;
      if (this.chance(0.5)) {
        const r = this.fresh("r");
        this.emit(1, `let ${r}: ${rows}(${text}),`);
        this.emit(1, `match ${r},`);
      } else {
        this.emit(1, `match ${rows}(${text}),`);
      }
      this.emit(2, "Ok(got),");
      this.emit(3, "say got,");
      this.emit(3, "say got.length,");
      if (mapped) this.emit(3, `say ${mapped}(got),`);
      this.emit(2, "Error(message),");
      this.emit(3, "say message,");
    }

    // And a loop of the whole thing, so an imbalance of one accumulates
    // into something the allocation count can see.
    if (rows) {
      this.emit(1, `for k in 0..${2 + this.int(4)},`);
      this.emit(2, `match ${rows}("a,b,c"),`);
      this.emit(3, "Ok(got),");
      this.emit(4, "say got.length,");
      this.emit(3, "Error(message),");
      this.emit(4, "say message,");
    }
    this.emit(1, `say "done"`);
    return this.out.join("\n") + "\n";
  }
}

export function programFor(seed: number): string {
  return new MemGen(seed).program();
}

// ---------------------------------------------------------------------------
// the properties
// ---------------------------------------------------------------------------

export interface MemOutcome {
  kind: "ok" | "skipped" | "failed";
  /** Why it was skipped or how it failed. */
  detail?: string;
  property?: string;
  allocations?: number;
}

function runInterpreted(src: string, file: string): { out: string; error: string | null } {
  const lines: string[] = [];
  const { module, diags } = parse(src, file);
  const sema = check(module);
  const errs = [...diags.items, ...sema.items].filter((d) => d.severity === "error");
  if (errs.length) return { out: "", error: renderAll(errs.slice(0, 2), { source: src }) };
  const interp = new Interpreter({ out: (s) => lines.push(s), err: (s) => lines.push(s), stepLimit: 5_000_000 });
  try {
    interp.run(module);
  } catch (e) {
    return { out: lines.join("\n"), error: e instanceof HalkaRuntimeError ? `${e.code}: ${e.msg}` : String(e) };
  }
  return { out: lines.join("\n"), error: null };
}

/**
 * Compile and run one seed.
 *
 * A program the backend refuses is *skipped*, not failed: R23 lets it
 * reject, and the generator is bound to wander into something it has not
 * grown yet. The count of those is reported, because a generator that has
 * drifted entirely into unsupported territory would otherwise look exactly
 * like a backend with no bugs left.
 */
export function checkSeed(seed: number): MemOutcome {
  const src = programFor(seed);
  const file = `mem-${seed}.hk`;

  const { module, diags } = parse(src, file);
  const sema = check(module);
  if (diags.hasErrors || sema.hasErrors) {
    return {
      kind: "failed", property: "generated source compiles",
      detail: renderAll([...diags.items, ...sema.items].slice(0, 2), { source: src }),
    };
  }
  const inferred = inferTypes(module);
  if (inferred.diags.hasErrors) {
    return {
      kind: "failed", property: "generated source type-checks",
      detail: renderAll(inferred.diags.items.slice(0, 2), { source: src }),
    };
  }

  const own = checkOwnership(module, inferred.types, inferred.structFields);
  if (own.diags.hasErrors) return { kind: "skipped", detail: "ownership refused it" };

  const escapes = analyseEscapes(module, inferred.types, inferred.structFields, own.owningParams, inferred.enumVariants);
  const { c, diags: emitDiags } = emitC(module, inferred.types,
    emitOptionsFrom(inferred, { file, release: false, escapes, owningParams: own.owningParams }));
  if (emitDiags.hasErrors) {
    // E07xx is the backend saying it has not grown this yet, which it is
    // allowed to say.
    return { kind: "skipped", detail: renderAll(emitDiags.items.slice(0, 1), { source: src }) };
  }

  const exe = join(tmpdir(), `halka-memfuzz-${process.pid}-${seed}${process.platform === "win32" ? ".exe" : ""}`);
  const outcome = buildNative(c, file, { out: exe, release: false, keepC: false, emitOnly: false, quiet: true });
  if (!outcome.ok) {
    return { kind: "failed", property: "the generated C compiles", detail: `${outcome.message ?? "build failed"}\n--- program ---\n${src}` };
  }

  try {
    // A generated program should finish in well under a second; anything
    // that does not is a runaway, and killing it beats hanging the suite.
    const r = spawnSync(exe, [], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, HALKA_REPORT_LEAKS: "1" },
    });
    const stdout = (r.stdout ?? "").split("\r\n").join("\n").replace(/\s+$/, "");
    const stderr = r.stderr ?? "";
    if (r.status !== 0) {
      return {
        kind: "failed", property: "the compiled program runs",
        detail: `exit ${r.status}${r.signal ? ` (${r.signal})` : ""}\n${stdout}\n${stderr}\n--- program ---\n${src}`,
      };
    }

    const interp = runInterpreted(src, file);
    if (interp.error) {
      return { kind: "failed", property: "the interpreter runs it", detail: `${interp.error}\n--- program ---\n${src}` };
    }
    if (interp.out.replace(/\s+$/, "") !== stdout) {
      return {
        kind: "failed", property: "both engines print the same thing",
        detail: firstDiff(interp.out.replace(/\s+$/, ""), stdout) + `\n--- program ---\n${src}`,
      };
    }

    const m = /halka: (\d+) heap object\(s\) still live at exit, of (\d+) allocated/.exec(stderr);
    if (!m) return { kind: "failed", property: "it reports its allocations", detail: stderr };
    if (Number(m[1]) !== 0) {
      return {
        kind: "failed", property: "it leaks nothing",
        detail: `${m[1]} heap object(s) still live at exit, of ${m[2]} allocated\n--- program ---\n${src}`,
      };
    }
    return { kind: "ok", allocations: Number(m[2]) };
  } finally {
    if (existsSync(exe)) rmSync(exe, { force: true });
  }
}

function firstDiff(want: string, got: string): string {
  const w = want.split("\n");
  const g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) {
    if (w[i] === g[i]) continue;
    return `  line ${i + 1}:\n    interpreter: ${JSON.stringify(w[i] ?? "<missing>")}\n    compiled:    ${JSON.stringify(g[i] ?? "<missing>")}`;
  }
  return "  (they differ only in length)";
}

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

/**
 * How many the suite runs. Each one is a C compile, so this is the budget
 * rather than a target; the soak is this file run directly.
 */
export const MEM_FUZZ_SEEDS = 12;

export function suiteFuzzMemory(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
  seeds = MEM_FUZZ_SEEDS,
): void {
  if (!findToolchain()) return; // the native suite says so once already

  let compiled = 0;
  let skipped = 0;
  const failures: { seed: number; property: string; detail: string }[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const r = checkSeed(seed);
    if (r.kind === "ok") compiled++;
    else if (r.kind === "skipped") skipped++;
    else failures.push({ seed, property: r.property ?? "unknown", detail: r.detail ?? "" });
  }

  for (const p of ["generated source compiles", "generated source type-checks", "the generated C compiles",
    "the compiled program runs", "the interpreter runs it", "both engines print the same thing",
    "it reports its allocations", "it leaks nothing"]) {
    const hits = failures.filter((f) => f.property === p);
    if (!hits.length) { ok("memfuzz", `${p} (${compiled} of ${seeds} programs)`); continue; }
    const f = hits[0]!;
    bad("memfuzz", p,
      `${hits.length} of ${seeds} failed; first was seed ${f.seed}\n` +
      `reproduce: node --experimental-strip-types test/fuzz-memory.ts --seed ${f.seed}\n${f.detail}`);
  }

  // A generator that has drifted into things the backend refuses would pass
  // every property above while proving nothing at all.
  if (compiled >= Math.ceil(seeds / 2)) ok("memfuzz", `most programs reach the backend (${compiled} compiled, ${skipped} skipped)`);
  else bad("memfuzz", "most programs reach the backend",
    `only ${compiled} of ${seeds} compiled; ${skipped} were skipped, so the properties above checked almost nothing`);
}

// ---------------------------------------------------------------------------
// standalone
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("fuzz-memory.ts")) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--seed");
  if (at >= 0) {
    const seed = Number(args[at + 1]);
    process.stdout.write(`--- seed ${seed} ---\n${programFor(seed)}\n`);
    const r = checkSeed(seed);
    process.stdout.write(`${r.kind}${r.property ? `: ${r.property}` : ""}\n${r.detail ?? ""}\n`);
    process.exit(r.kind === "failed" ? 1 : 0);
  }
  if (!findToolchain()) {
    process.stdout.write("no C compiler found\n");
    process.exit(0);
  }
  const n = Number(args[0]) || 100;
  const t0 = Date.now();
  let compiled = 0, skipped = 0;
  for (let seed = 1; seed <= n; seed++) {
    const r = checkSeed(seed);
    if (r.kind === "ok") compiled++;
    else if (r.kind === "skipped") skipped++;
    else {
      process.stdout.write(`FAIL seed ${seed}: ${r.property}\n${r.detail}\n`);
      process.exit(1);
    }
    if (seed % 25 === 0) {
      process.stdout.write(`  ${seed} seeds, ${compiled} compiled, ${skipped} skipped, ${Date.now() - t0}ms\n`);
    }
  }
  process.stdout.write(`${n} seeds: ${compiled} compiled, ${skipped} skipped, no failures  (${Date.now() - t0}ms)\n`);
}
