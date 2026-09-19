// The execution half of the Jupyter kernel.
//
// Jupyter speaks ZeroMQ with HMAC-signed multipart messages over five
// sockets. Reimplementing that in Node would mean either a native dependency
// or the ZMTP wire protocol by hand, and this compiler has no runtime
// dependencies. So the split is: a small Python front end (tools/jupyter/
// halka_kernel.py) inherits all of that from `ipykernel`, which anyone
// running Jupyter already has, and talks to this process over stdio.
//
// The protocol is one JSON object per line, in both directions. The host
// writes zero or more `{"stream": ...}` lines as the cell produces output,
// then exactly one line carrying the request's `id`, which ends the reply.

import { createInterface } from "node:readline";

import { parse } from "../parser/parser.ts";
import { Interpreter, HalkaRuntimeError } from "../interp/interpreter.ts";
import { renderAll, HalkaError, type Span } from "../util/diagnostics.ts";
import { inspect } from "../runtime/value.ts";
import { evalSnippet, looksUnfinished } from "./eval.ts";
import { KEYWORDS } from "../lexer/token.ts";
import { PRELUDE_MODULES } from "../sema/prelude-types.ts";

interface Request {
  id: number;
  kind: "exec" | "complete" | "is_complete" | "inspect" | "reset";
  code?: string;
  cursor?: number;
}

/** Everything a cell can be completed to that is not a user-defined name. */
const EXTRA_COMPLETIONS = [...KEYWORDS, ...PRELUDE_MODULES.keys()];

export function runKernelHost(): void {
  let interp = fresh();
  let cellNo = 0;

  const send = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\n"); };
  const stream = (name: "stdout" | "stderr", text: string): void => send({ stream: name, text });

  function fresh(): Interpreter {
    return new Interpreter({
      // Jupyter renders ANSI, so diagnostics keep their colour.
      color: true,
      grants: (process.env["HALKA_GRANTS"] ?? "").split(",").filter(Boolean),
      out: (s) => stream("stdout", s + "\n"),
      err: (s) => stream("stderr", s + "\n"),
    });
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      return; // a torn line is the front end's problem, not a reason to die
    }
    try {
      send({ id: req.id, ...handle(req) });
    } catch (e) {
      // The front end is waiting on this id, so it always gets an answer.
      send({ id: req.id, status: "error", ename: "internal", evalue: String(e), traceback: [String(e)] });
    }
  });
  rl.on("close", () => process.exit(0));

  function handle(req: Request): Record<string, unknown> {
    switch (req.kind) {
      case "reset":
        interp = fresh();
        cellNo = 0;
        return { status: "ok" };

      case "is_complete": {
        const src = req.code ?? "";
        const { diags } = parse(src, "<cell>");
        if (!diags.hasErrors) return { status: "complete" };
        if (looksUnfinished(src)) return { status: "incomplete", indent: "    " };
        return { status: "invalid" };
      }

      case "complete": {
        const src = req.code ?? "";
        const cursor = req.cursor ?? src.length;
        const before = src.slice(0, cursor);
        const prefix = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? "";
        // After a dot the candidates are that module's members, not every
        // name in scope — offering globals there would be plainly wrong.
        const dotted = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(before);
        const pool = dotted
          ? [...(PRELUDE_MODULES.get(dotted[1]!)?.keys() ?? [])]
          : [...new Set([...interp.globals.allNames(), ...EXTRA_COMPLETIONS])];
        const matches = pool.filter((n) => n.startsWith(prefix)).sort();
        return { status: "ok", matches, start: cursor - prefix.length, end: cursor };
      }

      case "inspect": {
        const name = req.code ?? "";
        const b = interp.globals.lookup(name);
        if (!b) return { status: "ok", found: false };
        return { status: "ok", found: true, text: `${name} : ${inspect(b.value)}` };
      }

      case "exec":
        return exec(req.code ?? "");
    }
  }

  function exec(src: string): Record<string, unknown> {
    cellNo += 1;
    const name = `<cell ${cellNo}>`;
    const sources = new Map([[name, src]]);
    const { module, diags } = parse(src, name);
    if (diags.hasErrors) return fail("SyntaxError", renderAll(diags.items, { color: true, sources }));

    try {
      const v = evalSnippet(interp, module);
      // A cell's value is its result, the way a notebook expects; a
      // statement-only cell has none and shows nothing.
      if (v && v.t !== "nothing") return { status: "ok", value: inspect(v) };
      return { status: "ok" };
    } catch (e) {
      if (e instanceof HalkaRuntimeError) {
        const rendered = renderAll(
          [{ code: e.code, severity: "error", message: e.msg, span: e.span ?? anonSpan(name) }],
          { color: true, sources },
        );
        const trace = e.trace.length ? "\ncall stack (innermost last):\n" + e.trace.map((f) => `  ${f}`).join("\n") : "";
        return fail(e.code, rendered + trace);
      }
      if (e instanceof HalkaError) return fail("error", renderAll(e.diagnostics, { color: true, sources }));
      return fail("error", String(e));
    }
  }

  function fail(ename: string, text: string): Record<string, unknown> {
    return { status: "error", ename, evalue: firstLine(text), traceback: text.split("\n") };
  }
}

/** A span for an error the runtime raised with no source position of its own. */
function anonSpan(file: string): Span {
  const p = { offset: 0, line: 1, col: 1 };
  return { file, start: p, end: p };
}

function firstLine(s: string): string {
  // Strip colour so the one-line summary Jupyter puts in the error header
  // does not carry a half-open escape sequence.
  const plain = s.split("\n")[0] ?? "";
  return plain.replace(/\u001b\[[0-9;]*m/g, "");
}
