"""Jupyter kernel front end for Halka.

This half exists only because Jupyter's wire protocol is ZeroMQ with
HMAC-signed multipart messages across five sockets. `ipykernel` already
implements all of it and ships with every Jupyter install, so inheriting from
it costs nothing and keeps the compiler itself free of runtime dependencies.

Everything language-specific happens in `halka kernel host`, a long-lived
child process that holds the interpreter state between cells. One JSON object
per line goes each way; the host writes any number of `{"stream": ...}` lines
as a cell produces output, then one line carrying the request id, which ends
the reply.
"""

import json
import os
import queue
import shlex
import subprocess
import threading

from ipykernel.kernelbase import Kernel

__version__ = "0.1.0"


class HostGone(RuntimeError):
    """The execution host exited, so no further cell can be answered."""


class Host:
    """The `halka kernel host` child process, one request at a time."""

    def __init__(self, argv):
        self.argv = argv
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._next_id = 0
        # stderr is drained on its own thread: the host only writes to it when
        # something has gone wrong, and a full pipe would otherwise wedge it.
        self._stderr = queue.Queue()
        t = threading.Thread(target=self._drain_stderr, daemon=True)
        t.start()

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self._stderr.put(line)

    def request(self, payload, on_stream=None):
        """Send one request and return its reply, streaming output as it comes."""
        if self.proc.poll() is not None:
            raise HostGone(self._diagnosis())
        self._next_id += 1
        rid = self._next_id
        payload = dict(payload, id=rid)
        try:
            self.proc.stdin.write(json.dumps(payload) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, ValueError):
            raise HostGone(self._diagnosis())

        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise HostGone(self._diagnosis())
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue  # not ours to interpret
            if msg.get("id") == rid:
                return msg
            if "stream" in msg and on_stream is not None:
                on_stream(msg["stream"], msg.get("text", ""))

    def _diagnosis(self):
        lines = []
        while not self._stderr.empty():
            lines.append(self._stderr.get_nowait())
        detail = "".join(lines).strip()
        cmd = " ".join(shlex.quote(a) for a in self.argv)
        return f"the Halka execution host stopped ({cmd})" + (f"\n{detail}" if detail else "")

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def host_argv():
    """How to start the host. The kernelspec sets HALKA_HOST_CMD as JSON."""
    raw = os.environ.get("HALKA_HOST_CMD")
    if raw:
        return json.loads(raw)
    return ["halka", "kernel", "host"]


class HalkaKernel(Kernel):
    implementation = "halka"
    implementation_version = __version__
    language = "halka"
    language_version = "0.1.0"
    language_info = {
        "name": "halka",
        "mimetype": "text/x-halka",
        "file_extension": ".hk",
        # No Pygments lexer exists for Halka yet, so asking for one by name
        # would make nbconvert fail rather than fall back.
        "pygments_lexer": "text",
    }
    banner = "Halka — a compiled language you can run a cell at a time"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._host = None

    @property
    def host(self):
        if self._host is None:
            self._host = Host(host_argv())
        return self._host

    def _stream(self, name, text):
        self.send_response(self.iopub_socket, "stream", {"name": name, "text": text})

    def _fatal(self, exc):
        self._stream("stderr", str(exc) + "\n")
        self._host = None  # the next cell gets a fresh attempt
        return {
            "status": "error",
            "execution_count": self.execution_count,
            "ename": "HostGone",
            "evalue": str(exc),
            "traceback": str(exc).split("\n"),
        }

    def do_execute(self, code, silent, store_history=True,
                   user_expressions=None, allow_stdin=False, *, cell_id=None):
        if not code.strip():
            return {"status": "ok", "execution_count": self.execution_count,
                    "payload": [], "user_expressions": {}}
        try:
            reply = self.host.request(
                {"kind": "exec", "code": code},
                on_stream=None if silent else self._stream,
            )
        except HostGone as e:
            return self._fatal(e)

        if reply.get("status") == "error":
            err = {
                "ename": reply.get("ename", "error"),
                "evalue": reply.get("evalue", ""),
                "traceback": reply.get("traceback", []),
            }
            if not silent:
                self.send_response(self.iopub_socket, "error", err)
            return dict(err, status="error", execution_count=self.execution_count)

        value = reply.get("value")
        if value is not None and not silent:
            self.send_response(self.iopub_socket, "execute_result", {
                "execution_count": self.execution_count,
                "data": {"text/plain": value},
                "metadata": {},
            })
        return {"status": "ok", "execution_count": self.execution_count,
                "payload": [], "user_expressions": {}}

    def do_complete(self, code, cursor_pos):
        try:
            reply = self.host.request({"kind": "complete", "code": code, "cursor": cursor_pos})
        except HostGone:
            return {"status": "ok", "matches": [], "cursor_start": cursor_pos,
                    "cursor_end": cursor_pos, "metadata": {}}
        return {
            "status": "ok",
            "matches": reply.get("matches", []),
            "cursor_start": reply.get("start", cursor_pos),
            "cursor_end": reply.get("end", cursor_pos),
            "metadata": {},
        }

    def do_is_complete(self, code):
        try:
            reply = self.host.request({"kind": "is_complete", "code": code})
        except HostGone:
            return {"status": "unknown"}
        out = {"status": reply.get("status", "unknown")}
        if out["status"] == "incomplete":
            out["indent"] = reply.get("indent", "    ")
        return out

    def do_inspect(self, code, cursor_pos, detail_level=0, omit_sections=()):
        word = _word_at(code, cursor_pos)
        if not word:
            return {"status": "ok", "found": False, "data": {}, "metadata": {}}
        try:
            reply = self.host.request({"kind": "inspect", "code": word})
        except HostGone:
            return {"status": "ok", "found": False, "data": {}, "metadata": {}}
        if not reply.get("found"):
            return {"status": "ok", "found": False, "data": {}, "metadata": {}}
        return {"status": "ok", "found": True,
                "data": {"text/plain": reply.get("text", "")}, "metadata": {}}

    def do_shutdown(self, restart):
        if self._host is not None:
            self._host.close()
            self._host = None
        return {"status": "ok", "restart": restart}


def _word_at(code, pos):
    start = pos
    while start > 0 and (code[start - 1].isalnum() or code[start - 1] == "_"):
        start -= 1
    end = pos
    while end < len(code) and (code[end].isalnum() or code[end] == "_"):
        end += 1
    return code[start:end]


if __name__ == "__main__":
    from ipykernel.kernelapp import IPKernelApp

    IPKernelApp.launch_instance(kernel_class=HalkaKernel)
