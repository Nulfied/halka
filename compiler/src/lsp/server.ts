// The Halka language server (LSP 3.17 over stdio).
//
// Written against the raw JSON-RPC framing with no npm dependencies, so any
// editor that speaks LSP — VS Code, Neovim, Helix, Emacs (eglot/lsp-mode),
// Sublime, Zed, Kate, IntelliJ (LSP4IJ) — can use it with `halka lsp`.

import { parse } from "../parser/parser.ts";
import { lex } from "../lexer/lexer.ts";
import { check } from "../sema/check.ts";
import { format } from "../fmt/format.ts";
import { KEYWORDS } from "../lexer/token.ts";
import { PRELUDE_NAMES } from "../sema/prelude-names.ts";
import { typeText } from "../runtime/convert.ts";
import type { Diagnostic as HDiag, Span } from "../util/diagnostics.ts";
import type * as A from "../parser/ast.ts";

interface Doc {
  uri: string;
  version: number;
  text: string;
  module?: A.Module;
  diags: HDiag[];
}

const docs = new Map<string, Doc>();

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

let buffer = Buffer.alloc(0);

function send(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

export function startServer(): void {
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + len) return;
      const body = buffer.subarray(start, start + len).toString("utf8");
      buffer = buffer.subarray(start + len);
      try {
        handle(JSON.parse(body));
      } catch (e) {
        process.stderr.write(`halka lsp: ${String(e)}\n`);
      }
    }
  });
  process.stdin.resume();
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: true }, // 1 = full
          hoverProvider: true,
          documentSymbolProvider: true,
          documentFormattingProvider: true,
          definitionProvider: true,
          completionProvider: { triggerCharacters: [".", ":"] },
          documentHighlightProvider: true,
          renameProvider: { prepareProvider: false },
        },
        serverInfo: { name: "halka-lsp", version: "0.1.0" },
      });

    case "initialized": return;
    case "shutdown": return reply(id, null);
    case "exit": process.exit(0);

    case "textDocument/didOpen": {
      const td = params["textDocument"] as { uri: string; version: number; text: string };
      analyse({ uri: td.uri, version: td.version, text: td.text, diags: [] });
      return;
    }
    case "textDocument/didChange": {
      const td = params["textDocument"] as { uri: string; version: number };
      const changes = params["contentChanges"] as { text: string }[];
      const text = changes[changes.length - 1]?.text ?? "";
      analyse({ uri: td.uri, version: td.version, text, diags: [] });
      return;
    }
    case "textDocument/didSave": {
      const td = params["textDocument"] as { uri: string };
      const d = docs.get(td.uri);
      if (d) analyse({ ...d, diags: [] });
      return;
    }
    case "textDocument/didClose": {
      const td = params["textDocument"] as { uri: string };
      docs.delete(td.uri);
      notify("textDocument/publishDiagnostics", { uri: td.uri, diagnostics: [] });
      return;
    }

    case "textDocument/hover": return reply(id, onHover(params));
    case "textDocument/documentSymbol": return reply(id, onSymbols(params));
    case "textDocument/formatting": return reply(id, onFormat(params));
    case "textDocument/definition": return reply(id, onDefinition(params));
    case "textDocument/completion": return reply(id, onCompletion(params));
    case "textDocument/documentHighlight": return reply(id, onHighlight(params));
    case "textDocument/rename": return reply(id, onRename(params));

    default:
      if (id !== undefined) reply(id, null);
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyse(doc: Doc): void {
  const path = uriToPath(doc.uri);
  const { module, diags } = parse(doc.text, path);
  const sema = check(module);
  doc.module = module;
  doc.diags = [...diags.items, ...sema.items];
  docs.set(doc.uri, doc);

  notify("textDocument/publishDiagnostics", {
    uri: doc.uri,
    version: doc.version,
    diagnostics: doc.diags.map(toLspDiagnostic),
  });
}

function toLspDiagnostic(d: HDiag) {
  return {
    range: spanToRange(d.span),
    severity: d.severity === "error" ? 1 : d.severity === "warning" ? 2 : 3,
    code: d.code,
    source: "halka",
    message: d.message + (d.rule ? `\n\nlocked rule: ${d.rule}` : "") + (d.help ? `\nhelp: ${d.help}` : ""),
  };
}

function spanToRange(s: Span) {
  return {
    start: { line: Math.max(0, s.start.line - 1), character: Math.max(0, s.start.col - 1) },
    end: { line: Math.max(0, s.end.line - 1), character: Math.max(0, s.end.col - 1) },
  };
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function docAt(params: Record<string, unknown>): { doc: Doc; line: number; col: number } | null {
  const td = params["textDocument"] as { uri: string } | undefined;
  const pos = params["position"] as { line: number; character: number } | undefined;
  const doc = td && docs.get(td.uri);
  if (!doc) return null;
  return { doc, line: (pos?.line ?? 0) + 1, col: (pos?.character ?? 0) + 1 };
}

/** The identifier under the cursor, found from the token stream. */
function wordAt(doc: Doc, line: number, col: number): { name: string; span: Span } | null {
  const { tokens } = lex(doc.text, uriToPath(doc.uri));
  for (const t of tokens) {
    if (t.kind !== "Ident" && t.kind !== "Keyword") continue;
    if (t.span.start.line !== line) continue;
    if (col >= t.span.start.col && col <= t.span.end.col) return { name: t.text, span: t.span };
  }
  return null;
}

function onHover(params: Record<string, unknown>) {
  const at = docAt(params);
  if (!at) return null;
  const w = wordAt(at.doc, at.line, at.col);
  if (!w) return null;

  // A diagnostic under the cursor wins — it is the most useful thing to show.
  const d = at.doc.diags.find((x) => x.span.start.line === at.line && at.col >= x.span.start.col && at.col <= x.span.end.col);

  const parts: string[] = [];
  const decl = at.doc.module ? findDecl(at.doc.module, w.name) : null;
  if (decl) parts.push("```halka\n" + declSignature(decl) + "\n```");

  const kw = KEYWORD_DOCS[w.name];
  if (kw) parts.push(`**\`${w.name}\`** — ${kw}`);

  const pre = PRELUDE_DOCS[w.name];
  if (pre) parts.push("```halka\n" + pre.sig + "\n```\n\n" + pre.doc);

  if (d) parts.push(`---\n\n**${d.severity} ${d.code}**: ${d.message}` + (d.help ? `\n\n*help:* ${d.help}` : ""));
  if (!parts.length) return null;
  return { contents: { kind: "markdown", value: parts.join("\n\n") }, range: spanToRange(w.span) };
}

function declSignature(s: A.Stmt): string {
  switch (s.kind) {
    case "FnDecl": {
      const g = s.generics.length ? `<${s.generics.map((x) => x.name).join(", ")}>` : "";
      const ps = s.params.map((p) => (p.type ? `${p.name}: ${typeText(p.type)}` : p.name)).join(", ");
      const r = s.retType ? `: ${typeText(s.retType)}` : "";
      return `${s.name}${g}(${ps})${r}`;
    }
    case "StructDecl": return `${s.name}:\n${s.fields.map((f) => `    ${f.name}${f.type ? `: ${typeText(f.type)}` : ""}`).join(",\n")}`;
    case "EnumDecl": return `enum ${s.name}:\n${s.variants.map((v) => `    ${v.name}`).join(",\n")}`;
    case "TraitDecl": return `trait ${s.name}`;
    case "TypeAliasDecl": return `type ${s.name}: ${typeText(s.type)}`;
    case "CapabilityDecl": return `capability ${s.name}:\n${s.perms.map((p) => `    ${p}`).join(",\n")}`;
    case "ConstDecl": return `const ${s.name}`;
    default: return "";
  }
}

function findDecl(mod: A.Module, name: string): A.Stmt | null {
  let found: A.Stmt | null = null;
  const visit = (stmts: A.Stmt[]) => {
    for (const s of stmts) {
      if (found) return;
      switch (s.kind) {
        case "FnDecl": case "StructDecl": case "EnumDecl": case "TraitDecl":
        case "TypeAliasDecl": case "CapabilityDecl": case "ConstDecl":
          if (s.name === name) { found = s; return; }
          if (s.kind === "FnDecl" && s.body) visit(s.body.stmts);
          break;
        case "ImplDecl": visit(s.members); break;
        case "GenerateDecl": visit(s.body.stmts); break;
        default: break;
      }
    }
  };
  visit(mod.stmts);
  return found;
}

const SYMBOL_KIND: Record<string, number> = {
  FnDecl: 12, StructDecl: 23, EnumDecl: 10, TraitDecl: 11,
  TypeAliasDecl: 5, CapabilityDecl: 8, ConstDecl: 14, ImplDecl: 5,
};

function onSymbols(params: Record<string, unknown>) {
  const td = params["textDocument"] as { uri: string };
  const doc = docs.get(td.uri);
  if (!doc?.module) return [];
  const out: unknown[] = [];

  const symbolsOf = (stmts: A.Stmt[]): unknown[] => {
    const res: unknown[] = [];
    for (const s of stmts) {
      const kind = SYMBOL_KIND[s.kind];
      if (!kind) continue;
      const name = "name" in s ? (s as { name: string }).name : s.kind === "ImplDecl" ? `${s.typeName} implements ${s.traits.join(", ")}` : "";
      if (!name) continue;
      const children =
        s.kind === "ImplDecl" ? symbolsOf(s.members)
        : s.kind === "TraitDecl" ? symbolsOf(s.members)
        : s.kind === "StructDecl" ? s.fields.map((f) => ({
            name: f.name, kind: 8, range: spanToRange(f.span), selectionRange: spanToRange(f.span), children: [],
          }))
        : s.kind === "EnumDecl" ? s.variants.map((v) => ({
            name: v.name, kind: 22, range: spanToRange(v.span), selectionRange: spanToRange(v.span), children: [],
          }))
        : [];
      res.push({
        name, kind, detail: s.kind === "FnDecl" ? declSignature(s) : undefined,
        range: spanToRange(s.span), selectionRange: spanToRange(s.span), children,
      });
    }
    return res;
  };

  out.push(...symbolsOf(doc.module.stmts));
  return out;
}

function onFormat(params: Record<string, unknown>) {
  const td = params["textDocument"] as { uri: string };
  const doc = docs.get(td.uri);
  if (!doc) return null;
  const path = uriToPath(doc.uri);
  const { module, diags, comments } = parse(doc.text, path);
  if (diags.hasErrors) return null; // never reformat code that does not parse (#48)
  const text = format(module, comments);
  const lines = doc.text.split(/\r\n|\r|\n/);
  return [{
    range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } },
    newText: text,
  }];
}

function onDefinition(params: Record<string, unknown>) {
  const at = docAt(params);
  if (!at?.doc.module) return null;
  const w = wordAt(at.doc, at.line, at.col);
  if (!w) return null;
  const decl = findDecl(at.doc.module, w.name);
  if (!decl) return null;
  return { uri: at.doc.uri, range: spanToRange(decl.span) };
}

function onHighlight(params: Record<string, unknown>) {
  const at = docAt(params);
  if (!at) return [];
  const w = wordAt(at.doc, at.line, at.col);
  if (!w) return [];
  const { tokens } = lex(at.doc.text, uriToPath(at.doc.uri));
  return tokens.filter((t) => t.kind === "Ident" && t.text === w.name).map((t) => ({ range: spanToRange(t.span), kind: 1 }));
}

function onRename(params: Record<string, unknown>) {
  const at = docAt(params);
  const newName = params["newName"] as string;
  if (!at || !newName) return null;
  const w = wordAt(at.doc, at.line, at.col);
  if (!w) return null;
  const { tokens } = lex(at.doc.text, uriToPath(at.doc.uri));
  const edits = tokens
    .filter((t) => t.kind === "Ident" && t.text === w.name)
    .map((t) => ({ range: spanToRange(t.span), newText: newName }));
  return { changes: { [at.doc.uri]: edits } };
}

function onCompletion(params: Record<string, unknown>) {
  const at = docAt(params);
  const items: unknown[] = [];

  for (const k of KEYWORDS) {
    items.push({ label: k, kind: 14, detail: KEYWORD_DOCS[k] ? "keyword" : undefined, documentation: KEYWORD_DOCS[k] });
  }
  for (const [name, d] of Object.entries(PRELUDE_DOCS)) {
    items.push({ label: name, kind: 3, detail: d.sig, documentation: { kind: "markdown", value: d.doc } });
  }
  for (const n of PRELUDE_NAMES) {
    if (!(n in PRELUDE_DOCS)) items.push({ label: n, kind: 3 });
  }

  if (at?.doc.module) {
    const seen = new Set<string>();
    const collect = (stmts: A.Stmt[]) => {
      for (const s of stmts) {
        if ("name" in s && typeof (s as { name?: unknown }).name === "string") {
          const n = (s as { name: string }).name;
          if (seen.has(n)) continue;
          seen.add(n);
          items.push({ label: n, kind: SYMBOL_KIND[s.kind] === 12 ? 3 : 7, detail: declSignature(s) });
        }
        if (s.kind === "FnDecl" && s.body) collect(s.body.stmts);
        if (s.kind === "EnumDecl") for (const v of s.variants) if (!seen.has(v.name)) { seen.add(v.name); items.push({ label: v.name, kind: 20 }); }
      }
    };
    collect(at.doc.module.stmts);
  }

  for (const s of SNIPPETS) items.push({ ...s, kind: 15, insertTextFormat: 2 });
  return { isIncomplete: false, items };
}

// ---------------------------------------------------------------------------
// Documentation shown in hover & completion
// ---------------------------------------------------------------------------

const KEYWORD_DOCS: Record<string, string> = {
  let: "Introduce a binding. `let name: value` (#1).",
  const: "A compile-time constant (#39).",
  give: "Return from the current function; the single return mechanism (#9).",
  say: "Print a value (#3).",
  if: "Conditional. `if cond,` + an indented block (#9).",
  else: "The alternative branch; `else if` chains (#9).",
  for: "Iterate. `for item in items,` (#6).",
  while: "Loop while a condition holds.",
  match: "Pattern match. Literals, variants, tuples, collections, guards, `else` (#10).",
  break: "Exit the nearest enclosing loop (#8).",
  continue: "Skip to the next iteration of the nearest loop (#8).",
  defer: "Schedule cleanup for function exit; runs in reverse order, even on early `give` (#24).",
  trait: "A behaviour contract. Halka has no separate interface construct (#16).",
  implements: "Implement one or more traits for a type (#16).",
  enum: "A tagged union. `Result<T>` with `Ok`/`Error` is the standard error model (#22).",
  type: "A type alias, not a new nominal type (#12).",
  import: "Bring in a module (#33).",
  from: "`from module import name, name` (#33).",
  export: "Make names visible to importers (#33).",
  start: "Spawn a task (#26).",
  await: "Wait for a task and take its result (#28).",
  send: "`send channel : value` (#27).",
  receive: "`receive channel` (#27).",
  make: "`make channel(T)`, `make mutex`, `make rwmutex` (#27, #29).",
  atomic: "A thread-safe primitive cell (#30).",
  load: "Read an atomic (#30).",
  store: "`store atomic : value` (#30).",
  cancel: "Request cancellation of a task (#31).",
  cancelled: "True inside a task whose cancellation was requested (#31).",
  parallel: "An explicitly parallel block (#32).",
  with: "Scoped lock (`with lock,`) or scoped capability (`with capability C,`) (#29, #45).",
  borrow: "A safe shared borrow; `borrow mut` for exclusive (#14).",
  move: "Transfer ownership (#25).",
  raw: "Mark a raw pointer; unsafe operations need `unsafe:` (#46).",
  unsafe: "A block where raw-pointer operations are permitted (#46).",
  as: "An explicit conversion expected to succeed (#15).",
  to: "A conversion that may fail; yields `Result<T>` (#15).",
  is: "Test a state or type: `is null`, `is error`, `is cancelled`, `is int` (R10).",
  or: "Logical or, and null-coalescing: `a or b` yields `b` when `a` is null or false (R11).",
  and: "Logical and, short-circuiting (R11).",
  not: "Logical negation; binds looser than comparison (#51).",
  null: "The absence value (#7).",
  nothing: "The unit value returned by a function with no `give` (#16).",
  macro: "A compile-time source transformation, hygienic by default (#40).",
  generate: "Create declarations at compile time (#41).",
  reflect: "Inspect a type or value (#42).",
  specialize: "Ask for explicit generic specialization (#43).",
  compile: "Force evaluation at compile time (#39).",
  kernel: "A device/GPU kernel (#44).",
  launch: "Launch a kernel, optionally with `blocks:`/`threads:` (#44).",
  device: "Place data or code on a device (#44).",
  capability: "Declare a security permission (#45).",
  requires: "Declare the capabilities a function needs (#45).",
  revoke: "Take a capability away from a task (#45).",
  register: "Register a callback across an ABI boundary (#38).",
  callback: "Mark a function as an ABI callback (#38).",
  extern: "Declare ABI details for foreign symbols (#38).",
};

const PRELUDE_DOCS: Record<string, { sig: string; doc: string }> = {
  len: { sig: "len(value): int", doc: "Length of a list, tuple, string, map, set, or range." },
  print: { sig: "print(...values)", doc: "Print values separated by spaces. `say` is the keyword form." },
  assert: { sig: "assert(condition, message: string?)", doc: "Fail with a message when the condition is false." },
  panic: { sig: "panic(message)", doc: "Abort with a message. Not recoverable — use `Result` for recoverable failures (#23)." },
  sorted: { sig: "sorted(items, key?)", doc: "A new sorted list. `key` is a named function applied to each element." },
  reversed: { sig: "reversed(items): list", doc: "A new list in reverse order." },
  enumerate: { sig: "enumerate(items): list", doc: "Pairs of `(index, value)`." },
  zip: { sig: "zip(a, b, ...): list", doc: "Tuples drawn from each list, truncated to the shortest." },
  sum: { sig: "sum(items)", doc: "Add every element." },
  min: { sig: "min(items) | min(a, b, ...)", doc: "Smallest value." },
  max: { sig: "max(items) | max(a, b, ...)", doc: "Largest value." },
  div: { sig: "div(a, b): int", doc: "Floor division. `/` always yields a float, so use `div` for integer division (R21)." },
  abs: { sig: "abs(x)", doc: "Absolute value." },
  sqrt: { sig: "sqrt(x): float", doc: "Square root." },
  pow: { sig: "pow(base, exponent)", doc: "Exponentiation; exact for whole exponents." },
  apply: { sig: "apply value : function", doc: "Apply a function value to one argument (#17)." },
  sleep: { sig: "sleep(milliseconds)", doc: "Suspend the current task." },
  close: { sig: "close(channel)", doc: "Close a channel; pending receivers get `null` (#27)." },
  Ok: { sig: "Ok(value): Result", doc: "A successful result (#22)." },
  Error: { sig: "Error(message): Result", doc: "A failed result (#22)." },
};

const SNIPPETS = [
  { label: "fn", detail: "function declaration", insertText: "${1:name}(${2:params}),\n    ${0}" },
  { label: "if", detail: "if / else", insertText: "if ${1:condition},\n    ${2},\nelse,\n    ${0}" },
  { label: "for", detail: "for loop", insertText: "for ${1:item} in ${2:items},\n    ${0}" },
  { label: "match", detail: "match", insertText: "match ${1:value},\n    ${2:pattern},\n        ${3},\n    else,\n        ${0}" },
  { label: "struct", detail: "struct declaration", insertText: "${1:Name}:\n    ${2:field}: ${3:string}" },
  { label: "trait", detail: "trait declaration", insertText: "trait ${1:Name}:\n    ${2:method}(),\n        give nothing" },
  { label: "impl", detail: "implements", insertText: "${1:Type} implements ${2:Trait}:\n    ${3:method}(),\n        ${0}" },
  { label: "result", detail: "handle a Result", insertText: "match ${1:result},\n    Ok(value),\n        ${2},\n    Error(message),\n        ${0}" },
  { label: "task", detail: "start / await", insertText: "let ${1:task}: start ${2:worker}(),\nlet ${3:result}: await ${1:task}" },
];

// ---------------------------------------------------------------------------

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = decodeURIComponent(uri.slice("file://".length));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}
