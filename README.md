<div align="center">

# Halka

**One assignment operator. One separator. One way to write things.**

A general-purpose language with a syntax small enough to learn in an afternoon
and a semantics deep enough for systems work, concurrency, and AI/ML.

[Quick start](#quick-start) · [Tour](#a-sixty-second-tour) · [Why Halka](#why-halka) ·
[Spec](spec/V49-LOCKED.md) · [Roadmap](ROADMAP.md) · [Editors](#editor-support)

</div>

---

## The idea

Most languages grow three ways to say the same thing. Halka locks two rules and
derives everything else from them:

| | |
|---|---|
| **`:`** | association — binding, type annotation, map entry, block header, slice bound |
| **`,`** | separation and continuation — nothing else; it is not an expression operator |

That is the whole surface grammar. There is no `=` vs `==` confusion, no
`->`, no `fn`/`def`/`func`, no lambda syntax, no function overloading, and no
exceptions. What is left is small, regular, and hard to get wrong.

```halka
let name: "HALKA"
let age: 25

greet(who: string: "world"),
    give "Hello, {who}!"

say greet(name)

if age >= 18,
    say "adult",
else,
    say "minor"
```

## Quick start

Halka's reference toolchain runs on Node 22.6 or newer and has **no runtime
dependencies**.

```bash
git clone https://github.com/halka-lang/halka.git
cd halka/compiler
node bin/halka.mjs run ../examples/hello.hk
```

Put it on your `PATH`:

```bash
npm link
halka run examples/tour.hk
```

Or start an interactive session:

```bash
halka repl
```

### The `halka` command

| Command | What it does |
|---|---|
| `halka run <file.hk>` | Run a program |
| `halka check [paths]` | Parse and check without running |
| `halka fmt --write [paths]` | Format to the canonical style (rule #48) |
| `halka test [dir]` | Run `test_*.hk` / `*_test.hk` files |
| `halka repl` | Interactive session |
| `halka lsp` | Language server over stdio |
| `halka ast <file> [--json]` | Print the canonical AST |
| `halka tokens <file>` | Print the token stream |

## A sixty-second tour

```halka
# Types are inferred; annotate only when you want to.
let numbers: [10, 20, 30, 40, 50]
let users: ["alice": 20, "bob": 25]
let tags: {"compiler", "runtime"}
let point: (10, 20)

# Slicing, negative indices, ranges.
say numbers[1:3]        # [20, 30]
say numbers[-1]         # 50
say numbers[::-1]       # reversed
for i in 1..=3,
    say i

# Destructuring uses the shape of the thing being unpacked.
let (x, y): point
let [first, ...rest]: numbers

# Functions. `give` is the single return mechanism.
factorial(n),
    if n <= 1,
        give 1,
    else,
        give n * factorial(n - 1)

# Functions are values. There is no lambda — pass a name.
let squares: numbers.map(double)

# Structs and traits. Traits are the only abstraction contract.
User:
    name: string,
    age: int

trait Greet:
    hello(),
        give nothing

User implements Greet:
    hello(),
        give "hi {name}, you are {age}"

# Errors are values, not control flow. No try/catch anywhere.
parse_age(text),
    let r: text to int,
    if r is error,
        give Error("not a number: {text}"),
    else,
        give r

match parse_age("42"),
    Ok(value),
        say value,
    Error(message),
        say message

# Cleanup is deterministic and survives early `give`.
read_config(),
    let file: open("config.hk"),
    defer close file,
    give parse(file)

# Concurrency is built in.
let a: start fetch("/users"),
let b: start fetch("/orders"),
let users: await a,
let orders: await b

let ch: make channel(int): 8
send ch : 42
let got: receive ch

parallel:
    let left: heavy(0, 500),
    let right: heavy(500, 1000)
```

Run [`examples/tour.hk`](examples/tour.hk) to see all of this execute.

## Why Halka

Halka takes one idea from each language it admires and refuses the parts that
made those languages hard to learn.

| Strength | From | How Halka does it |
|---|---|---|
| Deterministic cleanup, no GC pauses in the design | C++/Rust | `defer`, ownership, `move`/`borrow` (#24, #25) |
| Memory safety by default | Rust | `borrow` / `borrow mut`; raw pointers only inside `unsafe:` (#14, #46) |
| Arbitrary-precision integers | Python | `int` is unbounded; `float` is IEEE-754 |
| Readable, indentation-structured code | Python | Indentation defines blocks (#3, #49) |
| Errors as values | Go/Rust | `Result<T>` with `Ok`/`Error`; **no exceptions** (#22, #23) |
| Lightweight concurrency + channels | Go | `start` / `await`, `make channel(T)`, `send`/`receive` (#26–#28) |
| Traits, generics, pattern matching | Rust/ML | `trait`, `f<T>(...)`, `match` with guards (#10, #16) |
| Compile-time execution and macros | Zig/Lisp | `compile`, `macro`, `generate`, `reflect` (#39–#42) |
| Direct C / C++ / Python interop | Zig/Cython | `c`, `cpp`, `py` boundary markers (#35–#37) |
| GPU and device targets as first-class | CUDA/Mojo | `kernel`, `launch`, `device` (#44) |
| Capability-based security | Pony/Deno | `capability`, `requires`, `with capability` (#45) |

And the things it deliberately does **not** have, each locked by a rule:

- **no exceptions** (#23) — recoverable failure is `Result<T>`
- **no function overloading** (#21) — one name, one definition; use generics
- **no lambdas** (#17) — named functions are first-class values
- **no separate interface system** (#16) — traits do that job
- **no C-style casts** (#15) — `as` when it must succeed, `to` when it can fail
- **no ambient authority** (#45) — a function states the capabilities it needs

The compiler does not merely omit these; it **recognises and rejects** them
with a message that names the locked rule and teaches the alternative:

```
error[E0303]: `catch` is reserved and is not part of Halka V49
  --> app.hk:12:5
   |
12 |     catch e,
   |     ^^^^^
  = locked rule: #23 — Exception model
  = help: Halka has no exception system. Match on Result<T>:
          `match result, Ok(value), ... Error(message), ...`
```

## The specification

The syntax is **locked**. All 54 rules live in
[`spec/V49-LOCKED.md`](spec/V49-LOCKED.md), transcribed from the authored design
documents that are archived byte-for-byte in [`spec/source/`](spec/source).

Rule #52 demands that every valid program has exactly one parse and that the
parser never guesses. Where two locked forms are spelled identically — `:` as
assignment versus slice bound, `[` as literal versus index, a function
declaration versus a call — [`spec/RESOLUTIONS.md`](spec/RESOLUTIONS.md) gives
the deterministic answer. A resolution may only *narrow* a locked rule, never
contradict it, and each one is covered by a test.

Changing a locked rule needs a numbered HEP (Halka Enhancement Proposal) and a
version bump past V49.

## Editor support

`halka lsp` speaks LSP 3.17 over stdio with no dependencies, so any editor that
speaks LSP works: diagnostics, hover, completion, go-to-definition, document
symbols, rename, highlight, and formatting.

| Editor | How |
|---|---|
| **VS Code / Cursor / Windsurf** | Install the extension in [`editors/vscode`](editors/vscode) |
| **Neovim** | [`editors/nvim`](editors/nvim) — `lspconfig` + Tree-sitter setup |
| **Helix** | [`editors/helix`](editors/helix) — drop into `languages.toml` |
| **Zed** | [`editors/zed`](editors/zed) |
| **Sublime Text** | [`editors/sublime`](editors/sublime) |
| **Emacs, Kate, IntelliJ (LSP4IJ), any LSP client** | Point it at `halka lsp` for `*.hk` |

Syntax highlighting is provided both as a TextMate grammar (VS Code, Sublime,
GitHub Linguist) and as a Tree-sitter grammar (Neovim, Helix, Zed).

## Repository layout

```
spec/            the locked V49 specification and its grammar resolutions
  V49-LOCKED.md    the 54 rules — the source of truth
  RESOLUTIONS.md   R1-R21, the deterministic answers #52 requires
  source/          the authored .docx documents, archived unchanged
compiler/        the reference toolchain (TypeScript, zero runtime deps)
  src/lexer/       layout, comma rule, strings, comments
  src/parser/      deterministic recursive descent -> one canonical AST
  src/sema/        name resolution, arity, locked-absence checks
  src/interp/      the reference semantics (generator-based evaluator)
  src/runtime/     values, fiber scheduler, prelude
  src/fmt/         the canonical formatter
  src/lsp/         the language server
  test/            spec conformance, rejection, golden-output, formatter suites
stdlib/          Halka-source standard library modules
examples/        runnable programs
editors/         editor integrations
docs/            the documentation site
```

## Status

**v0.1 — the language runs.** The locked spec is implemented end to end: every
executable example in the specification parses, and `examples/tour.hk` exercises
30 of the 54 rules and produces correct output.

What works today: the full surface syntax, type inference at runtime, structs,
traits, generics, enums and pattern matching, `Result`, optionals, destructuring,
slices and ranges, `defer`, ownership markers, tasks, channels, mutexes, atomics,
cancellation, `parallel:`, capabilities, macros, `reflect`, the formatter, the
REPL, and the language server.

What is next, in order: a static type checker with full inference, a bytecode
VM, then a native backend that emits C99 so Halka compiles to a real binary with
any C compiler and no LLVM dependency. See [ROADMAP.md](ROADMAP.md).

Halka is pre-1.0. The **syntax** is locked; library APIs are not yet stable.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
The one hard rule: **a change that alters locked syntax needs a HEP.** Everything
else — the type checker, the native backend, the standard library, editor
support, documentation, examples — is open.

```bash
cd compiler
npm test          # 77 tests: spec conformance, rejections, golden output, formatter
npm run typecheck
```

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option — the same arrangement Rust uses, so Halka can be embedded anywhere.
