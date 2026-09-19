// The Halka reference interpreter.
//
// Every evaluator is a generator so that any expression can suspend on a task,
// channel, or lock (see runtime/scheduler.ts). Control flow uses thrown
// signals: `give` (#9), `break`/`continue` (#8). Cleanup uses the frame's
// defer list, run in reverse on every exit path (#24).

import type * as A from "../parser/ast.ts";
import { type Span, DiagnosticBag, renderDiagnostic } from "../util/diagnostics.ts";
import {
  Env, Fiber, Channel, Mutex,
  type Value, type Suspend, type Frame, type FnV, type NativeV, type NativeCtx,
  NULL, NOTHING, TRUE, FALSE,
  int, float, str, bool, list, tuple,
  display, inspect, keyOf, valueEq, truthy, typeNameOf, codePoints,
} from "../runtime/value.ts";
import { Scheduler, Deadlock } from "../runtime/scheduler.ts";
import { installPrelude, builtinMethod } from "../runtime/prelude.ts";
import { convert, typeText, defaultFor, primitiveMatches } from "../runtime/convert.ts";

export type Ev = Generator<Suspend, Value, unknown>;
export type Ex = Generator<Suspend, void, unknown>;

// ---------------------------------------------------------------------------
// Control-flow signals
// ---------------------------------------------------------------------------

export class GiveSignal {
  value: Value;
  constructor(value: Value) { this.value = value; }
}
export class BreakSignal {}
export class ContinueSignal {}

export class HalkaRuntimeError extends Error {
  msg: string;
  span: Span | null;
  code: string;
  trace: string[];
  constructor(msg: string, span: Span | null, code = "R0001", trace: string[] = []) {
    super(msg);
    this.name = "HalkaRuntimeError";
    this.msg = msg;
    this.span = span;
    this.code = code;
    this.trace = trace;
  }
}

// ---------------------------------------------------------------------------
// Declaration tables
// ---------------------------------------------------------------------------

interface StructInfo { decl: A.StructDecl; fields: A.FieldDecl[] }
interface EnumInfo { decl: A.EnumDecl; variants: Map<string, A.EnumVariant> }

export interface InterpOptions {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Abort after this many scheduler steps (0 = unlimited). */
  stepLimit?: number;
  /** Capabilities granted to the program by the host (#45). */
  grants?: string[];
  color?: boolean;
}

export class Interpreter {
  readonly globals = new Env(null, null);
  readonly sched = new Scheduler();
  readonly structs = new Map<string, StructInfo>();
  readonly enums = new Map<string, EnumInfo>();
  readonly traits = new Map<string, A.TraitDecl>();
  /** typeName -> methodName -> function */
  readonly impls = new Map<string, Map<string, FnV>>();
  readonly capabilities = new Map<string, A.CapabilityDecl>();
  readonly macros = new Map<string, A.FnDecl>();
  readonly modules = new Map<string, Env>();

  out: (s: string) => void;
  errOut: (s: string) => void;
  color: boolean;

  /** Dynamic capability set, one entry per active call (#45). */
  private capStack: Set<string>[] = [new Set()];
  private callTrace: string[] = [];
  private moved = new WeakSet<object>();

  constructor(opts: InterpOptions = {}) {
    this.out = opts.out ?? ((s) => process.stdout.write(s + "\n"));
    this.errOut = opts.err ?? ((s) => process.stderr.write(s + "\n"));
    this.color = opts.color ?? false;
    this.sched.stepLimit = opts.stepLimit ?? 0;
    for (const g of opts.grants ?? []) this.capStack[0]!.add(g);
    installPrelude(this);
  }

  // ---- error helpers ----------------------------------------------------

  fail(msg: string, span: Span | null = null, code = "R0001"): never {
    throw new HalkaRuntimeError(msg, span, code, [...this.callTrace]);
  }

  private ctx(env: Env): NativeCtx {
    return {
      env,
      say: (s) => this.out(s),
      spawn: (n, g) => this.sched.spawn(n, g),
      callFn: (fn, args) => this.callValue(fn, args, null),
      fail: (m) => this.fail(m),
    };
  }

  // =======================================================================
  // Program entry
  // =======================================================================

  /** Load a module: hoist declarations, then run its top-level statements. */
  run(mod: A.Module): Value {
    this.hoist(mod.stmts, this.globals);
    const frame: Frame = { fnName: "<main>", defers: [], capabilities: new Set(), unsafeDepth: 0 };
    const env = new Env(this.globals, frame);
    const self = this;

    function* body(): Ev {
      try {
        yield* self.execStmts(env, mod.stmts);
      } catch (e) {
        if (e instanceof GiveSignal) return e.value;
        throw e;
      } finally {
        yield* self.runDefers(frame);
      }
      // A `main()` function, if present, is the entry point.
      const m = self.globals.lookup("main");
      if (m && (m.value.t === "fn" || m.value.t === "native")) {
        return yield* self.callValue(m.value, [], null);
      }
      return NOTHING;
    }

    const main = this.sched.spawn("main", body());
    try {
      this.sched.runUntil(main);
    } catch (e) {
      if (e instanceof Deadlock) this.fail("deadlock: every task is blocked waiting", null, "R0020");
      throw e;
    }
    if (main.state === "failed") throw main.error;
    // A task that failed and was never awaited would otherwise vanish silently;
    // one that was awaited has already been turned into an `Error` result (#31).
    for (const f of this.sched.unobservedFailures()) {
      const m = f.error instanceof HalkaRuntimeError ? f.error.msg : String(f.error);
      this.errOut(`warning: task \`${f.name}\` failed and its result was never awaited: ${m}`);
    }
    return main.result;
  }

  /** Register every declaration in a statement list before executing it. */
  hoist(stmts: A.Stmt[], env: Env): void {
    for (const s of stmts) this.hoistOne(s, env);
    // Trait/impl wiring needs all types registered first.
    for (const s of stmts) {
      if (s.kind === "ImplDecl") this.registerImpl(s, env);
      if (s.kind === "TraitDecl") this.registerTraitDefaults(s, env);
    }
  }

  private hoistOne(s: A.Stmt, env: Env): void {
    switch (s.kind) {
      case "FnDecl": {
        if (s.isMacro) { this.macros.set(s.name, s); return; }
        if (s.foreign) return;
        if (!s.body) return;
        if (env.hasLocal(s.name)) {
          this.fail(`\`${s.name}\` is already defined — Halka has no function overloading (rule #21)`, s.span, "E0302");
        }
        env.define(s.name, { t: "fn", name: s.name, decl: s, env }, false);
        return;
      }
      case "StructDecl": {
        if (s.foreign) return;
        this.structs.set(s.name, { decl: s, fields: s.fields });
        env.define(s.name, { t: "type", name: s.name, decl: s }, false);
        return;
      }
      case "EnumDecl": {
        const variants = new Map<string, A.EnumVariant>();
        for (const v of s.variants) variants.set(v.name, v);
        this.enums.set(s.name, { decl: s, variants });
        env.define(s.name, { t: "type", name: s.name, decl: s }, false);
        for (const v of s.variants) this.defineVariantCtor(env, s.name, v);
        return;
      }
      case "TraitDecl":
        this.traits.set(s.name, s);
        return;
      case "TypeAliasDecl":
        env.define(s.name, { t: "type", name: s.name, decl: s }, false);
        return;
      case "CapabilityDecl":
        this.capabilities.set(s.name, s);
        env.define(s.name, { t: "capability", name: s.name, perms: s.perms }, false);
        return;
      case "GenerateDecl":
        this.hoist(s.body.stmts, env);
        return;
      default:
        return;
    }
  }

  private defineVariantCtor(env: Env, enumName: string, v: A.EnumVariant): void {
    const fieldNames = v.fields.map((f) => f.name);
    if (!v.fields.length) {
      env.define(v.name, { t: "variant", enumName, name: v.name, fieldNames: [], fields: [] }, false);
      return;
    }
    const self = this;
    const native: NativeV = {
      t: "native",
      name: v.name,
      arity: [v.fields.length, v.fields.length],
      call(args) {
        if (args.length !== fieldNames.length) {
          self.fail(`${v.name} takes ${fieldNames.length} value(s), got ${args.length}`, v.span, "R0011");
        }
        return { t: "variant", enumName, name: v.name, fieldNames, fields: args };
      },
    };
    env.define(v.name, native, false);
  }

  private registerImpl(s: A.ImplDecl, env: Env): void {
    let table = this.impls.get(s.typeName);
    if (!table) { table = new Map(); this.impls.set(s.typeName, table); }
    for (const m of s.members) {
      if (!m.body) continue;
      table.set(m.name, { t: "fn", name: m.name, decl: m, env });
    }
    for (const traitName of s.traits) {
      const trait = this.traits.get(traitName);
      if (!trait) continue;
      for (const req of trait.members) {
        if (req.body) continue;
        if (!table.has(req.name)) {
          this.fail(`\`${s.typeName}\` implements \`${traitName}\` but is missing \`${req.name}\``, s.span, "E0402");
        }
      }
      // Inherit trait default methods.
      for (const d of trait.members) {
        if (d.body && !table.has(d.name)) table.set(d.name, { t: "fn", name: d.name, decl: d, env });
      }
    }
  }

  private registerTraitDefaults(_s: A.TraitDecl, _env: Env): void { /* wired at impl time */ }

  // =======================================================================
  // Statements
  // =======================================================================

  *execStmts(env: Env, stmts: A.Stmt[]): Ex {
    for (const s of stmts) yield* this.execStmt(env, s);
  }

  *execBlock(env: Env, block: A.Block): Ex {
    const scope = env.child();
    this.hoist(block.stmts, scope);
    yield* this.execStmts(scope, block.stmts);
  }

  *execStmt(env: Env, s: A.Stmt): Ex {
    switch (s.kind) {
      // --- declarations already hoisted -----------------------------------
      case "FnDecl": case "StructDecl": case "EnumDecl": case "TraitDecl":
      case "TypeAliasDecl": case "CapabilityDecl": case "ExternDecl":
      case "SpecializeDecl": case "ExportDecl":
        return;
      case "ImplDecl":
        if (!this.impls.has(s.typeName)) this.registerImpl(s, env);
        return;
      case "GenerateDecl":
        yield* this.execStmts(env, s.body.stmts);
        return;
      case "ImportDecl":
        yield* this.execImport(env, s);
        return;

      // --- bindings ---------------------------------------------------------
      case "LetStmt": {
        const v = s.value ? yield* this.eval(env, s.value) : NULL;
        this.bindPattern(env, s.pattern, v, true, s.span);
        return;
      }
      case "ConstDecl": {
        const v = yield* this.eval(env, s.value);
        env.define(s.name, v, false);
        return;
      }
      case "AssignStmt":
        yield* this.execAssign(env, s);
        return;

      // --- simple statements ------------------------------------------------
      case "ExprStmt":
        yield* this.eval(env, s.expr);
        return;
      case "SayStmt": {
        const parts: string[] = [];
        for (const a of s.args) parts.push(display(yield* this.eval(env, a)));
        this.out(parts.join(" "));
        return;
      }
      case "GiveStmt": {
        const v = s.value ? yield* this.eval(env, s.value) : NOTHING;
        throw new GiveSignal(v);
      }
      case "BreakStmt": throw new BreakSignal();
      case "ContinueStmt": throw new ContinueSignal();

      case "DeferStmt": {
        const frame = env.frame;
        if (!frame) this.fail("`defer` is only valid inside a function", s.span, "R0012");
        const self = this;
        const inner = s.stmt;
        frame.defers.push(function* () { yield* self.execStmt(env, inner); });
        return;
      }

      // --- control flow -----------------------------------------------------
      case "IfStmt": {
        if (truthy(yield* this.eval(env, s.cond))) return yield* this.execBlock(env, s.then);
        for (const e of s.elifs) {
          if (truthy(yield* this.eval(env, e.cond))) return yield* this.execBlock(env, e.block);
        }
        if (s.else) yield* this.execBlock(env, s.else);
        return;
      }

      case "WhileStmt": {
        for (;;) {
          if (!truthy(yield* this.eval(env, s.cond))) break;
          try {
            yield* this.execBlock(env, s.body);
          } catch (e) {
            if (e instanceof BreakSignal) break;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
          yield { kind: "yield" };
        }
        return;
      }

      case "ForStmt": {
        const iterable = yield* this.eval(env, s.iter);
        const items = this.iterate(iterable, s.iter.span);
        for (const item of items) {
          const scope = env.child();
          this.bindPattern(scope, s.pattern, item, true, s.span);
          try {
            yield* this.execBlock(scope, s.body);
          } catch (e) {
            if (e instanceof BreakSignal) return;
            if (e instanceof ContinueSignal) continue;
            throw e;
          }
        }
        return;
      }

      case "MatchStmt":
        yield* this.eval(env, s.expr);
        return;

      case "WithStmt": return yield* this.execWith(env, s);

      case "ParallelStmt": return yield* this.execParallel(env, s);

      case "UnsafeStmt": {
        const frame = env.frame;
        if (frame) frame.unsafeDepth++;
        try { yield* this.execBlock(env, s.body); }
        finally { if (frame) frame.unsafeDepth--; }
        return;
      }

      case "IntrinsicStmt": return yield* this.execIntrinsic(env, s);
    }
  }

  private *execAssign(env: Env, s: A.AssignStmt): Ex {
    const value = yield* this.eval(env, s.value);
    const t = s.target;

    switch (t.kind) {
      case "Ident": {
        const b = env.lookup(t.name);
        if (b && !b.mutable) this.fail(`\`${t.name}\` cannot be reassigned`, s.span, "R0013");
        if (!b) {
          const f = fieldOfSelf(env, t.name);
          if (f) { f.set(value); return; }
        }
        env.set(t.name, value);
        return;
      }
      case "MemberExpr": {
        const obj = yield* this.eval(env, t.obj);
        this.setMember(obj, t.name, value, s.span);
        return;
      }
      case "IndexExpr": {
        const obj = yield* this.eval(env, t.obj);
        const idx = yield* this.eval(env, t.index);
        this.setIndex(obj, idx, value, s.span);
        return;
      }
      case "DerefExpr": {
        const r = yield* this.eval(env, t.expr);
        if (r.t === "ref") {
          if (!r.mut) this.fail("cannot assign through a shared borrow — use `borrow mut` or `&mut`", s.span, "E0501");
          r.set(value);
          return;
        }
        if (r.t === "rawptr") {
          if (!env.frame || env.frame.unsafeDepth === 0) {
            this.fail("writing through a raw pointer requires an `unsafe:` block (rule #46)", s.span, "E0502");
          }
          if (r.cell) r.cell.v = value;
          return;
        }
        this.fail("`*` can only assign through a reference or a raw pointer", s.span, "R0014");
        return;
      }
      case "TupleExpr": case "ListExpr": {
        const pat = this.exprToPattern(t);
        this.bindPattern(env, pat, value, false, s.span);
        return;
      }
      default:
        this.fail("this is not something you can assign to", s.span, "E0108");
    }
  }

  private *execWith(env: Env, s: A.WithStmt): Ex {
    if (s.capability) {
      const name = s.subject.kind === "Ident" ? s.subject.name
        : s.subject.kind === "MemberExpr" ? memberPath(s.subject)
        : null;
      if (!name) this.fail("`with capability` expects a capability name", s.span, "E0503");
      const set = this.capStack[this.capStack.length - 1]!;
      const had = set.has(name);
      set.add(name);
      try { yield* this.execBlock(env, s.body); }
      finally { if (!had) set.delete(name); }
      return;
    }

    const subject = yield* this.eval(env, s.subject);
    if (subject.t !== "mutex") {
      this.fail(`\`with\` expects a mutex, found ${typeNameOf(subject)}`, s.subject.span, "R0015");
    }
    yield { kind: "lock", m: subject.m, write: true };
    try { yield* this.execBlock(env, s.body); }
    finally { this.sched.unlock(subject.m, true); }
  }

  private *execParallel(env: Env, s: A.ParallelStmt): Ex {
    const scope = env.child();
    this.hoist(s.body.stmts, scope);
    const fibers: Fiber[] = [];
    const self = this;
    for (const st of s.body.stmts) {
      const f = this.sched.spawn("parallel", (function* (): Ev {
        yield* self.execStmt(scope, st);
        return NOTHING;
      })());
      fibers.push(f);
    }
    for (const f of fibers) {
      if (!f.finished) yield { kind: "await", task: f };
      if (f.state === "failed") throw f.error;
    }
  }

  private *execIntrinsic(env: Env, s: A.IntrinsicStmt): Ex {
    switch (s.op) {
      case "send": {
        const ch = yield* this.eval(env, s.target);
        if (ch.t !== "channel") this.fail("`send` expects a channel", s.target.span, "R0016");
        const v = s.value ? yield* this.eval(env, s.value) : NOTHING;
        const res = yield { kind: "send", ch: ch.ch, value: v };
        if (res && typeof res === "object" && "error" in (res as object)) {
          this.fail(String((res as { error: string }).error), s.span, "R0017");
        }
        return;
      }
      case "store": {
        const a = yield* this.eval(env, s.target);
        if (a.t !== "atomic") this.fail("`store` expects an atomic", s.target.span, "R0018");
        a.box.v = s.value ? yield* this.eval(env, s.value) : NOTHING;
        return;
      }
      case "cancel": {
        const t = yield* this.eval(env, s.target);
        if (t.t !== "task") this.fail("`cancel` expects a task", s.target.span, "R0019");
        this.sched.cancel(t.fiber);
        return;
      }
      case "register": {
        yield* this.eval(env, s.target);
        return; // callbacks are registered by the FFI layer; a no-op in stage 0
      }
      case "release": {
        const m = yield* this.eval(env, s.target);
        if (m.t === "mutex") this.sched.unlock(m.m, true);
        return;
      }
      case "grant": case "revoke": {
        const name = s.target.kind === "Ident" ? s.target.name : null;
        if (!name) return;
        const set = this.capStack[this.capStack.length - 1]!;
        if (s.op === "grant") set.add(name);
        else set.delete(name);
        return;
      }
      default:
        return;
    }
  }

  private *execImport(env: Env, s: A.ImportDecl): Ex {
    if (s.foreign) {
      // FFI is a native-backend feature; make the boundary explicit rather than silent.
      env.define(s.alias ?? baseName(s.path), { t: "module", name: s.path, exports: new Map() }, false);
      return;
    }
    const mod = this.modules.get(s.path);
    if (!mod) {
      this.fail(`module \`${s.path}\` was not found`, s.span, "E0201");
    }
    if (s.form === "module") {
      const exports = new Map<string, Value>();
      for (const n of mod.localNames()) exports.set(n, mod.lookup(n)!.value);
      env.define(s.alias ?? baseName(s.path), { t: "module", name: s.path, exports }, false);
      return;
    }
    for (const n of s.names) {
      const b = mod.lookup(n.name);
      if (!b) this.fail(`\`${n.name}\` is not exported by \`${s.path}\``, s.span, "E0202");
      env.define(n.alias ?? n.name, b.value, false);
    }
  }

  // =======================================================================
  // Expressions
  // =======================================================================

  *eval(env: Env, e: A.Expr): Ev {
    switch (e.kind) {
      case "IntLit": return int(e.value);
      case "FloatLit": return float(e.value);
      case "BoolLit": return bool(e.value);
      case "NullLit": return NULL;
      case "NothingLit": return NOTHING;
      case "CharLit": return { t: "char", v: e.value };
      case "EllipsisExpr": return NOTHING;

      case "StrLit": {
        let out = "";
        for (const p of e.parts) {
          if (p.kind === "text") out += p.text ?? "";
          else out += display(yield* this.eval(env, p.expr!));
        }
        return str(out);
      }

      case "Ident": {
        const b = env.lookup(e.name);
        if (!b) {
          const f = fieldOfSelf(env, e.name);
          if (f) return f.get();
          this.fail(`\`${e.name}\` is not defined${this.didYouMean(env, e.name)}`, e.span, "E0203");
        }
        if (typeof b.value === "object" && this.moved.has(b.value as object)) {
          this.fail(`\`${e.name}\` was moved and can no longer be used (rule #25)`, e.span, "E0504");
        }
        return b.value;
      }

      case "TupleExpr": {
        const vs: Value[] = [];
        for (const el of e.elements) vs.push(yield* this.eval(env, el));
        return tuple(vs);
      }
      case "ListExpr": {
        const vs: Value[] = [];
        for (const el of e.elements) vs.push(yield* this.eval(env, el));
        return list(vs);
      }
      case "SetExpr": {
        const m = new Map<string, Value>();
        for (const el of e.elements) {
          const v = yield* this.eval(env, el);
          m.set(keyOf(v), v);
        }
        return { t: "set", v: m };
      }
      case "MapExpr": {
        const m = new Map<string, { k: Value; v: Value }>();
        for (const en of e.entries) {
          const k = yield* this.eval(env, en.key);
          const v = yield* this.eval(env, en.value);
          m.set(keyOf(k), { k, v });
        }
        return { t: "map", v: m };
      }
      case "RecordExpr": {
        const m = new Map<string, Value>();
        for (const en of e.entries) m.set(en.key, yield* this.eval(env, en.value));
        return { t: "record", v: m };
      }
      case "BlockExpr": {
        // A suite used as a value is a thunk; run it now and yield `nothing`.
        yield* this.execBlock(env, e.block);
        return NOTHING;
      }

      case "UnaryExpr": return yield* this.evalUnary(env, e);
      case "BinaryExpr": return yield* this.evalBinary(env, e);
      case "RangeExpr": return yield* this.evalRange(env, e);
      case "IsExpr": return yield* this.evalIs(env, e);
      case "CastExpr": return yield* this.evalCast(env, e);

      case "MemberExpr": {
        const obj = yield* this.eval(env, e.obj);
        return this.getMember(obj, e.name, e.span);
      }
      case "IndexExpr": {
        const obj = yield* this.eval(env, e.obj);
        const idx = yield* this.eval(env, e.index);
        return this.getIndex(obj, idx, e.span);
      }
      case "SliceExpr": {
        const obj = yield* this.eval(env, e.obj);
        const st = e.start ? yield* this.eval(env, e.start) : null;
        const en = e.end ? yield* this.eval(env, e.end) : null;
        const sp = e.step ? yield* this.eval(env, e.step) : null;
        return this.sliceOf(obj, st, en, sp, e.span);
      }

      case "CallExpr": return yield* this.evalCall(env, e);
      case "ApplyExpr": {
        const v = yield* this.eval(env, e.value);
        const f = yield* this.eval(env, e.fn);
        return yield* this.callValue(f, [v], e.span);
      }

      case "MatchExpr": return yield* this.evalMatch(env, e);

      // --- references & ownership (#14, #25, #46) --------------------------
      case "BorrowExpr": case "RefExpr": {
        const mut = e.kind === "BorrowExpr" ? e.mut : e.mut;
        const inner = e.kind === "BorrowExpr" ? e.expr : e.expr;
        return yield* this.makeRef(env, inner, mut, e.span);
      }
      case "DerefExpr": {
        const r = yield* this.eval(env, e.expr);
        if (r.t === "ref") return r.get();
        if (r.t === "rawptr") {
          if (!env.frame || env.frame.unsafeDepth === 0) {
            this.fail("dereferencing a raw pointer requires an `unsafe:` block (rule #46)", e.span, "E0502");
          }
          return r.cell ? r.cell.v : NULL;
        }
        this.fail(`cannot dereference ${typeNameOf(r)}`, e.span, "R0021");
        break;
      }
      case "MoveExpr": {
        const v = yield* this.eval(env, e.expr);
        if (e.expr.kind === "Ident") {
          const b = env.lookup(e.expr.name);
          if (b && typeof b.value === "object") this.moved.add(b.value as object);
        }
        return v;
      }
      case "RawExpr": {
        const v = yield* this.eval(env, e.expr);
        return { t: "rawptr", addr: rawAddr(), cell: { v } };
      }

      // --- concurrency (#26–#32) ------------------------------------------
      case "StartExpr": return yield* this.evalStart(env, e);
      case "AwaitExpr": {
        const t = yield* this.eval(env, e.expr);
        if (t.t !== "task") return t; // awaiting a plain value is the value
        if (!t.fiber.finished) yield { kind: "await", task: t.fiber };
        return this.taskResult(t.fiber);
      }
      case "ReceiveExpr": {
        const c = yield* this.eval(env, e.channel);
        if (c.t !== "channel") this.fail("`receive` expects a channel", e.span, "R0016");
        return (yield { kind: "recv", ch: c.ch }) as Value;
      }
      case "MakeExpr": {
        if (e.what === "channel") {
          const cap = e.capacity ? yield* this.eval(env, e.capacity) : null;
          const n = cap && cap.t === "int" ? Number(cap.v) : 0;
          return { t: "channel", ch: new Channel(n) };
        }
        return { t: "mutex", m: new Mutex(e.what === "rwmutex") };
      }
      case "AtomicExpr": {
        const v = yield* this.eval(env, e.init);
        return { t: "atomic", box: { v } };
      }
      case "LoadExpr": {
        const a = yield* this.eval(env, e.target);
        if (a.t !== "atomic") this.fail("`load` expects an atomic", e.span, "R0018");
        return a.box.v;
      }
      case "CancelledExpr": {
        const f = this.currentFiber;
        return bool(!!f?.cancelRequested);
      }

      // --- compile-time tier (#39–#43) -------------------------------------
      case "CompileExpr":
        // The reference interpreter evaluates the compile tier eagerly with the
        // same evaluator (R20); the native backend folds it at build time.
        return yield* this.eval(env, e.expr);
      case "ReflectExpr": return yield* this.evalReflect(env, e);

      // --- device / GPU (#44) ----------------------------------------------
      case "DeviceExpr": return yield* this.eval(env, e.expr);
      case "LaunchExpr": {
        if (e.config) yield* this.eval(env, e.config);
        return yield* this.eval(env, e.call);
      }

      case "AcquireExpr": {
        const decl = this.capabilities.get(e.capability);
        this.capStack[this.capStack.length - 1]!.add(e.capability);
        return { t: "capability", name: e.capability, perms: decl?.perms ?? [] };
      }

      case "ForeignExpr":
        this.fail(
          `\`${e.lang}\` interop needs the native backend; the reference interpreter cannot call ${e.lang.toUpperCase()} code`,
          e.span, "R0030",
        );
        break;

      case "FnRefExpr": {
        const b = env.lookup(e.name);
        if (!b) this.fail(`\`${e.name}\` is not defined`, e.span, "E0203");
        return b.value;
      }
    }
    this.fail(`cannot evaluate ${(e as A.Node).kind}`, (e as A.Node).span, "R0099");
  }

  private get currentFiber(): Fiber | null { return this.activeFiber; }
  private activeFiber: Fiber | null = null;

  // ---- operators --------------------------------------------------------

  private *evalUnary(env: Env, e: A.UnaryExpr): Ev {
    const v = yield* this.eval(env, e.operand);
    switch (e.op) {
      case "not": return bool(!truthy(v));
      case "+":
        if (v.t === "int" || v.t === "float") return v;
        this.fail(`unary \`+\` expects a number, found ${typeNameOf(v)}`, e.span, "E0401");
        break;
      case "-":
        if (v.t === "int") return int(-v.v);
        if (v.t === "float") return float(-v.v);
        this.fail(`unary \`-\` expects a number, found ${typeNameOf(v)}`, e.span, "E0401");
    }
    return NULL;
  }

  private *evalBinary(env: Env, e: A.BinaryExpr): Ev {
    // `or` / `and` short-circuit and double as null-coalescing (R11).
    if (e.op === "or") {
      const l = yield* this.eval(env, e.lhs);
      return truthy(l) ? l : yield* this.eval(env, e.rhs);
    }
    if (e.op === "and") {
      const l = yield* this.eval(env, e.lhs);
      return truthy(l) ? yield* this.eval(env, e.rhs) : l;
    }

    const a = yield* this.eval(env, e.lhs);
    const b = yield* this.eval(env, e.rhs);
    return this.binop(e.op, a, b, e.span);
  }

  binop(op: A.BinaryOp, a: Value, b: Value, span: Span | null): Value {
    switch (op) {
      case "==": return bool(valueEq(a, b));
      case "!=": return bool(!valueEq(a, b));
    }

    // string / char concatenation and comparison
    if ((a.t === "string" || a.t === "char") && (b.t === "string" || b.t === "char")) {
      const x = a.v, y = b.v;
      switch (op) {
        case "+": return str(x + y);
        case "<": return bool(x < y);
        case "<=": return bool(x <= y);
        case ">": return bool(x > y);
        case ">=": return bool(x >= y);
      }
    }
    if (a.t === "string" && op === "+") return str(a.v + display(b));
    if (b.t === "string" && op === "+") return str(display(a) + b.v);

    if (a.t === "list" && b.t === "list" && op === "+") return list([...a.v, ...b.v]);

    const bothInt = a.t === "int" && b.t === "int";
    if ((a.t === "int" || a.t === "float") && (b.t === "int" || b.t === "float")) {
      if (bothInt) {
        const x = (a as { v: bigint }).v, y = (b as { v: bigint }).v;
        switch (op) {
          case "+": return int(x + y);
          case "-": return int(x - y);
          case "*": return int(x * y);
          case "%":
            if (y === 0n) this.fail("modulo by zero", span, "R0002");
            return int(((x % y) + y) % y); // floored, matching the `//`-free design
          case "/":
            // R21: `/` always yields a float so `3 / 2` is 1.5, not 1.
            if (y === 0n) this.fail("division by zero", span, "R0002");
            return float(Number(x) / Number(y));
          case "<": return bool(x < y);
          case "<=": return bool(x <= y);
          case ">": return bool(x > y);
          case ">=": return bool(x >= y);
        }
      }
      const x = a.t === "int" ? Number(a.v) : a.v;
      const y = b.t === "int" ? Number(b.v) : b.v;
      switch (op) {
        case "+": return float(x + y);
        case "-": return float(x - y);
        case "*": return float(x * y);
        case "/":
          if (y === 0) this.fail("division by zero", span, "R0002");
          return float(x / y);
        case "%":
          if (y === 0) this.fail("modulo by zero", span, "R0002");
          return float(((x % y) + y) % y);
        case "<": return bool(x < y);
        case "<=": return bool(x <= y);
        case ">": return bool(x > y);
        case ">=": return bool(x >= y);
      }
    }

    this.fail(`\`${op}\` is not defined for ${typeNameOf(a)} and ${typeNameOf(b)}`, span, "E0401");
  }

  private *evalRange(env: Env, e: A.RangeExpr): Ev {
    const lo = e.lo ? yield* this.eval(env, e.lo) : int(0);
    const hi = e.hi ? yield* this.eval(env, e.hi) : null;
    const st = e.step ? yield* this.eval(env, e.step) : null;
    const toI = (v: Value): bigint => v.t === "int" ? v.v : v.t === "float" ? BigInt(Math.trunc(v.v)) : this.fail("a range needs whole numbers", e.span, "E0401");
    return { t: "range", lo: toI(lo), hi: hi ? toI(hi) : null, inclusive: e.inclusive, step: st ? toI(st) : 1n };
  }

  private *evalIs(env: Env, e: A.IsExpr): Ev {
    const v = yield* this.eval(env, e.expr);
    switch (e.test) {
      case "null": return bool(v.t === "null");
      case "nothing": return bool(v.t === "nothing");
      case "error": return bool(v.t === "variant" && v.name === "Error");
      case "ok": return bool(v.t === "variant" && v.name === "Ok");
      case "cancelled": return bool(v.t === "variant" && v.name === "Cancelled");
    }
    if (v.t === "variant" && v.name === e.test) return TRUE;
    if (v.t === "variant" && v.enumName === e.test) return TRUE;
    if (v.t === "struct" && v.name === e.test) return TRUE;
    return bool(typeNameOf(v) === e.test || primitiveMatches(v, e.test));
  }

  private *evalCast(env: Env, e: A.CastExpr): Ev {
    const v = yield* this.eval(env, e.expr);
    const target = typeText(e.type);
    const r = convert(v, target);
    if (e.fallible) {
      // `to` yields a Result (#15).
      if (r.ok) return this.mkVariant("Result", "Ok", ["value"], [r.value]);
      return this.mkVariant("Result", "Error", ["message"], [str(r.error)]);
    }
    if (!r.ok) this.fail(`${r.error} — use \`to ${target}\` for a conversion that can fail (rule #15)`, e.span, "E0403");
    return r.value;
  }

  mkVariant(enumName: string, name: string, fieldNames: string[], fields: Value[]): Value {
    return { t: "variant", enumName, name, fieldNames, fields };
  }

  // ---- calls ------------------------------------------------------------

  private *evalCall(env: Env, e: A.CallExpr): Ev {
    // Struct construction: `User(name: "x", age: 1)` or positional.
    if (e.callee.kind === "Ident") {
      const info = this.structs.get(e.callee.name);
      if (info) return yield* this.constructStruct(env, info, e);
      const mac = this.macros.get(e.callee.name);
      if (mac) return yield* this.expandMacro(env, mac, e);
    }

    let fnVal: Value;
    let self: Value | undefined;
    if (e.callee.kind === "MemberExpr") {
      const obj = yield* this.eval(env, e.callee.obj);
      const m = this.getMember(obj, e.callee.name, e.callee.span);
      if (m.t === "bound") { fnVal = m.fn; self = m.recv; }
      else { fnVal = m; if (obj.t === "struct" || obj.t === "variant") self = obj; }
    } else {
      fnVal = yield* this.eval(env, e.callee);
    }

    const args: Value[] = [];
    const named = new Map<string, Value>();
    for (const a of e.args) {
      if (a.value.kind === "EllipsisExpr") continue;
      const v = yield* this.eval(env, a.value);
      if (a.name) named.set(a.name, v);
      else args.push(v);
    }
    return yield* this.callValue(fnVal, args, e.span, named, self);
  }

  *callValue(fn: Value, args: Value[], span: Span | null, named?: Map<string, Value>, self?: Value): Ev {
    if (fn.t === "bound") return yield* this.callValue(fn.fn, args, span, named, fn.recv);

    if (fn.t === "native") {
      // A method's arity counts its receiver, so check the full argument list.
      const all = self !== undefined ? [self, ...args] : args;
      const [min, max] = fn.arity;
      if (all.length < min || all.length > max) {
        const shown = self !== undefined ? [Math.max(0, min - 1), max === Infinity ? max : max - 1] as const : [min, max] as const;
        this.fail(`\`${fn.name}\` takes ${arityText(shown[0], shown[1])}, got ${args.length}`, span, "E0404");
      }
      const r = fn.call(all, this.ctx(this.globals));
      if (r && typeof r === "object" && Symbol.iterator in (r as object) && typeof (r as Generator).next === "function") {
        return yield* (r as Generator<Suspend, Value, unknown>);
      }
      return r as Value;
    }

    if (fn.t !== "fn") this.fail(`${typeNameOf(fn)} is not callable`, span, "E0405");

    const decl = fn.decl;
    const frame: Frame = { fnName: fn.name, defers: [], capabilities: new Set(), unsafeDepth: 0 };
    const env = new Env(fn.env, frame);

    // #45 — capability check
    if (decl.requires.length) {
      const held = new Set(this.capStack[this.capStack.length - 1]);
      for (const a of args) if (a.t === "capability") held.add(a.name);
      for (const need of decl.requires) {
        const root = need.split(".")[0]!;
        if (!held.has(need) && !held.has(root)) {
          this.fail(
            `\`${fn.name}\` requires the \`${need}\` capability, which is not held here (rule #45)`,
            span, "E0505",
          );
        }
      }
    }

    // Bind parameters (#18 defaults, #19 variadics)
    const ps = decl.params;
    let i = 0;
    for (const p of ps) {
      if (p.variadic) {
        const rest = args.slice(i);
        i = args.length;
        env.define(p.name === "..." ? "_varargs" : p.name, list(rest));
        continue;
      }
      let v: Value | undefined = i < args.length ? args[i++] : undefined;
      if (v === undefined && named?.has(p.name)) v = named.get(p.name);
      if (v === undefined) {
        if (p.default) v = yield* this.eval(env, p.default);
        else this.fail(`\`${fn.name}\` is missing the argument \`${p.name}\``, span, "E0406");
      }
      env.define(p.name, v!);
    }
    if (self !== undefined && !ps.some((p) => p.name === "self")) {
      env.define("self", self, false);
      // Bare field names inside a method read and write through the receiver
      // (#16's `print(), say name`); see `fieldOfSelf`.
      frame.self = self;
    }
    if (i < args.length && !ps.some((p) => p.variadic)) {
      this.fail(`\`${fn.name}\` takes ${ps.length} argument(s), got ${args.length}`, span, "E0404");
    }

    if (this.callTrace.length > 2000) this.fail("call stack overflow", span, "R0003");
    this.callTrace.push(fn.name);
    this.capStack.push(new Set(this.capStack[this.capStack.length - 1]));

    let result: Value = NOTHING;
    try {
      if (decl.body) yield* this.execStmts(env, decl.body.stmts);
    } catch (e) {
      if (e instanceof GiveSignal) result = e.value;
      else {
        // Defers still run on the way out.
        yield* this.runDefers(frame);
        this.callTrace.pop();
        this.capStack.pop();
        throw e;
      }
    }
    yield* this.runDefers(frame);
    this.callTrace.pop();
    this.capStack.pop();
    return result;
  }

  *runDefers(frame: Frame): Ex {
    // #24 — reverse registration order, and a failing defer must not hide the rest.
    while (frame.defers.length) {
      const d = frame.defers.pop()!;
      try { yield* d(); }
      catch (e) { if (e instanceof GiveSignal) continue; this.errOut(`defer failed: ${String(e)}`); }
    }
  }

  private *constructStruct(env: Env, info: StructInfo, e: A.CallExpr): Ev {
    const fields = new Map<string, Value>();
    const positional: Value[] = [];
    const named = new Map<string, Value>();
    let elided = false;
    for (const a of e.args) {
      if (a.value.kind === "EllipsisExpr") { elided = true; continue; }
      const v = yield* this.eval(env, a.value);
      if (a.name) named.set(a.name, v);
      else positional.push(v);
    }
    let i = 0;
    for (const f of info.fields) {
      let v: Value | undefined;
      if (named.has(f.name)) v = named.get(f.name);
      else if (i < positional.length) v = positional[i++];
      else if (f.default) v = yield* this.eval(env, f.default);
      else if (elided) v = defaultFor(f.type);
      else this.fail(`\`${info.decl.name}\` is missing the field \`${f.name}\``, e.span, "E0407");
      fields.set(f.name, v!);
    }
    return { t: "struct", name: info.decl.name, fields };
  }

  /**
   * #40 — macros. The reference interpreter expands them at the call site with
   * arguments already evaluated; the native backend performs the full
   * source-level, hygienic expansion.
   */
  private *expandMacro(env: Env, decl: A.FnDecl, e: A.CallExpr): Ev {
    const frame: Frame = { fnName: decl.name, defers: [], capabilities: new Set(), unsafeDepth: 0 };
    const scope = new Env(env, frame); // hygienic: a fresh scope
    let i = 0;
    for (const p of decl.params) {
      const a = e.args[i++];
      scope.define(p.name, a ? yield* this.eval(env, a.value) : (p.default ? yield* this.eval(env, p.default) : NULL));
    }
    let result: Value = NOTHING;
    try { if (decl.body) yield* this.execStmts(scope, decl.body.stmts); }
    catch (err) { if (err instanceof GiveSignal) result = err.value; else throw err; }
    yield* this.runDefers(frame);
    return result;
  }

  private *evalStart(env: Env, e: A.StartExpr): Ev {
    const call = e.call;
    if (call.kind !== "CallExpr") {
      // `start expr` where expr is not a call: evaluate it in a fiber anyway.
      const self = this;
      const f = this.sched.spawn("task", (function* (): Ev { return yield* self.eval(env, call); })());
      return { t: "task", fiber: f };
    }
    // Arguments are evaluated eagerly at `start`, the body runs in the fiber.
    let fnVal: Value;
    let selfV: Value | undefined;
    if (call.callee.kind === "MemberExpr") {
      const obj = yield* this.eval(env, call.callee.obj);
      const m = this.getMember(obj, call.callee.name, call.callee.span);
      if (m.t === "bound") { fnVal = m.fn; selfV = m.recv; } else { fnVal = m; selfV = obj; }
    } else {
      fnVal = yield* this.eval(env, call.callee);
    }
    const args: Value[] = [];
    for (const a of call.args) if (a.value.kind !== "EllipsisExpr") args.push(yield* this.eval(env, a.value));

    const self = this;
    const name = call.callee.kind === "Ident" ? call.callee.name : "task";
    const fiber = this.sched.spawn(name, (function* (): Ev {
      const prev = self.activeFiber;
      try { return yield* self.callValue(fnVal, args, e.span, undefined, selfV); }
      finally { self.activeFiber = prev; }
    })());
    return { t: "task", fiber };
  }

  /** #31 — `await` yields the value, or `Error(...)` / `Cancelled` states. */
  taskResult(f: Fiber): Value {
    if (f.state === "cancelled" || f.cancelRequested) {
      return this.mkVariant("Result", "Cancelled", [], []);
    }
    if (f.state === "failed") {
      const m = f.error instanceof HalkaRuntimeError ? f.error.msg : String(f.error);
      return this.mkVariant("Result", "Error", ["message"], [str(m)]);
    }
    return f.result;
  }

  private *evalReflect(env: Env, e: A.ReflectExpr): Ev {
    // #42 — one mechanism, usable at runtime or compile time.
    let name: string;
    let kind: string;
    let fields: Value[] = [];
    let methods: Value[] = [];

    const target = e.target;
    if (target.kind === "Ident" && (this.structs.has(target.name) || this.enums.has(target.name))) {
      name = target.name;
      const st = this.structs.get(name);
      if (st) {
        kind = "Struct";
        fields = st.fields.map((f) => str(f.name));
      } else {
        kind = "Enum";
        fields = [...this.enums.get(name)!.variants.keys()].map(str);
      }
      methods = [...(this.impls.get(name)?.keys() ?? [])].map(str);
    } else {
      const v = yield* this.eval(env, target);
      name = typeNameOf(v);
      kind = v.t === "struct" ? "Struct" : v.t === "variant" ? "Enum" : "Primitive";
      if (v.t === "struct") fields = [...v.fields.keys()].map(str);
      methods = [...(this.impls.get(name)?.keys() ?? [])].map(str);
    }

    const m = new Map<string, Value>();
    m.set("name", str(name));
    m.set("kind", { t: "variant", enumName: "Kind", name: kind, fieldNames: [], fields: [] });
    m.set("fields", list(fields));
    m.set("methods", list(methods));
    return { t: "record", v: m };
  }

  private *makeRef(env: Env, target: A.Expr, mut: boolean, span: Span): Ev {
    if (target.kind === "Ident") {
      const b = env.lookup(target.name);
      if (!b) this.fail(`\`${target.name}\` is not defined`, span, "E0203");
      return { t: "ref", mut, label: target.name, get: () => b.value, set: (v) => { b.value = v; } };
    }
    if (target.kind === "IndexExpr") {
      const obj = yield* this.eval(env, target.obj);
      const idx = yield* this.eval(env, target.index);
      const self = this;
      return {
        t: "ref", mut, label: "element",
        get: () => self.getIndex(obj, idx, span),
        set: (v) => self.setIndex(obj, idx, v, span),
      };
    }
    if (target.kind === "MemberExpr") {
      const obj = yield* this.eval(env, target.obj);
      const self = this;
      const nm = target.name;
      return {
        t: "ref", mut, label: nm,
        get: () => self.getMember(obj, nm, span),
        set: (v) => self.setMember(obj, nm, v, span),
      };
    }
    const v = yield* this.eval(env, target);
    return { t: "ref", mut, label: "value", get: () => v, set: () => this.fail("cannot assign to a temporary", span, "E0506") };
  }

  // ---- match (#10) ------------------------------------------------------

  private *evalMatch(env: Env, e: A.MatchExpr): Ev {
    const subject = yield* this.eval(env, e.subject);
    for (const arm of e.arms) {
      const scope = env.child();
      if (!this.matchPattern(scope, arm.pattern, subject)) continue;
      if (arm.guard && !truthy(yield* this.eval(scope, arm.guard))) continue;
      return yield* this.runArm(scope, arm.body);
    }
    if (e.elseArm) return yield* this.runArm(env.child(), e.elseArm);
    return NOTHING;
  }

  private *runArm(scope: Env, body: A.Block): Ev {
    // A single-expression arm yields its value (R18); otherwise the arm is a block.
    if (body.stmts.length === 1 && body.stmts[0]!.kind === "ExprStmt") {
      return yield* this.eval(scope, (body.stmts[0] as A.ExprStmt).expr);
    }
    yield* this.execBlock(scope, body);
    return NOTHING;
  }

  matchPattern(env: Env, p: A.Pattern, v: Value): boolean {
    switch (p.kind) {
      case "WildcardPat": return true;
      case "NullPat": return v.t === "null";
      case "RestPat":
        if (p.name) env.define(p.name, v);
        return true;

      case "BindPat":
        env.define(p.name, v);
        return true;

      case "TypePat": {
        // A capitalised name in a pattern: a nullary variant, a type test, or a binding.
        if (v.t === "variant" && v.name === p.name) return true;
        if (v.t === "struct" && v.name === p.name) return true;
        if (typeNameOf(v) === p.name || primitiveMatches(v, p.name)) return true;
        // Unknown capitalised name: bind it (matches the `match info.kind, Struct,` idiom).
        if (!this.structs.has(p.name) && !this.enums.has(p.name) && !isKnownTypeWord(p.name)) {
          env.define(p.name, v);
          return true;
        }
        return false;
      }

      case "LiteralPat": {
        const lit = evalConst(p.value);
        return lit !== null && valueEq(lit, v);
      }

      case "TuplePat": {
        if (v.t !== "tuple" && v.t !== "list") return false;
        return this.matchSeq(env, p.elements, v.v);
      }

      case "ListPat": {
        if (v.t !== "list" && v.t !== "tuple") return false;
        return this.matchSeq(env, p.elements, v.v);
      }

      case "MapPat": {
        if (v.t !== "map") return false;
        for (const en of p.entries) {
          const k = evalConst(en.key);
          if (!k) return false;
          const got = v.v.get(keyOf(k));
          if (!got) return false;
          if (!this.matchPattern(env, en.value, got.v)) return false;
        }
        return true;
      }

      case "VariantPat": {
        if (v.t === "variant") {
          if (v.name !== p.name) return false;
          return this.matchSeq(env, p.args, v.fields);
        }
        if (v.t === "struct" && v.name === p.name) {
          return this.matchSeq(env, p.args, [...v.fields.values()]);
        }
        return false;
      }

      case "StructPat": {
        if (v.t !== "struct" || v.name !== p.name) return false;
        for (const f of p.fields) {
          const got = v.fields.get(f.name);
          if (got === undefined) return false;
          if (!this.matchPattern(env, f.pattern, got)) return false;
        }
        return true;
      }
    }
    return false;
  }

  private matchSeq(env: Env, pats: A.Pattern[], vals: Value[]): boolean {
    const restAt = pats.findIndex((x) => x.kind === "RestPat");
    if (restAt === -1) {
      if (pats.length !== vals.length) return false;
      return pats.every((pp, i) => this.matchPattern(env, pp, vals[i]!));
    }
    const before = pats.slice(0, restAt);
    const after = pats.slice(restAt + 1);
    if (vals.length < before.length + after.length) return false;
    for (let i = 0; i < before.length; i++) if (!this.matchPattern(env, before[i]!, vals[i]!)) return false;
    for (let i = 0; i < after.length; i++) {
      if (!this.matchPattern(env, after[after.length - 1 - i]!, vals[vals.length - 1 - i]!)) return false;
    }
    const rest = pats[restAt] as A.RestPat;
    if (rest.name) env.define(rest.name, list(vals.slice(before.length, vals.length - after.length)));
    return true;
  }

  // ---- destructuring (#4) -----------------------------------------------

  bindPattern(env: Env, p: A.Pattern, v: Value, declare: boolean, span: Span): void {
    switch (p.kind) {
      case "BindPat":
        if (declare) env.define(p.name, v);
        else env.set(p.name, v);
        return;
      case "WildcardPat": return;
      case "RestPat":
        if (p.name) { if (declare) env.define(p.name, v); else env.set(p.name, v); }
        return;
      case "TypePat":
        if (declare) env.define(p.name, v); else env.set(p.name, v);
        return;
      case "TuplePat": case "ListPat": {
        const items = v.t === "tuple" || v.t === "list" ? v.v
          : v.t === "string" ? codePoints(v.v).map((c) => str(c))
          : this.fail(`cannot destructure ${typeNameOf(v)}`, span, "E0408");
        const restAt = p.elements.findIndex((x) => x.kind === "RestPat");
        if (restAt === -1) {
          if (items.length !== p.elements.length) {
            this.fail(`expected ${p.elements.length} value(s) to unpack, found ${items.length}`, span, "E0409");
          }
          p.elements.forEach((el, i) => this.bindPattern(env, el, items[i]!, declare, span));
          return;
        }
        const before = p.elements.slice(0, restAt);
        const after = p.elements.slice(restAt + 1);
        if (items.length < before.length + after.length) {
          this.fail(`not enough values to unpack: need at least ${before.length + after.length}, found ${items.length}`, span, "E0409");
        }
        before.forEach((el, i) => this.bindPattern(env, el, items[i]!, declare, span));
        after.forEach((el, i) => this.bindPattern(env, el, items[items.length - after.length + i]!, declare, span));
        const rest = p.elements[restAt] as A.RestPat;
        if (rest.name) {
          const slice = list(items.slice(before.length, items.length - after.length));
          if (declare) env.define(rest.name, slice); else env.set(rest.name, slice);
        }
        return;
      }
      case "StructPat": {
        if (v.t !== "struct") this.fail(`expected a ${p.name}, found ${typeNameOf(v)}`, span, "E0408");
        for (const f of p.fields) {
          const got = v.fields.get(f.name);
          if (got === undefined) this.fail(`\`${p.name}\` has no field \`${f.name}\``, span, "E0410");
          this.bindPattern(env, f.pattern, got, declare, span);
        }
        return;
      }
      case "VariantPat": {
        if (v.t !== "variant" || v.name !== p.name) this.fail(`expected ${p.name}, found ${inspect(v)}`, span, "E0408");
        p.args.forEach((a, i) => this.bindPattern(env, a, v.fields[i] ?? NULL, declare, span));
        return;
      }
      default:
        this.fail("this pattern cannot be used in a binding", span, "E0411");
    }
  }

  private exprToPattern(e: A.Expr): A.Pattern {
    switch (e.kind) {
      case "Ident": return { kind: "BindPat", span: e.span, name: e.name };
      case "TupleExpr": return { kind: "TuplePat", span: e.span, elements: e.elements.map((x) => this.exprToPattern(x)) };
      case "ListExpr": return { kind: "ListPat", span: e.span, elements: e.elements.map((x) => this.exprToPattern(x)) };
      default: return { kind: "WildcardPat", span: e.span };
    }
  }

  // ---- member / index access --------------------------------------------

  getMember(obj: Value, name: string, span: Span): Value {
    if (obj.t === "struct") {
      const f = obj.fields.get(name);
      if (f !== undefined) return f;
      const m = this.impls.get(obj.name)?.get(name);
      if (m) return { t: "bound", recv: obj, fn: m };
    }
    if (obj.t === "record") {
      const f = obj.v.get(name);
      if (f !== undefined) return f;
    }
    if (obj.t === "module") {
      const f = obj.exports.get(name);
      if (f !== undefined) return f;
      this.fail(`\`${obj.name}\` has no export \`${name}\``, span, "E0202");
    }
    if (obj.t === "variant") {
      const i = obj.fieldNames.indexOf(name);
      if (i >= 0) return obj.fields[i]!;
      const m = this.impls.get(obj.enumName)?.get(name);
      if (m) return { t: "bound", recv: obj, fn: m };
    }
    if (obj.t === "capability" && obj.perms.includes(name)) {
      return { t: "capability", name: `${obj.name}.${name}`, perms: [] };
    }
    if (obj.t === "ref") return this.getMember(obj.get(), name, span);

    const b = builtinMethod(obj, name);
    if (b) return b;

    const impl = this.impls.get(typeNameOf(obj))?.get(name);
    if (impl) return { t: "bound", recv: obj, fn: impl };

    this.fail(`${typeNameOf(obj)} has no member \`${name}\``, span, "E0412");
  }

  setMember(obj: Value, name: string, v: Value, span: Span): void {
    if (obj.t === "struct") {
      if (!obj.fields.has(name)) this.fail(`\`${obj.name}\` has no field \`${name}\``, span, "E0410");
      obj.fields.set(name, v);
      return;
    }
    if (obj.t === "record") { obj.v.set(name, v); return; }
    if (obj.t === "ref") { this.setMember(obj.get(), name, v, span); return; }
    this.fail(`cannot set \`${name}\` on ${typeNameOf(obj)}`, span, "E0413");
  }

  getIndex(obj: Value, idx: Value, span: Span): Value {
    if (obj.t === "ref") return this.getIndex(obj.get(), idx, span);
    if (obj.t === "list" || obj.t === "tuple") {
      const i = this.normIndex(idx, obj.v.length, span);
      return obj.v[i]!;
    }
    if (obj.t === "string") {
      const cps = codePoints(obj.v);
      const i = this.normIndex(idx, cps.length, span);
      return { t: "char", v: cps[i]! };
    }
    if (obj.t === "map") {
      const got = obj.v.get(keyOf(idx));
      return got ? got.v : NULL; // a missing key reads as `null` (#7)
    }
    if (obj.t === "record" && idx.t === "string") {
      return obj.v.get(idx.v) ?? NULL;
    }
    if (obj.t === "set") return bool(obj.v.has(keyOf(idx)));
    this.fail(`${typeNameOf(obj)} cannot be indexed`, span, "E0414");
  }

  setIndex(obj: Value, idx: Value, v: Value, span: Span): void {
    if (obj.t === "ref") return this.setIndex(obj.get(), idx, v, span);
    if (obj.t === "list") {
      const i = this.normIndex(idx, obj.v.length, span);
      obj.v[i] = v;
      return;
    }
    if (obj.t === "map") { obj.v.set(keyOf(idx), { k: idx, v }); return; }
    if (obj.t === "record" && idx.t === "string") { obj.v.set(idx.v, v); return; }
    if (obj.t === "set") { if (truthy(v)) obj.v.set(keyOf(idx), idx); else obj.v.delete(keyOf(idx)); return; }
    if (obj.t === "tuple") this.fail("a tuple is immutable", span, "E0415");
    this.fail(`${typeNameOf(obj)} cannot be indexed`, span, "E0414");
  }

  /** #54 — negative indices count from the end. */
  private normIndex(idx: Value, len: number, span: Span): number {
    if (idx.t !== "int" && idx.t !== "float") {
      this.fail(`an index must be a whole number, found ${typeNameOf(idx)}`, span, "E0416");
    }
    let i = idx.t === "int" ? Number(idx.v) : Math.trunc(idx.v);
    if (i < 0) i += len;
    if (i < 0 || i >= len) this.fail(`index ${idx.t === "int" ? idx.v : idx.v} is out of range for length ${len}`, span, "R0004");
    return i;
  }

  /** R13 — `[start:end:step]`, bounds clamp, negative step reverses. */
  sliceOf(obj: Value, startV: Value | null, endV: Value | null, stepV: Value | null, span: Span): Value {
    const asNum = (v: Value | null): number | null => {
      if (v === null || v.t === "null") return null;
      if (v.t === "int") return Number(v.v);
      if (v.t === "float") return Math.trunc(v.v);
      this.fail("slice bounds must be whole numbers", span, "E0416");
    };
    const step = asNum(stepV) ?? 1;
    if (step === 0) this.fail("slice step cannot be 0", span, "R0005");

    const build = (items: Value[]): Value[] => {
      const len = items.length;
      let s = asNum(startV);
      let e = asNum(endV);
      if (step > 0) {
        s = s === null ? 0 : s < 0 ? Math.max(0, s + len) : Math.min(s, len);
        e = e === null ? len : e < 0 ? Math.max(0, e + len) : Math.min(e, len);
        const out: Value[] = [];
        for (let i = s; i < e; i += step) out.push(items[i]!);
        return out;
      }
      s = s === null ? len - 1 : s < 0 ? s + len : Math.min(s, len - 1);
      e = e === null ? -1 : e < 0 ? e + len : Math.min(e, len);
      const out: Value[] = [];
      for (let i = s; i > e; i += step) if (i >= 0 && i < len) out.push(items[i]!);
      return out;
    };

    if (obj.t === "list") return list(build(obj.v));
    if (obj.t === "tuple") return tuple(build(obj.v));
    if (obj.t === "string") return str(build(codePoints(obj.v).map((c) => str(c))).map((c) => (c as { v: string }).v).join(""));
    if (obj.t === "ref") return this.sliceOf(obj.get(), startV, endV, stepV, span);
    this.fail(`${typeNameOf(obj)} cannot be sliced`, span, "E0417");
  }

  // ---- iteration --------------------------------------------------------

  iterate(v: Value, span: Span): Value[] {
    switch (v.t) {
      case "list": return [...v.v];
      case "tuple": return [...v.v];
      case "set": return [...v.v.values()];
      case "string": return codePoints(v.v).map((c) => ({ t: "char", v: c }) as Value);
      case "map": return [...v.v.values()].map((e) => tuple([e.k, e.v]));
      case "record": return [...v.v].map(([k, e]) => tuple([str(k), e]));
      case "range": {
        const out: Value[] = [];
        const { lo, hi, inclusive, step } = v;
        if (hi === null) this.fail("an unbounded range cannot be iterated", span, "R0006");
        if (step === 0n) this.fail("a range step cannot be 0", span, "R0005");
        if (step > 0n) for (let i = lo; inclusive ? i <= hi : i < hi; i += step) out.push(int(i));
        else for (let i = lo; inclusive ? i >= hi : i > hi; i += step) out.push(int(i));
        return out;
      }
      case "ref": return this.iterate(v.get(), span);
      default:
        this.fail(`${typeNameOf(v)} is not iterable`, span, "E0418");
    }
  }

  private didYouMean(env: Env, name: string): string {
    const names = env.allNames();
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of names) {
      const d = editDistance(name, n);
      if (d < bestD && d <= Math.max(1, Math.floor(name.length / 3))) { bestD = d; best = n; }
    }
    return best ? ` — did you mean \`${best}\`?` : "";
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Bare names inside a method resolve against the receiver's fields (#16). */
function fieldOfSelf(env: Env, name: string): { get: () => Value; set: (v: Value) => void } | null {
  const self = env.frame?.self;
  if (!self) return null;
  if (self.t === "struct" && self.fields.has(name)) {
    return { get: () => self.fields.get(name)!, set: (v) => { self.fields.set(name, v); } };
  }
  if (self.t === "record" && self.v.has(name)) {
    return { get: () => self.v.get(name)!, set: (v) => { self.v.set(name, v); } };
  }
  if (self.t === "variant") {
    const i = self.fieldNames.indexOf(name);
    if (i >= 0) return { get: () => self.fields[i]!, set: (v) => { self.fields[i] = v; } };
  }
  return null;
}

function arityText(min: number, max: number): string {
  if (min === max) return `${min} argument(s)`;
  if (max === Infinity) return `at least ${min} argument(s)`;
  return `${min}–${max} arguments`;
}

function memberPath(e: A.MemberExpr): string | null {
  const parts: string[] = [e.name];
  let cur: A.Expr = e.obj;
  while (cur.kind === "MemberExpr") { parts.unshift(cur.name); cur = cur.obj; }
  if (cur.kind !== "Ident") return null;
  parts.unshift(cur.name);
  return parts.join(".");
}

function baseName(path: string): string {
  const p = path.replace(/\.(h|hpp|hk)$/, "");
  const parts = p.split(/[./\\]/);
  return parts[parts.length - 1] || p;
}

let rawCounter = 0x1000;
function rawAddr(): number { return (rawCounter += 8); }

function isKnownTypeWord(s: string): boolean {
  return ["Struct", "Enum", "Class", "Primitive", "Trait", "Kind"].includes(s);
}

/** Constant-fold a literal pattern's expression without an environment. */
function evalConst(e: A.Expr): Value | null {
  switch (e.kind) {
    case "IntLit": return int(e.value);
    case "FloatLit": return float(e.value);
    case "BoolLit": return bool(e.value);
    case "NullLit": return NULL;
    case "NothingLit": return NOTHING;
    case "CharLit": return { t: "char", v: e.value };
    case "StrLit": return e.parts.every((p) => p.kind === "text") ? str(e.parts.map((p) => p.text ?? "").join("")) : null;
    case "UnaryExpr": {
      const inner = evalConst(e.operand);
      if (!inner) return null;
      if (e.op === "-" && inner.t === "int") return int(-inner.v);
      if (e.op === "-" && inner.t === "float") return float(-inner.v);
      return null;
    }
    case "TupleExpr": {
      const vs = e.elements.map(evalConst);
      return vs.every((x) => x !== null) ? tuple(vs as Value[]) : null;
    }
    case "ListExpr": {
      const vs = e.elements.map(evalConst);
      return vs.every((x) => x !== null) ? list(vs as Value[]) : null;
    }
    default: return null;
  }
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export { DiagnosticBag, renderDiagnostic };
export { convert, typeText } from "../runtime/convert.ts";
