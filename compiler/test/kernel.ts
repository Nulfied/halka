// The Jupyter kernel's execution host, driven the way the Python front end
// drives it. The front end needs `ipykernel` and a notebook to be worth
// testing; this half is pure stdio, so it can be tested anywhere — and it is
// the half that holds the interpreter state, which is where cell-to-cell
// behaviour can actually break.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "halka.mjs");

interface Reply { id: number; status?: string; value?: string; [k: string]: unknown }

/** One `halka kernel host`, with the same line discipline the front end uses. */
class Host {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiting = new Map<number, (r: Reply) => void>();
  private nextId = 0;
  readonly streams: { name: string; text: string }[] = [];

  constructor() {
    this.proc = spawn(process.execPath, [CLI, "kernel", "host"], { stdio: "pipe" });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Reply & { stream?: string; text?: string };
        if (msg.stream) { this.streams.push({ name: msg.stream, text: msg.text ?? "" }); continue; }
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    });
  }

  request(payload: Record<string, unknown>): Promise<Reply> {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      // Generous, because a cold CI runner pays for type-stripping the
      // whole compiler on the first request.
      const timer = setTimeout(() => rej(new Error(`the host did not answer ${JSON.stringify(payload)}`)), 60000);
      this.waiting.set(id, (r) => { clearTimeout(timer); res(r); });
      this.proc.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
    });
  }

  exec(code: string): Promise<Reply> { return this.request({ kind: "exec", code }); }

  close(): void { this.proc.stdin.end(); this.proc.kill(); }
}

export async function runKernelTests(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
): Promise<void> {
  const h = new Host();
  const check = (name: string, cond: boolean, detail: string): void => {
    if (cond) ok("kernel", name); else bad("kernel", name, detail);
  };

  try {
    // A cell's value is its result.
    const r1 = await h.exec("1 + 2");
    check("value of a cell", r1.status === "ok" && r1.value === "3", `got ${JSON.stringify(r1)}`);

    // State carries between cells, which is the whole point of a kernel.
    await h.exec("let x: 10");
    const r2 = await h.exec("x * 4");
    check("state carries between cells", r2.value === "40", `got ${JSON.stringify(r2)}`);

    // A function defined in one cell is callable from the next.
    await h.exec("double(n: int): int,\n    give n * 2");
    const r3 = await h.exec("double(21)");
    check("a function defined in an earlier cell", r3.value === "42", `got ${JSON.stringify(r3)}`);

    // `say` is streamed, not folded into the value.
    const before = h.streams.length;
    const r4 = await h.exec('say "hello"');
    const streamed = h.streams.slice(before);
    check("say is streamed", r4.status === "ok" && streamed.some((s) => s.name === "stdout" && s.text === "hello\n"),
      `streams: ${JSON.stringify(streamed)}`);

    // A parse error is an error reply, not a crash, and the host survives it.
    const r5 = await h.exec("let : :");
    check("a parse error is reported", r5.status === "error", `got ${JSON.stringify(r5)}`);
    const r6 = await h.exec("x + 1");
    check("the host survives a bad cell", r6.value === "11", `got ${JSON.stringify(r6)}`);

    // A runtime error too, with the code the interpreter would have used.
    const r7 = await h.exec("[1, 2][9]");
    check("a runtime error is reported", r7.status === "error" && typeof r7.ename === "string" && r7.ename !== "internal",
      `got ${JSON.stringify(r7)}`);

    // Completion, including the member case.
    const c1 = await h.request({ kind: "complete", code: "dou", cursor: 3 });
    check("completes a user-defined name", (c1["matches"] as string[]).includes("double"), JSON.stringify(c1));
    const c2 = await h.request({ kind: "complete", code: "math.sq", cursor: 7 });
    const m2 = c2["matches"] as string[];
    check("completes a module member", m2.length > 0 && m2.every((n) => n.startsWith("sq")), JSON.stringify(c2));

    // `is_complete` decides whether a console keeps reading.
    const i1 = await h.request({ kind: "is_complete", code: "1 + 1" });
    check("a finished cell is complete", i1.status === "complete", JSON.stringify(i1));
    const i2 = await h.request({ kind: "is_complete", code: "f(a: int): int," });
    check("an unfinished cell is incomplete", i2.status === "incomplete", JSON.stringify(i2));

    // Reset clears the state, so a notebook's "restart kernel" means it.
    await h.request({ kind: "reset" });
    const r8 = await h.exec("x + 1");
    check("reset clears state", r8.status === "error", `got ${JSON.stringify(r8)}`);
  } finally {
    h.close();
  }

  frontEnd(ok, bad);
}

/**
 * The Python front end, with ipykernel stubbed out. Skipped where no Python
 * is installed, which is also a machine that cannot run Jupyter.
 */
function frontEnd(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
): void {
  const script = join(HERE, "..", "..", "tools", "jupyter", "test_front_end.py");
  for (const exe of [process.env["HALKA_PYTHON"], "python", "python3", "py"].filter(Boolean) as string[]) {
    const probe = spawnSync(exe, ["-c", "import sys"], { stdio: "ignore" });
    if (probe.status !== 0) continue;
    // Bounded, because that script blocks on a pipe: a host that wedges
    // should fail this suite, not stall CI until the job limit.
    const r = spawnSync(exe, [script, CLI], { encoding: "utf8", timeout: 180000 });
    if (r.status === 0) ok("kernel", "the Python front end");
    else bad("kernel", "the Python front end", r.error ? String(r.error) : (r.stdout ?? "") + (r.stderr ?? ""));
    return;
  }
  process.stdout.write("note: no Python found — the kernel front end was not tested" + String.fromCharCode(10));
}
