// A fuzzer for the formatter.
//
// Four formatter bugs turned up in one week of work, and every one of them
// changed what a program meant: operator precedence dropped the brackets out
// of `(a + b) * c`; a `{` in a string came back as an interpolation; the
// paren form of a type constructor came back as the angle form; and a
// bracketed receiver, `(a or b).n`, came back as `a or b.n`. All four still
// parsed. All four still compiled. Three of the four still printed something
// plausible. None of them was found by reading the formatter -- each one was
// found by accident, when new test material happened to contain the shape
// that broke, which means the shapes nobody had written yet were still broken
// and nobody knew.
//
// A formatter has two properties worth asserting, and both are cheap:
//
//   1. It preserves meaning. Reprinting a program and parsing the result must
//      give back the same tree, to the node. This is the strong one -- it
//      fails on `(a or b).n` even in the cases where the program would have
//      printed the same answer anyway.
//   2. It is idempotent. Formatting formatted source must change nothing.
//
// Both are properties of *every* program, not of the nine in `test/cases`,
// so they can be checked against programs nobody wrote. This file generates
// them: fully bracketed, type-correct, deliberately weighted towards the
// shapes that have broken before -- mixed-precedence arithmetic, braces and
// escapes in strings, bracketed receivers, the paren form of a type
// constructor.
//
// The first four hundred programs found two more bugs:
//
//   * `not (a and b)` was reprinted as `not a and b`. `not` binds tighter
//     than `and` and `or` and looser than the comparisons, and the printer
//     had it as looser than everything, so it never bracketed anything.
//     Fixing it turned up the same hole in `as` and in `is`, which each
//     decided their own bracketing; all four now share one rule.
//   * `"A{"B{"c } d"}E"}F"` did not lex. An interpolation copied a nested
//     string by scanning for the next quote, which one level further in is
//     an *opening* quote, so the `}` inside it closed the wrong
//     interpolation. That one is in the lexer, not the formatter.
//
// Generation is seeded, so a failure is a number you can rerun. The suite
// runs a fixed set of seeds on every `npm test`; for a longer soak:
//
//   node --experimental-strip-types test/fuzz.ts 100000
//
// which reports the first seed that fails and prints the program.

import { parse } from "../src/parser/parser.ts";
import { format } from "../src/fmt/format.ts";
import { check } from "../src/sema/check.ts";
import { Interpreter, HalkaRuntimeError } from "../src/interp/interpreter.ts";
import { renderAll } from "../src/util/diagnostics.ts";

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------

/** The types the generator knows how to build and combine. */
type Ty = "int" | "float" | "bool" | "string" | "list";

interface Var {
  name: string;
  ty: Ty;
  /** Declared `T?`. Readable with `or` and testable with `is null`. */
  opt: boolean;
}

/**
 * An integer expression and a bound on its magnitude. Tracked so the
 * generator never emits arithmetic that overflows: an overflow is a
 * legitimate trap in both engines, but it would end the program early and
 * the comparison after it would be vacuous.
 */
interface IntExpr {
  src: string;
  bound: number;
}

/** Bound assumed for an integer whose value the generator cannot compute. */
const OPAQUE = 1000;

/** mulberry32 -- small, seeded, and identical on every machine. */
function rngFor(seed: number): () => number {
  let a = (seed + 0x6d2b79f5) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * String literal bodies, chosen for the escapes rather than the words. `{`
 * opens an interpolation (#2), so a literal one has to come back out escaped;
 * `}` on its own does not and must not acquire a backslash. Getting either
 * wrong produces source that still parses.
 */
const STR_BODIES = [
  "plain",
  "a \\{ literal brace",
  "closing } brace",
  "both \\{ and }",
  "json-ish: \\{\\\"k\\\": [1]}",
  "quote \\\" inside",
  "backslash \\\\ here",
  "tab\\tand\\nnewline",
  "",
  " leading and trailing ",
  "unicode \\u{00e9} \\u{0915}",
];

export class Gen {
  private rng: () => number;
  private env: Var[] = [];
  private lines: string[] = [];
  private next = 0;
  private loops = 0;

  constructor(seed: number) {
    this.rng = rngFor(seed);
  }

  // ---- random helpers ---------------------------------------------------

  private int(n: number): number {
    return Math.floor(this.rng() * n);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  private chance(p: number): boolean {
    return this.rng() < p;
  }

  private fresh(): string {
    return `v${this.next++}`;
  }

  private vars(ty: Ty, opt = false): Var[] {
    return this.env.filter((v) => v.ty === ty && v.opt === opt);
  }

  // ---- expressions ------------------------------------------------------

  /**
   * Every binary expression is emitted fully bracketed. That makes the tree
   * the generator intended the only tree the source can parse, whatever the
   * precedence table says -- so when the formatter reprints it in its own
   * minimal-bracket form, the comparison is against an unambiguous original.
   */
  private intExpr(d: number): IntExpr {
    const leaves: (() => IntExpr)[] = [
      () => ({ src: String(this.int(10)), bound: 9 }),
      () => ({ src: String(-this.int(10)), bound: 9 }),
    ];
    const vs = this.vars("int");
    if (vs.length) leaves.push(() => ({ src: this.pick(vs).name, bound: OPAQUE }));

    if (d <= 0) return this.pick(leaves)();

    const forms: (() => IntExpr)[] = [
      ...leaves,
      // arithmetic, bounded so it cannot overflow
      () => {
        const a = this.intExpr(d - 1);
        const b = this.intExpr(d - 1);
        const op = this.pick(["+", "-"]);
        return { src: `(${a.src} ${op} ${b.src})`, bound: a.bound + b.bound };
      },
      () => {
        const a = this.intExpr(d - 1);
        const b = this.intExpr(d - 1);
        if (a.bound * b.bound > 1e12) return a;
        return { src: `(${a.src} * ${b.src})`, bound: a.bound * b.bound };
      },
      // a literal divisor, so the remainder cannot be taken modulo zero
      () => {
        const a = this.intExpr(d - 1);
        const m = 1 + this.int(9);
        return { src: `(${a.src} % ${m})`, bound: m - 1 };
      },
      () => ({ src: `-${this.atomInt(d - 1)}`, bound: OPAQUE }),
      // a bracketed receiver: access binds tighter than any operator, so
      // dropping these brackets is a different program that still compiles
      () => ({ src: `(${this.strExpr(d - 1)}).length`, bound: OPAQUE }),
      () => ({ src: `(${this.listExpr(d - 1)}).length`, bound: OPAQUE }),
      () => ({ src: `(${this.floatExpr(d - 1)} as int)`, bound: OPAQUE }),
    ];

    // reading an optional, which is how a `weak` read and a missing value
    // are both spelled
    const opts = this.vars("int", true);
    if (opts.length) {
      forms.push(() => {
        const o = this.pick(opts);
        const fb = this.intExpr(d - 1);
        return { src: `(${o.name} or ${fb.src})`, bound: Math.max(fb.bound, OPAQUE) };
      });
    }
    return this.pick(forms)();
  }

  /** An integer in a position where a bare `-` would read as subtraction. */
  private atomInt(d: number): string {
    const vs = this.vars("int");
    if (vs.length && this.chance(0.5)) return this.pick(vs).name;
    if (d <= 0) return String(this.int(10));
    return `(${this.intExpr(d - 1).src})`;
  }

  private floatExpr(d: number): string {
    const leaves = [
      () => `${this.int(100) / 10}`,
      () => `(${this.intExpr(0).src} as float)`,
    ];
    const vs = this.vars("float");
    if (vs.length) leaves.push(() => this.pick(vs).name);
    if (d <= 0) return this.pick(leaves)();

    return this.pick([
      ...leaves,
      () => `(${this.floatExpr(d - 1)} ${this.pick(["+", "-", "*"])} ${this.floatExpr(d - 1)})`,
      // a literal divisor again, for the same reason
      () => `(${this.intExpr(d - 1).src} / ${1 + this.int(9)})`,
    ])();
  }

  private strExpr(d: number): string {
    const leaves: (() => string)[] = [() => `"${this.pick(STR_BODIES)}"`];
    const vs = this.vars("string");
    if (vs.length) leaves.push(() => this.pick(vs).name);
    if (d <= 0) return this.pick(leaves)();

    const forms: (() => string)[] = [
      ...leaves,
      () => `(${this.strExpr(d - 1)} + ${this.strExpr(d - 1)})`,
      () => `(${this.intExpr(d - 1).src} as string)`,
      // an interpolation holding an expression, beside a literal brace
      () => `"pre {${this.intExpr(Math.min(d - 1, 1)).src}} \\{ post"`,
      () => `"{${this.strExpr(Math.min(d - 1, 1))}} and {${this.intExpr(0).src}}"`,
    ];
    const opts = this.vars("string", true);
    if (opts.length) {
      forms.push(() => `(${this.pick(opts).name} or ${this.strExpr(d - 1)})`);
    }
    return this.pick(forms)();
  }

  private boolExpr(d: number): string {
    const leaves: (() => string)[] = [() => this.pick(["true", "false"])];
    const vs = this.vars("bool");
    if (vs.length) leaves.push(() => this.pick(vs).name);
    if (d <= 0) return this.pick(leaves)();

    const forms: (() => string)[] = [
      ...leaves,
      // mixed precedence across three levels -- `and` under `or` under a
      // comparison is the shape that lost its brackets
      () => `(${this.boolExpr(d - 1)} ${this.pick(["and", "or"])} ${this.boolExpr(d - 1)})`,
      () => `not ${this.atomBool(d - 1)}`,
      () => `(${this.intExpr(d - 1).src} ${this.pick(["<", "<=", ">", ">=", "==", "!="])} ${this.intExpr(d - 1).src})`,
      () => `(${this.strExpr(d - 1)} ${this.pick(["==", "!="])} ${this.strExpr(d - 1)})`,
    ];
    for (const ty of ["int", "string"] as const) {
      const opts = this.vars(ty, true);
      if (opts.length) forms.push(() => `${this.pick(opts).name} is null`);
    }
    return this.pick(forms)();
  }

  private atomBool(d: number): string {
    const vs = this.vars("bool");
    if (vs.length && this.chance(0.5)) return this.pick(vs).name;
    if (d <= 0) return this.pick(["true", "false"]);
    return `(${this.boolExpr(d - 1)})`;
  }

  private listExpr(d: number): string {
    const vs = this.vars("list");
    if (vs.length && this.chance(0.4)) return this.pick(vs).name;
    const n = this.int(4);
    const items: string[] = [];
    for (let i = 0; i < n; i++) items.push(this.intExpr(Math.max(d - 1, 0)).src);
    // an empty list literal needs its element type from somewhere, so the
    // generator only writes one when it has at least one element
    if (!items.length) items.push(this.intExpr(0).src);
    return `[${items.join(", ")}]`;
  }

  private expr(ty: Ty, d: number): string {
    switch (ty) {
      case "int": return this.intExpr(d).src;
      case "float": return this.floatExpr(d);
      case "bool": return this.boolExpr(d);
      case "string": return this.strExpr(d);
      case "list": return this.listExpr(d);
    }
  }

  // ---- statements -------------------------------------------------------

  private emit(indent: number, text: string): void {
    this.lines.push("    ".repeat(indent) + text);
  }

  private tyName(ty: Ty): string {
    // the paren form of a type constructor, which the formatter once
    // rewrote into the angle form
    return ty === "list" ? (this.chance(0.5) ? "list(int)" : "list<int>") : ty;
  }

  /** One statement, possibly a block. Returns the names it introduced. */
  private stmt(indent: number, d: number): void {
    const roll = this.rng();

    // a binding, sometimes annotated, sometimes optional
    if (roll < 0.34) {
      const ty = this.pick(["int", "float", "bool", "string", "list"] as const);
      const name = this.fresh();
      if ((ty === "int" || ty === "string") && this.chance(0.25)) {
        // `T?`, with and without a value -- the two states a weak read has
        if (this.chance(0.5)) {
          this.emit(indent, `let ${name}: ${this.tyName(ty)}?`);
        } else {
          this.emit(indent, `let ${name}: ${this.tyName(ty)}?: ${this.expr(ty, d)}`);
        }
        this.env.push({ name, ty, opt: true });
        return;
      }
      const ann = this.chance(0.4) ? `${this.tyName(ty)}: ` : "";
      this.emit(indent, `let ${name}: ${ann}${this.expr(ty, d)}`);
      this.env.push({ name, ty, opt: false });
      return;
    }

    // a conditional
    if (roll < 0.52 && indent < 2) {
      this.emit(indent, `if ${this.boolExpr(d)},`);
      this.block(indent + 1, d);
      if (this.chance(0.4)) {
        this.emit(indent, `else if ${this.boolExpr(d)},`);
        this.block(indent + 1, d);
      }
      if (this.chance(0.6)) {
        this.emit(indent, "else,");
        this.block(indent + 1, d);
      }
      return;
    }

    // a loop, over a range short enough that the output stays readable
    if (roll < 0.62 && indent < 2 && this.loops < 3) {
      this.loops++;
      const it = `i${this.next++}`;
      this.emit(indent, `for ${it} in 0..${1 + this.int(3)},`);
      this.env.push({ name: it, ty: "int", opt: false });
      const before = this.env.length;
      this.block(indent + 1, d);
      this.env.length = before - 1;
      return;
    }

    // a match over an integer, which is also how an optional is read
    if (roll < 0.70 && indent < 2) {
      const subject = this.fresh();
      this.emit(indent, `let ${subject}: ${this.intExpr(d).src}`);
      this.emit(indent, `match ${subject},`);
      this.emit(indent + 1, `${this.int(5)},`);
      this.block(indent + 2, 0);
      this.emit(indent + 1, "_,");
      this.block(indent + 2, 0);
      this.env.push({ name: subject, ty: "int", opt: false });
      return;
    }

    // and otherwise, something printed -- the behaviour check needs output
    const ty = this.pick(["int", "float", "bool", "string", "list"] as const);
    this.emit(indent, `say ${this.expr(ty, d)}`);
  }

  /** A block body, scoped: names it binds go out of scope at the end. */
  private block(indent: number, d: number): void {
    const before = this.env.length;
    const n = 1 + this.int(2);
    for (let i = 0; i < n; i++) this.stmt(indent, Math.max(d - 1, 0));
    // every block ends in a `say`, so an empty branch cannot hide a change
    this.emit(indent, `say ${this.expr(this.pick(["int", "string", "bool"] as const), 0)}`);
    this.env.length = before;
  }

  /** A whole program. */
  program(): string {
    const n = 4 + this.int(6);
    for (let i = 0; i < n; i++) {
      if (this.chance(0.12)) this.lines.push(`# comment ${i}`);
      this.stmt(0, 1 + this.int(3));
    }
    this.emit(0, `say ${this.expr("string", 1)}`);
    return this.lines.join("\n") + "\n";
  }
}

/** The program for a seed. Deterministic: the same seed is the same program. */
export function programFor(seed: number): string {
  return new Gen(seed).program();
}

// ---------------------------------------------------------------------------
// the properties
// ---------------------------------------------------------------------------

/**
 * A tree, with spans dropped. Two programs with the same shape here are the
 * same program: the formatter is allowed to move text around, and nothing
 * else. Comparing trees rather than output is what makes this catch a
 * meaning change whose two versions happen to print the same thing.
 */
export function shapeOf(node: unknown): string {
  // integer literals are held as bigint, which JSON has no opinion about
  return JSON.stringify(node, (k, v) =>
    k === "span" ? undefined : typeof v === "bigint" ? `${v}n` : v);
}

export interface FmtFailure {
  seed: number;
  property: string;
  detail: string;
  source: string;
}

function runOut(src: string, file: string): { out: string; error: string | null } {
  const lines: string[] = [];
  const { module, diags } = parse(src, file);
  const sema = check(module);
  const errs = [...diags.items, ...sema.items].filter((d) => d.severity === "error");
  if (errs.length) return { out: "", error: renderAll(errs.slice(0, 2), { source: src }) };

  const interp = new Interpreter({
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    stepLimit: 2_000_000,
  });
  try {
    interp.run(module);
  } catch (e) {
    const msg = e instanceof HalkaRuntimeError ? `${e.code}: ${e.msg}` : String(e);
    return { out: lines.join("\n"), error: msg };
  }
  return { out: lines.join("\n"), error: null };
}

/**
 * Where two serialised trees stop agreeing, with enough either side to read.
 * A tree is one very long line, so the line-by-line diff below is no use on
 * it -- and a failure nobody can read is a failure nobody fixes.
 */
function treeDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 110);
  return `  first difference at character ${i}:\n` +
    `    common:  ...${a.slice(from, i)}\n` +
    `    before:  ${a.slice(i, i + 160)}\n` +
    `    after:   ${b.slice(i, i + 160)}`;
}

function firstDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    return `  line ${i + 1}:\n    before: ${JSON.stringify(x[i] ?? "<missing>")}\n    after:  ${JSON.stringify(y[i] ?? "<missing>")}`;
  }
  return "  (differ only in length)";
}

/**
 * Check one seed. Returns the failure, or null.
 *
 * `behaviour` runs the program twice, which costs far more than the tree
 * comparison and finds strictly less -- it is on by default because a tree
 * comparison cannot see a formatter bug that the *parser* also has, and off
 * for long soaks where throughput matters.
 */
export function checkSeed(seed: number, behaviour = true): FmtFailure | null {
  const src = programFor(seed);
  const name = `fuzz-${seed}.hk`;
  const fail = (property: string, detail: string): FmtFailure => ({ seed, property, detail, source: src });

  const a = parse(src, name);
  if (a.diags.hasErrors) {
    // the generator emitted something that is not Halka; that is a bug here,
    // not in the formatter, but it is still a bug
    return fail("generated source parses", renderAll(a.diags.items.slice(0, 2), { source: src }));
  }

  const once = format(a.module, a.comments);
  const b = parse(once, name);
  if (b.diags.hasErrors) {
    return fail("formatted source parses", `${renderAll(b.diags.items.slice(0, 2), { source: once })}\n--- formatted ---\n${once}`);
  }

  // 1. meaning is preserved
  const before = shapeOf(a.module);
  const after = shapeOf(b.module);
  if (before !== after) {
    return fail("formatting preserves the tree", `${treeDiff(before, after)}\n--- formatted ---\n${once}`);
  }

  // 2. formatting is idempotent
  const twice = format(b.module, b.comments);
  if (once !== twice) {
    return fail("formatting is idempotent", firstDiff(once, twice));
  }

  // 3. and the program still does what it did
  if (behaviour) {
    const r1 = runOut(src, name);
    const r2 = runOut(once, name);
    if (r1.out !== r2.out || r1.error !== r2.error) {
      return fail("formatting preserves behaviour",
        `${firstDiff(r1.out + (r1.error ?? ""), r2.out + (r2.error ?? ""))}\n--- formatted ---\n${once}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

/**
 * The shapes this fuzzer exists to cover -- each one is a bug that got out.
 *
 * Checked, rather than assumed, because a generator that quietly stops
 * producing one of them still passes every property above: a fuzzer that
 * has drifted into emitting nothing but `say 4` is indistinguishable from a
 * formatter with no bugs left, and the suite would stay green either way.
 */
const SHAPES: { name: string; hit: (n: Record<string, unknown>) => boolean }[] = [
  {
    name: "an operand that binds looser than its operator",
    hit: (n) => n["kind"] === "BinaryExpr"
      && [n["lhs"], n["rhs"]].some((c) => (c as Record<string, unknown>)?.["kind"] === "BinaryExpr"),
  },
  {
    name: "`not` over `and`/`or`",
    hit: (n) => n["kind"] === "UnaryExpr" && n["op"] === "not"
      && (n["operand"] as Record<string, unknown>)?.["kind"] === "BinaryExpr",
  },
  {
    name: "a literal brace in a string",
    hit: (n) => n["kind"] === "StrLit"
      && (n["parts"] as { kind: string; text?: string }[]).some(
        (p) => p.kind === "text" && (p.text ?? "").includes("{")),
  },
  {
    name: "an interpolation",
    hit: (n) => n["kind"] === "StrLit"
      && (n["parts"] as { kind: string }[]).some((p) => p.kind === "expr"),
  },
  {
    name: "a bracketed receiver",
    hit: (n) => (n["kind"] === "MemberExpr" || n["kind"] === "IndexExpr")
      && ["BinaryExpr", "UnaryExpr", "CastExpr"].includes(
        String((n["obj"] as Record<string, unknown>)?.["kind"])),
  },
  {
    name: "a cast of an expression",
    hit: (n) => n["kind"] === "CastExpr"
      && (n["expr"] as Record<string, unknown>)?.["kind"] !== "IntLit",
  },
  {
    name: "the paren form of a type constructor",
    hit: (n) => n["kind"] === "NamedType" && ((n["args"] as unknown[]) ?? []).length > 0,
  },
  { name: "an optional read with `or`", hit: (n) => n["kind"] === "BinaryExpr" && n["op"] === "or" },
  { name: "a nested block", hit: (n) => n["kind"] === "IfStmt" || n["kind"] === "ForStmt" },
];

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { for (const x of node) walk(x, visit); return; }
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n["kind"] === "string") visit(n);
  for (const k of Object.keys(n)) if (k !== "span") walk(n[k], visit);
}

/** The shapes the given seeds actually produced. */
export function coverage(seeds: number): Set<string> {
  const seen = new Set<string>();
  for (let seed = 1; seed <= seeds; seed++) {
    if (seen.size === SHAPES.length) break;
    const { module } = parse(programFor(seed), `fuzz-${seed}.hk`);
    walk(module, (n) => {
      for (const s of SHAPES) if (!seen.has(s.name) && s.hit(n)) seen.add(s.name);
    });
  }
  return seen;
}

/**
 * The seeds the suite runs on every `npm test`. Fixed, so a red build is the
 * same red build on every machine and on CI.
 */
export const FUZZ_SEEDS = 400;

export function suiteFuzz(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
  seeds = FUZZ_SEEDS,
): void {
  const failures: FmtFailure[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const f = checkSeed(seed);
    if (f) failures.push(f);
  }
  // One result per property rather than per seed: a broken formatter fails
  // hundreds of seeds at once, and hundreds of identical failures is worse
  // reading than one with a seed to reproduce it.
  const properties = [
    "generated source parses",
    "formatted source parses",
    "formatting preserves the tree",
    "formatting is idempotent",
    "formatting preserves behaviour",
  ];
  for (const p of properties) {
    const hits = failures.filter((f) => f.property === p);
    if (!hits.length) {
      ok("fuzz", `${p} (${seeds} programs)`);
      continue;
    }
    const f = hits[0]!;
    bad("fuzz", p,
      `${hits.length} of ${seeds} programs failed; first was seed ${f.seed}\n` +
      `reproduce: node --experimental-strip-types test/fuzz.ts --seed ${f.seed}\n` +
      `${f.detail}\n--- program ---\n${f.source}`);
  }

  const seen = coverage(seeds);
  for (const s of SHAPES) {
    if (seen.has(s.name)) ok("fuzz", `the generator still produces ${s.name}`);
    else bad("fuzz", `the generator still produces ${s.name}`,
      `no program in ${seeds} contained it, so the property checks above are not covering it`);
  }
}

// ---------------------------------------------------------------------------
// standalone: a longer soak than the suite can afford
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`
  || import.meta.url.endsWith("/fuzz.ts") && process.argv[1]?.endsWith("fuzz.ts")) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--seed");
  if (at >= 0) {
    const seed = Number(args[at + 1]);
    const src = programFor(seed);
    process.stdout.write(`--- seed ${seed} ---\n${src}\n`);
    const f = checkSeed(seed);
    process.stdout.write(f ? `FAIL ${f.property}\n${f.detail}\n` : "ok\n");
    process.exit(f ? 1 : 0);
  }
  const n = Number(args[0]) || 10_000;
  const t0 = Date.now();
  let checked = 0;
  for (let seed = 1; seed <= n; seed++) {
    const f = checkSeed(seed, !args.includes("--fast"));
    checked++;
    if (f) {
      process.stdout.write(`FAIL seed ${seed}: ${f.property}\n${f.detail}\n--- program ---\n${f.source}\n`);
      process.exit(1);
    }
    if (seed % 5000 === 0) process.stdout.write(`  ${seed} programs, ${Date.now() - t0}ms\n`);
  }
  process.stdout.write(`${checked} programs, no failures  (${Date.now() - t0}ms)\n`);
}
