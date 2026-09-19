# Halka Roadmap

The syntax is locked. This document is about everything else: making Halka fast,
making it self-hosted, and giving it the ecosystem a language needs to survive.

It is written as a sequence of shipped artefacts, not dates. Every item is
achievable with free tooling and free infrastructure.

---

## Where we are

**v0.1 — the language runs.** A complete reference implementation of the locked
V49 specification: lexer, deterministic parser, static checks, a generator-based
interpreter with real cooperative concurrency, a formatter, a REPL, and a
language server. 77 tests green, including conformance against every executable
code block in the specification.

The reference implementation is deliberately written for **clarity over speed**.
It is the executable definition of what Halka *means*. Performance comes from
the backends below, and the reference implementation stays as the oracle they
are tested against.

---

## v0.2 — Types

The interpreter checks types at runtime. v0.2 moves that work to compile time.

- **Hindley–Milner inference with annotations optional** (#11, #13). Rule #11
  makes annotations optional "whenever the compiler can infer the type
  unambiguously" — that is a promise of real inference, not of local guessing.
- **Optional types as a first-class check** — `T?` (#13) tracks nullability, so
  `name.length` on a `string?` is a compile error and `name or "Unknown"`
  narrows it to `string` (R11).
- **Exhaustiveness checking for `match`** (#10) — a missing enum variant is an
  error, not a silent fallthrough.
- **Generic constraints via traits** (#16) — `max<T: Ord>(a: T, b: T)`.
- **`Result` must be handled** — ignoring a `Result` value is a warning, then an
  error. This is what makes "no exceptions" (#23) safe rather than merely
  different.
- **Ownership and borrow checking** (#14, #25) — currently ownership markers are
  tracked dynamically. v0.2 makes `move` / `borrow` / `borrow mut` a static
  analysis: one mutable borrow or many shared ones, no use after move.
- **Capability checking at compile time** (#45) — `requires` becomes a static
  obligation rather than a dynamic check.

**Why it matters:** this is the difference between "a nice scripting language"
and "a language you can write a database in".

## v0.3 — A bytecode VM

- Lower the canonical AST to a register-based IR, then to bytecode.
- Constant folding, dead-code elimination, inlining of small functions.
- Monomorphise generics (#43 `specialize` becomes a hint the optimiser honours).
- Replace the tree-walking evaluator behind the same CLI, keeping the
  interpreter as the differential-testing oracle: every test must produce
  identical output under both.
- Target: 20–50× the reference interpreter on numeric and collection workloads.

## v0.4 — Native compilation, through C

`halka build --native app.hk` emits **C99** and invokes whatever C compiler is
present.

This is the deliberate choice over LLVM:

- **$0 and no dependency.** Every platform already has a C compiler. No 2 GB
  LLVM checkout, no version-matching pain, no multi-hour CI builds.
- **Instant portability.** Anywhere C runs, Halka runs — including embedded
  targets, WASM via Emscripten, and platforms LLVM does not prioritise.
- **Free C/C++ interop.** Rules #35 and #36 stop being an FFI marshalling
  problem and become ordinary C calls in the generated source.
- It is the path Nim, V, early Haskell, Vala and Chicken Scheme took. An LLVM
  backend can be added later for optimisation; it is not needed to ship.

Deliverables: the C backend, a small runtime library (`libhalka`: values,
scheduler, channels, allocator), static-binary output, and cross-compilation.

## v0.5 — FFI made real

With a native backend, the boundary markers stop being placeholders.

- **`c`** (#35) — direct C ABI calls, structs, callbacks, `c malloc`/`c free`
  under the ownership rules.
- **`cpp`** (#36) — classes, methods, namespaces, templates through a generated
  shim; C++ exceptions converted to `Result` at the boundary.
- **`py`** (#37) — embed CPython, marshal values both ways, release the GIL
  around Halka tasks. This is the on-ramp for AI/ML: NumPy, PyTorch, pandas and
  Hugging Face become callable from Halka on day one, while the numeric kernels
  around them are written in Halka and compiled.

## v0.6 — Self-hosting

Rewrite the compiler in Halka, compile it with the v0.5 toolchain, and compile
itself. This is the Zig path exactly: stage 0 in a host language, stage 1 in the
language itself.

Self-hosting is not vanity. It is the only honest proof that the language is
good enough to write a compiler in, and it makes every compiler contributor a
Halka programmer.

The stage-0 TypeScript implementation is retained as the specification oracle.

## v0.7 — The AI/ML layer

The locked syntax already reserves what this needs: `kernel`, `launch`, `device`
(#44), `parallel:` (#32), `compile` and `generate` (#39, #41).

- **Tensors in the standard library** — n-dimensional arrays with broadcasting,
  built on the slice syntax that #54 already locks.
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
