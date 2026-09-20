# Halka — implementation status

The ecosystem plan has 55 areas. This file says, for each one, what actually
exists today. It is the answer to "is that implemented or is that planned?",
and it is updated in the same commit as the work it describes.

The counts below are derived from the table by `tools/status-counts.mjs`,
which CI runs: they were hand-kept once and drifted six rows out of date.
They cover 54 areas, because #54 is the organising principle and has no
state to be in.

**Legend** — ✅ done · 🟡 partial · ⬜ not started · 🔗 belongs in the ecosystem, not the core

Counts today: **16 done · 19 partial · 13 not started · 6 ecosystem**

---

## The compiler and language

| # | Area | Status | What exists |
|---|---|---|---|
| 1 | Language core | 🟡 | All 54 locked syntax rules parse and run. Domains like embedded, graphics and OS work are *reachable* but unproven. |
| 2 | Compiler toolchain | 🟡 | Lexer, parser, AST, name resolution, scope analysis, type analysis, backend lowering, native codegen, linking, diagnostics. Missing: IR stage, optimization stage, incremental builds, debug info. |
| 3 | Intermediate representation | ⬜ | The backend lowers AST → C directly. No IR means no target-independent optimization and no second backend. **This is a multiplier — see below.** |
| 4 | Optimization system | 🟡 | Delegated to the C compiler. Getting it to vectorise needed a codegen fix — redundant parentheses are a reassociation barrier — plus opt-in `--fast-math` and `--cpu-native`; a dense-layer kernel goes 74 ms to 17 ms, or 4 ms across threads. Halka-level work is escape analysis (M4). Bounds-check elision and monomorphisation need #3. |
| 5 | Memory, ownership & lifetimes | ✅ | **Enforced statically.** Move checking with flow-sensitive branch merging and loop detection, lexical non-escaping borrows, one-writer-or-many-readers aliasing, and task-capture checking. A parameter's ownership is *inferred* from whether the body keeps it, so there are no annotations and no lifetime syntax anywhere. |
| 6 | Raw memory & unsafe | 🟡 | `raw`, `unsafe:` parse; the interpreter enforces that deref requires `unsafe`. The backend does not implement raw pointers yet. |
| 7 | Type system | ✅ | Hindley-Milner-style inference, optionals as a real constructor with narrowing, generics, structs, enums, traits, match exhaustiveness. |
| 8 | Generics & abstraction | 🟡 | Parsed, inferred, and checked. **Not monomorphised** — the native backend cannot compile a generic function yet. |
| 9 | Pattern matching & control flow | 🟡 | Complete in the interpreter (literals, variants, tuples, collections, guards, `else`). The backend does not compile `match` yet. |
| 10 | Functions & program structure | ✅ | Functions, defaults, variadics, recursion, function values, modules. |
| 11 | Compile-time programming | 🟡 | `compile`, `macro`, `generate`, `reflect`, `specialize` all parse and run, but in the interpreter they evaluate eagerly rather than in a separate compile-time tier. |
| 12 | Native programming & ABI | 🟡 | The backend emits C99, links native binaries, and links extra libraries via `extern: link:`. No calling-convention control or callbacks yet. |
| 13 | **Foreign function interface** | ✅ | **C works.** `import c "header.h"` includes it, `c f(x)` calls it, declarations are type-checked, strings cross as `const char *` with no copy, `extern: link:` links libraries, and C compiler warnings are surfaced rather than hidden. C++ still errors (`E0716`). |
| 14 | Python interoperability | ✅ | **Works.** The binary embeds CPython. Modules, attribute chains, `from py "m" import f`, lists both ways, GIL taken per call so `parallel:` keeps every core busy. Crossing back is explicit with `as` (#15). Measured against the same program in Python: 44x single-threaded, 153x on four threads. |
| 15 | Runtime system | ✅ | `libhalka`: C99, no dependencies — strings, lists (which own and release their elements), threads, mutexes, atomics, panics, timing, files, capabilities, and live-allocation accounting so leaks are testable. |

## Libraries

| # | Area | Status | What exists |
|---|---|---|---|
| 16 | Standard library | 🟡 | `math`, `strings`, `lists`, `maps`, `io`, `time`, `os`, `json` natively; `seq`, `result`, `testing` in Halka. **No filesystem, no networking, no processes, no compression, no crypto.** |
| 17 | Collections | 🟡 | list, array, map, set, tuple, ranges, iteration. No queue, stack, tree or graph types. |
| 18 | Filesystem & OS APIs | 🟡 | `files.read/read_bytes/lines/write/append/remove/size/exists/is_dir/list_dir/make_dir`, every one gated on the `FileAccess` capability (#45) and returning `Result` (#22, #23) — [spec/FILE-IO.md](spec/FILE-IO.md). Plus `os.env`, `os.args`, `os.platform`. Compiled as well as interpreted, except `lines`, `read_bytes` and `list_dir`, which build lists. No sockets, processes or permissions APIs. |
| 19 | Networking stack | ⬜ | Nothing. |
| 37 | Cryptography | 🔗 | Nothing — and Halka should **bind libsodium or BoringSSL, never implement its own primitives.** Writing new crypto is how projects get CVEs. |

## Concurrency and distribution

| # | Area | Status | What exists |
|---|---|---|---|
| 20 | Concurrency & parallelism | 🟡 | Interpreter: tasks, channels, mutexes, atomics, cancellation, `parallel:` on a fiber scheduler. Backend: `parallel:` on **real OS threads**, measured at 3.2x on 8 cores. Missing: tasks/channels in the backend, a work-stealing pool, actors. |
| 21 | Distributed runtime | ⬜ | Nothing. Needs #19. |
| 22 | Actor system | ⬜ | Nothing. Buildable as a library on #20 once channels are native. |

## Tooling

| # | Area | Status | What exists |
|---|---|---|---|
| 23 | Errors & diagnostics | ✅ | Spans, carets, severity, the locked rule each error comes from, and a `help:` line that teaches the alternative. 60+ numbered codes. |
| 24 | Debugging | ⬜ | No debug info, no DAP adapter. `halka build` does emit `/Zi` in debug mode, so a C debugger sees the generated C. |
| 25 | Language server / IntelliSense | ✅ | LSP 3.17 over stdio, zero dependencies: diagnostics, hover, completion, go-to-definition, document symbols, rename, highlight, formatting. |
| 26 | Code formatting | ✅ | Canonical, idempotent, comment-preserving, behaviour-preserving — all four properties are tested. |
| 27 | Linting & static analysis | ✅ | Name resolution, arity, locked-absence checks, naming conventions, type errors, match exhaustiveness, and full ownership and borrow analysis. No unused-code detection yet. |
| 28 | Testing ecosystem | ✅ | `halka test` for user projects; 160 internal tests across spec conformance, rejection, golden output, formatter, native-vs-interpreter equivalence, real C and Python FFI calls, ownership, and a zero-leak assertion on every compiled binary. |
| 29 | Build system | 🟡 | `halka build` compiles a whole program — imported modules and installed packages included — to one native binary, by linking every module into one unit before emitting C (R23.5). `halka.pkg` defines a project. No incremental compilation (whole-program by design for now) and no cross-compilation yet. |
| 30 | Package management | ✅ | `halka init/add/remove/install/update/tree`. `halka.pkg` manifests, semver with caret and exact requirements, Minimal Version Selection, `halka.lock` with SHA-256 per archive, a per-user cache, and path dependencies. No install scripts of any kind. [spec/PACKAGES.md](spec/PACKAGES.md). |
| 31 | Package registry | ✅ | Live at `nulfied.github.io/halka/registry`, and `HALKA_REGISTRY` points at any other static tree or local directory. `halka pkg pack` builds an archive reproducibly, `publish` puts it in a registry, `index` derives every `index/<name>.json` from the archives themselves so the two cannot disagree — CI rebuilds and checks it. Archives are verified by hash before extraction and rejected if they hold links or escaping paths. Publishing over an existing version is refused: lockfiles pin its hash. |
| 32 | CLI | ✅ | `run build check fmt test repl lsp ast tokens toolchain`. |
| 33 | IDE & editor integration | ✅ | VS Code extension, TextMate grammar, Tree-sitter grammar, and setup for Neovim, Helix, Zed, Sublime. |
| 50 | Compiler API | 🟡 | `halka ast --json` exposes the canonical AST. No stable library API, no IR access, no plugins. |

## Platforms and targets

| # | Area | Status | What exists |
|---|---|---|---|
| 34 | Web development | ⬜ | Nothing. Needs #19. |
| 35 | WebAssembly | ⬜ | Nothing — but the C backend means `wasi-sdk` or Emscripten is a *configuration*, not a new backend. **Cheap multiplier.** |
| 36 | Database & backend | 🔗 | Nothing. Should be library bindings over #13, not core work. |
| 38 | Scientific computing | 🔗 | Nothing. BLAS/LAPACK bindings over #13 beat a from-scratch implementation. |
| 39 | Symbolic mathematics | 🔗 | Nothing. A library, and a large one — SymPy is 15 years of work. |
| 40 | AI / ML framework | 🟡→🔗 | The *syntax* is locked (`kernel`, `launch`, `device`, `parallel:`) and real parallelism is measured. The framework itself should start as bindings, not a rewrite of PyTorch. |
| 41 | Notebook environment | ⬜ | Nothing. A Jupyter kernel is ~500 lines over the existing REPL — **cheap, high-visibility**. |
| 42 | Game & graphics runtime | 🔗 | Nothing. Bind SDL3, Dear ImGui, wgpu. |
| 43 | GUI framework | 🔗 | Nothing. Bind GTK, Qt, or Dear ImGui. Qt is 30 years of work; we are not rebuilding it. |
| 44 | Embedded platform | ⬜ | Plausible — C99 output with no runtime dependency is exactly what embedded targets want — but untested, and `libhalka` currently calls `malloc`. |
| 45 | OS & low-level development | ⬜ | Same: plausible via the C backend, unproven, and needs freestanding mode. |
| 46 | Plugin ABI | ⬜ | Nothing. Needs #12 and a stability commitment. |
| 47 | Cross-platform | 🟡 | The interpreter and toolchain run anywhere Node runs. The backend supports MSVC, gcc, clang and `zig cc`, but has only been *exercised* on Windows/MSVC. CI covers Linux and macOS for the interpreter. |
| 48 | Native backends | 🟡 | One: C99. Adding a second (LLVM, or direct machine code) needs #3. |

## Long-term

| # | Area | Status | What exists |
|---|---|---|---|
| 49 | Self-hosting | ⬜ | Stage 0 in TypeScript. Nothing written in Halka yet beyond three stdlib modules. |
| 51 | Formal verification | ⬜ | Nothing. Honestly: this is a research programme, not a feature. |
| 52 | Security model | 🟡 | Ownership, borrows and data-race freedom are static. Capabilities (`requires`, `with capability`, `HALKA_GRANTS`) are dynamic but enforced in compiled binaries as well as the interpreter, so the guarantee does not weaken at `halka build`. `unsafe:` is still enforced only by the interpreter. |
| 53 | Developer experience | 🟡 | Language, runtime, CLI, formatter, diagnostics, testing, LSP and editor integration exist. Package manager, debugger and distribution do not. |
| 54 | Ecosystem philosophy | — | The organising principle, not a feature. |
| 55 | Interaction rule | ✅ | Honoured. This file is how implemented and planned are kept apart. |

---

## Can all 55 be implemented?

**Yes, in principle. No, not by a small team in any near timeframe — and that is the wrong goal anyway.**

Calibration, so the number means something:

| Project | Time to 1.0 | People |
|---|---|---|
| Rust | ~9 years | hundreds, Mozilla-funded |
| Go | ~3 years to 1.0 | a funded Google team |
| Zig | 9 years, **still pre-1.0** | 1 full-time + ~500 contributors |
| Swift | 4 years to open source | a large Apple team |

And several individual items on the list are *themselves* that size: NumPy is 20 years, SymPy 15, PyTorch is hundreds of engineers, Qt is 30 years. "Implement #39 symbolic mathematics" is not a task; it is a career.

So the list is a correct and coherent **vision**. It is not a checklist.

## The multiplier strategy

The 55 items are not independent. A handful unlock most of the rest:

**#13 — the C FFI. ✅ Built.** Almost everything in the "libraries and
platforms" section already exists as a C library, and now it is reachable:

- #19 networking → bind the platform sockets API
- #37 cryptography → bind libsodium (and *never* write our own)
- #38 scientific → bind BLAS/LAPACK
- #42 graphics → bind SDL3, wgpu
- #43 GUI → bind GTK or Dear ImGui
- #36 database → bind SQLite, libpq
- #40 AI/ML → bind ONNX Runtime, and #14 gets PyTorch via CPython

That is **seven ecosystem areas from one compiler feature**, and the generated
code is already C, so the binding is a declaration rather than a marshalling
layer. Each of those rows is now a library someone can write, not a compiler
change someone has to make first.

**#30/#31 — package manager and registry.** These turn every 🔗 row from *our*
work into *someone else's* work. A language without a package manager has to
ship every library itself; a language with one grows libraries it did not write.

**#3 — the IR.** Unlocks #4 real optimization, #48 a second backend, #50 a
programmable toolchain, and #51 if that is ever attempted.

**#35 — WebAssembly.** Nearly free: point the existing C backend at `wasi-sdk`.
Unlocks #34 and a browser playground, which is the cheapest possible way to let
someone try the language.

**#41 — a Jupyter kernel.** ~500 lines over the existing REPL, and it puts
Halka inside the tool the AI/ML audience already has open.

Eight items. Build those and the other 47 become achievable — most of them by
people who are not us.

## What this means for sequencing

The wedge does not need 55 areas. It needs a person with a slow Python training
loop to be able to rewrite that loop in Halka **without giving up NumPy**, and
have it be faster and use all their cores.

That now works — see [`examples/ffi/wedge.hk`](examples/ffi/wedge.hk) and
[`docs/ffi.md`](docs/ffi.md). What remains of the wedge is #41, a Jupyter
kernel, so trying it costs ten minutes; and the ownership checker, so the
safety claim is a compiler guarantee rather than a design document.

Everything else is what the ecosystem grows into after that.
