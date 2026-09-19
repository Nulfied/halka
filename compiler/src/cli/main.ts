// The `halka` command-line driver.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { parse, Parser } from "../parser/parser.ts";
import { lex } from "../lexer/lexer.ts";
import { Interpreter, HalkaRuntimeError } from "../interp/interpreter.ts";
import { DiagnosticBag, renderAll, HalkaError, type Diagnostic } from "../util/diagnostics.ts";
import { format } from "../fmt/format.ts";
import { check } from "../sema/check.ts";
import { inferTypes } from "../sema/infer.ts";
import { checkOwnership } from "../sema/ownership.ts";
import { emitC } from "../backend/c/emit.ts";
import { buildNative, describeToolchains, findPython } from "../backend/c/build.ts";
import { show as showTy } from "../sema/types.ts";
import { inspect, display, type Value, NOTHING } from "../runtime/value.ts";
import type * as A from "../parser/ast.ts";

export const VERSION = "0.1.0";

const NL = "\n";
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];

function die(msg: string): never {
  process.stderr.write(`halka: ${msg}\n`);
  process.exit(1);
}

function report(diags: Diagnostic[], sources: Map<string, string>): void {
  if (!diags.length) return;
  process.stderr.write(renderAll(diags, { color: useColor, sources }) + "\n\n");
  const errs = diags.filter((d) => d.severity === "error").length;
  const warns = diags.length - errs;
  const bits: string[] = [];
  if (errs) bits.push(`${errs} error${errs === 1 ? "" : "s"}`);
  if (warns) bits.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  process.stderr.write(bits.join(", ") + "\n");
}

// ---------------------------------------------------------------------------
// module loading
// ---------------------------------------------------------------------------

interface Loaded {
  main: A.Module;
  sources: Map<string, string>;
  deps: { path: string; mod: A.Module }[];
  diags: DiagnosticBag;
}

/** Parse `file` plus every local module it imports (#33, #34). */
function loadProgram(file: string): Loaded {
  const sources = new Map<string, string>();
  const diags = new DiagnosticBag();
  const deps: { path: string; mod: A.Module }[] = [];
  const seen = new Set<string>();

  const root = dirname(resolve(file));
  // Module search path: next to the importing file, then the bundled stdlib,
  // then anything on HALKA_PATH (#33, #34).
  const searchPath = [
    root,
    join(root, ".."),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "stdlib"),
    ...(process.env["HALKA_PATH"] ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean),
  ];

  const readModule = (abs: string, logical: string): A.Module | null => {
    if (seen.has(abs)) return null;
    seen.add(abs);
    const src = readFileSync(abs, "utf8");
    sources.set(abs, src);
    const { tokens, diags: lexDiags } = lex(src, abs);
    for (const d of lexDiags.items) diags.items.push(d);
    const mod = new Parser(tokens, abs, diags).parseModule();
    for (const s of mod.stmts) {
      if (s.kind !== "ImportDecl" || s.foreign) continue;
      const rel = s.path.replace(/\./g, "/").replace(/^"|"$/g, "");
      const candidates = searchPath.flatMap((dir) => [join(dir, rel + ".hk"), join(dir, rel, "mod.hk")]);
      for (const cand of candidates) {
        if (existsSync(cand)) {
          const sub = readModule(resolve(cand), s.path);
          if (sub) deps.push({ path: s.path, mod: sub });
          break;
        }
      }
    }
    return mod;
  };

  const abs = resolve(file);
  const main = readModule(abs, basename(abs, ".hk"));
  if (!main) die(`could not read ${file}`);
  return { main, sources, deps, diags };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdRun(args: string[]): void {
  const file = args[0];
  if (!file) die("usage: halka run <file.hk>");
  if (!existsSync(file)) die(`no such file: ${file}`);

  const { main, sources, deps, diags } = loadProgram(file);
  const sema = check(main, deps.map((d) => d.mod));
  for (const d of sema.items) diags.items.push(d);
  if (!diags.hasErrors) {
    const inferred = inferTypes(main);
    for (const d of inferred.diags.items) diags.items.push(d);
    if (!inferred.diags.hasErrors) {
      const own = checkOwnership(main, inferred.types, inferred.structFields);
      for (const d of own.diags.items) diags.items.push(d);
    }
  }

  if (diags.hasErrors) {
    report(diags.items, sources);
    process.exit(1);
  }
  const warnings = diags.items.filter((d) => d.severity === "warning");
  if (warnings.length && process.env["HALKA_WARN"] !== "0") report(warnings, sources);

  const interp = new Interpreter({ color: useColor, grants: (process.env["HALKA_GRANTS"] ?? "").split(",").filter(Boolean) });
  // Register local modules before running main.
  for (const d of deps) {
    const env = interp.globals.child();
    interp.hoist(d.mod.stmts, env);
    interp.modules.set(d.path, env);
  }
  try {
    interp.run(main);
  } catch (e) {
    reportRuntime(e, sources);
    process.exit(1);
  }
}

function reportRuntime(e: unknown, sources: Map<string, string>): void {
  if (e instanceof HalkaRuntimeError) {
    report([{
      code: e.code,
      severity: "error",
      message: e.msg,
      span: e.span ?? anonSpan(),
      help: e.code === "R0030" ? "build it instead: `halka build --release <file.hk>`" : undefined,
    }], sources);
    if (e.trace.length) {
      process.stderr.write("\ncall stack (innermost last):\n");
      for (const f of e.trace) process.stderr.write(`  ${f}\n`);
    }
    return;
  }
  if (e instanceof HalkaError) {
    report(e.diagnostics, sources);
    return;
  }
  process.stderr.write(`halka: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
}

function anonSpan() {
  const p = { offset: 0, line: 1, col: 1 };
  return { file: "<runtime>", start: p, end: p };
}

function cmdCheck(args: string[]): void {
  const explain = args.includes("--explain");
  // Accept files or directories, like `halka fmt` does.
  const given = args.filter((a) => !a.startsWith("-"));
  const files = (given.length ? given : ["."]).flatMap((a) => {
    if (!existsSync(a)) die(`no such file or directory: ${a}`);
    return statSync(a).isDirectory() ? discover(a) : [a];
  });
  if (!files.length) die("no .hk files found");
  let total = 0;
  const allSources = new Map<string, string>();
  const allDiags: Diagnostic[] = [];
  const unknowns: { span: { file: string; start: { line: number; col: number } }; why: string }[] = [];
  for (const f of files) {
    const { main, sources, deps, diags } = loadProgram(f);
    const sema = check(main, deps.map((d) => d.mod));
    for (const [k, v] of sources) allSources.set(k, v);
    allDiags.push(...diags.items, ...sema.items);
    if (!diags.hasErrors && !sema.hasErrors) {
      const inferred = inferTypes(main);
      allDiags.push(...inferred.diags.items);
      if (!inferred.diags.hasErrors) {
        allDiags.push(...checkOwnership(main, inferred.types, inferred.structFields).diags.items);
      }
      if (explain) unknowns.push(...inferred.unknowns);
    }
    total++;
  }
  if (explain) {
    if (!unknowns.length) process.stdout.write("every expression has a concrete type" + NL);
    for (const u of unknowns) {
      process.stdout.write(`  ${u.span.file}:${u.span.start.line}:${u.span.start.col}  unknown type — ${u.why}` + NL);
    }
  }
  report(allDiags, allSources);
  const errs = allDiags.filter((d) => d.severity === "error").length;
  if (!errs) process.stdout.write(`checked ${total} file${total === 1 ? "" : "s"}: no errors\n`);
  process.exit(errs ? 1 : 0);
}

function cmdFmt(args: string[]): void {
  const write = args.includes("--write") || args.includes("-w");
  const checkOnly = args.includes("--check");
  const files = args.filter((a) => !a.startsWith("-"));
  const targets = files.length ? files.flatMap((f) => (statSync(f).isDirectory() ? discover(f) : [f])) : discover(".");
  let changed = 0;

  for (const f of targets) {
    const src = readFileSync(f, "utf8");
    const { module, diags, comments } = parse(src, f);
    if (diags.hasErrors) {
      report(diags.items, new Map([[f, src]]));
      process.stderr.write(`halka fmt: skipping ${f} (it does not parse)\n`);
      continue;
    }
    const out = format(module, comments);
    if (out === src) continue;
    changed++;
    if (checkOnly) process.stdout.write(`would reformat ${f}\n`);
    else if (write) writeFileSync(f, out, "utf8");
    else process.stdout.write(out);
  }
  if (checkOnly) {
    if (changed) { process.stderr.write(`${changed} file(s) need formatting\n`); process.exit(1); }
    process.stdout.write("all files are formatted\n");
  } else if (write) {
    process.stdout.write(`formatted ${changed} file(s)\n`);
  }
}

function cmdBuild(args: string[]): void {
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const positional = args.filter((a) => !a.startsWith("-"));
  const file = positional[0];
  if (!file) die("usage: halka build [--release] [--emit-c] [-o out] <file.hk>");
  if (!existsSync(file)) die(`no such file: ${file}`);

  const oIdx = args.indexOf("-o");
  const outName = oIdx >= 0 && args[oIdx + 1] ? args[oIdx + 1]! : defaultBinaryName(file);

  const { main, sources, deps, diags } = loadProgram(file);
  const sema = check(main, deps.map((d) => d.mod));
  for (const d of sema.items) diags.items.push(d);
  if (diags.hasErrors) { report(diags.items, sources); process.exit(1); }

  const inferred = inferTypes(main);
  for (const d of inferred.diags.items) diags.items.push(d);
  if (!inferred.diags.hasErrors) {
    const own = checkOwnership(main, inferred.types, inferred.structFields);
    for (const d of own.diags.items) diags.items.push(d);
  }
  if (diags.hasErrors) { report(diags.items, sources); process.exit(1); }

  const { c, diags: emitDiags, links, needsPython } = emitC(main, inferred.types, {
    release: flags.has("--release"),
    file: basename(file),
    foreignImports: inferred.foreignImports,
  });
  if (emitDiags.hasErrors) {
    report(emitDiags.items, sources);
    process.stderr.write(NL + "the native backend is still growing; `halka run` executes the whole language today." + NL);
    process.exit(1);
  }

  const outcome = buildNative(c, file, {
    out: outName,
    release: flags.has("--release"),
    keepC: flags.has("--keep-c") || flags.has("--emit-c"),
    emitOnly: flags.has("--emit-c"),
    quiet: flags.has("--quiet"),
    libs: links,
    needsPython,
  });

  if (!outcome.ok) die(outcome.message ?? "the build failed");
  for (const w of outcome.warnings ?? []) {
    process.stderr.write(`warning from the C compiler: ${w}` + NL);
  }
  if ((outcome.warnings ?? []).length) {
    process.stderr.write("  these usually mean a `c` declaration does not match the real symbol" + NL);
  }
  if (outcome.cFile && flags.has("--emit-c")) {
    process.stdout.write(`wrote ${outcome.cFile}` + NL);
    return;
  }
  if (!flags.has("--quiet")) {
    const extra = [
      outcome.toolchain,
      flags.has("--release") ? "release" : "debug",
      ...(outcome.python ? [`CPython ${outcome.python.version}`] : []),
      ...(links.length ? [`links ${links.join(" ")}`] : []),
    ].join(", ");
    process.stdout.write(`built ${outcome.binary}  (${extra})` + NL);
    if (outcome.cFile) process.stdout.write(`  C source kept at ${outcome.cFile}` + NL);
  }
}

function defaultBinaryName(file: string): string {
  const base = basename(file).replace(/\.hk$/, "");
  return process.platform === "win32" ? `${base}.exe` : `./${base}`;
}

function cmdToolchain(): void {
  process.stdout.write(`C compilers found: ${describeToolchains()}` + NL);
  const py = findPython();
  process.stdout.write(
    py
      ? `CPython for embedding: ${py.version} (${py.include})` + NL
      : "CPython for embedding: not found — install python3-dev to use `py` interop" + NL,
  );
}

function cmdAst(args: string[]): void {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) die("usage: halka ast <file.hk> [--json]");
  const src = readFileSync(file, "utf8");
  const { module, diags } = parse(src, file);
  if (diags.hasErrors) { report(diags.items, new Map([[file, src]])); process.exit(1); }
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(module, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  } else {
    process.stdout.write(sexp(module, 0) + "\n");
  }
}

function cmdTokens(args: string[]): void {
  const file = args[0];
  if (!file) die("usage: halka tokens <file.hk>");
  const src = readFileSync(file, "utf8");
  const { tokens, diags } = lex(src, file);
  for (const t of tokens) {
    const pos = `${String(t.span.start.line).padStart(4)}:${String(t.span.start.col).padEnd(3)}`;
    process.stdout.write(`${pos} ${t.kind.padEnd(10)} ${JSON.stringify(t.text)}\n`);
  }
  report(diags.items, new Map([[file, src]]));
}

function cmdRepl(): void {
  const interp = new Interpreter({ color: useColor });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "halka> " });
  let buffer = "";
  process.stdout.write(`Halka ${VERSION} — type an expression, or \`:help\`.\n`);
  rl.prompt();

  rl.on("line", (line) => {
    if (!buffer && line.startsWith(":")) {
      const [cmd] = line.slice(1).split(/\s+/);
      if (cmd === "q" || cmd === "quit" || cmd === "exit") { rl.close(); return; }
      if (cmd === "help") {
        process.stdout.write(":help  :quit  :env  :clear\nEnd a line with `,` or an open block to continue on the next line.\n");
        rl.prompt();
        return;
      }
      if (cmd === "env") {
        process.stdout.write(interp.globals.allNames().sort().join(" ") + "\n");
        rl.prompt();
        return;
      }
      if (cmd === "clear") { buffer = ""; rl.setPrompt("halka> "); rl.prompt(); return; }
    }

    buffer += (buffer ? "\n" : "") + line;
    // Continue reading while the snippet is obviously incomplete.
    if (/[,:([{]\s*$/.test(line) || (buffer.match(/\n/g) && /^\s+\S/.test(line))) {
      rl.setPrompt("  ...  ");
      rl.prompt();
      return;
    }

    const src = buffer;
    buffer = "";
    rl.setPrompt("halka> ");

    const { module, diags } = parse(src, "<repl>");
    if (diags.hasErrors) {
      report(diags.items, new Map([["<repl>", src]]));
      rl.prompt();
      return;
    }
    try {
      const v = runRepl(interp, module);
      if (v && v.t !== "nothing") process.stdout.write(inspect(v) + "\n");
    } catch (e) {
      reportRuntime(e, new Map([["<repl>", src]]));
    }
    rl.prompt();
  });

  rl.on("close", () => { process.stdout.write("\n"); process.exit(0); });
}

/** Evaluate a REPL snippet in the persistent global scope and echo its value. */
function runRepl(interp: Interpreter, mod: A.Module): Value {
  interp.hoist(mod.stmts, interp.globals);
  let last: Value = NOTHING;
  const frame = { fnName: "<repl>", defers: [], capabilities: new Set<string>(), unsafeDepth: 0 };
  interp.globals.frame = frame;
  const gen = (function* () {
    for (const s of mod.stmts) {
      if (s.kind === "ExprStmt") last = (yield* interp.eval(interp.globals, s.expr)) as Value;
      else yield* interp.execStmt(interp.globals, s);
    }
    return last;
  })();
  const f = interp.sched.spawn("<repl>", gen as never);
  interp.sched.runUntil(f);
  if (f.state === "failed") throw f.error;
  return last;
}

function cmdTest(args: string[]): void {
  const dir = args[0] ?? ".";
  const files = discover(dir).filter((f) => basename(f).startsWith("test_") || basename(f).endsWith("_test.hk"));
  if (!files.length) die(`no test files found under ${dir} (name them test_*.hk or *_test.hk)`);
  let pass = 0, fail = 0;
  for (const f of files) {
    const { main, sources, deps, diags } = loadProgram(f);
    if (diags.hasErrors) { report(diags.items, sources); fail++; continue; }
    const out: string[] = [];
    const interp = new Interpreter({ out: (s) => out.push(s), err: (s) => out.push(s) });
    for (const d of deps) {
      const env = interp.globals.child();
      interp.hoist(d.mod.stmts, env);
      interp.modules.set(d.path, env);
    }
    try {
      interp.run(main);
      process.stdout.write(`  ok   ${f}\n`);
      pass++;
    } catch (e) {
      process.stdout.write(`  FAIL ${f}\n`);
      for (const l of out) process.stdout.write(`       ${l}\n`);
      reportRuntime(e, sources);
      fail++;
    }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

function discover(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (extname(p) === ".hk") out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function sexp(n: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  if (n === null || n === undefined) return `${pad}-`;
  if (typeof n !== "object") return `${pad}${typeof n === "bigint" ? n.toString() : JSON.stringify(n)}`;
  if (Array.isArray(n)) return n.map((x) => sexp(x, depth)).join("\n");
  const o = n as Record<string, unknown>;
  if (typeof o["kind"] !== "string") {
    return Object.entries(o).filter(([k]) => k !== "span").map(([k, v]) => `${pad}${k}:\n${sexp(v, depth + 1)}`).join("\n");
  }
  const lines = [`${pad}(${o["kind"]}`];
  for (const [k, v] of Object.entries(o)) {
    if (k === "kind" || k === "span" || v === undefined) continue;
    if (typeof v !== "object" || v === null) {
      lines.push(`${pad}  ${k}=${typeof v === "bigint" ? v.toString() : JSON.stringify(v)}`);
    } else {
      lines.push(`${pad}  ${k}:`);
      lines.push(sexp(v, depth + 2));
    }
  }
  lines.push(`${pad})`);
  return lines.join("\n");
}

const HELP = `Halka ${VERSION} — the Halka programming language

usage: halka <command> [arguments]

commands:
  run <file.hk>          run a program (reference interpreter)
  build <file.hk>        compile to a native binary via C99
                           --release  optimise, drop overflow/bounds checks
                           --emit-c   write the generated C and stop
                           --keep-c   keep the generated C beside the binary
                           -o <path>  output path
  toolchain              show which C compilers were found
  check [files...]       parse and type-check without running
  fmt [--write] [paths]  format source to canonical style (#48)
  test [dir]             run test_*.hk / *_test.hk files
  repl                   start an interactive session
  ast <file.hk> [--json] print the canonical AST
  tokens <file.hk>       print the token stream
  lsp                    start the language server (stdio)
  version                print the version

environment:
  HALKA_GRANTS=A,B       grant capabilities to the program (#45)
  NO_COLOR=1             disable coloured diagnostics
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "check": return cmdCheck(rest);
    case "build": return cmdBuild(rest);
    case "toolchain": return cmdToolchain();
    case "fmt": case "format": return cmdFmt(rest);
    case "test": return cmdTest(rest);
    case "repl": case undefined: return cmdRepl();
    case "ast": return cmdAst(rest);
    case "tokens": return cmdTokens(rest);
    case "lsp": {
      const { startServer } = await import("../lsp/server.ts");
      return startServer();
    }
    case "version": case "--version": case "-v":
      process.stdout.write(`halka ${VERSION}\n`);
      return;
    case "help": case "--help": case "-h":
      process.stdout.write(HELP);
      return;
    default:
      if (cmd.endsWith(".hk")) return cmdRun([cmd, ...rest]);
      die(`unknown command \`${cmd}\` — try \`halka help\``);
  }
}
