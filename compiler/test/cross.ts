// Cross-compilation: the flags, not the compile.
//
// `--target` needs a toolchain that carries the target's own headers and
// libraries, which in practice means `zig cc`. Most machines do not have
// one — the machine this was written on had only MSVC — so an end-to-end
// cross build cannot be part of the suite. What can be is the part that was
// actually written here: which compiler gets chosen, and what it is asked
// to do. Shipping that untested is how a feature turns out broken on the
// one machine that tries it.

import { unixFlags, targetsWindows, findToolchain, type CompileOpts } from "../src/backend/c/build.ts";

function opts(over: Partial<CompileOpts> = {}): CompileOpts {
  return { release: true, includeDirs: ["/w"], objDir: "/w", ...over };
}

export function suiteCross(
  ok: (suite: string, name: string) => void,
  bad: (suite: string, name: string, detail: string) => void,
): void {
  const check = (name: string, cond: boolean, detail: string): void => {
    if (cond) ok("cross", name); else bad("cross", name, detail);
  };

  // The triple reaches the driver, and only when one was asked for.
  const linux = unixFlags(["a.c"], "out", opts({ target: "x86_64-linux-gnu" }));
  check("the target reaches the driver",
    linux.join(" ").includes("-target x86_64-linux-gnu"), linux.join(" "));
  check("no target flag without a target",
    !unixFlags(["a.c"], "out", opts()).includes("-target"), "unexpected -target");

  // Threading follows the target, not the machine running the build. Getting
  // this from the host would put `-pthread` on a Windows cross build and
  // leave it off a Linux one made from Windows.
  check("a linux target is linked with pthread", linux.includes("-pthread"), linux.join(" "));
  const win = unixFlags(["a.c"], "out", opts({ target: "x86_64-windows-gnu" }));
  check("a windows target is not", !win.includes("-pthread"), win.join(" "));
  check("windows targets are recognised",
    targetsWindows("x86_64-windows-gnu") && targetsWindows("aarch64-windows-msvc")
      && !targetsWindows("x86_64-linux-musl") && !targetsWindows("aarch64-macos"),
    "triple classification");

  // The safety flags are not dropped on the way to another platform.
  for (const f of ["-Werror=implicit-function-declaration", "-Werror=incompatible-pointer-types"]) {
    check(`${f} survives a cross build`, linux.includes(f), linux.join(" "));
  }
  check("release still optimises when cross-building", linux.includes("-O2"), linux.join(" "));

  // MSVC builds for this machine only. Asking it for another target has to
  // fail with an explanation rather than produce a binary for the wrong one.
  if (process.platform === "win32") {
    const native = findToolchain();
    const cross = findToolchain("x86_64-linux-gnu");
    check("msvc is not offered for a cross build",
      !cross || cross.kind !== "msvc",
      `chose ${cross?.name ?? "nothing"} for a cross build (native is ${native?.name ?? "nothing"})`);
  }
}
