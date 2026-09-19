// Static type inference for Halka (#11, #13).
//
// Walks the canonical AST, assigns a type to every expression, and records it
// in a TypeMap the native backend consumes. Annotations are optional wherever
// inference is unambiguous, which is what rule #11 promises.
//
// The pass is *gradual by construction*: anything it cannot model yet becomes
// `any`, which unifies with everything. That keeps false positives near zero
// while the checker matures. `halka check --explain` lists every `any` that
// survived, because each one is a value the backend must box.

import type * as A from "../parser/ast.ts";
import { DiagnosticBag, type Span } from "../util/diagnostics.ts";
import {
  type Ty, type FnT, type FnParam,
  INT, FLOAT, BOOL, STRING, CHAR, BYTE, NOTHING, NULL, NEVER,
  any, opt, list, arr, map, set, tup, named, fn, param, fresh,
  prune, unify, tryUnify, instantiate, show, isNumeric, UnifyError, resultOf, cty,
} from "./types.ts";

export type TypeMap = Map<A.Node, Ty>;

interface StructInfo { decl: A.StructDecl; fields: Map<string, Ty>; order: string[] }
interface EnumInfo { decl: A.EnumDecl; variants: Map<string, { fields: Ty[]; names: string[] }>; generics: string[] }

class Scope {
  vars = new Map<string, Ty>();
  parent: Scope | null;
  constructor(parent: Scope | null) { this.parent = parent; }
  get(n: string): Ty | undefined {
    let s: Scope | null = this;
    while (s) { const t = s.vars.get(n); if (t) return t; s = s.parent; }
    return undefined;
  }
  set(n: string, t: Ty): void { this.vars.set(n, t); }
  child(): Scope { return new Scope(this); }
}

export interface ForeignImport { lang: "c" | "cpp" | "py"; path: string; names: string[] }

export interface InferResult {
  types: TypeMap;
  diags: DiagnosticBag;
  /** Expressions that stayed `any`, for `--explain`. */
  unknowns: { span: Span; why: string }[];
  /** `import c "stdio.h"` / `import py "numpy"` (#35-#37). */
  foreignImports: ForeignImport[];
  /** Struct name -> field types, in declaration order. Used by the ownership pass. */
  structFields: Map<string, Ty[]>;
}

export class Inferencer {
  readonly diags = new DiagnosticBag();
  readonly types: TypeMap = new Map();
  readonly unknowns: { span: Span; why: string }[] = [];

  private structs = new Map<string, StructInfo>();
  private enums = new Map<string, EnumInfo>();
  private traits = new Map<string, A.TraitDecl>();
  private aliases = new Map<string, Ty>();
  private impls = new Map<string, Map<string, FnT>>();
  private fns = new Map<string, FnT>();
  private generics = new Set<string>();
  /** `c printf(...)`-style declarations, keyed "lang name" (#35-#37). */
  private foreignFns = new Map<string, FnT>();
  /** `c struct Point:` declarations, keyed "lang Name". */
  private foreignTypes = new Set<string>();
  /** Modules brought in by `import c "stdio.h"` / `import py "numpy"`. */
  readonly foreignImports: { lang: "c" | "cpp" | "py"; path: string; names: string[] }[] = [];
  /** Return type of the function currently being checked, for `give`. */
  private retStack: Ty[] = [];

  // -------------------------------------------------------------------------

  run(mod: A.Module): InferResult {
    const global = new Scope(null);
    for (const [n, t] of PRELUDE) global.set(n, t);

    this.collectTypes(mod.stmts);
    this.collectSignatures(mod.stmts, global);
    this.checkStmts(mod.stmts, global);

    const structFields = new Map<string, Ty[]>();
    for (const [name, info] of this.structs) structFields.set(name, info.order.map((f) => info.fields.get(f)!));
    return {
      types: this.types,
      diags: this.diags,
      unknowns: this.unknowns,
      foreignImports: this.foreignImports,
      structFields,
    };
  }

  private err(code: string, msg: string, span: Span, extra?: Record<string, unknown>): void {
    this.diags.error(code, msg, span, extra as never);
  }

  private note(e: A.Node, t: Ty): Ty {
    this.types.set(e, t);
    return t;
  }

  private expect(actual: Ty, want: Ty, span: Span, what: string): void {
    try {
      unify(want, actual);
    } catch (e) {
      if (e instanceof UnifyError) {
        this.err("E0450", `${what}: expected ${show(e.expected)}, found ${show(e.actual)}`, span, {
          help: e.detail || undefined,
        });
      } else throw e;
    }
  }

  // ---- pass 1: type declarations -----------------------------------------

  private collectTypes(stmts: A.Stmt[]): void {
    // Register names first so declarations can refer to each other.
    for (const s of stmts) {
      if (s.kind === "StructDecl") this.structs.set(s.name, { decl: s, fields: new Map(), order: [] });
      else if (s.kind === "EnumDecl") this.enums.set(s.name, { decl: s, variants: new Map(), generics: s.generics.map((g) => g.name) });
      else if (s.kind === "TraitDecl") this.traits.set(s.name, s);
      else if (s.kind === "GenerateDecl") this.collectTypes(s.body.stmts);
    }
    // Result<T> is built in (#22).
    if (!this.enums.has("Result")) {
      this.enums.set("Result", {
        decl: null as unknown as A.EnumDecl,
        generics: ["T"],
        variants: new Map([
          ["Ok", { fields: [named("T")], names: ["value"] }],
          ["Error", { fields: [STRING], names: ["message"] }],
          ["Cancelled", { fields: [], names: [] }],
        ]),
      });
    }

    for (const s of stmts) {
      if (s.kind === "TypeAliasDecl") this.aliases.set(s.name, this.toTy(s.type));
    }
    for (const s of stmts) {
      if (s.kind === "StructDecl") {
        const info = this.structs.get(s.name)!;
        for (const f of s.fields) {
          const t = f.type ? this.toTy(f.type) : fresh(`${s.name}.${f.name}`);
          info.fields.set(f.name, t);
          info.order.push(f.name);
        }
      } else if (s.kind === "EnumDecl") {
        const info = this.enums.get(s.name)!;
        const gs = new Set(s.generics.map((g) => g.name));
        for (const g of gs) this.generics.add(g);
        for (const v of s.variants) {
          info.variants.set(v.name, {
            fields: v.fields.map((f) =>
              f.type ? this.toTy(f.type)
                // An untyped payload is generic only when the enum is.
                : s.generics.length ? named(s.generics[0]!.name)
                : fresh(`${s.name}.${v.name}.${f.name}`)),
            names: v.fields.map((f) => f.name),
          });
        }
      } else if (s.kind === "GenerateDecl") {
        this.collectTypes(s.body.stmts);
      }
    }
  }

  // ---- pass 2: function signatures ---------------------------------------

  private collectSignatures(stmts: A.Stmt[], scope: Scope): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "FnDecl": {
          if (s.foreign) {
            // A foreign declaration types the Halka side of the boundary; the
            // foreign side comes from its own header (#35).
            const fsig = this.signatureOf(s);
            this.foreignFns.set(`${s.foreign} ${s.name}`, fsig);
            this.types.set(s, fsig);
            break;
          }
          if (!s.body) break;
          const sig = this.signatureOf(s);
          this.fns.set(s.name, sig);
          scope.set(s.name, sig);
          break;
        }
        case "StructDecl":
          if (s.foreign) { this.foreignTypes.add(`${s.foreign} ${s.name}`); break; }
          scope.set(s.name, { k: "type", name: s.name });
          break;
        case "EnumDecl":
          scope.set(s.name, { k: "type", name: s.name });
          for (const v of s.variants) {
            const info = this.enums.get(s.name)!;
            const vi = info.variants.get(v.name)!;
            const ret = named(s.name, s.generics.map((g) => named(g.name)));
            scope.set(v.name, vi.fields.length
              ? fn(vi.fields.map((t, i) => param(vi.names[i] ?? `f${i}`, t)), ret, info.generics)
              : ret);
          }
          break;
        case "CapabilityDecl":
          scope.set(s.name, { k: "cap", name: s.name });
          break;
        case "ImplDecl": {
          let table = this.impls.get(s.typeName);
          if (!table) { table = new Map(); this.impls.set(s.typeName, table); }
          for (const m of s.members) table.set(m.name, this.signatureOf(m));
          break;
        }
        case "TraitDecl":
          for (const m of s.members) {
            // Trait methods are available on every implementor.
            for (const [, table] of this.impls) if (!table.has(m.name)) { /* filled at impl time */ }
          }
          break;
        case "ImportDecl":
          if (s.foreign) {
            this.foreignImports.push({ lang: s.foreign, path: s.path, names: s.names.map((n) => n.name) });
            // `from py "math" import sqrt` binds the names locally.
            for (const n of s.names) {
              scope.set(n.alias ?? n.name, s.foreign === "py"
                ? fn([param("args", any("python argument"), { variadic: true })], cty("py", "object"))
                : any(`${s.foreign} import`));
            }
            if (s.form === "module") scope.set(s.alias ?? lastSegment(s.path), { k: "module", name: s.path });
          }
          break;
        case "GenerateDecl":
          this.collectSignatures(s.body.stmts, scope);
          break;
        default: break;
      }
    }
  }

  private signatureOf(d: A.FnDecl): FnT {
    const gs = d.generics.map((g) => g.name);
    for (const g of gs) this.generics.add(g);
    const params: FnParam[] = d.params.map((p) => {
      let t = p.type ? this.toTy(p.type) : fresh(p.name);
      if (p.variadic) t = list(t);
      return param(p.name, t, { optional: !!p.default, variadic: p.variadic });
    });
    const ret = d.retType ? this.toTy(d.retType) : fresh(`${d.name}:ret`);
    return fn(params, ret, gs);
  }

  // ---- type expressions ---------------------------------------------------

  toTy(t: A.TypeNode): Ty {
    switch (t.kind) {
      case "InferType": return fresh();
      case "OptionalType": return opt(this.toTy(t.inner));
      case "RefType": return { k: "ref", inner: this.toTy(t.inner), mut: t.mut };
      case "RawPtrType": return { k: "raw", inner: this.toTy(t.inner) };
      case "TupleType": return tup(t.elements.map((e) => this.toTy(e)));
      case "ForeignType": {
        const inner = t.inner;
        if (inner.kind === "NamedType") return cty(t.lang, inner.name);
        if (inner.kind === "RawPtrType") return { k: "raw", inner: this.toTy(inner.inner) };
        return cty(t.lang, "void *");
      }
      case "NamedType": {
        const args = t.args.map((a) => this.toTy(a));
        switch (t.name) {
          case "int": case "int8": case "int16": case "int32": case "int64":
          case "uint": case "uint8": case "uint16": case "uint32": case "uint64":
            return INT;
          case "float": case "float32": case "float64": case "double": return FLOAT;
          case "bool": return BOOL;
          case "string": return STRING;
          case "char": return CHAR;
          case "byte": return BYTE;
          case "void": case "nothing": return NOTHING;
          case "list": return list(args[0] ?? fresh());
          case "array": return arr(args[0] ?? fresh());
          case "set": return set(args[0] ?? fresh());
          case "map": return map(args[0] ?? fresh(), args[1] ?? fresh());
          case "tuple": return tup(args);
          case "channel": return { k: "chan", inner: args[0] ?? fresh() };
          case "task": return { k: "task", inner: args[0] ?? fresh() };
          case "shared": return { k: "shared", inner: args[0] ?? fresh() };
          case "atomic": return { k: "atomic", inner: args[0] ?? fresh() };
          case "mutex": return { k: "mutex", rw: false };
          case "rwmutex": return { k: "mutex", rw: true };
        }
        const alias = this.aliases.get(t.name);
        if (alias) return alias;
        if (this.structs.has(t.name) || this.enums.has(t.name)) return named(t.name, args);
        if (this.generics.has(t.name)) return named(t.name, args);
        // An unknown capitalised name is a forward reference or a generic.
        return named(t.name, args);
      }
    }
  }

  // ---- statements ----------------------------------------------------------

  private checkStmts(stmts: A.Stmt[], scope: Scope): void {
    for (const s of stmts) this.checkStmt(s, scope);
  }

  private checkBlock(b: A.Block, scope: Scope): void {
    const inner = scope.child();
    this.collectSignatures(b.stmts, inner);
    this.checkStmts(b.stmts, inner);
  }

  private checkStmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case "FnDecl": {
        if (!s.body || s.foreign) return;
        const sig = this.fns.get(s.name) ?? this.signatureOf(s);
        const inner = scope.child();
        s.params.forEach((p, i) => {
          const pt = sig.params[i]?.ty ?? fresh(p.name);
          inner.set(p.name === "..." ? "_varargs" : p.name, pt);
          if (p.default) this.expect(this.infer(p.default, inner), pt, p.span, `default for \`${p.name}\``);
        });
        this.retStack.push(sig.ret);
        this.checkBlock(s.body, inner);
        this.retStack.pop();
        // A function with no `give` returns nothing.
        if (!blockGives(s.body)) tryUnify(sig.ret, NOTHING);
        this.note(s, sig);
        return;
      }

      case "ImplDecl": {
        const selfTy = named(s.typeName);
        for (const m of s.members) {
          if (!m.body) continue;
          const sig = this.impls.get(s.typeName)?.get(m.name) ?? this.signatureOf(m);
          const inner = scope.child();
          inner.set("self", selfTy);
          // Bare field names resolve against the receiver (#16).
          const info = this.structs.get(s.typeName);
          if (info) for (const [f, t] of info.fields) inner.set(f, t);
          m.params.forEach((p, i) => inner.set(p.name, sig.params[i]?.ty ?? fresh(p.name)));
          this.retStack.push(sig.ret);
          this.checkBlock(m.body, inner);
          this.retStack.pop();
          if (!blockGives(m.body)) tryUnify(sig.ret, NOTHING);
        }
        return;
      }

      case "TraitDecl":
        // `method(), give nothing` is how #16 spells a contract with no
        // default implementation, so it is a signature rather than a body.
        for (const m of s.members) if (m.body && !isEmptyContract(m.body)) this.checkStmt(m, scope);
        return;

      case "LetStmt": case "ConstDecl": {
        if (s.kind === "ConstDecl") {
          const vt = this.infer(s.value, scope);
          scope.set(s.name, s.type ? this.toTy(s.type) : vt);
          if (s.type) this.expect(vt, this.toTy(s.type), s.span, `\`${s.name}\``);
          return;
        }
        const declared = s.type ? this.toTy(s.type) : null;
        let vt: Ty = declared ?? fresh();
        if (s.value) {
          const got = this.infer(s.value, scope);
          if (declared) this.expect(got, declared, s.span, patName(s.pattern));
          else vt = got;
        } else if (!declared) {
          vt = opt(fresh()); // `let name: string?` with no value
        }
        this.bindPattern(s.pattern, vt, scope);
        return;
      }

      case "AssignStmt": {
        const vt = this.infer(s.value, scope);
        if (s.type) this.expect(vt, this.toTy(s.type), s.span, "assignment");
        this.assignTo(s.target, s.type ? this.toTy(s.type) : vt, scope, s.span);
        return;
      }

      case "ExprStmt": this.infer(s.expr, scope); return;
      case "SayStmt": for (const a of s.args) this.infer(a, scope); return;

      case "GiveStmt": {
        const want = this.retStack[this.retStack.length - 1];
        const got = s.value ? this.infer(s.value, scope) : NOTHING;
        if (want) this.expect(got, want, s.span, "this `give`");
        return;
      }

      case "IfStmt": {
        const c = this.infer(s.cond, scope);
        this.expectCondition(c, s.cond.span);
        // Narrow `x is null` / `not (x is null)` in the branches (R10, #13).
        const narrowed = this.narrowing(s.cond);
        this.checkBranch(s.then, scope, narrowed ? { name: narrowed.name, ty: narrowed.whenTrue } : null);
        for (const e of s.elifs) {
          this.expectCondition(this.infer(e.cond, scope), e.cond.span);
          const n2 = this.narrowing(e.cond);
          this.checkBranch(e.block, scope, n2 ? { name: n2.name, ty: n2.whenTrue } : null);
        }
        if (s.else) this.checkBranch(s.else, scope, narrowed ? { name: narrowed.name, ty: narrowed.whenFalse } : null);
        return;
      }

      case "WhileStmt":
        this.expectCondition(this.infer(s.cond, scope), s.cond.span);
        this.checkBlock(s.body, scope);
        return;

      case "ForStmt": {
        const it = this.infer(s.iter, scope);
        const elem = this.elementType(it, s.iter.span);
        const inner = scope.child();
        this.bindPattern(s.pattern, elem, inner);
        this.checkBlock(s.body, inner);
        return;
      }

      case "MatchStmt": this.infer(s.expr, scope); return;
      case "DeferStmt": this.checkStmt(s.stmt, scope); return;

      case "WithStmt":
        if (!s.capability) this.infer(s.subject, scope);
        this.checkBlock(s.body, scope);
        return;

      case "ParallelStmt": case "UnsafeStmt": case "GenerateDecl":
        this.checkBlock(s.body, scope);
        return;

      case "IntrinsicStmt": {
        const t = this.infer(s.target, scope);
        const v = s.value ? this.infer(s.value, scope) : null;
        const p = prune(t);
        const soft = p.k === "any" || p.k === "var" || p.k === "never";
        if (s.op === "send") {
          const elem = v ?? fresh("sent value");
          if (p.k === "chan") this.expect(elem, p.inner, s.span, "value sent on this channel");
          else if (soft) unify(t, { k: "chan", inner: elem }); // infer the parameter's type
          else this.err("E0451", `\`send\` expects a channel, found ${show(p)}`, s.target.span, { rule: "#27 — Channels" });
        }
        if (s.op === "store") {
          const val = v ?? fresh("stored value");
          if (p.k === "atomic") this.expect(val, p.inner, s.span, "value stored in this atomic");
          else if (soft) unify(t, { k: "atomic", inner: val });
          else this.err("E0452", `\`store\` expects an atomic, found ${show(p)}`, s.target.span, { rule: "#30 — Atomics" });
        }
        if (s.op === "cancel") {
          if (soft) unify(t, { k: "task", inner: fresh("task result") });
          else if (p.k !== "task") this.err("E0453", `\`cancel\` expects a task, found ${show(p)}`, s.target.span, { rule: "#31 — Cancellation" });
        }
        return;
      }

      default: return;
    }
  }

  private checkBranch(b: A.Block, scope: Scope, narrow: { name: string; ty: Ty } | null): void {
    const inner = scope.child();
    if (narrow) inner.set(narrow.name, narrow.ty);
    this.collectSignatures(b.stmts, inner);
    this.checkStmts(b.stmts, inner);
  }

  private expectCondition(t: Ty, span: Span): void {
    const p = prune(t);
    if (p.k === "any" || p.k === "var" || p.k === "never") return;
    if (p.k === "prim" && p.name === "bool") return;
    // Halka truthiness accepts optionals in a condition (R11), but not numbers —
    // `if count,` is almost always a mistake.
    if (p.k === "opt") return;
    this.err("E0454", `a condition must be a bool, found ${show(p)}`, span, {
      help: p.k === "prim" && isNumeric(p) ? "compare it, e.g. `count > 0`" : undefined,
    });
  }

  /** `x is null` narrows `x` to `T` in the false branch (R10, #13). */
  private narrowing(cond: A.Expr): { name: string; whenTrue: Ty; whenFalse: Ty } | null {
    if (cond.kind === "UnaryExpr" && cond.op === "not") {
      const inner = this.narrowing(cond.operand);
      return inner ? { name: inner.name, whenTrue: inner.whenFalse, whenFalse: inner.whenTrue } : null;
    }
    if (cond.kind !== "IsExpr" || cond.test !== "null") return null;
    if (cond.expr.kind !== "Ident") return null;
    const t = this.types.get(cond.expr);
    if (!t) return null;
    const p = prune(t);
    if (p.k !== "opt") return null;
    return { name: cond.expr.name, whenTrue: NULL, whenFalse: p.inner };
  }

  private elementType(t: Ty, span: Span): Ty {
    const p = prune(t);
    switch (p.k) {
      case "list": case "array": case "set": return p.elem;
      case "range": return INT;
      case "map": return tup([p.key, p.val]);
      case "tuple": return p.elems.length ? p.elems[0]! : any("empty tuple");
      case "prim": if (p.name === "string") return CHAR; break;
      case "any": case "var": return any("iterating an unknown type");
      default: break;
    }
    this.err("E0455", `${show(p)} is not iterable`, span, { rule: "#6 — Indexing, slicing & ranges" });
    return any("not iterable");
  }

  // ---- patterns ------------------------------------------------------------

  private bindPattern(p: A.Pattern, t: Ty, scope: Scope): void {
    switch (p.kind) {
      case "BindPat": scope.set(p.name, p.type ? this.toTy(p.type) : t); return;
      case "TypePat": scope.set(p.name, t); return;
      case "WildcardPat": return;
      case "RestPat": if (p.name) scope.set(p.name, list(any("rest"))); return;
      case "TuplePat": {
        const pt = prune(t);
        if (pt.k === "tuple") {
          p.elements.forEach((e, i) => this.bindPattern(e, pt.elems[i] ?? any("short tuple"), scope));
        } else if (pt.k === "list" || pt.k === "array") {
          p.elements.forEach((e) => this.bindPattern(e, pt.elem, scope));
        } else {
          p.elements.forEach((e) => this.bindPattern(e, any("destructuring"), scope));
        }
        return;
      }
      case "ListPat": {
        const pt = prune(t);
        const elem = pt.k === "list" || pt.k === "array" || pt.k === "set" ? pt.elem
          : pt.k === "tuple" ? any("tuple destructured as a list")
          : any("destructuring");
        for (const e of p.elements) {
          if (e.kind === "RestPat") { if (e.name) scope.set(e.name, list(elem)); continue; }
          this.bindPattern(e, elem, scope);
        }
        return;
      }
      case "StructPat": {
        const info = this.structs.get(p.name);
        for (const f of p.fields) this.bindPattern(f.pattern, info?.fields.get(f.name) ?? any("unknown field"), scope);
        return;
      }
      case "VariantPat": {
        const owner = this.enumOwning(p.name);
        const vi = owner?.info.variants.get(p.name);
        const subst = new Map<string, Ty>();
        const pt = prune(t);
        if (owner && pt.k === "named" && pt.name === owner.name) {
          owner.info.generics.forEach((g, i) => subst.set(g, pt.args[i] ?? fresh(g)));
        }
        p.args.forEach((a, i) => {
          const ft = vi?.fields[i];
          this.bindPattern(a, ft ? instantiate(ft, subst) : any("variant payload"), scope);
        });
        return;
      }
      default: return;
    }
  }

  private enumOwning(variant: string): { name: string; info: EnumInfo } | null {
    for (const [name, info] of this.enums) if (info.variants.has(variant)) return { name, info };
    return null;
  }

  private assignTo(target: A.Expr, vt: Ty, scope: Scope, span: Span): void {
    switch (target.kind) {
      case "Ident": {
        const existing = scope.get(target.name);
        if (existing) this.expect(vt, existing, span, `\`${target.name}\``);
        else scope.set(target.name, vt);
        this.note(target, existing ?? vt);
        return;
      }
      case "MemberExpr": {
        const ft = this.infer(target, scope);
        this.expect(vt, ft, span, `field \`${target.name}\``);
        return;
      }
      case "IndexExpr": {
        const ot = prune(this.infer(target.obj, scope));
        const it = this.infer(target.index, scope);
        if (ot.k === "list" || ot.k === "array") {
          this.expect(it, INT, target.index.span, "an index");
          this.expect(vt, ot.elem, span, "the element");
        } else if (ot.k === "map") {
          this.expect(it, ot.key, target.index.span, "the key");
          this.expect(vt, ot.val, span, "the value");
        }
        return;
      }
      case "TupleExpr": case "ListExpr": {
        const pt = prune(vt);
        const elems = target.kind === "TupleExpr" ? target.elements : target.elements;
        elems.forEach((e, i) => {
          const et = pt.k === "tuple" ? (pt.elems[i] ?? any("short tuple"))
            : pt.k === "list" || pt.k === "array" ? pt.elem
            : any("destructuring");
          this.assignTo(e, et, scope, span);
        });
        return;
      }
      default:
        this.infer(target, scope);
        return;
    }
  }

  // ---- expressions ---------------------------------------------------------

  infer(e: A.Expr, scope: Scope): Ty {
    const t = this.inferRaw(e, scope);
    return this.note(e, t);
  }

  private inferRaw(e: A.Expr, scope: Scope): Ty {
    switch (e.kind) {
      case "IntLit": return INT;
      case "FloatLit": return FLOAT;
      case "BoolLit": return BOOL;
      case "CharLit": return CHAR;
      case "NullLit": return NULL;
      case "NothingLit": return NOTHING;
      case "EllipsisExpr": return any("elided");

      case "StrLit":
        for (const p of e.parts) if (p.kind === "expr" && p.expr) this.infer(p.expr, scope);
        return STRING;

      case "Ident": {
        const t = scope.get(e.name);
        if (t) return t;
        if (this.structs.has(e.name) || this.enums.has(e.name)) return { k: "type", name: e.name };
        // Undefined names are reported by check.ts; do not double-report here.
        return any(`unknown name \`${e.name}\``);
      }

      case "TupleExpr": return tup(e.elements.map((x) => this.infer(x, scope)));

      case "ListExpr": {
        if (!e.elements.length) return list(fresh("element"));
        const first = this.infer(e.elements[0]!, scope);
        for (const x of e.elements.slice(1)) {
          this.expect(this.infer(x, scope), first, x.span, "every element of a list must have the same type");
        }
        return list(first);
      }

      case "SetExpr": {
        if (!e.elements.length) return set(fresh("element"));
        const first = this.infer(e.elements[0]!, scope);
        for (const x of e.elements.slice(1)) this.expect(this.infer(x, scope), first, x.span, "every element of a set");
        return set(first);
      }

      case "MapExpr": {
        if (!e.entries.length) return map(fresh("key"), fresh("value"));
        const k0 = this.infer(e.entries[0]!.key, scope);
        const v0 = this.infer(e.entries[0]!.value, scope);
        for (const en of e.entries.slice(1)) {
          this.expect(this.infer(en.key, scope), k0, en.key.span, "every key of a map");
          this.expect(this.infer(en.value, scope), v0, en.value.span, "every value of a map");
        }
        return map(k0, v0);
      }

      case "RecordExpr": {
        for (const en of e.entries) this.infer(en.value, scope);
        return any("record block");
      }

      case "BlockExpr": this.checkBlock(e.block, scope); return NOTHING;

      case "UnaryExpr": {
        const t = this.infer(e.operand, scope);
        if (e.op === "not") { this.expectCondition(t, e.span); return BOOL; }
        if (!isNumeric(t) && prune(t).k !== "any" && prune(t).k !== "var") {
          this.err("E0456", `unary \`${e.op}\` expects a number, found ${show(t)}`, e.span);
          return any("bad unary");
        }
        return t;
      }

      case "BinaryExpr": return this.inferBinary(e, scope);

      case "RangeExpr": {
        if (e.lo) this.expect(this.infer(e.lo, scope), INT, e.lo.span, "a range bound");
        if (e.hi) this.expect(this.infer(e.hi, scope), INT, e.hi.span, "a range bound");
        if (e.step) this.expect(this.infer(e.step, scope), INT, e.step.span, "a range step");
        return { k: "range" };
      }

      case "IsExpr": this.infer(e.expr, scope); return BOOL;

      case "CastExpr": {
        this.infer(e.expr, scope);
        const target = this.toTy(e.type);
        return e.fallible ? resultOf(target) : target;
      }

      case "MemberExpr": return this.inferMember(e, scope);
      case "IndexExpr": return this.inferIndex(e, scope);

      case "SliceExpr": {
        const ot = prune(this.infer(e.obj, scope));
        for (const b of [e.start, e.end, e.step]) if (b) this.expect(this.infer(b, scope), INT, b.span, "a slice bound");
        if (ot.k === "list" || ot.k === "array" || ot.k === "tuple") return ot.k === "tuple" ? list(any("tuple slice")) : list(ot.elem);
        if (ot.k === "prim" && ot.name === "string") return STRING;
        if (ot.k === "any" || ot.k === "var") return any("slicing an unknown type");
        this.err("E0457", `${show(ot)} cannot be sliced`, e.span, { rule: "#54 — Indexing, slicing & ranges" });
        return any("bad slice");
      }

      case "CallExpr": return this.inferCall(e, scope);

      case "ApplyExpr": {
        const v = this.infer(e.value, scope);
        const f = prune(this.infer(e.fn, scope));
        if (f.k === "fn") {
          const inst = instantiate(f) as FnT;
          if (inst.params[0]) this.expect(v, inst.params[0].ty, e.span, "the applied argument");
          return inst.ret;
        }
        return any("apply to an unknown function");
      }

      case "MatchExpr": return this.inferMatch(e, scope);

      case "BorrowExpr": return { k: "ref", inner: this.infer(e.expr, scope), mut: e.mut };
      case "RefExpr": return { k: "ref", inner: this.infer(e.expr, scope), mut: e.mut };
      case "MoveExpr": return this.infer(e.expr, scope);
      case "DerefExpr": {
        const t = prune(this.infer(e.expr, scope));
        if (t.k === "ref" || t.k === "raw") return t.inner;
        if (t.k === "any" || t.k === "var") return any("dereferencing an unknown type");
        this.err("E0458", `cannot dereference ${show(t)}`, e.span, { rule: "#14 — References / pointers" });
        return any("bad deref");
      }
      case "RawExpr": return { k: "raw", inner: this.infer(e.expr, scope) };

      case "StartExpr": {
        const inner = this.infer(e.call, scope);
        return { k: "task", inner };
      }
      case "AwaitExpr": {
        const t = prune(this.infer(e.expr, scope));
        // `await` yields the value, or an Error / Cancelled state (#31, R15).
        return t.k === "task" ? t.inner : t.k === "any" || t.k === "var" ? any("awaiting an unknown value") : t;
      }
      case "ReceiveExpr": {
        const raw = this.infer(e.channel, scope);
        const t = prune(raw);
        if (t.k === "chan") return opt(t.inner); // a closed channel yields null
        if (t.k === "var") { const el = fresh("received value"); unify(raw, { k: "chan", inner: el }); return opt(el); }
        if (t.k === "any") return any("receiving from an unknown channel");
        this.err("E0451", `\`receive\` expects a channel, found ${show(t)}`, e.span, { rule: "#27 — Channels" });
        return any("bad receive");
      }
      case "LoadExpr": {
        const raw = this.infer(e.target, scope);
        const t = prune(raw);
        if (t.k === "atomic") return t.inner;
        if (t.k === "var") { const el = fresh("atomic value"); unify(raw, { k: "atomic", inner: el }); return el; }
        if (t.k === "any") return any("loading an unknown atomic");
        this.err("E0452", `\`load\` expects an atomic, found ${show(t)}`, e.span, { rule: "#30 — Atomics" });
        return any("bad load");
      }
      case "MakeExpr":
        if (e.what === "channel") {
          if (e.capacity) this.expect(this.infer(e.capacity, scope), INT, e.capacity.span, "a channel capacity");
          return { k: "chan", inner: e.type ? this.toTy(e.type) : fresh("channel element") };
        }
        return { k: "mutex", rw: e.what === "rwmutex" };
      case "AtomicExpr":
        return { k: "atomic", inner: e.type ? this.toTy(e.type) : this.infer(e.init, scope) };

      case "CancelledExpr": return BOOL;
      case "AcquireExpr": return { k: "cap", name: e.capability };
      case "ReflectExpr": this.infer(e.target, scope); return any("reflection");
      case "CompileExpr": return this.infer(e.expr, scope);
      case "DeviceExpr": return this.infer(e.expr, scope);
      case "LaunchExpr": return this.infer(e.call, scope);
      case "ForeignExpr": return this.inferForeign(e, scope);
      case "FnRefExpr": return scope.get(e.name) ?? any("function reference");
    }
  }

  /** `c malloc(100)`, `py numpy.array(...)` — a call across a foreign boundary. */
  private inferForeign(e: A.ForeignExpr, scope: Scope): Ty {
    const inner = e.expr;

    if (inner.kind === "CallExpr") {
      // Resolve the callee's name without inferring it as a Halka value.
      const name = inner.callee.kind === "Ident" ? inner.callee.name
        : inner.callee.kind === "MemberExpr" ? memberPath(inner.callee)
        : null;
      const argTys = inner.args.map((a) => (a.value.kind === "EllipsisExpr" ? any("elided") : this.infer(a.value, scope)));

      const sig = name ? this.foreignFns.get(`${e.lang} ${name}`) : undefined;
      if (!sig) {
        // Python is dynamically typed, so the result is a Python value until
        // `as` says what it should become (#15, #37).
        if (e.lang === "py") return cty("py", "object");
        // For C the foreign compiler checks the call, not us.
        return any(`undeclared ${e.lang} function${name ? ` \`${name}\`` : ""}`);
      }
      const inst = instantiate(sig) as FnT;
      argTys.forEach((t, i) => {
        const p = inst.params[i];
        if (p && !p.variadic) this.expect(t, p.ty, inner.args[i]!.span, `argument \`${p.name}\``);
      });
      return inst.ret;
    }

    if (inner.kind === "Ident") {
      const sig = this.foreignFns.get(`${e.lang} ${inner.name}`);
      if (sig) return sig;
      if (this.foreignTypes.has(`${e.lang} ${inner.name}`)) return cty(e.lang, inner.name);
      if (e.lang === "py") return cty("py", "object");
      return any(`${e.lang} symbol \`${inner.name}\``);
    }

    if (inner.kind === "MemberExpr") return e.lang === "py" ? cty("py", "object") : any(`${e.lang} member`);
    return e.lang === "py" ? cty("py", "object") : any(`${e.lang} interop`);
  }

  private inferBinary(e: A.BinaryExpr, scope: Scope): Ty {
    const l = this.infer(e.lhs, scope);
    const r = this.infer(e.rhs, scope);
    const lp = prune(l);
    const rp = prune(r);

    switch (e.op) {
      case "and": case "or": {
        // R11: `a or b` yields `b` when `a` is null or false, so an optional
        // left operand is unwrapped by a non-optional right operand.
        if (e.op === "or" && lp.k === "opt" && rp.k !== "opt" && rp.k !== "prim") return rp;
        if (e.op === "or" && lp.k === "opt") {
          if (tryUnify(lp.inner, rp)) return rp;
          return opt(lp.inner);
        }
        if (lp.k === "prim" && lp.name === "null") return rp;
        if (tryUnify(l, r)) return lp.k === "any" ? rp : lp;
        return any("mixed or/and operands");
      }

      case "==": case "!=":
        if (!tryUnify(l, r) && lp.k !== "any" && rp.k !== "any") {
          this.err("E0459", `cannot compare ${show(lp)} with ${show(rp)}`, e.span);
        }
        return BOOL;

      case "<": case "<=": case ">": case ">=":
        if (!tryUnify(l, r) && lp.k !== "any" && rp.k !== "any") {
          this.err("E0459", `cannot order ${show(lp)} against ${show(rp)}`, e.span);
        }
        return BOOL;

      case "+":
        // `+` concatenates strings and lists as well as adding numbers.
        if (lp.k === "prim" && lp.name === "string") return STRING;
        if (rp.k === "prim" && rp.name === "string") return STRING;
        if (lp.k === "list") { this.expect(r, lp, e.span, "list concatenation"); return lp; }
        return this.arith(e, lp, rp);

      case "-": case "*": case "%": return this.arith(e, lp, rp);

      case "/":
        // R21: `/` always yields a float, so `3 / 2` is 1.5.
        this.arith(e, lp, rp);
        return FLOAT;
    }
  }

  private arith(e: A.BinaryExpr, lp: Ty, rp: Ty): Ty {
    const soft = (t: Ty) => t.k === "any" || t.k === "var" || t.k === "never";
    if (soft(lp) || soft(rp)) return soft(lp) ? rp : lp;
    if (!isNumeric(lp) || !isNumeric(rp)) {
      this.err("E0460", `\`${e.op}\` is not defined for ${show(lp)} and ${show(rp)}`, e.span, {
        rule: "#51 — Operator precedence",
      });
      return any("bad arithmetic");
    }
    // int + float widens to float.
    const lf = lp.k === "prim" && lp.name === "float";
    const rf = rp.k === "prim" && rp.name === "float";
    return lf || rf ? FLOAT : INT;
  }

  private inferMember(e: A.MemberExpr, scope: Scope): Ty {
    const ot = prune(this.infer(e.obj, scope));

    if (ot.k === "opt") {
      this.err("E0461", `\`${e.name}\` cannot be read from ${show(ot)} — it may be null`, e.span, {
        rule: "#13 — Optional types",
        help: `test it first (\`if x is null,\`) or default it (\`x or ...\`)`,
      });
      return any("member of an optional");
    }

    if (ot.k === "named") {
      const info = this.structs.get(ot.name);
      if (info) {
        const f = info.fields.get(e.name);
        if (f) return f;
        const m = this.impls.get(ot.name)?.get(e.name);
        if (m) return instantiate(m);
        const trait = this.traitMethod(ot.name, e.name);
        if (trait) return instantiate(trait);
        this.err("E0462", `\`${ot.name}\` has no field or method \`${e.name}\``, e.span, {
          help: near(e.name, [...info.fields.keys(), ...(this.impls.get(ot.name)?.keys() ?? [])]),
        });
        return any("unknown member");
      }
      const en = this.enums.get(ot.name);
      if (en) {
        const m = this.impls.get(ot.name)?.get(e.name);
        if (m) return instantiate(m);
        // A variant payload field, e.g. `r.value` on Ok.
        for (const v of en.variants.values()) {
          const i = v.names.indexOf(e.name);
          if (i >= 0) return v.fields[i]!;
        }
      }
      return any(`member of ${ot.name}`);
    }

    const builtin = builtinMemberType(ot, e.name);
    if (builtin) return builtin;

    if (ot.k === "any" || ot.k === "var") return any("member of an unknown type");
    this.err("E0462", `${show(ot)} has no member \`${e.name}\``, e.span);
    return any("unknown member");
  }

  private traitMethod(typeName: string, method: string): FnT | null {
    for (const [, t] of this.traits) {
      for (const m of t.members) {
        if (m.name !== method) continue;
        const impl = this.impls.get(typeName)?.get(method);
        if (impl) return impl;
        if (m.body && !isEmptyContract(m.body)) return this.signatureOf(m);
      }
    }
    return null;
  }

  private inferIndex(e: A.IndexExpr, scope: Scope): Ty {
    const ot = prune(this.infer(e.obj, scope));
    const it = this.infer(e.index, scope);
    switch (ot.k) {
      case "list": case "array":
        this.expect(it, INT, e.index.span, "an index");
        return ot.elem;
      case "map":
        this.expect(it, ot.key, e.index.span, "the key");
        // A missing key reads as null (#7).
        return opt(ot.val);
      case "set":
        this.expect(it, ot.elem, e.index.span, "the element");
        return BOOL;
      case "tuple":
        this.expect(it, INT, e.index.span, "an index");
        return e.index.kind === "IntLit" ? (ot.elems[Number(e.index.value)] ?? any("tuple index out of range")) : any("dynamic tuple index");
      case "prim":
        if (ot.name === "string") { this.expect(it, INT, e.index.span, "an index"); return CHAR; }
        break;
      case "any": case "var": return any("indexing an unknown type");
      default: break;
    }
    this.err("E0463", `${show(ot)} cannot be indexed`, e.span, { rule: "#54 — Indexing, slicing & ranges" });
    return any("bad index");
  }

  private inferCall(e: A.CallExpr, scope: Scope): Ty {
    // Struct construction.
    if (e.callee.kind === "Ident") {
      const info = this.structs.get(e.callee.name);
      if (info) {
        const positional = e.args.filter((a) => !a.name && a.value.kind !== "EllipsisExpr");
        let i = 0;
        for (const a of e.args) {
          if (a.value.kind === "EllipsisExpr") continue;
          const t = this.infer(a.value, scope);
          const fieldName = a.name ?? info.order[i++];
          const ft = fieldName ? info.fields.get(fieldName) : undefined;
          if (ft) this.expect(t, ft, a.span, `field \`${fieldName}\``);
          else if (a.name) {
            this.err("E0464", `\`${info.decl.name}\` has no field \`${a.name}\``, a.span, {
              help: near(a.name, info.order),
            });
          }
        }
        const elided = e.args.some((a) => a.value.kind === "EllipsisExpr");
        if (!elided && !e.args.some((a) => a.name) && positional.length !== info.order.length) {
          this.err("E0465", `\`${info.decl.name}\` has ${info.order.length} field(s), but ${positional.length} were given`, e.span);
        }
        return named(info.decl.name);
      }
    }

    const ct = prune(this.infer(e.callee, scope));
    const argTys = e.args.map((a) => (a.value.kind === "EllipsisExpr" ? any("elided") : this.infer(a.value, scope)));

    if (ct.k !== "fn") {
      if (ct.k === "any" || ct.k === "var") return any("calling an unknown function");
      if (ct.k === "type") return named(ct.name);
      this.err("E0466", `${show(ct)} is not callable`, e.callee.span);
      return any("bad call");
    }

    const sig = instantiate(ct) as FnT;
    const required = sig.params.filter((p) => !p.optional && !p.variadic).length;
    const hasVariadic = sig.params.some((p) => p.variadic);
    if (!hasVariadic && !e.args.some((a) => a.name || a.value.kind === "EllipsisExpr")) {
      if (argTys.length < required || argTys.length > sig.params.length) {
        this.err("E0404",
          `expected ${required === sig.params.length ? required : `${required}–${sig.params.length}`} argument(s), found ${argTys.length}`,
          e.span);
      }
    }
    argTys.forEach((t, i) => {
      const p = sig.params[i];
      if (!p) return;
      if (p.variadic) { this.expect(t, (prune(p.ty) as { elem?: Ty }).elem ?? p.ty, e.args[i]!.span, `argument \`${p.name}\``); return; }
      this.expect(t, p.ty, e.args[i]!.span, `argument \`${p.name}\``);
    });
    return sig.ret;
  }

  private inferMatch(e: A.MatchExpr, scope: Scope): Ty {
    const subject = this.infer(e.subject, scope);
    let result: Ty | null = null;

    const armType = (b: A.Block, inner: Scope): Ty => {
      this.collectSignatures(b.stmts, inner);
      if (b.stmts.length === 1 && b.stmts[0]!.kind === "ExprStmt") {
        return this.infer((b.stmts[0] as A.ExprStmt).expr, inner);
      }
      this.checkStmts(b.stmts, inner);
      return NOTHING;
    };

    for (const arm of e.arms) {
      const inner = scope.child();
      this.checkPatternAgainst(arm.pattern, subject, inner);
      if (arm.guard) this.expectCondition(this.infer(arm.guard, inner), arm.guard.span);
      const t = armType(arm.body, inner);
      if (result === null) result = t;
      else if (!tryUnify(result, t)) result = any("match arms have different types");
    }
    if (e.elseArm) {
      const t = armType(e.elseArm, scope.child());
      if (result === null) result = t;
      else if (!tryUnify(result, t)) result = any("match arms have different types");
    }

    this.checkExhaustive(e, subject);
    return result ?? NOTHING;
  }

  private checkPatternAgainst(p: A.Pattern, subject: Ty, scope: Scope): void {
    // Matching a variant tells us the subject's enum, even for an untyped
    // parameter — this is what makes exhaustiveness checking work on inference.
    if (p.kind === "VariantPat" || p.kind === "TypePat") {
      const owner = this.enumOwning(p.name);
      if (owner) {
        tryUnify(subject, named(owner.name, owner.info.generics.map((g) => fresh(g))));
      }
    }

    if (p.kind === "LiteralPat") {
      const lt = this.infer(p.value, scope);
      if (!tryUnify(lt, subject)) {
        this.err("E0467", `this pattern is ${show(lt)} but the value is ${show(subject)}`, p.span, {
          rule: "#10 — Pattern details for match",
        });
      }
      return;
    }
    this.bindPattern(p, subject, scope);
  }

  /** #10 + #22 — a match over an enum must cover every variant or have an else. */
  private checkExhaustive(e: A.MatchExpr, subject: Ty): void {
    if (e.elseArm) return;
    const p = prune(subject);
    if (p.k !== "named") return;
    const info = this.enums.get(p.name);
    if (!info) return;

    const covered = new Set<string>();
    let hasIrrefutable = false;
    for (const arm of e.arms) {
      if (arm.guard) continue; // a guarded arm proves nothing
      switch (arm.pattern.kind) {
        case "VariantPat": covered.add(arm.pattern.name); break;
        case "TypePat": covered.add(arm.pattern.name); break;
        case "BindPat": case "WildcardPat": hasIrrefutable = true; break;
        default: break;
      }
    }
    if (hasIrrefutable) return;

    const missing = [...info.variants.keys()].filter((v) => !covered.has(v));
    // `Cancelled` only arises from awaiting a task, so it is not required.
    const required = missing.filter((m) => m !== "Cancelled");
    if (required.length) {
      this.err("E0468", `this match does not cover ${required.map((m) => `\`${m}\``).join(", ")}`, e.span, {
        rule: "#10 — Pattern details for match",
        help: `add the missing arm${required.length > 1 ? "s" : ""}, or an \`else\` branch`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `give nothing` alone is a trait contract, not a default implementation (#16). */
function isEmptyContract(b: A.Block): boolean {
  if (b.stmts.length !== 1) return false;
  const only = b.stmts[0]!;
  return only.kind === "GiveStmt" && (!only.value || only.value.kind === "NothingLit");
}

function memberPath(e: A.MemberExpr): string {
  const parts = [e.name];
  let cur: A.Expr = e.obj;
  while (cur.kind === "MemberExpr") { parts.unshift(cur.name); cur = cur.obj; }
  if (cur.kind === "Ident") parts.unshift(cur.name);
  return parts.join(".");
}

function lastSegment(path: string): string {
  const p = path.replace(/\.(h|hpp|hxx)$/, "");
  const parts = p.split(/[./\\]/);
  return parts[parts.length - 1] || p;
}

function patName(p: A.Pattern): string {
  return p.kind === "BindPat" ? `\`${p.name}\`` : "this binding";
}

function blockGives(b: A.Block): boolean {
  let found = false;
  const walk = (stmts: A.Stmt[]) => {
    for (const s of stmts) {
      if (found) return;
      switch (s.kind) {
        case "GiveStmt": found = true; return;
        case "IfStmt":
          walk(s.then.stmts);
          for (const e of s.elifs) walk(e.block.stmts);
          if (s.else) walk(s.else.stmts);
          break;
        case "ForStmt": case "WhileStmt": case "WithStmt":
        case "ParallelStmt": case "UnsafeStmt":
          walk(s.body.stmts);
          break;
        case "MatchStmt":
          for (const a of s.expr.arms) walk(a.body.stmts);
          if (s.expr.elseArm) walk(s.expr.elseArm.stmts);
          break;
        case "DeferStmt": walk([s.stmt]); break;
        default: break;
      }
    }
  };
  walk(b.stmts);
  return found;
}

function near(name: string, options: string[]): string | undefined {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = dist(name, o);
    if (d < bestD && d <= Math.max(1, Math.floor(name.length / 3))) { bestD = d; best = o; }
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

// ---------------------------------------------------------------------------
// built-in member and method types
// ---------------------------------------------------------------------------

function builtinMemberType(ot: Ty, name: string): Ty | null {
  const T = (t: Ty) => t;
  switch (name) {
    case "length": case "size":
      if (["list", "array", "map", "set", "tuple", "range"].includes(ot.k)) return INT;
      if (ot.k === "prim" && ot.name === "string") return INT;
      break;
    case "value": if (ot.k === "atomic") return ot.inner; break;
    case "state": if (ot.k === "task") return STRING; break;
  }

  if (ot.k === "prim" && ot.name === "string") {
    switch (name) {
      case "upper": case "lower": case "trim": case "trim_start": case "trim_end":
        return fn([], STRING);
      case "split": return fn([param("sep", STRING, { optional: true })], list(STRING));
      case "lines": return fn([], list(STRING));
      case "contains": case "starts_with": case "ends_with":
        return fn([param("needle", STRING)], BOOL);
      case "replace": return fn([param("from", STRING), param("to", STRING)], STRING);
      case "index_of": return fn([param("needle", STRING)], INT);
      case "repeat": return fn([param("times", INT)], STRING);
      case "chars": return fn([], list(CHAR));
      case "bytes": return fn([], list(INT));
      case "pad_start": case "pad_end": return fn([param("width", INT), param("fill", STRING, { optional: true })], STRING);
      case "is_empty": return fn([], BOOL);
    }
  }

  if (ot.k === "list" || ot.k === "array") {
    const E = ot.elem;
    switch (name) {
      case "push": return fn([param("value", E, { variadic: true })], NOTHING);
      case "pop": return fn([], opt(E));
      case "insert": return fn([param("index", INT), param("value", E)], NOTHING);
      case "remove_at": return fn([param("index", INT)], E);
      case "remove": return fn([param("value", E)], BOOL);
      case "clear": return fn([], NOTHING);
      case "extend": return fn([param("other", list(E))], NOTHING);
      case "contains": return fn([param("value", E)], BOOL);
      case "index_of": return fn([param("value", E)], INT);
      case "count": return fn([param("value", E)], INT);
      case "first": case "last": return fn([], opt(E));
      case "reverse": case "sort": return fn([], NOTHING);
      case "join": return fn([param("sep", STRING, { optional: true })], STRING);
      case "is_empty": return fn([], BOOL);
      case "sum": return fn([], E);
      case "map": { const R = fresh("mapped"); return fn([param("f", fn([param("x", E)], R))], list(R)); }
      case "filter": return fn([param("f", fn([param("x", E)], BOOL))], list(E));
      case "reduce": { const A2 = fresh("acc"); return fn([param("f", fn([param("acc", A2), param("x", E)], A2)), param("init", A2, { optional: true })], A2); }
      case "any": case "all": return fn([param("f", fn([param("x", E)], BOOL))], BOOL);
      case "find": return fn([param("f", fn([param("x", E)], BOOL))], opt(E));
    }
  }

  if (ot.k === "map") {
    switch (name) {
      case "keys": return fn([], list(ot.key));
      case "values": return fn([], list(ot.val));
      case "entries": return fn([], list(tup([ot.key, ot.val])));
      case "has": return fn([param("key", ot.key)], BOOL);
      case "get": return fn([param("key", ot.key)], opt(ot.val));
      case "get_or": return fn([param("key", ot.key), param("fallback", ot.val)], ot.val);
      case "remove": return fn([param("key", ot.key)], BOOL);
      case "clear": return fn([], NOTHING);
      case "is_empty": return fn([], BOOL);
    }
  }

  if (ot.k === "set") {
    switch (name) {
      case "add": return fn([param("value", ot.elem)], NOTHING);
      case "remove": case "has": return fn([param("value", ot.elem)], BOOL);
      case "to_list": return fn([], list(ot.elem));
      case "union": case "intersect": case "difference": return fn([param("other", ot)], ot);
      case "is_empty": return fn([], BOOL);
    }
  }

  if (ot.k === "range" && name === "to_list") return fn([], list(INT));
  if (ot.k === "tuple" && name === "to_list") return fn([], list(any("tuple element")));

  if (ot.k === "prim" && ot.name === "char") {
    switch (name) {
      case "upper": case "lower": return fn([], CHAR);
      case "code": return fn([], INT);
      case "is_digit": case "is_alpha": case "is_space": return fn([], BOOL);
    }
  }

  if (ot.k === "prim" && ot.name === "int" && name === "to_string") {
    return fn([param("radix", INT, { optional: true })], STRING);
  }

  void T;
  return null;
}

// ---------------------------------------------------------------------------
// prelude signatures
// ---------------------------------------------------------------------------

function poly(name: string): Ty { return named(name); }

const PRELUDE: [string, Ty][] = (() => {
  const T = poly("T");
  const U = poly("U");
  const K = poly("K");
  const entries: [string, Ty][] = [
    ["len", fn([param("value", any("any container"))], INT)],
    ["type_of", fn([param("value", any("any value"))], STRING)],
    ["inspect", fn([param("value", any("any value"))], STRING)],
    ["print", fn([param("values", any("any value"), { variadic: true })], NOTHING)],
    ["panic", fn([param("message", any("any value"))], NEVER)],
    ["assert", fn([param("condition", BOOL), param("message", STRING, { optional: true })], NOTHING)],
    ["id", fn([param("value", T)], T, ["T"])],

    ["int", fn([param("value", any("convertible"))], INT)],
    ["float", fn([param("value", any("convertible"))], FLOAT)],
    ["string", fn([param("value", any("any value"))], STRING)],
    ["bool", fn([param("value", any("any value"))], BOOL)],
    ["char", fn([param("value", any("convertible"))], CHAR)],

    ["list", fn([param("from", list(T), { optional: true })], list(T), ["T"])],
    ["array", fn([param("a", any("size or source"), { optional: true }), param("b", any("fill"), { optional: true })], list(any("array element")))],
    ["tuple", fn([param("values", any("any value"), { variadic: true })], any("tuple"))],
    ["set", fn([param("from", list(T), { optional: true })], set(T), ["T"])],
    ["map", fn([param("pairs", list(tup([K, U])), { optional: true })], map(K, U), ["K", "U"])],
    ["range", fn([param("a", INT), param("b", INT, { optional: true }), param("step", INT, { optional: true })], { k: "range" })],

    ["abs", fn([param("x", T)], T, ["T"])],
    ["div", fn([param("a", INT), param("b", INT)], INT)],
    ["mod", fn([param("a", INT), param("b", INT)], INT)],
    ["round", fn([param("x", FLOAT)], INT)],
    ["round_to", fn([param("x", FLOAT), param("digits", INT)], FLOAT)],
    ["floor", fn([param("x", FLOAT)], INT)],
    ["ceil", fn([param("x", FLOAT)], INT)],
    ["sqrt", fn([param("x", FLOAT)], FLOAT)],
    ["pow", fn([param("base", T), param("exp", T)], T, ["T"])],
    ["min", fn([param("values", T, { variadic: true })], T, ["T"])],
    ["max", fn([param("values", T, { variadic: true })], T, ["T"])],
    ["sum", fn([param("items", list(T))], T, ["T"])],

    ["sorted", fn([param("items", list(T)), param("key", any("key function"), { optional: true })], list(T), ["T"])],
    ["reversed", fn([param("items", list(T))], list(T), ["T"])],
    ["enumerate", fn([param("items", list(T))], list(tup([INT, T])), ["T"])],
    ["zip", fn([param("lists", any("list"), { variadic: true })], list(any("tuple")))],
    ["contains", fn([param("haystack", any("container")), param("needle", any("value"))], BOOL)],

    ["add", fn([param("target", { k: "atomic", inner: INT }), param("delta", INT)], INT)],
    ["subtract", fn([param("target", { k: "atomic", inner: INT }), param("delta", INT)], INT)],
    ["exchange", fn([param("target", { k: "atomic", inner: T }), param("value", T)], T, ["T"])],
    ["compare_exchange", fn([param("target", { k: "atomic", inner: T }), param("expected", T), param("value", T)], BOOL, ["T"])],

    ["close", fn([param("target", any("channel or file"))], NOTHING)],
    ["sleep", fn([param("milliseconds", INT)], NOTHING)],
    ["yield_now", fn([], NOTHING)],
    ["now_ms", fn([], FLOAT)],
    ["cpu_count", fn([], INT)],
    ["acquire", fn([param("lock", { k: "mutex", rw: false })], NOTHING)],
    ["acquire_lock", fn([param("lock", { k: "mutex", rw: false })], NOTHING)],
    ["release_lock", fn([param("lock", { k: "mutex", rw: false })], NOTHING)],
    ["task_state", fn([param("task", { k: "task", inner: T })], STRING, ["T"])],

    ["apply", fn([param("value", T), param("f", fn([param("x", T)], U))], U, ["T", "U"])],

    ["Ok", fn([param("value", T)], resultOf(T), ["T"])],
    ["Error", fn([param("message", STRING)], resultOf(T), ["T"])],
    ["Cancelled", resultOf(any("cancelled"))],
  ];
  return entries;
})();

export function inferTypes(mod: A.Module): InferResult {
  return new Inferencer().run(mod);
}
