// Escape analysis — spec/MEMORY-MODEL.md M4.
//
// The ownership checker proved that every heap value has one owner and that no
// borrow outlives its block. This pass turns that proof into deallocation:
// for each frame it works out which locals the frame is responsible for, so
// the backend can emit a `free` at scope exit instead of leaking.
//
// It is deliberately conservative in one direction only. A value is released
// **only** when we can show the frame owns it and nothing outlives the frame
// holding it. Anything unclear is left alone — a leak is a performance bug,
// a double free is a security bug, and they are not the same kind of wrong.
//
// A consequence of M2.3 worth naming: a function can never return a borrow, so
// a call that yields an owned type always yields a *fresh* value. That is what
// makes "the caller owns a call's result" safe to assume.

import type * as A from "../parser/ast.ts";
import type { TypeMap } from "./infer.ts";
import { type Ty, prune } from "./types.ts";
import { classifyOwnership, type OwnershipKind } from "./ownership.ts";
import { JSON_DOC } from "./prelude-types.ts";

/**
 * A local the frame must release. `enum` carries its type too, because
 * which payload needs freeing depends on the variant, and the backend
 * resolves that from the monomorphised instance.
 */
export interface Owned { name: string; kind: "str" | "list" | "enum" | "opt" | "map" | "tuple" | "json" | "struct" | "shared" | "weak"; ty?: Ty }

export interface EscapeInfo {
  /**
   * Locals each block must free when control leaves it. Keyed by the block
   * that *declares* them, so a value created inside a loop is freed every
   * iteration rather than accumulating until the function returns.
   */
  blocks: Map<A.Block, Owned[]>;
  /** Owning parameters each function must free, keyed by function name. */
  params: Map<string, Owned[]>;
  /** What the module's top level must free before the program exits. */
  topLevel: Owned[];
  /** List literals that can live on the stack: they neither escape nor grow. */
  stackable: Set<A.Expr>;
}

/** Prelude and method calls that return a freshly allocated container. */
const ALLOCATING = new Set([
  "map", "filter", "sorted", "reversed", "enumerate", "zip", "chars", "bytes",
  "split", "lines", "keys", "values", "entries", "to_list", "union", "intersect",
  "difference", "join", "upper", "lower", "trim", "trim_start", "trim_end",
  "replace", "repeat", "pad_start", "pad_end", "concat", "flatten", "chunk",
  "unique", "merge", "from_entries", "list", "array", "set", "map", "tuple",
  "string", "inspect",
]);

/** Methods that can reallocate a list's storage, so it cannot live on the stack. */
const GROWING = new Set(["push", "insert", "extend", "remove_at", "remove", "clear", "sort", "reverse"]);

class EscapeAnalysis {
  private types: TypeMap;
  private structFields: Map<string, Ty[]>;
  private owningParams: Map<string, boolean[]>;
  private enumsWithHeap = new Set<string>();
  private fns = new Map<string, A.FnDecl>();
  readonly stackable = new Set<A.Expr>();
  readonly blocks = new Map<A.Block, Owned[]>();
  readonly params = new Map<string, Owned[]>();
  /** The module's top level, treated as one block. */
  private top: A.Block | null = null;

  topBlock(mod: A.Module): A.Block {
    if (!this.top) this.top = { kind: "Block", span: mod.span, stmts: mod.stmts };
    return this.top;
  }

  constructor(
    types: TypeMap,
    structFields: Map<string, Ty[]>,
    owningParams: Map<string, boolean[]>,
    enumVariants?: Map<string, Map<string, { fields: Ty[]; names: string[] }>>,
  ) {
    this.types = types;
    this.structFields = structFields;
    this.owningParams = owningParams;
    for (const [name, variants] of enumVariants ?? []) {
      if (EscapeAnalysis.carriesHeap(variants)) this.enumsWithHeap.add(name);
    }
  }

  private kind(n: A.Node): OwnershipKind {
    return classifyOwnership(this.types.get(n), (name) => this.structFields.get(name));
  }

  private heapKind(t: Ty | undefined): "str" | "list" | "enum" | "opt" | "map" | "tuple" | "json" | "struct" | "shared" | "weak" | null {
    if (!t) return null;
    const p = prune(t);
    if (p.k === "prim" && p.name === "string") return "str";
    if (p.k === "list" || p.k === "array") return "list";
    // A map owns its keys and values, so releasing one releases them.
    if (p.k === "map") return "map";
    // An enum can carry a heap payload — `Result<string>` owns its string —
    // so it needs releasing like any other owner. Which field to free
    // depends on the tag, which the backend works out per instantiation.
    if (p.k === "named" && this.enumsWithHeap.has(p.name)) return "enum";
    // `string?` owns its string when it has one. The wrapper itself is a
    // plain struct, so the release has to look at the tag first.
    if (p.k === "opt" && this.heapKind(p.inner)) return "opt";
    // A tuple owns whatever its fields own, so `(i, "row {i}")` in a loop
    // leaked a string per iteration until this was here.
    if (p.k === "tuple" && p.elems.some((el) => this.heapKind(el))) return "tuple";
    // A parsed JSON document owns its whole tree. Indexing one hands back a
    // borrowed pointer into it, which is why that is not an owner.
    if (p.k === "any" && p.why === JSON_DOC) return "json";
    // A struct owns whatever its fields own. Only enums were handled here,
    // so `let b: B("x{i}")` in a loop leaked a string per iteration.
    if (p.k === "named" && this.structOwns(p.name, new Set())) return "struct";
    // A `shared` handle is one owner of a counted box (M3): every handle
    // releases, and the last one frees the value.
    if (p.k === "shared") return "shared";
    // A weak handle owns no value, but it does hold the control block open
    // so that asking is safe, and that has to be given back.
    if (p.k === "weak") return "weak";
    return null;
  }

  /** Does this struct own anything that has to be freed? */
  private structOwns(name: string, seen: Set<string>): boolean {
    if (seen.has(name)) return false;
    seen.add(name);
    const fields = this.structFields.get(name);
    if (!fields) return false;
    return fields.some((f) => {
      const p = prune(f);
      if (p.k === "named") return this.structOwns(p.name, seen);
      return this.heapKind(f) !== null;
    });
  }

  /** Does any variant of this enum carry something heap-allocated? */
  private static carriesHeap(variants: Map<string, { fields: Ty[] }>): boolean {
    for (const v of variants.values()) {
      for (const f of v.fields) {
        const p = prune(f);
        if (p.k === "prim" && p.name === "string") return true;
        if (p.k === "list" || p.k === "array") return true;
        // A bare type parameter may be instantiated with anything, so a
        // generic payload counts as possibly owning.
        if (p.k === "named" && p.args.length === 0) return true;
      }
    }
    return false;
  }

  run(mod: A.Module): EscapeInfo {
    const collect = (stmts: A.Stmt[]) => {
      for (const s of stmts) {
        if (s.kind === "FnDecl" && s.body && !s.foreign && !s.isMacro) {
          this.fns.set(s.name, s);
        } else if (s.kind === "ImplDecl") {
          for (const m of s.members) if (m.body) this.fns.set(`${s.typeName}.${m.name}`, m);
        } else if (s.kind === "GenerateDecl") {
          collect(s.body.stmts);
        }
      }
    };
    collect(mod.stmts);

    for (const [name, f] of this.fns) this.analyse(f.body!, f, name);
    const top = this.topBlock(mod);
    this.analyse(top, null, "<main>");
    // The emitter builds its own Block for main(), so hand the top level's
    // release set over by value rather than by node identity.
    return {
      blocks: this.blocks,
      params: this.params,
      topLevel: this.blocks.get(top) ?? [],
      stackable: this.stackable,
    };
  }

  // -------------------------------------------------------------------------

  private analyse(body: A.Block, fn: A.FnDecl | null, fnName: string): void {
    /**
     * Locals the frame took ownership of, and where their value came from.
     * This is a list rather than a name-keyed map because two sibling blocks
     * may each declare an owned `xs`; those are different values and each
     * block has to free its own. Disqualification below is still by name,
     * which over-approximates in the leak direction rather than the
     * double-free one.
     */
    const owns: { name: string; kind: "str" | "list" | "enum" | "opt" | "map" | "tuple" | "json" | "struct" | "shared" | "weak"; ty?: Ty; init: A.Expr | null; block: A.Block | null }[] = [];
    const declare = (name: string, d: { kind: "str" | "list" | "enum" | "opt" | "map" | "tuple" | "json" | "struct" | "shared" | "weak"; ty?: Ty; init: A.Expr | null; block: A.Block | null }) => {
      // One release per (block, name); a block cannot free the same C
      // variable twice however many times the source rebinds it.
      const at = owns.findIndex((o) => o.name === name && o.block === d.block);
      if (at >= 0) owns[at] = { name, ...d };
      else owns.push({ name, ...d });
    };
    const escaped = new Set<string>();
    const movedAway = new Set<string>();
    const grown = new Set<string>();

    // An owning parameter arrives owned, so this frame must release it (M2.2).
    if (fn) {
      const flags = this.owningParams.get(fnName);
      const sig = this.types.get(fn);
      const params = sig && prune(sig).k === "fn" ? (prune(sig) as { params: { ty: Ty }[] }).params : [];
      fn.params.forEach((p, i) => {
        if (!flags?.[i]) return;
        const hk = this.heapKind(params[i]?.ty);
        if (hk) declare(p.name, { kind: hk, init: null, block: null });
      });
    }

    const markEscape = (e: A.Expr): void => {
      const n = rootIdent(e);
      if (n) escaped.add(n);
    };

    const visit = (e: A.Expr, position: "value" | "escape" | "read"): void => {
      switch (e.kind) {
        case "Ident":
          if (position === "escape") escaped.add(e.name);
          else if (position === "value" && this.kind(e) === "owned") movedAway.add(e.name);
          return;

        case "MoveExpr":
          if (e.expr.kind === "Ident") {
            if (position === "escape") escaped.add(e.expr.name);
            else movedAway.add(e.expr.name);
            return;
          }
          visit(e.expr, position);
          return;

        case "CallExpr": {
          const callee = e.callee.kind === "Ident" ? e.callee.name : null;
          const method = e.callee.kind === "MemberExpr" ? e.callee.name : null;
          if (method && GROWING.has(method)) {
            const recv = rootIdent((e.callee as A.MemberExpr).obj);
            if (recv) grown.add(recv);
          }
          if (e.callee.kind === "MemberExpr") visit(e.callee.obj, "read");
          const flags = callee ? this.owningParams.get(callee) : undefined;
          e.args.forEach((a, i) => {
            // An argument the callee keeps leaves this frame for good.
            const keeps = !!flags?.[i] || (method !== null && GROWING.has(method));
            visit(a.value, keeps ? "escape" : "read");
          });
          return;
        }

        case "StartExpr": {
          // A task outlives the frame, so anything it captures escapes.
          if (e.call.kind === "CallExpr") {
            for (const a of e.call.args) { visit(a.value, "escape"); markEscape(a.value); }
          } else visit(e.call, "escape");
          return;
        }

        case "ListExpr": case "SetExpr": case "TupleExpr":
          for (const el of e.elements) visit(el, position === "read" ? "read" : "escape");
          return;

        case "MapExpr":
          for (const en of e.entries) { visit(en.key, "escape"); visit(en.value, "escape"); }
          return;

        case "RecordExpr":
          for (const en of e.entries) visit(en.value, "escape");
          return;

        case "StrLit":
          for (const p of e.parts) if (p.kind === "expr" && p.expr) visit(p.expr, "read");
          return;

        case "MatchExpr":
          visit(e.subject, "read");
          for (const arm of e.arms) walk(arm.body.stmts);
          if (e.elseArm) walk(e.elseArm.stmts);
          return;

        default:
          for (const c of childExprs(e)) visit(c, "read");
          return;
      }
    };

    let current: A.Block = body;
    const inBlock = (b: A.Block, f: () => void): void => {
      const prev = current;
      current = b;
      f();
      current = prev;
    };

    const walk = (stmts: A.Stmt[]): void => {
      for (const s of stmts) {
        switch (s.kind) {
          case "LetStmt": {
            // Destructuring copies fields out; the value itself is not moved,
            // so the frame keeps owning it and still has to release it.
            // Treating it as a move leaked the field of every `let (a, b): t`.
            if (s.value) visit(s.value, s.pattern.kind === "TuplePat" ? "read" : "value");
            if (s.pattern.kind !== "BindPat") break;
            if (!s.value) {
              // `let w: weak(C)` with nothing in it yet still owns whatever
              // it is assigned later, and something has to give that back.
              const declared = this.types.get(s.pattern as unknown as A.Node);
              const dk = this.heapKind(declared);
              if (dk === "shared" || dk === "weak") {
                declare(s.pattern.name, { kind: dk, ty: declared, init: null, block: current });
              }
              break;
            }
            const hk = this.heapKind(this.types.get(s.pattern as unknown as A.Node) ?? this.types.get(s.value));
            // Only claim a value the frame demonstrably owns.
            if (hk && this.producesOwned(s.value)) {
              const ty = this.types.get(s.pattern as unknown as A.Node) ?? this.types.get(s.value);
              declare(s.pattern.name, { kind: hk, ty, init: s.value, block: current });
            }
            break;
          }
          case "ConstDecl": visit(s.value, "value"); break;
          case "AssignStmt":
            // Assigning into a field or an element hands the value over.
            visit(s.value, s.target.kind === "Ident" ? "value" : "escape");
            if (s.target.kind !== "Ident") {
              visit(s.target, "read");
              markEscape(s.value);
            } else {
              const k = this.heapKind(this.types.get(s.target));
              // A handle is the exception: rebinding one releases the handle
              // it held and takes the new one, so the frame still knows what
              // it owns and still has to give it back. For anything else the
              // frame loses track and stops claiming it.
              if (k !== "shared" && k !== "weak") escaped.add(s.target.name);
            }
            break;
          case "GiveStmt":
            if (s.value) { visit(s.value, "escape"); markEscape(s.value); }
            break;
          case "ExprStmt": visit(s.expr, "read"); break;
          case "SayStmt": for (const a of s.args) visit(a, "read"); break;
          case "IntrinsicStmt":
            visit(s.target, "read");
            if (s.value) { visit(s.value, s.op === "send" ? "escape" : "read"); if (s.op === "send") markEscape(s.value); }
            break;
          case "IfStmt":
            visit(s.cond, "read");
            inBlock(s.then, () => walk(s.then.stmts));
            for (const e of s.elifs) { visit(e.cond, "read"); inBlock(e.block, () => walk(e.block.stmts)); }
            if (s.else) inBlock(s.else, () => walk(s.else!.stmts));
            break;
          case "ForStmt": visit(s.iter, "read"); inBlock(s.body, () => walk(s.body.stmts)); break;
          case "WhileStmt": visit(s.cond, "read"); inBlock(s.body, () => walk(s.body.stmts)); break;
          case "MatchStmt":
            visit(s.expr.subject, "read");
            for (const arm of s.expr.arms) inBlock(arm.body, () => walk(arm.body.stmts));
            if (s.expr.elseArm) inBlock(s.expr.elseArm, () => walk(s.expr.elseArm!.stmts));
            break;
          case "WithStmt":
            if (!s.capability) visit(s.subject, "read");
            inBlock(s.body, () => walk(s.body.stmts));
            break;
          case "ParallelStmt": case "UnsafeStmt": case "GenerateDecl":
            inBlock(s.body, () => walk(s.body.stmts));
            break;
          case "DeferStmt": walk([s.stmt]); break;
          default: break;
        }
      }
    };
    walk(body.stmts);

    const paramOwned: Owned[] = [];
    for (const info of owns) {
      const name = info.name;
      if (escaped.has(name) || movedAway.has(name)) continue;
      const owned: Owned = { name, kind: info.kind, ty: info.ty };
      if (info.block === null) {
        paramOwned.push(owned);              // an owning parameter
      } else {
        const list = this.blocks.get(info.block) ?? [];
        list.push(owned);
        this.blocks.set(info.block, list);
      }
      // M4 — a list that neither escapes nor grows can live on the stack.
      if (info.kind === "list" && info.init?.kind === "ListExpr" && !grown.has(name)) {
        this.stackable.add(info.init);
      }
    }
    this.params.set(fnName, paramOwned);
  }

  /**
   * Does this expression hand the frame a value it owns? Reading an element
   * out of a container does not — the container still owns it — so those are
   * excluded to keep a double free impossible.
   */
  private producesOwned(e: A.Expr): boolean {
    switch (e.kind) {
      case "ListExpr": case "MapExpr": case "SetExpr": case "RecordExpr":
        return true;
      case "TupleExpr":
        // The struct itself is not heap, but a field built here is, and
        // releasing the tuple is what releases it.
        return true;
      case "StrLit":
        // A literal with no interpolation is static; one with interpolation
        // is built at run time.
        return e.parts.some((p) => p.kind === "expr");
      case "BinaryExpr":
        return e.op === "+";
      case "Ident": case "MoveExpr":
        return true; // a move: this frame is the new owner
      case "CastExpr":
        return !e.fallible;
      case "CallExpr": {
        // `files.read(path)` hands back a fresh `Result` that owns its
        // payload; the module it came from does not keep a reference.
        if (e.callee.kind === "MemberExpr" && e.callee.obj.kind === "Ident") {
          const objTy = this.types.get(e.callee.obj);
          if (objTy && prune(objTy).k === "module") return true;
        }
        if (e.callee.kind === "Ident") {
          if (this.fns.has(e.callee.name)) return true; // M2.3: it cannot be a borrow
          // A struct literal: `B("x")` builds a fresh value, and whatever
          // its fields own goes with it.
          if (this.structFields.has(e.callee.name)) return true;
          return ALLOCATING.has(e.callee.name);
        }
        if (e.callee.kind === "MemberExpr") return ALLOCATING.has(e.callee.name);
        return false;
      }
      default:
        return false;
    }
  }
}

function rootIdent(e: A.Expr): string | null {
  let cur: A.Expr = e;
  for (;;) {
    if (cur.kind === "Ident") return cur.name;
    if (cur.kind === "MoveExpr") { cur = cur.expr; continue; }
    if (cur.kind === "MemberExpr") { cur = cur.obj; continue; }
    if (cur.kind === "IndexExpr") { cur = cur.obj; continue; }
    if (cur.kind === "SliceExpr") { cur = cur.obj; continue; }
    if (cur.kind === "BorrowExpr" || cur.kind === "RefExpr") { cur = cur.expr; continue; }
    return null;
  }
}

function childExprs(e: A.Expr): A.Expr[] {
  const out: A.Expr[] = [];
  const push = (x: unknown) => {
    if (x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string" && "span" in (x as object)) {
      const k = (x as { kind: string }).kind;
      if (!k.endsWith("Pat") && !k.endsWith("Type") && k !== "Block") out.push(x as A.Expr);
    }
  };
  for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "typeArgs") continue;
    if (Array.isArray(v)) for (const x of v) { push(x); if (x && typeof x === "object" && "value" in (x as object)) push((x as { value: unknown }).value); }
    else push(v);
  }
  return out;
}

export function analyseEscapes(
  mod: A.Module,
  types: TypeMap,
  structFields: Map<string, Ty[]>,
  owningParams: Map<string, boolean[]>,
  enumVariants?: Map<string, Map<string, { fields: Ty[]; names: string[] }>>,
): EscapeInfo {
  return new EscapeAnalysis(types, structFields, owningParams, enumVariants).run(mod);
}
