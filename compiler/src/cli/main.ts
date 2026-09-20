// The `halka` command-line driver.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
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
import { checkUnsafe } from "../sema/unsafe.ts";
import { analyseEscapes } from "../sema/escape.ts";
import { linkProgram } from "../sema/link.ts";
import { emitC, emitOptionsFrom } from "../backend/c/emit.ts";
import { buildNative, describeToolchains, findPython } from "../backend/c/build.ts";
import { show as showTy } from "../sema/types.ts";
import { runKernelHost } from "./kernel.ts";
import { installKernelspec } from "./kernelspec.ts";
import { inspect, display, type Value } from "../runtime/value.ts";
import { evalSnippet } from "./eval.ts";
import type * as A from "../parser/ast.ts";
import {
  BUILTIN_MODULES,
  LOCK_NAME,
  MANIFEST_NAME,
  ProjectError,
  type Project,
  type ResolvedDep,
  findProjectDir,
  loadProject,
  missingPackages,
  projectSearchPath,
  sync,
} from "../pkg/project.ts";
import { formatManifest, type Dependency } from "../pkg/manifest.ts";
import { compareVersions, formatVersion, parseReq, parseVersion } from "../pkg/semver.ts";
import { Registry, cacheRoot, cachedPackages, clearIndexCache, registryRoot } from "../pkg/registry.ts";

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

  // A dependency the lockfile names but the cache does not have would
  // otherwise let `import` fall through to whatever else the search path can
  // reach — a built-in module, or a same-named file elsewhere. Silently
  // importing something other than what was asked for is worse than stopping.
  const absent = missingPackages(file);
  if (absent) {
    die(
      `${absent.names.length === 1 ? "a dependency is" : "dependencies are"} not installed: ` +
      `${absent.names.join(", ")}` + NL +
      `  Run \`halka install\` in ${absent.projectDir}`,
    );
  }

  const root = dirname(resolve(file));
  // Module search path: next to the importing file, then the bundled stdlib,
  // then anything on HALKA_PATH (#33, #34).
  const searchPath = [
    root,
    join(root, ".."),
    // Anything this project declared in `halka.pkg` and has installed (#30).
    ...projectSearchPath(file),
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
      for (const d of checkUnsafe(main, inferred.types).items) diags.items.push(d);
    }
  }

  if (diags.hasErrors) {
    report(diags.items, sources);
    process.exit(1);
  }
  const warnings = diags.items.filter((d) => d.severity === "warning");
  if (warnings.length && process.env["HALKA_WARN"] !== "0") report(warnings, sources);

  const interp = new Interpreter({ color: useColor, grants: (process.env["HALKA_GRANTS"] ?? "").split(",").filter(Boolean) });
  // Register local modules before running main. Hoisting happens for every
  // module first, then imports are bound, so a dependency that imports
  // another dependency resolves whichever order they were discovered in.
  const moduleEnvs = deps.map((d) => {
    const env = interp.globals.child();
    interp.hoist(d.mod.stmts, env);
    interp.modules.set(d.path, env);
    return { d, env };
  });
  for (const { d, env } of moduleEnvs) interp.bindImports(d.mod.stmts, env);
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
        allDiags.push(...checkUnsafe(main, inferred.types).items);
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

  // The backend compiles one module, so imported modules are linked into the
  // program first: every imported declaration gets a unique name and every
  // reference is rewritten to match (sema/link.ts).
  const linked = linkProgram({ main, deps }).module;

  const inferred = inferTypes(linked);
  for (const d of inferred.diags.items) diags.items.push(d);
  let owningParams = new Map<string, boolean[]>();
  if (!inferred.diags.hasErrors) {
    const own = checkOwnership(linked, inferred.types, inferred.structFields);
    for (const d of checkUnsafe(linked, inferred.types).items) own.diags.items.push(d);
    for (const d of own.diags.items) diags.items.push(d);
    owningParams = own.owningParams;
  }
  if (diags.hasErrors) { report(diags.items, sources); process.exit(1); }

  // M4 — turn the ownership proof into deallocation.
  const escapes = analyseEscapes(linked, inferred.types, inferred.structFields, owningParams, inferred.enumVariants);

  const { c, diags: emitDiags, links, needsPython } = emitC(linked, inferred.types,
    emitOptionsFrom(inferred, {
      file: basename(file),
      release: flags.has("--release"),
      uncheckedIndex: flags.has("--no-bounds-checks"),
      escapes,
      owningParams,
    }));
  if (emitDiags.hasErrors) {
    report(emitDiags.items, sources);
    process.stderr.write(NL + "the native backend is still growing; `halka run` executes the whole language today." + NL);
    process.exit(1);
  }

  const outcome = buildNative(c, file, {
    out: outName,
    release: flags.has("--release"),
    fastMath: flags.has("--fast-math"),
    nativeCpu: flags.has("--cpu-native"),
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
      ...(flags.has("--fast-math") ? ["fast-math"] : []),
      ...(flags.has("--cpu-native") ? ["cpu-native"] : []),
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

/**
 * The Jupyter kernel. `host` is the half that runs code; `install` registers
 * a kernelspec pointing Jupyter at the Python front end, which in turn starts
 * `host`. See tools/jupyter/halka_kernel.py for why it is split that way.
 */
function cmdKernel(args: string[]): void {
  const sub = args[0] ?? "install";
  if (sub === "host") {
    // No banner and nothing else on stdout: the front end parses every line.
    runKernelHost();
    return;
  }
  if (sub !== "install") die(`unknown kernel command \`${sub}\` — try \`install\` or \`host\``);

  // The notebook should run *this* halka, so the spec records how this
  // process was started rather than trusting PATH to agree later.
  const hostCmd = [process.execPath, resolve(process.argv[1] ?? "halka"), "kernel", "host"];
  let res;
  try {
    res = installKernelspec(hostCmd);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  process.stdout.write(`installed the Halka kernel in ${res.dir}` + NL);
  process.stdout.write(`  front end: ${res.python}` + NL);
  if (res.warning) process.stdout.write(`  warning: ${res.warning}` + NL);
  process.stdout.write(`Start Jupyter and pick "Halka" from the kernel list.` + NL);
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
  return evalSnippet(interp, mod);
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
    const envs = deps.map((d) => {
      const env = interp.globals.child();
      interp.hoist(d.mod.stmts, env);
      interp.modules.set(d.path, env);
      return { d, env };
    });
    for (const { d, env } of envs) interp.bindImports(d.mod.stmts, env);
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

// ---------------------------------------------------------------------------
// packages (#29, #30, #31) — spec/PACKAGES.md
// ---------------------------------------------------------------------------

/** Find the project this command applies to, or explain why there is none. */
function currentProject(): Project {
  const dir = findProjectDir(process.cwd());
  if (!dir) {
    die(
      `this is not a Halka project — no ${MANIFEST_NAME} here or in any parent directory.` + NL +
      `  Run \`halka init\` to create one.`,
    );
  }
  try {
    return loadProject(dir);
  } catch (e) {
    if (e instanceof ProjectError) die(e.message);
    throw e;
  }
}

async function withProjectErrors<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Error) die(e.message);
    throw e;
  }
}

function cmdInit(args: string[]): void {
  const dir = process.cwd();
  const target = join(dir, MANIFEST_NAME);
  if (existsSync(target)) die(`${MANIFEST_NAME} already exists here`);

  const given = args.find((a) => !a.startsWith("-"));
  const name = given ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    die(
      `\`${name}\` is not a valid package name — lowercase letters, digits and \`-\`, starting with a letter.` + NL +
      `  Pass one explicitly: \`halka init my-package\``,
    );
  }

  const version = parseVersion("0.1.0")!;
  writeFileSync(target, formatManifest({ name, version, license: "", description: "", deps: [], file: target }));
  process.stdout.write(`wrote ${MANIFEST_NAME}` + NL);

  const src = join(dir, "src");
  const entry = join(src, "main.hk");
  if (!existsSync(entry)) {
    mkdirSync(src, { recursive: true });
    writeFileSync(entry, `say "hello from ${name}"` + NL);
    process.stdout.write("wrote src/main.hk" + NL);
  }
}

async function cmdAdd(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) die("usage: halka add <name> [version] [--dev] [--path DIR]");

  const pathIdx = args.indexOf("--path");
  const pathValue = pathIdx >= 0 ? args[pathIdx + 1] : undefined;
  if (pathIdx >= 0 && !pathValue) die("`--path` needs a directory");

  if (BUILTIN_MODULES.has(name)) {
    die(
      `\`${name}\` is the name of a built-in module, so no package can use it.` + NL +
      `  \`import ${name}\` already means the one in the prelude.`,
    );
  }

  const project = currentProject();
  const dev = args.includes("--dev");

  let dep: Dependency;
  if (pathValue) {
    dep = { name, req: null, path: pathValue, dev };
  } else {
    const reqText = positional.find((a) => a !== name && a !== pathValue);
    let req = reqText ? parseReq(reqText) : null;
    if (reqText && !req) die(`\`${reqText}\` is not a version requirement — write \`1.2.0\` or \`=1.2.0\``);
    if (!req) {
      // No version given: take the newest published and pin its compatibility
      // range, which is exactly what the bare (caret) form means.
      const registry = new Registry();
      const failures = (await registry.prefetch([name])).failures;
      if (failures.length) die(`could not read the registry:` + NL + `  ${failures.join(NL + "  ")}`);
      const versions = registry.versions(name);
      if (!versions || versions.length === 0) die(`no package named \`${name}\` was found in ${registryRoot()}`);
      const newest = versions.slice().sort(compareVersions).pop()!;
      req = { kind: "caret", version: newest };
    }
    dep = { name, req, path: null, dev };
  }

  const deps = [...project.manifest.deps];
  const at = deps.findIndex((d) => d.name === name);
  if (at >= 0) deps[at] = dep;
  else deps.push(dep);
  const updated = { ...project.manifest, deps };

  // Install before writing the manifest, so a failed add leaves the project
  // exactly as it was rather than half-changed.
  const installed = await withProjectErrors(() =>
    sync({ ...project, manifest: updated }, { dev: true, offline: false, update: false }));
  writeFileSync(join(project.dir, MANIFEST_NAME), formatManifest(updated));

  const added = installed.find((d) => d.name === name);
  const where = dev ? "dev-deps" : "deps";
  process.stdout.write(`added ${name}${added ? " " + formatVersion(added.version) : ""} to ${where}` + NL);
}

async function cmdRemove(args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) die("usage: halka remove <name>");
  const project = currentProject();
  if (!project.manifest.deps.some((d) => d.name === name)) {
    die(`\`${name}\` is not a dependency of \`${project.manifest.name}\``);
  }
  const updated = { ...project.manifest, deps: project.manifest.deps.filter((d) => d.name !== name) };
  writeFileSync(join(project.dir, MANIFEST_NAME), formatManifest(updated));
  // Re-resolve from scratch: dropping a dependency can drop transitive ones.
  await withProjectErrors(() =>
    sync({ ...project, manifest: updated, lock: null }, { dev: true, offline: false, update: true }));
  process.stdout.write(`removed ${name}` + NL);
}

async function cmdInstall(args: string[]): Promise<void> {
  const project = currentProject();
  const installed = await withProjectErrors(() =>
    sync(project, { dev: args.includes("--dev"), offline: args.includes("--offline"), update: false }));
  reportInstalled(installed);
}

async function cmdUpdate(args: string[]): Promise<void> {
  const project = currentProject();
  const only = args.find((a) => !a.startsWith("-"));
  if (only && !project.manifest.deps.some((d) => d.name === only)) {
    die(`\`${only}\` is not a dependency of \`${project.manifest.name}\``);
  }
  // An update is the one time a newly published version should be visible.
  clearIndexCache();
  const installed = await withProjectErrors(() => sync(project, { dev: true, offline: false, update: true }));
  reportInstalled(installed);
}

function reportInstalled(installed: ResolvedDep[]): void {
  if (installed.length === 0) {
    process.stdout.write("no dependencies" + NL);
    return;
  }
  for (const d of installed) {
    process.stdout.write(`  ${d.name} ${formatVersion(d.version)}${d.source === "path" ? "  (path)" : ""}` + NL);
  }
  process.stdout.write(
    `${installed.length} package${installed.length === 1 ? "" : "s"}, ${LOCK_NAME} is up to date` + NL,
  );
}

async function cmdTree(_args: string[]): Promise<void> {
  const project = currentProject();
  process.stdout.write(`${project.manifest.name} ${formatVersion(project.manifest.version)}` + NL);

  const direct = project.manifest.deps;
  if (direct.length === 0) {
    process.stdout.write("  (no dependencies)" + NL);
    return;
  }

  const installed = await withProjectErrors(() => sync(project, { dev: true, offline: true, update: false }));
  const byName = new Map(installed.map((d) => [d.name, d]));
  const registry = new Registry(undefined, true);
  const seen = new Set<string>();

  const walk = (name: string, prefix: string, last: boolean): void => {
    const d = byName.get(name);
    const label = d
      ? `${name} ${formatVersion(d.version)}${d.source === "path" ? " (path)" : ""}`
      : `${name} (not installed)`;
    const repeated = seen.has(name);
    process.stdout.write(`${prefix}${last ? "`-- " : "|-- "}${label}${repeated ? " *" : ""}` + NL);
    if (repeated || !d || d.source === "path") return;
    seen.add(name);
    const kids = registry.requirements(name, d.version) ?? [];
    kids.forEach((k, i) => walk(k.name, prefix + (last ? "    " : "|   "), i === kids.length - 1));
  };
  direct.forEach((d, i) => walk(d.name, "", i === direct.length - 1));
  if (seen.size) process.stdout.write(NL + "* already shown above" + NL);
}

function cmdPkg(args: string[]): void {
  if (args[0] !== "cache") die("usage: halka pkg cache [--clear]");
  if (args.includes("--clear")) {
    clearIndexCache();
    process.stdout.write(`cleared the index cache under ${cacheRoot()}` + NL);
    process.stdout.write(
      "package archives were kept — they are verified by hash, so reusing them is safe" + NL,
    );
    return;
  }
  process.stdout.write(`cache:    ${cacheRoot()}` + NL);
  process.stdout.write(`registry: ${registryRoot()}` + NL);
  const packages = cachedPackages();
  if (packages.length === 0) {
    process.stdout.write("no packages cached" + NL);
    return;
  }
  for (const p of packages.sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1))) {
    process.stdout.write(`  ${p.name} ${p.version}` + NL);
  }
}

const HELP = `Halka ${VERSION} — the Halka programming language

usage: halka <command> [arguments]

commands:
  run <file.hk>          run a program (reference interpreter)
  build <file.hk>        compile to a native binary via C99
                           --release  optimise; bounds checks are kept
                             unless the compiler can prove them
                             unnecessary, so a release binary is still
                             memory-safe
                           --no-bounds-checks  drop them anyway, for code
                             that has been measured and needs the last
                             few percent. Out-of-range reads become
                             undefined behaviour, as they are in C
                           --fast-math  let the C compiler reassociate
                             floating point, which is what lets it
                             vectorise a reduction. Results may differ
                             from the interpreter; measure before trusting
                           --cpu-native  target this machine's instruction
                             set; the binary may not run elsewhere
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
  kernel install         register the Jupyter kernel for this user
  kernel host            the execution half of that kernel (stdio JSON);
                           Jupyter starts this, you do not
  version                print the version

packages (spec/PACKAGES.md):
  init [name]            create a halka.pkg in this directory
  add <name> [req]       add a dependency and install it
                           --dev      add to dev-deps instead
                           --path P   depend on a local directory
  remove <name>          drop a dependency
  install                install what halka.pkg asks for
                           --offline  use only what is already cached
                           --dev      include dev-deps
  update [name]          re-resolve, ignoring the lockfile's pins
  tree                   show the resolved dependency graph
  pkg cache [--clear]    show or clear the package cache

environment:
  HALKA_GRANTS=A,B       grant capabilities to the program (#45)
  HALKA_REGISTRY=URL     registry root (a URL or a local directory)
  HALKA_CACHE=DIR        where packages are cached
  NO_COLOR=1             disable coloured diagnostics
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "run": return cmdRun(rest);
    case "init": return cmdInit(rest);
    case "add": return cmdAdd(rest);
    case "remove": return cmdRemove(rest);
    case "install": return cmdInstall(rest);
    case "update": return cmdUpdate(rest);
    case "tree": return cmdTree(rest);
    case "pkg": return cmdPkg(rest);
    case "check": return cmdCheck(rest);
    case "build": return cmdBuild(rest);
    case "toolchain": return cmdToolchain();
    case "kernel": return cmdKernel(rest);
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
