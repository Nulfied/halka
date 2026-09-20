// The Halka prelude: built-in functions, methods, and modules.
//
// Everything here is reachable without an import. Module-scoped helpers live in
// `math`, `strings`, `lists`, `maps`, `io`, `files`, `time`, `os`, and `json`, and
// are reached with `import math` / `from math import sqrt` (#33).

import type { Interpreter, Ev } from "../interp/interpreter.ts";
import {
  Env, Channel,
  type Value, type NativeV, type Suspend, type NativeCtx,
  NULL, NOTHING, TRUE, FALSE,
  int, float, str, bool, list, tuple,
  display, inspect, keyOf, valueEq, truthy, typeNameOf, codePoints,
} from "./value.ts";
import { convert } from "./convert.ts";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";

type Fn = (args: Value[], ctx: NativeCtx) => Value | Generator<Suspend, Value, unknown>;

function native(name: string, min: number, max: number, call: Fn): NativeV {
  return { t: "native", name, arity: [min, max], call };
}

let INTERP: Interpreter;

function fail(msg: string): never {
  return INTERP.fail(msg);
}

function needList(v: Value, who: string): Value[] {
  if (v.t === "list") return v.v;
  if (v.t === "tuple") return v.v;
  if (v.t === "set") return [...v.v.values()];
  if (v.t === "range") return INTERP.iterate(v, { file: "<prelude>", start: { offset: 0, line: 1, col: 1 }, end: { offset: 0, line: 1, col: 1 } });
  fail(`${who} expects a list, found ${typeNameOf(v)}`);
}

function needNum(v: Value, who: string): number {
  if (v.t === "int") return Number(v.v);
  if (v.t === "float") return v.v;
  fail(`${who} expects a number, found ${typeNameOf(v)}`);
}

function needStr(v: Value, who: string): string {
  if (v.t === "string") return v.v;
  if (v.t === "char") return v.v;
  fail(`${who} expects a string, found ${typeNameOf(v)}`);
}

function numLike(a: Value, n: number): Value {
  return a.t === "int" && Number.isInteger(n) ? int(BigInt(Math.trunc(n))) : float(n);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export function installPrelude(interp: Interpreter): void {
  INTERP = interp;
  const g = interp.globals;
  const def = (n: NativeV) => g.define(n.name, n, false);

  // --- built-in Result (#22) --------------------------------------------
  g.define("Ok", native("Ok", 1, 1, (a) => interp.mkVariant("Result", "Ok", ["value"], [a[0]!])), false);
  g.define("Error", native("Error", 1, 1, (a) => interp.mkVariant("Result", "Error", ["message"], [a[0]!])), false);
  g.define("Cancelled", interp.mkVariant("Result", "Cancelled", [], []), false);

  // --- core -------------------------------------------------------------
  def(native("len", 1, 1, (a) => int(BigInt(lengthOf(a[0]!)))));
  def(native("type_of", 1, 1, (a) => str(typeNameOf(a[0]!))));
  def(native("inspect", 1, 1, (a) => str(inspect(a[0]!))));
  def(native("print", 0, Infinity, (a, c) => { c.say(a.map(display).join(" ")); return NOTHING; }));
  def(native("panic", 1, 1, (a) => fail(display(a[0]!))));
  def(native("assert", 1, 2, (a) => {
    if (!truthy(a[0]!)) fail(a[1] ? display(a[1]) : "assertion failed");
    return NOTHING;
  }));
  def(native("id", 1, 1, (a) => a[0]!));

  // conversions as functions (alongside `as` / `to`, #15)
  def(native("int", 1, 1, (a) => convertOrFail(a[0]!, "int")));
  def(native("float", 1, 1, (a) => convertOrFail(a[0]!, "float")));
  def(native("string", 1, 1, (a) => str(display(a[0]!))));
  def(native("bool", 1, 1, (a) => bool(truthy(a[0]!))));
  def(native("char", 1, 1, (a) => convertOrFail(a[0]!, "char")));

  // --- constructors -----------------------------------------------------
  def(native("list", 0, 1, (a) => (a.length ? list([...needList(a[0]!, "list")]) : list([]))));
  def(native("array", 0, 2, (a) => {
    if (!a.length) return list([]);
    if (a.length === 2 && a[0]!.t === "int") return list(Array.from({ length: Number((a[0] as { v: bigint }).v) }, () => a[1]!));
    return list([...needList(a[0]!, "array")]);
  }));
  def(native("tuple", 0, Infinity, (a) => tuple(a)));
  def(native("set", 0, 1, (a) => {
    const m = new Map<string, Value>();
    if (a.length) for (const v of needList(a[0]!, "set")) m.set(keyOf(v), v);
    return { t: "set", v: m };
  }));
  def(native("map", 0, 1, (a) => {
    const m = new Map<string, { k: Value; v: Value }>();
    if (a.length) {
      for (const pair of needList(a[0]!, "map")) {
        if (pair.t !== "tuple" && pair.t !== "list") fail("map() expects a list of (key, value) pairs");
        m.set(keyOf(pair.v[0]!), { k: pair.v[0]!, v: pair.v[1] ?? NULL });
      }
    }
    return { t: "map", v: m };
  }));
  def(native("range", 1, 3, (a) => {
    const n = (v: Value) => (v.t === "int" ? v.v : BigInt(Math.trunc(needNum(v, "range"))));
    if (a.length === 1) return { t: "range", lo: 0n, hi: n(a[0]!), inclusive: false, step: 1n };
    return { t: "range", lo: n(a[0]!), hi: n(a[1]!), inclusive: false, step: a[2] ? n(a[2]) : 1n };
  }));

  // --- numbers ----------------------------------------------------------
  def(native("abs", 1, 1, (a) => {
    const v = a[0]!;
    if (v.t === "int") return int(v.v < 0n ? -v.v : v.v);
    return float(Math.abs(needNum(v, "abs")));
  }));
  /** Truncating integer division — `/` always yields a float (R21). */
  def(native("div", 2, 2, (a) => {
    const x = a[0]!, y = a[1]!;
    if (x.t === "int" && y.t === "int") {
      if (y.v === 0n) fail("division by zero");
      const q = x.v / y.v;
      // floor toward negative infinity, matching `%`
      return int(x.v % y.v !== 0n && (x.v < 0n) !== (y.v < 0n) ? q - 1n : q);
    }
    const d = needNum(y, "div");
    if (d === 0) fail("division by zero");
    return float(Math.floor(needNum(x, "div") / d));
  }));
  def(native("mod", 2, 2, (a) => INTERP.binop("%", a[0]!, a[1]!, null)));
  def(native("round", 1, 1, (a) => int(BigInt(Math.round(needNum(a[0]!, "round"))))));
  def(native("round_to", 2, 2, (a) => {
    const f = 10 ** needNum(a[1]!, "round_to");
    return float(Math.round(needNum(a[0]!, "round_to") * f) / f);
  }));
  def(native("floor", 1, 1, (a) => int(BigInt(Math.floor(needNum(a[0]!, "floor"))))));
  def(native("ceil", 1, 1, (a) => int(BigInt(Math.ceil(needNum(a[0]!, "ceil"))))));
  def(native("sqrt", 1, 1, (a) => float(Math.sqrt(needNum(a[0]!, "sqrt")))));
  def(native("pow", 2, 2, (a) => {
    const x = a[0]!, y = a[1]!;
    if (x.t === "int" && y.t === "int" && y.v >= 0n) return int(x.v ** y.v);
    return float(needNum(x, "pow") ** needNum(y, "pow"));
  }));
  def(native("min", 1, Infinity, (a) => reduceCmp(a, -1)));
  def(native("max", 1, Infinity, (a) => reduceCmp(a, 1)));
  def(native("sum", 1, 1, (a) => {
    let acc: Value = int(0);
    for (const v of needList(a[0]!, "sum")) acc = INTERP.binop("+", acc, v, null);
    return acc;
  }));

  // --- sequences --------------------------------------------------------
  def(native("sorted", 1, 2, function* (a, c): Generator<Suspend, Value, unknown> {
    const items = [...needList(a[0]!, "sorted")];
    if (a[1]) {
      const keyed: { k: Value; v: Value }[] = [];
      for (const v of items) keyed.push({ k: (yield* c.callFn(a[1]!, [v])) as Value, v });
      keyed.sort((x, y) => compareValues(x.k, y.k));
      return list(keyed.map((x) => x.v));
    }
    items.sort(compareValues);
    return list(items);
  }));
  def(native("reversed", 1, 1, (a) => list([...needList(a[0]!, "reversed")].reverse())));
  def(native("enumerate", 1, 1, (a) => list(needList(a[0]!, "enumerate").map((v, i) => tuple([int(BigInt(i)), v])))));
  def(native("zip", 2, Infinity, (a) => {
    const ls = a.map((x) => needList(x, "zip"));
    const n = Math.min(...ls.map((l) => l.length));
    return list(Array.from({ length: n }, (_, i) => tuple(ls.map((l) => l[i]!))));
  }));
  def(native("contains", 2, 2, (a) => bool(containsValue(a[0]!, a[1]!))));

  // --- atomics (#30) ----------------------------------------------------
  def(native("add", 2, 2, (a) => atomicRmw(a[0]!, a[1]!, "+")));
  def(native("subtract", 2, 2, (a) => atomicRmw(a[0]!, a[1]!, "-")));
  def(native("exchange", 2, 2, (a) => {
    const at = a[0]!;
    if (at.t !== "atomic") fail("`exchange` expects an atomic");
    const old = at.box.v;
    at.box.v = a[1]!;
    return old;
  }));
  def(native("compare_exchange", 3, 3, (a) => {
    const at = a[0]!;
    if (at.t !== "atomic") fail("`compare_exchange` expects an atomic");
    if (valueEq(at.box.v, a[1]!)) { at.box.v = a[2]!; return TRUE; }
    return FALSE;
  }));

  // --- channels / tasks (#26–#31) ---------------------------------------
  def(native("close", 1, 1, (a) => {
    const v = a[0]!;
    if (v.t === "channel") { interp.sched.closeChannel(v.ch); return NOTHING; }
    if (v.t === "struct" && v.name === "File") { v.fields.set("open", FALSE); return NOTHING; }
    return NOTHING;
  }));
  def(native("sleep", 1, 1, function* (a): Generator<Suspend, Value, unknown> {
    yield { kind: "sleep", ms: needNum(a[0]!, "sleep") };
    return NOTHING;
  }));
  def(native("now_ms", 0, 0, () => float(performance.now())));
  def(native("cpu_count", 0, 0, () => int(BigInt(Math.max(1, (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 1)))));
  def(native("yield_now", 0, 0, function* (): Generator<Suspend, Value, unknown> {
    yield { kind: "yield" };
    return NOTHING;
  }));
  def(native("acquire_lock", 1, 1, function* (a): Generator<Suspend, Value, unknown> {
    const m = a[0]!;
    if (m.t !== "mutex") fail("`acquire` expects a mutex");
    yield { kind: "lock", m: m.m, write: true };
    return NOTHING;
  }));
  g.define("acquire", g.lookup("acquire_lock")!.value, false);
  def(native("release_lock", 1, 1, (a) => {
    const m = a[0]!;
    if (m.t !== "mutex") fail("`release` expects a mutex");
    interp.sched.unlock(m.m, true);
    return NOTHING;
  }));
  def(native("task_state", 1, 1, (a) => {
    const t = a[0]!;
    if (t.t !== "task") fail("`task_state` expects a task");
    return str(t.fiber.state);
  }));

  // --- function values (#17) --------------------------------------------
  def(native("apply", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
    return (yield* c.callFn(a[1]!, [a[0]!])) as Value;
  }));

  // --- modules ----------------------------------------------------------
  installModule(interp, "math", mathModule());
  installModule(interp, "strings", stringsModule());
  installModule(interp, "lists", listsModule());
  installModule(interp, "maps", mapsModule());
  installModule(interp, "io", ioModule(interp));
  installModule(interp, "time", timeModule());
  installModule(interp, "os", osModule());
  installModule(interp, "json", jsonModule());
  installModule(interp, "files", filesModule(interp));
}

function installModule(interp: Interpreter, name: string, entries: NativeV[]): void {
  const env = new Env(null, null);
  for (const e of entries) env.define(e.name, e, false);
  interp.modules.set(name, env);
}

function convertOrFail(v: Value, target: string): Value {
  const r = convert(v, target);
  if (!r.ok) fail(r.error);
  return r.value;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lengthOf(v: Value): number {
  switch (v.t) {
    case "list": case "tuple": return v.v.length;
    case "string": return codePoints(v.v).length;
    case "map": case "set": return v.v.size;
    case "record": return v.v.size;
    case "range": {
      if (v.hi === null) fail("an unbounded range has no length");
      const span = (v.inclusive ? v.hi - v.lo + 1n : v.hi - v.lo);
      const n = span / (v.step < 0n ? -v.step : v.step);
      return Number(n < 0n ? 0n : n);
    }
    case "struct": return v.fields.size;
    case "variant": return v.fields.length;
    default: fail(`${typeNameOf(v)} has no length`);
  }
}

function reduceCmp(args: Value[], dir: 1 | -1): Value {
  const items = args.length === 1 ? needList(args[0]!, dir > 0 ? "max" : "min") : args;
  if (!items.length) fail(dir > 0 ? "max() of an empty list" : "min() of an empty list");
  let best = items[0]!;
  for (const v of items.slice(1)) if (compareValues(v, best) * dir > 0) best = v;
  return best;
}

export function compareValues(a: Value, b: Value): number {
  if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) {
    const x = a.t === "int" ? a.v : a.v;
    const y = b.t === "int" ? b.v : b.v;
    if (a.t === "int" && b.t === "int") return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    const nx = Number(x), ny = Number(y);
    return nx < ny ? -1 : nx > ny ? 1 : 0;
  }
  if ((a.t === "string" || a.t === "char") && (b.t === "string" || b.t === "char")) {
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  }
  if (a.t === "bool" && b.t === "bool") return (a.v ? 1 : 0) - (b.v ? 1 : 0);
  if ((a.t === "list" || a.t === "tuple") && (b.t === "list" || b.t === "tuple")) {
    const n = Math.min(a.v.length, b.v.length);
    for (let i = 0; i < n; i++) {
      const c = compareValues(a.v[i]!, b.v[i]!);
      if (c) return c;
    }
    return a.v.length - b.v.length;
  }
  const ka = keyOf(a), kb = keyOf(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function containsValue(hay: Value, needle: Value): boolean {
  switch (hay.t) {
    case "list": case "tuple": return hay.v.some((x) => valueEq(x, needle));
    case "set": return hay.v.has(keyOf(needle));
    case "map": return hay.v.has(keyOf(needle));
    case "string": return hay.v.includes(needle.t === "string" || needle.t === "char" ? needle.v : display(needle));
    case "record": return needle.t === "string" && hay.v.has(needle.v);
    default: return false;
  }
}

function atomicRmw(at: Value, delta: Value, op: "+" | "-"): Value {
  if (at.t !== "atomic") fail(`\`${op === "+" ? "add" : "subtract"}\` expects an atomic`);
  at.box.v = INTERP.binop(op, at.box.v, delta, null);
  return at.box.v;
}

// ---------------------------------------------------------------------------
// Built-in methods (obj.method(...))
// ---------------------------------------------------------------------------

export function builtinMethod(obj: Value, name: string): Value | null {
  // Zero-argument properties read like fields.
  switch (name) {
    case "length": case "size":
      if (["list", "tuple", "string", "map", "set", "record", "range", "struct"].includes(obj.t)) {
        return int(BigInt(lengthOf(obj)));
      }
      break;
    case "value":
      if (obj.t === "atomic") return obj.box.v;
      break;
    case "state":
      if (obj.t === "task") return str(obj.fiber.state);
      break;
  }

  const table = METHODS[obj.t];
  const m = table?.[name];
  if (!m) return null;
  return { t: "bound", recv: obj, fn: m };
}

const METHODS: Record<string, Record<string, NativeV> | undefined> = {
  string: {
    upper: native("upper", 1, 1, (a) => str(needStr(a[0]!, "upper").toUpperCase())),
    lower: native("lower", 1, 1, (a) => str(needStr(a[0]!, "lower").toLowerCase())),
    trim: native("trim", 1, 1, (a) => str(needStr(a[0]!, "trim").trim())),
    trim_start: native("trim_start", 1, 1, (a) => str(needStr(a[0]!, "trim_start").trimStart())),
    trim_end: native("trim_end", 1, 1, (a) => str(needStr(a[0]!, "trim_end").trimEnd())),
    split: native("split", 1, 2, (a) => {
      const s = needStr(a[0]!, "split");
      const sep = a[1] ? needStr(a[1], "split") : " ";
      return list(s.split(sep).map(str));
    }),
    lines: native("lines", 1, 1, (a) => list(needStr(a[0]!, "lines").split("\n").map(str))),
    contains: native("contains", 2, 2, (a) => bool(needStr(a[0]!, "contains").includes(needStr(a[1]!, "contains")))),
    starts_with: native("starts_with", 2, 2, (a) => bool(needStr(a[0]!, "starts_with").startsWith(needStr(a[1]!, "starts_with")))),
    ends_with: native("ends_with", 2, 2, (a) => bool(needStr(a[0]!, "ends_with").endsWith(needStr(a[1]!, "ends_with")))),
    replace: native("replace", 3, 3, (a) => str(needStr(a[0]!, "replace").split(needStr(a[1]!, "replace")).join(needStr(a[2]!, "replace")))),
    index_of: native("index_of", 2, 2, (a) => int(BigInt(needStr(a[0]!, "index_of").indexOf(needStr(a[1]!, "index_of"))))),
    repeat: native("repeat", 2, 2, (a) => str(needStr(a[0]!, "repeat").repeat(Math.max(0, needNum(a[1]!, "repeat"))))),
    chars: native("chars", 1, 1, (a) => list(codePoints(needStr(a[0]!, "chars")).map((c) => ({ t: "char", v: c }) as Value))),
    bytes: native("bytes", 1, 1, (a) => list([...new TextEncoder().encode(needStr(a[0]!, "bytes"))].map((b) => int(BigInt(b))))),
    pad_start: native("pad_start", 2, 3, (a) => str(needStr(a[0]!, "pad_start").padStart(needNum(a[1]!, "pad_start"), a[2] ? needStr(a[2], "pad_start") : " "))),
    pad_end: native("pad_end", 2, 3, (a) => str(needStr(a[0]!, "pad_end").padEnd(needNum(a[1]!, "pad_end"), a[2] ? needStr(a[2], "pad_end") : " "))),
    is_empty: native("is_empty", 1, 1, (a) => bool(needStr(a[0]!, "is_empty").length === 0)),
  },

  list: {
    push: native("push", 2, Infinity, (a) => { const l = a[0]! as { v: Value[] }; l.v.push(...a.slice(1)); return NOTHING; }),
    pop: native("pop", 1, 1, (a) => { const l = a[0]! as { v: Value[] }; return l.v.length ? l.v.pop()! : NULL; }),
    insert: native("insert", 3, 3, (a) => { const l = a[0]! as { v: Value[] }; l.v.splice(needNum(a[1]!, "insert"), 0, a[2]!); return NOTHING; }),
    remove_at: native("remove_at", 2, 2, (a) => {
      const l = a[0]! as { v: Value[] };
      const i = needNum(a[1]!, "remove_at");
      const j = i < 0 ? i + l.v.length : i;
      if (j < 0 || j >= l.v.length) fail(`index ${i} is out of range for length ${l.v.length}`);
      return l.v.splice(j, 1)[0]!;
    }),
    remove: native("remove", 2, 2, (a) => {
      const l = a[0]! as { v: Value[] };
      const i = l.v.findIndex((x) => valueEq(x, a[1]!));
      if (i < 0) return FALSE;
      l.v.splice(i, 1);
      return TRUE;
    }),
    clear: native("clear", 1, 1, (a) => { (a[0]! as { v: Value[] }).v.length = 0; return NOTHING; }),
    extend: native("extend", 2, 2, (a) => { (a[0]! as { v: Value[] }).v.push(...needList(a[1]!, "extend")); return NOTHING; }),
    contains: native("contains", 2, 2, (a) => bool(containsValue(a[0]!, a[1]!))),
    index_of: native("index_of", 2, 2, (a) => int(BigInt(needList(a[0]!, "index_of").findIndex((x) => valueEq(x, a[1]!))))),
    count: native("count", 2, 2, (a) => int(BigInt(needList(a[0]!, "count").filter((x) => valueEq(x, a[1]!)).length))),
    first: native("first", 1, 1, (a) => needList(a[0]!, "first")[0] ?? NULL),
    last: native("last", 1, 1, (a) => { const l = needList(a[0]!, "last"); return l[l.length - 1] ?? NULL; }),
    reverse: native("reverse", 1, 1, (a) => { (a[0]! as { v: Value[] }).v.reverse(); return NOTHING; }),
    join: native("join", 1, 2, (a) => str(needList(a[0]!, "join").map(display).join(a[1] ? needStr(a[1], "join") : ""))),
    is_empty: native("is_empty", 1, 1, (a) => bool(needList(a[0]!, "is_empty").length === 0)),
    sum: native("sum", 1, 1, (a) => {
      let acc: Value = int(0);
      for (const v of needList(a[0]!, "sum")) acc = INTERP.binop("+", acc, v, null);
      return acc;
    }),
    sort: native("sort", 1, 1, (a) => { (a[0]! as { v: Value[] }).v.sort(compareValues); return NOTHING; }),
    map: native("map", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
      const out: Value[] = [];
      for (const v of needList(a[0]!, "map")) out.push((yield* c.callFn(a[1]!, [v])) as Value);
      return list(out);
    }),
    filter: native("filter", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
      const out: Value[] = [];
      for (const v of needList(a[0]!, "filter")) if (truthy((yield* c.callFn(a[1]!, [v])) as Value)) out.push(v);
      return list(out);
    }),
    reduce: native("reduce", 2, 3, function* (a, c): Generator<Suspend, Value, unknown> {
      const items = needList(a[0]!, "reduce");
      let acc = a[2] !== undefined ? a[2]! : items[0] ?? NULL;
      for (const v of a[2] !== undefined ? items : items.slice(1)) acc = (yield* c.callFn(a[1]!, [acc, v])) as Value;
      return acc;
    }),
    any: native("any", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
      for (const v of needList(a[0]!, "any")) if (truthy((yield* c.callFn(a[1]!, [v])) as Value)) return TRUE;
      return FALSE;
    }),
    all: native("all", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
      for (const v of needList(a[0]!, "all")) if (!truthy((yield* c.callFn(a[1]!, [v])) as Value)) return FALSE;
      return TRUE;
    }),
    find: native("find", 2, 2, function* (a, c): Generator<Suspend, Value, unknown> {
      for (const v of needList(a[0]!, "find")) if (truthy((yield* c.callFn(a[1]!, [v])) as Value)) return v;
      return NULL;
    }),
  },

  map: {
    keys: native("keys", 1, 1, (a) => list([...(a[0]! as { v: Map<string, { k: Value; v: Value }> }).v.values()].map((e) => e.k))),
    values: native("values", 1, 1, (a) => list([...(a[0]! as { v: Map<string, { k: Value; v: Value }> }).v.values()].map((e) => e.v))),
    entries: native("entries", 1, 1, (a) => list([...(a[0]! as { v: Map<string, { k: Value; v: Value }> }).v.values()].map((e) => tuple([e.k, e.v])))),
    has: native("has", 2, 2, (a) => bool((a[0]! as { v: Map<string, unknown> }).v.has(keyOf(a[1]!)))),
    get: native("get", 2, 2, (a) => {
      const m = (a[0]! as { v: Map<string, { k: Value; v: Value }> }).v;
      const e = m.get(keyOf(a[1]!));
      return e ? e.v : NULL;
    }),
    get_or: native("get_or", 3, 3, (a) => {
      const m = (a[0]! as { v: Map<string, { k: Value; v: Value }> }).v;
      const e = m.get(keyOf(a[1]!));
      return e ? e.v : a[2]!;
    }),
    remove: native("remove", 2, 2, (a) => bool((a[0]! as { v: Map<string, unknown> }).v.delete(keyOf(a[1]!)))),
    clear: native("clear", 1, 1, (a) => { (a[0]! as { v: Map<string, unknown> }).v.clear(); return NOTHING; }),
    is_empty: native("is_empty", 1, 1, (a) => bool((a[0]! as { v: Map<string, unknown> }).v.size === 0)),
  },

  set: {
    add: native("add", 2, 2, (a) => { (a[0]! as { v: Map<string, Value> }).v.set(keyOf(a[1]!), a[1]!); return NOTHING; }),
    remove: native("remove", 2, 2, (a) => bool((a[0]! as { v: Map<string, Value> }).v.delete(keyOf(a[1]!)))),
    has: native("has", 2, 2, (a) => bool((a[0]! as { v: Map<string, Value> }).v.has(keyOf(a[1]!)))),
    to_list: native("to_list", 1, 1, (a) => list([...(a[0]! as { v: Map<string, Value> }).v.values()])),
    union: native("union", 2, 2, (a) => setOp(a[0]!, a[1]!, "union")),
    intersect: native("intersect", 2, 2, (a) => setOp(a[0]!, a[1]!, "intersect")),
    difference: native("difference", 2, 2, (a) => setOp(a[0]!, a[1]!, "difference")),
    is_empty: native("is_empty", 1, 1, (a) => bool((a[0]! as { v: Map<string, Value> }).v.size === 0)),
  },

  range: {
    to_list: native("to_list", 1, 1, (a) => list(needList(a[0]!, "to_list"))),
  },

  tuple: {
    to_list: native("to_list", 1, 1, (a) => list([...(a[0]! as { v: Value[] }).v])),
  },

  char: {
    upper: native("upper", 1, 1, (a) => ({ t: "char", v: needStr(a[0]!, "upper").toUpperCase() })),
    lower: native("lower", 1, 1, (a) => ({ t: "char", v: needStr(a[0]!, "lower").toLowerCase() })),
    code: native("code", 1, 1, (a) => int(BigInt(needStr(a[0]!, "code").codePointAt(0) ?? 0))),
    is_digit: native("is_digit", 1, 1, (a) => bool(/^\d$/.test(needStr(a[0]!, "is_digit")))),
    is_alpha: native("is_alpha", 1, 1, (a) => bool(/^\p{L}$/u.test(needStr(a[0]!, "is_alpha")))),
    is_space: native("is_space", 1, 1, (a) => bool(/^\s$/.test(needStr(a[0]!, "is_space")))),
  },

  int: {
    to_string: native("to_string", 1, 2, (a) => {
      const v = a[0]! as { v: bigint };
      return str(a[1] ? v.v.toString(needNum(a[1], "to_string")) : v.v.toString());
    }),
  },

  variant: {
    unwrap: native("unwrap", 1, 2, (a) => {
      const v = a[0]!;
      if (v.t !== "variant") fail("`unwrap` expects a Result");
      if (v.name === "Ok") return v.fields[0] ?? NOTHING;
      if (a[1] !== undefined) return a[1];
      fail(`unwrap on ${inspect(v)}`);
    }),
    or_else: native("or_else", 2, 2, (a) => {
      const v = a[0]!;
      if (v.t === "variant" && v.name === "Ok") return v.fields[0] ?? NOTHING;
      return a[1]!;
    }),
  },
};

function setOp(a: Value, b: Value, op: "union" | "intersect" | "difference"): Value {
  if (a.t !== "set") fail(`\`${op}\` expects a set`);
  const other = b.t === "set" ? b.v : new Map(needList(b, op).map((v) => [keyOf(v), v] as const));
  const out = new Map<string, Value>();
  if (op === "union") { for (const [k, v] of a.v) out.set(k, v); for (const [k, v] of other) out.set(k, v); }
  if (op === "intersect") for (const [k, v] of a.v) if (other.has(k)) out.set(k, v);
  if (op === "difference") for (const [k, v] of a.v) if (!other.has(k)) out.set(k, v);
  return { t: "set", v: out };
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

function mathModule(): NativeV[] {
  const un = (n: string, f: (x: number) => number) => native(n, 1, 1, (a) => float(f(needNum(a[0]!, n))));
  return [
    un("sqrt", Math.sqrt), un("sin", Math.sin), un("cos", Math.cos), un("tan", Math.tan),
    un("asin", Math.asin), un("acos", Math.acos), un("atan", Math.atan),
    un("log", Math.log), un("log2", Math.log2), un("log10", Math.log10), un("exp", Math.exp),
    un("sinh", Math.sinh), un("cosh", Math.cosh), un("tanh", Math.tanh), un("cbrt", Math.cbrt),
    native("atan2", 2, 2, (a) => float(Math.atan2(needNum(a[0]!, "atan2"), needNum(a[1]!, "atan2")))),
    native("hypot", 2, Infinity, (a) => float(Math.hypot(...a.map((x) => needNum(x, "hypot"))))),
    native("pi", 0, 0, () => float(Math.PI)),
    native("e", 0, 0, () => float(Math.E)),
    native("gcd", 2, 2, (a) => {
      let x = a[0]!.t === "int" ? (a[0] as { v: bigint }).v : BigInt(Math.trunc(needNum(a[0]!, "gcd")));
      let y = a[1]!.t === "int" ? (a[1] as { v: bigint }).v : BigInt(Math.trunc(needNum(a[1]!, "gcd")));
      if (x < 0n) x = -x;
      if (y < 0n) y = -y;
      while (y) { [x, y] = [y, x % y]; }
      return int(x);
    }),
    native("is_nan", 1, 1, (a) => bool(Number.isNaN(needNum(a[0]!, "is_nan")))),
    native("clamp", 3, 3, (a) => {
      const x = needNum(a[0]!, "clamp"), lo = needNum(a[1]!, "clamp"), hi = needNum(a[2]!, "clamp");
      return numLike(a[0]!, Math.min(hi, Math.max(lo, x)));
    }),
  ];
}

function stringsModule(): NativeV[] {
  return [
    native("join", 2, 2, (a) => str(needList(a[0]!, "join").map(display).join(needStr(a[1]!, "join")))),
    native("split", 2, 2, (a) => list(needStr(a[0]!, "split").split(needStr(a[1]!, "split")).map(str))),
    native("from_chars", 1, 1, (a) => str(needList(a[0]!, "from_chars").map(display).join(""))),
    native("format", 1, Infinity, (a) => {
      let i = 1;
      return str(needStr(a[0]!, "format").replace(/\{\}/g, () => display(a[i++] ?? NULL)));
    }),
    native("repeat", 2, 2, (a) => str(needStr(a[0]!, "repeat").repeat(Math.max(0, needNum(a[1]!, "repeat"))))),
  ];
}

function listsModule(): NativeV[] {
  return [
    native("flatten", 1, 1, (a) => list(needList(a[0]!, "flatten").flatMap((x) => (x.t === "list" ? x.v : [x])))),
    native("chunk", 2, 2, (a) => {
      const items = needList(a[0]!, "chunk");
      const n = Math.max(1, needNum(a[1]!, "chunk"));
      const out: Value[] = [];
      for (let i = 0; i < items.length; i += n) out.push(list(items.slice(i, i + n)));
      return list(out);
    }),
    native("unique", 1, 1, (a) => {
      const seen = new Set<string>();
      const out: Value[] = [];
      for (const v of needList(a[0]!, "unique")) { const k = keyOf(v); if (!seen.has(k)) { seen.add(k); out.push(v); } }
      return list(out);
    }),
    native("concat", 2, Infinity, (a) => list(a.flatMap((x) => needList(x, "concat")))),
  ];
}

function mapsModule(): NativeV[] {
  return [
    native("from_entries", 1, 1, (a) => {
      const m = new Map<string, { k: Value; v: Value }>();
      for (const p of needList(a[0]!, "from_entries")) {
        if (p.t !== "tuple" && p.t !== "list") fail("from_entries expects (key, value) pairs");
        m.set(keyOf(p.v[0]!), { k: p.v[0]!, v: p.v[1] ?? NULL });
      }
      return { t: "map", v: m };
    }),
    native("merge", 2, Infinity, (a) => {
      const m = new Map<string, { k: Value; v: Value }>();
      for (const x of a) { if (x.t !== "map") fail("merge expects maps"); for (const [k, e] of x.v) m.set(k, e); }
      return { t: "map", v: m };
    }),
  ];
}

function ioModule(interp: Interpreter): NativeV[] {
  return [
    native("say", 0, Infinity, (a) => { interp.out(a.map(display).join(" ")); return NOTHING; }),
    native("write", 1, 1, (a) => { process.stdout.write(display(a[0]!)); return NOTHING; }),
    native("error", 1, 1, (a) => { interp.errOut(display(a[0]!)); return NOTHING; }),
  ];
}

// --- files (#18) — spec/FILE-IO.md ---------------------------------------

/**
 * Every operation here is gated on `FileAccess` (#45: ordinary code receives
 * no ambient unrestricted privileges), and every one that can fail gives a
 * `Result` rather than throwing, because Halka has no exceptions (#22, #23).
 */
function needCapability(interp: Interpreter, perm: string, who: string): void {
  if (interp.holdsCapability(perm)) return;
  // E0505 is the code a `requires` clause raises, because this is the same
  // failure: a capability that is not held at the point of the call.
  interp.fail(
    `\`files.${who}\` requires the \`${perm}\` capability, which is not held here (rule #45)\n` +
    `  wrap the call in \`with capability FileAccess,\`, declare \`requires FileAccess\` ` +
    `on the enclosing function, or run with HALKA_GRANTS=FileAccess`,
    null, "E0505",
  );
}

function okOf(v: Value): Value {
  return INTERP.mkVariant("Result", "Ok", ["value"], [v]);
}

function errOf(op: string, path: string, e: unknown): Value {
  const why = e instanceof Error ? (e as NodeJS.ErrnoException).message : String(e);
  return INTERP.mkVariant("Result", "Error", ["message"], [str(`${op} ${JSON.stringify(path)}: ${why}`)]);
}

/** Run a filesystem call, turning a throw into an `Error` result (#23). */
function attempt(op: string, path: string, f: () => Value): Value {
  try {
    return f();
  } catch (e) {
    return errOf(op, path, e);
  }
}

function filesModule(interp: Interpreter): NativeV[] {
  const read = (who: string, a: Value[]): string => {
    needCapability(interp, "FileAccess.read", who);
    return needStr(a[0]!, `files.${who}`);
  };
  const write = (who: string, a: Value[]): string => {
    needCapability(interp, "FileAccess.write", who);
    return needStr(a[0]!, `files.${who}`);
  };
  const NOTHING_OK = () => okOf(NOTHING);

  return [
    native("read", 1, 1, (a) => {
      const path = read("read", a);
      return attempt("reading", path, () => {
        const bytes = readFileSync(path);
        // Invalid UTF-8 is an error, not U+FFFD: substituting silently turns
        // a data problem into a correctness problem further downstream (F4).
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return okOf(str(text));
      });
    }),

    native("read_bytes", 1, 1, (a) => {
      const path = read("read_bytes", a);
      return attempt("reading", path, () =>
        okOf(list([...readFileSync(path)].map((b) => int(BigInt(b))))));
    }),

    native("lines", 1, 1, (a) => {
      const path = read("lines", a);
      return attempt("reading", path, () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
        // A trailing newline ends the last line rather than starting an
        // empty one, and a CR before it is dropped so a file written on
        // Windows reads the same everywhere (F4).
        const body = text.endsWith("\n") ? text.slice(0, -1) : text;
        const out = body === "" && text === "" ? [] : body.split("\n").map((l) => l.replace(/\r$/, ""));
        return okOf(list(out.map(str)));
      });
    }),

    native("write", 2, 2, (a) => {
      const path = write("write", a);
      const body = needStr(a[1]!, "files.write");
      return attempt("writing", path, () => { writeFileSync(path, body, "utf8"); return NOTHING_OK(); });
    }),

    native("append", 2, 2, (a) => {
      const path = write("append", a);
      const body = needStr(a[1]!, "files.append");
      return attempt("appending to", path, () => { appendFileSync(path, body, "utf8"); return NOTHING_OK(); });
    }),

    native("remove", 1, 1, (a) => {
      const path = write("remove", a);
      // A directory is removed only when empty, and never recursively: an
      // accidental `files.remove("src")` should fail, not delete a tree.
      return attempt("removing", path, () => {
        if (existsSync(path) && statSync(path).isDirectory()) rmdirSync(path);
        else rmSync(path);
        return NOTHING_OK();
      });
    }),

    native("size", 1, 1, (a) => {
      const path = read("size", a);
      return attempt("measuring", path, () => okOf(int(BigInt(statSync(path).size))));
    }),

    // `exists` and `is_dir` answer a question; "no" is an answer and not a
    // failure, so they are plain booleans rather than Results (F2).
    native("exists", 1, 1, (a) => {
      const path = read("exists", a);
      return bool(existsSync(path));
    }),

    native("is_dir", 1, 1, (a) => {
      const path = read("is_dir", a);
      try {
        return bool(statSync(path).isDirectory());
      } catch {
        return bool(false);
      }
    }),

    native("list_dir", 1, 1, (a) => {
      const path = read("list_dir", a);
      // Names, not paths: joining them is the caller's business, and it is
      // the only answer that does not depend on how the directory was named.
      return attempt("listing", path, () => okOf(list(readdirSync(path).map(str))));
    }),

    native("make_dir", 1, 1, (a) => {
      const path = write("make_dir", a);
      // Parents are created and an existing directory is not an error, so
      // callers do not all write the same "does it exist yet" dance (F3).
      return attempt("creating", path, () => { mkdirSync(path, { recursive: true }); return NOTHING_OK(); });
    }),
  ];
}

function timeModule(): NativeV[] {
  return [
    native("now", 0, 0, () => int(BigInt(Date.now()))),
    native("monotonic", 0, 0, () => float(performance.now())),
    native("sleep", 1, 1, function* (a): Generator<Suspend, Value, unknown> {
      yield { kind: "sleep", ms: needNum(a[0]!, "sleep") };
      return NOTHING;
    }),
  ];
}

function osModule(): NativeV[] {
  return [
    native("env", 1, 2, (a) => {
      const v = process.env[needStr(a[0]!, "env")];
      return v === undefined ? (a[1] ?? NULL) : str(v);
    }),
    native("args", 0, 0, () => list(process.argv.slice(2).map(str))),
    native("platform", 0, 0, () => str(process.platform)),
    native("exit", 0, 1, (a) => { process.exit(a[0] ? needNum(a[0], "exit") : 0); }),
  ];
}

/**
 * Where JSON stops being valid, as a byte offset.
 *
 * `JSON.parse` reports a position too, but it phrases and places its errors
 * differently between engine versions, and the compiled backend has its own
 * parser that cannot reproduce them. A program must fail the same way
 * whichever engine runs it (R23), so both locate the error with this
 * grammar instead. Only reached once parsing has already failed.
 */
function jsonErrorAt(text: string): number {
  const b = Buffer.from(text, "utf8");
  let p = 0;

  const space = (): void => {
    while (p < b.length && (b[p] === 32 || b[p] === 9 || b[p] === 10 || b[p] === 13)) p++;
  };
  const word = (w: string): boolean => {
    let k = 0;
    while (k < w.length && p < b.length && b[p] === w.charCodeAt(k)) { p++; k++; }
    return k === w.length;
  };
  const str = (): boolean => {
    if (p >= b.length || b[p] !== 34) return false;
    p++;
    for (;;) {
      if (p >= b.length) return false;
      const c = b[p]!;
      if (c === 34) { p++; return true; }
      if (c < 0x20) return false;
      if (c !== 92) { p++; continue; }
      p++;
      if (p >= b.length) return false;
      const e = String.fromCharCode(b[p]!);
      p++;
      if (e === "u") {
        for (let k = 0; k < 4; k++) {
          if (p >= b.length || !/[0-9a-fA-F]/.test(String.fromCharCode(b[p]!))) return false;
          p++;
        }
      } else if (!'"\/bfnrt'.includes(e)) return false;
    }
  };
  const num = (): boolean => {
    const from = p;
    if (p < b.length && (b[p] === 45 || b[p] === 43)) p++;
    while (p < b.length) {
      const c = b[p]!;
      if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || c === 45 || c === 43) p++;
      else break;
    }
    if (p === from) return false;
    return !Number.isNaN(Number(b.subarray(from, p).toString("utf8")));
  };

  const value = (): boolean => {
    space();
    if (p >= b.length) return false;
    const c = b[p]!;
    if (c === 123) {            // {
      p++;
      space();
      if (p < b.length && b[p] === 125) { p++; return true; }
      for (;;) {
        space();
        if (!str()) return false;
        space();
        if (p >= b.length || b[p] !== 58) return false;   // :
        p++;
        if (!value()) return false;
        space();
        if (p < b.length && b[p] === 44) { p++; continue; }
        if (p < b.length && b[p] === 125) { p++; return true; }
        return false;
      }
    }
    if (c === 91) {             // [
      p++;
      space();
      if (p < b.length && b[p] === 93) { p++; return true; }
      for (;;) {
        if (!value()) return false;
        space();
        if (p < b.length && b[p] === 44) { p++; continue; }
        if (p < b.length && b[p] === 93) { p++; return true; }
        return false;
      }
    }
    if (c === 34) return str();
    if (c === 116) return word("true");
    if (c === 102) return word("false");
    if (c === 110) return word("null");
    return num();
  };

  if (!value()) return p;
  space();
  return p;   // trailing content, or the end
}

function jsonModule(): NativeV[] {
  return [
    native("stringify", 1, 2, (a) => str(JSON.stringify(toJson(a[0]!), null, a[1] ? needNum(a[1], "stringify") : undefined))),
    native("parse", 1, 1, (a) => {
      const text = needStr(a[0]!, "parse");
      try { return fromJson(JSON.parse(text)); }
      catch (e) {
        // Not the engine's wording. `JSON.parse` phrases its errors
        // differently between Node versions, and the compiled backend has
        // its own parser that could never reproduce them -- so a program
        // would fail differently depending on how it was run (R23). The
        // position is the one part worth keeping, and both parsers report
        // the byte they gave up at.
        fail(`invalid JSON at byte ${jsonErrorAt(text)}`);
      }
    }),
  ];
}

function toJson(v: Value): unknown {
  switch (v.t) {
    case "null": case "nothing": return null;
    case "bool": return v.v;
    case "int": return Number(v.v);
    case "float": return v.v;
    case "string": case "char": return v.v;
    case "list": case "tuple": return v.v.map(toJson);
    case "set": return [...v.v.values()].map(toJson);
    case "map": return Object.fromEntries([...v.v.values()].map((e) => [display(e.k), toJson(e.v)]));
    case "record": return Object.fromEntries([...v.v].map(([k, e]) => [k, toJson(e)]));
    case "struct": return Object.fromEntries([...v.fields].map(([k, e]) => [k, toJson(e)]));
    case "variant": return v.fields.length === 1 ? { [v.name]: toJson(v.fields[0]!) } : v.name;
    default: return display(v);
  }
}

function fromJson(x: unknown): Value {
  if (x === null) return NULL;
  if (typeof x === "boolean") return bool(x);
  if (typeof x === "number") return Number.isInteger(x) ? int(BigInt(x)) : float(x);
  if (typeof x === "string") return str(x);
  if (Array.isArray(x)) return list(x.map(fromJson));
  const m = new Map<string, { k: Value; v: Value }>();
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) m.set(keyOf(str(k)), { k: str(k), v: fromJson(v) });
  return { t: "map", v: m };
}
