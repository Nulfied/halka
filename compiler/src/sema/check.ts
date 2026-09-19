// Static checks that run before execution.
//
// This is the "no major loophole" pass: it catches the mistakes the locked
// rules make impossible (#21 overloading, #23 exceptions, #9 give placement,
// #8 break/continue placement, R3.1 naming) plus undefined names and obvious
// arity errors, all with spans and rule citations.
//
// It is deliberately conservative: anything it cannot prove wrong, it allows.

import type * as A from "../parser/ast.ts";
import { DiagnosticBag, type Span } from "../util/diagnostics.ts";
import { isTypeName } from "../parser/parser.ts";
import { PRELUDE_NAMES, PRELUDE_ARITY } from "./prelude-names.ts";

interface FnSig { name: string; min: number; max: number; span: Span }

class Scope {
  names = new Set<string>();
  parent: Scope | null;
  constructor(parent: Scope | null) { this.parent = parent; }
  has(n: string): boolean {
    let s: Scope | null = this;
    while (s) { if (s.names.has(n)) return true; s = s.parent; }
    return false;
  }
  add(n: string): void { this.names.add(n); }
  child(): Scope { return new Scope(this); }
}

class Checker {
  diags = new DiagnosticBag();
  private fns = new Map<string, FnSig>();
  private types = new Set<string>();
  private variants = new Set<string>();
  private traits = new Set<string>();
  private caps = new Set<string>();
  private macros = new Set<string>();
  private structFields = new Map<string, string[]>();
  private modules = new Set<string>();
  private fnDepth = 0;
  private loopDepth = 0;

  check(main: A.Module, deps: A.Module[]): DiagnosticBag {
    const global = new Scope(null);
    for (const n of PRELUDE_NAMES) global.add(n);
    for (const m of deps) this.collect(m.stmts, global, true);
    this.collect(main.stmts, global, false);
    this.walkStmts(main.stmts, global);
    return this.diags;
  }

  /** Pass 1: record every declaration so order does not matter. */
  private collect(stmts: A.Stmt[], scope: Scope, imported: boolean): void {
    const seen = new Map<string, Span>();
    const once = (name: string, span: Span, what: string) => {
      const prev = seen.get(name);
      if (prev && !imported) {
        this.diags.error("E0302", `\`${name}\` is already defined in this module`, span, {
          rule: "#21 — Function overloading",
          help: "Halka gives each name one definition; use a generic (`f<T>(...)`) or a different name",
          notes: [{ message: "first defined here", span: prev }],
        });
      }
      seen.set(name, span);
      scope.add(name);
      void what;
    };

    for (const s of stmts) {
      switch (s.kind) {
        case "FnDecl":
          if (s.isMacro) { this.macros.add(s.name); scope.add(s.name); break; }
          if (s.foreign) { scope.add(s.name); break; }
          once(s.name, s.span, "function");
          this.fns.set(s.name, {
            name: s.name,
            min: s.params.filter((p) => !p.default && !p.variadic).length,
            max: s.params.some((p) => p.variadic) ? Infinity : s.params.length,
            span: s.span,
          });
          break;
        case "StructDecl":
          if (!s.foreign) once(s.name, s.span, "type");
          this.types.add(s.name);
          this.structFields.set(s.name, s.fields.map((f) => f.name));
          scope.add(s.name);
          break;
        case "EnumDecl":
          once(s.name, s.span, "type");
          this.types.add(s.name);
          for (const v of s.variants) { this.variants.add(v.name); scope.add(v.name); }
          break;
        case "TraitDecl":
          this.traits.add(s.name);
          scope.add(s.name);
          for (const m of s.members) this.types.add(m.name);
          break;
        case "TypeAliasDecl":
          this.types.add(s.name);
          scope.add(s.name);
          break;
        case "CapabilityDecl":
          this.caps.add(s.name);
          scope.add(s.name);
          break;
        case "ConstDecl":
          once(s.name, s.span, "constant");
          break;
        case "LetStmt":
          this.declarePattern(s.pattern, scope);
          break;
        case "ImportDecl":
          if (s.form === "module") { scope.add(s.alias ?? baseName(s.path)); this.modules.add(s.alias ?? baseName(s.path)); }
          else for (const n of s.names) scope.add(n.alias ?? n.name);
          break;
        case "GenerateDecl":
          this.collect(s.body.stmts, scope, imported);
          break;
        case "AssignStmt":
          // A top-level `name:` block introduces a name (R3).
          if (s.target.kind === "Ident") scope.add(s.target.name);
          break;
        default:
          break;
      }
    }
  }

  private declarePattern(p: A.Pattern, scope: Scope): void {
    switch (p.kind) {
      case "BindPat": case "TypePat": scope.add(p.name); return;
      case "RestPat": if (p.name) scope.add(p.name); return;
      case "TuplePat": case "ListPat": for (const e of p.elements) this.declarePattern(e, scope); return;
      case "StructPat": for (const f of p.fields) this.declarePattern(f.pattern, scope); return;
      case "VariantPat": for (const a of p.args) this.declarePattern(a, scope); return;
      case "MapPat": for (const e of p.entries) this.declarePattern(e.value, scope); return;
      default: return;
    }
  }

  // ---- pass 2: walk ----------------------------------------------------

  private walkStmts(stmts: A.Stmt[], scope: Scope): void {
    for (const s of stmts) this.walkStmt(s, scope);
  }

  private walkBlock(b: A.Block, scope: Scope): void {
    const inner = scope.child();
    this.collect(b.stmts, inner, false);
    this.walkStmts(b.stmts, inner);
  }

  private walkStmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case "FnDecl": {
        if (!isValueName(s.name) && !s.isMacro) {
          this.diags.warn("W1001", `function names are lower_snake_case in canonical Halka; \`${s.name}\` is not`, s.span, {
            rule: "R3.1 / #53 — Canonical style",
          });
        }
        if (!s.body) return;
        const inner = scope.child();
        for (const g of s.generics) { inner.add(g.name); this.types.add(g.name); }
        let sawDefault = false;
        for (const p of s.params) {
          if (p.default) sawDefault = true;
          else if (sawDefault && !p.variadic) {
            this.diags.error("E0419", `required parameter \`${p.name}\` cannot follow a parameter with a default`, p.span, {
              rule: "#18 — Default parameters",
              help: "put required parameters first",
            });
          }
          if (p.variadic && p.default) {
            this.diags.error("E0420", "a variadic parameter cannot have a default", p.span, { rule: "#19 — Variadic parameters" });
          }
          inner.add(p.name === "..." ? "_varargs" : p.name);
          if (p.default) this.walkExpr(p.default, inner);
        }
        if (s.params.findIndex((p) => p.variadic) !== -1 && s.params.findIndex((p) => p.variadic) !== s.params.length - 1) {
          this.diags.error("E0421", "a variadic parameter must come last", s.span, { rule: "#19 — Variadic parameters" });
        }
        inner.add("self");
        this.fnDepth++;
        const savedLoop = this.loopDepth;
        this.loopDepth = 0;
        this.walkBlock(s.body, inner);
        this.loopDepth = savedLoop;
        this.fnDepth--;
        return;
      }

      case "StructDecl": {
        if (!isTypeName(s.name)) {
          this.diags.error("E0107", `\`${s.name}\` declares a type, so it must be UpperCamelCase`, s.span, {
            rule: "R3.1",
            help: `rename it to \`${toUpperCamel(s.name)}\``,
          });
        }
        const names = new Set<string>();
        for (const f of s.fields) {
          if (names.has(f.name)) {
            this.diags.error("E0422", `duplicate field \`${f.name}\``, f.span);
          }
          names.add(f.name);
          if (f.default) this.walkExpr(f.default, scope);
        }
        return;
      }

      case "EnumDecl": {
        if (!isTypeName(s.name)) {
          this.diags.error("E0107", `\`${s.name}\` declares a type, so it must be UpperCamelCase`, s.span, { rule: "R3.1" });
        }
        return;
      }

      case "TraitDecl":
        for (const m of s.members) if (m.body) this.walkStmt(m, scope);
        return;

      case "ImplDecl": {
        if (!this.types.has(s.typeName)) {
          this.diags.error("E0204", `\`${s.typeName}\` is not a type declared in this module`, s.span, {
            rule: "#16 — Interfaces beyond traits",
          });
        }
        for (const t of s.traits) {
          if (!this.traits.has(t)) {
            this.diags.error("E0205", `\`${t}\` is not a trait`, s.span, {
              rule: "#16 — Interfaces beyond traits",
              help: "declare it with `trait Name:` first",
            });
          }
        }
        const inner = scope.child();
        inner.add("self");
        // A method body may name the receiver's fields directly (#16).
        for (const f of this.structFields.get(s.typeName) ?? []) inner.add(f);
        for (const m of s.members) this.walkStmt(m, inner);
        return;
      }

      case "LetStmt": {
        if (s.value) this.walkExpr(s.value, scope);
        if (s.isConst && !s.value) {
          this.diags.error("E0104", "a `const` must have a value", s.span);
        }
        this.declarePattern(s.pattern, scope);
        if (s.pattern.kind === "BindPat" && isTypeName(s.pattern.name)) {
          this.diags.warn("W1002", `\`${s.pattern.name}\` looks like a type name; values are lower_snake_case`, s.span, { rule: "R3.1" });
        }
        return;
      }

      case "ConstDecl":
        this.walkExpr(s.value, scope);
        scope.add(s.name);
        return;

      case "AssignStmt":
        this.walkExpr(s.value, scope);
        if (s.target.kind === "Ident") scope.add(s.target.name);
        else this.walkExpr(s.target, scope);
        return;

      case "ExprStmt": this.walkExpr(s.expr, scope); return;
      case "SayStmt": for (const a of s.args) this.walkExpr(a, scope); return;

      case "GiveStmt":
        if (this.fnDepth === 0) {
          this.diags.error("E0130", "`give` is only valid inside a function", s.span, {
            rule: "#9 — Early give",
            help: "at the top level, just evaluate the expression",
          });
        }
        if (s.value) this.walkExpr(s.value, scope);
        return;

      case "BreakStmt": case "ContinueStmt":
        if (this.loopDepth === 0) {
          this.diags.error("E0131", `\`${s.kind === "BreakStmt" ? "break" : "continue"}\` is only valid inside a loop`, s.span, {
            rule: "#8 — break / continue",
          });
        }
        return;

      case "IfStmt":
        this.walkExpr(s.cond, scope);
        this.walkBlock(s.then, scope);
        for (const e of s.elifs) { this.walkExpr(e.cond, scope); this.walkBlock(e.block, scope); }
        if (s.else) this.walkBlock(s.else, scope);
        return;

      case "ForStmt": {
        this.walkExpr(s.iter, scope);
        const inner = scope.child();
        this.declarePattern(s.pattern, inner);
        this.loopDepth++;
        this.walkBlock(s.body, inner);
        this.loopDepth--;
        return;
      }

      case "WhileStmt":
        this.walkExpr(s.cond, scope);
        this.loopDepth++;
        this.walkBlock(s.body, scope);
        this.loopDepth--;
        return;

      case "MatchStmt": this.walkExpr(s.expr, scope); return;

      case "DeferStmt":
        if (this.fnDepth === 0) {
          this.diags.warn("W1003", "`defer` at the top level runs when the program ends", s.span, { rule: "#24 — defer / cleanup" });
        }
        this.walkStmt(s.stmt, scope);
        return;

      case "WithStmt":
        if (!s.capability) this.walkExpr(s.subject, scope);
        else if (s.subject.kind === "Ident" && !this.caps.has(s.subject.name)) {
          this.diags.error("E0507", `\`${s.subject.name}\` is not a declared capability`, s.subject.span, {
            rule: "#45 — Capability / security syntax",
            help: "declare it with `capability Name:`",
          });
        }
        this.walkBlock(s.body, scope);
        return;

      case "ParallelStmt": this.walkBlock(s.body, scope); return;
      case "UnsafeStmt": this.walkBlock(s.body, scope); return;
      case "GenerateDecl": this.walkBlock(s.body, scope); return;

      case "IntrinsicStmt":
        this.walkExpr(s.target, scope);
        if (s.value) this.walkExpr(s.value, scope);
        return;

      case "SpecializeDecl":
        for (const it of s.items) {
          if (!this.fns.has(it.name)) {
            this.diags.error("E0206", `\`${it.name}\` is not a function in this module`, it.span, { rule: "#43 — Specialization" });
          }
        }
        return;

      case "ExportDecl":
        for (const n of s.names) {
          if (!scope.has(n)) {
            this.diags.error("E0207", `\`${n}\` is exported but not defined`, s.span, { rule: "#33 — Import / export details" });
          }
        }
        return;

      default:
        return;
    }
  }

  private walkExpr(e: A.Expr, scope: Scope): void {
    switch (e.kind) {
      case "Ident": {
        if (scope.has(e.name)) return;
        if (this.types.has(e.name) || this.variants.has(e.name) || this.caps.has(e.name) || this.macros.has(e.name)) return;
        this.diags.error("E0203", `\`${e.name}\` is not defined`, e.span, {
          help: suggest(e.name, scope),
        });
        return;
      }

      case "CallExpr": {
        if (e.callee.kind === "Ident") {
          const sig = this.fns.get(e.callee.name);
          const positional = e.args.filter((a) => !a.name && a.value.kind !== "EllipsisExpr").length;
          const hasElision = e.args.some((a) => a.value.kind === "EllipsisExpr");
          if (sig && !hasElision && !e.args.some((a) => a.name)) {
            if (positional < sig.min || positional > sig.max) {
              this.diags.error("E0404", `\`${sig.name}\` takes ${arity(sig.min, sig.max)}, but ${positional} were given`, e.span, {
                notes: [{ message: "defined here", span: sig.span }],
              });
            }
          }
          const pre = PRELUDE_ARITY[e.callee.name];
          if (pre && !hasElision && (positional < pre[0] || positional > pre[1])) {
            this.diags.error("E0404", `\`${e.callee.name}\` takes ${arity(pre[0], pre[1])}, but ${positional} were given`, e.span);
          }
          if (!scope.has(e.callee.name) && !this.types.has(e.callee.name) && !this.variants.has(e.callee.name) && !this.macros.has(e.callee.name)) {
            this.diags.error("E0203", `\`${e.callee.name}\` is not defined`, e.callee.span, { help: suggest(e.callee.name, scope) });
          }
        } else {
          this.walkExpr(e.callee, scope);
        }
        for (const a of e.args) this.walkExpr(a.value, scope);
        return;
      }

      case "MemberExpr": this.walkExpr(e.obj, scope); return;
      case "IndexExpr": this.walkExpr(e.obj, scope); this.walkExpr(e.index, scope); return;
      case "SliceExpr":
        this.walkExpr(e.obj, scope);
        if (e.start) this.walkExpr(e.start, scope);
        if (e.end) this.walkExpr(e.end, scope);
        if (e.step) this.walkExpr(e.step, scope);
        return;

      case "MatchExpr": {
        this.walkExpr(e.subject, scope);
        for (const arm of e.arms) {
          const inner = scope.child();
          this.declarePattern(arm.pattern, inner);
          if (arm.guard) this.walkExpr(arm.guard, inner);
          this.walkBlock(arm.body, inner);
        }
        if (e.elseArm) this.walkBlock(e.elseArm, scope);
        return;
      }

      case "StrLit":
        for (const p of e.parts) if (p.kind === "expr" && p.expr) this.walkExpr(p.expr, scope);
        return;

      case "RecordExpr": for (const en of e.entries) this.walkExpr(en.value, scope); return;
      case "MapExpr": for (const en of e.entries) { this.walkExpr(en.key, scope); this.walkExpr(en.value, scope); } return;
      case "BlockExpr": this.walkBlock(e.block, scope); return;

      case "AcquireExpr":
        if (!this.caps.has(e.capability)) {
          this.diags.error("E0507", `\`${e.capability}\` is not a declared capability`, e.span, {
            rule: "#45 — Capability / security syntax",
            help: "declare it with `capability Name:`",
          });
        }
        return;

      case "IsExpr": this.walkExpr(e.expr, scope); return;
      case "ForeignExpr": return; // the FFI layer validates its own boundary

      default: {
        // Generic recursion over child expressions.
        for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
          if (k === "span" || k === "kind" || k === "type") continue;
          if (Array.isArray(v)) { for (const x of v) if (isExpr(x)) this.walkExpr(x as A.Expr, scope); }
          else if (isExpr(v)) this.walkExpr(v as A.Expr, scope);
        }
        return;
      }
    }
  }
}

function isExpr(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && "span" in (v as object)
    && !(v as { kind: string }).kind.endsWith("Pat")
    && !(v as { kind: string }).kind.endsWith("Type")
    && (v as { kind: string }).kind !== "Block";
}

function arity(min: number, max: number): string {
  if (min === max) return `${min} argument${min === 1 ? "" : "s"}`;
  if (max === Infinity) return `at least ${min} argument${min === 1 ? "" : "s"}`;
  return `${min}–${max} arguments`;
}

function isValueName(s: string): boolean { return !/^[A-Z]/.test(s); }

function toUpperCamel(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_m, _a, c: string) => c.toUpperCase());
}

function baseName(path: string): string {
  const parts = path.replace(/^"|"$/g, "").split(/[./\\]/);
  return parts[parts.length - 1] ?? path;
}

function suggest(name: string, scope: Scope): string | undefined {
  const names: string[] = [];
  let s: Scope | null = scope;
  while (s) { names.push(...s.names); s = s.parent; }
  let best: string | null = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = dist(name, n);
    if (d < bestD && d <= Math.max(1, Math.floor(name.length / 3))) { bestD = d; best = n; }
  }
  return best ? `did you mean \`${best}\`?` : undefined;
}

function dist(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

export function check(main: A.Module, deps: A.Module[] = []): DiagnosticBag {
  return new Checker().check(main, deps);
}
