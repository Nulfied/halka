# Halka benchmarks

> Reproduce everything here with `node bench/run.mjs`. It builds each kernel,
> checks that all three implementations print the same answer, and refuses to
> report timings if they disagree.

The claim being tested is **not** "faster than Python". Any compiled language
beats an interpreted, GIL-locked one; that is table stakes, and Python's
numeric ecosystem routes around it by calling into C anyway.

The claim is the one that matters for the workloads Halka targets:

> **As fast as hand-written C, without the memory-safety and build-system pain,
> and with parallelism Python structurally cannot offer.**

---

## Results

Measured on Windows 11, x86-64, 8 logical cores (4 physical + SMT).
Halka and C were compiled by **the same compiler with the same flags**
(MSVC 19.36, `/O2 /DNDEBUG`), so this measures the quality of the code Halka
*generates*, not the compiler underneath it. Python 3.10.11, CPython.

Best of 5 runs, wall clock including process start.

| kernel | measures | Halka | C `/O2` | Python | vs C | vs Python |
|---|---|---|---|---|---|---|
| `fib` | recursive calls, `fib(35)` | **158 ms** | 157 ms | 9 660 ms | **1.01x** | 61x faster |
| `loop` | integer arithmetic, 200M iterations | **452 ms** | 389 ms | 27 906 ms | **1.16x** | 62x faster |
| `mandel` | floating point, 900×900×500 | **660 ms** | 702 ms | 40 423 ms | **0.94–1.04x** | 61x faster |

All three implementations produce identical output; the harness asserts it
before printing any timing.

### Reading these honestly

- **`fib` at 1.01x** is the expected result, not a lucky one. The generated C
  for `fib` is the same code a person would write, so it compiles to the same
  instructions. An earlier version of this benchmark used `fib(32)`, which runs
  in ~50 ms — short enough that process startup dominated and the numbers
  swung between 0.67x and 1.15x run to run. The workload was raised until the
  measurement was stable. **Treat any sub-100 ms benchmark result, here or
  anywhere, as noise.**

- **`mandel` at 0.94–1.04x** — repeated runs put Halka on either side of the
  hand-written C. The honest conclusion is **parity**, not superiority. A single
  run showing 0.94x would be a flattering way to report a tie, so the range is
  given instead. Expect roughly ±10% run-to-run variance on this machine.

- **`loop` at 1.16x is a real, explainable gap, and it is a correctness cost,
  not an inefficiency.** Halka's `%` is *floored*: the sign of the result
  follows the divisor, so `-7 % 3` is `2` and the identity
  `div(a,b)*b + a%b == a` holds for every sign. C's `%` truncates, so `-7 % 3`
  is `-1` and the identity does not hold. Halka emits a sign correction that C
  does not, and that is the 16%. We could match C exactly by truncating; we
  would rather be right about negative numbers. When the compiler can prove an
  operand is non-negative the correction will be elided, which is a planned
  optimisation, not a change of semantics.

---

## Parallelism: what the GIL costs

`bench/gil.hk` and `bench/gil.py` run an identical Mandelbrot workload
(300×300, 200 iterations) single-threaded, then split across 8 threads.

```
halka  1 thread :   45 ms
halka  8 threads:   14 ms   speedup 3.20x   <- real cores

python 1 thread : 1863 ms
python 8 threads: 3681 ms   speedup 0.51x   <- the GIL
```

Both produce `4239790`.

Halka gets **3.2x** from 8 logical cores (4 physical), which is close to the
ceiling for this machine. Python gets **0.51x** — adding threads made it
*twice as slow*, because pure-Python threads cannot execute bytecode
concurrently and the GIL hand-off is pure overhead.

That is the gap the AI/ML wedge lives in. It is not a tuning difference, and no
amount of Python optimisation closes it; it is structural. The usual answer is
`multiprocessing`, which buys real cores at the price of process startup and
serialising every value across the boundary.

End to end on this workload: Halka is **41x** faster single-threaded and
**263x** faster with 8 threads.

Halka's `parallel:` block (#32) lowers to real OS threads — `hk_spawn` /
`hk_join` in the generated C. There is no interpreter lock anywhere in the
runtime, and the memory model (see [`spec/MEMORY-MODEL.md`](../spec/MEMORY-MODEL.md))
prevents data races statically rather than documenting them.

---

## What is *not* being claimed

- **These are microbenchmarks.** They measure code generation quality on scalar
  and floating-point kernels. They say nothing about allocation-heavy,
  string-heavy, or I/O-bound programs, and Halka's v1 backend is not yet tuned
  for those.
- **Halka is not faster than NumPy or PyTorch.** Those are C and CUDA with a
  Python interface. The comparison against CPython above is a comparison
  against *pure Python*, which is what people write around those libraries —
  the training loop, the data munging, the custom kernel — and it is exactly
  where Halka's wedge is.
- **The native backend compiles a subset of the language today.** Scalars,
  strings, lists, structs, functions, control flow, `defer`, and `parallel:`.
  Match, enums, maps, and tasks run under `halka run` and will be added to the
  backend; the compiler tells you which it is with an `E07xx` diagnostic rather
  than silently producing something slow.
- **Memory is not yet freed by the v1 backend** for heap values the compiler
  cannot prove local. It is memory-*safe* (no use-after-free is possible) but
  not yet memory-*efficient*. Ownership-driven release lands with the borrow
  checker. None of the kernels above allocate in their hot loop.

---

## Running them

```bash
node bench/run.mjs                # everything
node bench/run.mjs fib mandel     # selected kernels
node bench/run.mjs --runs 9       # more samples

# the GIL comparison
halka build --release bench/gil.hk -o bench/gil && ./bench/gil
python bench/gil.py
```

Requires a C compiler (`cc`, `gcc`, `clang`, `zig cc`, or MSVC). Run
`halka toolchain` to see what was found.
