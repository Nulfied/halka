// Whole-program linking: fold a program and its imported modules into one
// module, so the rest of the pipeline never has to know modules exist.
//
// The native backend compiles a single module. Rather than teach inference,
// ownership, escape analysis and emission each to carry a cross-module
// environment, this pass does what a linker does: it gives every imported
// declaration a unique name, rewrites every reference to match, and
// concatenates. Everything downstream then sees one flat program.
//
// This is whole-program compilation, and the trade-off is worth naming:
// there is no separate compilation and no incremental build, so a large
// dependency is recompiled every time. In exchange the C compiler sees
// across module boundaries and can inline through them, and none of the
// passes below need a notion of scope they do not already have.
//
// Only *declarations* are taken from a dependency. A module's top-level
// statements do not run on import, which is what the interpreter already
// does: it hoists a dependency's declarations and executes only main.

import type * as A from "../parser/ast.ts";
import { isPreludeModule } from "./prelude-types.ts";

export interface LinkInput {
  main: A.Module;
  /** Dependencies in load order: a module appears before anything using it. */
  deps: { path: string; mod: A.Module }[];
}

export interface LinkResult {
  module: A.Module;
  /** Linked name -> where it came from, so diagnostics can still read well. */
  origins: Map<string, { module: string; name: string }>;
}

type Decl =
  | A.FnDecl | A.StructDecl | A.EnumDecl | A.TraitDecl
  | A.TypeAliasDecl | A.ConstDecl | A.CapabilityDecl;

function isDeclKind(kind: string): boolean {
  return kind === "FnDecl" || kind === "StructDecl" || kind === "EnumDecl"
    || kind === "TraitDecl" || kind === "TypeAliasDecl" || kind === "ConstDecl"
    || kind === "CapabilityDecl";
}

function declName(s: A.Stmt): string | null {
  return isDeclKind(s.kind) ? (s as Decl).name : null;
}

/**
 * A declaration's linked name. `.` cannot appear in an identifier, so a
 * dotted import path becomes underscores; the prefix keeps the result clear
 * of anything a person would plausibly write.
 */
function mangle(modulePath: string, name: string): string {
  return `hk_m_${modulePath.replace(/[^A-Za-z0-9]/g, "_")}__${name}`;
}

// ---------------------------------------------------------------------------
// scopes
//
// A local may shadow a module-level name (`let encode: 5` beside a top-level
// `encode`), so a reference can only be renamed when nothing nearer binds it.
// Without this the linker would rewrite the local and change what the
// program means.
// ---------------------------------------------------------------------------

class Scope {
  private names = new Set<string>();
  private parent: Scope | null;
  // A parameter property would be neater, but the toolchain is erasable
  // TypeScript: it runs under `node --experimental-strip-types`, which
  // refuses any syntax that has to emit code.
  constructor(parent: Scope | null = null) { this.parent = parent; }
  bind(name: string): void { this.names.add(name); }
  shadows(name: string): boolean {
    return this.names.has(name) || (this.parent?.shadows(name) ?? false);
  }
  child(): Scope { return new Scope(this); }
}

/** Bind every name a pattern introduces. */
function bindPattern(p: unknown, scope: Scope): void {
  if (p === null || typeof p !== "object") return;
  const n = p as { kind?: string } & Record<string, unknown>;
  switch (n.kind) {
    case "BindPat": case "RestPat":
      if (typeof n["name"] === "string") scope.bind(n["name"]);
      return;
    case "TuplePat": case "ListPat":
      for (const e of n["elements"] as unknown[]) bindPattern(e, scope);
      return;
    case "MapPat":
      for (const e of n["entries"] as { value: unknown }[]) bindPattern(e.value, scope);
      return;
    case "VariantPat":
      for (const a of n["args"] as unknown[]) bindPattern(a, scope);
      return;
    case "StructPat":
      for (const f of n["fields"] as { pattern: unknown }[]) bindPattern(f.pattern, scope);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------

type Rename = Map<string, string>;

export function linkProgram(input: LinkInput): LinkResult {
  const origins = new Map<string, { module: string; name: string }>();

  // What each module exports, and what each export was renamed to.
  const exportsOf = new Map<string, Map<string, string>>();
  for (const { path, mod } of input.deps) {
    const table = new Map<string, string>();
    for (const s of mod.stmts) {
      const name = declName(s);
      if (name === null) continue;
      // A macro is expanded before this runs, and a foreign declaration names
      // a symbol in another language; neither may be renamed.
      if (s.kind === "FnDecl" && (s.isMacro || s.foreign)) continue;
      if (s.kind === "StructDecl" && s.foreign) continue;
      const to = mangle(path, name);
      table.set(name, to);
      origins.set(to, { module: path, name });
    }
    exportsOf.set(path, table);
  }

  const stmts: A.Stmt[] = [];

  // Dependencies first, in load order, so a declaration precedes its use.
  for (const { path, mod } of input.deps) {
    // Inside a dependency both its own names and the ones it imported are in
    // scope, so its rename map is the union.
    const rename: Rename = new Map(exportsOf.get(path)!);
    for (const [alias, target] of importedModules(mod)) {
      for (const [member, to] of exportsOf.get(target) ?? []) rename.set(`${alias}.${member}`, to);
    }
    const top = new Scope();
    for (const s of mod.stmts) {
      if (s.kind === "ImportDecl") continue; // a dependency's imports are resolved above
      if (declName(s) === null) continue; // top-level code is not imported
      stmts.push(rewrite(s, rename, top) as A.Stmt);
    }
  }

  // Then main, with its own imports resolved. Foreign imports stay: the
  // backend needs them to emit prototypes and to know what to link.
  const mainRename: Rename = new Map();
  for (const [alias, target] of importedModules(input.main)) {
    for (const [member, to] of exportsOf.get(target) ?? []) mainRename.set(`${alias}.${member}`, to);
  }
  const mainTop = new Scope();
  for (const s of input.main.stmts) {
    // A prelude module is not a file to link in — it is provided by the
    // runtime — so its import has to survive, or inference never binds the
    // name and every `math.sqrt` types as unknown.
    if (s.kind === "ImportDecl" && !s.foreign && !isPreludeModule(s.path)) continue;
    stmts.push(rewrite(s, mainRename, mainTop) as A.Stmt);
  }

  return { module: { ...input.main, stmts }, origins };
}

/** `alias -> module path` for every whole-module import in a module. */
function importedModules(mod: A.Module): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of mod.stmts) {
    if (s.kind !== "ImportDecl" || s.foreign || s.form !== "module") continue;
    out.set(s.alias ?? s.path.split(".").pop()!, s.path);
  }
  return out;
}

/**
 * Structural rewrite. Every node is copied, so the caller's AST is untouched
 * — the interpreter may still be handed the originals.
 *
 * The rename map holds two kinds of key: a bare name, for a declaration in
 * the module being rewritten, and `alias.member`, for something reached
 * through an import. A `MemberExpr` is tested against the second form before
 * being treated as a field access, which is what turns `codec.encode(x)`
 * into a plain call to the linked name.
 */
function rewrite(node: unknown, r: Rename, scope: Scope): unknown {
  if (Array.isArray(node)) return node.map((n) => rewrite(n, r, scope));
  if (node === null || typeof node !== "object") return node;

  const n = node as { kind?: unknown } & Record<string, unknown>;
  if (typeof n.kind !== "string") {
    // Plain records with no `kind` — a parameter, a match arm, a struct
    // field — still hold nodes that need rewriting. Returning them untouched
    // left parameter *type annotations* unrenamed, so a function took
    // `Point` while its callers passed the linked `..__Point`.
    // A bare string value is a binding occurrence and is left alone, which
    // falls out of `rewrite` returning non-objects unchanged.
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n)) {
      copy[key] = key === "span" ? value : rewrite(value, r, scope);
    }
    return copy;
  }

  switch (n.kind) {
    case "Ident": {
      const name = n["name"] as string;
      if (scope.shadows(name)) return n;
      const to = r.get(name);
      return to ? { ...n, name: to } : n;
    }

    case "NamedType": {
      const name = n["name"] as string;
      const to = scope.shadows(name) ? undefined : r.get(name);
      return { ...n, name: to ?? name, args: rewrite(n["args"], r, scope) };
    }

    case "MemberExpr": {
      const obj = n["obj"] as { kind?: string; name?: string } | undefined;
      if (obj && obj.kind === "Ident" && typeof obj.name === "string" && !scope.shadows(obj.name)) {
        const to = r.get(`${obj.name}.${n["name"] as string}`);
        if (to) return { kind: "Ident", name: to, span: n["span"] };
      }
      break;
    }

    // ---- scope-introducing forms --------------------------------------
    case "FnDecl": {
      const inner = scope.child();
      for (const p of (n["params"] as { name?: string }[] | undefined) ?? []) {
        if (typeof p.name === "string") inner.bind(p.name);
      }
      for (const g of (n["generics"] as { name?: string }[] | undefined) ?? []) {
        if (typeof g.name === "string") inner.bind(g.name);
      }
      // `self` is bound inside methods.
      inner.bind("self");
      return mapNode(n, r, scope, inner);
    }

    case "Block": {
      // A block binds sequentially: a `let` shadows only what follows it.
      const inner = scope.child();
      const out: unknown[] = [];
      for (const s of (n["stmts"] as unknown[]) ?? []) {
        out.push(rewrite(s, r, inner));
        const st = s as { kind?: string; pattern?: unknown; name?: unknown };
        if (st.kind === "LetStmt") bindPattern(st.pattern, inner);
        else if (st.kind === "ConstDecl" && typeof st.name === "string") inner.bind(st.name);
      }
      return { ...n, stmts: out };
    }

    case "ForStmt": {
      const inner = scope.child();
      bindPattern(n["pattern"], inner);
      return {
        ...n,
        pattern: rewrite(n["pattern"], r, inner),
        iter: rewrite(n["iter"], r, scope),
        body: rewrite(n["body"], r, inner),
      };
    }

    case "MatchExpr": {
      const arms = ((n["arms"] as { pattern: unknown; guard?: unknown; body: unknown; span: unknown }[]) ?? [])
        .map((arm) => {
          const inner = scope.child();
          bindPattern(arm.pattern, inner);
          return {
            ...arm,
            pattern: rewrite(arm.pattern, r, inner),
            guard: arm.guard ? rewrite(arm.guard, r, inner) : arm.guard,
            body: rewrite(arm.body, r, inner),
          };
        });
      return {
        ...n,
        subject: rewrite(n["subject"], r, scope),
        arms,
        elseArm: n["elseArm"] ? rewrite(n["elseArm"], r, scope) : n["elseArm"],
      };
    }

    default:
      break;
  }

  return mapNode(n, r, scope, scope);
}

/** Copy a node, rewriting children in `inner` and renaming its own name. */
function mapNode(
  n: Record<string, unknown> & { kind?: unknown },
  r: Rename,
  outer: Scope,
  inner: Scope,
): unknown {
  const kind = n.kind as string;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(n)) {
    if (key === "span" || key === "kind") {
      out[key] = value;
    } else if (key === "name" && isDeclKind(kind)) {
      // Rename the declaration itself. A field or parameter of the same name
      // is reached through a different key, so it is left alone.
      out[key] = outer.shadows(value as string) ? value : (r.get(value as string) ?? value);
    } else if (key === "typeName" && kind === "ImplDecl") {
      out[key] = r.get(value as string) ?? value;
    } else if (key === "traits" && kind === "ImplDecl") {
      out[key] = (value as string[]).map((t) => r.get(t) ?? t);
    } else {
      out[key] = rewrite(value, r, inner);
    }
  }
  return out;
}
