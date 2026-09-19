// Halka parser — deterministic recursive descent, one canonical parse (#52).
//
// Disambiguation strategy is fully specified in spec/RESOLUTIONS.md:
//   R1  the five roles of `:`          R2  type position
//   R3  block openers / R3.1 casing    R4  `[` index vs literal
//   R5  comma as soft terminator       R6  fn decl vs call statement
//   R7  command-call syntax            R8  precedence
//   R9  generics vs less-than          R10 `is`
//   R12 layout                         R14 header punctuation
//
// Every lookahead used here is bounded and side-effect free.

import { DiagnosticBag, type Span, spanOf } from "../util/diagnostics.ts";
import { T, type Token, type TokenKind, tokenDesc } from "../lexer/token.ts";
import { lex, type Comment } from "../lexer/lexer.ts";
import type * as A from "./ast.ts";

const STATE_TESTS = new Set(["null", "error", "ok", "cancelled", "nothing"]);

/** Binary operator precedence — spec/RESOLUTIONS.md R8. Higher binds tighter. */
const BIN_PREC: Record<string, number> = {
  "*": 5, "/": 5, "%": 5,
  "+": 4, "-": 4,
  // ranges are handled separately at level 3
  "<": 2, "<=": 2, ">": 2, ">=": 2, "==": 2, "!=": 2, is: 2,
  // `not` unary at level 1.5
  and: 1,
  or: 0,
};

export class Parser {
  private toks: Token[];
  private p = 0;
  private file: string;
  readonly diags: DiagnosticBag;
  /** Guard against pathological error recovery loops. */
  private errorCount = 0;

  constructor(tokens: Token[], file: string, diags: DiagnosticBag) {
    this.toks = tokens;
    this.file = file;
    this.diags = diags;
  }

  // ---- token helpers ----------------------------------------------------

  private cur(): Token { return this.toks[this.p]!; }
  private at(k = 0): Token { return this.toks[Math.min(this.p + k, this.toks.length - 1)]!; }
  private is(kind: TokenKind, k = 0): boolean { return this.at(k).kind === kind; }
  private isKw(word: string, k = 0): boolean {
    const t = this.at(k);
    return t.kind === T.Keyword && t.text === word;
  }
  /** FFI boundary markers are contextual keywords (R19). */
  private foreignAt(k = 0): A.ForeignLang | null {
    const t = this.at(k);
    if (t.kind !== T.Ident) return null;
    return t.text === "c" || t.text === "cpp" || t.text === "py" ? (t.text as A.ForeignLang) : null;
  }

  private isAnyKw(...words: string[]): boolean {
    const t = this.cur();
    return t.kind === T.Keyword && words.includes(t.text);
  }
  private next(): Token { return this.toks[this.p++] ?? this.toks[this.toks.length - 1]!; }
  private eat(kind: TokenKind): boolean {
    if (this.is(kind)) { this.p++; return true; }
    return false;
  }
  private eatKw(word: string): boolean {
    if (this.isKw(word)) { this.p++; return true; }
    return false;
  }
  private expect(kind: TokenKind, what: string): Token {
    if (this.is(kind)) return this.next();
    this.error("E0100", `expected ${what}, found ${tokenDesc(this.cur())}`, this.cur().span);
    return this.cur();
  }
  private sp(from: Token | Span, to?: Token | Span): Span {
    const a = "kind" in (from as Token) && "span" in (from as object) ? (from as Token).span : (from as Span);
    const bTok = to ?? this.toks[Math.max(0, this.p - 1)]!;
    const b = "span" in (bTok as object) && (bTok as Token).kind !== undefined ? (bTok as Token).span : (bTok as Span);
    return spanOf(a, b);
  }
  private error(code: string, msg: string, span: Span, extra?: Record<string, unknown>): void {
    this.errorCount++;
    if (this.errorCount > 200) return;
    this.diags.error(code, msg, span, extra as never);
  }

  // ---- layout helpers ---------------------------------------------------

  /** Consume the optional soft-terminator comma plus the newline ending a statement (R5). */
  private endStmt(): void {
    // A nested block already consumed its DEDENT, which ends the statement.
    if (this.toks[this.p - 1]?.kind === T.Dedent) { this.eat(T.Comma); return; }
    this.eat(T.Comma);
    if (this.is(T.Newline)) { this.p++; return; }
    if (this.is(T.Dedent) || this.is(T.Eof)) return;
    this.error("E0101", `unexpected ${tokenDesc(this.cur())} after statement`, this.cur().span, {
      help: "statements end at the end of the line; use `,` only to continue a construct",
    });
    // recover: skip to end of line
    while (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
    this.eat(T.Newline);
  }

  /** Consume `[,] NEWLINE INDENT ... DEDENT` and return the block (R12, R14). */
  private parseSuite(): A.Block {
    const start = this.cur();
    this.eat(T.Comma);
    this.eat(T.Colon); // tolerated: `enum X:` / `trait X:` / `if x:` are all one parse (R14)
    if (!this.is(T.Newline)) {
      // Single-line suite: `if x, say "hi"` — accepted, formatted to a block by `halka fmt`.
      const s = this.parseStmt();
      return { kind: "Block", span: s?.span ?? start.span, stmts: s ? [s] : [] };
    }
    this.expect(T.Newline, "end of line");
    if (!this.is(T.Indent)) {
      this.error("E0102", "expected an indented block here", this.cur().span, {
        rule: "R12 (from #49)",
        help: "indent the body by 4 spaces",
      });
      return { kind: "Block", span: start.span, stmts: [] };
    }
    this.next(); // Indent
    const stmts: A.Stmt[] = [];
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      const before = this.p;
      const s = this.parseStmt();
      if (s) stmts.push(s);
      if (this.p === before) { this.p++; } // hard guard
    }
    this.eat(T.Dedent);
    return { kind: "Block", span: this.sp(start), stmts };
  }

  // ---- entry ------------------------------------------------------------

  parseModule(): A.Module {
    const start = this.cur();
    const stmts: A.Stmt[] = [];
    while (!this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      if (this.is(T.Indent)) {
        this.error("E0103", "unexpected indentation at the top level", this.cur().span);
        this.p++;
        continue;
      }
      if (this.eat(T.Dedent)) continue;
      const before = this.p;
      const s = this.parseStmt();
      if (s) stmts.push(s);
      if (this.p === before) this.p++;
    }
    return { kind: "Module", file: this.file, span: this.sp(start), stmts };
  }

  // =======================================================================
  // Statements
  // =======================================================================

  private parseStmt(): A.Stmt | null {
    while (this.eat(T.Newline)) { /* blank */ }
    if (this.is(T.Eof) || this.is(T.Dedent)) return null;

    const t = this.cur();

    if (t.kind === T.Keyword) {
      switch (t.text) {
        case "let": case "const": return this.parseLet();
        case "type": return this.parseTypeAlias();
        case "enum": return this.parseEnum();
        case "trait": return this.parseTrait();
        case "capability": return this.parseCapability();
        case "import": return this.parseImport();
        case "from": return this.parseFromImport();
        case "export": return this.parseExport();
        case "if": return this.parseIf();
        case "for": return this.parseFor();
        case "while": return this.parseWhile();
        case "match": { const e = this.parseMatch(); this.endStmt(); return { kind: "MatchStmt", span: e.span, expr: e }; }
        case "break": { this.next(); const s: A.BreakStmt = { kind: "BreakStmt", span: t.span }; this.endStmt(); return s; }
        case "continue": { this.next(); const s: A.ContinueStmt = { kind: "ContinueStmt", span: t.span }; this.endStmt(); return s; }
        case "give": return this.parseGive();
        case "say": return this.parseSay();
        case "defer": return this.parseDefer();
        case "with": return this.parseWith();
        case "parallel": { this.next(); const body = this.parseSuite(); return { kind: "ParallelStmt", span: this.sp(t), body }; }
        case "unsafe": { this.next(); const body = this.parseSuite(); return { kind: "UnsafeStmt", span: this.sp(t), body }; }
        case "macro": case "compile": case "kernel": case "callback": case "device":
          return this.parseMarkedDecl();
        case "generate": return this.parseGenerate();
        case "specialize": return this.parseSpecialize();
        case "extern": return this.parseExtern();
        case "send": case "store": return this.parseAssocIntrinsic(t.text as "send" | "store");
        case "cancel": case "register": case "release":
          return this.parseUnaryIntrinsic(t.text as "cancel" | "register" | "release");
        case "revoke": return this.parseRevoke();
      }
    }

    // Declarations and blocks that begin with a bare identifier (R3.1, R6).
    if (t.kind === T.Ident) {
      if (this.foreignAt() && this.canStartExpr2(1)) return this.parseForeignStmt();
      if (this.looksLikeFnDecl(this.p)) return this.parseFnDecl({});
      if (this.isKw("implements", 1)) return this.parseImpl();
      if (this.is(T.Colon, 1) && this.is(T.Newline, 2) && this.is(T.Indent, 3)) {
        // `Name:` block — struct decl if UpperCamelCase, record value otherwise (R3.1).
        if (isTypeName(t.text)) return this.parseStructDecl();
        return this.parseRecordAssign();
      }
      if (this.isCommandCallStart()) return this.parseCommandCallStmt();
    }

    // Fall through: expression, assignment, or binding.
    return this.parseExprOrAssign();
  }

  // ---- let / const ------------------------------------------------------

  private parseLet(): A.Stmt {
    const kw = this.next();
    const isConst = kw.text === "const";
    const pattern = this.parsePattern();
    let type: A.TypeNode | undefined;
    let value: A.Expr | undefined;

    if (this.eat(T.Colon)) {
      const { type: ty, value: val } = this.parseAscriptionTail();
      type = ty;
      value = val;
    }
    this.endStmt();

    if (isConst && value === undefined) {
      this.error("E0104", "a `const` must have a value", this.sp(kw));
    }
    return { kind: "LetStmt", span: this.sp(kw), pattern, type, value, isConst };
  }

  /**
   * After a binding `:` we may see `Type`, `value`, or `Type : value` (R1.1).
   * Chains longer than `target : Type : value` are rejected.
   */
  private parseAscriptionTail(): { type?: A.TypeNode; value?: A.Expr } {
    // Block form: `name:` NEWLINE INDENT  (R3)
    if (this.is(T.Newline) && this.is(T.Indent, 1)) {
      return { value: this.blockIsRecord() ? this.parseRecordBlock() : this.parseBlockValue() };
    }

    if (this.looksLikeTypeThenColon()) {
      const type = this.parseType();
      this.expect(T.Colon, "`:` before the value");
      if (this.is(T.Newline) && this.is(T.Indent, 1)) return { type, value: this.parseRecordBlock() };
      const value = this.parseValueExpr();
      if (this.is(T.Colon)) {
        this.error("E0105", "an ascription chain may have at most `target : Type : value`", this.cur().span, { rule: "R1.1" });
      }
      return { type, value };
    }

    if (this.looksLikeBareType()) return { type: this.parseType() };
    return { value: this.parseValueExpr() };
  }

  /** `name:` NEWLINE INDENT k: v, ... DEDENT  → a record value (R3). */
  private parseRecordBlock(): A.RecordExpr {
    const start = this.cur();
    this.expect(T.Newline, "end of line");
    this.expect(T.Indent, "an indented block");
    const entries: A.RecordExpr["entries"] = [];
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      const keyTok = this.cur();
      if (keyTok.kind !== T.Ident && keyTok.kind !== T.Keyword && keyTok.kind !== T.Str) {
        this.error("E0106", `expected a field name, found ${tokenDesc(keyTok)}`, keyTok.span);
        while (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
        this.eat(T.Newline);
        continue;
      }
      this.next();
      const key = keyTok.kind === T.Str ? (keyTok.parts?.map((x) => x.value).join("") ?? "") : keyTok.text;
      this.expect(T.Colon, "`:` after the field name");
      let value: A.Expr;
      if (this.is(T.Newline) && this.is(T.Indent, 1)) {
        value = this.blockIsRecord() ? this.parseRecordBlock() : this.parseBlockValue();
      } else value = this.parseValueExpr();
      entries.push({ key, value, span: this.sp(keyTok) });
      this.endStmt();
    }
    this.eat(T.Dedent);
    return { kind: "RecordExpr", span: this.sp(start), entries };
  }

  /**
   * An indented body under `name:` holds either `key: value` entries (a record)
   * or ordinary statements (a thunk). Decided by the first line (#3).
   */
  private blockIsRecord(): boolean {
    const k0 = this.at(2);
    const k1 = this.at(3);
    if (k1.kind !== T.Colon) return false;
    return k0.kind === T.Ident || k0.kind === T.Str;
  }

  private parseBlockValue(): A.Expr {
    const start = this.cur();
    const block = this.parseSuite();
    return { kind: "BlockExpr", span: this.sp(start), block };
  }

  private parseRecordAssign(): A.Stmt {
    const nameTok = this.next(); // ident
    this.expect(T.Colon, "`:`");
    const value = this.blockIsRecord() ? this.parseRecordBlock() : this.parseBlockValue();
    const target: A.Ident = { kind: "Ident", span: nameTok.span, name: nameTok.text };
    return { kind: "AssignStmt", span: this.sp(nameTok), target, value };
  }

  // ---- expression / assignment statement --------------------------------

  private parseExprOrAssign(): A.Stmt {
    const start = this.cur();
    const lhs = this.parseExpr(0);

    if (this.is(T.Colon)) {
      this.next();
      if (!isAssignable(lhs)) {
        this.error("E0108", "this is not something you can assign to", lhs.span, {
          rule: "#1 — Operators & expressions",
          help: "assign to a name, a field (`obj.x`), or an index (`items[0]`)",
        });
      }
      const { type, value } = this.parseAscriptionTail();
      this.endStmt();
      return {
        kind: "AssignStmt",
        span: this.sp(start),
        target: lhs,
        type,
        value: value ?? ({ kind: "NullLit", span: this.sp(start) } as A.NullLit),
      };
    }

    this.endStmt();
    return { kind: "ExprStmt", span: this.sp(start), expr: lhs };
  }

  // ---- control flow -----------------------------------------------------

  private parseIf(): A.Stmt {
    const kw = this.next();
    const cond = this.parseExpr(0);
    const then = this.parseSuite();
    const elifs: A.IfStmt["elifs"] = [];
    let elseBlock: A.Block | undefined;

    for (;;) {
      this.eat(T.Comma);
      while (this.is(T.Newline) && this.isKw("else", 1)) this.p++;
      if (!this.isKw("else")) break;
      const elseTok = this.next();
      if (this.isKw("if")) {
        this.next();
        const c = this.parseExpr(0);
        const b = this.parseSuite();
        elifs.push({ cond: c, block: b, span: this.sp(elseTok) });
        continue;
      }
      elseBlock = this.parseSuite();
      break;
    }
    return { kind: "IfStmt", span: this.sp(kw), cond, then, elifs, else: elseBlock };
  }

  private parseFor(): A.Stmt {
    const kw = this.next();
    const pattern = this.parsePattern();
    if (!this.eatKw("in")) {
      this.error("E0109", "expected `in` after the loop variable", this.cur().span, {
        help: "a for loop reads `for item in items,`",
      });
    }
    const iter = this.parseExpr(0);
    const body = this.parseSuite();
    return { kind: "ForStmt", span: this.sp(kw), pattern, iter, body };
  }

  private parseWhile(): A.Stmt {
    const kw = this.next();
    const cond = this.parseExpr(0);
    const body = this.parseSuite();
    return { kind: "WhileStmt", span: this.sp(kw), cond, body };
  }

  private parseGive(): A.Stmt {
    const kw = this.next();
    // `give Capability to worker` — capability delegation (#45)
    if (this.is(T.Ident) && this.isKw("to", 1)) {
      const cap = this.next();
      this.next(); // to
      const who = this.parseExpr(0);
      this.endStmt();
      return {
        kind: "IntrinsicStmt", span: this.sp(kw), op: "grant",
        target: { kind: "Ident", span: cap.span, name: cap.text }, value: who,
      };
    }
    if (this.is(T.Newline) || this.is(T.Comma) || this.is(T.Dedent) || this.is(T.Eof)) {
      this.endStmt();
      return { kind: "GiveStmt", span: this.sp(kw) };
    }
    const value = this.parseValueExpr();
    this.endStmt();
    return { kind: "GiveStmt", span: this.sp(kw), value };
  }

  private parseSay(): A.Stmt {
    const kw = this.next();
    const args: A.Expr[] = [];
    if (!this.is(T.Newline) && !this.is(T.Comma) && !this.is(T.Eof) && !this.is(T.Dedent)) {
      args.push(this.parseExpr(0));
      // `say a, b` on one line: commas separate arguments only inside the same line.
      while (this.is(T.Comma) && !this.is(T.Newline, 1)) {
        this.next();
        if (this.is(T.Newline) || this.is(T.Eof)) break;
        args.push(this.parseExpr(0));
      }
    }
    this.endStmt();
    return { kind: "SayStmt", span: this.sp(kw), args };
  }

  private parseDefer(): A.Stmt {
    const kw = this.next();
    const inner = this.parseStmt();
    return {
      kind: "DeferStmt", span: this.sp(kw),
      stmt: inner ?? ({ kind: "ExprStmt", span: this.sp(kw), expr: { kind: "NothingLit", span: this.sp(kw) } } as A.ExprStmt),
    };
  }

  private parseWith(): A.Stmt {
    const kw = this.next();
    const capability = this.eatKw("capability");
    const subject = this.parseExpr(0);
    const body = this.parseSuite();
    return { kind: "WithStmt", span: this.sp(kw), subject, capability, body };
  }

  private parseMatch(): A.MatchExpr {
    const kw = this.next();
    const subject = this.parseExpr(0);
    this.eat(T.Comma);
    this.eat(T.Colon);
    this.expect(T.Newline, "end of line");
    const arms: A.MatchArm[] = [];
    let elseArm: A.Block | undefined;
    if (!this.is(T.Indent)) {
      this.error("E0110", "expected indented match arms", this.cur().span, { rule: "#10 — Pattern details for match" });
      return { kind: "MatchExpr", span: this.sp(kw), subject, arms };
    }
    this.next();
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      const armStart = this.cur();
      if (this.isKw("else")) {
        this.next();
        elseArm = this.parseSuite();
        this.eat(T.Comma);
        continue;
      }
      const pattern = this.parsePattern();
      let guard: A.Expr | undefined;
      if (this.eatKw("if")) guard = this.parseExpr(0);
      const body = this.parseSuite();
      arms.push({ pattern, guard, body, span: this.sp(armStart) });
      this.eat(T.Comma);
    }
    this.eat(T.Dedent);
    return { kind: "MatchExpr", span: this.sp(kw), subject, arms, elseArm };
  }

  // ---- intrinsics -------------------------------------------------------

  /** `send channel : 10` / `store counter : 10` (R1.2). */
  private parseAssocIntrinsic(op: "send" | "store"): A.Stmt {
    const kw = this.next();
    const target = this.parseExpr(0);
    let value: A.Expr | undefined;
    if (this.eat(T.Colon)) value = this.parseValueExpr();
    else this.error("E0111", `\`${op}\` needs a value: \`${op} target : value\``, this.sp(kw), { rule: "#27/#30" });
    this.endStmt();
    return { kind: "IntrinsicStmt", span: this.sp(kw), op, target, value };
  }

  private parseUnaryIntrinsic(op: "cancel" | "register" | "release"): A.Stmt {
    const kw = this.next();
    // `register callback: handler` (#38)
    if (op === "register" && this.isKw("callback") && this.is(T.Colon, 1)) {
      this.next();
      this.next();
    }
    const target = this.parseExpr(0);
    this.endStmt();
    return { kind: "IntrinsicStmt", span: this.sp(kw), op, target };
  }

  /** `revoke FileAccess from worker` (#45). */
  private parseRevoke(): A.Stmt {
    const kw = this.next();
    const cap = this.parseExpr(0);
    let who: A.Expr | undefined;
    if (this.eatKw("from")) who = this.parseExpr(0);
    this.endStmt();
    return { kind: "IntrinsicStmt", span: this.sp(kw), op: "revoke", target: cap, value: who };
  }

  // ---- command call (R7) -------------------------------------------------

  /** True when the current Ident begins a parenthesis-free command call. */
  private isCommandCallStart(): boolean {
    if (!this.is(T.Ident)) return false;
    const n = this.at(1);
    if (n.nlBefore) return false;
    switch (n.kind) {
      case T.Ident: case T.Keyword: case T.Int: case T.Float:
      case T.Str: case T.RawStr: case T.Char: case T.LBrace:
        break;
      case T.LBracket:
        // `items [0]` would be an index; a literal argument must be separated.
        if (n.glued) return false;
        break;
      case T.Minus:
        // `a - b` is subtraction; `f -1` is not written in canonical Halka.
        return false;
      default:
        return false;
    }
    // A following keyword only starts an argument if it can begin an expression.
    if (n.kind === T.Keyword && !CAN_START_EXPR_KW.has(n.text)) return false;
    // `x and y`, `a is null`, `n if n > 1` are operators, not commands.
    if (n.kind === T.Keyword && BIN_PREC[n.text] !== undefined) return false;
    return true;
  }

  private parseCommandCallStmt(): A.Stmt {
    const nameTok = this.next();
    const callee: A.Ident = { kind: "Ident", span: nameTok.span, name: nameTok.text };
    const args: A.Arg[] = [];
    const first = this.parseExpr(0);
    args.push({ value: first, span: first.span });
    // `add counter : 1`  →  add(counter, 1)
    if (this.eat(T.Colon)) {
      const v = this.parseValueExpr();
      args.push({ value: v, span: v.span });
    } else {
      while (this.is(T.Comma) && !this.is(T.Newline, 1)) {
        this.next();
        const e = this.parseExpr(0);
        args.push({ value: e, span: e.span });
      }
    }
    const call: A.CallExpr = { kind: "CallExpr", span: this.sp(nameTok), callee, args, typeArgs: [], command: true };
    this.endStmt();
    return { kind: "ExprStmt", span: call.span, expr: call };
  }

  // =======================================================================
  // Declarations
  // =======================================================================

  /** R6: `ident ( ... ) [: Type] [requires ...] [,] NEWLINE INDENT`. */
  private looksLikeFnDecl(start: number): boolean {
    let i = start;
    if (this.toks[i]?.kind !== T.Ident) return false;
    i++;
    const afterGenerics = this.scanGenerics(i);
    if (afterGenerics !== -1) i = afterGenerics;
    if (this.toks[i]?.kind !== T.LParen) return false;
    i = this.skipBalanced(i);
    if (i === -1) return false;
    // scan to end of line
    let depth = 0;
    while (i < this.toks.length) {
      const k = this.toks[i]!.kind;
      if (k === T.LParen || k === T.LBracket || k === T.LBrace) depth++;
      else if (k === T.RParen || k === T.RBracket || k === T.RBrace) depth--;
      else if (k === T.Newline && depth <= 0) break;
      else if (k === T.Eof) return false;
      i++;
    }
    return this.toks[i + 1]?.kind === T.Indent;
  }

  /** If tokens[i] opens a balanced `< ... >` followed by `(`, return the index after `>`. */
  private scanGenerics(i: number): number {
    if (this.toks[i]?.kind !== T.Lt) return -1;
    let depth = 0;
    let j = i;
    while (j < this.toks.length) {
      const k = this.toks[j]!.kind;
      if (k === T.Lt) depth++;
      else if (k === T.Gt) {
        depth--;
        if (depth === 0) return j + 1;
      } else if (k === T.Newline || k === T.Eof || k === T.Comma && depth === 0) return -1;
      j++;
    }
    return -1;
  }

  /** Given index of an opening bracket, return the index just past its match, or -1. */
  private skipBalanced(i: number): number {
    const open = this.toks[i]!.kind;
    const close = open === T.LParen ? T.RParen : open === T.LBracket ? T.RBracket : T.RBrace;
    let depth = 0;
    let j = i;
    while (j < this.toks.length) {
      const k = this.toks[j]!.kind;
      if (k === open) depth++;
      else if (k === close) {
        depth--;
        if (depth === 0) return j + 1;
      } else if (k === T.Eof) return -1;
      j++;
    }
    return -1;
  }

  private parseFnDecl(opts: { isMacro?: boolean; isCompile?: boolean; isCallback?: boolean; isKernel?: boolean; isDevice?: boolean; foreign?: A.ForeignLang; signatureOk?: boolean }): A.FnDecl {
    const nameTok = this.expect(T.Ident, "a function name");
    const generics = this.parseGenericParams();
    const params = this.parseParamList();
    let retType: A.TypeNode | undefined;
    if (this.is(T.Colon) && !this.is(T.Newline, 1)) {
      this.next();
      retType = this.parseType();
    }
    const requires: string[] = [];
    if (this.eatKw("requires")) {
      for (;;) {
        const c = this.parseCapabilityPath();
        if (c) requires.push(c);
        if (this.is(T.Comma) && !this.is(T.Newline, 1)) { this.next(); continue; }
        break;
      }
    }
    let body: A.Block | undefined;
    let isSignature = false;
    if (this.is(T.Comma) || this.is(T.Colon) || this.is(T.Newline)) {
      const save = this.p;
      this.eat(T.Comma);
      if (this.is(T.Newline) && this.is(T.Indent, 1)) {
        this.p = save;
        body = this.parseSuite();
      } else {
        this.p = save;
        isSignature = true;
        this.endStmt();
      }
    } else {
      isSignature = true;
      this.endStmt();
    }
    if (isSignature && !opts.signatureOk) {
      this.error("E0112", `\`${nameTok.text}\` has no body`, nameTok.span, {
        rule: "#53 — Canonical style",
        help: "a function body is an indented block under `name(params),`",
      });
    }
    return {
      kind: "FnDecl", span: this.sp(nameTok), name: nameTok.text, generics, params, retType, body,
      isMacro: !!opts.isMacro, isCompile: !!opts.isCompile, isCallback: !!opts.isCallback,
      isKernel: !!opts.isKernel, isDevice: !!opts.isDevice, requires, isSignature, foreign: opts.foreign,
    };
  }

  /** True when the bracketed list at `i` reads as a parameter list (R19). */
  private foreignLooksLikeSignature(i: number): boolean {
    if (this.toks[i]?.kind !== T.LParen) return false;
    let j = i + 1;
    if (this.toks[j]?.kind === T.RParen) return false; // `f()` is a call
    for (;;) {
      if (this.toks[j]?.kind === T.Ellipsis) {
        j++;
      } else {
        if (this.toks[j]?.kind !== T.Ident) return false;
        if (this.toks[j + 1]?.kind !== T.Colon) return false;
        const e = this.scanType(j + 2);
        if (e === -1) return false;
        j = e;
      }
      if (this.toks[j]?.kind === T.Comma) { j++; continue; }
      break;
    }
    return this.toks[j]?.kind === T.RParen;
  }

  private parseCapabilityPath(): string | null {
    if (!this.is(T.Ident)) {
      this.error("E0113", "expected a capability name", this.cur().span, { rule: "#45 — Capability / security syntax" });
      return null;
    }
    let name = this.next().text;
    while (this.is(T.Dot) && (this.is(T.Ident, 1) || this.is(T.Keyword, 1))) {
      this.next();
      name += "." + this.next().text;
    }
    return name;
  }

  private parseGenericParams(): A.GenericParam[] {
    const out: A.GenericParam[] = [];
    if (!this.is(T.Lt)) return out;
    this.next();
    while (!this.is(T.Gt) && !this.is(T.Eof) && !this.is(T.Newline)) {
      const t = this.expect(T.Ident, "a type parameter name");
      const bounds: string[] = [];
      if (this.eat(T.Colon)) {
        for (;;) {
          const b = this.expect(T.Ident, "a trait bound");
          bounds.push(b.text);
          if (this.is(T.Plus)) { this.next(); continue; }
          break;
        }
      }
      out.push({ name: t.text, bounds, span: t.span });
      if (!this.eat(T.Comma)) break;
    }
    this.expect(T.Gt, "`>`");
    return out;
  }

  private parseParamList(): A.Param[] {
    const out: A.Param[] = [];
    this.expect(T.LParen, "`(`");
    while (!this.is(T.RParen) && !this.is(T.Eof)) {
      const start = this.cur();
      let variadic = false;
      if (this.eat(T.Ellipsis)) {
        variadic = true;
        // A bare trailing `...` is the C variadic marker (#35): `c printf(fmt: string, ...)`.
        if (this.is(T.RParen)) {
          out.push({ name: "...", type: undefined, default: undefined, variadic: true, span: this.sp(start) });
          break;
        }
      }
      const nameTok = this.cur();
      if (nameTok.kind !== T.Ident && nameTok.kind !== T.Underscore) {
        this.error("E0114", `expected a parameter name, found ${tokenDesc(nameTok)}`, nameTok.span);
        while (!this.is(T.RParen) && !this.is(T.Comma) && !this.is(T.Eof)) this.p++;
        this.eat(T.Comma);
        continue;
      }
      this.next();
      let type: A.TypeNode | undefined;
      let def: A.Expr | undefined;
      if (this.eat(T.Colon)) {
        if (this.eat(T.Ellipsis)) variadic = true; // `values: ...int` (#19)
        if (this.looksLikeTypeThenColon()) {
          type = this.parseType();
          this.expect(T.Colon, "`:` before the default value");
          def = this.parseValueExpr();
        } else if (this.looksLikeBareType()) {
          type = this.parseType();
        } else {
          def = this.parseValueExpr(); // `greet(name: "HALKA")` — inferred default (#18)
        }
      }
      out.push({ name: nameTok.text, type, default: def, variadic, span: this.sp(start) });
      if (!this.eat(T.Comma)) break;
    }
    this.expect(T.RParen, "`)`");
    return out;
  }

  /** `macro f(...)`, `compile f(...)`, `kernel f(...)`, `callback f(...)`, `device f(...)`. */
  private parseMarkedDecl(): A.Stmt {
    const kw = this.next();
    const flag = kw.text;
    if (flag === "device" && !this.is(T.Ident)) {
      // `device: gpu(0)` / `data: device [...]` handled elsewhere; here: `device: ...`
      this.p--;
      return this.parseExprOrAssign();
    }
    if (flag === "compile" && !this.looksLikeFnDecl(this.p)) {
      this.p--;
      return this.parseExprOrAssign();
    }
    const decl = this.parseFnDecl({
      isMacro: flag === "macro",
      isCompile: flag === "compile",
      isCallback: flag === "callback",
      isKernel: flag === "kernel",
      isDevice: flag === "device",
    });
    decl.span = this.sp(kw);
    return decl;
  }

  private parseStructDecl(): A.Stmt {
    const nameTok = this.next();
    const generics = this.parseGenericParams();
    this.expect(T.Colon, "`:`");
    this.expect(T.Newline, "end of line");
    this.expect(T.Indent, "an indented block of fields");
    const fields: A.FieldDecl[] = [];
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      const f = this.cur();
      if (f.kind !== T.Ident) {
        this.error("E0115", `expected a field name, found ${tokenDesc(f)}`, f.span);
        while (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
        continue;
      }
      this.next();
      let type: A.TypeNode | undefined;
      let def: A.Expr | undefined;
      if (this.eat(T.Colon)) {
        if (this.looksLikeTypeThenColon()) {
          type = this.parseType();
          this.expect(T.Colon, "`:`");
          def = this.parseValueExpr();
        } else if (this.looksLikeBareType()) type = this.parseType();
        else def = this.parseValueExpr();
      }
      fields.push({ name: f.text, type, default: def, span: this.sp(f) });
      this.endStmt();
    }
    this.eat(T.Dedent);
    return { kind: "StructDecl", span: this.sp(nameTok), name: nameTok.text, generics, fields };
  }

  private parseImpl(): A.Stmt {
    const nameTok = this.next();
    this.next(); // implements
    const traits: string[] = [];
    for (;;) {
      const t = this.expect(T.Ident, "a trait name");
      traits.push(t.text);
      if (this.is(T.Comma) && !this.is(T.Newline, 1)) { this.next(); continue; }
      break;
    }
    this.eat(T.Comma);
    this.expect(T.Colon, "`:`");
    const members = this.parseMemberBlock();
    return { kind: "ImplDecl", span: this.sp(nameTok), typeName: nameTok.text, traits, members };
  }

  private parseTrait(): A.Stmt {
    const kw = this.next();
    const nameTok = this.expect(T.Ident, "a trait name");
    const generics = this.parseGenericParams();
    this.eat(T.Comma);
    this.eat(T.Colon);
    const members = this.parseMemberBlock(true);
    return { kind: "TraitDecl", span: this.sp(kw), name: nameTok.text, generics, members };
  }

  private parseMemberBlock(signatureOk = false): A.FnDecl[] {
    this.expect(T.Newline, "end of line");
    if (!this.is(T.Indent)) {
      this.error("E0116", "expected an indented block of members", this.cur().span);
      return [];
    }
    this.next();
    const members: A.FnDecl[] = [];
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      if (!this.is(T.Ident)) {
        this.error("E0117", `expected a member, found ${tokenDesc(this.cur())}`, this.cur().span);
        while (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
        continue;
      }
      members.push(this.parseFnDecl({ signatureOk }));
      this.eat(T.Comma);
    }
    this.eat(T.Dedent);
    return members;
  }

  private parseEnum(): A.Stmt {
    const kw = this.next();
    const nameTok = this.expect(T.Ident, "an enum name");
    const generics = this.parseGenericParams();
    this.eat(T.Comma);
    this.eat(T.Colon); // R14: `enum X`, `enum X:` and `enum X,` are one parse
    this.expect(T.Newline, "end of line");
    const variants: A.EnumVariant[] = [];
    if (!this.is(T.Indent)) {
      this.error("E0118", "expected indented enum variants", this.cur().span, { rule: "#22 — Result model" });
      return { kind: "EnumDecl", span: this.sp(kw), name: nameTok.text, generics, variants };
    }
    this.next();
    while (!this.is(T.Dedent) && !this.is(T.Eof)) {
      if (this.eat(T.Newline)) continue;
      const v = this.cur();
      if (v.kind !== T.Ident) {
        this.error("E0119", `expected a variant name, found ${tokenDesc(v)}`, v.span);
        while (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
        continue;
      }
      this.next();
      const fields = this.is(T.LParen) ? this.parseParamList() : [];
      variants.push({ name: v.text, fields, span: this.sp(v) });
      this.endStmt();
    }
    this.eat(T.Dedent);
    return { kind: "EnumDecl", span: this.sp(kw), name: nameTok.text, generics, variants };
  }

  private parseTypeAlias(): A.Stmt {
    const kw = this.next();
    const nameTok = this.expect(T.Ident, "a type name");
    const generics = this.parseGenericParams();
    this.expect(T.Colon, "`:`");
    const type = this.parseType();
    this.endStmt();
    return { kind: "TypeAliasDecl", span: this.sp(kw), name: nameTok.text, generics, type };
  }

  private parseCapability(): A.Stmt {
    const kw = this.next();
    const nameTok = this.expect(T.Ident, "a capability name");
    this.eat(T.Colon);
    this.expect(T.Newline, "end of line");
    const perms: string[] = [];
    if (this.is(T.Indent)) {
      this.next();
      while (!this.is(T.Dedent) && !this.is(T.Eof)) {
        if (this.eat(T.Newline)) continue;
        const t = this.cur();
        if (t.kind !== T.Ident && t.kind !== T.Keyword) {
          this.error("E0120", `expected a permission name, found ${tokenDesc(t)}`, t.span);
          this.p++;
          continue;
        }
        this.next();
        perms.push(t.text);
        this.endStmt();
      }
      this.eat(T.Dedent);
    }
    return { kind: "CapabilityDecl", span: this.sp(kw), name: nameTok.text, perms };
  }

  // ---- modules ----------------------------------------------------------

  private parseImport(): A.Stmt {
    const kw = this.next();
    let foreign: A.ForeignLang | undefined;
    if (this.foreignAt()) foreign = this.next().text as A.ForeignLang;
    const { path, alias } = this.parseModulePath();
    this.endStmt();
    return { kind: "ImportDecl", span: this.sp(kw), form: "module", foreign, path, names: [], alias };
  }

  private parseFromImport(): A.Stmt {
    const kw = this.next();
    let foreign: A.ForeignLang | undefined;
    if (this.foreignAt()) foreign = this.next().text as A.ForeignLang;
    const { path } = this.parseModulePath(false);
    if (!this.eatKw("import")) {
      this.error("E0121", "expected `import` after the module path", this.cur().span, {
        rule: "#33 — Import / export details",
        help: "write `from math import sqrt`",
      });
    }
    const names: { name: string; alias?: string }[] = [];
    for (;;) {
      if (!this.is(T.Ident)) break;
      const n = this.next().text;
      let alias: string | undefined;
      if (this.is(T.Colon) && this.is(T.Ident, 1)) { this.next(); alias = this.next().text; }
      names.push({ name: n, alias });
      if (this.is(T.Comma) && !this.is(T.Newline, 1)) { this.next(); continue; }
      break;
    }
    this.endStmt();
    return { kind: "ImportDecl", span: this.sp(kw), form: "from", foreign, path, names };
  }

  private parseModulePath(allowAlias = true): { path: string; alias?: string } {
    if (this.is(T.Str)) {
      const t = this.next();
      const path = t.parts?.map((p) => p.value).join("") ?? "";
      let alias: string | undefined;
      if (allowAlias && this.is(T.Colon) && this.is(T.Ident, 1)) { this.next(); alias = this.next().text; }
      return { path, alias };
    }
    let path = "";
    if (this.is(T.Ident) || this.is(T.Keyword)) path = this.next().text;
    else this.error("E0122", "expected a module name", this.cur().span);
    while (this.is(T.Dot) && (this.is(T.Ident, 1) || this.is(T.Keyword, 1))) {
      this.next();
      path += "." + this.next().text;
    }
    let alias: string | undefined;
    if (allowAlias && this.is(T.Colon) && (this.is(T.Ident, 1) || this.is(T.Keyword, 1))) {
      this.next();
      alias = this.next().text;
    }
    return { path, alias };
  }

  private parseExport(): A.Stmt {
    const kw = this.next();
    const names: string[] = [];
    if (this.is(T.Colon)) {
      this.next();
      this.expect(T.Newline, "end of line");
      if (this.is(T.Indent)) {
        this.next();
        while (!this.is(T.Dedent) && !this.is(T.Eof)) {
          if (this.eat(T.Newline)) continue;
          if (!this.is(T.Ident)) { this.p++; continue; }
          names.push(this.next().text);
          this.endStmt();
        }
        this.eat(T.Dedent);
      }
      return { kind: "ExportDecl", span: this.sp(kw), names };
    }
    for (;;) {
      if (!this.is(T.Ident)) break;
      names.push(this.next().text);
      if (this.is(T.Comma) && !this.is(T.Newline, 1)) { this.next(); continue; }
      break;
    }
    this.endStmt();
    return { kind: "ExportDecl", span: this.sp(kw), names };
  }

  // ---- compile-time tier -------------------------------------------------

  private parseGenerate(): A.Stmt {
    const kw = this.next();
    let target: string | undefined;
    let lang: A.ForeignLang | undefined;
    if (this.foreignAt()) lang = this.next().text as A.ForeignLang;
    else if (this.is(T.Ident)) target = this.next().text;
    this.expect(T.Colon, "`:`");
    const body = this.parseSuite();
    return { kind: "GenerateDecl", span: this.sp(kw), target, lang, body };
  }

  private parseSpecialize(): A.Stmt {
    const kw = this.next();
    const items: A.SpecializeDecl["items"] = [];
    const one = () => {
      const n = this.expect(T.Ident, "a function name");
      const typeArgs: A.TypeNode[] = [];
      if (this.eat(T.Lt)) {
        while (!this.is(T.Gt) && !this.is(T.Eof) && !this.is(T.Newline)) {
          typeArgs.push(this.parseType());
          if (!this.eat(T.Comma)) break;
        }
        this.expect(T.Gt, "`>`");
      }
      items.push({ name: n.text, typeArgs, span: this.sp(n) });
    };
    if (this.eat(T.Colon)) {
      this.expect(T.Newline, "end of line");
      if (this.is(T.Indent)) {
        this.next();
        while (!this.is(T.Dedent) && !this.is(T.Eof)) {
          if (this.eat(T.Newline)) continue;
          one();
          this.endStmt();
        }
        this.eat(T.Dedent);
      }
    } else {
      one();
      this.endStmt();
    }
    return { kind: "SpecializeDecl", span: this.sp(kw), items };
  }

  private parseExtern(): A.Stmt {
    const kw = this.next();
    if (this.eat(T.Colon)) {
      const rec = this.parseRecordBlock();
      const abi: Record<string, string> = {};
      for (const e of rec.entries) {
        const v = e.value;
        abi[e.key] = v.kind === "StrLit" ? v.parts.map((p) => p.text ?? "").join("")
          : v.kind === "Ident" ? v.name : String((v as { value?: unknown }).value ?? "");
      }
      return { kind: "ExternDecl", span: this.sp(kw), abi };
    }
    let lang: A.ForeignLang | undefined;
    if (this.foreignAt()) lang = this.next().text as A.ForeignLang;
    let name: string | undefined;
    if (this.is(T.Ident)) name = this.next().text;
    this.endStmt();
    return { kind: "ExternDecl", span: this.sp(kw), lang, name };
  }

  /** Statements led by a `c` / `cpp` / `py` boundary marker (R19, #35–#37). */
  private parseForeignStmt(): A.Stmt {
    const kw = this.next();
    const lang = kw.text as A.ForeignLang;

    if (this.is(T.Ident) && (this.cur().text === "struct" || this.cur().text === "class")) {
      this.next();
      const decl = this.parseStructDecl() as A.StructDecl;
      decl.foreign = lang;
      decl.span = this.sp(kw);
      return decl;
    }
    if (this.looksLikeFnDecl(this.p)) {
      const d = this.parseFnDecl({ foreign: lang, signatureOk: true });
      d.span = this.sp(kw);
      return d;
    }
    // A foreign *signature* declares an external function; its arguments are all
    // `name : Type` (or `...`). Anything else is a foreign *call* (R19).
    if (this.is(T.Ident) && this.is(T.LParen, 1) && this.foreignLooksLikeSignature(this.p + 1)) {
      const d = this.parseFnDecl({ foreign: lang, signatureOk: true });
      d.span = this.sp(kw);
      return d;
    }

    // `c printf("...")` / `py library.register(handler)` — a foreign call statement.
    const inner = this.parseExpr(0);
    const expr: A.ForeignExpr = { kind: "ForeignExpr", span: this.sp(kw), lang, expr: inner };
    if (this.is(T.Colon)) {
      this.next();
      const { type, value } = this.parseAscriptionTail();
      this.endStmt();
      return { kind: "AssignStmt", span: this.sp(kw), target: expr, type, value: value ?? { kind: "NullLit", span: expr.span } };
    }
    this.endStmt();
    return { kind: "ExprStmt", span: expr.span, expr };
  }

  // =======================================================================
  // Types (R2)
  // =======================================================================

  /** Heuristic-free check: is the upcoming run of tokens a type followed by `:`? */
  private looksLikeTypeThenColon(): boolean {
    const end = this.scanType(this.p);
    return end !== -1 && this.toks[end]?.kind === T.Colon;
  }

  /** Is the upcoming run of tokens a type that ends the construct? */
  private looksLikeBareType(): boolean {
    const end = this.scanType(this.p);
    if (end === -1) return false;
    const k = this.toks[end]!.kind;
    return k === T.Newline || k === T.Comma || k === T.RParen || k === T.Eof || k === T.Dedent;
  }

  /** Bounded scan: return the index just past a type starting at `i`, or -1. */
  private scanType(i: number): number {
    const t = this.toks[i];
    if (!t) return -1;

    if (t.kind === T.Ident && (t.text === "c" || t.text === "cpp" || t.text === "py") && this.toks[i + 1]?.kind === T.Ident) {
      return this.scanType(i + 1);
    }
    if (t.kind === T.Keyword && t.text === "raw") {
      let j = i + 1;
      if (this.toks[j]?.kind === T.Star) j++;
      if (this.toks[j]?.kind === T.Keyword && this.toks[j]!.text === "mut") j++;
      return this.scanType(j);
    }
    if (t.kind === T.Amp) {
      let j = i + 1;
      if (this.toks[j]?.kind === T.Keyword && this.toks[j]!.text === "mut") j++;
      return this.scanType(j);
    }
    if (t.kind === T.LParen) {
      // A parenthesised type must contain types, so `(10, 20)` is a value, not a type.
      let j = i + 1;
      if (this.toks[j]?.kind === T.RParen) j++;
      else {
        for (;;) {
          const e = this.scanType(j);
          if (e === -1) return -1;
          j = e;
          if (this.toks[j]?.kind === T.Comma) { j++; continue; }
          break;
        }
        if (this.toks[j]?.kind !== T.RParen) return -1;
        j++;
      }
      while (this.toks[j]?.kind === T.Question) j++;
      return j;
    }
    if (t.kind !== T.Ident) return -1;
    if (!isTypeName(t.text) && !PRIMITIVE_TYPES.has(t.text) && !TYPE_CTORS.has(t.text)) return -1;

    let j = i + 1;
    if (this.toks[j]?.kind === T.Lt) {
      const after = this.scanAngles(j);
      if (after === -1) return -1;
      j = after;
    } else if (this.toks[j]?.kind === T.LParen && TYPE_CTORS.has(t.text)) {
      const after = this.skipBalanced(j);
      if (after === -1) return -1;
      j = after;
    }
    while (this.toks[j]?.kind === T.Question) j++;
    return j;
  }

  private scanAngles(i: number): number {
    let depth = 0;
    let j = i;
    while (j < this.toks.length) {
      const k = this.toks[j]!.kind;
      if (k === T.Lt) depth++;
      else if (k === T.Gt) { depth--; if (depth === 0) return j + 1; }
      else if (k === T.Newline || k === T.Eof) return -1;
      j++;
    }
    return -1;
  }

  parseType(): A.TypeNode {
    const start = this.cur();

    if (this.foreignAt() && this.at(1).kind === T.Ident) {
      const lang = this.next().text as A.ForeignLang;
      const inner = this.parseType();
      return { kind: "ForeignType", span: this.sp(start), lang, inner };
    }
    if (this.isKw("raw")) {
      this.next();
      this.eat(T.Star);
      const mut = this.eatKw("mut");
      const inner = this.parseType();
      return { kind: "RawPtrType", span: this.sp(start), inner, mut };
    }
    if (this.is(T.Amp)) {
      this.next();
      const mut = this.eatKw("mut");
      const inner = this.parseType();
      return { kind: "RefType", span: this.sp(start), inner, mut };
    }
    if (this.is(T.LParen)) {
      this.next();
      const elements: A.TypeNode[] = [];
      while (!this.is(T.RParen) && !this.is(T.Eof)) {
        elements.push(this.parseType());
        if (!this.eat(T.Comma)) break;
      }
      this.expect(T.RParen, "`)`");
      let node: A.TypeNode = elements.length === 1 ? elements[0]! : { kind: "TupleType", span: this.sp(start), elements };
      while (this.eat(T.Question)) node = { kind: "OptionalType", span: this.sp(start), inner: node };
      return node;
    }

    const nameTok = this.cur();
    if (nameTok.kind !== T.Ident) {
      this.error("E0123", `expected a type, found ${tokenDesc(nameTok)}`, nameTok.span, { rule: "R2 — type position" });
      return { kind: "InferType", span: nameTok.span };
    }
    this.next();
    const args: A.TypeNode[] = [];
    if (this.is(T.Lt) && this.scanAngles(this.p) !== -1) {
      this.next();
      while (!this.is(T.Gt) && !this.is(T.Eof)) {
        args.push(this.parseType());
        if (!this.eat(T.Comma)) break;
      }
      this.expect(T.Gt, "`>`");
    } else if (this.is(T.LParen) && TYPE_CTORS.has(nameTok.text)) {
      this.next();
      while (!this.is(T.RParen) && !this.is(T.Eof)) {
        args.push(this.parseType());
        if (!this.eat(T.Comma)) break;
      }
      this.expect(T.RParen, "`)`");
    }
    let node: A.TypeNode = { kind: "NamedType", span: this.sp(nameTok), name: nameTok.text, args };
    while (this.eat(T.Question)) node = { kind: "OptionalType", span: this.sp(nameTok), inner: node };
    return node;
  }

  // =======================================================================
  // Patterns (#4, #10)
  // =======================================================================

  parsePattern(): A.Pattern {
    const start = this.cur();

    if (this.is(T.Underscore)) { this.next(); return { kind: "WildcardPat", span: start.span }; }
    if (this.is(T.Ellipsis)) {
      this.next();
      const name = this.is(T.Ident) ? this.next().text : undefined;
      return { kind: "RestPat", span: this.sp(start), name };
    }
    if (this.isKw("null")) { this.next(); return { kind: "NullPat", span: start.span }; }

    if (this.is(T.LParen)) {
      this.next();
      const elements: A.Pattern[] = [];
      while (!this.is(T.RParen) && !this.is(T.Eof)) {
        elements.push(this.parsePattern());
        if (!this.eat(T.Comma)) break;
      }
      this.expect(T.RParen, "`)`");
      if (elements.length === 1) return elements[0]!;
      return { kind: "TuplePat", span: this.sp(start), elements };
    }

    if (this.is(T.LBracket)) {
      this.next();
      const elements: A.Pattern[] = [];
      while (!this.is(T.RBracket) && !this.is(T.Eof)) {
        elements.push(this.parsePattern());
        if (!this.eat(T.Comma)) break;
      }
      this.expect(T.RBracket, "`]`");
      return { kind: "ListPat", span: this.sp(start), elements };
    }

    if (this.is(T.Ident)) {
      const nameTok = this.next();
      if (this.is(T.LParen)) {
        this.next();
        const args: A.Pattern[] = [];
        while (!this.is(T.RParen) && !this.is(T.Eof)) {
          args.push(this.parsePattern());
          if (!this.eat(T.Comma)) break;
        }
        this.expect(T.RParen, "`)`");
        return { kind: "VariantPat", span: this.sp(nameTok), name: nameTok.text, args };
      }
      if (this.is(T.LBrace)) {
        this.next();
        const fields: { name: string; pattern: A.Pattern }[] = [];
        while (!this.is(T.RBrace) && !this.is(T.Eof)) {
          const f = this.expect(T.Ident, "a field name");
          let pat: A.Pattern = { kind: "BindPat", span: f.span, name: f.text };
          if (this.eat(T.Colon)) pat = this.parsePattern();
          fields.push({ name: f.text, pattern: pat });
          if (!this.eat(T.Comma)) break;
        }
        this.expect(T.RBrace, "`}`");
        return { kind: "StructPat", span: this.sp(nameTok), name: nameTok.text, fields };
      }
      if (isTypeName(nameTok.text) || PRIMITIVE_TYPES.has(nameTok.text)) {
        return { kind: "TypePat", span: nameTok.span, name: nameTok.text };
      }
      let type: A.TypeNode | undefined;
      return { kind: "BindPat", span: nameTok.span, name: nameTok.text, type };
    }

    // Literal patterns.
    const e = this.parseUnary();
    return { kind: "LiteralPat", span: this.sp(start), value: e };
  }

  // =======================================================================
  // Expressions (R8)
  // =======================================================================

  /**
   * The value position after a binding `:`. Identical to `parseExpr` except
   * that a bare `ident arg` is read as a command call (R7).
   */
  private parseValueExpr(): A.Expr {
    if (this.foreignAt() && this.canStartExpr2(1)) return this.parseExpr(0);
    if (this.isCommandCallStart()) {
      const nameTok = this.next();
      const callee: A.Ident = { kind: "Ident", span: nameTok.span, name: nameTok.text };
      const args: A.Arg[] = [];
      const first = this.parseExpr(0);
      args.push({ value: first, span: first.span });
      if (this.is(T.Colon) && !this.is(T.Newline, 1)) {
        this.next();
        const v = this.parseExpr(0);
        args.push({ value: v, span: v.span });
      }
      return { kind: "CallExpr", span: this.sp(nameTok), callee, args, typeArgs: [], command: true };
    }
    return this.parseExpr(0);
  }

  parseExpr(minPrec: number): A.Expr {
    let lhs = this.parseRange();
    for (;;) {
      const t = this.cur();
      const op = t.kind === T.Keyword ? t.text : opText(t.kind);
      if (op === undefined) break;
      const prec = BIN_PREC[op];
      if (prec === undefined || prec < minPrec) break;

      if (op === "is") {
        this.next();
        const test = this.parseIsTest();
        lhs = { kind: "IsExpr", span: this.sp(lhs.span), expr: lhs, test };
        continue;
      }
      this.next();
      const rhs = this.parseExpr(prec + 1);
      lhs = { kind: "BinaryExpr", span: spanOf(lhs.span, rhs.span), op: op as A.BinaryOp, lhs, rhs };
    }
    return lhs;
  }

  private parseIsTest(): string {
    const t = this.cur();
    if (t.kind === T.Keyword && STATE_TESTS.has(t.text)) { this.next(); return t.text; }
    if (t.kind === T.Ident) { this.next(); return t.text; }
    this.error("E0231", `\`is\` expects a state or type, found ${tokenDesc(t)}`, t.span, {
      rule: "R10",
      help: "valid right-hand sides: null, error, ok, cancelled, a type name, or a variant name",
    });
    return "null";
  }

  /** Level 3: ranges. */
  private parseRange(): A.Expr {
    // `range a..b step n` (#54)
    if (this.is(T.Ident) && this.cur().text === "range" && !this.is(T.LParen, 1)) {
      const kw = this.next();
      const inner = this.parseRange();
      let step: A.Expr | undefined;
      if (this.eatKw("step")) step = this.parseRange();
      if (inner.kind === "RangeExpr") {
        inner.step = step;
        inner.span = this.sp(kw);
        return inner;
      }
      return { kind: "RangeExpr", span: this.sp(kw), lo: inner, hi: undefined, inclusive: false, step };
    }

    const start = this.cur();
    if (this.is(T.DotDot) || this.is(T.DotDotEq)) {
      const inclusive = this.is(T.DotDotEq);
      this.next();
      const hi = this.parseNot();
      return { kind: "RangeExpr", span: this.sp(start), hi, inclusive };
    }

    const lo = this.parseNot();
    if (this.is(T.DotDot) || this.is(T.DotDotEq)) {
      const inclusive = this.is(T.DotDotEq);
      this.next();
      let hi: A.Expr | undefined;
      if (this.canStartExpr()) hi = this.parseNot();
      let step: A.Expr | undefined;
      if (this.isKw("step")) { this.next(); step = this.parseNot(); }
      return { kind: "RangeExpr", span: this.sp(start), lo, hi, inclusive, step };
    }
    return lo;
  }

  /** `not` sits between comparison and `and` (R8). */
  private parseNot(): A.Expr {
    if (this.isKw("not")) {
      const kw = this.next();
      const operand = this.parseExpr(2); // binds looser than comparison
      return { kind: "UnaryExpr", span: this.sp(kw), op: "not", operand };
    }
    return this.parseConversion();
  }

  /** Level 4: `as` / `to` (#15). */
  private parseConversion(): A.Expr {
    let e = this.parseAdditive();
    for (;;) {
      if (this.isKw("as")) {
        this.next();
        const type = this.parseType();
        e = { kind: "CastExpr", span: spanOf(e.span, type.span), expr: e, type, fallible: false };
      } else if (this.isKw("to")) {
        this.next();
        const type = this.parseType();
        e = { kind: "CastExpr", span: spanOf(e.span, type.span), expr: e, type, fallible: true };
      } else break;
    }
    return e;
  }

  private parseAdditive(): A.Expr {
    let lhs = this.parseMultiplicative();
    while (this.is(T.Plus) || this.is(T.Minus)) {
      const op = this.next().text as A.BinaryOp;
      const rhs = this.parseMultiplicative();
      lhs = { kind: "BinaryExpr", span: spanOf(lhs.span, rhs.span), op, lhs, rhs };
    }
    return lhs;
  }

  private parseMultiplicative(): A.Expr {
    let lhs = this.parseUnary();
    while (this.is(T.Star) || this.is(T.Slash) || this.is(T.Percent)) {
      const op = this.next().text as A.BinaryOp;
      const rhs = this.parseUnary();
      lhs = { kind: "BinaryExpr", span: spanOf(lhs.span, rhs.span), op, lhs, rhs };
    }
    return lhs;
  }

  /** Level 3: unary and the keyword-prefixed value forms. */
  private parseUnary(): A.Expr {
    const t = this.cur();

    if (t.kind === T.Minus || t.kind === T.Plus) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "UnaryExpr", span: this.sp(t), op: t.text as A.UnaryOp, operand };
    }
    if (t.kind === T.Star) {
      this.next();
      const operand = this.parseUnary();
      return { kind: "DerefExpr", span: this.sp(t), expr: operand };
    }
    if (t.kind === T.Amp) {
      this.next();
      const mut = this.eatKw("mut");
      const operand = this.parseUnary();
      return { kind: "RefExpr", span: this.sp(t), expr: operand, mut };
    }

    if (t.kind === T.Keyword) {
      switch (t.text) {
        case "not": {
          this.next();
          const operand = this.parseExpr(2);
          return { kind: "UnaryExpr", span: this.sp(t), op: "not", operand };
        }
        case "borrow": {
          this.next();
          const mut = this.eatKw("mut");
          const e = this.parseUnary();
          return { kind: "BorrowExpr", span: this.sp(t), expr: e, mut };
        }
        case "move": { this.next(); return { kind: "MoveExpr", span: this.sp(t), expr: this.parseUnary() }; }
        case "raw": {
          this.next();
          if (this.is(T.Star) || this.is(T.Ident)) {
            // `raw *int` in a value slot is a null raw pointer of that type.
            const save = this.p;
            const end = this.scanType(save - 1);
            if (end !== -1) {
              this.p = save - 1;
              const ty = this.parseType();
              return { kind: "RawExpr", span: this.sp(t), expr: { kind: "NullLit", span: ty.span } };
            }
            this.p = save;
          }
          return { kind: "RawExpr", span: this.sp(t), expr: this.parseUnary() };
        }
        case "start": { this.next(); return { kind: "StartExpr", span: this.sp(t), call: this.parseUnary() }; }
        case "await": { this.next(); return { kind: "AwaitExpr", span: this.sp(t), expr: this.parseUnary() }; }
        case "receive": { this.next(); return { kind: "ReceiveExpr", span: this.sp(t), channel: this.parseUnary() }; }
        case "load": { this.next(); return { kind: "LoadExpr", span: this.sp(t), target: this.parseUnary() }; }
        case "reflect": { this.next(); return { kind: "ReflectExpr", span: this.sp(t), target: this.parseUnary() }; }
        case "compile": { this.next(); return { kind: "CompileExpr", span: this.sp(t), expr: this.parseUnary() }; }
        case "cancelled": { this.next(); return { kind: "CancelledExpr", span: this.sp(t) }; }
        case "make": return this.parseMake();
        case "atomic": return this.parseAtomic();
        case "launch": return this.parseLaunch();
        case "device": { this.next(); return { kind: "DeviceExpr", span: this.sp(t), expr: this.parseUnary() }; }
        case "match": return this.parseMatch();
      }
    }

    // `c malloc(100)` / `cpp Point(10, 20)` — a boundary marker only when an operand
    // follows; otherwise `c` is an ordinary name (`abi: c`, `(a + b) * c`).
    {
      const lang = this.foreignAt();
      if (lang && this.canStartExpr2(1)) {
        this.next();
        const inner = this.parseUnary();
        return { kind: "ForeignExpr", span: this.sp(t), lang, expr: inner };
      }
    }

    // `apply 5 : operation` (#17)
    if (t.kind === T.Ident && t.text === "apply" && !this.is(T.LParen, 1)) {
      this.next();
      const value = this.parseExpr(1);
      this.expect(T.Colon, "`:` before the function");
      const fn = this.parseExpr(1);
      return { kind: "ApplyExpr", span: this.sp(t), value, fn };
    }
    // `acquire FileAccess` (#45)
    if (t.kind === T.Ident && t.text === "acquire" && this.is(T.Ident, 1)) {
      this.next();
      const cap = this.next();
      return { kind: "AcquireExpr", span: this.sp(t), capability: cap.text };
    }

    return this.parsePostfix();
  }

  private parseMake(): A.Expr {
    const kw = this.next(); // make
    const what = this.cur();
    if (what.kind === T.Ident || what.kind === T.Keyword) {
      const name = what.text;
      if (name === "channel") {
        this.next();
        let type: A.TypeNode | undefined;
        if (this.eat(T.LParen)) {
          type = this.parseType();
          this.expect(T.RParen, "`)`");
        }
        let capacity: A.Expr | undefined;
        if (this.is(T.Colon) && !this.is(T.Newline, 1)) { this.next(); capacity = this.parseExpr(1); }
        return { kind: "MakeExpr", span: this.sp(kw), what: "channel", type, capacity };
      }
      if (name === "mutex" || name === "rwmutex") {
        this.next();
        return { kind: "MakeExpr", span: this.sp(kw), what: name };
      }
    }
    this.error("E0124", "`make` expects `channel(T)`, `mutex`, or `rwmutex`", this.sp(kw), { rule: "#27/#29" });
    return { kind: "NullLit", span: this.sp(kw) };
  }

  private parseAtomic(): A.Expr {
    const kw = this.next(); // atomic
    let type: A.TypeNode | undefined;
    let init: A.Expr = { kind: "IntLit", span: this.sp(kw), value: 0n };
    if (this.eat(T.LParen)) {
      if (this.looksLikeBareType() && this.is(T.Ident) && PRIMITIVE_TYPES.has(this.cur().text)) {
        type = this.parseType();
      } else if (!this.is(T.RParen)) {
        init = this.parseExpr(0);
      }
      this.expect(T.RParen, "`)`");
    }
    if (this.is(T.Colon) && !this.is(T.Newline, 1)) { this.next(); init = this.parseExpr(1); }
    return { kind: "AtomicExpr", span: this.sp(kw), type, init };
  }

  private parseLaunch(): A.Expr {
    const kw = this.next();
    const call = this.parsePostfix();
    let config: A.RecordExpr | undefined;
    if (this.is(T.Colon) && this.is(T.Newline, 1) && this.is(T.Indent, 2)) {
      this.next();
      config = this.parseRecordBlock();
    }
    return { kind: "LaunchExpr", span: this.sp(kw), call, config };
  }

  /** Level 2: calls, member access, indexing, slicing (R4, R9). */
  private parsePostfix(): A.Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.cur();
      if (t.kind === T.Dot && !t.nlBefore) {
        this.next();
        const n = this.cur();
        if (n.kind !== T.Ident && n.kind !== T.Keyword) {
          this.error("E0125", `expected a field or method name, found ${tokenDesc(n)}`, n.span);
          break;
        }
        this.next();
        e = { kind: "MemberExpr", span: spanOf(e.span, n.span), obj: e, name: n.text };
        continue;
      }
      if (t.kind === T.LParen && !t.nlBefore) {
        e = this.finishCall(e, []);
        continue;
      }
      // Generic call: `f<int>(...)` — bounded lookahead (R9).
      if (t.kind === T.Lt && !t.nlBefore && (e.kind === "Ident" || e.kind === "MemberExpr")) {
        const after = this.scanGenerics(this.p);
        if (after !== -1 && this.toks[after]?.kind === T.LParen) {
          this.next();
          const typeArgs: A.TypeNode[] = [];
          while (!this.is(T.Gt) && !this.is(T.Eof)) {
            typeArgs.push(this.parseType());
            if (!this.eat(T.Comma)) break;
          }
          this.expect(T.Gt, "`>`");
          e = this.finishCall(e, typeArgs);
          continue;
        }
      }
      if (t.kind === T.LBracket && !t.nlBefore) {
        e = this.finishIndex(e);
        continue;
      }
      break;
    }
    return e;
  }

  private finishCall(callee: A.Expr, typeArgs: A.TypeNode[]): A.CallExpr {
    this.expect(T.LParen, "`(`");
    const args: A.Arg[] = [];
    while (!this.is(T.RParen) && !this.is(T.Eof)) {
      const startTok = this.cur();
      // `...` — an elided argument list, or a C variadic marker (#35, #42).
      if (this.is(T.Ellipsis)) {
        this.next();
        args.push({ value: { kind: "EllipsisExpr", span: startTok.span }, span: startTok.span });
        if (!this.eat(T.Comma)) break;
        continue;
      }
      // Named argument: `timeout: 10` (#37)
      if ((this.is(T.Ident) || this.is(T.Keyword)) && this.is(T.Colon, 1) && !this.is(T.Newline, 2)) {
        const n = this.next();
        this.next();
        const v = this.parseExpr(0);
        args.push({ name: n.text, value: v, span: this.sp(startTok) });
      } else {
        const v = this.parseExpr(0);
        args.push({ value: v, span: this.sp(startTok) });
      }
      if (!this.eat(T.Comma)) break;
    }
    this.expect(T.RParen, "`)`");
    return { kind: "CallExpr", span: spanOf(callee.span, this.toks[this.p - 1]!.span), callee, args, typeArgs, command: false };
  }

  /** `a[i]` or `a[start:end:step]` (R4, R13). */
  private finishIndex(obj: A.Expr): A.Expr {
    const open = this.expect(T.LBracket, "`[`");
    const slots: (A.Expr | undefined)[] = [];
    let isSlice = false;
    let cur: A.Expr | undefined;

    for (;;) {
      if (this.is(T.RBracket) || this.is(T.Eof)) break;
      if (this.is(T.Colon)) {
        isSlice = true;
        this.next();
        slots.push(cur);
        cur = undefined;
        continue;
      }
      cur = this.parseExpr(0);
    }
    slots.push(cur);
    this.expect(T.RBracket, "`]`");

    if (!isSlice) {
      const index = slots[0] ?? ({ kind: "NullLit", span: this.sp(open) } as A.NullLit);
      if (slots[0] === undefined) {
        this.error("E0126", "empty index `[]`", this.sp(open), {
          rule: "#54 — Indexing, slicing & ranges",
          help: "write an index (`items[0]`) or a slice (`items[:]`)",
        });
      }
      return { kind: "IndexExpr", span: spanOf(obj.span, this.toks[this.p - 1]!.span), obj, index };
    }
    if (slots.length > 3) {
      this.error("E0127", "a slice has at most `[start:end:step]`", this.sp(open), { rule: "R13" });
    }
    return {
      kind: "SliceExpr", span: spanOf(obj.span, this.toks[this.p - 1]!.span), obj,
      start: slots[0], end: slots[1], step: slots[2],
    };
  }

  private canStartExpr2(k: number): boolean {
    const t = this.at(k);
    switch (t.kind) {
      case T.Int: case T.Float: case T.Str: case T.RawStr: case T.Char:
      case T.Ident: case T.LParen: case T.LBracket: case T.LBrace:
        return true;
      case T.Keyword:
        return CAN_START_EXPR_KW.has(t.text);
      default:
        return false;
    }
  }

  private canStartExpr(): boolean {
    const t = this.cur();
    switch (t.kind) {
      case T.Int: case T.Float: case T.Str: case T.RawStr: case T.Char:
      case T.Ident: case T.LParen: case T.LBracket: case T.LBrace:
      case T.Minus: case T.Plus: case T.Star: case T.Amp: case T.Underscore:
        return true;
      case T.Keyword:
        return CAN_START_EXPR_KW.has(t.text);
      default:
        return false;
    }
  }

  private parsePrimary(): A.Expr {
    const t = this.cur();

    switch (t.kind) {
      case T.Int: this.next(); return { kind: "IntLit", span: t.span, value: t.big ?? BigInt(t.num ?? 0) };
      case T.Float: this.next(); return { kind: "FloatLit", span: t.span, value: t.num ?? 0 };
      case T.Char: this.next(); return { kind: "CharLit", span: t.span, value: t.ch ?? "\0" };
      case T.Str: case T.RawStr: return this.parseStrLit();
      case T.Underscore:
        this.next();
        this.error("E0128", "`_` can only appear in a pattern", t.span, { rule: "#4 — Destructuring" });
        return { kind: "NullLit", span: t.span };
      case T.Ident: {
        this.next();
        return { kind: "Ident", span: t.span, name: t.text };
      }
      case T.LParen: {
        this.next();
        const elements: A.Expr[] = [];
        let trailingComma = false;
        while (!this.is(T.RParen) && !this.is(T.Eof)) {
          elements.push(this.parseExpr(0));
          if (this.eat(T.Comma)) { trailingComma = true; continue; }
          trailingComma = false;
          break;
        }
        this.expect(T.RParen, "`)`");
        if (elements.length === 1 && !trailingComma) return elements[0]!;
        return { kind: "TupleExpr", span: this.sp(t), elements };
      }
      case T.LBracket: return this.parseBracketLiteral();
      case T.LBrace: {
        this.next();
        const elements: A.Expr[] = [];
        while (!this.is(T.RBrace) && !this.is(T.Eof)) {
          elements.push(this.parseExpr(0));
          if (!this.eat(T.Comma)) break;
        }
        this.expect(T.RBrace, "`}`");
        return { kind: "SetExpr", span: this.sp(t), elements };
      }
      case T.Keyword:
        switch (t.text) {
          case "true": this.next(); return { kind: "BoolLit", span: t.span, value: true };
          case "false": this.next(); return { kind: "BoolLit", span: t.span, value: false };
          case "null": this.next(); return { kind: "NullLit", span: t.span };
          case "nothing": this.next(); return { kind: "NothingLit", span: t.span };
        }
        break;
    }

    this.error("E0129", `expected an expression, found ${tokenDesc(t)}`, t.span);
    if (!this.is(T.Newline) && !this.is(T.Eof) && !this.is(T.Dedent)) this.p++;
    return { kind: "NullLit", span: t.span };
  }

  /** `[...]` in primary position: a list literal or a map literal (R4). */
  private parseBracketLiteral(): A.Expr {
    const open = this.next(); // [
    const elements: A.Expr[] = [];
    const entries: { key: A.Expr; value: A.Expr }[] = [];

    while (!this.is(T.RBracket) && !this.is(T.Eof)) {
      const first = this.parseExpr(0);
      if (this.is(T.Colon) && !this.is(T.Newline, 1)) {
        this.next();
        const v = this.parseExpr(0);
        entries.push({ key: first, value: v });
      } else {
        elements.push(first);
      }
      if (!this.eat(T.Comma)) break;
    }
    this.expect(T.RBracket, "`]`");

    if (entries.length && elements.length) {
      this.error("E0210", "a literal cannot mix `key: value` entries with plain elements", this.sp(open), {
        rule: "R4",
        help: "use a map (`[\"a\": 1]`) or a list (`[1, 2]`), not both",
      });
    }
    if (entries.length) return { kind: "MapExpr", span: this.sp(open), entries };
    return { kind: "ListExpr", span: this.sp(open), elements };
  }

  private parseStrLit(): A.Expr {
    const t = this.next();
    const raw = t.kind === T.RawStr;
    const multiline = t.text.startsWith('"""') || t.text.startsWith('r"""');
    const parts: A.StrPartNode[] = [];
    for (const p of t.parts ?? []) {
      if (p.kind === "text") {
        parts.push({ kind: "text", text: p.value, span: p.span });
      } else {
        // Re-lex and parse the interpolated expression source (#2).
        const sub = lex(p.value, this.file);
        for (const d of sub.diags.items) this.diags.items.push({ ...d, span: p.span });
        const sp = new Parser(sub.tokens, this.file, this.diags);
        const e = sp.parseExpr(0);
        parts.push({ kind: "expr", expr: retarget(e, p.span), span: p.span });
      }
    }
    return { kind: "StrLit", span: t.span, parts, raw, multiline };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PRIMITIVE_TYPES = new Set([
  "int", "uint", "float", "byte", "bool", "string", "char",
  "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
  "float32", "float64", "double", "void",
]);

const TYPE_CTORS = new Set(["list", "array", "map", "set", "channel", "task", "tuple", "vector"]);

/** Keywords that may begin an expression. */
const CAN_START_EXPR_KW = new Set([
  "true", "false", "null", "nothing", "not", "borrow", "move", "raw", "start",
  "await", "receive", "load", "reflect", "compile", "make", "atomic", "launch",
  "device", "match", "cancelled",
]);

function opText(k: TokenKind): string | undefined {
  switch (k) {
    case T.Plus: return "+";
    case T.Minus: return "-";
    case T.Star: return "*";
    case T.Slash: return "/";
    case T.Percent: return "%";
    case T.Lt: return "<";
    case T.Le: return "<=";
    case T.Gt: return ">";
    case T.Ge: return ">=";
    case T.EqEq: return "==";
    case T.Ne: return "!=";
    default: return undefined;
  }
}

/** R3.1 — UpperCamelCase names are type names. */
export function isTypeName(s: string): boolean {
  return /^[A-Z]/.test(s);
}

function isAssignable(e: A.Expr): boolean {
  switch (e.kind) {
    case "Ident": case "MemberExpr": case "IndexExpr": case "DerefExpr":
    case "TupleExpr": case "ListExpr": case "ForeignExpr":
      return true;
    default:
      return false;
  }
}

/** Point every node of an interpolated sub-expression at its span in the outer file. */
function retarget<TNode>(node: TNode, span: Span): TNode {
  const seen = new Set<unknown>();
  const go = (v: unknown): void => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const e of v) go(e); return; }
    const o = v as Record<string, unknown>;
    if ("span" in o) o.span = span;
    for (const k of Object.keys(o)) if (k !== "span") go(o[k]);
  };
  go(node);
  return node;
}

export function parse(src: string, file: string): { module: A.Module; diags: DiagnosticBag; comments: Comment[] } {
  const { tokens, diags, comments } = lex(src, file);
  const p = new Parser(tokens, file, diags);
  const module = p.parseModule();
  return { module, diags, comments };
}
