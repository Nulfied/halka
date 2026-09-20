// The Halka native backend: lowers the typed AST to C99.
//
// Why C and not LLVM (see ROADMAP): every platform already has a C compiler,
// so this costs nothing to distribute, cross-compiles for free, and makes the
// C and C++ FFI of #35/#36 ordinary calls in the generated source.
//
// The contract with the interpreter is R23: identical observable behaviour for
// any program both accept; the backend may *reject* a program whose types are
// not concrete enough to compile without boxing, but never accept one the
// checker rejected. Rejections carry an E07xx code and name the expression.
//
// Scalar arithmetic, calls, loops and array indexing lower to plain C with no
// tagging or indirection, which is what makes the generated code competitive
// with hand-written C.

import type * as A from "../../parser/ast.ts";
import { DiagnosticBag, type Span } from "../../util/diagnostics.ts";
import type { TypeMap, ForeignImport } from "../../sema/infer.ts";
import type { EscapeInfo, Owned } from "../../sema/escape.ts";
import { type Ty, prune, show, C_SCALARS } from "../../sema/types.ts";
import { PY_RUNTIME, pyConverter, pyLifter } from "./pyruntime.ts";
import { preludeMember, JSON_DOC } from "../../sema/prelude-types.ts";

interface EnumVariantDef { name: string; tag: number; fields: { name: string; ty: Ty }[] }
/** One monomorphised enum. `key` is the C name; `name` is the Halka name. */
interface EnumDef { key: string; name: string; variants: EnumVariantDef[] }

export interface EmitOptions {
  /** Release builds drop overflow and bounds checks the optimiser proved safe. */
  release?: boolean;
  /** Source file name, used in panic messages. */
  file: string;
  /** `import c "..."` / `import py "..."` collected by inference (#35-#37). */
  foreignImports?: ForeignImport[];
  /** Which locals each frame must free, from the escape pass (M4). */
  escapes?: EscapeInfo;
  /**
   * Field types per struct, in declaration order, from inference.
   *
   * Without these the emitter fell back to `any` for every field, which
   * `cty` maps to `hk_int` — so a struct with a `string` field emitted C
   * that assigned an `hk_str *` to an `hk_int`. The C compiler now rejects
   * that (it is one of the promoted warnings), where before it built a
   * binary that read the pointer as a number.
   */
  structFields?: Map<string, Ty[]>;
  /** Enum name -> variant -> payload types, from inference. */
  enumVariants?: Map<string, Map<string, { fields: Ty[]; names: string[] }>>;
  /**
   * Drop every bounds check, even the ones that were not proved safe. An
   * explicit opt-out: `--release` keeps them now, because a release build
   * that silently loses memory safety is not what this language is for.
   */
  uncheckedIndex?: boolean;
  /** Enum name -> type parameters. A generic enum gets a C type per use. */
  enumGenerics?: Map<string, string[]>;
  /**
   * Which parameters of each function take ownership of their argument
   * (M2.2). A caller keeps ownership of everything else, so a freshly built
   * argument it passes is still the caller's to release.
   */
  owningParams?: Map<string, boolean[]>;
}

export interface EmitResult {
  c: string;
  diags: DiagnosticBag;
  /** Libraries the program asked to link against, via `extern: link: "..."`. */
  links: string[];
  /** True when the program embeds CPython and needs its headers and import lib. */
  needsPython: boolean;
}

interface StructDef { name: string; fields: { name: string; ty: Ty }[] }

/** C reserved words a Halka identifier must not collide with. */
const C_RESERVED = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double",
  "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long",
  "register", "restrict", "return", "short", "signed", "sizeof", "static", "struct",
  "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "bool",
  "true", "false", "main", "NULL",
]);

export class CEmitter {
  private out: string[] = [];
  private decls: string[] = [];
  private aux: string[] = [];
  private parN = 0;
  private types: TypeMap;
  private diags = new DiagnosticBag();
  private opts: EmitOptions;
  private depth = 1;
  private tmp = 0;
  private structs = new Map<string, StructDef>();
  /**
   * Monomorphised enums, keyed by their C name. `Result<T>` is generic, so
   * `Result<int>` and `Result<string>` are two different C types built on
   * demand; a plain enum has one instance keyed by its own name.
   */
  private enums = new Map<string, EnumDef>();
  /** Variant name -> its (generic) enum, so `Ok(x)` and `r is Ok` resolve. */
  private variantOwner = new Map<string, string>();
  /** Enum name -> its variants, before any type arguments are applied. */
  private enumTemplates = new Map<string, Map<string, { fields: Ty[]; names: string[] }>>();
  private fnRet = new Map<string, Ty>();
  private strLits = new Map<string, string>();
  /**
   * One entry per open block. `owned` is what the escape pass says this block
   * must free; `live` is the subset already declared at the current point, so
   * an early `give` never frees something C has not seen yet.
   */
  private blockStack: { owned: Set<string>; kinds: Map<string, "str" | "list" | "enum" | "opt" | "map" | "tuple" | "json" | "struct" | "shared" | "weak">; types: Map<string, Ty | undefined>; declared: Set<string>; optVars: Set<string>; live: Owned[]; caps: number; isLoopBody: boolean }[] = [];
  /** Owning parameters of the current function, freed when it returns. */
  private frameParams: Owned[] = [];
  /** Values built inside the current statement, freed once it completes. */
  private stmtTemps: Owned[] = [];
  private inMain = false;
  /**
   * Top-level `const` names. They are module-level bindings, so they are
   * emitted at file scope rather than as locals of `main` — otherwise a
   * function cannot see them, which is how a compiled program came to
   * reject a constant the interpreter accepted.
   */
  private moduleConsts = new Set<string>();
  private includes: string[] = [];
  private links: string[] = [];
  private needsPython = false;
  /** Prelude modules the program actually calls, so only those are linked. */
  private preludeUsed = new Set<string>();
  /** Result wrappers already emitted, so each is generated once. */
  private wrappers = new Set<string>();
  /** `c struct Point:` — referenced as `struct Point`, never redefined by us. */
  private foreignStructs = new Set<string>();
  /** `import py "numpy"` -> the static holding the imported module. */
  private pyModules = new Map<string, string>();
  /** `from py "math" import sqrt` -> the static holding that attribute. */
  private pyNames = new Map<string, { mod: string; attr: string; slot: string }>();

  constructor(types: TypeMap, opts: EmitOptions) {
    this.types = types;
    this.opts = opts;
  }

  // -------------------------------------------------------------------------

  emit(mod: A.Module): EmitResult {
    const fns = mod.stmts.filter((s): s is A.FnDecl => s.kind === "FnDecl" && !!s.body && !s.isMacro && !s.foreign);
    const structs = mod.stmts.filter((s): s is A.StructDecl => s.kind === "StructDecl" && !s.foreign);
    const top = mod.stmts.filter((s) => !DECL_KINDS.has(s.kind));

    // A top-level `const` becomes a file-scope static, declared before any
    // function so every function can reach it, and assigned where the
    // statement sits so its initialiser still runs in order.
    for (const st of top) {
      if (st.kind !== "LetStmt" || !st.isConst || st.pattern.kind !== "BindPat") continue;
      this.moduleConsts.add(st.pattern.name);
    }

    for (const s of structs) this.declareStruct(s);
    this.registerEnums();
    this.collectForeign(mod);
    for (const f of fns) {
      const sig = this.tyOf(f);
      // An unmapped declaration, or one whose type is not a function, has no
      // return type to record — fall back to `any` rather than dropping it.
      this.fnRet.set(f.name, (sig && retOf(sig)) ?? { k: "any" });
    }

    for (const st of top) {
      if (st.kind !== "LetStmt" || !st.isConst || st.pattern.kind !== "BindPat") continue;
      const t = this.tyOf(st.pattern as unknown as A.Node) ?? (st.value ? this.tyOf(st.value) : undefined);
      this.decls.push(`static ${this.cty(t, `\`${st.pattern.name}\``, st.span)} ${mangle(st.pattern.name)};`);
    }

    // Forward declarations so order does not matter.
    for (const f of fns) this.decls.push(this.signature(f) + ";");

    // A foreign declaration with an explicit return type also emits a C
    // prototype, so a symbol without a header can still be called (#35).
    for (const s of mod.stmts) {
      if (s.kind !== "FnDecl" || s.foreign !== "c" || !s.retType) continue;
      const sig = this.types.get(s);
      if (!sig) continue; // never guess a prototype — a wrong one is worse than none
      const ret = this.cty(retOf(sig), "return", s.span);
      const ps = s.params.map((pp, i) => {
        if (pp.name === "...") return "...";
        return this.cty(paramOf(sig, i), `parameter \`${pp.name}\``, pp.span);
      });
      this.decls.push(`extern ${ret} ${s.name}(${ps.length ? ps.join(", ") : "void"});`);
    }

    for (const f of fns) this.emitFunction(f);

    // Top-level statements become main().
    this.out.push("");
    this.out.push("int main(int argc, char **argv) {");
    this.inMain = true;
    this.depth = 1;
    this.frameParams = [];
    this.line("hk_init(argc, argv);");
    this.suite({ kind: "Block", span: mod.span, stmts: top }, false, this.opts.escapes?.topLevel);
    // A `main()` function is the entry point, after any top-level statements.
    // The interpreter does exactly this; a backend that skipped it would run
    // the program and silently do nothing, which is the divergence R23 exists
    // to rule out.
    const entry = fns.find((f) => f.name === "main" && f.params.length === 0);
    if (entry) this.line(`${mangle("main")}();`);
    this.line("hk_shutdown();");
    this.line("return 0;");
    this.inMain = false;
    this.out.push("}");

    return { c: this.assemble(), diags: this.diags, links: this.links, needsPython: this.needsPython };
  }

  /** Turn `import c "stdio.h"` into an include, and `extern: link:` into -l flags. */
  private collectForeign(mod: A.Module): void {
    for (const imp of this.opts.foreignImports ?? []) {
      if (imp.lang === "py") {
        this.needsPython = true;
        const path = imp.path.replace(/^"|"$/g, "");
        if (!this.pyModules.has(path)) this.pyModules.set(path, `hk_pymod${this.pyModules.size}`);
        const modSlot = this.pyModules.get(path)!;
        for (const n of imp.names) {
          if (!this.pyNames.has(n)) this.pyNames.set(n, { mod: modSlot, attr: n, slot: `hk_pyfn${this.pyNames.size}` });
        }
        continue;
      }
      const path = imp.path.replace(/^"|"$/g, "");
      const angled = !path.startsWith(".") && !path.includes("/") && !path.includes("\\");
      const inc = angled ? `#include <${path}>` : `#include "${path}"`;
      // string.h and math.h are already pulled in by the preamble.
      if (BUILTIN_INCLUDES.has(path)) continue;
      if (!this.includes.includes(inc)) this.includes.push(inc);
    }
    const walk = (stmts: A.Stmt[]): void => {
      for (const s of stmts) {
        if (s.kind === "StructDecl" && s.foreign) this.foreignStructs.add(s.name);
        else if (s.kind === "ExternDecl" && s.abi) {
          for (const key of ["link", "links", "library"]) {
            const v = s.abi[key];
            if (v) for (const lib of v.split(/[,\s]+/).filter(Boolean)) if (!this.links.includes(lib)) this.links.push(lib);
          }
        } else if (s.kind === "GenerateDecl") walk(s.body.stmts);
      }
    };
    walk(mod.stmts);
  }

  private assemble(): string {
    const head = [
      `/* Generated by the Halka compiler from ${this.opts.file}. Do not edit. */`,
      ...(this.needsPython ? ["#define PY_SSIZE_T_CLEAN", "#include <Python.h>"] : []),
      `#include "halka.h"`,
      `#include <string.h>`,
      `#include <math.h>`,
      ...(this.includes.length ? ["", "/* foreign headers (#35) */", ...this.includes] : []),
      "",
    ];
    const lits: string[] = [];
    for (const [text, name] of this.strLits) {
      lits.push(`static hk_str *${name};`);
      void text;
    }
    for (const slot of this.pyModules.values()) lits.push(`static PyObject *${slot};`);
    for (const n of this.pyNames.values()) lits.push(`static PyObject *${n.slot};`);
    const init: string[] = [];
    if (this.needsPython) {
      init.push("static void hk_init_python(void) {");
      init.push("  hk_py_start();");
      for (const [path, slot] of this.pyModules) {
        init.push(`  ${slot} = hk_py_import(${cString(path)}, ${cString(this.opts.file)}, 0);`);
      }
      for (const n of this.pyNames.values()) {
        init.push(`  ${n.slot} = hk_py_attr(${n.mod}, ${cString(n.attr)}, ${cString(this.opts.file)}, 0);`);
      }
      init.push("}");
      init.push("");
    }
    if (this.strLits.size) {
      init.push("static void hk_init_literals(void) {");
      for (const [text, name] of this.strLits) init.push(`  ${name} = hk_str_lit(${cString(text)});`);
      init.push("}");
      init.push("");
    }
    const bootstrap = ["  hk_init(argc, argv);"];
    if (this.strLits.size) bootstrap.push("  hk_init_literals();");
    if (this.needsPython) bootstrap.push("  hk_init_python();");
    let body = this.out.join("\n").replace("  hk_init(argc, argv);", bootstrap.join("\n"));
    if (this.needsPython) body = body.split("  hk_shutdown();").join("  hk_py_stop();\n  hk_shutdown();");
    const pyrt = this.needsPython ? [PY_RUNTIME] : [];
    return [...head, ...this.optDecls(false), ...this.tupleDecls(), ...this.structDecls(), ...this.enumDecls(), ...this.optDecls(true), ...lits, "", ...this.decls, "", ...pyrt, ...this.aux, ...init, body, ""].join("\n");
  }

  private optTypes = new Map<string, { key: string; cty: string; late?: boolean }>();
  private tupleTypes = new Map<string, { key: string; elems: Ty[]; ctys: string[]; depth: number }>();
  /** Parameters of the function being emitted that are stored as optionals. */
  private optParams = new Set<string>();
  /** Parameters of the function being emitted -> whether the callee owns it. */
  private fnParams = new Map<string, boolean>();

  private structDecls(): string[] {
    const out: string[] = [];
    for (const s of this.structs.values()) {
      out.push(`typedef struct ${mangleType(s.name)} {`);
      for (const f of s.fields) out.push(`  ${this.cty(f.ty, f.name)} ${mangle(f.name)};`);
      out.push(`} ${mangleType(s.name)};`);
      out.push("");
    }
    return out;
  }

  // ---- helpers -------------------------------------------------------------

  private line(s: string): void { this.out.push("  ".repeat(this.depth) + s); }
  private open(s: string): void { this.line(s); this.depth++; }
  private close(s = "}"): void { this.depth--; this.line(s); }
  private fresh(prefix = "t"): string { return `hk_${prefix}${this.tmp++}`; }

  /**
   * A `static` wrapper turning the runtime's neutral `hk_io_result` into the
   * `Result<T>` this call site expects. One per (function, instantiation),
   * because `Result<string>` and `Result<int>` are different C types.
   */
  private resultWrapper(member: { c?: string; okFrom?: string }, name: string, e: A.CallExpr): string {
    const inst = this.enumOf(this.tyOf(e), e.span);
    if (!inst) {
      this.err("E0701", `the native backend cannot tell which \`Result\` \`files.${name}\` returns here`, e.span,
        "annotate the value or the function's return type");
      return member.c!;
    }
    const wrapper = `hk_w_${member.c}__${inst.key}`;
    if (!this.wrappers.has(wrapper)) {
      this.wrappers.add(wrapper);
      const ok = inst.variants.find((v) => v.name === "Ok")!;
      const err = inst.variants.find((v) => v.name === "Error")!;
      const params = (paramTypesOf(this.types.get(e.callee) ?? undefined) ?? []).map((t, i) =>
        `${this.cty(t, `parameter ${i}`)} a${i}`);
      const payload = member.okFrom === "none" ? ""
        : `, .as.Ok.${mangle(ok.fields[0]!.name)} = ${member.okFrom === "number" ? "r.number" : "r.value"}`;
      this.aux.push(
        `static ${mangleType(inst.key)} ${wrapper}(${params.length ? params.join(", ") : "void"}) {`,
        `  hk_io_result r = ${member.c}(${params.map((_, i) => `a${i}`).join(", ")});`,
        `  if (r.ok) return (${mangleType(inst.key)}){ .tag = ${variantTag(inst.key, "Ok")}${payload} };`,
        `  return (${mangleType(inst.key)}){ .tag = ${variantTag(inst.key, "Error")}, .as.Error.${mangle(err.fields[0]!.name)} = r.error };`,
        "}",
        "",
      );
    }
    return wrapper;
  }

  private usePrelude(mod: string): void {
    this.preludeUsed.add(mod);
    if (mod === "math" && !this.includes.includes("#include <math.h>")) {
      this.includes.push("#include <math.h>");
    }
  }

  private tyOf(n: A.Node): Ty | undefined { return this.types.get(n); }

  private err(code: string, msg: string, span: Span, help?: string): void {
    this.diags.error(code, msg, span, { help, rule: "R23 — native backend contract" } as never);
  }

  private loc(span: Span): string {
    return `${cString(this.opts.file)}, ${span.start.line}`;
  }

  /** Map a Halka type to its C spelling. */
  private cty(t: Ty | undefined, what: string, span?: Span): string {
    const p = t ? prune(t) : undefined;
    if (!p) return "hk_int";
    switch (p.k) {
      case "prim":
        switch (p.name) {
          case "int": return "hk_int";
          case "float": return "hk_float";
          case "bool": return "hk_bool";
          case "char": return "hk_char";
          case "byte": return "hk_byte";
          case "string": return "hk_str *";
          case "nothing": return "void";
          case "null": return "void *";
        }
        break;
      case "list": case "array": return "hk_list *";
      case "map": {
        // Both halves must be representable, and the key must be hashable
        // by its bytes or as a string -- which is every kind the runtime
        // knows. Anything else is refused rather than hashed as a pointer.
        const kc = this.cty(p.key, "map key", span);
        const vc = this.cty(p.val, "map value", span);
        // `ekindOf` falls back to HK_E_INT, which would hash a struct by
        // its first eight bytes, so the shapes the runtime actually knows
        // are named here instead.
        if (!MAP_KEY_CTYS.has(kc) || !MAP_VALUE_CTYS.has(vc)) {
          if (span) {
            this.err("E0701", `the native backend cannot represent ${show(p)} yet`, span,
              "a map key may be a number, bool, char or string; a value may also be a list");
          }
          break;
        }
        return "hk_map *";
      }
      case "named":
        if (this.structs.has(p.name)) return mangleType(p.name);
        if (this.enumTemplates.has(p.name)) {
          const inst = this.enumInstance(p.name, (p.args ?? []).map(prune), span);
          if (inst) return mangleType(inst.key);
        }
        if (this.foreignStructs.has(p.name)) return `struct ${p.name}`;
        break;
      case "cty":
        if (p.lang === "py") return "PyObject *";
        if (this.foreignStructs.has(p.name)) return `struct ${p.name}`;
        return p.name;
      case "mutex": return "hk_mutex *";
      case "atomic": return "volatile hk_int";
      case "range": return "hk_int";
      case "opt": {
        const o = this.optRegister(p.inner, span);
        if (o) return o;
        break;
      }
      case "tuple": {
        const t2 = this.tupleRegister(p.elems, span);
        if (t2) return t2;
        break;
      }
      // Both are handles on the same control block; which one a value is
      // comes from its Halka type, not its C type.
      case "shared": case "weak": return "hk_shared *";
      case "any":
        // Only this one `any` has a representation: a parsed JSON document
        // is an opaque dynamic value, like `PyObject *` at the py boundary.
        if (p.why === JSON_DOC) return "hk_json *";
        break;
      default: break;
    }
    if (span) {
      this.err("E0701", `the native backend cannot represent ${show(p)} yet (${what})`, span,
        "run it with `halka run`, or annotate this with a concrete type");
    }
    return "hk_int";
  }

  // --- optionals (#7) -------------------------------------------------------
  //
  // `T?` becomes a struct per inner type: `{ hk_bool has; T v; }`. NULL would
  // do for the pointer-shaped types, but not for `int?` or `bool?`, and one
  // representation keeps every operation on optionals the same shape.
  //
  // The inner type is deliberately restricted. An optional of a struct or an
  // enum would have to be declared after that type, while a struct with an
  // optional field has to be declared after the optional — orders that can
  // both be required at once. Rejecting is allowed (R23); mis-compiling is
  // not, so the cases that cannot be ordered are refused by name.

  /** Register `T?` and give its C type, or null if `T` cannot be optional. */
  private optRegister(inner: Ty, span?: Span): string | null {
    const p = prune(inner);
    const named = p.k === "named" && this.structs.has(p.name);
    const ok = (p.k === "prim" && p.name !== "nothing" && p.name !== "null")
      || p.k === "list" || p.k === "array" || p.k === "tuple" || named;
    if (!ok) {
      if (span) {
        this.err("E0701", `the native backend cannot represent ${show(p)}? yet`, span,
          "an optional may hold a number, bool, char, byte, string, list, tuple or struct");
      }
      return null;
    }
    const key = `opt_${tyKey(p)}`;
    if (!this.optTypes.has(key)) {
      // An optional of a struct or tuple has to be declared *after* that
      // type, while one of a scalar can come first -- and a struct with an
      // optional field needs the optional first. The two groups are
      // emitted on either side of the struct declarations so both orders
      // are available.
      this.optTypes.set(key, { key, cty: this.cty(p, "optional value", span), late: named || p.k === "tuple" });
    }
    return mangleType(key);
  }

  // --- tuples ---------------------------------------------------------------
  //
  // Each shape is its own C struct with fields `f0`, `f1`, ... Beside it the
  // emitter writes a descriptor: field kinds and byte offsets, which is what
  // lets the runtime release or print a tuple whose layout it cannot know --
  // and therefore what lets a *list* of tuples work at all.

  /** Register a tuple shape and give its C type, or null if unsupported. */
  private tupleRegister(elems: Ty[], span?: Span): string | null {
    if (elems.length === 0) {
      if (span) this.err("E0701", "the native backend has no empty tuple", span);
      return null;
    }
    const key = `tup_${elems.map(tyKey).join("_")}`;
    const known = this.tupleTypes.get(key);
    if (known) return mangleType(key);
    const ctys: string[] = [];
    for (const el of elems) {
      const c = this.cty(el, "tuple field", span);
      // The same ordering problem optionals have: a tuple of structs would
      // need declaring after them, a struct with a tuple field before.
      if (!TUPLE_FIELD_CTYS.has(c) && !c.startsWith("hk_T_tup_")) {
        if (span) {
          this.err("E0701", `the native backend cannot put ${show(prune(el))} in a tuple yet`, span,
            "a tuple field may be a number, bool, char, byte, string, list, or another tuple");
        }
        return null;
      }
      ctys.push(c);
    }
    this.tupleTypes.set(key, { key, elems, ctys, depth: tupleDepth(elems) });
    return mangleType(key);
  }

  /** The tuple type of `t`, if it is one and the backend can build it. */
  private tupOf(t: Ty | undefined): { cty: string; elems: Ty[]; ctys: string[]; key: string } | null {
    const p = t ? prune(t) : undefined;
    if (!p || p.k !== "tuple") return null;
    const c = this.tupleRegister(p.elems);
    if (!c) return null;
    const info = this.tupleTypes.get(`tup_${p.elems.map(tyKey).join("_")}`)!;
    return { cty: c, elems: info.elems, ctys: info.ctys, key: info.key };
  }

  /**
   * A comparator for one tuple shape, generated once. Lists are refused
   * rather than compared: the interpreter compares them structurally and
   * the C runtime has no deep list equality to match that with.
   */
  private tupleEq(info: { cty: string; elems: Ty[]; ctys: string[]; key: string }, span: Span): string | null {
    const name = `hk_teq_${info.key}`;
    if (this.wrappers.has(name)) return name;
    const tests: string[] = [];
    for (let i = 0; i < info.ctys.length; i++) {
      const c = info.ctys[i]!;
      const el = prune(info.elems[i]!);
      if (el.k === "tuple") {
        const subInfo = this.tupOf(el)!;
        const subFn = this.tupleEq(subInfo, span);
        if (!subFn) return null;
        tests.push(`${subFn}(&a->f${i}, &b->f${i})`);
      } else if (c === "hk_str *") {
        tests.push(`hk_str_eq(a->f${i}, b->f${i})`);
      } else if (c === "hk_list *") {
        this.err("E0708", "the native backend cannot compare a tuple holding a list yet", span,
          "compare the fields you need, or run it with `halka run`");
        return null;
      } else {
        tests.push(`a->f${i} == b->f${i}`);
      }
    }
    this.wrappers.add(name);
    this.aux.push(
      `static hk_bool ${name}(const ${info.cty} *a, const ${info.cty} *b) {`,
      `  return ${tests.join(" && ")};`,
      "}",
      "",
    );
    return name;
  }

  /**
   * `let (a, b): t`. The names are copied out of a temporary, so when that
   * temporary is a value we own -- a fresh tuple rather than a variable --
   * it stays alive for the block, because the names borrow its fields.
   */
  private destructureTuple(pat: A.TuplePat, value: A.Expr): void {
    const info = this.tupOf(this.tyOf(value))!;
    if (pat.elements.length > info.elems.length) {
      this.err("E0702", `this pattern wants ${pat.elements.length} fields from a ${info.elems.length}-tuple`, pat.span);
      return;
    }
    const tmp = this.fresh("dst");
    this.line(`${info.cty} ${tmp} = ${this.expr(value)};`);
    if (!isRead(value)) {
      const here = this.blockStack[this.blockStack.length - 1];
      here?.live.push({ name: tmp, kind: "tuple", ty: this.tyOf(value) });
    }
    pat.elements.forEach((el, i) => {
      if (el.kind === "WildcardPat") return;
      if (el.kind !== "BindPat") {
        this.err("E0702", "the native backend only supports plain names in a tuple pattern yet", pat.span);
        return;
      }
      this.line(`${info.ctys[i]} ${mangle(el.name)} = ${tmp}.f${i};`);
      this.noteDecl(el.name, info.elems[i]);
    });
  }

  /**
   * `m.entries()` — a list of `(key, value)` tuples. Built here rather than
   * in the runtime because the tuple's layout is per shape, and the list
   * co-owns what it copies, so each entry is retained.
   */
  private mapEntries(obj: A.Expr, recv: string, e: A.CallExpr): string {
    const info = this.tupOf(this.tyOf(e) ? this.elemOf(this.tyOf(e)) : undefined)
      ?? this.tupOf(this.elemTypeOfMap(this.tyOf(obj)));
    if (!info) {
      this.err("E0711", "the native backend cannot build this map's entry tuple yet", e.span);
      return "0";
    }
    const { kt, vt } = this.mapParts(this.tyOf(obj));
    const kc = this.cty(kt, "map key", e.span);
    const vc = this.cty(vt, "map value", e.span);
    const mv = this.fresh("ent");
    const out = this.fresh("entl");
    const i = this.fresh("ei");
    const tv = this.fresh("etv");
    const desc = this.tupDescOf(info.key);
    this.line(`hk_map *${mv} = ${recv};`);
    this.line(`hk_list *${out} = hk_list_new(sizeof(${info.cty}), ${mv}->count, HK_E_TUPLE);`);
    this.line(`hk_list_set_desc(${out}, &${desc});`);
    this.open(`for (hk_int ${i} = 0; ${i} < ${mv}->used; ${i}++) {`);
    this.line(`if (!${mv}->live[${i}]) continue;`);
    this.line(`${info.cty} ${tv} = { .f0 = *(${kc} *)(${mv}->keys + ${i} * ${mv}->ksz),` +
      ` .f1 = *(${vc} *)(${mv}->vals + ${i} * ${mv}->vsz) };`);
    this.line(`hk_tuple_retain(&${tv}, &${desc});`);
    this.line(`HK_PUSH(${out}, ${info.cty}, ${tv});`);
    this.close();
    return out;
  }

  /**
   * `maps.from_entries(es)` — the inverse. Also emitted here: the runtime
   * would need the tuple's layout and the map's key and value sizes, all of
   * which are known while compiling.
   */
  private mapFromEntries(e: A.CallExpr, arg: string): string {
    const rt = this.tyOf(e);
    const { kt, vt } = this.mapParts(rt);
    const info = this.tupOf(this.elemOf(this.tyOf(e.args[0]!.value)));
    if (!info || !kt || !vt) {
      this.err("E0711", "the native backend cannot tell what map `from_entries` builds here", e.span,
        "annotate the result, e.g. `let m: map(string, int): maps.from_entries(es)`");
      return "0";
    }
    const kc = this.cty(kt, "map key", e.span);
    const vc = this.cty(vt, "map value", e.span);
    const src = this.fresh("fes");
    const out = this.fresh("fem");
    const i = this.fresh("fi");
    this.line(`hk_list *${src} = ${arg};`);
    this.line(`hk_map *${out} = hk_map_new(sizeof(${kc}), sizeof(${vc}), ${ekindOf(kc)}, ${ekindOf(vc)}, ${src}->len);`);
    this.open(`for (hk_int ${i} = 0; ${i} < ${src}->len; ${i}++) {`);
    // `hk_map_set` retains what it keeps, so the source list is untouched.
    this.line(`hk_map_set(${out}, &HK_AT(${src}, ${info.cty}, ${i}).f0, &HK_AT(${src}, ${info.cty}, ${i}).f1);`);
    this.close();
    // No release here. `holdArgs` runs before this and has already made a
    // freshly built entries list the statement's to free; releasing it
    // again is a use-after-free. It was correct when this ran *before*
    // holdArgs, and reordering the prelude dispatch made it wrong --
    // invisibly on Windows, where the allocator tolerated it, and visibly
    // on Linux and macOS.
    return out;
  }

  /**
   * `json.stringify(x)`, dispatched on the static type of `x`. The runtime
   * has one function per shape rather than a generic value, because the
   * backend knows exactly what it is serialising.
   *
   * Output must match the interpreter byte for byte (R23), and that goes
   * through JavaScript's JSON.stringify, so the conventions are its ones:
   * an integral float loses its decimal point, a non-string map key is
   * stringified, and an absent optional is `null`.
   */
  private jsonStringify(e: A.CallExpr, arg: string): string {
    const a0 = e.args[0]!.value;
    if (a0.kind === "NullLit") return "hk_json_null()";
    const t = this.tyOf(a0);

    const o = this.optOf(t);
    if (o) {
      const v = this.fresh("jso");
      this.line(`${o.cty} ${v} = ${arg};`);
      return `(${v}.has ? ${this.jsonOf(`${v}.v`, o.inner, e.span)} : hk_json_null())`;
    }
    return this.jsonOf(arg, t, e.span);
  }

  /** The JSON of an already-emitted C expression of known type. */
  private jsonOf(cExpr: string, t: Ty | undefined, span: Span): string {
    const p = t ? prune(t) : undefined;
    if (this.isJsonDoc(t)) return `hk_json_dump(${cExpr})`;
    const tu = this.tupOf(t);
    if (tu) {
      const v = this.fresh("jst");
      this.line(`${tu.cty} ${v} = ${cExpr};`);
      return `hk_json_tuple(&${v}, &${this.tupDescOf(tu.key)})`;
    }
    if (p?.k === "list" || p?.k === "array") return `hk_json_list(${cExpr})`;
    if (p?.k === "map") return `hk_json_map(${cExpr})`;
    if (p?.k === "prim") {
      switch (p.name) {
        case "string": return `hk_json_str(${cExpr})`;
        case "int": case "byte": return `hk_json_int(${cExpr})`;
        case "float": return `hk_json_float(${cExpr})`;
        case "bool": return `hk_json_bool(${cExpr})`;
        case "char": {
          const c = this.fresh("jsc");
          this.line(`hk_str *${c} = hk_str_from_char(${cExpr});`);
          this.stmtTemps.push({ name: c, kind: "str" });
          return `hk_json_str(${c})`;
        }
        case "null": return "hk_json_null()";
        default: break;
      }
    }
    this.err("E0711", `the native backend cannot serialise ${show(p ?? ({ k: "any" } as Ty))} to JSON yet`, span,
      "run it with `halka run` while the backend catches up");
    return `hk_str_lit("null")`;
  }

  /** The HK_E_* kind for a list element, which `ekindOf` cannot tell for a tuple. */
  private elemKind(elemTy: Ty | undefined, cty: string): string {
    const p = elemTy ? prune(elemTy) : undefined;
    return p?.k === "tuple" ? "HK_E_TUPLE" : ekindOf(cty);
  }

  /** Give a list the tuple layout it holds, when it holds tuples. */
  private attachDesc(listVar: string, elemTy: Ty | undefined): void {
    const info = this.tupOf(elemTy);
    if (info) this.line(`hk_list_set_desc(${listVar}, &${this.tupDescOf(info.key)});`);
  }

  /** The descriptor symbol for a tuple shape. */
  private tupDescOf(key: string): string { return `hk_td_${key}`; }

  private tupleDecls(): string[] {
    const out: string[] = [];
    // Shallowest first: a nested tuple must be a complete type before the
    // tuple that contains it, and its descriptor must exist before being
    // pointed at.
    const all = [...this.tupleTypes.values()].sort((a, b) => a.depth - b.depth);
    for (const t of all) {
      const n = mangleType(t.key);
      out.push(`typedef struct ${n} {`);
      t.ctys.forEach((c, i) => out.push(`  ${c} f${i};`));
      out.push(`} ${n};`);
      out.push("");
    }
    for (const t of all) {
      const n = mangleType(t.key);
      const d = this.tupDescOf(t.key);
      out.push(`static const hk_int ${d}_k[] = { ${t.ctys.map((c, i) => this.fieldKind(t.elems[i]!, c)).join(", ")} };`);
      out.push(`static const hk_int ${d}_o[] = { ${t.ctys.map((_, i) => `offsetof(${n}, f${i})`).join(", ")} };`);
      const subs = t.elems.map((el) => {
        const sub2 = this.tupOf(el);
        return sub2 ? `&${this.tupDescOf(sub2.key)}` : "NULL";
      });
      out.push(`static const hk_tupdesc *const ${d}_s[] = { ${subs.join(", ")} };`);
      out.push(`static const hk_tupdesc ${d} = { ${t.ctys.length}, ${d}_k, ${d}_o, ${d}_s };`);
      out.push("");
    }
    return out;
  }

  private fieldKind(el: Ty, c: string): string {
    return prune(el).k === "tuple" ? "HK_E_TUPLE" : ekindOf(c);
  }

  /** `(a, b)` — a struct literal, with each field emitted in its own type. */
  private tupleLit(e: A.TupleExpr): string {
    const info = this.tupOf(this.tyOf(e));
    if (!info) {
      this.err("E0701", "the native backend cannot build this tuple yet", e.span);
      return "0";
    }
    const parts = e.elements.map((x, i) => `.f${i} = ${this.coerce(x, info.elems[i])}`);
    return `((${info.cty}){ ${parts.join(", ")} })`;
  }

  private optDecls(late: boolean): string[] {
    const out: string[] = [];
    for (const o of this.optTypes.values()) {
      if (!!o.late !== late) continue;
      out.push(`typedef struct ${mangleType(o.key)} {`);
      out.push("  hk_bool has;");
      out.push(`  ${o.cty} v;`);
      out.push(`} ${mangleType(o.key)};`);
      out.push("");
    }
    return out;
  }

  /**
   * `match` on an optional (#7). The locked spec writes it as a binding arm
   * for the value and a `null` arm for its absence, in either order, so this
   * is an if/else on the tag rather than a switch.
   */
  private matchOptional(m: A.MatchExpr, o: { cty: string; inner: Ty }): void {
    const subject = this.fresh("opt");
    this.open("{");
    this.line(`${o.cty} ${subject} = ${this.expr(m.subject)};`);
    // A scope of its own, so an arm's binding is not visible to whatever
    // follows the match.
    this.pushScope();

    // Arms are tried in order and the first match wins, so a bare name --
    // which matches anything, `null` included -- ends the chain. Getting
    // this wrong would make `match x, value, ..., null, ...` take the second
    // arm for an absent value where the interpreter takes the first.
    let opened = 0;
    let exhaustive = false;
    for (const arm of m.arms) {
      if (exhaustive) break; // unreachable: an earlier arm matches everything
      if (arm.guard) {
        this.err("E0704", "the native backend does not support a guard on a `match` arm yet", arm.span,
          "run it with `halka run` while the backend catches up");
        continue;
      }
      const pat = arm.pattern;
      if (pat.kind === "NullPat") {
        this.open(`${opened ? "else " : ""}if (!${subject}.has) {`);
        this.suite(arm.body);
        this.close("}");
        opened++;
        continue;
      }
      if (pat.kind === "BindPat" || pat.kind === "WildcardPat") {
        this.open(opened ? "else {" : "{");
        // The name is bound to the optional itself, not to its contents:
        // this arm is reached for an absent value too.
        if (pat.kind === "BindPat") {
          this.line(`${o.cty} ${mangle(pat.name)} = ${subject};`);
          this.noteDecl(pat.name, this.tyOf(m.subject));
        }
        this.suite(arm.body);
        this.close("}");
        opened++;
        exhaustive = true;
        continue;
      }
      this.err("E0704", "matching an optional takes a name and `null`", arm.span,
        "run it with `halka run` while the backend catches up");
    }
    this.popScope();
    this.close("}");
  }

  /**
   * A condition (R11). An optional is true when it holds a value, which in C
   * is its tag rather than the struct, and a struct cannot be tested at all.
   */
  private cond(e: A.Expr): string {
    const o = this.optOf(this.tyOf(e));
    if (!o) return this.expr(e);
    if (e.kind === "Ident" && this.isOptVar(e.name)) return `${mangle(e.name)}.has`;
    const t = this.fresh("cnd");
    this.line(`${o.cty} ${t} = ${this.expr(e)};`);
    return `${t}.has`;
  }

  /**
   * `match t, (a, b), ...`. A tuple has one shape, so a pattern of plain
   * names always matches and the first such arm is the whole match. A
   * pattern with a literal field would need comparing, which is refused
   * rather than silently ignored.
   */
  private matchTuple(m: A.MatchExpr, info: { cty: string; elems: Ty[]; ctys: string[]; key: string }): void {
    const subject = this.fresh("mtup");
    this.open("{");
    this.line(`${info.cty} ${subject} = ${this.expr(m.subject)};`);
    this.pushScope();
    for (const arm of m.arms) {
      if (arm.guard) {
        this.err("E0704", "the native backend does not support a guard on a `match` arm yet", arm.span,
          "run it with `halka run` while the backend catches up");
        break;
      }
      const pat = arm.pattern;
      if (pat.kind === "WildcardPat") { this.suite(arm.body); break; }
      if (pat.kind === "BindPat") {
        this.line(`${info.cty} ${mangle(pat.name)} = ${subject};`);
        this.noteDecl(pat.name, this.tyOf(m.subject));
        this.suite(arm.body);
        break;
      }
      if (pat.kind !== "TuplePat") {
        this.err("E0704", "matching a tuple takes a tuple pattern or a name", arm.span,
          "run it with `halka run` while the backend catches up");
        break;
      }
      if (!pat.elements.every((el) => el.kind === "BindPat" || el.kind === "WildcardPat")) {
        this.err("E0704", "the native backend only supports plain names in a tuple pattern yet", arm.span,
          "run it with `halka run` while the backend catches up");
        break;
      }
      this.open("{");
      pat.elements.forEach((el, i) => {
        if (el.kind !== "BindPat") return;
        this.line(`${info.ctys[i]} ${mangle(el.name)} = ${subject}.f${i};`);
        this.noteDecl(el.name, info.elems[i]);
      });
      this.suite(arm.body);
      this.close("}");
      break; // a name-only tuple pattern matches every tuple of this shape
    }
    this.popScope();
    this.close("}");
  }

  /** A block frame that owns nothing, for bindings introduced outside `suite`. */
  private pushScope(): void {
    this.blockStack.push({
      owned: new Set(), kinds: new Map(), types: new Map(),
      declared: new Set(), optVars: new Set(), live: [], caps: 0, isLoopBody: false,
    });
  }

  private popScope(): void { this.blockStack.pop(); }

  /** Record what this block declared, so a narrowed read knows how it is stored. */
  private noteDecl(name: string, t: Ty | undefined): void {
    const here = this.blockStack[this.blockStack.length - 1];
    if (!here) return;
    here.declared.add(name);
    if (this.optOf(t)) here.optVars.add(name);
  }

  /**
   * Is this name stored as an optional? Innermost declaration wins, so a
   * block that shadows `x: string?` with a plain `x: string` reads its own.
   */
  private isOptVar(name: string): boolean {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      const f = this.blockStack[i]!;
      if (f.declared.has(name)) return f.optVars.has(name);
    }
    return this.optParams.has(name);
  }

  /** The optional type of `t`, if it is one. */
  private optOf(t: Ty | undefined): { cty: string; inner: Ty } | null {
    const p = t ? prune(t) : undefined;
    if (!p || p.k !== "opt") return null;
    const c = this.optRegister(p.inner);
    return c ? { cty: c, inner: p.inner } : null;
  }

  /** `(T?){ .has = true, .v = x }` — an inner value lifted into an optional. */
  private optSome(cty: string, value: string): string {
    return `((${cty}){ .has = true, .v = ${value} })`;
  }

  private optNone(cty: string): string {
    return `((${cty}){ .has = false })`;
  }

  /**
   * Emit `e` as a value of type `want`, lifting it into an optional when the
   * target is optional and the expression is not. This is where `let x: T?: v`
   * and passing a plain `T` to a `T?` parameter become well-typed C.
   */
  private coerce(e: A.Expr, want: Ty | undefined, newOwner = true): string {
    return this.liftTo(this.expr(e), e, want, newOwner);
  }

  /**
   * Lift already-emitted C text into `want` if that is an optional and the
   * expression did not already produce one.
   */
  private liftTo(cExpr: string, e: A.Expr, want: Ty | undefined, newOwner = true): string {
    // Making a weak handle: it watches the block without owning the value.
    const wk = this.weakOf(want);
    if (wk) return this.weakOf(this.tyOf(e)) ? cExpr : `hk_weak_from(${cExpr})`;

    // Reading one. The value may be gone, so it comes back as a `T?` and
    // the checker has already made the caller treat it as one.
    const fromWeak = this.weakOf(this.tyOf(e));
    if (fromWeak && this.optOf(want)) {
      const o = this.optOf(want)!;
      const ct = this.cty(fromWeak, "weak value", e.span);
      const h = this.fresh("wk");
      const out = this.fresh("wv");
      this.line(`hk_shared *${h} = ${cExpr};`);
      this.line(`${o.cty} ${out} = { 0 };`);
      this.line(`if (hk_weak_alive(${h})) { ${out}.has = true; ${out}.v = *(${ct} *)${h}->data; }`);
      return out;
    }

    const sh = this.sharedOf(want);
    if (sh) {
      if (this.sharedOf(this.tyOf(e))) {
        // Whether to bump the count is a question about ownership, not
        // syntax. Reading an existing handle and binding it to a name adds
        // an owner, so the count goes up and that name releases later. A
        // call that hands one back has already transferred its count, so
        // retaining it again leaks. And an argument does not add an owner
        // at all: a parameter borrows (M2.2) and the callee never releases.
        return newOwner && isRead(e) ? `hk_shared_retain(${cExpr})` : cExpr;
      }
      return this.shareValue(cExpr, sh, e.span);
    }
    const o = this.optOf(want);
    if (!o) return cExpr;
    if (e.kind === "NullLit") return this.optNone(o.cty);
    if (this.producesOpt(e)) return cExpr;
    return this.optSome(o.cty, cExpr);
  }

  /**
   * Does emitting `e` already yield the optional struct? The inferred type
   * cannot answer this on its own: a literal in an optional slot is recorded
   * with the optional type, but the C text for it is still a bare value.
   */
  private producesOpt(e: A.Expr): boolean {
    switch (e.kind) {
      case "IntLit": case "FloatLit": case "StrLit": case "CharLit":
      case "BoolLit": case "NullLit": case "ListExpr": case "MapExpr":
        return false;
      case "Ident":
        return this.isOptVar(e.name) && !!this.optOf(this.tyOf(e));
      default:
        return !!this.optOf(this.tyOf(e));
    }
  }

  private isStr(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "prim" && p.name === "string";
  }
  private isFloat(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "prim" && p.name === "float";
  }
  /** Is this the opaque dynamic value `json.parse` hands back? */
  private isJsonDoc(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "any" && p.why === JSON_DOC;
  }

  /** Loop variables proven to be a valid index into a particular list. */
  private provenIdx: { varName: string; listName: string }[] = [];

  /**
   * Is `obj[index]` an access the compiler already knows is in range? Only
   * the exact shape `xs[i]` inside `for i in 0..len(xs),` qualifies, which
   * is the idiomatic loop and the one worth removing a branch from.
   */
  private isProven(obj: A.Expr, index: A.Expr): boolean {
    if (obj.kind !== "Ident" || index.kind !== "Ident") return false;
    return this.provenIdx.some((p) => p.varName === index.name && p.listName === obj.name);
  }

  /**
   * If this loop is `for i in 0..len(xs),` and its body leaves both `i` and
   * the length of `xs` alone, give back the pair that proves `xs[i]`.
   *
   * Conservative on purpose: anything that could resize the list, rebind
   * either name, or hand the list to code this pass cannot see gives up.
   * Being wrong here reintroduces exactly the out-of-bounds read the check
   * exists to stop.
   */
  private boundedBy(it: A.RangeExpr, s: A.ForStmt): { varName: string; listName: string } | null {
    if (it.inclusive || s.pattern.kind !== "BindPat") return null;
    if (it.step && !(it.step.kind === "IntLit" && it.step.value === 1n)) return null;
    if (!(it.lo && it.lo.kind === "IntLit" && it.lo.value >= 0n)) return null;
    const hi = it.hi;
    if (!hi || hi.kind !== "CallExpr" || hi.callee.kind !== "Ident" || hi.callee.name !== "len") return null;
    const arg = hi.args[0]?.value;
    if (!arg || arg.kind !== "Ident" || !this.isList(this.tyOf(arg))) return null;
    const varName = s.pattern.name;
    const listName = arg.name;
    return this.stable(s.body, varName, listName) ? { varName, listName } : null;
  }

  /** Does this block leave the loop variable and the list's length alone? */
  private stable(b: A.Block, varName: string, listName: string): boolean {
    let ok = true;
    const seeExpr = (e: A.Expr): void => {
      if (!ok || !e) return;
      if (e.kind === "CallExpr") {
        // A method that can resize it, or the list handed to anything that
        // might: `len` is the one call known to leave it alone.
        if (e.callee.kind === "MemberExpr" && rootName(e.callee.obj) === listName) ok = false;
        const callee = e.callee.kind === "Ident" ? e.callee.name : null;
        for (const a of e.args) {
          if (a.value.kind === "Ident" && a.value.name === listName && callee !== "len") ok = false;
        }
      }
      // A task could run beside the loop and resize it.
      if (e.kind === "StartExpr" || e.kind === "MoveExpr") ok = false;
      for (const c of exprKids(e)) seeExpr(c);
    };
    const seeStmt = (st: A.Stmt): void => {
      if (!ok) return;
      if (st.kind === "AssignStmt" && st.target.kind === "Ident"
        && (st.target.name === varName || st.target.name === listName)) ok = false;
      if (st.kind === "LetStmt" && st.pattern.kind === "BindPat"
        && (st.pattern.name === varName || st.pattern.name === listName)) ok = false;
      if (st.kind === "ParallelStmt" || st.kind === "UnsafeStmt") ok = false;
      for (const x of stmtKids(st)) {
        if (x && typeof x === "object" && (x as { kind?: string }).kind === "Block") {
          for (const inner of (x as A.Block).stmts) seeStmt(inner);
        } else if (x) {
          seeExpr(x as A.Expr);
        }
      }
    };
    for (const st of b.stmts) seeStmt(st);
    return ok;
  }

  private isMap(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "map";
  }
  /** The key and value types of a map, for the runtime's sizes and kinds. */
  private mapParts(t: Ty | undefined): { kt: Ty | undefined; vt: Ty | undefined } {
    const p = t ? prune(t) : undefined;
    return p && p.k === "map" ? { kt: p.key, vt: p.val } : { kt: undefined, vt: undefined };
  }

  /**
   * `m[k]`. A missing key reads as null (#7), so this yields the optional
   * the checker already assigned it rather than a bare value.
   */
  private mapGet(obj: A.Expr, key: A.Expr, want: Ty | undefined, span: Span): string {
    const { kt, vt } = this.mapParts(this.tyOf(obj));
    const kc = this.cty(kt, "map key", span);
    const vc = this.cty(vt, "map value", span);
    const o = this.optOf(want);
    const k = this.fresh("gk");
    const out = this.fresh("gv");
    this.line(`${kc} ${k} = ${this.coerce(key, kt)};`);
    if (!o) {
      // Typed as the bare value: only reachable where the checker proved the
      // key is there, so read it without the wrapper.
      this.line(`${vc} ${out} = ${zeroOf(vc)};`);
      this.line(`hk_map_get(${this.expr(obj)}, &${k}, &${out});`);
      return out;
    }
    this.line(`${o.cty} ${out} = { 0 };`);
    this.line(`${out}.has = hk_map_get(${this.expr(obj)}, &${k}, &${out}.v);`);
    return out;
  }

  /** `m[k]: v`. The map retains what it keeps, so temporaries still go free. */
  private mapSet(obj: A.Expr, key: A.Expr, value: A.Expr, span: Span): void {
    const { kt, vt } = this.mapParts(this.tyOf(obj));
    const kc = this.cty(kt, "map key", span);
    const vc = this.cty(vt, "map value", span);
    const k = this.fresh("sk");
    const v = this.fresh("sv");
    this.line(`${kc} ${k} = ${this.coerce(key, kt)};`);
    this.line(`${vc} ${v} = ${this.coerce(value, vt)};`);
    this.line(`hk_map_set(${this.expr(obj)}, &${k}, &${v});`);
    if (kc === "hk_str *" && !isRead(key)) this.line(`hk_str_release(${k});`);
    if (vc === "hk_str *" && !isRead(value)) this.line(`hk_str_release(${v});`);
    if (vc === "hk_list *" && !isRead(value)) this.line(`hk_list_release(${v});`);
  }

  /** The map methods the checker offers (`keys`, `has`, `get_or`, ...). */
  private mapMethod(obj: A.Expr, m: string, e: A.CallExpr): string {
    const { kt, vt } = this.mapParts(this.tyOf(obj));
    const kc = this.cty(kt, "map key", e.span);
    const recv = this.expr(obj);
    const withKey = (body: (k: string) => string): string => {
      const k = this.fresh("mk");
      this.line(`${kc} ${k} = ${this.coerce(e.args[0]!.value, kt)};`);
      const out = body(k);
      if (kc === "hk_str *" && !isRead(e.args[0]!.value)) {
        // The key was only looked up, so a freshly built one is ours still.
        const r = this.fresh("mr");
        this.line(`${this.cty(this.tyOf(e), "result", e.span)} ${r} = ${out};`);
        this.line(`hk_str_release(${k});`);
        return r;
      }
      return out;
    };
    switch (m) {
      case "entries": return this.mapEntries(obj, recv, e);
      case "keys": return `hk_map_keys(${recv})`;
      case "values": return `hk_map_values(${recv})`;
      case "is_empty": return `(hk_map_len(${recv}) == 0)`;
      case "clear": return `(hk_map_clear(${recv}), 0)`;
      case "has": return withKey((k) => `hk_map_has(${recv}, &${k})`);
      case "remove": return withKey((k) => `hk_map_remove(${recv}, &${k})`);
      case "get": return this.mapGet(obj, e.args[0]!.value, this.tyOf(e), e.span);
      case "get_or": {
        const got = this.mapGet(obj, e.args[0]!.value, undefined, e.span);
        const has = this.fresh("go");
        const kk = this.fresh("gk");
        this.line(`${kc} ${kk} = ${this.coerce(e.args[0]!.value, kt)};`);
        this.line(`hk_bool ${has} = hk_map_has(${recv}, &${kk});`);
        if (kc === "hk_str *" && !isRead(e.args[0]!.value)) this.line(`hk_str_release(${kk});`);
        void vt;
        return `(${has} ? ${got} : (${this.expr(e.args[1]!.value)}))`;
      }
    }
    this.err("E0711", `the native backend does not implement \`.${m}\` on a map yet`, e.span,
      "run it with `halka run` while the backend catches up");
    return "0";
  }

  private isList(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && (p.k === "list" || p.k === "array");
  }
  private elemOf(t: Ty | undefined): Ty | undefined {
    const p = t ? prune(t) : undefined;
    return p && (p.k === "list" || p.k === "array") ? p.elem : undefined;
  }
  private isHeap(t: Ty | undefined): boolean { return this.isStr(t) || this.isList(t); }

  // ---- declarations --------------------------------------------------------

  /**
   * An enum becomes a tagged union: one `tag` field naming the variant, and
   * a union of one struct per variant carrying its payload. Tags are the
   * declaration order, so a `match` compiles to a plain `switch`.
   */
  /**
   * `match` over an enum is a `switch` on the tag. Each arm opens a C block
   * and binds its pattern's names to the payload, so the bindings cannot
   * leak between arms and the compiler checks the types for us.
   */
  private matchStmt(m: A.MatchExpr): void {
    const o = this.optOf(this.tyOf(m.subject));
    if (o) { this.matchOptional(m, o); return; }
    const tu = this.tupOf(this.tyOf(m.subject));
    if (tu) { this.matchTuple(m, tu); return; }
    const def = this.enumOf(this.tyOf(m.subject), m.span);
    if (!def) {
      this.err("E0704", "the native backend can only `match` on an enum yet", m.span,
        "run it with `halka run` while the backend catches up");
      return;
    }
    const subject = this.fresh("match");

    this.open("{");
    this.line(`${mangleType(def.key)} ${subject} = ${this.expr(m.subject)};`);
    this.open(`switch (${subject}.tag) {`);
    for (const arm of m.arms) {
      const pat = arm.pattern;
      if (pat.kind !== "VariantPat" && pat.kind !== "TypePat") {
        this.err("E0704", "the native backend only supports variant patterns in a `match` yet", arm.span,
          "run it with `halka run` while the backend catches up");
        continue;
      }
      const name = pat.name;
      const v = def.variants.find((x) => x.name === name);
      if (!v) {
        this.err("E0705", `\`${name}\` is not a variant of \`${def.name}\``, arm.span);
        continue;
      }
      if (arm.guard) {
        this.err("E0704", "the native backend does not support a guard on a `match` arm yet", arm.span,
          "run it with `halka run` while the backend catches up");
        continue;
      }
      this.line(`case ${variantTag(def.key, name)}: {`);
      this.depth++;
      const args = pat.kind === "VariantPat" ? pat.args : [];
      args.forEach((a, i) => {
        const f = v.fields[i];
        if (!f) return;
        if (a.kind === "WildcardPat") return;
        if (a.kind !== "BindPat") {
          this.err("E0704", "the native backend only supports plain names inside a variant pattern yet", arm.span);
          return;
        }
        const fc = this.cty(f.ty, `\`${name}.${f.name}\``);
        if (fc === "void") return; // a `nothing` payload carries no field
        this.line(`${fc} ${mangle(a.name)} = ${subject}.as.${mangle(name)}.${mangle(f.name)};`);
      });
      this.suite(arm.body);
      this.line("break;");
      this.depth--;
      this.line("}");
    }
    if (m.elseArm) {
      this.line("default: {");
      this.depth++;
      this.suite(m.elseArm);
      this.line("break;");
      this.depth--;
      this.line("}");
    }
    this.close();
    this.close();
  }

  /**
   * Register every enum the program can name, as a template. Instantiation
   * happens on demand from `cty`, because a generic enum has no single C
   * type — `Result<int>` and `Result<string>` are different structs.
   */
  private registerEnums(): void {
    for (const [name, variants] of this.opts.enumVariants ?? []) {
      this.enumTemplates.set(name, variants);
      for (const v of variants.keys()) this.variantOwner.set(v, name);
    }
  }

  /**
   * The C type for one instantiation, declaring it the first time it is
   * needed. `args` are the type arguments, already pruned.
   */
  private enumInstance(name: string, args: Ty[], span?: Span): EnumDef | null {
    const template = this.enumTemplates.get(name);
    if (!template) return null;
    const generics = this.opts.enumGenerics?.get(name) ?? [];
    const key = args.length ? `${name}_${args.map(tyKey).join("_")}` : name;
    const existing = this.enums.get(key);
    if (existing) return existing;

    const subst = new Map<string, Ty>();
    generics.forEach((g, i) => { if (args[i]) subst.set(g, args[i]!); });

    let tag = 0;
    const variants: EnumVariantDef[] = [];
    for (const [vname, vi] of template) {
      variants.push({
        name: vname,
        tag: tag++,
        fields: vi.fields.map((ty, i) => ({ name: vi.names[i] ?? `f${i}`, ty: substTy(ty, subst) })),
      });
    }
    const def: EnumDef = { key, name, variants };
    // Registered before the field types are lowered, so an enum that refers
    // to itself does not recurse forever.
    this.enums.set(key, def);
    for (const v of variants) {
      for (const f of v.fields) this.cty(f.ty, `\`${name}.${v.name}.${f.name}\``, span);
    }
    return def;
  }

  /** The instance a typed expression refers to, or null if it is not an enum. */
  private enumOf(t: Ty | undefined, span?: Span): EnumDef | null {
    const p = t ? prune(t) : undefined;
    if (!p || p.k !== "named") return null;
    return this.enumInstance(p.name, (p.args ?? []).map(prune), span);
  }

  private enumDecls(): string[] {
    const out: string[] = [];
    for (const e of this.enums.values()) {
      out.push(`typedef struct ${mangleType(e.key)} {`);
      out.push("  hk_int tag;");
      // A union with no members is not valid C, so an enum whose variants
      // all carry nothing is just the tag.
      // `Result<nothing>`'s Ok carries nothing, and a `void` struct member
      // is not valid C, so a payload of type `nothing` contributes no field.
      const carried = (v: EnumVariantDef) =>
        v.fields.filter((f) => this.cty(f.ty, `\`${e.name}.${v.name}.${f.name}\``) !== "void");
      if (e.variants.some((v) => carried(v).length)) {
        out.push("  union {");
        for (const v of e.variants) {
          const fs = carried(v);
          if (!fs.length) continue;
          out.push(`    struct { ${fs.map((f) => `${this.cty(f.ty, f.name)} ${mangle(f.name)};`).join(" ")} } ${mangle(v.name)};`);
        }
        out.push("  } as;");
      }
      out.push(`} ${mangleType(e.key)};`);
      for (const v of e.variants) out.push(`#define ${variantTag(e.key, v.name)} ${v.tag}`);
      out.push("");
    }
    return out;
  }

  private declareStruct(s: A.StructDecl): void {
    const inferred = this.opts.structFields?.get(s.name);
    const fields = s.fields.map((f, i) => ({
      name: f.name,
      ty: inferred?.[i] ?? this.types.get(f as unknown as A.Node) ?? ({ k: "any" } as Ty),
    }));
    // Field types come from the struct's own declaration nodes when available.
    this.structs.set(s.name, { name: s.name, fields });
  }

  /** Fill in field types from the inferencer once it has run. */
  setStructFields(name: string, fields: { name: string; ty: Ty }[]): void {
    this.structs.set(name, { name, fields });
  }

  private signature(f: A.FnDecl): string {
    const sig = this.tyOf(f);
    const ret = sig ? retOf(sig) : undefined;
    const ps = f.params.map((p, i) => {
      const pt = sig ? paramOf(sig, i) : undefined;
      return `${this.cty(pt, `parameter \`${p.name}\``, p.span)} ${mangle(p.name)}`;
    });
    const rc = this.cty(ret, `the return type of \`${f.name}\``, f.span);
    return `static ${rc} ${mangle(f.name)}(${ps.length ? ps.join(", ") : "void"})`;
  }

  private emitFunction(f: A.FnDecl): void {
    this.out.push("");
    this.out.push(this.signature(f) + " {");
    this.depth = 1;
    this.frameParams = this.opts.escapes?.params.get(f.name) ?? [];
    const fsig = this.tyOf(f);
    this.optParams = new Set(
      f.params.filter((_, i) => fsig && this.optOf(paramOf(fsig, i))).map((p) => p.name),
    );
    const owningFlags = this.opts.owningParams?.get(f.name);
    this.fnParams = new Map(f.params.map((p, i) => [p.name, !!owningFlags?.[i]]));

    const sig = this.tyOf(f);
    const ret = sig ? retOf(sig) : undefined;
    const isVoid = this.cty(ret, "return", f.span) === "void";

    // `defer` (#24) needs one exit path, so functions with defers use a result
    // variable and a cleanup label.
    const defers = collectDefers(f.body!);
    const needsCleanup = defers.length > 0;
    if (needsCleanup && !isVoid) this.line(`${this.cty(ret, "return", f.span)} hk_result = 0;`);

    // #45 — a `requires` clause is checked on entry, which is where the
    // interpreter checks it. Without this a compiled function declared
    // `requires FileAccess` would run for anyone.
    for (const need of f.requires) this.line(`HK_CAP("${need}", "${f.name}");`);

    this.fnCtx = { isVoid, needsCleanup, retTy: ret };
    this.suite(f.body!);

    if (needsCleanup) {
      this.depth--;
      this.line("hk_cleanup:;");
      this.depth++;
      for (const d of defers.slice().reverse()) this.stmt(d.stmt);
      for (const o of this.frameParams.slice().reverse()) this.releaseLocal(o);
      this.line(isVoid ? "return;" : "return hk_result;");
    } else {
      for (const o of this.frameParams.slice().reverse()) this.releaseLocal(o);
      if (!isVoid) this.line(`return ${zeroOf(this.cty(ret, "return", f.span))};`);
    }

    this.frameParams = [];
    this.out.push("}");
  }

  private fnCtx: { isVoid: boolean; needsCleanup: boolean; retTy: Ty | undefined } =
    { isVoid: true, needsCleanup: false, retTy: undefined };

  /**
   * The value a `give` hands back, with the count put right.
   *
   * A local holding a handle owns a count, either because it built the box
   * or because binding it retained; returning one transfers that count and
   * the frame does not release it. A *borrowed* parameter is the opposite:
   * the caller still holds the only count, so handing it out without
   * adding one frees the value while the caller is still using it.
   *
   * Which it is cannot be read off the syntax. It is not "is this name in
   * the live list" either, since a value that escapes through `give` is
   * deliberately left out of that list.
   */
  private giveValue(e: A.Expr): string {
    const base = this.coerce(e, this.fnCtx.retTy, false);
    if (e.kind !== "Ident" || !this.sharedOf(this.tyOf(e))) return base;
    const owning = this.fnParams.get(e.name);
    // Not a parameter, or one the caller handed over: the count is ours.
    if (owning === undefined || owning) return base;
    return `hk_shared_retain(${base})`;
  }

  private releaseLocal(o: Owned): void {
    if (o.kind === "shared") { this.line(`hk_shared_release(${mangle(o.name)});`); return; }
    if (o.kind === "weak") { this.line(`hk_weak_release(${mangle(o.name)});`); return; }
    if (o.kind === "struct") {
      const fn = this.structReleaser(this.structNameOf(o.ty) ?? "");
      if (fn) this.line(`${fn}(&${mangle(o.name)});`);
      return;
    }
    if (o.kind === "json") { this.line(`hk_json_release(${mangle(o.name)});`); return; }
    if (o.kind === "tuple") {
      const info = this.tupOf(o.ty);
      if (info) this.line(`hk_tuple_drop(&${mangle(o.name)}, &${this.tupDescOf(info.key)});`);
      return;
    }
    if (o.kind === "map") { this.line(`hk_map_release(${mangle(o.name)});`); return; }
    if (o.kind === "opt") {
      // Only when it holds something: the wrapper owns nothing itself.
      const p = o.ty ? prune(o.ty) : undefined;
      const inner = p && p.k === "opt" ? prune(p.inner) : undefined;
      const free = inner && (inner.k === "list" || inner.k === "array")
        ? "hk_list_release"
        : inner && inner.k === "prim" && inner.name === "string" ? "hk_str_release" : null;
      if (free) this.line(`if (${mangle(o.name)}.has) ${free}(${mangle(o.name)}.v);`);
      return;
    }
    if (o.kind === "enum") {
      const fn = this.enumReleaser(o.ty);
      if (fn) this.line(`${fn}(${mangle(o.name)});`);
      return;
    }
    this.line(o.kind === "str" ? `hk_str_release(${mangle(o.name)});` : `hk_list_release(${mangle(o.name)});`);
  }

  /**
   * A releaser for one monomorphised enum: a switch on the tag that frees
   * whatever that variant carries. Generated once per instantiation, and
   * only when some variant actually carries heap memory.
   */
  private enumReleaser(t: Ty | undefined): string | null {
    const inst = this.enumOf(t);
    if (!inst) return null;
    const name = `hk_free_${inst.key}`;
    if (this.wrappers.has(name)) return name;

    const arms: string[] = [];
    for (const v of inst.variants) {
      const frees = v.fields
        .map((f) => ({ f, c: this.cty(f.ty, f.name) }))
        .filter(({ c }) => c === "hk_str *" || c === "hk_list *")
        .map(({ f, c }) => `${c === "hk_str *" ? "hk_str_release" : "hk_list_release"}(v.as.${mangle(v.name)}.${mangle(f.name)});`);
      if (frees.length) arms.push(`    case ${variantTag(inst.key, v.name)}: ${frees.join(" ")} break;`);
    }
    if (!arms.length) return null;

    this.wrappers.add(name);
    this.aux.push(
      `static void ${name}(${mangleType(inst.key)} v) {`,
      "  switch (v.tag) {",
      ...arms,
      "    default: break;",
      "  }",
      "}",
      "",
    );
    return name;
  }

  /**
   * A releaser for one struct: frees whatever its fields own. Generated
   * once per struct that owns anything, and null when none of its fields
   * do -- a struct of scalars needs no cleanup.
   *
   * Without this a struct local holding a string leaked it on every scope
   * exit, because escape analysis only knew how to release enums.
   */
  private structReleaser(name: string): string | null {
    const def = this.structs.get(name);
    if (!def) return null;
    const fn = `hk_free_s_${name}`;
    if (this.wrappers.has(fn)) return fn;

    const frees: string[] = [];
    for (const f of def.fields) {
      const c = this.cty(f.ty, f.name);
      if (c === "hk_str *") frees.push(`  hk_str_release(v->${mangle(f.name)});`);
      else if (c === "hk_list *") frees.push(`  hk_list_release(v->${mangle(f.name)});`);
      else if (c === "hk_map *") frees.push(`  hk_map_release(v->${mangle(f.name)});`);
      else {
        const inner = this.structReleaser(this.structNameOf(f.ty) ?? "");
        if (inner) frees.push(`  ${inner}(&v->${mangle(f.name)});`);
      }
    }
    if (!frees.length) return null;

    this.wrappers.add(fn);
    this.aux.push(`static void ${fn}(${mangleType(name)} *v) {`, ...frees, "}", "");
    return fn;
  }

  /** The payload type of a `shared(T)`, if this is one. */
  private sharedOf(t: Ty | undefined): Ty | null {
    const p = t ? prune(t) : undefined;
    return p && p.k === "shared" ? p.inner : null;
  }

  /** The payload type of a `weak(T)`, if this is one. */
  private weakOf(t: Ty | undefined): Ty | null {
    const p = t ? prune(t) : undefined;
    return p && p.k === "weak" ? p.inner : null;
  }

  /**
   * A `void (*)(void *)` that releases one payload type, for the box to
   * call when its last owner goes. Null when the payload owns nothing.
   */
  private sharedDrop(inner: Ty, span: Span): string {
    const name = this.structNameOf(inner);
    const rel = name ? this.structReleaser(name) : null;
    if (!rel || !name) return "NULL";
    const fn = `hk_drop_${name}`;
    if (this.wrappers.has(fn)) return fn;
    this.wrappers.add(fn);
    // A wrapper rather than a cast: calling a function through a pointer of
    // a different signature is undefined, however reliably it works.
    this.aux.push(
      `static void ${fn}(void *p) { ${rel}((${mangleType(name)} *)p); }`,
      "",
    );
    void span;
    return fn;
  }

  /** Put a plain T into a fresh `shared(T)` box. */
  private shareValue(cExpr: string, inner: Ty, span: Span): string {
    const ct = this.cty(inner, "shared value", span);
    const tmp = this.fresh("shv");
    this.line(`${ct} ${tmp} = ${cExpr};`);
    return `hk_shared_new(&${tmp}, sizeof(${ct}), ${this.sharedDrop(inner, span)})`;
  }

  /** The struct this type names, if it names one. */
  private structNameOf(t: Ty | undefined): string | null {
    const p = t ? prune(t) : undefined;
    return p && p.k === "named" && this.structs.has(p.name) ? p.name : null;
  }

  /** Emit a block's statements, freeing what it owns on the way out (M4). */
  private suite(b: A.Block, isLoopBody = false, override?: Owned[], caps = 0): void {
    const owned = override ?? this.opts.escapes?.blocks.get(b) ?? [];
    const frame = {
      owned: new Set(owned.map((o) => o.name)),
      kinds: new Map(owned.map((o) => [o.name, o.kind] as const)),
      types: new Map(owned.map((o) => [o.name, o.ty] as const)),
      // Which names this block declares, and which of those are stored as
      // optionals. Scoped rather than per-function, so an inner block that
      // shadows an optional with a plain value is read correctly.
      declared: new Set<string>(),
      optVars: new Set<string>(),
      live: [] as Owned[],
      caps,
      isLoopBody,
    };
    this.blockStack.push(frame);
    for (const st of b.stmts) this.stmt(st);
    for (const o of frame.live.slice().reverse()) this.releaseLocal(o);
    for (let i = 0; i < frame.caps; i++) this.line("hk_cap_pop();");
    this.blockStack.pop();
  }

  /** Free everything in scope before returning; the returned value is kept. */
  private releaseForReturn(keep?: string): void {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      for (const o of this.blockStack[i]!.live.slice().reverse()) {
        if (o.name !== keep) this.releaseLocal(o);
      }
      // A `give` out of a `with capability` block must not leave the grant
      // standing for whatever runs next.
      for (let c = 0; c < this.blockStack[i]!.caps; c++) this.line("hk_cap_pop();");
    }
    for (const o of this.frameParams.slice().reverse()) if (o.name !== keep) this.releaseLocal(o);
  }

  /** Free everything down to and including the nearest loop body. */
  private releaseForLoopExit(): void {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      for (const o of this.blockStack[i]!.live.slice().reverse()) this.releaseLocal(o);
      for (let c = 0; c < this.blockStack[i]!.caps; c++) this.line("hk_cap_pop();");
      if (this.blockStack[i]!.isLoopBody) return;
    }
  }

  // ---- statements ----------------------------------------------------------

  private stmt(s: A.Stmt): void {
    // A value built inside an expression and never bound to a name is this
    // statement's responsibility, so it is freed as soon as the statement ends.
    const saved = this.stmtTemps;
    this.stmtTemps = [];
    this.stmtInner(s);
    for (const t of this.stmtTemps.slice().reverse()) this.releaseLocal(t);
    this.stmtTemps = saved;
  }

  /**
   * Give the statement ownership of any argument the callee only borrows.
   * A parameter borrows unless ownership analysis says the callee moves it
   * (M2.2), so a list or string built for the call is still the caller's to
   * free -- without this `f([1, 2, 3])` leaked the literal on every call.
   * `owning` is absent for a prelude function, which borrows everything.
   */
  private holdArgs(e: A.CallExpr, args: string[], owning?: boolean[]): void {
    e.args.forEach((a, i) => {
      if (owning?.[i]) return; // the callee frees it
      const k = a.value.kind;
      if (k === "Ident" || k === "MemberExpr" || k === "IndexExpr") return; // borrowed from elsewhere
      const at = this.tyOf(a.value);
      const ac = at ? this.cty(at, "argument") : "";
      if (ac === "hk_list *") args[i] = this.holdTemp(args[i]!, "list");
      else if (ac === "hk_str *") args[i] = this.holdTemp(args[i]!, "str");
      else if (ac === "hk_map *") args[i] = this.holdTemp(args[i]!, "map");
      else if (ac === "hk_json *") args[i] = this.holdTemp(args[i]!, "json");
    });
  }

  /** Bind a freshly built value so the statement can free it again. */
  private holdTemp(cExpr: string, kind: "str" | "list" | "map" | "json"): string {
    const cty = kind === "str" ? "hk_str *" : kind === "map" ? "hk_map *"
      : kind === "json" ? "hk_json *" : "hk_list *";
    const v = this.fresh(kind === "str" ? "tstr" : kind === "map" ? "tmap"
      : kind === "json" ? "tjsn" : "tlst");
    this.line(`${cty}${v} = ${cExpr};`);
    this.stmtTemps.push({ name: v, kind });
    return v;
  }

  private stmtInner(s: A.Stmt): void {
    switch (s.kind) {
      case "FnDecl": case "StructDecl": case "EnumDecl": case "TraitDecl":
      case "ImplDecl": case "TypeAliasDecl": case "CapabilityDecl":
      case "ImportDecl": case "ExportDecl": case "ExternDecl":
      case "SpecializeDecl": case "GenerateDecl":
        return;

      case "DeferStmt": return; // hoisted to the cleanup block

      case "LetStmt": case "ConstDecl": {
        if (s.kind === "ConstDecl") {
          const t = this.tyOf(s.value);
          this.line(`${this.cty(t, `\`${s.name}\``, s.span)} ${mangle(s.name)} = ${this.expr(s.value)};`);
          return;
        }
        if (s.pattern.kind === "TuplePat" && s.value && this.tupOf(this.tyOf(s.value))) {
          this.destructureTuple(s.pattern, s.value);
          return;
        }
        if (s.pattern.kind !== "BindPat") {
          this.err("E0702", "the native backend does not support destructuring yet", s.span,
            "bind the value to one name, then index it");
          return;
        }
        const t = this.tyOf(s.pattern as unknown as A.Node) ?? (s.value ? this.tyOf(s.value) : undefined);
        const ct = this.cty(t, `\`${s.pattern.name}\``, s.span);
        const init = s.value ? this.coerce(s.value, t) : (this.optOf(t) ? this.optNone(ct) : zeroOf(ct));
        this.noteDecl(s.pattern.name, t);
        // A module-level constant is already declared at file scope.
        if (this.inMain && this.moduleConsts.has(s.pattern.name)) {
          this.line(`${mangle(s.pattern.name)} = ${init};`);
          return;
        }
        this.line(`${ct} ${mangle(s.pattern.name)} = ${init};`);
        const here = this.blockStack[this.blockStack.length - 1];
        if (here?.owned.has(s.pattern.name)) {
          here.live.push({
            name: s.pattern.name,
            kind: here.kinds.get(s.pattern.name) ?? "list",
            ty: here.types.get(s.pattern.name),
          });
        }
        return;
      }

      case "AssignStmt": {
        const t = s.target;
        if (t.kind === "Ident") {
          // Rebinding a handle gives back the one it held first, or the
          // count it was holding is lost.
          const tt = this.tyOf(t);
          const rebound = this.coerce(s.value, tt);
          if (this.sharedOf(tt)) this.line(`hk_shared_release(${mangle(t.name)});`);
          else if (this.weakOf(tt)) this.line(`hk_weak_release(${mangle(t.name)});`);
          this.line(`${mangle(t.name)} = ${rebound};`);
          return;
        }
        if (t.kind === "MemberExpr") { this.line(`${this.expr(t)} = ${this.expr(s.value)};`); return; }
        if (t.kind === "IndexExpr") {
          const ot = this.tyOf(t.obj);
          if (this.isList(ot)) {
            const et = this.cty(this.elemOf(ot), "element", t.span);
            this.line(`HK_IDX(${this.expr(t.obj)}, ${et}, ${this.expr(t.index)}) = ${this.expr(s.value)};`);
            return;
          }
          if (this.isMap(ot)) { this.mapSet(t.obj, t.index, s.value, t.span); return; }
        }
        this.err("E0703", "the native backend cannot assign to this target yet", s.span);
        return;
      }

      case "ExprStmt": {
        const t = this.tyOf(s.expr);
        const p = t ? prune(t) : undefined;
        const e = this.expr(s.expr);
        const isVoid = p?.k === "prim" && (p.name === "nothing" || p.name === "null");
        const isUnknown = !p || p.k === "any" || p.k === "var";
        // `(void)` discards the result; a foreign call for its side effect is
        // fine even when we cannot name its type.
        this.line(isVoid ? `${e};` : isUnknown ? `(void)(${e});` : `(void)(${e});`);
        return;
      }

      case "SayStmt": {
        if (!s.args.length) { this.line(`hk_say_cstr("");`); return; }
        // `say` builds a string; bind it so the frame can free it again.
        const pieces: string[] = [];
        s.args.forEach((a, i) => {
          if (i) pieces.push(this.strLitConst(" "));
          pieces.push(this.asStrOwned(a));
        });
        const acc = pieces.length === 1 ? pieces[0]! : `hk_str_join(${pieces.length}, (hk_str *[]){ ${pieces.join(", ")} })`;
        const t = this.fresh("say");
        this.line(`hk_str *${t} = ${acc};`);
        this.line(`hk_say(${t});`);
        this.line(`hk_str_release(${t});`);
        return;
      }

      case "GiveStmt": {
        const keep = s.value?.kind === "Ident" ? s.value.name : undefined;
        if (this.inMain) {
          this.releaseForReturn(keep);
          this.line("hk_shutdown();");
          this.line("return 0;");
          return;
        }
        if (this.fnCtx.needsCleanup) {
          if (s.value && !this.fnCtx.isVoid) this.line(`hk_result = ${this.giveValue(s.value)};`);
          // Block-scoped values must go before the jump; C scopes end here.
          this.releaseForReturn(keep);
          this.line("goto hk_cleanup;");
          return;
        }
        const value = s.value && !this.fnCtx.isVoid ? this.giveValue(s.value) : null;
        this.releaseForReturn(keep);
        this.line(value !== null ? `return ${value};` : "return;");
        return;
      }

      // Both leave the loop body, so its values are freed first.
      case "BreakStmt": this.releaseForLoopExit(); this.line("break;"); return;
      case "ContinueStmt": this.releaseForLoopExit(); this.line("continue;"); return;

      case "IfStmt": {
        this.open(`if (${this.cond(s.cond)}) {`);
        this.suite(s.then);
        for (const e of s.elifs) {
          this.close(`} else if (${this.cond(e.cond)}) {`);
          this.depth++;
          this.suite(e.block);
        }
        if (s.else) {
          this.close("} else {");
          this.depth++;
          this.suite(s.else);
        }
        this.close();
        return;
      }

      case "WhileStmt": {
        this.open(`while (${this.cond(s.cond)}) {`);
        this.suite(s.body, true);
        this.close();
        return;
      }

      case "ForStmt": return this.forStmt(s);

      case "UnsafeStmt": {
        this.open("{");
        this.suite(s.body);
        this.close();
        return;
      }

      case "ParallelStmt": return this.parallelStmt(s);

      case "WithStmt": {
        if (!s.capability) {
          this.err("E0704", "the native backend supports `with capability` only, for now", s.span,
            "run it with `halka run` while the backend catches up");
          return;
        }
        const name = s.subject.kind === "Ident" ? s.subject.name : null;
        if (!name) {
          this.err("E0503", "`with capability` expects a capability name", s.span);
          return;
        }
        this.open("{");
        this.line(`hk_cap_push("${name}");`);
        // The pop is recorded on the body's own frame, so every path out of
        // it — falling off the end, `give`, `break` — pops exactly once.
        this.suite(s.body, false, undefined, 1);
        this.close();
        return;
      }

      case "MatchStmt": return this.matchStmt(s.expr);

      default:
        this.err("E0704", `the native backend does not support \`${describeStmt(s)}\` yet`, s.span,
          "run it with `halka run` while the backend catches up");
        return;
    }
  }

  /**
   * #32 — `parallel:` runs each branch on its own OS thread. There is no
   * interpreter lock, so this uses every core.
   *
   * Each branch must be a binding to a call, which is the form #32 locks:
   *     parallel:
   *         first: calculate_a(),
   *         second: calculate_b()
   * The call's arguments are the branch's captured state, so the capture set
   * is explicit in the source and needs no escape analysis.
   */
  private parallelStmt(s: A.ParallelStmt): void {
    interface Branch { name: string | null; declare: boolean; call: A.CallExpr; ret: Ty | undefined }
    const branches: Branch[] = [];

    for (const st of s.body.stmts) {
      let name: string | null = null;
      let declare = false;
      let value: A.Expr | null = null;
      if (st.kind === "LetStmt" && st.pattern.kind === "BindPat" && st.value) {
        name = st.pattern.name;
        declare = true;              // scoped to the block
        value = st.value;
      } else if (st.kind === "AssignStmt" && st.target.kind === "Ident") {
        name = st.target.name;       // the #32 idiom: assign to an outer name
        value = st.value;
      } else if (st.kind === "ExprStmt") {
        value = st.expr;
      }
      if (!value || value.kind !== "CallExpr" || value.callee.kind !== "Ident") {
        this.err("E0715", "each branch of a `parallel:` block must call a function", st.span,
          "write `let result: work(args),` — the arguments are what the branch captures");
        return;
      }
      branches.push({ name, declare, call: value, ret: this.tyOf(value) });
    }
    if (!branches.length) return;

    const id = this.parN++;
    const handles: string[] = [];

    this.open("{");
    branches.forEach((b, i) => {
      const fname = (b.call.callee as A.Ident).name;
      const argTys = b.call.args.map((a) => this.tyOf(a.value));
      const retC = this.cty(b.ret, "branch result", b.call.span);
      const sname = `hk_par${id}_${i}`;

      // Top-level capture struct and trampoline.
      const fields = argTys.map((t, j) => `  ${this.cty(t, "captured argument", b.call.span)} a${j};`);
      this.aux.push(`typedef struct ${sname} {`);
      this.aux.push(...fields);
      if (retC !== "void") this.aux.push(`  ${retC} result;`);
      this.aux.push(`} ${sname};`);
      this.aux.push(`static void *${sname}_run(void *hk_p) {`);
      this.aux.push(`  ${sname} *hk_s = (${sname} *)hk_p;`);
      const callArgs = argTys.map((_, j) => `hk_s->a${j}`).join(", ");
      this.aux.push(retC === "void" ? `  ${mangle(fname)}(${callArgs});` : `  hk_s->result = ${mangle(fname)}(${callArgs});`);
      this.aux.push("  return NULL;");
      this.aux.push("}");
      this.aux.push("");

      const sv = `hk_ps${id}_${i}`;
      const args = b.call.args.map((a) => this.expr(a.value));
      this.line(`${sname} ${sv};`);
      args.forEach((a, j) => this.line(`${sv}.a${j} = ${a};`));
      const hv = `hk_pt${id}_${i}`;
      this.line(`hk_thread *${hv} = hk_spawn(${sname}_run, &${sv});`);
      handles.push(hv);
    });

    for (const h of handles) this.line(`hk_join(${h});`);
    branches.forEach((b, i) => {
      if (!b.name) return;
      const retC = this.cty(b.ret, "branch result", b.call.span);
      if (retC === "void") return;
      if (b.declare) {
        this.line(`${retC} ${mangle(b.name)} = hk_ps${id}_${i}.result;`);
        this.line(`(void)${mangle(b.name)};`);
      } else {
        this.line(`${mangle(b.name)} = hk_ps${id}_${i}.result;`);
      }
    });
    this.close();
  }

  /**
   * `for e in m` — each entry as a `(key, value)` tuple, built per iteration
   * straight from the map's dense arrays. No intermediate list is made, and
   * the tuple borrows the key and value rather than retaining them, the way
   * reading a list element does.
   */
  private forEachMapEntry(s: A.ForStmt, v: string, it: A.Expr, t: Ty | undefined): void {
    const info = this.tupOf(this.tyOf(s.pattern as unknown as A.Node) ?? this.elemTypeOfMap(t));
    if (!info) {
      this.err("E0705", "the native backend cannot build this map's entry tuple yet", s.span);
      return;
    }
    const { kt, vt } = this.mapParts(t);
    const kc = this.cty(kt, "map key", s.span);
    const vc = this.cty(vt, "map value", s.span);
    const mv = this.fresh("mit");
    const i = this.fresh("me");
    const owns = !isRead(it);
    this.open("{");
    this.line(`hk_map *${mv} = ${this.expr(it)};`);
    if (owns) {
      this.pushScope();
      this.blockStack[this.blockStack.length - 1]!.live.push({ name: mv, kind: "map" });
    }
    this.open(`for (hk_int ${i} = 0; ${i} < ${mv}->used; ${i}++) {`);
    this.line(`if (!${mv}->live[${i}]) continue;`);
    this.line(`${info.cty} ${v} = { .f0 = *(${kc} *)(${mv}->keys + ${i} * ${mv}->ksz),` +
      ` .f1 = *(${vc} *)(${mv}->vals + ${i} * ${mv}->vsz) };`);
    this.suite(s.body, true);
    this.close();
    if (owns) {
      this.popScope();
      this.line(`hk_map_release(${mv});`);
    }
    this.close();
  }

  private elemTypeOfMap(t: Ty | undefined): Ty | undefined {
    const p = t ? prune(t) : undefined;
    return p && p.k === "map" ? { k: "tuple", elems: [p.key, p.val] } as Ty : undefined;
  }

  private forStmt(s: A.ForStmt): void {
    if (s.pattern.kind !== "BindPat") {
      this.err("E0702", "the native backend does not support destructuring in a for loop yet", s.span);
      return;
    }
    const v = mangle(s.pattern.name);
    const it = s.iter;

    // `for i in a..b` lowers to a plain C for loop — no iterator, no allocation.
    if (it.kind === "RangeExpr" && it.lo && it.hi) {
      // `for i in 0..len(xs),` bounds `i` for the whole body, so `xs[i]`
      // inside needs no check — provided nothing in there changes either.
      const bounded = this.boundedBy(it, s);
      if (bounded) this.provenIdx.push(bounded);
      const lo = this.expr(it.lo);
      const hi = this.fresh("hi");
      const cmp = it.inclusive ? "<=" : "<";
      this.line(`const hk_int ${hi} = ${this.expr(it.hi)};`);
      const step = it.step ? this.expr(it.step) : "1";
      this.open(`for (hk_int ${v} = ${lo}; ${v} ${cmp} ${hi}; ${v} += ${step}) {`);
      this.suite(s.body, true);
      this.close();
      if (bounded) this.provenIdx.pop();
      return;
    }

    const t = this.tyOf(it);
    if (this.isList(t)) {
      const lst = this.fresh("lst");
      const i = this.fresh("i");
      const et = this.cty(this.elemOf(t), "element", s.span);
      // A list built to be looped over — `for x in [1, 2, 3]`, or over
      // `m.keys()` — belongs to nobody else, so the loop frees it. Reading
      // one from a variable borrows it and must not.
      const owns = !isRead(it);
      this.open("{");
      this.line(`hk_list *${lst} = ${this.expr(it)};`);
      // Recorded on a frame of its own so a `give` out of the loop frees it
      // too. `break` unwinds only as far as the loop body, so it falls out
      // to the release below instead of doing it twice.
      if (owns) {
        this.pushScope();
        this.blockStack[this.blockStack.length - 1]!.live.push({ name: lst, kind: "list" });
      }
      this.open(`for (hk_int ${i} = 0; ${i} < ${lst}->len; ${i}++) {`);
      this.line(`${et} ${v} = HK_AT(${lst}, ${et}, ${i});`);
      this.suite(s.body, true);
      this.close();
      if (owns) {
        this.popScope();
        this.line(`hk_list_release(${lst});`);
      }
      this.close();
      return;
    }

    if (this.isMap(t)) { this.forEachMapEntry(s, v, it, t); return; }

    this.err("E0705", `the native backend cannot iterate ${show(prune(t ?? ({ k: "any" } as Ty)))} yet`, s.span,
      "iterate a range (`for i in 0..n,`) or a list");
  }

  // ---- expressions ---------------------------------------------------------

  private expr(e: A.Expr): string {
    switch (e.kind) {
      case "IntLit": {
        const v = e.value;
        if (v === -9223372036854775808n) return "HK_INT_MIN";
        return `INT64_C(${v})`;
      }
      case "FloatLit": return formatDouble(e.value);
      case "BoolLit": return e.value ? "true" : "false";
      case "CharLit": return `UINT32_C(${e.value.codePointAt(0) ?? 0})`;
      case "NullLit": return "NULL";
      case "NothingLit": return "0";
      case "Ident": {
        // A variant that carries nothing is written bare, as a value rather
        // than a call, so `Done` has to build the tagged union here too.
        if (this.variantOwner.has(e.name)) {
          const inst = this.enumOf(this.tyOf(e), e.span);
          const v = inst?.variants.find((x) => x.name === e.name);
          if (inst && v && v.fields.length === 0) {
            return `((${mangleType(inst.key)}){ .tag = ${variantTag(inst.key, e.name)} })`;
          }
        }
        // Narrowing (#7, R10) happens in the checker: inside the false arm
        // of `x is null`, `x` has type `T` while the C variable is still a
        // `T?`. Reading `.v` is what makes the two agree, and the checker
        // has already established the value is there.
        if (this.isOptVar(e.name) && !this.optOf(this.tyOf(e))) return `${mangle(e.name)}.v`;
        return mangle(e.name);
      }

      case "StrLit": return this.strLit(e);

      case "UnaryExpr": {
        if (e.op === "not") return `(!(${this.expr(e.operand)}))`;
        if (e.op === "-") return `(-(${this.expr(e.operand)}))`;
        return `(+(${this.expr(e.operand)}))`;
      }

      case "BinaryExpr": return this.binary(e);

      case "CallExpr": return this.call(e);

      case "MemberExpr": {
        const ot = this.tyOf(e.obj);
        // A `shared` handle reads through to its payload, the way the
        // checker types it: `cache.hits`, not an unwrap at every use.
        const shInner = this.sharedOf(ot);
        if (shInner) {
          const ct = this.cty(shInner, "shared value", e.span);
          return `HK_SHARED_AS(${this.expr(e.obj)}, ${ct}).${mangle(e.name)}`;
        }
        if (this.isList(ot) && (e.name === "length" || e.name === "size")) return `(${this.expr(e.obj)})->len`;
        if (this.isStr(ot) && (e.name === "length" || e.name === "size")) return `hk_str_len_chars(${this.expr(e.obj)})`;
        const p = ot ? prune(ot) : undefined;
        if (p?.k === "named" && this.structs.has(p.name)) return `(${this.expr(e.obj)}).${mangle(e.name)}`;
        const enumInst = p?.k === "named" ? this.enumOf(p, e.span) : null;
        if (enumInst) {
          // A payload field is reached through its variant's arm of the
          // union. The field name identifies the variant, so reading a field
          // that two variants share is refused rather than guessed at.
          const def = enumInst;
          const owners = def.variants.filter((v) => v.fields.some((f) => f.name === e.name));
          if (owners.length === 1) {
            return `(${this.expr(e.obj)}).as.${mangle(owners[0]!.name)}.${mangle(e.name)}`;
          }
          if (owners.length > 1) {
            this.err("E0706",
              `\`.${e.name}\` is carried by more than one variant of \`${def.name}\` ` +
              `(${owners.map((v) => v.name).join(", ")}), so it is ambiguous here`, e.span,
              "match on the value instead, which binds the payload per variant");
            return "0";
          }
        }
        this.err("E0706", `the native backend cannot read \`.${e.name}\` yet`, e.span);
        return "0";
      }

      case "IndexExpr": {
        const ot = this.tyOf(e.obj);
        if (this.isList(ot)) {
          const et = this.cty(this.elemOf(ot), "element", e.span);
          const acc = this.opts.uncheckedIndex || this.isProven(e.obj, e.index) ? "HK_AT" : "HK_IDX";
          return `${acc}(${this.expr(e.obj)}, ${et}, ${this.expr(e.index)})`;
        }
        if (this.isJsonDoc(ot)) {
          // A missing key or an out-of-range index reads as null (#7), which
          // the runtime gives back as an absent document rather than failing.
          return this.isStr(this.tyOf(e.index))
            ? `hk_json_get(${this.expr(e.obj)}, ${this.expr(e.index)})`
            : `hk_json_at(${this.expr(e.obj)}, ${this.expr(e.index)}, ${this.loc(e.span)})`;
        }
        if (this.isMap(ot)) return this.mapGet(e.obj, e.index, this.tyOf(e), e.span);
        const tu = this.tupOf(ot);
        if (tu) {
          // Each field has its own type, so which one is being read has to be
          // known while compiling. A variable index cannot be.
          if (e.index.kind !== "IntLit") {
            this.err("E0707", "a tuple index must be a literal in compiled code", e.index.span,
              "the fields have different types, so the index has to be known at compile time");
            return "0";
          }
          const raw = Number(e.index.value);
          const i = raw < 0 ? raw + tu.elems.length : raw;
          if (i < 0 || i >= tu.elems.length) {
            this.err("E0707", `index ${raw} is out of range for a ${tu.elems.length}-tuple`, e.index.span);
            return "0";
          }
          return `${atom(this.expr(e.obj))}.f${i}`;
        }
        this.err("E0707", "the native backend can only index a list, a map or a tuple so far", e.span);
        return "0";
      }

      case "ListExpr": return this.listLit(e);
      case "MapExpr": return this.mapLit(e);
      case "TupleExpr": return this.tupleLit(e);

      case "CastExpr": return this.cast(e);

      case "MoveExpr": return this.expr(e.expr);
      case "CompileExpr": return this.expr(e.expr);
      case "DeviceExpr": return this.expr(e.expr);

      case "ForeignExpr": return this.foreignExpr(e);

      case "IsExpr": {
        if (e.test === "null") {
          const o = this.optOf(this.tyOf(e.expr));
          if (o) return `(!(${this.expr(e.expr)}).has)`;
          return `((${this.expr(e.expr)}) == NULL)`;
        }
        if (this.variantOwner.has(e.test)) {
          const inst = this.enumOf(this.tyOf(e.expr), e.span);
          if (inst) return `((${this.expr(e.expr)}).tag == ${variantTag(inst.key, e.test)})`;
        }
        this.err("E0708", `the native backend cannot test \`is ${e.test}\` yet`, e.span);
        return "false";
      }

      default:
        this.err("E0709", `the native backend does not support this expression yet (${e.kind})`, e.span,
          "run it with `halka run` while the backend catches up");
        return "0";
    }
  }

  /** `c malloc(100)`, `c Point`, `py numpy.array(...)` (#35-#37). */
  private foreignExpr(e: A.ForeignExpr): string {
    if (e.lang === "cpp") {
      this.err("E0716", "C++ interop needs the cpp shim, which is not built yet", e.span,
        "use the C boundary (`c ...`) for now");
      return "0";
    }
    if (e.lang === "py") return this.pyExpr(e);

    const inner = e.expr;
    if (inner.kind === "CallExpr") {
      const name = inner.callee.kind === "Ident" ? inner.callee.name
        : inner.callee.kind === "MemberExpr" ? this.expr(inner.callee)
        : null;
      if (!name) { this.err("E0717", "a `c` call must name a function", e.span); return "0"; }
      const args = inner.args
        .filter((a) => a.value.kind !== "EllipsisExpr")
        .map((a) => this.toC(a.value));
      return `${name}(${args.join(", ")})`;
    }
    if (inner.kind === "Ident") return inner.name;
    if (inner.kind === "MemberExpr") return this.expr(inner);
    this.err("E0717", "this is not something the `c` boundary can express", e.span);
    return "0";
  }

  /** `py numpy.array(...)`, `py math.sqrt(25)`, `py mod.attr` (#37). */
  private pyExpr(e: A.ForeignExpr): string {
    const inner = e.expr;

    if (inner.kind === "CallExpr") {
      const args = inner.args
        .filter((a) => a.value.kind !== "EllipsisExpr")
        .map((a) => this.toPy(a.value));
      const argv = args.length ? `(PyObject *[]){ ${args.join(", ")} }` : "NULL";

      // `py a.b.c(...)` — resolve the receiver, then call the final attribute
      // as a method, so attribute chains of any depth work.
      if (inner.callee.kind === "MemberExpr") {
        const recv = this.pyResolve(inner.callee.obj, e.span);
        if (recv) {
          return `hk_py_call_method(${recv}, ${cString(inner.callee.name)}, ${argv}, ${args.length}, ${this.loc(e.span)})`;
        }
      }
      const fn = this.pyResolve(inner.callee, e.span);
      if (fn) {
        const what = inner.callee.kind === "Ident" ? cString(inner.callee.name) : '"call"';
        return `hk_py_call(${fn}, ${argv}, ${args.length}, ${what}, ${this.loc(e.span)})`;
      }
      this.err("E0718", "this python callee cannot be resolved", e.span,
        "call a module function (`py math.sqrt(x)`) or an attribute of one");
      return "Py_None";
    }

    const resolved = this.pyResolve(inner, e.span);
    if (resolved) return resolved;
    this.err("E0718", "this is not something the `py` boundary can express yet", e.span,
      "call a module function (`py math.sqrt(x)`) or read an attribute");
    return "Py_None";
  }

  /** C for any Python-rooted expression: a module, a bound name, or `a.b.c`. */
  private pyResolve(e: A.Expr, span: Span): string | null {
    if (e.kind === "Ident") {
      const bound = this.pyNames.get(e.name);
      if (bound) return bound.slot;
      const modSlot = this.pyModuleSlot(e.name);
      if (modSlot) return modSlot;
      // A local already holding a Python value.
      const t = this.tyOf(e);
      const p = t ? prune(t) : undefined;
      if (p?.k === "cty" && p.lang === "py") return mangle(e.name);
      return null;
    }
    if (e.kind === "MemberExpr") {
      const obj = this.pyResolve(e.obj, span);
      if (!obj) return null;
      return `hk_py_attr(${obj}, ${cString(e.name)}, ${this.loc(span)})`;
    }
    if (e.kind === "ForeignExpr" && e.lang === "py") return this.pyExpr(e);
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    if (p?.k === "cty" && p.lang === "py") return this.expr(e);
    return null;
  }

  private pyModuleSlot(name: string): string | null {
    for (const [path, slot] of this.pyModules) {
      const base = path.split(/[./]/).pop();
      if (path === name || base === name) return slot;
    }
    return null;
  }

  /** Lift a Halka value into a Python object (implicit, #37). */
  private toPy(e: A.Expr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    if (p?.k === "cty" && p.lang === "py") return this.expr(e);
    const ct = this.cty(t, "python argument", e.span);
    if (ct === "hk_list *") {
      const elem = this.cty(this.elemOf(t), "element", e.span);
      const isRead = e.kind === "Ident" || e.kind === "MemberExpr" || e.kind === "IndexExpr";
      const lv = isRead ? this.expr(e) : this.holdTemp(this.expr(e), "list");
      if (elem === "hk_int") return `hk_py_from_list_int(${lv})`;
      if (elem === "hk_float") return `hk_py_from_list_float(${lv})`;
    }
    const lift = pyLifter(ct);
    if (!lift) {
      this.err("E0719", `the py boundary cannot yet pass ${show(p ?? ({ k: "any" } as Ty))}`, e.span,
        "pass a number, string, bool, or a list of numbers");
      return "Py_None";
    }
    return `${lift}(${this.expr(e)})`;
  }

  /** Convert a Halka value to its C representation at a boundary (#35). */
  private toC(e: A.Expr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    // A Halka string is length-prefixed but NUL-terminated, so `.data` is a
    // valid `const char *` with no copy.
    if (p?.k === "prim" && p.name === "string") return `(${this.expr(e)})->data`;
    return this.expr(e);
  }

  private binary(e: A.BinaryExpr): string {
    const lt = this.tyOf(e.lhs);
    const rt = this.tyOf(e.rhs);
    const l = this.expr(e.lhs);
    const r = this.expr(e.rhs);

    const bothBool = isBoolTy(lt) && isBoolTy(rt);
    if (e.op === "and") {
      if (bothBool) return `((${l}) && (${r}))`;
      const t = this.fresh("and");
      this.line(`${this.cty(lt, "operand", e.span)} ${t} = ${l};`);
      return `(${t} ? (${r}) : ${t})`;
    }
    if (e.op === "or") {
      if (bothBool) return `((${l}) || (${r}))`;
      // R11: `a or b` yields `b` when `a` is null or false, so the left
      // operand is evaluated exactly once.
      const o = this.optOf(lt);
      const t = this.fresh("or");
      if (o) {
        this.line(`${o.cty} ${t} = ${l};`);
        return `(${t}.has ? ${t}.v : (${r}))`;
      }
      this.line(`${this.cty(lt, "operand", e.span)} ${t} = ${l};`);
      return `(${t} ? ${t} : (${r}))`;
    }

    // Tuples compare field by field, through a generated comparator.
    const tueq = this.tupOf(lt) ?? this.tupOf(rt);
    if (tueq && (e.op === "==" || e.op === "!=")) {
      const fn = this.tupleEq(tueq, e.span);
      if (!fn) return "false";
      const la = this.fresh("ta");
      const rb = this.fresh("tb");
      this.line(`${tueq.cty} ${la} = ${l};`);
      this.line(`${tueq.cty} ${rb} = ${r};`);
      return `${e.op === "!=" ? "!" : ""}${fn}(&${la}, &${rb})`;
    }

    // Strings
    if (this.isStr(lt) || this.isStr(rt)) {
      switch (e.op) {
        case "+": return `hk_str_join(2, (hk_str *[]){ ${this.asStrOwned(e.lhs)}, ${this.asStrOwned(e.rhs)} })`;
        case "==": return `hk_str_eq(${l}, ${r})`;
        case "!=": return `(!hk_str_eq(${l}, ${r}))`;
        case "<": return `(hk_str_cmp(${l}, ${r}) < 0)`;
        case "<=": return `(hk_str_cmp(${l}, ${r}) <= 0)`;
        case ">": return `(hk_str_cmp(${l}, ${r}) > 0)`;
        case ">=": return `(hk_str_cmp(${l}, ${r}) >= 0)`;
      }
    }

    const isFloat = this.isFloat(lt) || this.isFloat(rt) || this.isFloat(this.tyOf(e));
    // `atom` leaves a bare identifier unwrapped. MSVC treats explicit
    // parentheses as a reassociation barrier even under /fp:fast, so
    // `acc = ((acc) + ...)` told it not to reorder the reduction — which is
    // exactly what vectorising a dot product requires. Writing
    // `acc = acc + (...)` instead is what lets the loop vectorise at all.
    const la = atom(l);
    const ra = atom(r);
    switch (e.op) {
      case "==": return `(${la} == ${ra})`;
      case "!=": return `(${la} != ${ra})`;
      case "<": return `(${la} < ${ra})`;
      case "<=": return `(${la} <= ${ra})`;
      case ">": return `(${la} > ${ra})`;
      case ">=": return `(${la} >= ${ra})`;
      case "/":
        // R21: `/` always yields a float.
        if (isFloat) return `((hk_float)(${l}) / (hk_float)(${r}))`;
        return `hk_fdiv(${l}, ${r}, ${this.loc(e.span)})`;
      case "%":
        if (isFloat) return `fmod((hk_float)(${l}), (hk_float)(${r}))`;
        return `hk_mod(${l}, ${r}, ${this.loc(e.span)})`;
      case "+": case "-": case "*": {
        // No outer parentheses either: `acc = acc + x` vectorises where
        // `acc = (acc + x)` does not, for the same reassociation reason.
        // Nesting stays correct because every operand goes through `atom`,
        // which parenthesises anything that is not a bare identifier.
        if (isFloat) return `${la} ${e.op} ${ra}`;
        if (this.opts.release) return `${la} ${e.op} ${ra}`;
        const f = e.op === "+" ? "hk_add_chk" : e.op === "-" ? "hk_sub_chk" : "hk_mul_chk";
        return `${f}(${l}, ${r}, ${this.loc(e.span)})`;
      }
    }
    this.err("E0710", `the native backend cannot compile \`${e.op}\` on these types yet`, e.span);
    return "0";
  }

  private call(e: A.CallExpr): string {
    if (e.callee.kind === "Ident") {
      const n = e.callee.name;
      // `from py "math" import sqrt` then `sqrt(2.0)` (#37).
      const pyBound = this.pyNames.get(n);
      if (pyBound) {
        const pargs = e.args.filter((a) => a.value.kind !== "EllipsisExpr").map((a) => this.toPy(a.value));
        const argv = pargs.length ? `(PyObject *[]){ ${pargs.join(", ")} }` : "NULL";
        return `hk_py_call(${pyBound.slot}, ${argv}, ${pargs.length}, ${cString(n)}, ${this.loc(e.span)})`;
      }
      const csig = this.tyOf(e.callee);
      const args = e.args.map((a) => this.expr(a.value));

      // Prelude functions with a direct C equivalent.
      switch (n) {
        case "len": {
          const t = this.tyOf(e.args[0]!.value);
          if (this.isList(t)) return `(${args[0]})->len`;
          if (this.isStr(t)) return `hk_str_len_chars(${args[0]})`;
          if (this.isMap(t)) return `hk_map_len(${args[0]})`;
          if (this.isJsonDoc(t)) return `hk_json_count(${args[0]})`;
          {
            const tu = this.tupOf(t);
            // A tuple's length is its shape, so it is known while compiling.
            if (tu) return `INT64_C(${tu.elems.length})`;
          }
          break;
        }
        case "div": return `hk_div(${args[0]}, ${args[1]}, ${this.loc(e.span)})`;
        case "mod": return `hk_mod(${args[0]}, ${args[1]}, ${this.loc(e.span)})`;
        case "abs": {
          const t = this.tyOf(e.args[0]!.value);
          return this.isFloat(t) ? `fabs(${args[0]})` : `((${args[0]}) < 0 ? -(${args[0]}) : (${args[0]}))`;
        }
        case "sqrt": return `sqrt((hk_float)(${args[0]}))`;
        case "pow": {
          // An integer power stays integral rather than round-tripping a double.
          if (!this.isFloat(this.tyOf(e))) return `hk_ipow(${args[0]}, ${args[1]}, ${this.loc(e.span)})`;
          return `pow((hk_float)(${args[0]}), (hk_float)(${args[1]}))`;
        }
        case "min": case "max": {
          if (args.length < 2) return args[0] ?? "0";
          const cmp = n === "min" ? "<" : ">";
          const ct = this.cty(this.tyOf(e), "comparison", e.span);
          return args.slice(1).reduce((acc, cur, i) => {
            const a = this.fresh("m");
            const b = this.fresh("m");
            this.line(`const ${ct} ${a} = ${acc};`);
            this.line(`const ${ct} ${b} = ${cur};`);
            void i;
            return `(${a} ${cmp} ${b} ? ${a} : ${b})`;
          }, args[0]!);
        }
        case "floor": return `((hk_int)floor((hk_float)(${args[0]})))`;
        case "ceil": return `((hk_int)ceil((hk_float)(${args[0]})))`;
        case "round": {
          const t = this.fresh("rnd");
          this.line(`const hk_float ${t} = (hk_float)(${args[0]});`);
          return `((hk_int)(${t} < 0 ? ceil(${t} - 0.5) : floor(${t} + 0.5)))`;
        }
        case "round_to": {
          const t = this.fresh("rt");
          this.line(`const hk_float ${t} = pow(10.0, (hk_float)(${args[1]}));`);
          return `(floor((hk_float)(${args[0]}) * ${t} + 0.5) / ${t})`;
        }
        case "int": return `((hk_int)(${args[0]}))`;
        case "float": return `((hk_float)(${args[0]}))`;
        case "string": return this.asStr(e.args[0]!.value);
        case "print": return `(hk_say(${args.length ? this.asStr(e.args[0]!.value) : "hk_str_lit(\"\")"}), 0)`;
        case "panic": return `(hk_panic(${this.asStr(e.args[0]!.value)}->data, ${this.loc(e.span)}), 0)`;
        case "assert":
          return `((${args[0]}) ? 0 : (hk_panic(${args[1] ? `${this.asStr(e.args[1]!.value)}->data` : `"assertion failed"`}, ${this.loc(e.span)}), 0))`;
        case "now_ms": return "hk_now_ms()";
        case "cpu_count": return "hk_cpu_count()";
        default: break;
      }

      if (this.structs.has(n)) {
        const def = this.structs.get(n)!;
        return `((${mangleType(n)}){ ${def.fields.map((f, i) => `.${mangle(f.name)} = ${args[i] ?? zeroOf(this.cty(f.ty, f.name))}`).join(", ")} })`;
      }

      if (this.variantOwner.has(n)) {
        // Which instantiation this is comes from the call's own type, since
        // `Ok(x)` alone does not say what `Result<T>` it belongs to.
        const inst = this.enumOf(this.tyOf(e), e.span);
        if (!inst) {
          this.err("E0701", `the native backend cannot tell which \`${this.variantOwner.get(n)}\` \`${n}\` builds here`, e.span,
            "annotate the value or the function's return type");
          return "0";
        }
        const v = inst.variants.find((x) => x.name === n)!;
        const payload = v.fields
          .map((f, i) => ({ f, a: args[i] }))
          .filter(({ f }) => this.cty(f.ty, f.name) !== "void")
          .map(({ f, a }) => `.as.${mangle(n)}.${mangle(f.name)} = ${a ?? zeroOf(this.cty(f.ty, f.name))}`);
        return `((${mangleType(inst.key)}){ .tag = ${variantTag(inst.key, n)}${payload.length ? ", " + payload.join(", ") : ""} })`;
      }
      this.holdArgs(e, args, this.opts.owningParams?.get(n));
      // Lifting into `T?` happens after holding, not before: it is the inner
      // value that was freshly built and needs freeing, and the wrapper is
      // a plain struct that owns nothing itself.
      e.args.forEach((a, i) => {
        args[i] = this.liftTo(args[i]!, a.value, csig ? paramOf(csig, i) : undefined, false);
      });
      return `${mangle(n)}(${args.join(", ")})`;
    }

    // Method calls on built-in containers.
    if (e.callee.kind === "MemberExpr") {
      const obj = e.callee.obj;
      const ot = this.tyOf(obj);
      const m = e.callee.name;
      const args = e.args.map((a) => this.expr(a.value));

      // `math.hypot(3.0, 4.0)`, `files.read(path)` — a call into a prelude
      // module. The signature table says which C function implements it.
      const op = ot ? prune(ot) : undefined;
      if (op?.k === "module") {
        const member = preludeMember(op.name, m);
        if (!member) {
          this.err("E0707", `\`${op.name}\` has no member \`${m}\``, e.span);
          return "0";
        }
        this.usePrelude(op.name);
        // A prelude function copies what it is given and retains anything
        // it keeps, so every argument is borrowed.
        this.holdArgs(e, args);
        // Emitted here rather than called in the runtime: both need types
        // the emitter knows and a runtime function would have to be told.
        if (op.name === "maps" && m === "from_entries") return this.mapFromEntries(e, args[0]!);
        if (op.name === "json" && m === "parse") return `hk_json_parse(${args[0]}, ${this.loc(e.span)})`;
        if (op.name === "json" && m === "stringify") return this.jsonStringify(e, args[0]!);
        if (!member.c) {
          this.err("E0707", `the native backend does not implement \`${op.name}.${m}\` yet`, e.span,
            "run it with `halka run` while the backend catches up");
          return "0";
        }
        // File operations are gated on a capability at run time (#45), and
        // a compiled program has to refuse on the same terms or the gate
        // would mean nothing once built.
        if (op.name === "files") {
          const perm = FILE_WRITERS.has(m) ? "FileAccess.write" : "FileAccess.read";
          this.line(`HK_CAP("${perm}", "files.${m}");`);
        }
        if (member.okFrom) return `${this.resultWrapper(member, m, e)}(${args.join(", ")})`;
        return `${member.c}(${args.join(", ")})`;
      }
      if (this.isMap(ot)) return this.mapMethod(obj, m, e);
      if (this.isList(ot)) {
        const et = this.cty(this.elemOf(ot), "element", e.span);
        switch (m) {
          case "push": {
            // `push` is an expression here, so it cannot expand to a
            // do/while. Bind the receiver first, then use the comma form.
            const lv = this.fresh("lst");
            this.line(`hk_list *${lv} = ${this.expr(obj)};`);
            return `HK_PUSH_E(${lv}, ${et}, ${args[0]})`;
          }
          case "is_empty": return `((${this.expr(obj)})->len == 0)`;
          default: break;
        }
      }
      this.err("E0711", `the native backend does not implement \`.${m}\` yet`, e.span);
      return "0";
    }

    this.err("E0712", "the native backend can only call named functions so far", e.span);
    return "0";
  }

  /** `["a": 1, "b": 2]` — built in order, because the map keeps that order. */
  private mapLit(e: A.MapExpr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    const kt = p && p.k === "map" ? p.key : undefined;
    const vt = p && p.k === "map" ? p.val : undefined;
    const kc = this.cty(kt, "map key", e.span);
    const vc = this.cty(vt, "map value", e.span);
    const v = this.fresh("map");
    this.line(`hk_map *${v} = hk_map_new(sizeof(${kc}), sizeof(${vc}), ${ekindOf(kc)}, ${ekindOf(vc)}, ${e.entries.length});`);
    for (const en of e.entries) {
      // The runtime takes the address of each, so both need a name.
      const k = this.fresh("mk");
      const val = this.fresh("mv");
      this.line(`${kc} ${k} = ${this.coerce(en.key, kt)};`);
      this.line(`${vc} ${val} = ${this.coerce(en.value, vt)};`);
      this.line(`hk_map_set(${v}, &${k}, &${val});`);
      // The map retained what it kept, so a freshly built key or value is
      // still this statement's to free.
      if (kc === "hk_str *" && !isRead(en.key)) this.line(`hk_str_release(${k});`);
      if (vc === "hk_str *" && !isRead(en.value)) this.line(`hk_str_release(${val});`);
      if (vc === "hk_list *" && !isRead(en.value)) this.line(`hk_list_release(${val});`);
    }
    return v;
  }

  private listLit(e: A.ListExpr): string {
    const t = this.tyOf(e);
    const et = this.cty(this.elemOf(t), "element", e.span);

    // M4 — a list that neither escapes nor grows can live on the stack, so
    // it costs no malloc and no free. Only for scalar elements: the header
    // is marked never-free (`rc = -1`, the same convention interned string
    // literals use), and a list that is never released would never release
    // owning elements either.
    if (this.opts.escapes?.stackable.has(e) && STACK_ELEM_CTYS.has(et)) {
      const data = this.fresh("sd");
      const hdr = this.fresh("sl");
      this.line(`${et} ${data}[${Math.max(e.elements.length, 1)}];`);
      e.elements.forEach((x, i) => this.line(`${data}[${i}] = ${this.expr(x)};`));
      this.line(`hk_list ${hdr} = { .rc = -1, .len = ${e.elements.length}, .cap = ${e.elements.length},` +
        ` .esz = sizeof(${et}), .ekind = ${ekindOf(et)}, .edesc = NULL, .data = ${data} };`);
      return `(&${hdr})`;
    }

    const v = this.fresh("lit");
    const elemTy = this.elemOf(t);
    this.line(`hk_list *${v} = hk_list_new(sizeof(${et}), ${e.elements.length}, ${this.elemKind(elemTy, et)});`);
    // A list of tuples has to carry the layout, or releasing it would leak
    // every owning field and printing it would render a pointer as an int.
    this.attachDesc(v, elemTy);
    for (const x of e.elements) this.line(`HK_PUSH(${v}, ${et}, ${this.coerce(x, elemTy)});`);
    return v;
  }

  private cast(e: A.CastExpr): string {
    if (e.fallible) {
      this.err("E0713", "the native backend does not support `to` (fallible conversion) yet", e.span,
        "use `as` when the conversion cannot fail");
      return "0";
    }
    const target = this.cty(this.tyOf(e), "conversion target", e.span);
    const src = this.tyOf(e.expr);
    const sp = src ? prune(src) : undefined;

    // A Python value crossing back into Halka is an explicit conversion (#15, #37).
    if (sp?.k === "cty" && sp.lang === "py") {
      if (target === "hk_list *") {
        const elem = this.cty(this.elemOf(this.tyOf(e)), "element", e.span);
        if (elem === "hk_int") return `hk_py_to_list_int(${this.expr(e.expr)}, ${this.loc(e.span)})`;
        if (elem === "hk_float") return `hk_py_to_list_float(${this.expr(e.expr)}, ${this.loc(e.span)})`;
      }
      const conv = pyConverter(target);
      if (!conv) {
        this.err("E0720", `a python value cannot be converted to ${show(prune(this.tyOf(e) ?? ({ k: "any" } as Ty)))} yet`, e.span,
          "convert to int, float, bool, string, list(int) or list(float)");
        return "0";
      }
      return target === "hk_bool"
        ? `${conv}(${this.expr(e.expr)})`
        : `${conv}(${this.expr(e.expr)}, ${this.loc(e.span)})`;
    }

    if (target === "hk_str *") return this.asStr(e.expr);
    if (this.isStr(src)) {
      this.err("E0713", "converting a string with `as` is not supported by the native backend yet", e.span,
        "use `to int` / `to float`, which yields a Result");
      return "0";
    }
    return `((${target})(${this.expr(e.expr)}))`;
  }

  /**
   * A string the caller owns, for handing to a consuming join. A value that is
   * merely *read* (a variable, a field, an element) is retained first, so the
   * join's release leaves it exactly as it found it.
   */
  private asStrOwned(e: A.Expr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    const isRead = e.kind === "Ident" || e.kind === "MemberExpr" || e.kind === "IndexExpr";
    if (isRead && p?.k === "prim" && p.name === "string") return `hk_str_retain(${this.expr(e)})`;
    return this.asStr(e);
  }

  /**
   * Produce an `hk_str *` for an already-emitted C expression of known type.
   * `asStr` works from the AST; an optional's inner value has no AST node of
   * its own, so this takes the C text instead.
   */
  private cStrOf(cExpr: string, t: Ty, span: Span): string {
    const p = prune(t);
    if (p.k === "prim") {
      switch (p.name) {
        case "string": return cExpr;
        case "int": case "byte": return `hk_str_from_int(${cExpr})`;
        case "float": return `hk_str_from_float(${cExpr})`;
        case "bool": return `hk_str_from_bool(${cExpr})`;
        case "char": return `hk_str_from_char(${cExpr})`;
        default: break;
      }
    }
    if (p.k === "list" || p.k === "array") return `hk_str_from_list(${cExpr})`;
    this.err("E0714", `the native backend cannot print ${show(p)} yet`, span);
    return `hk_str_lit("")`;
  }

  /** Produce an `hk_str *` for any expression (used by `say` and `+`). */
  private asStr(e: A.Expr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    if (e.kind === "StrLit") return this.strLit(e);
    if (e.kind === "NullLit") return `hk_str_lit("null")`;

    // An optional prints its value, or `null` when it has none (#7).
    const o = this.optOf(t);
    if (o) {
      const v = this.fresh("osv");
      this.line(`${o.cty} ${v} = ${this.expr(e)};`);
      return `(${v}.has ? ${this.cStrOf(`${v}.v`, o.inner, e.span)} : hk_str_lit("null"))`;
    }

    // A parsed document prints as the Halka value the interpreter would
    // have built: a string bare, everything else as `inspect` renders it.
    if (this.isJsonDoc(t)) {
      // Indexing borrows from the parent document, but a freshly parsed one
      // printed straight away belongs to this statement.
      const d = isRead(e) ? this.expr(e) : this.holdTemp(this.expr(e), "json");
      return `hk_json_display(${d})`;
    }

    // A tuple prints as `(a, b)` (#53), walked through its descriptor.
    const tu = this.tupOf(t);
    if (tu) {
      if (isRead(e)) return `hk_str_from_tuple(&${atom(this.expr(e))}, &${this.tupDescOf(tu.key)})`;
      const tv = this.fresh("ptup");
      const sv = this.fresh("ptstr");
      this.line(`${tu.cty} ${tv} = ${this.expr(e)};`);
      this.line(`hk_str *${sv} = hk_str_from_tuple(&${tv}, &${this.tupDescOf(tu.key)});`);
      this.line(`hk_tuple_drop(&${tv}, &${this.tupDescOf(tu.key)});`);
      return sv;
    }

    // A map prints as `[k: v, ...]` in insertion order (#53).
    if (p?.k === "map") {
      if (isRead(e)) return `hk_str_from_map(${this.expr(e)})`;
      const mv = this.fresh("pmap");
      const sv = this.fresh("pmstr");
      this.line(`hk_map *${mv} = ${this.expr(e)};`);
      this.line(`hk_str *${sv} = hk_str_from_map(${mv});`);
      this.line(`hk_map_release(${mv});`);
      return sv;
    }

    // A list prints as `[a, b, c]`, matching `inspect` (#53).
    if (p?.k === "list" || p?.k === "array") {
      const elem = this.cty(this.elemOf(t), "element", e.span);
      void elem;
      const isRead = e.kind === "Ident" || e.kind === "MemberExpr" || e.kind === "IndexExpr";
      // The list carries its own element kind now, so the printer does not
      // have to be told and a nested list can recurse into its child's.
      if (isRead) return `hk_str_from_list(${this.expr(e)})`;
      // A list built just to be printed is freed again straight away.
      const lv = this.fresh("plst");
      const sv = this.fresh("pstr");
      this.line(`hk_list *${lv} = ${this.expr(e)};`);
      this.line(`hk_str *${sv} = hk_str_from_list(${lv});`);
      this.line(`hk_list_release(${lv});`);
      return sv;
    }

    // A C scalar prints as its Halka counterpart (#35).
    if (p?.k === "cty" && p.lang !== "py") {
      const mapped = C_SCALARS[p.name];
      if (mapped === "int") return `hk_str_from_int((hk_int)(${this.expr(e)}))`;
      if (mapped === "float") return `hk_str_from_float((hk_float)(${this.expr(e)}))`;
      if (mapped === "bool") return `hk_str_from_bool((hk_bool)(${this.expr(e)}))`;
    }
    if (p?.k === "prim") {
      switch (p.name) {
        case "string": return this.expr(e);
        case "int": case "byte": return `hk_str_from_int(${this.expr(e)})`;
        case "float": return `hk_str_from_float(${this.expr(e)})`;
        case "bool": return `hk_str_from_bool(${this.expr(e)})`;
        case "char": return `hk_str_from_char(${this.expr(e)})`;
        default: break;
      }
    }
    if (e.kind === "ForeignExpr" || (p?.k === "any" && /\b(c|cpp|py)\b/.test(p.why ?? ""))) {
      this.err("E0714", "this foreign value has no declared type, so it cannot be printed", e.span,
        "declare it (`c cos(x: c double): c double`) or convert it (`... as float`)");
      return `hk_str_lit("")`;
    }
    this.err("E0714", `the native backend cannot print ${show(p ?? ({ k: "any" } as Ty))} yet`, e.span);
    return `hk_str_lit("")`;
  }

  private strLit(e: A.StrLit): string {
    // A literal with no interpolation is a static string built once.
    if (e.parts.every((p) => p.kind === "text")) {
      const text = e.parts.map((p) => p.text ?? "").join("");
      let name = this.strLits.get(text);
      if (!name) { name = `hk_s${this.strLits.size}`; this.strLits.set(text, name); }
      return name;
    }
    // Interpolation (#2) — one join, which consumes every piece, so no
    // intermediate concatenation is left behind.
    const pieces: string[] = [];
    for (const p of e.parts) {
      if (p.kind === "text") { if (p.text) pieces.push(this.strLitConst(p.text)); }
      else pieces.push(this.asStrOwned(p.expr!));
    }
    if (!pieces.length) return `hk_str_lit("")`;
    if (pieces.length === 1) return pieces[0]!;
    return `hk_str_join(${pieces.length}, (hk_str *[]){ ${pieces.join(", ")} })`;
  }

  private strLitConst(text: string): string {
    let name = this.strLits.get(text);
    if (!name) { name = `hk_s${this.strLits.size}`; this.strLits.set(text, name); }
    return name;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Headers the generated preamble already includes. */
const BUILTIN_INCLUDES = new Set(["string.h", "math.h"]);

const DECL_KINDS = new Set([
  "FnDecl", "StructDecl", "EnumDecl", "TraitDecl", "ImplDecl", "TypeAliasDecl",
  "CapabilityDecl", "ImportDecl", "ExportDecl", "ExternDecl", "SpecializeDecl",
]);

function mangle(name: string): string {
  if (C_RESERVED.has(name)) return `hk_u_${name}`;
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Parenthesise an emitted operand only when the grouping carries meaning.
 * A single identifier never needs it, and leaving it off matters: an
 * explicit parenthesis is a reassociation barrier to the C compiler, so
 * wrapping a reduction's accumulator silently costs auto-vectorisation.
 */
/**
 * What a list's elements own, so `hk_list_release` can release them. A list
 * of strings that reported HK_E_SCALAR freed its backing array and leaked
 * every string in it.
 */
/**
 * Element shapes a stack-promoted list may hold. Scalars only: the header is
 * never released, so anything owning would never be released either.
 */
const STACK_ELEM_CTYS = new Set(["hk_int", "hk_float", "hk_bool", "hk_char", "hk_byte"]);

/** Field shapes a tuple may hold; a nested tuple is allowed separately. */
const TUPLE_FIELD_CTYS = new Set(["hk_int", "hk_float", "hk_bool", "hk_char", "hk_byte", "hk_str *", "hk_list *"]);

/** How deeply tuples nest, so the shallowest can be declared first. */
function tupleDepth(elems: Ty[]): number {
  let d = 0;
  for (const el of elems) {
    const p = prune(el);
    if (p.k === "tuple") d = Math.max(d, 1 + tupleDepth(p.elems));
  }
  return d;
}

/** Key shapes the map runtime can hash and compare exactly. */
const MAP_KEY_CTYS = new Set(["hk_int", "hk_float", "hk_bool", "hk_char", "hk_byte", "hk_str *"]);
/** Value shapes it can copy, release and print. */
const MAP_VALUE_CTYS = new Set([...MAP_KEY_CTYS, "hk_list *"]);

/** The variable at the root of `a.b.c` or `a[i]`, if there is one. */
function rootName(e: A.Expr): string | null {
  let cur: A.Expr = e;
  for (;;) {
    if (cur.kind === "Ident") return cur.name;
    if (cur.kind === "MemberExpr" || cur.kind === "IndexExpr") { cur = cur.obj; continue; }
    return null;
  }
}

/** Child expressions of an expression, without naming every shape. */
function exprKids(e: A.Expr): A.Expr[] {
  const out: A.Expr[] = [];
  for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "typeArgs") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (!x || typeof x !== "object" || !("kind" in (x as object))) continue;
      const kind = (x as { kind: string }).kind;
      if (kind.endsWith("Pat") || kind.endsWith("Type") || kind === "Block") continue;
      out.push(x as A.Expr);
      const inner = (x as { value?: unknown }).value;
      if (inner && typeof inner === "object" && "kind" in (inner as object)) out.push(inner as A.Expr);
    }
  }
  return out;
}

/** Child expressions and blocks of a statement. */
function stmtKids(st: A.Stmt): unknown[] {
  const out: unknown[] = [];
  for (const [k, v] of Object.entries(st as unknown as Record<string, unknown>)) {
    if (k === "span" || k === "kind" || k === "type" || k === "pattern") continue;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (!x || typeof x !== "object" || !("kind" in (x as object))) continue;
      const kind = (x as { kind: string }).kind;
      if (kind.endsWith("Pat") || kind.endsWith("Type")) continue;
      out.push(x);
      for (const f of ["value", "body", "block"]) {
        const inner = (x as Record<string, unknown>)[f];
        if (inner && typeof inner === "object" && "kind" in (inner as object)) out.push(inner);
      }
    }
  }
  return out;
}

/** A value read from somewhere else, so the reader does not own it. */
function isRead(e: A.Expr): boolean {
  return e.kind === "Ident" || e.kind === "MemberExpr" || e.kind === "IndexExpr";
}

function ekindOf(elemCty: string): string {
  switch (elemCty) {
    case "hk_float": return "HK_E_FLOAT";
    case "hk_bool": return "HK_E_BOOL";
    case "hk_char": return "HK_E_CHAR";
    case "hk_str *": return "HK_E_STR";
    case "hk_list *": return "HK_E_LIST";
    default: return "HK_E_INT";
  }
}

function atom(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `(${s})`;
}

function mangleType(name: string): string { return `hk_T_${name}`; }
function variantTag(instanceKey: string, variant: string): string { return `hk_V_${instanceKey}_${variant}`; }

/** The permissions that count as writing, for the capability gate (F1). */
const FILE_WRITERS = new Set(["write", "append", "remove", "make_dir"]);

function paramTypesOf(t: Ty | undefined): Ty[] | null {
  const p = t ? prune(t) : undefined;
  return p && p.k === "fn" ? p.params.map((x) => x.ty) : null;
}

/** A short, C-safe name for a type argument, used in a monomorphised name. */
function tyKey(t: Ty): string {
  const p = prune(t);
  switch (p.k) {
    case "prim": return p.name === "string" ? "str" : p.name;
    case "list": case "array": return `list${tyKey(p.elem)}`;
    case "set": return `set${tyKey(p.elem)}`;
    case "map": return `map${tyKey(p.key)}${tyKey(p.val)}`;
    case "tuple": return `tup${p.elems.map(tyKey).join("")}`;
    case "opt": return `opt${tyKey(p.inner)}`;
    case "named": return p.args && p.args.length ? `${p.name}${p.args.map(tyKey).join("")}` : p.name;
    case "cty": return `c${p.name.replace(/[^A-Za-z0-9]/g, "")}`;
    default: return p.k;
  }
}

/** Replace a generic enum's type parameters with its type arguments. */
function substTy(t: Ty, subst: Map<string, Ty>): Ty {
  if (subst.size === 0) return t;
  const p = prune(t);
  switch (p.k) {
    case "named": {
      const hit = p.args && p.args.length ? undefined : subst.get(p.name);
      if (hit) return hit;
      return p.args && p.args.length ? { ...p, args: p.args.map((a) => substTy(a, subst)) } : p;
    }
    case "list": case "array": return { ...p, elem: substTy(p.elem, subst) };
    case "set": return { ...p, elem: substTy(p.elem, subst) };
    case "map": return { ...p, key: substTy(p.key, subst), val: substTy(p.val, subst) };
    case "tuple": return { ...p, elems: p.elems.map((e) => substTy(e, subst)) };
    case "opt": return { ...p, inner: substTy(p.inner, subst) };
    default: return p;
  }
}

function zeroOf(cty: string): string {
  switch (cty) {
    case "hk_int": case "hk_char": case "hk_byte": return "0";
    case "hk_float": return "0.0";
    case "hk_bool": return "false";
    case "hk_str *": case "hk_list *": case "void *": case "hk_mutex *": return "NULL";
    case "void": return "";
    default: return cty.endsWith("*") ? "NULL" : `(${cty}){0}`;
  }
}

function cString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\" + c.toString(8).padStart(3, "0");
    else if (c < 0x80) out += ch;
    else {
      // Emit UTF-8 bytes explicitly so the source encoding never matters.
      for (const b of new TextEncoder().encode(ch)) out += "\\" + b.toString(8).padStart(3, "0");
    }
  }
  return out + '"';
}

function formatDouble(v: number): string {
  if (Number.isNaN(v)) return "(0.0/0.0)";
  if (v === Infinity) return "(1.0/0.0)";
  if (v === -Infinity) return "(-1.0/0.0)";
  const s = Number.isInteger(v) && Math.abs(v) < 1e15 ? `${v}.0` : String(v);
  return s.includes("e") || s.includes(".") ? s : `${s}.0`;
}

function isBoolTy(t: Ty | undefined): boolean {
  const p = t ? prune(t) : undefined;
  return !!p && p.k === "prim" && p.name === "bool";
}

function retOf(t: Ty): Ty | undefined {
  const p = prune(t);
  return p.k === "fn" ? p.ret : undefined;
}

function paramOf(t: Ty, i: number): Ty | undefined {
  const p = prune(t);
  return p.k === "fn" ? p.params[i]?.ty : undefined;
}

function collectDefers(b: A.Block): A.DeferStmt[] {
  return b.stmts.filter((s): s is A.DeferStmt => s.kind === "DeferStmt");
}

function describeStmt(s: A.Stmt): string {
  switch (s.kind) {
    case "MatchStmt": return "match";
    case "WithStmt": return "with";
    case "IntrinsicStmt": return s.op;
    default: return s.kind.replace(/Stmt$/, "").toLowerCase();
  }
}

/** Does this initializer allocate a heap value the local then owns? */
function allocates(e: A.Expr): boolean {
  // A tuple is a plain struct, but the fields it is built from may be
  // freshly allocated, and releasing the tuple is what releases them.
  return e.kind === "ListExpr" || e.kind === "MapExpr" || e.kind === "SetExpr" || e.kind === "TupleExpr";
}

/**
 * Conservative escape test. The v1 backend only auto-releases a local it can
 * prove stays local; everything else is left to the ownership pass in v0.2.
 */
function escapes(_name: string): boolean {
  return true;
}

/**
 * Assemble the emitter's options from what inference produced.
 *
 * This exists because the field list drifted twice: the test suites once
 * omitted `structFields` (so a struct with a string field emitted a pointer
 * into an integer, with every test green) and later `enumGenerics` (so
 * `Result<T>` stayed generic). Callers now pass what they have and get the
 * whole set, rather than each remembering to list it.
 */
export function emitOptionsFrom(
  inferred: {
    foreignImports: ForeignImport[];
    structFields: Map<string, Ty[]>;
    enumVariants: Map<string, Map<string, { fields: Ty[]; names: string[] }>>;
    enumGenerics: Map<string, string[]>;
  },
  o: { file: string; release: boolean; uncheckedIndex?: boolean; escapes?: EscapeInfo; owningParams?: Map<string, boolean[]> },
): EmitOptions {
  return {
    release: o.release,
    uncheckedIndex: o.uncheckedIndex,
    file: o.file,
    escapes: o.escapes,
    foreignImports: inferred.foreignImports,
    structFields: inferred.structFields,
    enumVariants: inferred.enumVariants,
    enumGenerics: inferred.enumGenerics,
    owningParams: o.owningParams,
  };
}

export function emitC(mod: A.Module, types: TypeMap, opts: EmitOptions): EmitResult {
  return new CEmitter(types, opts).emit(mod);
}
