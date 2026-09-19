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
import { preludeMember } from "../../sema/prelude-types.ts";

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
  /** Enum name -> type parameters. A generic enum gets a C type per use. */
  enumGenerics?: Map<string, string[]>;
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
  private blockStack: { owned: Set<string>; kinds: Map<string, "str" | "list" | "enum">; types: Map<string, Ty | undefined>; live: Owned[]; isLoopBody: boolean }[] = [];
  /** Owning parameters of the current function, freed when it returns. */
  private frameParams: Owned[] = [];
  /** Values built inside the current statement, freed once it completes. */
  private stmtTemps: Owned[] = [];
  private inMain = false;
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

    for (const s of structs) this.declareStruct(s);
    this.registerEnums();
    this.collectForeign(mod);
    for (const f of fns) {
      const sig = this.tyOf(f);
      // An unmapped declaration, or one whose type is not a function, has no
      // return type to record — fall back to `any` rather than dropping it.
      this.fnRet.set(f.name, (sig && retOf(sig)) ?? { k: "any" });
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
    return [...head, ...this.structDecls(), ...this.enumDecls(), ...lits, "", ...this.decls, "", ...pyrt, ...this.aux, ...init, body, ""].join("\n");
  }

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
      default: break;
    }
    if (span) {
      this.err("E0701", `the native backend cannot represent ${show(p)} yet (${what})`, span,
        "run it with `halka run`, or annotate this with a concrete type");
    }
    return "hk_int";
  }

  private isStr(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "prim" && p.name === "string";
  }
  private isFloat(t: Ty | undefined): boolean {
    const p = t ? prune(t) : undefined;
    return !!p && p.k === "prim" && p.name === "float";
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

    const sig = this.tyOf(f);
    const ret = sig ? retOf(sig) : undefined;
    const isVoid = this.cty(ret, "return", f.span) === "void";

    // `defer` (#24) needs one exit path, so functions with defers use a result
    // variable and a cleanup label.
    const defers = collectDefers(f.body!);
    const needsCleanup = defers.length > 0;
    if (needsCleanup && !isVoid) this.line(`${this.cty(ret, "return", f.span)} hk_result = 0;`);

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

  private releaseLocal(o: Owned): void {
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

  /** Emit a block's statements, freeing what it owns on the way out (M4). */
  private suite(b: A.Block, isLoopBody = false, override?: Owned[]): void {
    const owned = override ?? this.opts.escapes?.blocks.get(b) ?? [];
    const frame = {
      owned: new Set(owned.map((o) => o.name)),
      kinds: new Map(owned.map((o) => [o.name, o.kind] as const)),
      types: new Map(owned.map((o) => [o.name, o.ty] as const)),
      live: [] as Owned[],
      isLoopBody,
    };
    this.blockStack.push(frame);
    for (const st of b.stmts) this.stmt(st);
    for (const o of frame.live.slice().reverse()) this.releaseLocal(o);
    this.blockStack.pop();
  }

  /** Free everything in scope before returning; the returned value is kept. */
  private releaseForReturn(keep?: string): void {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      for (const o of this.blockStack[i]!.live.slice().reverse()) {
        if (o.name !== keep) this.releaseLocal(o);
      }
    }
    for (const o of this.frameParams.slice().reverse()) if (o.name !== keep) this.releaseLocal(o);
  }

  /** Free everything down to and including the nearest loop body. */
  private releaseForLoopExit(): void {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      for (const o of this.blockStack[i]!.live.slice().reverse()) this.releaseLocal(o);
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

  /** Bind a freshly built value so the statement can free it again. */
  private holdTemp(cExpr: string, kind: "str" | "list"): string {
    const v = this.fresh(kind === "str" ? "tstr" : "tlst");
    this.line(`${kind === "str" ? "hk_str *" : "hk_list *"}${v} = ${cExpr};`);
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
        if (s.pattern.kind !== "BindPat") {
          this.err("E0702", "the native backend does not support destructuring yet", s.span,
            "bind the value to one name, then index it");
          return;
        }
        const t = this.tyOf(s.pattern as unknown as A.Node) ?? (s.value ? this.tyOf(s.value) : undefined);
        const ct = this.cty(t, `\`${s.pattern.name}\``, s.span);
        const init = s.value ? this.expr(s.value) : zeroOf(ct);
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
        if (t.kind === "Ident") { this.line(`${mangle(t.name)} = ${this.expr(s.value)};`); return; }
        if (t.kind === "MemberExpr") { this.line(`${this.expr(t)} = ${this.expr(s.value)};`); return; }
        if (t.kind === "IndexExpr") {
          const ot = this.tyOf(t.obj);
          if (this.isList(ot)) {
            const et = this.cty(this.elemOf(ot), "element", t.span);
            this.line(`HK_IDX(${this.expr(t.obj)}, ${et}, ${this.expr(t.index)}) = ${this.expr(s.value)};`);
            return;
          }
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
          if (s.value && !this.fnCtx.isVoid) this.line(`hk_result = ${this.expr(s.value)};`);
          // Block-scoped values must go before the jump; C scopes end here.
          this.releaseForReturn(keep);
          this.line("goto hk_cleanup;");
          return;
        }
        const value = s.value && !this.fnCtx.isVoid ? this.expr(s.value) : null;
        this.releaseForReturn(keep);
        this.line(value !== null ? `return ${value};` : "return;");
        return;
      }

      // Both leave the loop body, so its values are freed first.
      case "BreakStmt": this.releaseForLoopExit(); this.line("break;"); return;
      case "ContinueStmt": this.releaseForLoopExit(); this.line("continue;"); return;

      case "IfStmt": {
        this.open(`if (${this.expr(s.cond)}) {`);
        this.suite(s.then);
        for (const e of s.elifs) {
          this.close(`} else if (${this.expr(e.cond)}) {`);
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
        this.open(`while (${this.expr(s.cond)}) {`);
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

  private forStmt(s: A.ForStmt): void {
    if (s.pattern.kind !== "BindPat") {
      this.err("E0702", "the native backend does not support destructuring in a for loop yet", s.span);
      return;
    }
    const v = mangle(s.pattern.name);
    const it = s.iter;

    // `for i in a..b` lowers to a plain C for loop — no iterator, no allocation.
    if (it.kind === "RangeExpr" && it.lo && it.hi) {
      const lo = this.expr(it.lo);
      const hi = this.fresh("hi");
      const cmp = it.inclusive ? "<=" : "<";
      this.line(`const hk_int ${hi} = ${this.expr(it.hi)};`);
      const step = it.step ? this.expr(it.step) : "1";
      this.open(`for (hk_int ${v} = ${lo}; ${v} ${cmp} ${hi}; ${v} += ${step}) {`);
      this.suite(s.body, true);
      this.close();
      return;
    }

    const t = this.tyOf(it);
    if (this.isList(t)) {
      const lst = this.fresh("lst");
      const i = this.fresh("i");
      const et = this.cty(this.elemOf(t), "element", s.span);
      this.line(`hk_list *${lst} = ${this.expr(it)};`);
      this.open(`for (hk_int ${i} = 0; ${i} < ${lst}->len; ${i}++) {`);
      this.line(`${et} ${v} = HK_AT(${lst}, ${et}, ${i});`);
      this.suite(s.body, true);
      this.close();
      return;
    }

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
          const acc = this.opts.release ? "HK_AT" : "HK_IDX";
          return `${acc}(${this.expr(e.obj)}, ${et}, ${this.expr(e.index)})`;
        }
        this.err("E0707", "the native backend can only index a list so far", e.span);
        return "0";
      }

      case "ListExpr": return this.listLit(e);

      case "CastExpr": return this.cast(e);

      case "MoveExpr": return this.expr(e.expr);
      case "CompileExpr": return this.expr(e.expr);
      case "DeviceExpr": return this.expr(e.expr);

      case "ForeignExpr": return this.foreignExpr(e);

      case "IsExpr": {
        if (e.test === "null") return `((${this.expr(e.expr)}) == NULL)`;
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
      const t = this.fresh("or");
      this.line(`${this.cty(lt, "operand", e.span)} ${t} = ${l};`);
      return `(${t} ? ${t} : (${r}))`;
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
    switch (e.op) {
      case "==": return `((${l}) == (${r}))`;
      case "!=": return `((${l}) != (${r}))`;
      case "<": return `((${l}) < (${r}))`;
      case "<=": return `((${l}) <= (${r}))`;
      case ">": return `((${l}) > (${r}))`;
      case ">=": return `((${l}) >= (${r}))`;
      case "/":
        // R21: `/` always yields a float.
        if (isFloat) return `((hk_float)(${l}) / (hk_float)(${r}))`;
        return `hk_fdiv(${l}, ${r}, ${this.loc(e.span)})`;
      case "%":
        if (isFloat) return `fmod((hk_float)(${l}), (hk_float)(${r}))`;
        return `hk_mod(${l}, ${r}, ${this.loc(e.span)})`;
      case "+": case "-": case "*": {
        if (isFloat) return `((${l}) ${e.op} (${r}))`;
        if (this.opts.release) return `((${l}) ${e.op} (${r}))`;
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
      const args = e.args.map((a) => this.expr(a.value));

      // Prelude functions with a direct C equivalent.
      switch (n) {
        case "len": {
          const t = this.tyOf(e.args[0]!.value);
          if (this.isList(t)) return `(${args[0]})->len`;
          if (this.isStr(t)) return `hk_str_len_chars(${args[0]})`;
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
        if (!member.c) {
          this.err("E0707", `the native backend does not implement \`${op.name}.${m}\` yet`, e.span,
            "run it with `halka run` while the backend catches up");
          return "0";
        }
        this.usePrelude(op.name);
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

  private listLit(e: A.ListExpr): string {
    const t = this.tyOf(e);
    const et = this.cty(this.elemOf(t), "element", e.span);
    const v = this.fresh("lit");
    this.line(`hk_list *${v} = hk_list_new(sizeof(${et}), ${e.elements.length});`);
    for (const x of e.elements) this.line(`HK_PUSH(${v}, ${et}, ${this.expr(x)});`);
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

  /** Produce an `hk_str *` for any expression (used by `say` and `+`). */
  private asStr(e: A.Expr): string {
    const t = this.tyOf(e);
    const p = t ? prune(t) : undefined;
    if (e.kind === "StrLit") return this.strLit(e);

    // A list prints as `[a, b, c]`, matching `inspect` (#53).
    if (p?.k === "list" || p?.k === "array") {
      const elem = this.cty(this.elemOf(t), "element", e.span);
      const kind = elem === "hk_float" ? 1 : elem === "hk_bool" ? 2 : elem === "hk_char" ? 3 : elem === "hk_str *" ? 4 : 0;
      const isRead = e.kind === "Ident" || e.kind === "MemberExpr" || e.kind === "IndexExpr";
      if (isRead) return `hk_str_from_list(${this.expr(e)}, ${kind})`;
      // A list built just to be printed is freed again straight away.
      const lv = this.fresh("plst");
      const sv = this.fresh("pstr");
      this.line(`hk_list *${lv} = ${this.expr(e)};`);
      this.line(`hk_str *${sv} = hk_str_from_list(${lv}, ${kind});`);
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
  return e.kind === "ListExpr" || e.kind === "MapExpr" || e.kind === "SetExpr";
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
  o: { file: string; release: boolean; escapes?: EscapeInfo },
): EmitOptions {
  return {
    release: o.release,
    file: o.file,
    escapes: o.escapes,
    foreignImports: inferred.foreignImports,
    structFields: inferred.structFields,
    enumVariants: inferred.enumVariants,
    enumGenerics: inferred.enumGenerics,
  };
}

export function emitC(mod: A.Module, types: TypeMap, opts: EmitOptions): EmitResult {
  return new CEmitter(types, opts).emit(mod);
}
