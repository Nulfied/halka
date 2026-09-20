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

That claim only became true for calls into user code once the emitter learned
which parameters are owning. A parameter borrows unless the callee keeps its
argument (M2.2), so a list or string built at the call site is the caller's to
free — but the emitter had no access to the inference, so it freed such a value
only when the callee was a prelude function. `total([1, 2, 3])` in a loop leaked
every literal. Passing the inferred flags through to the backend closes it
without a second analysis, and without freeing what an owning callee took.

**A Jupyter kernel** shipped, which is the cheapest way into the crowd that
would otherwise never install a new language. It is two processes, because
Jupyter's wire protocol is ZeroMQ with HMAC-signed multipart messages and
speaking that from Node would mean a native dependency this compiler does not
have: a Python front end inherits the protocol from `ipykernel`, and
`halka kernel host` holds the interpreter state and runs cells over stdio
JSON. Cells are interpreted, not compiled — the notebook is for the edit-run
loop, and `halka build` is what makes a program fast
([docs/JUPYTER.md](docs/JUPYTER.md)).

**Optionals** (#7) compile now, which maps turned out to need: `m[k]` is a
`T?`, so there was no way to reach maps without them. `T?` becomes a struct
with a tag and a value rather than a null pointer, because NULL cannot stand
in for an absent `int?` or `bool?`. The locked surface all works compiled:
`is null`, `or`, truthiness, narrowing in the false arm of `is null`, and
`match` with a `null` arm. That last one has a trap worth recording — a bare
name matches anything, `null` included, so it ends the chain and a following
`null` arm is unreachable. Emitting it as "present, else absent" would have
disagreed with the interpreter on exactly the case the arm exists for. An
optional of a struct or enum is refused rather than mis-ordered in C.

**Incremental builds** skip work that provably has not changed. Not
separate compilation: R23.5 links every module into one unit before any C
is emitted, which is what lets generics monomorphise and names be rewritten
across module boundaries, and per-module object files would undo that. So
the granularity is the whole build, and the question is only whether it can
be skipped -- which it can when every input hashes the same. Every input
means the sources *and* every module they import, the flags, the runtime C
that gets compiled alongside them, and the compiler's own version, since a
new compiler emits different C from identical source. A no-op build goes
from 6.9 s to 0.6 s. `--force` rebuilds regardless.

**Cross-compilation** works through `halka build --target <triple>`. The
constraint is not the compiler but the target's headers and libraries: gcc
cannot supply them and MSVC builds for this machine only, so a cross build
picks `zig cc` (or clang) and says plainly what to install when neither is
there, rather than failing at the link with something unreadable. Threading
and the output extension follow the target rather than the host, so a Linux
binary built on Windows is not handed a `.exe` it is not.

Worth recording how it is tested. No compiler on the machine this was
written on can cross-compile, so an end-to-end cross build is not in the
suite; what is tested is the part that was written here -- which toolchain
gets chosen and what it is told. Shipping the rest untested is how a feature
turns out broken on the first machine that tries it.

**Stack promotion landed**, which mostly meant using an answer that was
already there. Escape analysis has computed `stackable` since M4 -- list
literals that neither escape nor grow -- and the backend ignored the set
entirely, so every one of them still took a malloc and a free. They are
emitted as stack storage now, with the header marked never-free using the
same `rc = -1` convention interned string literals already used. Scalar
elements only: a list that is never released would never release owning
elements either. On a loop building a three-element list three million
times that is 747 ms to 16 ms, a 40x difference, for the same checksum.

**Bounds checks survive `--release`.** They used to be dropped wholesale,
so a release binary had no memory safety -- an odd position for a language
whose pitch is being as fast as C *without* that pain. Three changes, in
the order they mattered. The check was a *function call* per element, which
also stopped the loop vectorising; inlining it to one unsigned compare and
a cold branch took a checked build from 5.9x an unchecked one to 1.9x.
Then `--release` started keeping them. Then the idiomatic loop stopped
needing them at all: `for i in 0..len(xs),` bounds `i` for the body, so
`xs[i]` inside is emitted unchecked, which is worth 1.7x on a proven loop.
The analysis is deliberately conservative -- anything that could resize the
list, rebind either name, or hand the list to code it cannot see gives up --
because being wrong reintroduces exactly the read the check exists to stop.
`--no-bounds-checks` is the explicit opt-out.

**`unsafe:` is checked statically** (#46). The interpreter had always
enforced it, but only when the line ran: a raw dereference down a branch
nobody took was never reported, `halka check` passed programs `halka run`
would refuse, and the compiled backend enforced nothing at all. The rule is
unchanged -- dereferencing a raw pointer or writing through one needs an
enclosing `unsafe:`, and the block does not reach into a function it calls
-- it is simply decided from the types now, so all three agree. A safe `&`
reference still dereferences without ceremony.

**`json` compiles natively**, both halves. `stringify` dispatches on the
argument's static type, so the runtime has one function per shape rather
than a generic walker; its conventions are JavaScript's, because that is
what the interpreter delegates to and the two must agree byte for byte.
`parse` needed something new: a document's shape is only known at run time,
so the backend gives it an opaque dynamic value in the same spirit as
`PyObject *` at the Python boundary. It prints as the Halka value the
interpreter would have built, which is not the same as printing it back as
JSON.

The interpreter's parse error used to be V8's own wording, which changes
between Node versions and which no C parser could reproduce -- so the same
program failed differently depending on how it was run. Both engines now
locate the error with the same grammar and report the same byte.

Fixing this also turned up a formatter bug with nothing to do with JSON:
`{` opens an interpolation, and reprinting a string that held one did not
escape it again, so `"a \{b} c"` came back as `"a {b} c"` -- an
interpolation of a variable. The program still compiled and quietly did
something else. No test had a brace in a string.

**Tuples compile natively**, and with them the two things maps were missing:
`for e in m` and `maps.from_entries`. Each shape is its own C struct, so the
runtime cannot know a layout ahead of time; the emitter writes a descriptor
beside each struct -- field kinds and byte offsets -- and one runtime walk
over that serves release, retain and printing. The descriptor is what makes a
*list* of tuples work, and the first version without it is the cautionary
case: a list of `(int, string)` compiled, ran, and printed its string
pointers as integers. Indexing, destructuring, tuple patterns in `match`,
equality, nesting and aliases all work compiled. A tuple index must be a
literal, because the fields have different types; iterating a tuple is
refused for the same reason.

**Maps compile natively**, insertion-ordered. That ordering is the whole
design constraint: the interpreter's map keeps insertion order, so printing
one or listing its keys has to produce the same sequence (R23), and a plain
hash table would have passed a test that checked membership and failed every
test that printed. Entries live in dense arrays in insertion order with an
open-addressed index beside them; a removal clears a flag and leaves the slot,
so every other entry keeps its position. Literals, `m[k]` (a `T?`, since a
missing key reads as null), `m[k]: v`, `len`, `keys`, `values`, `has`,
`get`, `get_or`, `remove`, `clear`, `is_empty`, printing and `maps.merge`
all work compiled. Iterating a map directly still does not: it yields tuples,
and the backend has no tuple type, so it is refused by name.

Fixing it turned up a leak that had nothing to do with maps: `for x in
[1, 2, 3]` never freed the list, and neither did a loop over `m.keys()`. The
loop now owns a freshly built iterable and frees it on every exit, `give`
included.

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

- **`maps` and `json` in compiled code.** Both are typed and both run under
  `halka run`; the backend has no map type at all, and `json.parse` yields a
  value whose shape is only known at run time. `lists` compiles.
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
