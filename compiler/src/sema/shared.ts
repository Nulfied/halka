// M3 — warning when a `shared` type can reach itself (W1010).
//
// Reference counting cannot free a cycle. The memory model says so plainly
// rather than hiding it: a refcounted graph that points back at itself
// leaks, and `weak(T)` is the way to break the loop. The compiler's job is
// to say which types have that shape, before anyone finds out at run time.
//
// So this walks the type graph looking for a path from a type back to
// itself that passes through at least one `shared`. A `weak` edge is not
// followed, because that is exactly what it is for.

import type * as A from "../parser/ast.ts";
import { DiagnosticBag, type Span } from "../util/diagnostics.ts";
import { type Ty, prune, show } from "./types.ts";

export interface SharedCheckInput {
  structFields: Map<string, Ty[]>;
  enumVariants: Map<string, Map<string, { fields: Ty[]; names: string[] }>>;
}

export function checkShared(mod: A.Module, info: SharedCheckInput): DiagnosticBag {
  const diags = new DiagnosticBag();

  /** The field or payload types of a named type, whichever it is. */
  const membersOf = (name: string): Ty[] => {
    const fields = info.structFields.get(name);
    if (fields) return fields;
    const variants = info.enumVariants.get(name);
    if (!variants) return [];
    return [...variants.values()].flatMap((v) => v.fields);
  };

  /**
   * Can `from` reach `target` through a path holding at least one `shared`?
   *
   * `seen` is keyed on the name *and* whether a shared edge has been
   * crossed, because the same type reached both ways is two different
   * questions: `A -> B -> A` only leaks if one of those hops is shared.
   */
  const reaches = (from: Ty, target: string, viaShared: boolean, seen: Set<string>): boolean => {
    const p = prune(from);
    switch (p.k) {
      case "weak":
        return false; // the whole point of `weak`: the cycle stops here
      case "shared":
        return reaches(p.inner, target, true, seen);
      case "named": {
        if (p.name === target && viaShared) return true;
        const key = `${p.name}:${viaShared ? 1 : 0}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return membersOf(p.name).some((m) => reaches(m, target, viaShared, seen));
      }
      case "opt": case "ref": case "task": case "chan": case "atomic":
        return reaches(p.inner, target, viaShared, seen);
      case "list": case "array": case "set":
        return reaches(p.elem, target, viaShared, seen);
      case "map":
        return reaches(p.key, target, viaShared, seen) || reaches(p.val, target, viaShared, seen);
      case "tuple":
        return p.elems.some((e) => reaches(e, target, viaShared, seen));
      default:
        // `raw` is deliberately not followed: it owns nothing, so it cannot
        // hold a refcount open.
        return false;
    }
  };

  const report = (name: string, span: Span): void => {
    const cyclic = membersOf(name).some((m) => reaches(m, name, false, new Set()));
    if (!cyclic) return;
    diags.warn("W1010", `a \`shared\` ${name} can reach itself; the cycle will leak`, span, {
      rule: "M3 — shared(T) for genuine shared ownership",
      help: "make one edge `weak(...)` to break it",
    } as never);
  };

  const walk = (stmts: A.Stmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "StructDecl" || s.kind === "EnumDecl") report(s.name, s.span);
      else if (s.kind === "GenerateDecl") walk(s.body.stmts);
    }
  };
  walk(mod.stmts);

  void show;
  return diags;
}
