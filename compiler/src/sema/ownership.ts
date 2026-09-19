// The ownership and borrow checker — spec/MEMORY-MODEL.md.
//
// This is what turns "memory safe without borrow-checker pain" from a design
// document into a compiler guarantee. It enforces:
//
//   M1   every heap value has one owner; using a moved value is an error
//   M2   borrows are lexical and may not escape the block that made them
//   M2.1 one `borrow mut`, or many `borrow`, never both
//   M2.2 parameters borrow by default; ownership is *inferred*, never annotated
//   M5   a task may not capture a borrow, so data races are rejected
//
// What keeps it small: a borrow cannot escape, so the analysis never has to
// relate two lifetimes and there is nothing to name. The whole thing is a
// forward walk with a state map and a conservative merge at joins.

import type * as A from "../parser/ast.ts";
import { DiagnosticBag, type Span } from "../util/diagnostics.ts";
import type { TypeMap } from "./infer.ts";
import { type Ty, prune, show } from "./types.ts";

// ---------------------------------------------------------------------------
// value classification
// ---------------------------------------------------------------------------

/** How a value behaves when it is assigned or passed. */
type Kind = "copy" | "owned" | "borrow" | "shared" | "unknown";

interface Fields { (name: string): Ty[] | undefined }

function classify(t: Ty | undefined, fields: Fields, seen = new Set<string>()): Kind {
  if (!t) return "unknown";
  const p = prune(t);
  switch (p.k) {
    case "prim":
      // Only `string` owns heap memory among the primitives.
      return p.name === "string" ? "owned" : "copy";
    case "list": case "array": case "map": case "set":
      return "owned";
    case "tuple": {
      const kinds = p.elems.map((e) => classify(e, fields, seen));
      return kinds.some((k) => k === "owned") ? "owned"
        : kinds.some((k) => k === "unknown") ? "unknown" : "copy";
    }
    case "named": {
      if (p.name === "shared" || p.name === "weak") return "shared";
      if (seen.has(p.name)) return "owned"; // recursive type: heap by definition
      const fs = fields(p.name);
      if (!fs) return "unknown"; // an enum or an unresolved name
      seen.add(p.name);
      const kinds = fs.map((f) => classify(f, fields, seen));
      seen.delete(p.name);
      // M1.1 — a struct of plain scalars is copied, not moved.
      return kinds.some((k) => k === "owned") ? "owned"
        : kinds.some((k) => k === "unknown") ? "unknown" : "copy";
    }
    case "shared": return "shared";
    case "ref": return "borrow";
    case "range": case "cap": case "type": case "module": return "copy";
    case "raw": case "cty": case "any": case "var": case "never": return "unknown";
    case "fn": case "task": case "chan": case "atomic": case "mutex": return "unknown";
    default: return "unknown";
  }
}

// ---------------------------------------------------------------------------
// per-variable state
// ---------------------------------------------------------------------------

interface VarState {
  name: string;
  kind: Kind;
  /** Where it was moved, if it was. */
  movedAt?: Span;
  /** Why it moved, for the diagnostic. */
  movedWhy?: string;
  /** Live shared borrows in the current block. */
  shared: number;
  /** A live exclusive borrow, if any. */
  exclusive?: Span;
  declaredAt: Span;
  /** True for a parameter, which borrows unless inference says otherwise. */
  isParam: boolean;
}

type State = Map<string, VarState>;

function cloneState(s: State): State {
  const out: State = new Map();
  for (const [k, v] of s) out.set(k, { ...v });
  return out;
}

/** Conservative join: moved on any path means moved after the join. */
function mergeState(into: State, other: State): void {
  for (const [k, v] of other) {
    const cur = into.get(k);
    if (!cur) { into.set(k, { ...v }); continue; }
    if (!cur.movedAt && v.movedAt) { cur.movedAt = v.movedAt; cur.movedWhy = v.movedWhy; }
  }
}

// ---------------------------------------------------------------------------
// the checker
// ---------------------------------------------------------------------------

export interface OwnershipResult {
  diags: DiagnosticBag;
  /** For each function, which parameters take ownership of their argument. */
  owningParams: Map<string, boolean[]>;
}

class OwnershipChecker {
  private diags = new DiagnosticBag();
  private types: TypeMap;
  private structFields: Map<string, Ty[]>;
  private fns = new Map<string, A.FnDecl>();
  /** fn name -> per-parameter "this parameter is moved by the body" (M2.2). */
  private owning = new Map<string, boolean[]>();

  constructor(types: TypeMap, structFields: Map<string, Ty[]>) {
    this.types = types;
    this.structFields = structFields;
  }

  private fieldsOf: Fields = (n) => this.structFields.get(n);

  private ty(n: A.Node): Ty | undefined { return this.types.get(n); }
  private kindOf(n: A.Node): Kind { return classify(this.ty(n), this.fieldsOf); }

  private err(code: string, msg: string, span: Span, extra?: Partial<{ help: string; rule: string; notes: { message: string; span?: Span }[] }>): void {
    this.diags.error(code, msg, span, { rule: RULE_OF[code] ?? "spec/MEMORY-MODEL.md", ...extra } as never);
  }

  // -------------------------------------------------------------------------

  run(mod: A.Module): OwnershipResult {
    this.collect(mod.stmts);
    this.inferOwningParams();
    for (const f of this.fns.values()) this.checkFunction(f);
    this.checkTopLevel(mod.stmts);
    return { diags: this.diags, owningParams: this.owning };
  }

  private collect(stmts: A.Stmt[]): void {
    for (const s of stmts) {
      if (s.kind === "FnDecl" && s.body && !s.foreign && !s.isMacro) {
        this.fns.set(s.name, s);
      } else if (s.kind === "ImplDecl") {
        for (const m of s.members) if (m.body) this.fns.set(`${s.typeName}.${m.name}`, m);
      } else if (s.kind === "GenerateDecl") {
        this.collect(s.body.stmts);
      }
    }
  }

  /**
   * M2.2 — a parameter is owning exactly when the body moves it. Passing a
   * parameter to another function's owning parameter is itself a move, so this
   * is a fixpoint over the call graph.
   */
  private inferOwningParams(): void {
    for (const [name, f] of this.fns) this.owning.set(name, f.params.map(() => false));

    for (let round = 0; round < 8; round++) {
      let changed = false;
      for (const [name, f] of this.fns) {
        const flags = this.owning.get(name)!;
        const params = new Set(f.params.map((p) => p.name));
        const moved = new Set<string>();
        this.collectMoves(f.body!, params, moved);
        f.params.forEach((p, i) => {
          if (!flags[i] && moved.has(p.name)) { flags[i] = true; changed = true; }
        });
      }
      if (!changed) break;
    }
  }

  /** Names among `watch` that this block moves. Used only by the fixpoint. */
  private collectMoves(block: A.Block, watch: Set<string>, out: Set<string>): void {
    const visitExprForMove = (e: A.Expr, movesIt: boolean): void => {
      if (movesIt && e.kind === "Ident" && watch.has(e.name) && this.kindOf(e) === "owned") out.add(e.name);
      if (e.kind === "MoveExpr" && e.expr.kind === "Ident" && watch.has(e.expr.name)) out.add(e.expr.name);
      for (const c of exprChildren(e)) visitExprForMove(c, false);
      // A call moves the arguments its callee owns.
      if (e.kind === "CallExpr") {
        const target = this.calleeName(e);
        const flags = target ? this.owning.get(target) : undefined;
        e.args.forEach((a, i) => {
          if (flags?.[i]) visitExprForMove(a.value, true);
        });
        // A container method that keeps its argument.
        if (e.callee.kind === "MemberExpr" && KEEPING_METHODS.has(e.callee.name)) {
          for (const a of e.args) visitExprForMove(a.value, true);
        }
      }
      if (e.kind === "StartExpr") {
        const call = e.call;
        if (call.kind === "CallExpr") for (const a of call.args) visitExprForMove(a.value, true);
      }
      // Building a container out of a value keeps it.
      if (e.kind === "ListExpr" || e.kind === "SetExpr" || e.kind === "TupleExpr") {
        for (const el of e.elements) visitExprForMove(el, true);
      }
      if (e.kind === "MapExpr") for (const en of e.entries) visitExprForMove(en.value, true);
      if (e.kind === "RecordExpr") for (const en of e.entries) visitExprForMove(en.value, true);
    };

    const walkStmts = (stmts: A.Stmt[]): void => {
      for (const s of stmts) {
        switch (s.kind) {
          case "LetStmt":
            if (s.value) visitExprForMove(s.value, true);
            break;
          case "AssignStmt":
            visitExprForMove(s.value, true);
            break;
          case "GiveStmt":
            if (s.value) visitExprForMove(s.value, true);
            break;
          case "ExprStmt": visitExprForMove(s.expr, false); break;
          case "SayStmt": for (const a of s.args) visitExprForMove(a, false); break;
          case "IntrinsicStmt":
            if (s.value) visitExprForMove(s.value, s.op === "send");
            break;
          case "IfStmt":
            visitExprForMove(s.cond, false);
            walkStmts(s.then.stmts);
            for (const e of s.elifs) walkStmts(e.block.stmts);
            if (s.else) walkStmts(s.else.stmts);
            break;
          case "ForStmt": visitExprForMove(s.iter, false); walkStmts(s.body.stmts); break;
          case "WhileStmt": visitExprForMove(s.cond, false); walkStmts(s.body.stmts); break;
          case "MatchStmt":
            visitExprForMove(s.expr.subject, false);
            for (const arm of s.expr.arms) walkStmts(arm.body.stmts);
            if (s.expr.elseArm) walkStmts(s.expr.elseArm.stmts);
            break;
          case "WithStmt": case "ParallelStmt": case "UnsafeStmt": case "GenerateDecl":
            walkStmts(s.body.stmts);
            break;
          case "DeferStmt": walkStmts([s.stmt]); break;
          default: break;
        }
      }
    };
    walkStmts(block.stmts);
  }

  private calleeName(e: A.CallExpr): string | null {
    if (e.callee.kind === "Ident") return e.callee.name;
    return null;
  }

  // -------------------------------------------------------------------------

  private checkFunction(f: A.FnDecl): void {
    const state: State = new Map();
    for (const p of f.params) {
      const t = this.types.get(f);
      const pt = t && prune(t).k === "fn" ? (prune(t) as { params: { ty: Ty }[] }).params[f.params.indexOf(p)]?.ty : undefined;
      state.set(p.name, {
        name: p.name,
        kind: classify(pt, this.fieldsOf),
        shared: 0,
        declaredAt: p.span,
        isParam: true,
      });
    }
    this.walkBlock(f.body!, state, { inLoop: false, fnName: f.name, flow: { diverged: false } });
  }

  private checkTopLevel(stmts: A.Stmt[]): void {
    const state: State = new Map();
    this.walkStmts(stmts, state, { inLoop: false, fnName: "<main>", flow: { diverged: false } });
  }

  // -------------------------------------------------------------------------

  private walkBlock(b: A.Block, state: State, ctx: Ctx): void {
    // A borrow dies at the end of the block that made it (M2), so remember
    // which borrows this block opened and close them on the way out.
    const opened: { target: string; exclusive: boolean }[] = [];
    this.walkStmts(b.stmts, state, { ...ctx, opened });
    for (const o of opened) this.release(state, o);
  }

  private walkStmts(stmts: A.Stmt[], state: State, ctx: Ctx): void {
    for (const s of stmts) {
      if (ctx.flow.diverged) return; // unreachable after `give` / `break`

      // A borrow lives to the end of its block only when it is *named*
      // (`let view: borrow data`). One created inside an expression —
      // `f(borrow data)` — is a temporary and dies with the statement.
      const named = s.kind === "LetStmt" && s.pattern.kind === "BindPat" && !!s.value
        && this.kindOf(s.value) === "borrow";
      const stmtOpened: { target: string; exclusive: boolean }[] = [];
      this.walkStmt(s, state, { ...ctx, opened: stmtOpened });

      if (named) ctx.opened?.push(...stmtOpened);
      else for (const o of stmtOpened) this.release(state, o);
    }
  }

  private release(state: State, o: { target: string; exclusive: boolean }): void {
    const v = state.get(o.target);
    if (!v) return;
    if (o.exclusive) v.exclusive = undefined;
    else v.shared = Math.max(0, v.shared - 1);
  }

  /** Analyse a branch in its own flow, and report whether it fell through. */
  private branch(body: A.Block, entry: State, ctx: Ctx): { state: State; diverged: boolean } {
    const b = cloneState(entry);
    const flow = { diverged: false };
    this.walkBlock(body, b, { ...ctx, flow });
    return { state: b, diverged: flow.diverged };
  }

  private walkStmt(s: A.Stmt, state: State, ctx: Ctx): void {
    switch (s.kind) {
      case "LetStmt": {
        // Destructuring reads elements out of the source the way indexing
        // does, so it copies rather than moving the container (M1).
        const consumes = s.pattern.kind === "BindPat";
        if (s.value) this.useExpr(s.value, state, ctx, consumes);
        if (s.pattern.kind === "BindPat") {
          const k = this.kindOf(s.pattern as unknown as A.Node) !== "unknown"
            ? this.kindOf(s.pattern as unknown as A.Node)
            : s.value ? this.kindOf(s.value) : "unknown";
          state.set(s.pattern.name, {
            name: s.pattern.name,
            kind: k,
            shared: 0,
            declaredAt: s.span,
            isParam: false,
          });
        } else {
          for (const n of patternNames(s.pattern)) {
            state.set(n, { name: n, kind: "unknown", shared: 0, declaredAt: s.span, isParam: false });
          }
        }
        return;
      }

      case "ConstDecl":
        this.useExpr(s.value, state, ctx, true);
        state.set(s.name, { name: s.name, kind: this.kindOf(s.value), shared: 0, declaredAt: s.span, isParam: false });
        return;

      case "AssignStmt": {
        this.useExpr(s.value, state, ctx, true);
        // Storing a borrow into a field, an element, or an outer binding lets
        // it outlive its block (M2.3).
        if (this.kindOf(s.value) === "borrow" && s.target.kind !== "DerefExpr") {
          this.escapes(s.value, "stored", s.span);
        }
        if (s.target.kind === "Ident") {
          const v = state.get(s.target.name);
          if (v) { v.movedAt = undefined; v.movedWhy = undefined; }
          else state.set(s.target.name, { name: s.target.name, kind: this.kindOf(s.value), shared: 0, declaredAt: s.span, isParam: false });
        } else {
          this.checkMutationTarget(s.target, state, ctx);
          this.useExpr(s.target, state, ctx, false);
        }
        return;
      }

      case "ExprStmt": this.useExpr(s.expr, state, ctx, false); return;
      case "SayStmt": for (const a of s.args) this.useExpr(a, state, ctx, false); return;

      case "GiveStmt":
        if (s.value) {
          this.useExpr(s.value, state, ctx, true);
          if (this.kindOf(s.value) === "borrow") this.escapes(s.value, "returned", s.span);
        }
        ctx.flow.diverged = true;
        return;

      case "BreakStmt": case "ContinueStmt":
        ctx.flow.diverged = true;
        return;

      case "IfStmt": {
        this.useExpr(s.cond, state, ctx, false);
        const results = [this.branch(s.then, state, ctx)];
        for (const e of s.elifs) {
          this.useExpr(e.cond, state, ctx, false);
          results.push(this.branch(e.block, state, ctx));
        }
        if (s.else) results.push(this.branch(s.else, state, ctx));

        for (const r of results) if (!r.diverged) mergeState(state, r.state);
        // Every arm left the block, and there was an `else`, so nothing follows.
        if (s.else && results.every((r) => r.diverged)) ctx.flow.diverged = true;
        return;
      }

      case "MatchStmt": {
        this.useExpr(s.expr.subject, state, ctx, false);
        const results: { state: State; diverged: boolean }[] = [];
        for (const arm of s.expr.arms) {
          const entry = cloneState(state);
          for (const n of patternNames(arm.pattern)) {
            entry.set(n, { name: n, kind: "unknown", shared: 0, declaredAt: arm.span, isParam: false });
          }
          results.push(this.branch(arm.body, entry, ctx));
        }
        if (s.expr.elseArm) results.push(this.branch(s.expr.elseArm, state, ctx));
        for (const r of results) if (!r.diverged) mergeState(state, r.state);
        return;
      }

      case "ForStmt": {
        this.useExpr(s.iter, state, ctx, false);
        const inner = cloneState(state);
        for (const n of patternNames(s.pattern)) {
          inner.set(n, { name: n, kind: "unknown", shared: 0, declaredAt: s.span, isParam: false });
        }
        this.walkBlock(s.body, inner, { ...ctx, inLoop: true, flow: { diverged: false } });
        // Anything moved inside the body would be moved again next iteration.
        this.reportLoopMoves(state, inner);
        mergeState(state, inner);
        return;
      }

      case "WhileStmt": {
        this.useExpr(s.cond, state, ctx, false);
        const inner = cloneState(state);
        this.walkBlock(s.body, inner, { ...ctx, inLoop: true, flow: { diverged: false } });
        this.reportLoopMoves(state, inner);
        mergeState(state, inner);
        return;
      }

      case "WithStmt":
        if (!s.capability) this.useExpr(s.subject, state, ctx, false);
        this.walkBlock(s.body, state, ctx);
        return;

      case "ParallelStmt": {
        // Branches run concurrently, so a value moved by one is not available
        // to another; analyse them from the same entry state and merge.
        const branches: State[] = [];
        for (const st of s.body.stmts) {
          const b = cloneState(state);
          this.walkStmt(st, b, { ...ctx, flow: { diverged: false } });
          branches.push(b);
        }
        for (const b of branches) mergeState(state, b);
        return;
      }

      case "UnsafeStmt": case "GenerateDecl":
        this.walkBlock(s.body, state, ctx);
        return;

      case "DeferStmt": this.walkStmt(s.stmt, state, ctx); return;

      case "IntrinsicStmt": {
        this.useExpr(s.target, state, ctx, false);
        if (s.value) {
          // `send ch : v` hands the value to another task (M5).
          this.useExpr(s.value, state, ctx, s.op === "send");
          if (s.op === "send" && this.kindOf(s.value) === "borrow") {
            this.err("E0512", "a channel cannot carry a borrow — the receiver may outlive it", s.value.span, {
              help: "send the value itself (`send ch : move x`), or a `shared(T)`",
            });
          }
        }
        return;
      }

      case "FnDecl":
        // A nested declaration is checked on its own.
        return;

      default: return;
    }
  }

  private reportLoopMoves(before: State, after: State): void {
    for (const [name, v] of after) {
      const b = before.get(name);
      if (!b || b.movedAt || !v.movedAt) continue;
      if (v.kind !== "owned") continue;
      this.err("E0504", `\`${name}\` is moved inside a loop, so the second iteration would use a moved value`, v.movedAt, {
        help: "move it before the loop, copy it inside, or use `shared(T)` if it really has several owners",
        notes: [{ message: `\`${name}\` is declared here`, span: b.declaredAt }],
      });
      // Report once.
      b.movedAt = v.movedAt;
      b.movedWhy = v.movedWhy;
    }
  }

  // ---- expressions ---------------------------------------------------------

  /**
   * Walk an expression. `consuming` is true when the surrounding context takes
   * ownership of the result (a binding, a `give`, storing into a container).
   */
  private useExpr(e: A.Expr, state: State, ctx: Ctx, consuming: boolean): void {
    switch (e.kind) {
      case "Ident": {
        const v = state.get(e.name);
        if (!v) return;
        if (v.movedAt) {
          this.err("E0504", `\`${e.name}\` was moved and can no longer be used`, e.span, {
            help: v.kind === "owned"
              ? "a value has one owner; copy it before the move, or use `shared(T)` if it needs several"
              : undefined,
            notes: [{ message: v.movedWhy ?? "moved here", span: v.movedAt }],
          });
          return;
        }
        if (consuming && v.kind === "owned") {
          if (v.exclusive || v.shared > 0) {
            this.err("E0508", `\`${e.name}\` cannot be moved while it is borrowed`, e.span, {
              notes: [{ message: "the borrow is still live here", span: v.exclusive ?? e.span }],
            });
            return;
          }
          v.movedAt = e.span;
          v.movedWhy = "moved here";
        }
        return;
      }

      case "MoveExpr": {
        if (e.expr.kind === "Ident") {
          const v = state.get(e.expr.name);
          if (v?.movedAt) {
            this.err("E0504", `\`${e.expr.name}\` was already moved`, e.span, {
              notes: [{ message: v.movedWhy ?? "moved here", span: v.movedAt }],
            });
            return;
          }
          if (v) { v.movedAt = e.span; v.movedWhy = "moved here by `move`"; }
          return;
        }
        this.useExpr(e.expr, state, ctx, true);
        return;
      }

      case "BorrowExpr": case "RefExpr": {
        const target = rootName(e.expr);
        this.useExpr(e.expr, state, ctx, false);
        if (!target) return;
        const v = state.get(target);
        if (!v) return;
        if (v.movedAt) {
          this.err("E0504", `\`${target}\` was moved and can no longer be borrowed`, e.span, {
            notes: [{ message: v.movedWhy ?? "moved here", span: v.movedAt }],
          });
          return;
        }
        // M2.1 — one exclusive borrow, or any number of shared ones.
        if (e.mut) {
          if (v.exclusive) {
            this.err("E0511", `\`${target}\` is already borrowed mutably`, e.span, {
              notes: [{ message: "the first `borrow mut` is here", span: v.exclusive }],
            });
            return;
          }
          if (v.shared > 0) {
            this.err("E0511", `\`${target}\` cannot be borrowed mutably while it is borrowed`, e.span, {
              help: "end the shared borrow first — a borrow lasts to the end of its block",
            });
            return;
          }
          v.exclusive = e.span;
          ctx.opened?.push({ target, exclusive: true });
        } else {
          if (v.exclusive) {
            this.err("E0511", `\`${target}\` cannot be borrowed while it is borrowed mutably`, e.span, {
              notes: [{ message: "the `borrow mut` is here", span: v.exclusive }],
            });
            return;
          }
          v.shared++;
          ctx.opened?.push({ target, exclusive: false });
        }
        return;
      }

      case "StartExpr": {
        // M5 — a task outlives the block that spawned it, so it may not
        // capture a borrow. Arguments are moved in.
        const call = e.call;
        if (call.kind === "CallExpr") {
          this.useExpr(call.callee, state, ctx, false);
          for (const a of call.args) {
            if (this.kindOf(a.value) === "borrow") {
              this.err("E0512", "a task cannot capture a borrow — it may outlive the value", a.value.span, {
                help: "pass the value itself, or a `shared(T)` if several owners are needed",
              });
            }
            this.useExpr(a.value, state, ctx, true);
          }
          return;
        }
        this.useExpr(call, state, ctx, true);
        return;
      }

      case "CallExpr": {
        if (e.callee.kind !== "Ident") this.useExpr(e.callee, state, ctx, false);
        const target = this.calleeName(e);
        const flags = target ? this.owning.get(target) : undefined;
        const keeps = e.callee.kind === "MemberExpr" && KEEPING_METHODS.has(e.callee.name);

        // M2.1 within one call: `f(borrow mut a, a)` is a conflict.
        this.checkArgumentAliasing(e, state);

        e.args.forEach((a, i) => {
          const owns = keeps || !!flags?.[i];
          if (owns && this.kindOf(a.value) === "borrow") {
            this.escapes(a.value, keeps ? "stored" : "kept by the callee", a.value.span);
          }
          this.useExpr(a.value, state, ctx, owns);
          if (owns && a.value.kind === "Ident") {
            const v = state.get(a.value.name);
            if (v?.movedAt === a.value.span) {
              v.movedWhy = keeps
                ? `moved here, because \`${(e.callee as A.MemberExpr).name}\` keeps its argument`
                : `moved here, because \`${target}\` keeps its argument`;
            }
          }
        });
        return;
      }

      case "ListExpr": case "SetExpr": case "TupleExpr":
        for (const el of e.elements) {
          if (this.kindOf(el) === "borrow") this.escapes(el, "stored", el.span);
          this.useExpr(el, state, ctx, true);
        }
        return;

      case "MapExpr":
        for (const en of e.entries) {
          this.useExpr(en.key, state, ctx, true);
          if (this.kindOf(en.value) === "borrow") this.escapes(en.value, "stored", en.value.span);
          this.useExpr(en.value, state, ctx, true);
        }
        return;

      case "RecordExpr":
        for (const en of e.entries) this.useExpr(en.value, state, ctx, true);
        return;

      case "DerefExpr":
        this.useExpr(e.expr, state, ctx, false);
        return;

      case "MatchExpr": {
        this.useExpr(e.subject, state, ctx, false);
        for (const arm of e.arms) {
          const entry = cloneState(state);
          for (const n of patternNames(arm.pattern)) {
            entry.set(n, { name: n, kind: "unknown", shared: 0, declaredAt: arm.span, isParam: false });
          }
          const r = this.branch(arm.body, entry, ctx);
          if (!r.diverged) mergeState(state, r.state);
        }
        if (e.elseArm) {
          const r = this.branch(e.elseArm, state, ctx);
          if (!r.diverged) mergeState(state, r.state);
        }
        return;
      }

      case "StrLit":
        for (const p of e.parts) if (p.kind === "expr" && p.expr) this.useExpr(p.expr, state, ctx, false);
        return;

      default:
        for (const c of exprChildren(e)) this.useExpr(c, state, ctx, false);
        return;
    }
  }

  /** M2.1 inside a single call's argument list. */
  private checkArgumentAliasing(e: A.CallExpr, state: State): void {
    const mut = new Map<string, Span>();
    const shared = new Map<string, Span>();
    for (const a of e.args) {
      const v = a.value;
      if (v.kind !== "BorrowExpr" && v.kind !== "RefExpr") continue;
      const root = rootName(v.expr);
      if (!root) continue;
      if (v.mut) mut.set(root, v.span);
      else shared.set(root, v.span);
    }
    for (const [name, span] of mut) {
      if (shared.has(name)) {
        this.err("E0511", `\`${name}\` is borrowed both mutably and shared in the same call`, span, {
          notes: [{ message: "the shared borrow is here", span: shared.get(name)! }],
        });
      }
    }
    void state;
  }

  /** Assigning through a shared borrow (M2.1 / E0509). */
  private checkMutationTarget(target: A.Expr, state: State, ctx: Ctx): void {
    if (target.kind === "DerefExpr") {
      const t = this.ty(target.expr);
      const p = t ? prune(t) : undefined;
      if (p?.k === "ref" && !p.mut) {
        this.err("E0509", "cannot assign through a shared borrow", target.span, {
          help: "take it with `borrow mut` (or `&mut`) if you need to change it",
        });
      }
      return;
    }
    const root = rootName(target);
    if (!root) return;
    const v = state.get(root);
    if (v?.exclusive === undefined && v && v.shared > 0) {
      this.err("E0509", `\`${root}\` cannot be changed while it is borrowed`, target.span, {
        help: "a borrow lasts to the end of its block; end it before mutating",
      });
    }
    void ctx;
  }

  private escapes(e: A.Expr, how: string, span: Span): void {
    this.err("E0510", `a borrow cannot be ${how} — it would outlive the block that created it`, span, {
      help: "return or store the value itself, an index into it, or a `shared(T)`",
    });
    void e;
  }
}

interface Ctx {
  inLoop: boolean;
  fnName: string;
  opened?: { target: string; exclusive: boolean }[];
  /**
   * Set once this path has left the block via `give`, `break` or `continue`.
   * A diverged branch must not be merged back: whatever it moved is
   * unreachable from the code that follows.
   */
  flow: { diverged: boolean };
}

/** The memory-model rule each diagnostic comes from. */
const RULE_OF: Record<string, string> = {
  E0504: "M1 — every value has one owner",
  E0508: "M1 — a value cannot move while it is borrowed",
  E0509: "M2.1 — no mutation through a shared borrow",
  E0510: "M2.3 — a borrow cannot leave its block",
  E0511: "M2.1 — one `borrow mut`, or many `borrow`, never both",
  E0512: "M5 — a task cannot capture a borrow",
};

/** Container methods that keep the value they are given. */
const KEEPING_METHODS = new Set(["push", "insert", "add", "extend"]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rootName(e: A.Expr): string | null {
  let cur: A.Expr = e;
  for (;;) {
    if (cur.kind === "Ident") return cur.name;
    if (cur.kind === "MemberExpr") { cur = cur.obj; continue; }
    if (cur.kind === "IndexExpr") { cur = cur.obj; continue; }
    if (cur.kind === "SliceExpr") { cur = cur.obj; continue; }
    if (cur.kind === "DerefExpr") { cur = cur.expr; continue; }
    return null;
  }
}

function patternNames(p: A.Pattern): string[] {
  switch (p.kind) {
    case "BindPat": case "TypePat": return [p.name];
    case "RestPat": return p.name ? [p.name] : [];
    case "TuplePat": case "ListPat": return p.elements.flatMap(patternNames);
    case "StructPat": return p.fields.flatMap((f) => patternNames(f.pattern));
    case "VariantPat": return p.args.flatMap(patternNames);
    case "MapPat": return p.entries.flatMap((e) => patternNames(e.value));
    default: return [];
  }
}

function exprChildren(e: A.Expr): A.Expr[] {
  const out: A.Expr[] = [];
  for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "type" || k === "typeArgs") continue;
    const push = (x: unknown) => {
      if (x && typeof x === "object" && typeof (x as { kind?: unknown }).kind === "string" && "span" in (x as object)) {
        const kind = (x as { kind: string }).kind;
        if (!kind.endsWith("Pat") && !kind.endsWith("Type") && kind !== "Block") out.push(x as A.Expr);
      }
    };
    if (Array.isArray(v)) for (const x of v) { push(x); if (x && typeof x === "object" && "value" in (x as object)) push((x as { value: unknown }).value); }
    else push(v);
  }
  return out;
}

export function checkOwnership(mod: A.Module, types: TypeMap, structFields: Map<string, Ty[]>): OwnershipResult {
  return new OwnershipChecker(types, structFields).run(mod);
}

export { classify as classifyOwnership };
export type { Kind as OwnershipKind };
export { show };
