// Halka lexer.
//
// Implements the locked lexical rules:
//   #2  strings, chars, interpolation, multiline, raw
//   #47 `#` line comments and `### ... ###` block comments
//   #49 newline terminates a statement; brackets suppress layout
//   #50 comma continuation + the 0..2-space-before-comma rule
//   R12 spaces-only indentation, INDENT/DEDENT, bracket suppression
//   R17 reserved words (and reserved-and-rejected words)

import { DiagnosticBag, type Pos, type Span } from "../util/diagnostics.ts";
import { T, type Token, type TokenKind, type StrPart, KEYWORDS, REJECTED_KEYWORDS } from "./token.ts";

const MAX_SPACES_BEFORE_COMMA = 2; // rule #50

export interface Comment {
  text: string;
  span: Span;
  /** True when the comment is alone on its line (not trailing code). */
  ownLine: boolean;
  block: boolean;
}

export interface LexResult {
  tokens: Token[];
  diags: DiagnosticBag;
  /** Comments are trivia for the parser but the formatter must preserve them (#47). */
  comments: Comment[];
}

export class Lexer {
  private readonly src: string;
  private readonly file: string;
  private readonly diags: DiagnosticBag;

  private i = 0;
  private line = 1;
  private col = 1;

  private tokens: Token[] = [];
  private indents: number[] = [0];
  private bracketDepth = 0;
  /** Stack of open bracket kinds, for better diagnostics. */
  private brackets: { ch: string; span: Span }[] = [];
  private atLineStart = true;
  private pendingNl = false;
  private lastSpaces = 0;
  private lastGlued = true;
  private comments: Comment[] = [];

  constructor(src: string, file: string, diags?: DiagnosticBag) {
    // Normalise newlines; strip a UTF-8 BOM.
    this.src = src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    this.file = file;
    this.diags = diags ?? new DiagnosticBag();
  }

  // ---- position helpers -------------------------------------------------

  private pos(): Pos {
    return { offset: this.i, line: this.line, col: this.col };
  }

  private span(start: Pos, end?: Pos): Span {
    return { file: this.file, start, end: end ?? this.pos() };
  }

  private peek(k = 0): string {
    return this.src[this.i + k] ?? "";
  }

  private advance(): string {
    const c = this.src[this.i++] ?? "";
    if (c === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private match(s: string): boolean {
    if (this.src.startsWith(s, this.i)) {
      for (let k = 0; k < s.length; k++) this.advance();
      return true;
    }
    return false;
  }

  private atEnd(): boolean {
    return this.i >= this.src.length;
  }

  private push(kind: TokenKind, text: string, start: Pos, extra?: Partial<Token>): Token {
    const tok: Token = {
      kind,
      text,
      span: this.span(start),
      spacesBefore: this.lastSpaces,
      glued: this.lastGlued,
      nlBefore: this.pendingNl,
      ...extra,
    };
    this.tokens.push(tok);
    this.pendingNl = false;
    this.lastSpaces = 0;
    this.lastGlued = true;
    return tok;
  }

  private pushLayout(kind: TokenKind, start: Pos): void {
    this.tokens.push({ kind, text: "", span: this.span(start, start) });
  }

  // ---- main loop --------------------------------------------------------

  lex(): LexResult {
    while (!this.atEnd()) {
      if (this.atLineStart && this.bracketDepth === 0) {
        if (!this.handleLineStart()) continue;
      }
      this.skipInlineTrivia();
      if (this.atEnd()) break;

      const c = this.peek();

      if (c === "\n") {
        const start = this.pos();
        this.advance();
        if (this.bracketDepth === 0) {
          if (this.tokens.length && this.last()?.kind !== T.Newline && this.last()?.kind !== T.Indent) {
            this.pushLayout(T.Newline, start);
          }
          this.atLineStart = true;
        } else {
          this.pendingNl = true;
          this.lastGlued = false;
        }
        continue;
      }

      this.scanToken();
    }

    // Close out the file.
    const end = this.pos();
    if (this.brackets.length) {
      const b = this.brackets[this.brackets.length - 1]!;
      this.diags.error("E0010", `unclosed \`${b.ch}\``, b.span, {
        help: "every bracket must be closed before the end of the file",
      });
    }
    if (this.tokens.length && this.last()!.kind !== T.Newline) this.pushLayout(T.Newline, end);
    while (this.indents.length > 1) {
      this.indents.pop();
      this.pushLayout(T.Dedent, end);
    }
    this.pushLayout(T.Eof, end);
    return { tokens: this.tokens, diags: this.diags, comments: this.comments };
  }

  private last(): Token | undefined {
    return this.tokens[this.tokens.length - 1];
  }

  /**
   * Measure indentation at the start of a logical line.
   * Returns false when the line turned out to be blank/comment-only and the
   * caller should restart the loop.
   */
  private handleLineStart(): boolean {
    const lineStart = this.pos();
    let width = 0;
    let sawTab = false;
    const tabStart = this.pos();
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === " ") {
        width++;
        this.advance();
      } else if (c === "\t") {
        sawTab = true;
        width += 4;
        this.advance();
      } else break;
    }

    // Blank line, or a line holding nothing but a comment: no layout tokens.
    if (this.atEnd()) return true;
    if (this.peek() === "\n") {
      this.advance();
      return false;
    }
    if (this.peek() === "#") {
      this.skipComment(true);
      // A `###` block comment may have consumed newlines; re-measure.
      if (!this.atEnd() && this.peek() === "\n") this.advance();
      return false;
    }

    if (sawTab) {
      this.diags.error("E0003", "tabs are not allowed in indentation", this.span(tabStart), {
        rule: "R12 (from #48, #53)",
        help: "Halka indents with spaces only; run `halka fmt` to convert",
      });
    }

    const top = this.indents[this.indents.length - 1]!;
    if (width > top) {
      this.indents.push(width);
      this.pushLayout(T.Indent, lineStart);
    } else if (width < top) {
      while (this.indents.length > 1 && width < this.indents[this.indents.length - 1]!) {
        this.indents.pop();
        this.pushLayout(T.Dedent, lineStart);
      }
      if (this.indents[this.indents.length - 1]! !== width) {
        this.diags.error("E0004", "dedent does not match any enclosing indentation level", this.span(lineStart), {
          rule: "R12",
          help: `expected a column in {${this.indents.join(", ")}}, found column ${width}`,
        });
        this.indents.push(width);
      }
    }
    this.atLineStart = false;
    this.lastSpaces = 0;
    this.lastGlued = true;
    return true;
  }

  /** Skip spaces and comments that do not end the line. Records space count for #50. */
  private skipInlineTrivia(): void {
    let spaces = 0;
    let any = false;
    for (;;) {
      const c = this.peek();
      if (c === " ") {
        spaces++;
        any = true;
        this.advance();
      } else if (c === "\t") {
        this.diags.error("E0003", "tabs are not allowed inside a line", this.span(this.pos()), {
          rule: "R12",
          help: "use spaces; `halka fmt` will do this for you",
        });
        spaces += 4;
        any = true;
        this.advance();
      } else if (c === "#") {
        const isBlock = this.src.startsWith("###", this.i);
        this.skipComment();
        any = true;
        if (!isBlock) break; // line comment runs to the newline
      } else break;
    }
    this.lastSpaces = spaces;
    if (any) this.lastGlued = false;
  }

  /** `#` to end of line, or `### ... ###` spanning lines (rule #47). */
  private skipComment(ownLine = false): void {
    const start = this.pos();
    if (this.src.startsWith("###", this.i)) {
      this.advance();
      this.advance();
      this.advance();
      for (;;) {
        if (this.atEnd()) {
          this.diags.error("E0011", "unterminated `###` block comment", this.span(start), {
            rule: "#47 — Comments",
            help: "close the comment with `###`",
          });
          return;
        }
        if (this.src.startsWith("###", this.i)) {
          this.advance();
          this.advance();
          this.advance();
          return;
        }
        this.advance();
      }
    }
    while (!this.atEnd() && this.peek() !== "\n") this.advance();
  }

  // ---- token scanning ---------------------------------------------------

  private scanToken(): void {
    const start = this.pos();
    const c = this.peek();

    // strings & chars
    if (c === '"') return this.scanString(start, false);
    if (c === "'") return this.scanChar(start);
    if ((c === "r" || c === "R") && this.peek(1) === '"') {
      this.advance();
      return this.scanString(start, true);
    }

    if (isDigit(c)) return this.scanNumber(start);
    if (isIdentStart(c)) return this.scanIdent(start);

    // multi-char punctuation, longest first
    if (this.match("...")) return void this.push(T.Ellipsis, "...", start);
    if (this.match("..=")) return void this.push(T.DotDotEq, "..=", start);
    if (this.match("..")) return void this.push(T.DotDot, "..", start);
    if (this.match("==")) return void this.push(T.EqEq, "==", start);
    if (this.match("!=")) return void this.push(T.Ne, "!=", start);
    if (this.match("<=")) return void this.push(T.Le, "<=", start);
    if (this.match(">=")) return void this.push(T.Ge, ">=", start);
    if (this.match("->")) {
      const t = this.push(T.Arrow, "->", start);
      this.diags.error("E0005", "`->` is not Halka syntax", t.span, {
        rule: "#53 — Canonical style",
        help: "a return type is written `f(params): Type,`",
      });
      return;
    }

    switch (c) {
      case ":": this.advance(); return void this.push(T.Colon, ":", start);
      case ",": return this.scanComma(start);
      case ".": this.advance(); return void this.push(T.Dot, ".", start);
      case "(": return this.openBracket(T.LParen, "(", start);
      case ")": return this.closeBracket(T.RParen, ")", "(", start);
      case "[": return this.openBracket(T.LBracket, "[", start);
      case "]": return this.closeBracket(T.RBracket, "]", "[", start);
      case "{": return this.openBracket(T.LBrace, "{", start);
      case "}": return this.closeBracket(T.RBrace, "}", "{", start);
      case "<": this.advance(); return void this.push(T.Lt, "<", start);
      case ">": this.advance(); return void this.push(T.Gt, ">", start);
      case "+": this.advance(); return void this.push(T.Plus, "+", start);
      case "-": this.advance(); return void this.push(T.Minus, "-", start);
      case "*": this.advance(); return void this.push(T.Star, "*", start);
      case "/": this.advance(); return void this.push(T.Slash, "/", start);
      case "%": this.advance(); return void this.push(T.Percent, "%", start);
      case "&": this.advance(); return void this.push(T.Amp, "&", start);
      case "?": this.advance(); return void this.push(T.Question, "?", start);
    }

    this.advance();
    const t = this.push(T.Ident, c, start);
    this.diags.error("E0001", `unexpected character \`${c}\``, t.span);
  }

  /** `,` with the locked 0..2-space-before rule (#50). */
  private scanComma(start: Pos): void {
    const spaces = this.lastSpaces;
    this.advance();
    const tok = this.push(T.Comma, ",", start);
    if (spaces > MAX_SPACES_BEFORE_COMMA) {
      this.diags.error("E0002", `${spaces} spaces before \`,\` — at most ${MAX_SPACES_BEFORE_COMMA} are allowed`, tok.span, {
        rule: "#50 — Exact comma-continuation rules",
        help: "use 0, 1, or 2 spaces before `,`",
      });
    }
  }

  private openBracket(kind: TokenKind, ch: string, start: Pos): void {
    this.advance();
    const t = this.push(kind, ch, start);
    this.bracketDepth++;
    this.brackets.push({ ch, span: t.span });
  }

  private closeBracket(kind: TokenKind, ch: string, open: string, start: Pos): void {
    this.advance();
    const t = this.push(kind, ch, start);
    const top = this.brackets.pop();
    if (!top) {
      this.diags.error("E0012", `unmatched \`${ch}\``, t.span);
    } else if (top.ch !== open) {
      this.diags.error("E0013", `\`${ch}\` closes \`${top.ch}\``, t.span, {
        notes: [{ message: `\`${top.ch}\` opened here`, span: top.span }],
      });
    }
    if (this.bracketDepth > 0) this.bracketDepth--;
  }

  private scanIdent(start: Pos): void {
    let s = "";
    while (!this.atEnd() && isIdentPart(this.peek())) s += this.advance();

    if (s === "_") return void this.push(T.Underscore, s, start);

    // A rejected word keeps its foreign meaning behind a `c` / `cpp` / `py` marker
    // (`cpp class Point:` is locked by #36).
    const prev = this.last();
    const afterForeignMarker = prev?.kind === T.Ident && (prev.text === "c" || prev.text === "cpp" || prev.text === "py");

    const rejected = afterForeignMarker ? undefined : REJECTED_KEYWORDS.get(s);
    if (rejected) {
      const t = this.push(T.Ident, s, start);
      this.diags.error(rejected.code, `\`${s}\` is reserved and is not part of Halka V49`, t.span, {
        rule: rejected.rule,
        help: rejected.help,
      });
      return;
    }

    this.push(KEYWORDS.has(s) ? T.Keyword : T.Ident, s, start);
  }

  private scanNumber(start: Pos): void {
    let s = "";
    const radixPrefix = this.peek() === "0" ? (this.peek(1) || "").toLowerCase() : "";
    if (radixPrefix === "x" || radixPrefix === "b" || radixPrefix === "o") {
      s += this.advance();
      s += this.advance();
      const radix = radixPrefix === "x" ? 16 : radixPrefix === "b" ? 2 : 8;
      let digits = "";
      while (!this.atEnd() && (isRadixDigit(this.peek(), radix) || this.peek() === "_")) {
        const d = this.advance();
        s += d;
        if (d !== "_") digits += d;
      }
      if (!digits) {
        const t = this.push(T.Int, s, start, { num: 0 });
        this.diags.error("E0006", `\`${s}\` has no digits`, t.span);
        return;
      }
      const big = BigInt(radixPrefix === "x" ? `0x${digits}` : radixPrefix === "b" ? `0b${digits}` : `0o${digits}`);
      this.push(T.Int, s, start, { num: Number(big), big });
      return;
    }

    let isFloat = false;
    let digits = "";
    while (!this.atEnd() && (isDigit(this.peek()) || this.peek() === "_")) {
      const d = this.advance();
      s += d;
      if (d !== "_") digits += d;
    }
    // A `.` only starts a fraction when followed by a digit — `1..10` stays a range.
    if (this.peek() === "." && isDigit(this.peek(1))) {
      isFloat = true;
      s += this.advance();
      digits += ".";
      while (!this.atEnd() && (isDigit(this.peek()) || this.peek() === "_")) {
        const d = this.advance();
        s += d;
        if (d !== "_") digits += d;
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      const save = { i: this.i, line: this.line, col: this.col };
      let exp = this.advance();
      if (this.peek() === "+" || this.peek() === "-") exp += this.advance();
      if (isDigit(this.peek())) {
        while (!this.atEnd() && (isDigit(this.peek()) || this.peek() === "_")) {
          const d = this.advance();
          exp += d;
        }
        s += exp;
        digits += exp.replace(/_/g, "");
        isFloat = true;
      } else {
        this.i = save.i;
        this.line = save.line;
        this.col = save.col;
      }
    }

    if (isFloat) {
      this.push(T.Float, s, start, { num: Number(digits) });
    } else {
      const big = BigInt(digits);
      this.push(T.Int, s, start, { num: Number(big), big });
    }
  }

  /** `'c'` — the character form (#2). */
  private scanChar(start: Pos): void {
    this.advance(); // opening '
    let value = "";
    if (this.peek() === "\\") {
      this.advance();
      value = this.readEscape(start);
    } else if (this.peek() === "'" || this.atEnd() || this.peek() === "\n") {
      const t = this.push(T.Char, "''", start, { ch: "\0" });
      this.diags.error("E0007", "empty character literal", t.span, {
        rule: "#2 — Strings & interpolation",
        help: "a character literal holds exactly one character, e.g. `'H'`",
      });
      if (this.peek() === "'") this.advance();
      return;
    } else {
      // Consume one full code point (handles surrogate pairs).
      const cp = String.fromCodePoint(this.src.codePointAt(this.i)!);
      for (let k = 0; k < cp.length; k++) this.advance();
      value = cp;
    }
    if (this.peek() !== "'") {
      const t = this.push(T.Char, value, start, { ch: value });
      this.diags.error("E0008", "unterminated character literal", t.span, {
        rule: "#2 — Strings & interpolation",
        help: "did you mean a string? strings use double quotes: \"...\"",
      });
      return;
    }
    this.advance(); // closing '
    this.push(T.Char, this.src.slice(start.offset, this.i), start, { ch: value });
  }

  /**
   * `"..."`, `"""..."""`, and `r"..."` (#2).
   * Produces a parts list so the parser can build an interpolation node.
   */
  private scanString(start: Pos, raw: boolean): void {
    const triple = this.src.startsWith('"""', this.i);
    const delim = triple ? '"""' : '"';
    for (let k = 0; k < delim.length; k++) this.advance();

    const parts: StrPart[] = [];
    let text = "";
    let textStart = this.pos();

    const flushText = () => {
      if (text.length) {
        parts.push({ kind: "text", value: text, span: this.span(textStart) });
        text = "";
      }
      textStart = this.pos();
    };

    for (;;) {
      if (this.atEnd()) {
        flushText();
        const t = this.push(raw ? T.RawStr : T.Str, this.src.slice(start.offset, this.i), start, { parts });
        this.diags.error("E0009", `unterminated ${triple ? "multiline " : ""}string literal`, t.span, {
          rule: "#2 — Strings & interpolation",
          help: `close it with ${delim}`,
        });
        return;
      }
      if (this.src.startsWith(delim, this.i)) {
        // In a single-quoted string `""` is not an escape; the delimiter ends it.
        for (let k = 0; k < delim.length; k++) this.advance();
        break;
      }
      if (!triple && this.peek() === "\n") {
        flushText();
        const t = this.push(raw ? T.RawStr : T.Str, this.src.slice(start.offset, this.i), start, { parts });
        this.diags.error("E0009", "unterminated string literal", t.span, {
          rule: "#2 — Strings & interpolation",
          help: 'a multiline string uses """..."""',
        });
        return;
      }

      const c = this.peek();

      if (!raw && c === "\\") {
        this.advance();
        text += this.readEscape(start);
        continue;
      }

      // Interpolation `{expr}` (#2). Raw strings do not interpolate.
      if (!raw && c === "{") {
        if (this.peek(1) === "{") {
          this.advance();
          this.advance();
          text += "{";
          continue;
        }
        flushText();
        const exprStart = this.pos();
        this.advance(); // {
        let depth = 1;
        let expr = "";
        while (!this.atEnd() && depth > 0) {
          const d = this.peek();
          if (d === "{") depth++;
          else if (d === "}") {
            depth--;
            if (depth === 0) {
              this.advance();
              break;
            }
          } else if (d === '"') {
            // Allow a nested string inside an interpolation.
            expr += this.advance();
            while (!this.atEnd() && this.peek() !== '"') {
              if (this.peek() === "\\") expr += this.advance();
              expr += this.advance();
            }
            if (!this.atEnd()) expr += this.advance();
            continue;
          }
          expr += this.advance();
        }
        if (depth > 0) {
          this.diags.error("E0014", "unterminated `{` interpolation", this.span(exprStart), {
            rule: "#2 — Strings & interpolation",
            help: "close the interpolation with `}`",
          });
        }
        if (!expr.trim()) {
          this.diags.error("E0015", "empty interpolation `{}`", this.span(exprStart), {
            rule: "#2 — Strings & interpolation",
            help: "put an expression inside, e.g. `{name}`",
          });
        }
        parts.push({ kind: "expr", value: expr, span: this.span(exprStart) });
        textStart = this.pos();
        continue;
      }
      if (!raw && c === "}" && this.peek(1) === "}") {
        this.advance();
        this.advance();
        text += "}";
        continue;
      }

      text += this.advance();
    }

    flushText();

    if (triple) stripMultilineIndent(parts);

    this.push(raw ? T.RawStr : T.Str, this.src.slice(start.offset, this.i), start, { parts });
  }

  private readEscape(strStart: Pos): string {
    const c = this.advance();
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case '"': return '"';
      case "'": return "'";
      case "{": return "{";
      case "}": return "}";
      case "e": return "\x1b";
      case "\n": return ""; // line continuation inside a string
      case "u": {
        if (this.peek() === "{") {
          this.advance();
          let hex = "";
          while (!this.atEnd() && this.peek() !== "}") hex += this.advance();
          if (this.peek() === "}") this.advance();
          const n = parseInt(hex, 16);
          if (Number.isNaN(n) || n > 0x10ffff) {
            this.diags.error("E0016", `invalid unicode escape \`\\u{${hex}}\``, this.span(strStart));
            return "�";
          }
          return String.fromCodePoint(n);
        }
        this.diags.error("E0016", "`\\u` must be written `\\u{...}`", this.span(strStart));
        return "�";
      }
      default:
        this.diags.error("E0017", `unknown escape \`\\${c}\``, this.span(strStart), {
          help: "valid escapes: \\n \\t \\r \\0 \\\\ \\\" \\' \\{ \\} \\e \\u{...}",
        });
        return c;
    }
  }
}

/**
 * `"""` strings drop the first newline and the common leading indentation,
 * so the locked example renders as three flush-left lines.
 */
function stripMultilineIndent(parts: StrPart[]): void {
  const first = parts[0];
  if (first?.kind === "text" && first.value.startsWith("\n")) first.value = first.value.slice(1);

  const last = parts[parts.length - 1];
  let trailingIndent = 0;
  if (last?.kind === "text") {
    const m = /\n([ ]*)$/.exec(last.value);
    if (m) {
      trailingIndent = m[1]!.length;
      last.value = last.value.slice(0, last.value.length - m[0]!.length + 1);
    }
  }

  // Common indentation across all text lines that begin a line.
  let common = Infinity;
  let atLineStart = true;
  for (const p of parts) {
    if (p.kind !== "text") {
      atLineStart = false;
      continue;
    }
    const lines = p.value.split("\n");
    for (let k = 0; k < lines.length; k++) {
      const isStart = k > 0 || atLineStart;
      const l = lines[k]!;
      if (!isStart || l.trim() === "") continue;
      common = Math.min(common, l.length - l.trimStart().length);
    }
    atLineStart = p.value.endsWith("\n");
  }
  if (!Number.isFinite(common)) common = trailingIndent;
  if (common <= 0) return;

  atLineStart = true;
  for (const p of parts) {
    if (p.kind !== "text") {
      atLineStart = false;
      continue;
    }
    const lines = p.value.split("\n");
    const out = lines.map((l, k) => {
      const isStart = k > 0 || atLineStart;
      return isStart ? l.slice(Math.min(common, l.length - l.trimStart().length)) : l;
    });
    const endsNl = p.value.endsWith("\n");
    p.value = out.join("\n");
    atLineStart = endsNl;
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isRadixDigit(c: string, radix: number): boolean {
  const n = parseInt(c, radix);
  return !Number.isNaN(n) && /^[0-9a-fA-F]$/.test(c);
}
function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c) || c.codePointAt(0)! > 0x7f;
}
function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c) || c.codePointAt(0)! > 0x7f;
}

export function lex(src: string, file: string): LexResult {
  return new Lexer(src, file).lex();
}
