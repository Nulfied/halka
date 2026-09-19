// `halka fmt` — the canonical formatter (#48, #53).
//
// Contract: the formatter understands the parsed structure and never changes
// meaning. It normalises indentation to 4 spaces, operator spacing, and comma
// presentation, and chooses the horizontal bracket layout when it fits inside
// the line budget and the vertical one otherwise (both are locked as valid).
//
// The comma rule it emits is the one the locked examples use: within a block,
// every statement is followed by `,` except the last, and the last also gets a
// `,` when the enclosing construct continues (for instance before `else`).

import type * as A from "../parser/ast.ts";
import type { Comment } from "../lexer/lexer.ts";
import { typeText } from "../runtime/convert.ts";

const INDENT = "    ";
const WIDTH = 88;

class Formatter {
  private out: string[] = [];
  private comments: Comment[];
  private used = new Set<Comment>();

  constructor(comments: Comment[] = []) {
    this.comments = [...comments].sort((a, b) => a.span.start.offset - b.span.start.offset);
  }

  format(mod: A.Module): string {
    this.block(mod.stmts, 0, false, true);
    this.flushRemainingComments(0);
    let text = this.out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    return text + "\n";
  }

  // ---- comments ---------------------------------------------------------

  /** Emit own-line comments that appear before `line`. */
  private commentsBefore(line: number, depth: number): void {
    for (const c of this.comments) {
      if (this.used.has(c)) continue;
      if (c.span.start.line >= line) break;
      if (!c.ownLine) continue;
      this.used.add(c);
      for (const l of c.text.split("\n")) this.push(depth, l.trim());
    }
  }

  /** A trailing comment on the same line as the statement. */
  private trailingOn(line: number): string {
    for (const c of this.comments) {
      if (this.used.has(c) || c.ownLine || c.block) continue;
      if (c.span.start.line === line) { this.used.add(c); return "  " + c.text.trim(); }
      if (c.span.start.line > line) break;
    }
    return "";
  }

  private flushRemainingComments(depth: number): void {
    for (const c of this.comments) {
      if (this.used.has(c)) continue;
      this.used.add(c);
      for (const l of c.text.split("\n")) this.push(depth, l.trim());
    }
  }

  private push(depth: number, line: string): void {
    this.out.push(line ? INDENT.repeat(depth) + line : "");
  }

  // ---- blocks -----------------------------------------------------------

  /**
   * @param continues whether something follows this whole block, which is what
   *   decides the trailing comma on its last statement (#50).
   */
  private block(stmts: A.Stmt[], depth: number, continues: boolean, topLevel = false): void {
    stmts.forEach((s, i) => {
      const last = i === stmts.length - 1;
      // The module top level is a list of independent statements, not one
      // continued construct, so it carries no separating commas (#53).
      const comma = topLevel ? false : last ? continues : true;
      if (topLevel && i > 0 && needsBlankLineBefore(s, stmts[i - 1]!)) this.out.push("");
      this.stmt(s, depth, comma);
    });
  }

  // ---- statements -------------------------------------------------------

  private stmt(s: A.Stmt, depth: number, comma: boolean): void {
    this.commentsBefore(s.span.start.line, depth);
    const tail = (text: string) => this.push(depth, text + (comma ? "," : "") + this.trailingOn(s.span.start.line));

    switch (s.kind) {
      case "LetStmt": {
        const kw = s.isConst ? "const" : "let";
        const pat = this.pattern(s.pattern);
        const parts = [`${kw} ${pat}`];
        if (s.type) parts.push(typeText(s.type));
        if (s.value !== undefined) {
          if (s.value.kind === "RecordExpr" || s.value.kind === "BlockExpr") {
            this.push(depth, `${parts.join(": ")}:`);
            this.valueBlock(s.value, depth + 1, comma);
            return;
          }
          parts.push(this.expr(s.value, depth));
        }
        return tail(parts.join(": "));
      }

      case "ConstDecl":
        return tail(`const ${s.name}${s.type ? `: ${typeText(s.type)}` : ""}: ${this.expr(s.value, depth)}`);

      case "AssignStmt": {
        const target = this.expr(s.target, depth);
        if (s.value.kind === "RecordExpr" || s.value.kind === "BlockExpr") {
          this.push(depth, `${target}${s.type ? `: ${typeText(s.type)}` : ""}:`);
          this.valueBlock(s.value, depth + 1, comma);
          return;
        }
        const mid = s.type ? `: ${typeText(s.type)}` : "";
        return tail(`${target}${mid}: ${this.expr(s.value, depth)}`);
      }

      case "ExprStmt": {
        const e = s.expr;
        if (e.kind === "CallExpr" && e.command) {
          const args = e.args.map((a) => this.expr(a.value, depth));
          const name = this.expr(e.callee, depth);
          // `send ch : v`-shaped commands keep the association form.
          if (args.length === 2 && isAssocCommand(name)) return tail(`${name} ${args[0]} : ${args[1]}`);
          return tail(`${name} ${args.join(", ")}`);
        }
        return tail(this.expr(e, depth));
      }

      case "SayStmt": return tail(`say${s.args.length ? " " + s.args.map((a) => this.expr(a, depth)).join(", ") : ""}`);
      case "GiveStmt": return tail(s.value ? `give ${this.expr(s.value, depth)}` : "give");
      case "BreakStmt": return tail("break");
      case "ContinueStmt": return tail("continue");

      case "IfStmt": {
        this.push(depth, `if ${this.expr(s.cond, depth)},`);
        const hasMore = s.elifs.length > 0 || !!s.else;
        this.block(s.then.stmts, depth + 1, hasMore || comma);
        s.elifs.forEach((e, i) => {
          this.push(depth, `else if ${this.expr(e.cond, depth)},`);
          const more = i < s.elifs.length - 1 || !!s.else;
          this.block(e.block.stmts, depth + 1, more || comma);
        });
        if (s.else) {
          this.push(depth, "else,");
          this.block(s.else.stmts, depth + 1, comma);
        }
        return;
      }

      case "ForStmt":
        this.push(depth, `for ${this.pattern(s.pattern)} in ${this.expr(s.iter, depth)},`);
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "WhileStmt":
        this.push(depth, `while ${this.expr(s.cond, depth)},`);
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "MatchStmt":
        this.matchExpr(s.expr, depth, comma);
        return;

      case "DeferStmt": {
        const saved = this.out.length;
        this.stmt(s.stmt, depth, comma);
        const line = this.out[saved]!;
        this.out[saved] = line.replace(/^(\s*)/, `$1defer `);
        return;
      }

      case "WithStmt":
        this.push(depth, `with ${s.capability ? "capability " : ""}${this.expr(s.subject, depth)},`);
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "ParallelStmt":
        this.push(depth, "parallel:");
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "UnsafeStmt":
        this.push(depth, "unsafe:");
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "IntrinsicStmt": {
        const t = this.expr(s.target, depth);
        const v = s.value ? this.expr(s.value, depth) : "";
        switch (s.op) {
          case "send": case "store": return tail(`${s.op} ${t} : ${v}`);
          case "grant": return tail(`give ${t} to ${v}`);
          case "revoke": return tail(`revoke ${t}${v ? ` from ${v}` : ""}`);
          default: return tail(`${s.op} ${t}`);
        }
      }

      case "FnDecl": return this.fnDecl(s, depth, comma);

      case "StructDecl": {
        this.push(depth, `${s.foreign ? s.foreign + " struct " : ""}${s.name}${this.generics(s.generics)}:`);
        s.fields.forEach((f, i) => {
          const parts = [f.name];
          if (f.type) parts.push(typeText(f.type));
          if (f.default) parts.push(this.expr(f.default, depth + 1));
          this.push(depth + 1, parts.join(": ") + (i < s.fields.length - 1 ? "," : comma ? "," : ""));
        });
        return;
      }

      case "EnumDecl": {
        this.push(depth, `enum ${s.name}${this.generics(s.generics)}:`);
        s.variants.forEach((v, i) => {
          const fields = v.fields.length ? `(${v.fields.map((f) => this.param(f, depth)).join(", ")})` : "";
          this.push(depth + 1, `${v.name}${fields}` + (i < s.variants.length - 1 ? "," : comma ? "," : ""));
        });
        return;
      }

      case "TraitDecl":
        this.push(depth, `trait ${s.name}${this.generics(s.generics)}:`);
        s.members.forEach((m, i) => this.fnDecl(m, depth + 1, i < s.members.length - 1 || comma));
        return;

      case "ImplDecl":
        this.push(depth, `${s.typeName} implements ${s.traits.join(", ")}:`);
        s.members.forEach((m, i) => this.fnDecl(m, depth + 1, i < s.members.length - 1 || comma));
        return;

      case "TypeAliasDecl":
        return tail(`type ${s.name}${this.generics(s.generics)}: ${typeText(s.type)}`);

      case "CapabilityDecl":
        this.push(depth, `capability ${s.name}:`);
        s.perms.forEach((p, i) => this.push(depth + 1, p + (i < s.perms.length - 1 ? "," : comma ? "," : "")));
        return;

      case "ImportDecl": {
        const lang = s.foreign ? s.foreign + " " : "";
        const path = /[/."]/.test(s.path) && !/^[a-z_][\w.]*$/i.test(s.path) ? `"${s.path}"` : s.path;
        if (s.form === "module") return tail(`import ${lang}${path}${s.alias ? `: ${s.alias}` : ""}`);
        const names = s.names.map((n) => (n.alias ? `${n.name}: ${n.alias}` : n.name)).join(", ");
        return tail(`from ${lang}${path} import ${names}`);
      }

      case "ExportDecl":
        if (s.names.length > 3) {
          this.push(depth, "export:");
          s.names.forEach((n, i) => this.push(depth + 1, n + (i < s.names.length - 1 ? "," : comma ? "," : "")));
          return;
        }
        return tail(`export ${s.names.join(", ")}`);

      case "ExternDecl":
        if (s.abi) {
          this.push(depth, "extern:");
          const es = Object.entries(s.abi);
          es.forEach(([k, v], i) => this.push(depth + 1, `${k}: ${/^\w+$/.test(v) ? v : `"${v}"`}` + (i < es.length - 1 ? "," : comma ? "," : "")));
          return;
        }
        return tail(`extern ${s.lang ?? ""} ${s.name ?? ""}`.replace(/\s+/g, " ").trim());

      case "GenerateDecl":
        this.push(depth, `generate${s.lang ? " " + s.lang : s.target ? " " + s.target : ""}:`);
        this.block(s.body.stmts, depth + 1, comma);
        return;

      case "SpecializeDecl":
        if (s.items.length === 1) {
          const it = s.items[0]!;
          return tail(`specialize ${it.name}${it.typeArgs.length ? `<${it.typeArgs.map(typeText).join(", ")}>` : ""}`);
        }
        this.push(depth, "specialize:");
        s.items.forEach((it, i) =>
          this.push(depth + 1, `${it.name}${it.typeArgs.length ? `<${it.typeArgs.map(typeText).join(", ")}>` : ""}` + (i < s.items.length - 1 ? "," : comma ? "," : "")));
        return;
    }
  }

  private valueBlock(v: A.Expr, depth: number, comma: boolean): void {
    if (v.kind === "RecordExpr") {
      v.entries.forEach((e, i) => {
        const last = i === v.entries.length - 1;
        if (e.value.kind === "RecordExpr" || e.value.kind === "BlockExpr") {
          this.push(depth, `${e.key}:`);
          this.valueBlock(e.value, depth + 1, !last || comma);
          return;
        }
        this.push(depth, `${e.key}: ${this.expr(e.value, depth)}` + (!last || comma ? "," : ""));
      });
      return;
    }
    if (v.kind === "BlockExpr") {
      this.block(v.block.stmts, depth, comma);
      return;
    }
    this.push(depth, this.expr(v, depth) + (comma ? "," : ""));
  }

  private fnDecl(s: A.FnDecl, depth: number, comma: boolean): void {
    this.commentsBefore(s.span.start.line, depth);
    const marker = s.isMacro ? "macro " : s.isCompile ? "compile " : s.isCallback ? "callback "
      : s.isKernel ? "kernel " : s.isDevice ? "device " : s.foreign ? s.foreign + " " : "";
    const params = s.params.map((p) => this.param(p, depth)).join(", ");
    const ret = s.retType ? `: ${typeText(s.retType)}` : "";
    const req = s.requires.length ? ` requires ${s.requires.join(", ")}` : "";
    const head = `${marker}${s.name}${this.generics(s.generics)}(${params})${ret}${req}`;
    if (!s.body) {
      this.push(depth, head + (comma ? "," : ""));
      return;
    }
    this.push(depth, head + ",");
    this.block(s.body.stmts, depth + 1, comma);
  }

  private param(p: A.Param, depth: number): string {
    if (p.name === "...") return "...";
    const parts = [p.name];
    if (p.type) parts.push((p.variadic ? "..." : "") + typeText(p.type));
    if (p.default) parts.push(this.expr(p.default, depth));
    return parts.join(": ");
  }

  private generics(g: A.GenericParam[]): string {
    if (!g.length) return "";
    return `<${g.map((x) => (x.bounds.length ? `${x.name}: ${x.bounds.join(" + ")}` : x.name)).join(", ")}>`;
  }

  private matchExpr(m: A.MatchExpr, depth: number, comma: boolean): void {
    this.push(depth, `match ${this.expr(m.subject, depth)},`);
    const n = m.arms.length + (m.elseArm ? 1 : 0);
    m.arms.forEach((arm, i) => {
      const guard = arm.guard ? ` if ${this.expr(arm.guard, depth)}` : "";
      this.push(depth + 1, `${this.pattern(arm.pattern)}${guard},`);
      this.block(arm.body.stmts, depth + 2, i < n - 1 || comma);
    });
    if (m.elseArm) {
      this.push(depth + 1, "else,");
      this.block(m.elseArm.stmts, depth + 2, comma);
    }
  }

  // ---- patterns ---------------------------------------------------------

  private pattern(p: A.Pattern): string {
    switch (p.kind) {
      case "BindPat": return p.type ? `${p.name}: ${typeText(p.type)}` : p.name;
      case "WildcardPat": return "_";
      case "RestPat": return `...${p.name ?? ""}`;
      case "NullPat": return "null";
      case "TypePat": return p.name;
      case "LiteralPat": return this.expr(p.value, 0);
      case "TuplePat": return `(${p.elements.map((x) => this.pattern(x)).join(", ")})`;
      case "ListPat": return `[${p.elements.map((x) => this.pattern(x)).join(", ")}]`;
      case "MapPat": return `[${p.entries.map((e) => `${this.expr(e.key, 0)}: ${this.pattern(e.value)}`).join(", ")}]`;
      case "VariantPat": return `${p.name}(${p.args.map((x) => this.pattern(x)).join(", ")})`;
      case "StructPat": return `${p.name}{${p.fields.map((f) => `${f.name}: ${this.pattern(f.pattern)}`).join(", ")}}`;
    }
  }

  // ---- expressions ------------------------------------------------------

  /**
   * Renders an expression on one line. Collection literals that would overflow
   * the line budget are emitted vertically instead — both layouts are locked as
   * equivalent (#5, #48), so this is a pure presentation choice.
   */
  private expr(e: A.Expr, depth: number): string {
    const flat = this.flat(e);
    if (flat.length + depth * 4 <= WIDTH) return flat;
    return this.vertical(e, depth) ?? flat;
  }

  private vertical(e: A.Expr, depth: number): string | null {
    const pad = INDENT.repeat(depth + 1);
    const close = INDENT.repeat(depth);
    switch (e.kind) {
      case "ListExpr":
        if (!e.elements.length) return null;
        return `[\n${e.elements.map((x) => pad + this.expr(x, depth + 1)).join(",\n")}\n${close}]`;
      case "MapExpr":
        if (!e.entries.length) return null;
        return `[\n${e.entries.map((x) => `${pad}${this.expr(x.key, depth + 1)}: ${this.expr(x.value, depth + 1)}`).join(",\n")}\n${close}]`;
      case "SetExpr":
        if (!e.elements.length) return null;
        return `{\n${e.elements.map((x) => pad + this.expr(x, depth + 1)).join(",\n")}\n${close}}`;
      case "CallExpr": {
        if (!e.args.length) return null;
        const callee = this.flat(e.callee);
        const args = e.args.map((a) => pad + (a.name ? `${a.name}: ` : "") + this.expr(a.value, depth + 1));
        return `${callee}${this.typeArgs(e.typeArgs)}(\n${args.join(",\n")}\n${close})`;
      }
      case "TupleExpr":
        if (!e.elements.length) return null;
        return `(\n${e.elements.map((x) => pad + this.expr(x, depth + 1)).join(",\n")}\n${close})`;
      default:
        return null;
    }
  }

  private typeArgs(ts: A.TypeNode[]): string {
    return ts.length ? `<${ts.map(typeText).join(", ")}>` : "";
  }

  /** One-line rendering of any expression. */
  private flat(e: A.Expr): string {
    switch (e.kind) {
      case "IntLit": return e.value.toString();
      case "FloatLit": return Number.isInteger(e.value) ? `${e.value}.0` : String(e.value);
      case "BoolLit": return e.value ? "true" : "false";
      case "NullLit": return "null";
      case "NothingLit": return "nothing";
      case "EllipsisExpr": return "...";
      case "CharLit": return `'${escape(e.value)}'`;
      case "StrLit": {
        if (e.raw) return `r"${e.parts.map((p) => p.text ?? "").join("")}"`;
        const body = e.parts.map((p) => (p.kind === "text" ? escape(p.text ?? "") : `{${this.flat(p.expr!)}}`)).join("");
        if (e.multiline) return `"""\n${body}"""`;
        return `"${body}"`;
      }
      case "Ident": return e.name;
      case "TupleExpr": return `(${e.elements.map((x) => this.flat(x)).join(", ")}${e.elements.length === 1 ? "," : ""})`;
      case "ListExpr": return `[${e.elements.map((x) => this.flat(x)).join(", ")}]`;
      case "MapExpr": return e.entries.length ? `[${e.entries.map((x) => `${this.flat(x.key)}: ${this.flat(x.value)}`).join(", ")}]` : "map()";
      case "SetExpr": return e.elements.length ? `{${e.elements.map((x) => this.flat(x)).join(", ")}}` : "set()";
      case "RecordExpr": return `{${e.entries.map((x) => `${x.key}: ${this.flat(x.value)}`).join(", ")}}`;
      case "BlockExpr": return "...";
      case "CallExpr": {
        const args = e.args.map((a) => (a.name ? `${a.name}: ${this.flat(a.value)}` : this.flat(a.value))).join(", ");
        return `${this.flat(e.callee)}${this.typeArgs(e.typeArgs)}(${args})`;
      }
      case "MemberExpr": return `${this.flat(e.obj)}.${e.name}`;
      case "IndexExpr": return `${this.flat(e.obj)}[${this.flat(e.index)}]`;
      case "SliceExpr": {
        const s = e.start ? this.flat(e.start) : "";
        const en = e.end ? this.flat(e.end) : "";
        const st = e.step ? `:${this.flat(e.step)}` : "";
        return `${this.flat(e.obj)}[${s}:${en}${st}]`;
      }
      case "UnaryExpr": return e.op === "not" ? `not ${this.flat(e.operand)}` : `${e.op}${this.flat(e.operand)}`;
      case "BinaryExpr": return `${this.wrap(e.lhs, e)} ${e.op} ${this.wrap(e.rhs, e)}`;
      case "RangeExpr": {
        const lo = e.lo ? this.flat(e.lo) : "";
        const hi = e.hi ? this.flat(e.hi) : "";
        const base = `${lo}..${e.inclusive ? "=" : ""}${hi}`;
        return e.step ? `range ${base} step ${this.flat(e.step)}` : base;
      }
      case "CastExpr": return `${this.flat(e.expr)} ${e.fallible ? "to" : "as"} ${typeText(e.type)}`;
      case "IsExpr": return `${this.flat(e.expr)} is ${e.test}`;
      case "BorrowExpr": return `borrow ${e.mut ? "mut " : ""}${this.flat(e.expr)}`;
      case "MoveExpr": return `move ${this.flat(e.expr)}`;
      case "RefExpr": return `&${e.mut ? "mut " : ""}${this.flat(e.expr)}`;
      case "DerefExpr": return `*${this.flat(e.expr)}`;
      case "RawExpr": return `raw ${this.flat(e.expr)}`;
      case "ApplyExpr": return `apply ${this.flat(e.value)} : ${this.flat(e.fn)}`;
      case "StartExpr": return `start ${this.flat(e.call)}`;
      case "AwaitExpr": return `await ${this.flat(e.expr)}`;
      case "ReceiveExpr": return `receive ${this.flat(e.channel)}`;
      case "LoadExpr": return `load ${this.flat(e.target)}`;
      case "MakeExpr": {
        if (e.what !== "channel") return `make ${e.what}`;
        const ty = e.type ? `(${typeText(e.type)})` : "";
        return `make channel${ty}${e.capacity ? `: ${this.flat(e.capacity)}` : ""}`;
      }
      case "AtomicExpr": return `atomic(${e.type ? typeText(e.type) + "): " : ""}${e.type ? this.flat(e.init) : this.flat(e.init) + ")"}`;
      case "ReflectExpr": return `reflect ${this.flat(e.target)}`;
      case "CompileExpr": return `compile ${this.flat(e.expr)}`;
      case "LaunchExpr": return `launch ${this.flat(e.call)}`;
      case "DeviceExpr": return `device ${this.flat(e.expr)}`;
      case "AcquireExpr": return `acquire ${e.capability}`;
      case "CancelledExpr": return "cancelled";
      case "ForeignExpr": return `${e.lang} ${this.flat(e.expr)}`;
      case "FnRefExpr": return e.name;
      case "MatchExpr": return `match ${this.flat(e.subject)}`;
    }
  }

  /** Parenthesise a child only when precedence requires it (#51). */
  private wrap(child: A.Expr, parent: A.BinaryExpr): string {
    const s = this.flat(child);
    if (child.kind !== "BinaryExpr") return s;
    const pc = PREC[child.op] ?? 0;
    const pp = PREC[parent.op] ?? 0;
    return pc < pp ? `(${s})` : s;
  }
}

const PREC: Record<string, number> = {
  "*": 5, "/": 5, "%": 5,
  "+": 4, "-": 4,
  "<": 2, "<=": 2, ">": 2, ">=": 2, "==": 2, "!=": 2,
  and: 1, or: 0,
};

function escape(s: string): string {
  return s.replace(/[\\"\n\t\r]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c] ?? c);
}

/** Commands whose second argument is written with the `:` association form. */
function isAssocCommand(name: string): boolean {
  return ["add", "subtract", "exchange", "store", "send", "apply"].includes(name);
}

function needsBlankLineBefore(s: A.Stmt, prev: A.Stmt): boolean {
  const blocky = new Set(["FnDecl", "StructDecl", "EnumDecl", "TraitDecl", "ImplDecl", "CapabilityDecl", "GenerateDecl"]);
  if (blocky.has(s.kind)) return true;
  if (blocky.has(prev.kind)) return true;
  return false;
}

export function format(mod: A.Module, comments: Comment[] = []): string {
  return new Formatter(comments).format(mod);
}
