# Foreign function interface

Halka talks to C and to Python. Both are compiled features: `halka build`
produces a binary that links C directly and, when needed, embeds CPython.
`halka run` will tell you to build instead.

```
error[R0030]: `py` interop is a compiled feature — the reference interpreter
              cannot call PY code
  = help: build it instead: `halka build --release <file.hk>`
```

---

## C (#35)

The backend emits C99, so a C call is a C call. There is no binding generator
and no marshalling layer.

```halka
import c "math.h",
import c "stdio.h"

# Declaring the Halka side lets the checker verify the call.
c hypot(x: c double, y: c double): c double

say "hypot(3, 4) = {c hypot(3.0, 4.0)}"
c printf("from C: %d\n", 42)
```

```
hypot(3, 4) = 5.0
from C: 42
```

### How it works

| Halka | becomes |
|---|---|
| `import c "math.h"` | `#include <math.h>` |
| `import c "./vendor/thing.h"` | `#include "./vendor/thing.h"` |
| `c f(args)` | `f(args)` |
| `c struct Point:` | a reference to the existing `struct Point`, never a redefinition |
| `c double`, `c int`, `c size_t` … | exactly those C types |

A declaration with a return type also emits an `extern` prototype, so a symbol
with no header is still callable. A declaration **without** one is used only for
checking, and the header must supply the real prototype.

### Crossing the boundary

Halka scalars convert implicitly, because the target type is unambiguous:

| Halka | C |
|---|---|
| `int` | `int`, `long`, `size_t`, `int64_t`, … |
| `float` | `float`, `double` |
| `bool` | `bool`, `_Bool` |
| `string` | `const char *` — **no copy**; a Halka string is NUL-terminated |
| `raw *T` | `T *` |

A C scalar coming back prints and arithmetics like its Halka counterpart. The
checker rejects anything not in this table and asks for an explicit `as`.

### Linking

```halka
extern:
    link: "sqlite3"
```

`link` accepts several libraries, comma- or space-separated. The build passes
`-lsqlite3` (or `sqlite3.lib` on MSVC).

### If a declaration is wrong

The C compiler catches it, and Halka surfaces the warning rather than hiding it:

```
warning from the C compiler: warning C4133: 'function': incompatible types
  these usually mean a `c` declaration does not match the real symbol
```

This matters. An early version of this FFI emitted `extern hk_int hypot(hk_int, hk_int);`
for a function that really takes doubles. MSVC only warned, and `hypot(3, 4)`
returned `4294965466`. Silent warnings are how FFI bugs reach production, so
they are printed.

---

## Python (#37)

A Halka binary can embed CPython. Every Python object is a `py object` until
you say what it should become.

```halka
import py "math",
import py "builtins"
from py "statistics" import mean

say "sqrt   {py math.sqrt(2.0) as float}"
say "fact   {py math.factorial(6) as int}"
say "mean   {mean([1.0, 2.0, 3.0, 4.0]) as float}"
say "sorted {py builtins.sorted([3, 1, 2]) as list(int)}"
say "upper  {py builtins.str.upper("halka") as string}"
```

### Why the cast is required

Crossing **into** Python is implicit — a Halka `int` is unambiguously a Python
`int`. Crossing **back** is explicit with `as` (#15), because a Python value has
no static type and only the program knows what it expects. That is what keeps
the rest of the language statically typed while talking to a dynamic one.

| `as` target | conversion |
|---|---|
| `int`, `float`, `bool`, `string` | the obvious one; a failure panics with the Python traceback |
| `list(int)`, `list(float)` | any Python sequence |

`to` gives the fallible form and yields a `Result` — planned, not yet built.

### Attribute chains and bound names

`py a.b.c(x)` resolves the chain with `getattr` and calls the last attribute as
a method. `from py "m" import f` binds `f` so you can call it directly.

### Threads and the GIL

Every conversion and call takes the GIL for its own duration and releases it
immediately. Halka's own `parallel:` threads keep running on all cores; only
the Python work is serialised, and only while it runs.

That is the point of the whole design:

```halka
import py "numpy"

let data: list(float): py numpy.linspace(0.0, 6.28318, n) as list(float)

parallel:
    a: kernel(data, 0, q),
    b: kernel(data, q, q * 2),
    c: kernel(data, q * 2, q * 3),
    d: kernel(data, q * 3, n)
```

NumPy prepares the data; the hot loop is native and runs on every core.

Measured on this machine (`examples/ffi/wedge.hk` vs `examples/ffi/wedge.py`,
identical algorithm, same NumPy, same answer `167484.119655`):

| | Halka | Python |
|---|---|---|
| kernel, 1 thread | **224 ms** | 9 953 ms |
| kernel, 4 threads | **65 ms** | 20 745 ms |
| speedup from threads | **3.47x** | **0.48x** |

Python's threads made it *twice as slow*. Halka is 44x faster single-threaded
and **153x** faster with four threads, while still using NumPy for the parts
NumPy is good at.

### Requirements

The build needs CPython's development headers.

```bash
halka toolchain          # shows whether they were found
```

| platform | how |
|---|---|
| Debian / Ubuntu | `apt install python3-dev` |
| Fedora | `dnf install python3-devel` |
| macOS, Windows | included with the python.org installer |

Set `HALKA_PYTHON` to choose a specific interpreter. The prefix of the
interpreter linked against is baked into the binary, so it finds its standard
library without `PYTHONHOME` being set.

---

## C++ (#36)

Not implemented. `cpp` parses and produces `E0716`. It needs a generated shim
that exposes C++ names through a C ABI and converts exceptions into `Result`.

---

## What is not done yet

- `to` across a foreign boundary (the `Result`-yielding form).
- Passing Halka functions to C as callbacks (`callback`, `extern`, #38).
- Structs by value across the boundary.
- C++ entirely.
- Python: dicts, keyword arguments, and iterating a Python object.
