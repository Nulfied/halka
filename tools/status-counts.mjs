// Keep STATUS.md's tally honest by deriving it from STATUS.md's own table.
//
//   node tools/status-counts.mjs           report
//   node tools/status-counts.mjs --write   rewrite the line
//   node tools/status-counts.mjs --check   fail if it is stale (CI)
//
// The line said "16 done, 12 partial, 23 not started" while the table held
// 16, 18 and 13. Nobody had lied; the table had been edited row by row over
// months and the summary above it had not, which is what a hand-maintained
// count does. The same reasoning as the registry index: a number that can
// be derived should never be stored.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "STATUS.md");
const MARKS = [
  ["✅", "done"],
  ["\u{1F7E1}", "partial"],
  ["⬜", "not started"],
  ["\u{1F517}", "ecosystem"],
];

const text = readFileSync(FILE, "utf8");
const counts = new Map(MARKS.map(([, name]) => [name, 0]));
let rows = 0;
const unmarked = [];
for (const line of text.split(/\r?\n/)) {
  const m = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|/.exec(line);
  if (!m) continue;
  rows++;
  const cell = m[3].trim();
  // A row mid-move is written `🟡→🔗`; it counts as where it is now.
  const mark = MARKS.find(([sym]) => cell.startsWith(sym));
  if (mark) counts.set(mark[1], counts.get(mark[1]) + 1);
  // One row carries `—`: the organising principle is not a feature and has
  // no state to be in. Anything else unmarked is a typo in a symbol, which
  // would otherwise vanish from the tally without a trace.
  else unmarked.push(`${m[1]} (${m[2].trim()}): ${JSON.stringify(cell)}`);
}
if (unmarked.length > 1) {
  process.stderr.write(`rows with no status:\n  ${unmarked.join("\n  ")}\n`);
  process.exit(1);
}

const want = `Counts today: **${MARKS.map(([, n]) => `${counts.get(n)} ${n}`).join(" · ")}**`;
const line = /^Counts today: \*\*.*\*\*$/m;
const have = line.exec(text)?.[0];

if (process.argv.includes("--write")) {
  writeFileSync(FILE, text.replace(line, want));
  process.stdout.write(`${want}   (${rows} rows)\n`);
} else if (process.argv.includes("--check")) {
  if (have === want) {
    process.stdout.write(`the counts match the table: ${want}\n`);
  } else {
    process.stdout.write(`::error::STATUS.md's counts do not match its table.%0Ahave: ${have}%0Awant: ${want}\n`);
    process.stderr.write(`have: ${have}\nwant: ${want}\nRun: node tools/status-counts.mjs --write\n`);
    process.exit(1);
  }
} else {
  process.stdout.write(`${rows} rows\nhave: ${have}\nwant: ${want}\n`);
}
