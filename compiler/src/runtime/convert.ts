// Value conversions shared by the interpreter (`as` / `to`, #15) and the prelude.

import type * as A from "../parser/ast.ts";
import {
  type Value, NULL, FALSE, int, float, str, bool, list,
  display, truthy, typeNameOf, codePoints,
} from "./value.ts";

export function primitiveMatches(v: Value, name: string): boolean {
  switch (name) {
    case "int": case "uint": return v.t === "int";
    case "float": case "double": return v.t === "float";
    case "string": return v.t === "string";
    case "char": return v.t === "char";
    case "bool": return v.t === "bool";
    case "byte": return v.t === "int";
    case "list": case "array": return v.t === "list";
    case "map": return v.t === "map";
    case "set": return v.t === "set";
    default: return false;
  }
}

/**
 * The built-in type constructors, which take their arguments in parentheses:
 * `list(int)`, `map(string, int)`. Every other generic takes them in angle
 * brackets — `Result<int>`, as the spec writes it (#22).
 *
 * Rendering everything with parentheses made the formatter emit
 * `Result(int)`, which the parser does not accept, so formatting a file that
 * named a user generic produced a file that no longer parsed.
 */
// Built-in type constructors are written with parentheses; a user generic
// gets angle brackets. Keep this in step with the parser's TYPE_CTORS, or
// the formatter rewrites documented syntax into the other form -- it turned
// `shared(Cache)` from the memory model into `shared<Cache>`.
const PAREN_TYPE_CTORS = new Set([
  "list", "array", "map", "set", "channel", "task", "tuple", "vector",
  "shared", "weak", "atomic", "mutex", "rwmutex",
]);

export function typeText(t: A.TypeNode): string {
  switch (t.kind) {
    case "NamedType": {
      if (!t.args.length) return t.name;
      const args = t.args.map(typeText).join(", ");
      return PAREN_TYPE_CTORS.has(t.name) ? `${t.name}(${args})` : `${t.name}<${args}>`;
    }
    case "OptionalType": return `${typeText(t.inner)}?`;
    case "RefType": return `&${t.mut ? "mut " : ""}${typeText(t.inner)}`;
    case "RawPtrType": return `raw *${typeText(t.inner)}`;
    case "TupleType": return `(${t.elements.map(typeText).join(", ")})`;
    case "ForeignType": return `${t.lang} ${typeText(t.inner)}`;
    case "InferType": return "_";
  }
}

export function defaultFor(t?: A.TypeNode): Value {
  if (!t) return NULL;
  const n = typeText(t);
  if (n === "int" || n === "uint" || n === "byte") return int(0);
  if (n === "float" || n === "double") return float(0);
  if (n === "string") return str("");
  if (n === "bool") return FALSE;
  if (n === "char") return { t: "char", v: "\0" };
  if (n.startsWith("list") || n.startsWith("array")) return list([]);
  return NULL;
}

/** #15 — `as` (must succeed) and `to` (may fail) share one conversion table. */
export function convert(v: Value, target: string): { ok: true; value: Value } | { ok: false; error: string } {
  const base = target.replace(/\?$/, "");
  switch (base) {
    case "int": case "int8": case "int16": case "int32": case "int64":
    case "uint": case "uint8": case "uint16": case "uint32": case "uint64": case "byte": {
      if (v.t === "int") return { ok: true, value: v };
      if (v.t === "float") return { ok: true, value: int(BigInt(Math.trunc(v.v))) };
      if (v.t === "bool") return { ok: true, value: int(v.v ? 1n : 0n) };
      if (v.t === "char") return { ok: true, value: int(BigInt(v.v.codePointAt(0) ?? 0)) };
      if (v.t === "string") {
        const s = v.v.trim();
        if (!/^[+-]?\d+$/.test(s)) return { ok: false, error: `"${v.v}" is not a whole number` };
        return { ok: true, value: int(BigInt(s)) };
      }
      return { ok: false, error: `cannot convert ${typeNameOf(v)} to ${base}` };
    }
    case "float": case "float32": case "float64": case "double": {
      if (v.t === "float") return { ok: true, value: v };
      if (v.t === "int") return { ok: true, value: float(Number(v.v)) };
      if (v.t === "bool") return { ok: true, value: float(v.v ? 1 : 0) };
      if (v.t === "string") {
        const n = Number(v.v.trim());
        if (v.v.trim() === "" || Number.isNaN(n)) return { ok: false, error: `"${v.v}" is not a number` };
        return { ok: true, value: float(n) };
      }
      return { ok: false, error: `cannot convert ${typeNameOf(v)} to float` };
    }
    case "string": return { ok: true, value: str(display(v)) };
    case "bool": return { ok: true, value: bool(truthy(v)) };
    case "char": {
      if (v.t === "char") return { ok: true, value: v };
      if (v.t === "string" && codePoints(v.v).length === 1) return { ok: true, value: { t: "char", v: v.v } };
      if (v.t === "int") return { ok: true, value: { t: "char", v: String.fromCodePoint(Number(v.v)) } };
      return { ok: false, error: `cannot convert ${typeNameOf(v)} to char` };
    }
    case "list": case "array": {
      if (v.t === "list") return { ok: true, value: v };
      if (v.t === "tuple") return { ok: true, value: list([...v.v]) };
      if (v.t === "set") return { ok: true, value: list([...v.v.values()]) };
      if (v.t === "string") return { ok: true, value: list(codePoints(v.v).map((c) => str(c))) };
      return { ok: false, error: `cannot convert ${typeNameOf(v)} to list` };
    }
    default:
      if (typeNameOf(v) === base) return { ok: true, value: v };
      return { ok: false, error: `cannot convert ${typeNameOf(v)} to ${base}` };
  }
}

