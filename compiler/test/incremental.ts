// Incremental builds: the stamp that decides whether work can be skipped.
//
// A build cache is only as good as its worst miss. Skipping a build that
// should have happened hands someone a stale binary and costs an afternoon,
// so the interesting cases here are all the ones where the stamp *must*
// change — a dependency edited, a flag added, the compiler upgraded, the
// runtime touched. The one where it must not is easy and tested last.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { stampFor, isUpToDate, writeStamp } from "../src/cli/stamp.ts";

function inputs(over: Partial<Parameters<typeof stampFor>[0]> = {}) {
  return {
    sources: new Map([["/p/app.hk", "main(),\n    say 1\n"]]),
    flags: ["--release"],
    version: "0.1.0",
    ...over,
  };
}

export function suiteIncremental(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
): void {
  const check = (name: string, cond: boolean, detail: string): void => {
    if (cond) ok("incremental", name); else bad("incremental", name, detail);
  };

  const base = stampFor(inputs());
  check("the same inputs give the same stamp", stampFor(inputs()) === base, "not deterministic");

  // Each of these must produce a different binary, so each must miss.
  const differs: [string, ReturnType<typeof inputs>][] = [
    ["a source edit", inputs({ sources: new Map([["/p/app.hk", "main(),\n    say 2\n"]]) })],
    ["a dependency edit", inputs({
      sources: new Map([["/p/app.hk", "main(),\n    say 1\n"], ["/p/dep.hk", "f(),\n    give 1\n"]]),
    })],
    ["a flag added", inputs({ flags: ["--release", "--fast-math"] })],
    ["a flag removed", inputs({ flags: [] })],
    ["a different target", inputs({ flags: ["--release", "target=x86_64-linux-gnu"] })],
    // A new compiler emits different C from identical source, so the
    // version has to be in the stamp or an upgrade silently does nothing.
    ["a compiler upgrade", inputs({ version: "0.2.0" })],
  ];
  for (const [name, i] of differs) {
    check(`${name} changes the stamp`, stampFor(i) !== base, "stamp unchanged");
  }

  // Flag order is not meaningful, so it must not force a rebuild.
  check("flag order does not matter",
    stampFor(inputs({ flags: ["--fast-math", "--release"] }))
      === stampFor(inputs({ flags: ["--release", "--fast-math"] })),
    "order changed the stamp");
  // Nor does the order modules happened to be discovered in.
  const a = new Map([["/p/a.hk", "x"], ["/p/b.hk", "y"]]);
  const b = new Map([["/p/b.hk", "y"], ["/p/a.hk", "x"]]);
  check("module discovery order does not matter",
    stampFor(inputs({ sources: a })) === stampFor(inputs({ sources: b })),
    "insertion order changed the stamp");

  // And the on-disk half: a stamp is only trusted next to a real binary.
  const dir = mkdtempSync(join(tmpdir(), "halka-inc-"));
  try {
    const out = join(dir, "prog.exe");
    check("no binary means not up to date", !isUpToDate(out, base), "claimed up to date with no binary");
    writeFileSync(out, "binary");
    check("no stamp means not up to date", !isUpToDate(out, base), "claimed up to date with no stamp");
    writeStamp(out, base);
    check("binary and matching stamp is up to date", isUpToDate(out, base), "should have been up to date");
    check("a different stamp is not", !isUpToDate(out, stampFor(inputs({ flags: [] }))), "stale stamp accepted");
    // An interrupted link leaves an empty file behind.
    writeFileSync(out, "");
    check("an empty binary is not up to date", !isUpToDate(out, base), "empty binary accepted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
