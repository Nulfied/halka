// `halka kernel install` — registering the Jupyter kernel.
//
// A kernelspec is a directory holding a `kernel.json` that says how to start
// the kernel. Ours starts the Python front end (tools/jupyter/halka_kernel.py)
// and tells it, through the environment, exactly which Halka to execute with
// — the one that installed the spec, not whatever happens to be on PATH.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface KernelPython {
  exe: string;
  hasIpykernel: boolean;
  dataDir: string | null;
}

/**
 * A Python that can host the kernel. This is a looser probe than the one the
 * `py` boundary uses: the kernel needs `ipykernel`, not the C headers.
 */
export function findKernelPython(): KernelPython | null {
  // It reports `sys.executable` rather than the name we tried, because
  // Jupyter may start the kernel with a different PATH than the shell that
  // installed it — and `py` on Windows is a launcher, not an interpreter.
  const probe = [
    "import json,sys",
    "d=None",
    "try:",
    "    import jupyter_core.paths as p; d=p.jupyter_data_dir()",
    "except Exception: pass",
    "try:",
    "    import ipykernel; k=True",
    "except Exception: k=False",
    "print(json.dumps({'exe':sys.executable,'ipykernel':k,'data':d}))",
  ].join("\n");

  for (const cand of [process.env["HALKA_PYTHON"], "python", "python3", "py"].filter(Boolean) as string[]) {
    try {
      const out = execFileSync(cand, ["-c", probe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(out.trim()) as { exe: string; ipykernel: boolean; data: string | null };
      return { exe: j.exe || cand, hasIpykernel: j.ipykernel, dataDir: j.data };
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Where Jupyter looks for kernels when Python could not be asked. */
function defaultDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "jupyter");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Jupyter");
  const xdg = process.env["XDG_DATA_HOME"];
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share"), "jupyter");
}

/** The front-end script, whether running from a checkout or an install. */
export function frontEndPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [
    ["..", "..", "..", "tools", "jupyter", "halka_kernel.py"], // src/cli -> repo root
    ["..", "..", "tools", "jupyter", "halka_kernel.py"],       // dist layout
  ]) {
    const p = resolve(here, ...rel);
    if (existsSync(p)) return p;
  }
  return resolve(here, "..", "..", "..", "tools", "jupyter", "halka_kernel.py");
}

export interface InstallResult {
  dir: string;
  python: string;
  warning?: string;
}

/**
 * Write the kernelspec. `hostCmd` is how the front end should start the
 * execution host — the running `halka` itself, so a checkout and a global
 * install do not fight over which one a notebook gets.
 */
export function installKernelspec(hostCmd: string[]): InstallResult {
  const py = findKernelPython();
  if (!py) {
    throw new Error(
      "no Python found — the Jupyter kernel's front end needs one\n" +
      "  Jupyter itself is written in Python, so a machine that can run notebooks has one.\n" +
      "  Set HALKA_PYTHON to point at it.",
    );
  }

  const script = frontEndPath();
  if (!existsSync(script)) {
    throw new Error(`the kernel front end is missing: ${script}`);
  }

  const dir = join(py.dataDir ?? defaultDataDir(), "kernels", "halka");
  mkdirSync(dir, { recursive: true });
  const spec = {
    argv: [py.exe, script, "-f", "{connection_file}"],
    display_name: "Halka",
    language: "halka",
    // JSON inside JSON because a kernelspec's env values must be strings.
    env: { HALKA_HOST_CMD: JSON.stringify(hostCmd) },
  };
  writeFileSync(join(dir, "kernel.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");

  return {
    dir,
    python: py.exe,
    warning: py.hasIpykernel ? undefined : `${py.exe} has no \`ipykernel\` — install it with \`${py.exe} -m pip install ipykernel\``,
  };
}
