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
| recursive calls, `fib(35)` | 153 ms | 141 ms | 9 344 ms | 1.08x |
| integer arithmetic, 200M | 424 ms | 349 ms | 26 606 ms | 1.21x |
| floating point, 900×900 | 593 ms | 638 ms | 39 158 ms | 0.93x |

And the parallelism the wedge depends on: 3.20x from 8 threads, where the same
workload in Python threads runs at 0.51x — *slower* than one thread.
See [bench/README.md](bench/README.md).

The reference interpreter stays as the oracle. R23 makes them one language:
the native tests compile each case and diff its output against the interpreter.

---

## The wedge, and what is left to build it

Interop, don't replace. Win one pain point measurably. Ship one benchmarkable
artifact. Meet people in the tools they already use.

Three of the four are demonstrated rather than claimed now — **C-level
speed**, **real multicore parallelism**, and **memory safety without lifetime
annotations**. Interop shipped too. What remains is packaging and reach.

## v0.3 — Ownership as a static pass ✅

**Shipped.** The memory model ([spec/MEMORY-MODEL.md](spec/MEMORY-MODEL.md)) is
a compiler guarantee now, not a design document.

- **Move checking** (M1) — use-after-move is `E0504`, and the error shows both
  the use and the move, with the reason for it.
- **Borrow checking** (M2) — a borrow cannot be returned, stored, or captured.
  A *named* borrow lives to the end of its block; one created inside an
  expression dies with the statement.
- **Aliasing** (M2.1) — one `borrow mut` or many `borrow`, checked across
  statements and inside a single call's argument list.
- **Task capture** (M5) — a task cannot capture a borrow, so data races are
  rejected rather than documented.
- **Ownership inference** (M2.2) — a parameter is owning exactly when the body
  keeps its argument, resolved as a fixpoint over the call graph. **No
  annotations and no new syntax**, which matters because V49 is locked.

The whole checker is a forward walk with a state map and a conservative merge
at joins, because a borrow that cannot escape never requires relating two
lifetimes. 18 tests cover it and six of those assert that ordinary code is
*not* rejected. Every .hk file in the repo passes.

**Escape analysis** (M4) shipped with it. The backend now frees what it
allocates: at the end of the block that declared a value, so something built
inside a loop is freed each iteration, and at statement end for values created
inside an expression and never named. The runtime counts live heap objects, so
the test suite asserts it — **every compiled program in the repo exits with
zero live objects**, including the ones that embed CPython.

**Packages** (#29/#30/#31) shipped too: `halka.pkg` manifests, semver
requirements in two forms, Minimal Version Selection, a hash-pinned
`halka.lock`, a per-user cache and path dependencies, against any static
registry. Fixing it turned up two problems worth naming: a module could not
use anything it imported (so a package could never have a dependency), and an
uninstalled dependency silently resolved to a built-in module of the same
name. Both are fixed and both now have tests.

**Multi-module native builds** landed with it. `halka build` now compiles a
whole program — imported modules and installed packages included — into one
binary, by linking every module into a single unit before emitting C
(R23.5). Three pre-existing bugs surfaced on the way and are fixed: a
dependency's own imports were never bound, an import was invisible inside
every function, and the compiled binary never called a `main()` function
while the interpreter did.

**File I/O** (#18) landed, capability-gated and `Result`-returning
([spec/FILE-IO.md](spec/FILE-IO.md)). It runs under `halka run` only, and
that is the next thing to fix: the native backend cannot represent
`Result<T>` because it has no enums, and it knows nothing about the prelude
modules either. So the order now is enums in the C backend, then the prelude
modules, then file I/O compiles too. None of that changes the API.

**Enums and `Result<T>` compile.** An enum lowers to a tagged union and
`match` to a `switch`; a generic enum is monomorphised, so `Result<int>` and
`Result<string>` are two C types built on demand. That clears the blocker
under File I/O — what is left for it is teaching the backend about prelude
modules, which brings `math`, `strings`, `lists` and the rest to compiled
code at the same time.

**The prelude compiles.** `sema/prelude-types.ts` is one signature table
read by both inference and the backend, so they cannot disagree about what
`math.hypot` is. `math`, `os`, `time`, `strings.repeat`, `io.write` and most
of `files` now lower to C; a member with no C implementation is named in a
diagnostic rather than mis-compiled. File I/O therefore works in compiled
programs, capability gate and all.

Still open from this milestone:

- **`with capability` and `requires` in compiled code.** A binary reads its
  grants from `HALKA_GRANTS` today, which is narrower than the interpreter.
- **`lists`, `maps` and `json`**, whose members take heterogeneous
  containers the signature table cannot describe honestly yet.
- **Stack promotion** — the analysis already identifies values that neither
  escape nor grow; the backend does not yet place them on the stack.
- **Bounds-check elision** for the `for i in 0..len(xs)` shape.
- **`shared(T)`** and the reference-cycle warning.

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
- A public package registry to point `halka add` at (the client is done).
- Debugger (DAP), profiler, coverage.
- Documentation generator.

---

## Infrastructure — all free

| Need | Choice | Cost |
|---|---|---|
| Source hosting, issues, reviews | GitHub | $0 |
| CI across Linux / macOS / Windows | GitHub Actions | $0 |
| Release binaries | GitHub Releases | $0 |
| Website and docs | GitHub Pages (needs a public repo) | $0 |
| Toolchain distribution | npm (`halka-lang`), later Homebrew, Scoop, AUR | $0 |
| Editor extension | VS Code Marketplace, Open VSX | $0 |
| Playground | Static page; the toolchain is already JavaScript | $0 |
| Community | GitHub Discussions, Discord, Matrix | $0 |
| Package registry | Static index on GitHub Pages, in its own public repo | $0 |

The only optional spend is a domain name (~$12/year). `nulfied.github.io`
works until then.

### Two things the free tier actually requires

Both of these are about repository *visibility*, and neither costs money as
long as it is planned for:

- **GitHub Pages needs a public repository** on GitHub Free; it is a paid
  feature for private ones. The site and the package registry therefore live
  in their own public repository, which is why `DEFAULT_REGISTRY` points at
  `nulfied.github.io/halka-registry` rather than at this repo. The compiler
  itself can stay private for as long as it wants to.
- **Actions minutes are metered on private repositories** (2,000/month on
  Free) and unmetered on public ones. Every job here runs on
  `ubuntu-latest`, which bills at 1x — Windows would be 2x and macOS 10x —
  so the current workflow is cheap either way, but a private repo does spend
  from a budget where a public one does not.

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
