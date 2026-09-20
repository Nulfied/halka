// Rule #46 — `unsafe:` is required for raw-pointer work, checked statically.
//
// The interpreter has always enforced this, but only when the code actually
// ran: a raw dereference down a branch nobody took was never reported, and
// `halka check` said a program was fine that `halka run` would refuse. The
// compiled backend enforced nothing at all.
//
// Checking it here fixes both. The rule is the interpreter's, unchanged:
// dereferencing a raw pointer, or writing through one, needs an enclosing
// `unsafe:` block, and the block does not reach into a function it calls --
// an `unsafe:` at a call site says nothing about the callee's body.

import type * as A from "../parser/ast.ts";
import { DiagnosticBag } from "../util/diagnostics.ts";
import type { TypeMap } from "./infer.ts";
import { type Ty, prune } from "./types.ts";

export function checkUnsafe(mod: A.Module, types: TypeMap): DiagnosticBag {
  const diags = new DiagnosticBag();

  const isRaw = (e: A.Expr): boolean => {
    const t: Ty | undefined = types.get(e);
    return !!t && prune(t).k === "raw";
  };

  const err = (msg: string, span: A.Node["span"]): void => {
    diags.error("E0502", msg, span, { rule: "#46 — unsafe / raw-pointer syntax" } as never);
  };

  /** `unsafe` is whether a raw operation is allowed right here. */
  const expr = (e: A.Expr | undefined, unsafe: boolean): void => {
    if (!e) return;
    if (e.kind === "DerefExpr") {
      if (!unsafe && isRaw(e.expr)) {
        err("dereferencing a raw pointer requires an `unsafe:` block (rule #46)", e.span);
      }
      expr(e.expr, unsafe);
      return;
    }
    for (const c of children(e)) expr(c, unsafe);
  };

  const stmt = (s: A.Stmt, unsafe: boolean): void => {
    switch (s.kind) {
      case "UnsafeStmt": block(s.body, true); return;

      case "AssignStmt":
        if (s.target.kind === "DerefExpr" && !unsafe && isRaw(s.target.expr)) {
          err("writing through a raw pointer requires an `unsafe:` block (rule #46)", s.span);
        }
        expr(s.target.kind === "DerefExpr" ? s.target.expr : s.target, unsafe);
        expr(s.value, unsafe);
        return;

      // Every body below starts a fresh frame: an `unsafe:` block around a
      // call does not make the callee's own raw work legal.
      case "FnDecl":
        if (s.body && !s.foreign) block(s.body, false);
        return;
      case "ImplDecl":
        for (const m of s.members) if (m.body) block(m.body, false);
        return;

      default:
        for (const c of stmtChildren(s)) {
          if (isBlock(c)) block(c as A.Block, unsafe);
          else expr(c as A.Expr, unsafe);
        }
    }
  };

  const block = (b: A.Block, unsafe: boolean): void => {
    for (const s of b.stmts) stmt(s, unsafe);
  };

  for (const s of mod.stmts) stmt(s, false);
  return diags;
}

function isBlock(x: unknown): boolean {
  return !!x && typeof x === "object" && (x as { kind?: unknown }).kind === "Block";
}

/** Every child node of an expression, without naming each shape. */
function children(e: A.Expr): A.Expr[] {
  const out: A.Expr[] = [];
  for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "typeArgs") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (!x || typeof x !== "object" || !("kind" in (x as object))) continue;
      const kind = (x as { kind: string }).kind;
      if (kind.endsWith("Pat") || kind.endsWith("Type") || kind === "Block") continue;
      out.push(x as A.Expr);
      // Call arguments and map entries wrap their value one level down.
      const inner = (x as { value?: unknown }).value;
      if (inner && typeof inner === "object" && "kind" in (inner as object)) out.push(inner as A.Expr);
    }
  }
  return out;
}

/** Child expressions and blocks of a statement. */
function stmtChildren(s: A.Stmt): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(s as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "type" || k === "pattern") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (!x || typeof x !== "object" || !("kind" in (x as object))) continue;
      const kind = (x as { kind: string }).kind;
      if (kind.endsWith("Pat") || kind.endsWith("Type")) continue;
      out.push(x);
      const inner = (x as { value?: unknown }).value;
      if (inner && typeof inner === "object" && "kind" in (inner as object)) out.push(inner);
      const body = (x as { body?: unknown }).body;
      if (isBlock(body)) out.push(body);
      const blk = (x as { block?: unknown }).block;
      if (isBlock(blk)) out.push(blk);
    }
  }
  return out;
}
