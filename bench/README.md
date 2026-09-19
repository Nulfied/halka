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

Best of 7 runs, wall clock including process start.

| kernel | measures | Halka | C `/O2` | Python | vs C | vs Python |
|---|---|---|---|---|---|---|
| `fib` | recursive calls, `fib(35)` | **153 ms** | 141 ms | 9 344 ms | **1.08x** | 61x faster |
| `loop` | integer arithmetic, 200M iterations | **424 ms** | 349 ms | 26 606 ms | **1.21x** | 63x faster |
| `mandel` | floating point, 900×900×500 | **593 ms** | 638 ms | 39 158 ms | **0.93x** | 66x faster |

All three implementations produce identical output; the harness asserts it
before printing any timing.

### Reading these honestly

- **The ratios move between runs, and the absolute times move with them.**
  An earlier best-of-5 on this machine recorded Halka at 158 / 452 / 660 ms
  against C at 157 / 389 / 702 ms — `fib` at 1.01x and `loop` at 1.16x. In the
  best-of-7 above *both* sides got faster and C gained more, so the ratio grew
  while Halka's own times fell. Before reading that as a regression we diffed
  the generated C against the previous commit: `fib`, `sum_to` and `total` are
  **byte-identical**, and the only change anywhere is the single `say` after
  the timed section. The codegen did not change; the machine did. This is the
  kind of thing a ratio hides and an absolute number exposes, which is why
  both are printed.

- **`fib` near 1.0x** is the expected result, not a lucky one. The generated C
  for `fib` is the same code a person would write, so it compiles to the same
  instructions. An earlier version of this benchmark used `fib(32)`, which runs
  in ~50 ms — short enough that process startup dominated and the numbers
  swung between 0.67x and 1.15x run to run. The workload was raised until the
  measurement was stable. **Treat any sub-100 ms benchmark result, here or
  anywhere, as noise.**

- **`mandel` under 1.0x is a tie, not a win.** Repeated runs put Halka on
  either side of the hand-written C (0.93x–1.04x across the runs recorded so
  far). The honest conclusion is **parity**. Reporting the 0.93x on its own
  would be a flattering way to describe a tie. Expect roughly ±10%
  run-to-run variance on this machine.

- **`loop`'s gap is real and explainable, and it is a correctness cost, not
  an inefficiency.** Halka's `%` is *floored*: the sign of the result
  follows the divisor, so `-7 % 3` is `2` and the identity
  `div(a,b)*b + a%b == a` holds for every sign. C's `%` truncates, so `-7 % 3`
  is `-1` and the identity does not hold. Halka emits a sign correction that C
  does not, and that is the gap. We could match C exactly by truncating; we
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
- **Memory is freed now.** Escape analysis (M4) turns the ownership proof into
  deallocation, and the runtime counts live heap objects so the test suite can
  assert it: every compiled program in this repo ends with **zero** live
  objects. Run any binary with `HALKA_REPORT_LEAKS=1` to see its own count.
  None of the kernels above allocate in their hot loop, so this does not move
  their numbers either way.

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
