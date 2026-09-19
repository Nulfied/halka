// Halka runtime values.
//
// `int` is arbitrary-precision (bigint) — one of the Python strengths the
// language keeps. `float` is IEEE-754 double. Strings are UTF-16 JS strings
// but all indexing is done over code points so `"नमस्ते"[0]` behaves.

import type * as A from "../parser/ast.ts";

export type Value =
  | NullV | NothingV | BoolV | IntV | FloatV | CharV | StrV
  | ListV | TupleV | MapV | SetV | RecordV | StructV | VariantV
  | FnV | NativeV | BoundV
  | TaskV | ChannelV | MutexV | AtomicV | RefV | RangeV
  | TypeV | CapabilityV | ModuleV | RawPtrV;

export interface NullV { t: "null" }
export interface NothingV { t: "nothing" }
export interface BoolV { t: "bool"; v: boolean }
export interface IntV { t: "int"; v: bigint }
export interface FloatV { t: "float"; v: number }
export interface CharV { t: "char"; v: string }
export interface StrV { t: "string"; v: string }
export interface ListV { t: "list"; v: Value[] }
export interface TupleV { t: "tuple"; v: Value[] }
export interface MapV { t: "map"; v: Map<string, { k: Value; v: Value }> }
export interface SetV { t: "set"; v: Map<string, Value> }
export interface RecordV { t: "record"; v: Map<string, Value> }
export interface StructV { t: "struct"; name: string; fields: Map<string, Value> }
export interface VariantV { t: "variant"; enumName: string; name: string; fieldNames: string[]; fields: Value[] }

export interface FnV {
  t: "fn";
  name: string;
  decl: A.FnDecl;
  /** Captured lexical environment. */
  env: Env;
  /** Receiver for a method reached through `obj.method`. */
  self?: Value;
}
export interface NativeV {
  t: "native";
  name: string;
  arity: [number, number]; // [min, max]; Infinity max for variadic
  call: (args: Value[], ctx: NativeCtx) => Value | Generator<Suspend, Value, unknown>;
}
export interface BoundV { t: "bound"; recv: Value; fn: FnV | NativeV }

export interface TaskV { t: "task"; fiber: Fiber }
export interface ChannelV { t: "channel"; ch: Channel }
export interface MutexV { t: "mutex"; m: Mutex }
export interface AtomicV { t: "atomic"; box: { v: Value } }
/** A borrow or an `&`/`&mut` reference: an lvalue cell. */
export interface RefV { t: "ref"; get: () => Value; set: (v: Value) => void; mut: boolean; label: string }
export interface RangeV { t: "range"; lo: bigint; hi: bigint | null; inclusive: boolean; step: bigint }
export interface TypeV { t: "type"; name: string; decl?: A.Stmt }
export interface CapabilityV { t: "capability"; name: string; perms: string[] }
export interface ModuleV { t: "module"; name: string; exports: Map<string, Value> }
export interface RawPtrV { t: "rawptr"; addr: number; cell?: { v: Value } }

export const NULL: NullV = { t: "null" };
export const NOTHING: NothingV = { t: "nothing" };
export const TRUE: BoolV = { t: "bool", v: true };
export const FALSE: BoolV = { t: "bool", v: false };

export function int(v: bigint | number): IntV { return { t: "int", v: typeof v === "bigint" ? v : BigInt(Math.trunc(v)) }; }
export function float(v: number): FloatV { return { t: "float", v }; }
export function str(v: string): StrV { return { t: "string", v }; }
export function bool(v: boolean): BoolV { return v ? TRUE : FALSE; }
export function list(v: Value[]): ListV { return { t: "list", v }; }
export function tuple(v: Value[]): TupleV { return { t: "tuple", v }; }

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export interface Binding { value: Value; mutable: boolean; moved?: boolean }

export class Env {
  private vars = new Map<string, Binding>();
  readonly parent: Env | null;
  /** The innermost function frame, used by `defer` and `give`. */
  frame: Frame | null;

  constructor(parent: Env | null = null, frame: Frame | null = null) {
    this.parent = parent;
    this.frame = frame ?? parent?.frame ?? null;
  }

  child(): Env { return new Env(this, this.frame); }

  lookup(name: string): Binding | undefined {
    let e: Env | null = this;
    while (e) {
      const b = e.vars.get(name);
      if (b) return b;
      e = e.parent;
    }
    return undefined;
  }

  has(name: string): boolean { return this.lookup(name) !== undefined; }
  hasLocal(name: string): boolean { return this.vars.has(name); }

  define(name: string, value: Value, mutable = true): void {
    this.vars.set(name, { value, mutable });
  }

  /** Assign to an existing binding, or define it in this scope if new. */
  set(name: string, value: Value): boolean {
    const b = this.lookup(name);
    if (b) { b.value = value; return true; }
    this.vars.set(name, { value, mutable: true });
    return false;
  }

  localNames(): string[] { return [...this.vars.keys()]; }

  /** All visible names, innermost first — used by the REPL and the LSP. */
  allNames(): string[] {
    const out: string[] = [];
    let e: Env | null = this;
    while (e) { out.push(...e.vars.keys()); e = e.parent; }
    return [...new Set(out)];
  }
}

export interface Frame {
  fnName: string;
  /** #24 — deferred operations, run in reverse registration order. */
  defers: (() => Generator<Suspend, void, unknown>)[];
  /** #45 — capabilities granted to this call. */
  capabilities: Set<string>;
  /** #46 — inside an `unsafe:` block. */
  unsafeDepth: number;
}

// ---------------------------------------------------------------------------
// Concurrency primitives (#26–#32)
// ---------------------------------------------------------------------------

export type Suspend =
  | { kind: "yield" }
  | { kind: "await"; task: Fiber }
  | { kind: "recv"; ch: Channel }
  | { kind: "send"; ch: Channel; value: Value }
  | { kind: "lock"; m: Mutex; write: boolean }
  | { kind: "sleep"; ms: number };

export type FiberState = "ready" | "running" | "blocked" | "done" | "failed" | "cancelled";

export class Fiber {
  static nextId = 1;
  readonly id = Fiber.nextId++;
  readonly name: string;
  gen: Generator<Suspend, Value, unknown> | null;
  state: FiberState = "ready";
  result: Value = NOTHING;
  error: unknown = null;
  /** Value handed back into the generator on resume. */
  resumeWith: unknown = undefined;
  cancelRequested = false;
  /** Fibers waiting on this one to finish. */
  waiters: Fiber[] = [];

  constructor(name: string, gen: Generator<Suspend, Value, unknown>) {
    this.name = name;
    this.gen = gen;
  }

  get finished(): boolean {
    return this.state === "done" || this.state === "failed" || this.state === "cancelled";
  }
}

export class Channel {
  readonly capacity: number;
  buffer: Value[] = [];
  closed = false;
  /** Fibers parked in `receive`. */
  recvQueue: Fiber[] = [];
  /** Fibers parked in `send`, with the value they are trying to hand over. */
  sendQueue: { fiber: Fiber; value: Value }[] = [];

  constructor(capacity = 0) { this.capacity = capacity; }
}

export class Mutex {
  locked = false;
  readers = 0;
  queue: { fiber: Fiber; write: boolean }[] = [];
  readonly rw: boolean;
  constructor(rw = false) { this.rw = rw; }
}

export interface NativeCtx {
  env: Env;
  say: (s: string) => void;
  spawn: (name: string, gen: Generator<Suspend, Value, unknown>) => Fiber;
  callFn: (fn: Value, args: Value[]) => Generator<Suspend, Value, unknown>;
  fail: (msg: string) => never;
}

// ---------------------------------------------------------------------------
// Display & equality
// ---------------------------------------------------------------------------

/** `say` output — human form, strings unquoted. */
export function display(v: Value): string {
  switch (v.t) {
    case "string": return v.v;
    case "char": return v.v;
    default: return inspect(v);
  }
}

/** Debug/REPL form — strings quoted, containers bracketed. */
export function inspect(v: Value, seen = new Set<unknown>()): string {
  switch (v.t) {
    case "null": return "null";
    case "nothing": return "nothing";
    case "bool": return v.v ? "true" : "false";
    case "int": return v.v.toString();
    case "float": return formatFloat(v.v);
    case "char": return `'${escapeStr(v.v)}'`;
    case "string": return `"${escapeStr(v.v)}"`;
    case "list": {
      if (seen.has(v)) return "[...]";
      seen.add(v);
      const s = `[${v.v.map((e) => inspect(e, seen)).join(", ")}]`;
      seen.delete(v);
      return s;
    }
    case "tuple": {
      if (seen.has(v)) return "(...)";
      seen.add(v);
      const s = `(${v.v.map((e) => inspect(e, seen)).join(", ")})`;
      seen.delete(v);
      return s;
    }
    case "map": {
      if (seen.has(v)) return "[...]";
      seen.add(v);
      const s = v.v.size === 0 ? "map()" : `[${[...v.v.values()].map((e) => `${inspect(e.k, seen)}: ${inspect(e.v, seen)}`).join(", ")}]`;
      seen.delete(v);
      return s;
    }
    case "set": {
      if (seen.has(v)) return "{...}";
      seen.add(v);
      const s = v.v.size === 0 ? "set()" : `{${[...v.v.values()].map((e) => inspect(e, seen)).join(", ")}}`;
      seen.delete(v);
      return s;
    }
    case "record": {
      if (seen.has(v)) return "{...}";
      seen.add(v);
      const s = `{${[...v.v].map(([k, e]) => `${k}: ${inspect(e, seen)}`).join(", ")}}`;
      seen.delete(v);
      return s;
    }
    case "struct": {
      if (seen.has(v)) return `${v.name}(...)`;
      seen.add(v);
      const s = `${v.name}(${[...v.fields].map(([k, e]) => `${k}: ${inspect(e, seen)}`).join(", ")})`;
      seen.delete(v);
      return s;
    }
    case "variant":
      return v.fields.length ? `${v.name}(${v.fields.map((e) => inspect(e, seen)).join(", ")})` : v.name;
    case "fn": return `<fn ${v.name}>`;
    case "native": return `<builtin ${v.name}>`;
    case "bound": return `<method ${v.fn.name}>`;
    case "task": return `<task #${v.fiber.id} ${v.fiber.state}>`;
    case "channel": return `<channel cap=${v.ch.capacity}${v.ch.closed ? " closed" : ""}>`;
    case "mutex": return v.m.rw ? "<rwmutex>" : "<mutex>";
    case "atomic": return `atomic(${inspect(v.box.v, seen)})`;
    case "ref": return `<${v.mut ? "&mut" : "&"} ${v.label}>`;
    case "range": return `${v.lo}..${v.inclusive ? "=" : ""}${v.hi ?? ""}`;
    case "type": return `<type ${v.name}>`;
    case "capability": return `<capability ${v.name}>`;
    case "module": return `<module ${v.name}>`;
    case "rawptr": return `<raw *${v.addr.toString(16)}>`;
  }
}

function formatFloat(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(1);
  return String(n);
}

function escapeStr(s: string): string {
  return s.replace(/[\\"\n\t\r\0]/g, (c) =>
    ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r", "\0": "\\0" })[c] ?? c);
}

/** Stable key for map/set membership — structural for value types. */
export function keyOf(v: Value): string {
  switch (v.t) {
    case "null": return "null";
    case "nothing": return "nothing";
    case "bool": return `b:${v.v}`;
    case "int": return `i:${v.v}`;
    case "float": return Number.isInteger(v.v) ? `i:${BigInt(v.v)}` : `f:${v.v}`;
    case "char": return `c:${v.v}`;
    case "string": return `s:${v.v}`;
    case "tuple": return `t:[${v.v.map(keyOf).join(",")}]`;
    case "list": return `l:[${v.v.map(keyOf).join(",")}]`;
    case "variant": return `v:${v.enumName}.${v.name}(${v.fields.map(keyOf).join(",")})`;
    case "struct": return `S:${v.name}{${[...v.fields].map(([k, e]) => `${k}=${keyOf(e)}`).join(",")}}`;
    default: return `o:${objectId(v)}`;
  }
}

const idMap = new WeakMap<object, number>();
let nextObjId = 1;
function objectId(o: object): number {
  let n = idMap.get(o);
  if (n === undefined) { n = nextObjId++; idMap.set(o, n); }
  return n;
}

export function valueEq(a: Value, b: Value): boolean {
  if (a.t === "int" && b.t === "float") return Number(a.v) === b.v;
  if (a.t === "float" && b.t === "int") return a.v === Number(b.v);
  if (a.t !== b.t) return false;
  return keyOf(a) === keyOf(b);
}

/** Truthiness: only `false`, `null`, and `nothing` are falsy (R11). */
export function truthy(v: Value): boolean {
  if (v.t === "bool") return v.v;
  if (v.t === "null" || v.t === "nothing") return false;
  return true;
}

export function typeNameOf(v: Value): string {
  switch (v.t) {
    case "struct": return v.name;
    case "variant": return v.enumName;
    case "list": return "list";
    case "rawptr": return "raw";
    default: return v.t;
  }
}

/** Code points, so indexing and slicing work on real characters. */
export function codePoints(s: string): string[] {
  return Array.from(s);
}
