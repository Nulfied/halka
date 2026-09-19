# Halka in Jupyter

A notebook kernel, so Halka can be tried a cell at a time next to the Python
people already run.

## Install

```
halka kernel install
```

That writes a kernelspec into your Jupyter data directory and prints where.
Start Jupyter and pick **Halka** from the kernel list.

The front end needs `ipykernel`, which every Jupyter install already has; if
`halka kernel install` warns that the Python it found does not have it:

```
python -m pip install ipykernel
```

Set `HALKA_PYTHON` to choose a different interpreter. To remove the kernel,
delete the directory the install command printed.

## How it works, and why

Jupyter's wire protocol is ZeroMQ: five sockets, multipart messages, each one
HMAC-signed. Speaking it from Node would mean either a native dependency or
implementing ZMTP by hand, and this compiler has no runtime dependencies at
all. So the kernel is two processes:

| | |
|---|---|
| `tools/jupyter/halka_kernel.py` | inherits the whole protocol from `ipykernel` |
| `halka kernel host` | holds the interpreter state and runs cells |

They talk over stdio: one JSON object per line, each way. The host writes any
number of `{"stream": ...}` lines as a cell produces output, then one line
carrying the request's `id`, which ends the reply. The kernelspec records the
absolute path of the `halka` that installed it, so a notebook runs the
compiler you meant rather than whatever PATH resolves to later.

## What a cell does

A cell is evaluated in one persistent global scope, so a name defined in one
cell is visible in the next — the same scope `halka repl` uses.

```halka
import math

square(n: int): int,
    give n * n
```

```halka
square(12)          # 144 — a cell's last expression is its result
say "and this is streamed as it happens"
```

Errors come back as Jupyter errors with the compiler's own rendering, colour
included. Tab completion offers names in scope, keywords, and — after a dot —
that prelude module's members. Restarting the kernel clears the scope.

## What it does not do yet

- **Cells are interpreted, not compiled.** The point of the notebook is the
  edit-run loop; `halka build` is what makes a program fast. A cell that calls
  into a compiled module is the obvious next step and is not built.
- **Interrupting a running cell** does not stop it. The host runs one cell at
  a time and does not yet watch for an interrupt.
- **No rich display.** Everything is `text/plain`. Plots would mean a display
  protocol Halka does not have.
- **`import` reaches the prelude and local modules**, the same as `halka run`
  from the notebook's directory.

## Testing it

`npm test` covers the host over its real stdio protocol, and runs
`tools/jupyter/test_front_end.py` when a Python is present — that one stubs
out `ipykernel` so the front end's own logic (starting the host, matching
replies, streaming, surviving a host that dies) is tested without needing
Jupyter installed. What is not covered here is `ipykernel` itself, which is
not ours to test.
