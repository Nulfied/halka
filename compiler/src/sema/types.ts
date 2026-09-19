// The Halka type algebra: representation, unification, and printing.
//
// Rule #11 makes annotations optional "whenever the compiler can infer the type
// unambiguously", which is a promise of real inference. This module provides
// the machinery; `infer.ts` walks the AST with it.
//
// Design notes:
//   * Inference variables use union-find with path compression.
//   * `T?` (#13) is a distinct type constructor, not a nullable pointer, so the
//     checker can reject `name.length` on a `string?` and narrow it after a
//     `is null` test (R10).
//   * `any` is the gradual escape hatch. Anything the checker cannot yet model
//     becomes `any` and unifies with everything, so unmodelled corners produce
//     no false positives. Every `any` the backend sees forces a boxed value, so
//     `halka check --explain` reports them.

export type Ty =
  | Prim | Opt | ListT | ArrayT | MapT | SetT | TupleT | FnT
  | NamedT | RefT | RawT | SharedT | TaskT | ChanT | AtomicT
  | MutexT | RangeT | CapT | ModuleT | TypeT | VarT | AnyT | NeverT;

export type PrimName = "int" | "float" | "bool" | "string" | "char" | "byte" | "nothing" | "null";

export interface Prim { k: "prim"; name: PrimName; width?: number; signed?: boolean }
export interface Opt { k: "opt"; inner: Ty }
export interface ListT { k: "list"; elem: Ty }
export interface ArrayT { k: "array"; elem: Ty; len?: number }
export interface MapT { k: "map"; key: Ty; val: Ty }
export interface SetT { k: "set"; elem: Ty }
export interface TupleT { k: "tuple"; elems: Ty[] }
export interface FnParam { name: string; ty: Ty; optional: boolean; variadic: boolean; moves: boolean }
export interface FnT { k: "fn"; params: FnParam[]; ret: Ty; generics: string[] }
export interface NamedT { k: "named"; name: string; args: Ty[] }
export interface RefT { k: "ref"; inner: Ty; mut: boolean }
export interface RawT { k: "raw"; inner: Ty }
export interface SharedT { k: "shared"; inner: Ty }
export interface TaskT { k: "task"; inner: Ty }
export interface ChanT { k: "chan"; inner: Ty }
export interface AtomicT { k: "atomic"; inner: Ty }
export interface MutexT { k: "mutex"; rw: boolean }
export interface RangeT { k: "range" }
export interface CapT { k: "cap"; name: string }
export interface ModuleT { k: "module"; name: string }
/** The type of a type name used as a value, e.g. a struct constructor. */
export interface TypeT { k: "type"; name: string }
export interface VarT { k: "var"; id: number; ref: Ty | null; bounds: string[]; origin?: string }
export interface AnyT { k: "any"; why?: string }
/** The type of an expression that never produces a value (`give`, `panic`). */
export interface NeverT { k: "never" }

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

export const INT: Prim = { k: "prim", name: "int" };
export const FLOAT: Prim = { k: "prim", name: "float" };
export const BOOL: Prim = { k: "prim", name: "bool" };
export const STRING: Prim = { k: "prim", name: "string" };
export const CHAR: Prim = { k: "prim", name: "char" };
export const BYTE: Prim = { k: "prim", name: "byte" };
export const NOTHING: Prim = { k: "prim", name: "nothing" };
export const NULL: Prim = { k: "prim", name: "null" };
export const NEVER: NeverT = { k: "never" };

export function any(why?: string): AnyT { return { k: "any", why }; }
export function opt(inner: Ty): Ty { return inner.k === "opt" ? inner : { k: "opt", inner }; }
export function list(elem: Ty): ListT { return { k: "list", elem }; }
export function arr(elem: Ty, len?: number): ArrayT { return { k: "array", elem, len }; }
export function map(key: Ty, val: Ty): MapT { return { k: "map", key, val }; }
export function set(elem: Ty): SetT { return { k: "set", elem }; }
export function tup(elems: Ty[]): TupleT { return { k: "tuple", elems }; }
export function named(name: string, args: Ty[] = []): NamedT { return { k: "named", name, args }; }
export function fn(params: FnParam[], ret: Ty, generics: string[] = []): FnT {
  return { k: "fn", params, ret, generics };
}
export function param(name: string, ty: Ty, o: Partial<FnParam> = {}): FnParam {
  return { name, ty, optional: false, variadic: false, moves: false, ...o };
}

let nextVarId = 1;
export function fresh(origin?: string, bounds: string[] = []): VarT {
  return { k: "var", id: nextVarId++, ref: null, bounds, origin };
}
export function resetVarCounter(): void { nextVarId = 1; }

/** The standard Result<T> shape (#22). */
export function resultOf(inner: Ty): NamedT { return named("Result", [inner]); }

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Follow inference-variable links to the representative type. */
export function prune(t: Ty): Ty {
  if (t.k === "var" && t.ref) {
    const r = prune(t.ref);
    t.ref = r; // path compression
    return r;
  }
  return t;
}

export function isVar(t: Ty): t is VarT { return prune(t).k === "var"; }
export function isAny(t: Ty): boolean { return prune(t).k === "any"; }

export function isNumeric(t: Ty): boolean {
  const p = prune(t);
  return p.k === "prim" && (p.name === "int" || p.name === "float" || p.name === "byte");
}

export function isScalar(t: Ty): boolean {
  const p = prune(t);
  return p.k === "prim" && p.name !== "string";
}

/** Values that are copied rather than moved (M1.1). */
export function isCopyable(t: Ty, structFields?: (n: string) => Ty[] | undefined): boolean {
  const p = prune(t);
  switch (p.k) {
    case "prim": return p.name !== "string";
    case "range": case "cap": case "type": return true;
    case "opt": return isCopyable(p.inner, structFields);
    case "tuple": return p.elems.every((e) => isCopyable(e, structFields));
    case "named": {
      const fs = structFields?.(p.name);
      return fs ? fs.every((f) => isCopyable(f, structFields)) : false;
    }
    case "any": return true;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// unification
// ---------------------------------------------------------------------------

export class UnifyError extends Error {
  expected: Ty;
  actual: Ty;
  detail: string;
  constructor(expected: Ty, actual: Ty, detail = "") {
    super(`expected ${show(expected)}, found ${show(actual)}`);
    this.name = "UnifyError";
    this.expected = expected;
    this.actual = actual;
    this.detail = detail;
  }
}

function occurs(v: VarT, t: Ty): boolean {
  const p = prune(t);
  if (p === v) return true;
  for (const c of childTypes(p)) if (occurs(v, c)) return true;
  return false;
}

export function childTypes(t: Ty): Ty[] {
  switch (t.k) {
    case "opt": case "ref": case "raw": case "shared":
    case "task": case "chan": case "atomic":
      return [t.inner];
    case "list": case "array": case "set": return [t.elem];
    case "map": return [t.key, t.val];
    case "tuple": return t.elems;
    case "named": return t.args;
    case "fn": return [...t.params.map((p) => p.ty), t.ret];
    default: return [];
  }
}

/**
 * Make `a` and `b` the same type, binding inference variables as needed.
 * Throws UnifyError when they cannot be reconciled.
 */
export function unify(a: Ty, b: Ty): void {
  const x = prune(a);
  const y = prune(b);
  if (x === y) return;

  // `any` absorbs anything — the gradual escape hatch.
  if (x.k === "any" || y.k === "any") return;
  // `never` (from `give` / `panic`) is compatible with every type.
  if (x.k === "never" || y.k === "never") return;

  if (x.k === "var") {
    if (occurs(x, y)) throw new UnifyError(x, y, "infinite type");
    x.ref = y;
    if (y.k === "var") y.bounds = [...new Set([...y.bounds, ...x.bounds])];
    return;
  }
  if (y.k === "var") return unify(y, x);

  // `null` inhabits every optional, and makes a bare type optional.
  if (x.k === "prim" && x.name === "null") {
    if (y.k === "opt") return;
    if (y.k === "prim" && y.name === "null") return;
    throw new UnifyError(x, y);
  }
  if (y.k === "prim" && y.name === "null") return unify(y, x);

  if (x.k === "opt" && y.k === "opt") return unify(x.inner, y.inner);
  // A plain T is acceptable where T? is expected (widening, never narrowing).
  if (x.k === "opt") return unify(x.inner, y);
  if (y.k === "opt") throw new UnifyError(x, y, "this value may be null");

  if (x.k !== y.k) {
    // `int` widens to `float` in a numeric context.
    if (isNumeric(x) && isNumeric(y)) return;
    throw new UnifyError(x, y);
  }

  switch (x.k) {
    case "prim": {
      const yy = y as Prim;
      if (x.name === yy.name) return;
      if (isNumeric(x) && isNumeric(yy)) return; // int/byte/float mix
      throw new UnifyError(x, y);
    }
    case "list": return unify(x.elem, (y as ListT).elem);
    case "array": return unify(x.elem, (y as ArrayT).elem);
    case "set": return unify(x.elem, (y as SetT).elem);
    case "map":
      unify(x.key, (y as MapT).key);
      return unify(x.val, (y as MapT).val);
    case "tuple": {
      const yy = y as TupleT;
      if (x.elems.length !== yy.elems.length) throw new UnifyError(x, y, "different number of elements");
      x.elems.forEach((e, i) => unify(e, yy.elems[i]!));
      return;
    }
    case "ref": return unify(x.inner, (y as RefT).inner);
    case "raw": return unify(x.inner, (y as RawT).inner);
    case "shared": return unify(x.inner, (y as SharedT).inner);
    case "task": return unify(x.inner, (y as TaskT).inner);
    case "chan": return unify(x.inner, (y as ChanT).inner);
    case "atomic": return unify(x.inner, (y as AtomicT).inner);
    case "mutex": return;
    case "range": return;
    case "cap": return;
    case "module": return;
    case "type": return;
    case "named": {
      const yy = y as NamedT;
      if (x.name !== yy.name) throw new UnifyError(x, y);
      const n = Math.min(x.args.length, yy.args.length);
      for (let i = 0; i < n; i++) unify(x.args[i]!, yy.args[i]!);
      return;
    }
    case "fn": {
      const yy = y as FnT;
      const n = Math.min(x.params.length, yy.params.length);
      for (let i = 0; i < n; i++) unify(x.params[i]!.ty, yy.params[i]!.ty);
      return unify(x.ret, yy.ret);
    }
  }
}

/** Unify without throwing; used for speculative checks like `or` coalescing. */
export function tryUnify(a: Ty, b: Ty): boolean {
  try { unify(a, b); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// generalisation & instantiation (let-polymorphism for top-level functions)
// ---------------------------------------------------------------------------

/** Replace each generic name in a signature with a fresh variable. */
export function instantiate(t: Ty, subst = new Map<string, Ty>()): Ty {
  const p = prune(t);
  switch (p.k) {
    case "named": {
      // A bare named type matching a generic parameter is a type variable.
      if (!p.args.length && subst.has(p.name)) return subst.get(p.name)!;
      return named(p.name, p.args.map((a) => instantiate(a, subst)));
    }
    case "opt": return opt(instantiate(p.inner, subst));
    case "list": return list(instantiate(p.elem, subst));
    case "array": return arr(instantiate(p.elem, subst), p.len);
    case "set": return set(instantiate(p.elem, subst));
    case "map": return map(instantiate(p.key, subst), instantiate(p.val, subst));
    case "tuple": return tup(p.elems.map((e) => instantiate(e, subst)));
    case "ref": return { k: "ref", inner: instantiate(p.inner, subst), mut: p.mut };
    case "raw": return { k: "raw", inner: instantiate(p.inner, subst) };
    case "shared": return { k: "shared", inner: instantiate(p.inner, subst) };
    case "task": return { k: "task", inner: instantiate(p.inner, subst) };
    case "chan": return { k: "chan", inner: instantiate(p.inner, subst) };
    case "atomic": return { k: "atomic", inner: instantiate(p.inner, subst) };
    case "fn": {
      const s = new Map(subst);
      for (const g of p.generics) s.set(g, fresh(g));
      return fn(
        p.params.map((pp) => ({ ...pp, ty: instantiate(pp.ty, s) })),
        instantiate(p.ret, s),
        [],
      );
    }
    default: return p;
  }
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

export function show(t: Ty): string {
  const p = prune(t);
  switch (p.k) {
    case "prim": return p.name;
    case "opt": return `${show(p.inner)}?`;
    case "list": return `list(${show(p.elem)})`;
    case "array": return p.len === undefined ? `array(${show(p.elem)})` : `array(${show(p.elem)}, ${p.len})`;
    case "map": return `map(${show(p.key)}, ${show(p.val)})`;
    case "set": return `set(${show(p.elem)})`;
    case "tuple": return `(${p.elems.map(show).join(", ")})`;
    case "fn": {
      const ps = p.params.map((x) => `${x.name}: ${show(x.ty)}`).join(", ");
      return `(${ps}): ${show(p.ret)}`;
    }
    case "named": return p.args.length ? `${p.name}<${p.args.map(show).join(", ")}>` : p.name;
    case "ref": return `&${p.mut ? "mut " : ""}${show(p.inner)}`;
    case "raw": return `raw *${show(p.inner)}`;
    case "shared": return `shared(${show(p.inner)})`;
    case "task": return `task(${show(p.inner)})`;
    case "chan": return `channel(${show(p.inner)})`;
    case "atomic": return `atomic(${show(p.inner)})`;
    case "mutex": return p.rw ? "rwmutex" : "mutex";
    case "range": return "range";
    case "cap": return `capability ${p.name}`;
    case "module": return `module ${p.name}`;
    case "type": return `type ${p.name}`;
    case "var": return p.origin ? p.origin : `_${p.id}`;
    case "any": return "_";
    case "never": return "never";
  }
}

/** A concrete type has no unresolved inference variables — codegen needs this. */
export function isConcrete(t: Ty): boolean {
  const p = prune(t);
  if (p.k === "var" || p.k === "any") return false;
  return childTypes(p).every(isConcrete);
}

/** Default any still-unresolved variable so codegen has something to emit. */
export function defaultUnresolved(t: Ty, to: Ty = any("unresolved")): Ty {
  const p = prune(t);
  if (p.k === "var") { p.ref = to; return to; }
  for (const c of childTypes(p)) defaultUnresolved(c, to);
  return p;
}
