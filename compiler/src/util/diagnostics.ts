// Halka diagnostics: source positions, spans, and the error reporter.
// Numbering scheme is defined in spec/RESOLUTIONS.md § Diagnostic numbering.

export interface Pos {
  /** 0-based byte/char offset into the source. */
  offset: number;
  /** 1-based line. */
  line: number;
  /** 1-based column, counted in code points. */
  col: number;
}

export interface Span {
  file: string;
  start: Pos;
  end: Pos;
}

export type Severity = "error" | "warning" | "note";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  span: Span;
  /** Optional "here is the locked rule this comes from" pointer. */
  rule?: string;
  /** Optional suggestion shown under the snippet. */
  help?: string;
  notes?: { message: string; span?: Span }[];
}

export class HalkaError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics[0]?.message ?? "halka: unknown error");
    this.name = "HalkaError";
    this.diagnostics = diagnostics;
  }
}

export function pos(offset: number, line: number, col: number): Pos {
  return { offset, line, col };
}

export function span(file: string, start: Pos, end: Pos): Span {
  return { file, start, end };
}

export function spanOf(a: Span, b: Span): Span {
  return { file: a.file, start: a.start, end: b.end };
}

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  error(code: string, message: string, span: Span, extra?: Partial<Diagnostic>): Diagnostic {
    const d: Diagnostic = { code, severity: "error", message, span, ...extra };
    this.items.push(d);
    return d;
  }

  warn(code: string, message: string, span: Span, extra?: Partial<Diagnostic>): Diagnostic {
    const d: Diagnostic = { code, severity: "warning", message, span, ...extra };
    this.items.push(d);
    return d;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  throwIfErrors(): void {
    if (this.hasErrors) throw new HalkaError(this.items.filter((d) => d.severity === "error"));
  }
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

export interface RenderOptions {
  color?: boolean;
  source?: string;
  /** Resolve other files for multi-file notes. */
  sources?: Map<string, string>;
}

/** Render one diagnostic as a rustc/zig-style snippet. */
export function renderDiagnostic(d: Diagnostic, opts: RenderOptions = {}): string {
  const color = opts.color ?? false;
  const c = (code: string, s: string) => (color ? code + s + RESET : s);

  const sev = d.severity === "error" ? c(BOLD + RED, "error") : d.severity === "warning" ? c(BOLD + YELLOW, "warning") : c(BOLD + BLUE, "note");

  const out: string[] = [];
  out.push(`${sev}[${c(BOLD, d.code)}]: ${c(BOLD, d.message)}`);
  out.push(`  ${c(DIM, "-->")} ${d.span.file}:${d.span.start.line}:${d.span.start.col}`);

  const src = opts.sources?.get(d.span.file) ?? opts.source;
  if (src !== undefined) {
    const lines = src.split(/\r\n|\r|\n/);
    const ln = d.span.start.line;
    const gutter = String(ln).length;
    const pad = " ".repeat(gutter);
    const text = lines[ln - 1] ?? "";
    out.push(`${pad} ${c(DIM, "|")}`);
    out.push(`${c(DIM, String(ln))} ${c(DIM, "|")} ${text}`);
    const startCol = Math.max(1, d.span.start.col);
    const endCol = d.span.end.line === ln ? Math.max(startCol + 1, d.span.end.col) : text.length + 1;
    const caretPad = " ".repeat(startCol - 1);
    const carets = "^".repeat(Math.max(1, endCol - startCol));
    out.push(`${pad} ${c(DIM, "|")} ${caretPad}${c(d.severity === "error" ? RED : YELLOW, carets)}`);
  }
  if (d.rule) out.push(`  ${c(CYAN, "=")} ${c(DIM, "locked rule:")} ${d.rule}`);
  if (d.help) out.push(`  ${c(CYAN, "=")} ${c(BOLD, "help:")} ${d.help}`);
  for (const n of d.notes ?? []) out.push(`  ${c(CYAN, "=")} ${c(DIM, "note:")} ${n.message}`);
  return out.join("\n");
}

export function renderAll(ds: Diagnostic[], opts: RenderOptions = {}): string {
  return ds.map((d) => renderDiagnostic(d, opts)).join("\n\n");
}
