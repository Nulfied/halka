// Halka token definitions. See spec/V49-LOCKED.md and spec/RESOLUTIONS.md R5, R12, R17.

import type { Span } from "../util/diagnostics.ts";

export const T = {
  // structural
  Newline: "Newline",
  Indent: "Indent",
  Dedent: "Dedent",
  Eof: "Eof",

  // literals
  Int: "Int",
  Float: "Float",
  Str: "Str", // cooked string, possibly with interpolation parts
  RawStr: "RawStr",
  Char: "Char",
  Ident: "Ident",
  Keyword: "Keyword",

  // punctuation / operators
  Colon: "Colon", // :
  Comma: "Comma", // ,
  Dot: "Dot", // .
  DotDot: "DotDot", // ..
  DotDotEq: "DotDotEq", // ..=
  Ellipsis: "Ellipsis", // ...
  LParen: "LParen",
  RParen: "RParen",
  LBracket: "LBracket",
  RBracket: "RBracket",
  LBrace: "LBrace",
  RBrace: "RBrace",
  Lt: "Lt",
  Gt: "Gt",
  Le: "Le",
  Ge: "Ge",
  EqEq: "EqEq",
  Ne: "Ne",
  Plus: "Plus",
  Minus: "Minus",
  Star: "Star",
  Slash: "Slash",
  Percent: "Percent",
  Amp: "Amp", // &
  Question: "Question", // ?
  Arrow: "Arrow", // -> (reserved, not in V49 surface; rejected with help)
  Underscore: "Underscore", // _
} as const;

export type TokenKind = (typeof T)[keyof typeof T];

/** A piece of a string literal: either literal text or an interpolated expression source. */
export interface StrPart {
  kind: "text" | "expr";
  value: string;
  /** Span of the part inside the original file (for interpolation diagnostics). */
  span: Span;
}

export interface Token {
  kind: TokenKind;
  /** Raw source text of the token. */
  text: string;
  span: Span;
  /** For Int/Float. */
  num?: number;
  /** For Int with a big value. */
  big?: bigint;
  /** For Str/RawStr: the decoded parts (text + interpolations). */
  parts?: StrPart[];
  /** For Char: the single code point. */
  ch?: string;
  /** Number of spaces immediately preceding this token on its line (for R5 comma rule). */
  spacesBefore?: number;
  /** True when no whitespace at all precedes this token (used by R4 index-vs-literal). */
  glued?: boolean;
  /** True when a newline was skipped between the previous token and this one. */
  nlBefore?: boolean;
}

/**
 * Contextual keywords: FFI boundary markers (#35-#37) and the `is` state words
 * (R10). They are lexed as identifiers so that `let [a, b, c]` and a variable
 * named `error` keep working; the parser recognises them positionally.
 */
export const CONTEXTUAL = new Set(["c", "cpp", "py", "ok", "error", "range", "apply", "acquire", "struct", "class", "step"]);

/** Reserved words — spec/RESOLUTIONS.md R17. */
export const KEYWORDS = new Set([
  "and", "as", "atomic", "await", "borrow", "break", "callback",
  "cancel", "cancelled", "capability", "compile", "const", "continue", "defer",
  "device", "else", "enum", "export", "extern", "false", "for",
  "from", "generate", "give", "if", "implements", "import", "in", "is",
  "kernel", "launch", "let", "load", "macro", "make", "match", "move",
  "mut", "not", "nothing", "null", "or", "parallel",
  "raw", "receive", "reflect", "register", "release", "requires", "revoke", "say",
  "send", "specialize", "start", "store", "to", "trait", "true",
  "type", "unsafe", "while", "with",
]);

/** Reserved and actively rejected — R16. Maps keyword to the locked rule that removed it. */
export const REJECTED_KEYWORDS = new Map<string, { code: string; rule: string; help: string }>([
  ["try", { code: "E0303", rule: "#23 — Exception model", help: "Halka has no exception system. Use Result<T> with Ok(value) / Error(message)." }],
  ["catch", { code: "E0303", rule: "#23 — Exception model", help: "Halka has no exception system. Match on Result<T>: `match result, Ok(value), ... Error(message), ...`" }],
  ["throw", { code: "E0303", rule: "#23 — Exception model", help: "Return an error instead: `give Error(\"message\")`." }],
  ["finally", { code: "E0303", rule: "#23 — Exception model", help: "Use `defer` for cleanup (rule #24); it runs even on early `give`." }],
  ["return", { code: "E0304", rule: "#9 — Early give", help: "Halka uses `give` as its single return mechanism." }],
  ["lambda", { code: "E0301", rule: "#17 — Function values", help: "Halka has no lambda syntax. Define a named function and pass it by name." }],
  ["fn", { code: "E0305", rule: "#53 — Canonical style", help: "Halka declares functions as `name(params),` with an indented body — no `fn` keyword." }],
  ["func", { code: "E0305", rule: "#53 — Canonical style", help: "Halka declares functions as `name(params),` with an indented body." }],
  ["function", { code: "E0305", rule: "#53 — Canonical style", help: "Halka declares functions as `name(params),` with an indented body." }],
  ["class", { code: "E0306", rule: "#16 — Interfaces beyond traits", help: "Use a struct declaration (`User:` + fields) and `implements` for behaviour." }],
]);

export function isKeyword(s: string): boolean {
  return KEYWORDS.has(s);
}

export function tokenDesc(t: Token): string {
  switch (t.kind) {
    case T.Newline: return "end of line";
    case T.Indent: return "an indented block";
    case T.Dedent: return "the end of an indented block";
    case T.Eof: return "end of file";
    default: return `\`${t.text}\``;
  }
}
