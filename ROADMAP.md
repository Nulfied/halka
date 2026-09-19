# Halka Roadmap

The syntax is locked. This document is about everything else: making Halka fast,
making it self-hosted, and giving it the ecosystem a language needs to survive.

It is written as a sequence of shipped artefacts, not dates. Every item is
achievable with free tooling and free infrastructure.

---

## Where we are

**v0.2 — it compiles, and it is fast.**

Shipped: the locked spec implemented end to end; static type inference with
optional tracking and match exhaustiveness; a reference interpreter covering
the whole language including tasks, channels and macros; and a **native backend
that emits C99 and produces binaries at parity with hand-written C**.

Measured, same compiler and flags for both, all outputs identical:

| kernel | Halka | C `/O2` | Python | vs C |
|---|---|---|---|---|
| recursive calls, `fib(35)` | 158 ms | 157 ms | 9 660 ms | 1.01x |
| integer arithmetic, 200M | 452 ms | 389 ms | 27 906 ms | 1.16x |
| floating point, 900×900 | 660 ms | 702 ms | 40 423 ms | ~1.0x |

And the parallelism the wedge depends on: 3.20x from 8 threads, where the same
workload in Python threads runs at 0.51x — *slower* than one thread.
See [bench/README.md](bench/README.md).

The reference interpreter stays as the oracle. R23 makes them one language:
the native tests compile each case and diff its output against the interpreter.

---

## The wedge, and what is left to build it

Interop, don't replace. Win one pain point measurably. Ship one benchmarkable
artifact. Meet people in the tools they already use.

Two of the four pain points are now demonstrated rather than claimed —
**C-level speed** and **real multicore parallelism**. These are what remains.

## v0.3 — Ownership as a static pass

The memory model ([spec/MEMORY-MODEL.md](spec/MEMORY-MODEL.md)) is designed and
documented; the checker does not yet enforce it.

- **Move checking** (M1) — use-after-move becomes `E0504` at compile time, with
  the move site pointed at.
- **Borrow checking** (M2) — one `borrow mut` or many `borrow`, and a borrow may
  not escape its block. One scope-depth comparison, no lifetime annotations, no
  inference of lifetimes. This is the part that must stay small; if the error
  messages ever need a tutorial, the design has failed.
- **Task capture checking** (M5) — a task cannot capture a borrow, so data races
  are rejected rather than documented.
- **Escape analysis** (M4) — stack-allocate what does not outlive its frame, and
  free what does at the owner's scope exit. This is also what removes the v1
  backend's leak.
- **`shared(T)`** and the cycle warning.

This is the largest remaining correctness piece, and it is what turns "memory
safe by construction" from a design document into a compiler guarantee.

## v0.4 — The rest of the language, natively

The backend compiles scalars, strings, lists, structs, control flow, `defer`
and `parallel:`. Still interpreter-only:

- enums and `match` (tagged unions and a jump table)
- maps and sets
- tasks, channels, `await` — a work-stealing scheduler over the thread pool
- traits with dynamic dispatch, and monomorphised generics (#43 `specialize`
  becomes a hint the optimiser honours)
- closures over named functions as values (#17)

Each missing construct produces an `E07xx` diagnostic naming the expression, so
the boundary is always visible rather than silently slow.

## v0.5 — Interop, because nobody gives up their libraries

This is the actual adoption blocker, and with a C backend it is mostly wiring.

- **`c`** (#35) — direct C ABI calls, structs, callbacks. The generated source
  is C, so this is a declaration, not a marshalling layer.
- **`cpp`** (#36) — classes, methods, templates through a generated shim; C++
  exceptions converted to `Result` at the boundary.
- **`py`** (#37) — embed CPython, marshal both ways, **release the GIL around
  Halka tasks**. This is the on-ramp: NumPy, PyTorch, pandas and Hugging Face
  stay available while the hot loop around them is Halka, compiled, and
  parallel. Nobody has to choose.
- A **Jupyter kernel**, so trying Halka costs ten minutes rather than a rewrite.

## v0.6 — Self-hosting

Rewrite the compiler in Halka and compile it with itself. The Zig path exactly:
stage 0 in a host language, stage 1 in the language.

Not vanity — it is the only honest proof the language is good enough to write a
compiler in, and it turns every compiler contributor into a Halka programmer.
The stage-0 TypeScript implementation is retained as the specification oracle.

## v0.7 — The AI/ML layer

The locked syntax already reserves what this needs: `kernel`, `launch`, `device`
(#44), `parallel:` (#32), `compile` and `generate` (#39, #41).

- **Tensors in the standard library** — n-dimensional arrays with broadcasting,
  built on the slice syntax that #54 already locks, and parallel by default
  over the thread pool.
- **GPU backends** — `kernel` compiles to CUDA / ROCm / Vulkan compute / Metal;
  `launch f(x): blocks: 64, threads: 256` is already the locked spelling.
- **Automatic differentiation via `generate`** (#41) — compile-time source
  generation produces gradient functions, so autodiff is a library, not a
  language feature.
- **Compile-time shape checking** — `compile` (#39) lets tensor shapes be
  verified before the program runs. Shape errors at compile time is the thing
  every Python ML developer wants and cannot have.
- **ONNX and safetensors** import/export; `py` interop for everything else.

## v1.0 — Stability

- The full specification frozen, including semantics (not just syntax).
- A conformance test suite any implementation can run.
- Backwards-compatibility guarantee.
- `halka pkg` and a package registry.
- Debugger (DAP), profiler, coverage.
- Documentation generator.

---

## Infrastructure — all free

| Need | Choice | Cost |
|---|---|---|
| Source hosting, issues, reviews | GitHub | $0 |
| CI across Linux / macOS / Windows | GitHub Actions (free for public repos) | $0 |
| Release binaries | GitHub Releases | $0 |
| Website and docs | GitHub Pages | $0 |
| Toolchain distribution | npm (`halka-lang`), later Homebrew, Scoop, AUR | $0 |
| Editor extension | VS Code Marketplace, Open VSX | $0 |
| Playground | Static page; the toolchain is already JavaScript | $0 |
| Community | GitHub Discussions, Discord, Matrix | $0 |
| Package registry | Static index on GitHub Pages first | $0 |

The only optional spend is a domain name (~$12/year). `halka-lang.github.io`
works until then.

---

## How a new language actually grows

Zig went from nothing to a large community in about eight years. The pattern
underneath that is worth copying deliberately.

1. **Be honest about status.** Zig's README said "pre-1.0, expect breakage" for
   years and people trusted it. Overclaiming is the fastest way to lose the
   early adopters who matter most.
2. **Ship something usable early, then never break the build.** A green CI badge
   and a `run` command that works on the first try beats a perfect design
   document.
3. **Have one thing nobody else has.** For Zig it was `comptime` and painless
   cross-compilation. For Halka it is the **locked, homogeneous syntax**: one
   association operator, one separator, no redundant forms, and a compiler that
   explains the rule when you reach for something the language deliberately
   lacks. That is a genuinely learnable systems language, which does not exist.
4. **Be useful before you are complete.** Zig's C compiler made it useful to
   people who did not write Zig. Halka's equivalent is `py` interop: be the
   fastest way to write the hot loop under someone's Python ML code.
5. **Documentation is the product.** A spec, a tour, a book, and error messages
   that teach. Halka's diagnostics already cite the rule they come from.
6. **Grow contributors, not just users.** Self-hosting (v0.6) is what converts a
   user base into a contributor base.
7. **Do not chase benchmarks early.** Correctness and clarity first; the VM and
   native backend are already scheduled.

---

## Where help is most useful right now

- **Type checker** (v0.2) — the largest single piece of remaining work.
- **C backend** (v0.4) — well-scoped and self-contained.
- **Standard library** — written in Halka, in `stdlib/`.
- **Editor integrations** — Tree-sitter queries, more editors.
- **Examples and documentation** — every locked rule deserves a runnable example.
- **Adversarial tests** — find a program with two parses, or one the checker
  wrongly accepts. Rule #52 says that is a bug.
