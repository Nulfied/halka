// Evaluating one snippet against a live interpreter.
//
// The REPL and the Jupyter kernel differ in how they get the text and how
// they show the result, not in how they run it, so they share this. Each
// snippet is hoisted into the same global scope, which is what makes a name
// defined in one cell visible in the next.

import { Interpreter } from "../interp/interpreter.ts";
import { NOTHING, type Value } from "../runtime/value.ts";
import type * as A from "../parser/ast.ts";

/** Evaluate a snippet in the persistent global scope and give its value. */
export function evalSnippet(interp: Interpreter, mod: A.Module): Value {
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

/**
 * Whether a snippet is worth waiting on more input for. A trailing `,` or
 * `:` is V49's continuation, and an unclosed bracket obviously continues, so
 * the caller can keep reading instead of reporting a parse error the user is
 * halfway through fixing.
 */
export function looksUnfinished(src: string): boolean {
  const lines = src.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  if (!last) return false;
  if (/[,:([{]\s*$/.test(last)) return true;
  // Inside an indented block: a further indented line is still to come.
  return lines.length > 1 && /^\s+\S/.test(last);
}
