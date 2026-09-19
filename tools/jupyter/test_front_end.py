"""Test the Halka kernel front end without needing Jupyter installed.

`ipykernel` supplies the ZeroMQ transport, the message signing and the shell
loop; that code is theirs and already tested. What is ours is the piece in
between: starting the execution host, matching replies to requests, turning
streamed lines into iopub messages, and shaping the reply dicts. Stubbing the
base class lets all of that run against a real `halka kernel host`.

    python tools/jupyter/test_front_end.py [path-to-halka.mjs]
"""

import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

RESPONSES = []


def install_stub():
    """Stand in for ipykernel so the front end can be imported anywhere."""
    class Kernel:
        execution_count = 1
        iopub_socket = object()

        def __init__(self, **kwargs):
            pass

        def send_response(self, socket, msg_type, content):
            RESPONSES.append((msg_type, content))

    base = types.ModuleType("ipykernel.kernelbase")
    base.Kernel = Kernel
    pkg = types.ModuleType("ipykernel")
    pkg.kernelbase = base
    sys.modules.setdefault("ipykernel", pkg)
    sys.modules.setdefault("ipykernel.kernelbase", base)


def main():
    cli = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "compiler", "bin", "halka.mjs")
    if not os.path.exists(cli):
        print(f"not found: {cli}")
        return 1
    os.environ["HALKA_HOST_CMD"] = json.dumps(["node", cli, "kernel", "host"])

    install_stub()
    sys.path.insert(0, HERE)
    import halka_kernel

    k = halka_kernel.HalkaKernel()
    failures = []
    passes = []

    def check(name, cond, detail=""):
        if cond:
            passes.append(name)
            print(f"ok   {name}")
        else:
            failures.append(name)
            print(f"FAIL {name}\n     {detail}")

    try:
        r = k.do_execute("1 + 2", False)
        result = [c for t, c in RESPONSES if t == "execute_result"]
        check("a cell's value becomes an execute_result",
              r["status"] == "ok" and result and result[-1]["data"]["text/plain"] == "3",
              f"{r} {RESPONSES}")

        del RESPONSES[:]
        k.do_execute('say "hi"', False)
        streams = [c for t, c in RESPONSES if t == "stream"]
        check("say arrives as a stream message",
              any(s["name"] == "stdout" and s["text"] == "hi\n" for s in streams),
              str(RESPONSES))

        del RESPONSES[:]
        r = k.do_execute("let : :", False)
        errs = [c for t, c in RESPONSES if t == "error"]
        check("a bad cell reports an error",
              r["status"] == "error" and len(errs) == 1 and errs[0]["traceback"],
              f"{r} {RESPONSES}")

        del RESPONSES[:]
        r = k.do_execute("", False)
        check("an empty cell is a no-op", r["status"] == "ok" and not RESPONSES, str(RESPONSES))

        k.do_execute("let answer: 42", True)
        del RESPONSES[:]
        r = k.do_execute("answer", True)
        check("a silent cell still runs but shows nothing", r["status"] == "ok" and not RESPONSES, str(RESPONSES))

        c = k.do_complete("ans", 3)
        check("completion reaches the host", "answer" in c["matches"], str(c))

        i = k.do_is_complete("f(a: int): int,")
        check("an unfinished cell asks for more", i["status"] == "incomplete", str(i))

        d = k.do_inspect("answer", 3)
        check("inspect finds a bound name", d["found"], str(d))

        # The interesting failure: the host dies mid-session. The kernel must
        # report it and stay usable rather than hanging on a dead pipe.
        del RESPONSES[:]
        k.host.proc.kill()
        k.host.proc.wait()
        r = k.do_execute("1 + 1", False)
        check("a dead host is reported, not hung", r["status"] == "error" and r["ename"] == "HostGone", str(r))
        r = k.do_execute("1 + 1", False)
        check("the kernel recovers by restarting the host", r["status"] == "ok", str(r))
    finally:
        k.do_shutdown(False)

    print(f"\n{len(passes)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
