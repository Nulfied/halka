# HALKA V49 — Grammar Resolutions (R-series)

**Status:** normative for the implementation · **Subordinate to** [`V49-LOCKED.md`](V49-LOCKED.md)

Rule #52 requires that *every valid program has one canonical parse* and that the
parser must never guess. The 54 locked rules fix the **surface syntax** but leave
several places where two locked forms are spelled identically. This document
resolves each one.

A resolution may only **narrow** a locked rule. If a resolution is ever found to
contradict a locked rule, the locked rule wins and the resolution is a bug.

Every resolution below is exercised by a conformance test in
`compiler/test/conformance/`, named after its R-number.

---

## R1 — The five roles of `:`

`:` is locked as "universal association" (Global Rules). It appears in five
grammatical positions. They are distinguished **structurally**, never by guessing:

| Role | Shape | Disambiguated by |
|---|---|---|
| **Binding / assignment** | `target : value` | `:` in *statement* position |
| **Type ascription** | `target : Type : value`, `name: Type` | `:` whose right operand is in *type position* (see R2) |
| **Map entry** | `key : value` inside `[ ]` or `{ }` | enclosing **collection literal** context |
| **Block opener** | `header :` NEWLINE INDENT | `:` is the **last token on its line** |
| **Slice separator** | `expr [ a : b : c ]` | enclosing **index** context (see R4) |

The lexer emits a single `COLON` token. The parser selects the role from the
*context stack* (`stmt`, `type`, `collection`, `index`) plus one-token lookahead
for NEWLINE. No backtracking is required for R1.

### R1.1 — Ascription chains

`a : T : v` parses as `bind(a, type=T, value=v)`, not as `bind(a, bind(T, v))`.

The rule: in `x : A : B`, the **middle** element is read in type position if and
only if it resolves to a type (a primitive name, a declared type, a type
constructor application such as `array(int)`, or a type expression such as `T?`).
If it does not resolve to a type, the program is rejected with a diagnostic —
the parser does not fall back to a different parse.

```halka
let age: int: 25            # bind age, type int, value 25
let numbers: array(int): [1, 2, 3, 4]
let name: string?: "HALKA"
```

Chains of length > 3 (`a: T: U: v`) are rejected.

### R1.2 — Operator-position `:` in keyword forms

`send channel : 10`, `store counter : 10`, `add counter : 1`,
`subtract counter : 1`, `exchange counter : 100`, `apply 5 : operation` all use
`:` as the association between a keyword operation's **target** and its
**operand**. These are parsed by the keyword's own production (R7), so the `:`
never reaches the generic binding rule.

---

## R2 — Type position

An expression is parsed in *type position* exactly when it is:

- the middle element of an ascription chain (R1.1),
- the operand after `:` in a parameter list,
- the right side of `type Name :`,
- inside `< >` generic argument lists,
- the operand of `?`, `&`, `&mut`, `raw *`,
- the return-type slot `f(params) : T ,`.

In type position, `(` `)` builds a **tuple type**, `name(args)` is a **type
constructor** (`list(int)`, `map(string, int)`), and `<` always opens generic
arguments. Value-only syntax (literals other than in const-generic slots,
operators, calls with non-type arguments) is rejected there.

---

## R3 — Block openers vs. inline bindings

A `:` that is the final token on its line opens an indented block. Otherwise the
binding is inline.

```halka
page:                  # block
    header:            # nested block
        title: "HALKA" # inline binding

let x: 25              # inline binding
```

### R3.1 — Capitalised block headers declare types

Rule #41 shows `User:` + block as a struct declaration, while Rule #3 shows
`page:` + block as a nested value. These are distinguished by the **identifier
case of the header**:

- **UpperCamelCase** header + block, **at declaration position** → *type declaration*
  (struct). Its body members are `name: Type` fields.
- **lowercase / snake_case** header + block → *record value block*. Its body
  members are `key: value` entries.

This is a hard lexical rule, not a heuristic: `user:` can never declare a type
and `User:` can never build a record value. `Halka` therefore requires type
names to be UpperCamelCase and value names to be lower_snake_case. The formatter
(#48) enforces it and the checker rejects violations with `E0107`.

*Declaration position* means module top level, or the body of a `generate`
block, or a nested type body.

---

## R4 — `[` : index vs. collection literal

Locked rules give `[` three jobs: array/list literal (#5), map literal (#5),
and indexing/slicing (#6, #54).

The parser decides with **zero lookahead**, from the token immediately before `[`:

- If `[` **directly follows** a complete postfix expression (identifier, `)`,
  `]`, string literal, or member access) with **no intervening whitespace-
  significant break**, it is an **index/slice**.
- Otherwise `[` starts a **collection literal**.

Inside an index, `:` is a slice separator and `[a:b:c]` is `slice(a,b,c)`.
Inside a literal, `:` is a map entry and the literal is a map if **any** element
is a `key: value` pair; a mixed literal is rejected (`E0210`).

```halka
let numbers: [10, 20, 30]   # literal — `[` starts a primary
let part: numbers[1:3]      # index   — `[` follows `numbers`
let users: ["alice": 20]    # map literal
```

An empty `[]` is the empty **list**; the empty map is `map()` and the empty set
is `set()`, because `{}` and `[]` cannot be told apart empty.

### R4.1 — `{ }`

`{ }` builds a **set** (#5). It is never a block — Halka blocks are
indentation-based (#49). Inside a string literal, `{expr}` is interpolation (#2).

---

## R5 — Comma: continuation, not an operator

Rule #50 is implemented exactly:

1. The lexer rejects 3+ spaces before `,` (`E0002`).
2. `,` is **not** an expression operator and never appears in the expression
   grammar.
3. In bracketed contexts (`( )`, `[ ]`, `{ }`, `< >`), `,` separates items and a
   trailing `,` before the closer is permitted.
4. In statement contexts, a `,` immediately before a NEWLINE is a **soft
   statement terminator**: it ends the statement and signals that the enclosing
   construct continues. It is accepted and required nowhere else.
5. A statement that is complete on one line needs no `,` (#50).

### R5.1 — Continuation before `else` / `else if`

```halka
if age < 18,
    give false,
else,
    give true
```

The `,` after `give false` terminates that statement *and* keeps the `if`
construct open across the DEDENT. Formally: after parsing a suite, the parser
accepts an optional `COMMA NEWLINE DEDENT` sequence before looking for
`else if` / `else`. The comma is **optional** for the parser (a missing one is
still a single canonical parse) but **required** by the formatter and by
`halka check --strict`, so canonical Halka always has it.

---

## R6 — Function declaration vs. call statement

Both are `ident ( args )`. They are distinguished by what follows:

```
ident ( params ) [ : ReturnType ] ","? NEWLINE INDENT   → function declaration
ident ( args )                     NEWLINE (no INDENT)  → call statement
```

The lexer emits INDENT/DEDENT, so this is decided with **one token of lookahead
past the newline** — no backtracking, satisfying #52.

A parenthesised list is re-interpreted as a parameter list only in the
declaration branch; `connect()` alone is always a call (#18).

---

## R7 — Command-call syntax

Rules #25, #31, #38, #40 and the `say` form all use `keyword-ish-name argument`
with no parentheses:

```halka
say "Welcome"
close file
disconnect connection
cancel task
register handler
log "Hello HALKA"       # macro invocation, #40
```

**Resolution:** Halka has one uniform *command call* production:

```
CommandCall := Identifier Expression ("," Expression)*
```

valid **only in statement position**, and only when the identifier is followed
by a token that can begin an expression and is **not** `(`, `:`, `[`, `.`, or a
binary operator. `f x` is exactly `f(x)`. This single rule covers `say`,
argument-taking macros, and every `close file`-style form in the locked rules,
so no special-case list of magic verbs is needed.

`say` and `give` are additionally **reserved keywords** (#9) because they are
control-flow-relevant, but they use the same production.

Command calls do not nest without parentheses: `close open file` is rejected
(`E0221`); write `close(open(file))`.

---

## R8 — `not` precedence

Rule #51 lists `not` at both level 3 ("unary operators") and level 7 ("logical
not"). These are reconciled as: `not` is **syntactically unary** (level 3 lists
its *form*) and **semantically low-precedence** (level 7 gives its *binding*).

Effective precedence, tightest first:

```
1  ( )                      grouping
2  f(x)  obj.x  a[i]  a[i:j]  postfix ?   call / member / index
3  -x  +x  *p  &x  &mut x  borrow  borrow mut  move  raw   unary
4  as  to                   conversion
5  *  /  %                  multiplicative
6  +  -                     additive
7  ..  ..=                  range
8  <  <=  >  >=  ==  !=  is comparison
9  not                      logical not
10 and                      logical and
11 or                       logical or
12 :                        association / assignment (right-assoc, lowest)
   ,                        structural — NOT an operator
```

`not a == b` is `not (a == b)`, matching the level-7 listing.
`..` binds tighter than comparison so `1..10` works as a loop subject; it binds
looser than `+` so `a+1 .. b-1` is `(a+1)..(b-1)`.

---

## R9 — Generics vs. less-than

`<` opens generic arguments in **type position** (R2) unconditionally. In
**expression position** it is a comparison, *except* for the single pattern:

```
Identifier '<' TypeArgs '>' '('
```

resolved by bounded, side-effect-free lookahead: on seeing `ident <`, the parser
scans forward for a balanced `>` that is immediately followed by `(`. If found,
it is a generic call; otherwise `<` is comparison. The scan never crosses a
NEWLINE, `;`, or an unbalanced closer, so it is O(line length) and total.

Declarations (`find<T>(...)`, `type Pair<T>:`) are always in declaration
position and need no lookahead.

---

## R10 — `is`

`is` is a binary operator (level 8) whose right operand is a **state or type
pattern**, not a general expression:

```halka
if name is null,        # null test
if result is error,     # Result discriminant
if result is cancelled, # task cancellation state
if value is int,        # type test
if info is Struct,      # variant test
```

Right operands are: `null`, `error`, `ok`, `cancelled`, a type name, or an enum
variant name. Anything else is `E0231`.

`x is not null` is **not** V49 syntax (no compound operator was locked); write
`not (x is null)`.

---

## R11 — `or` is both logical-or and null-coalescing

Rule #7 locks `let name: user.name or "Unknown"` and #51 lists `or` as logical.
One operator, one semantics:

> `a or b` evaluates `a`; if `a` is `null` or `false`, it evaluates and yields
> `b`; otherwise it yields `a`.

Short-circuiting. When `a : T?` and `b : T`, the result type is `T` — this is
what makes the locked optional-defaulting idiom type-check. When both are
`bool`, it is ordinary logical or. No third operator is introduced.

`and` is the dual: yields `a` if `a` is `null` or `false`, else `b`.

---

## R12 — Indentation

- Blocks are introduced by a block-opening `:` (R3), by a construct header
  ending in `,` + NEWLINE (`if x,`), or by a declaration header (R6).
- **Spaces only.** A TAB in leading whitespace is `E0003`. (#48/#53 give one
  canonical style; tabs would make the 0–2-space comma rule ill-defined.)
- The canonical indent is **4 spaces**. Any consistent width is accepted by the
  parser; `halka fmt` rewrites to 4.
- Inside `( )`, `[ ]`, `{ }`, `< >`, NEWLINE / INDENT / DEDENT are **suppressed**
  (#49: "bracketed constructs remain naturally layout-independent"). This is why
  vertical and horizontal bracket layouts are exactly equivalent.
- A DEDENT that matches no open block is `E0004`.

---

## R13 — Ranges and slices

- `a..b` — exclusive upper bound (#54)
- `a..=b` — inclusive (#54)
- `range a..b step n` — stepped (#54)
- `x[i]` — index; negative counts from the end (#54)
- `x[a:b]`, `x[:b]`, `x[a:]`, `x[:]`, `x[a:b:s]`, `x[::-1]` — slice (#54)

Slice bounds follow the range convention: `start` inclusive, `end` exclusive,
`step` may be negative. Omitted `start` is `0` (or `len-1` when step < 0),
omitted `end` is `len` (or `-len-1` when step < 0), omitted `step` is `1`.
This is the "exact slice-bound semantics" deferred by #6.

Out-of-range **index** is a runtime error; out-of-range **slice** bounds clamp.

---

## R14 — `enum` header without `:`

Rule #22 shows:

```halka
enum Result<T>
    Ok(value),
    Error(message)
```

The header has no trailing `:` or `,`. **Resolution:** a declaration header
(`enum`, `trait`, `capability`, `X implements Y`, struct `Name:`) may open its
block with `:`, with `,`, or with neither. All three are one canonical parse;
`halka fmt` emits `:` for `enum`/`trait`/`capability`/struct headers, matching
the locked examples.

Enum variant payloads may be written untyped (`Ok(value)`) — the name is then a
field name whose type is inferred or generic (`Ok(value)` in `Result<T>` gives
`value : T`).

---

## R15 — Built-in `Result` and `Option`

`Result<T>` is locked (#22) with variants `Ok(value)` / `Error(message)`. The
implementation defines it in the prelude exactly as written, plus:

- `T?` (#13) is the optional type. It is **not** `Option<T>`; there is no
  separate `Option` enum, because #7 locks `null` as the absence value. `T?` is
  a nullable `T` and `match` on it uses the locked `value` / `null` patterns.
- `to` (#15) produces `Result<T>`; `as` (#15) produces `T` and is rejected at
  compile time if the conversion can fail.
- Task results (#31) carry a third state: `cancelled`. `await` yields
  `Result<T>` extended with the `cancelled` discriminant, which is why
  `result is cancelled` is a distinct test from `result is error`.

---

## R16 — No lambdas, no overloading, no exceptions

Locked as absences (#17, #21, #23). The implementation must reject, with a
diagnostic that names the rule:

- any anonymous-function syntax → `E0301 (rule #17)`
- a second definition of a name in one scope → `E0302 (rule #21)`
- `try` / `catch` / `throw` / `finally` as keywords → `E0303 (rule #23)`

These keywords are **reserved and rejected**, not merely absent, so the error
message can teach the locked alternative.

---

## R17 — Reserved words

```
and      as       atomic     await     borrow    break     c         callback
cancel   cancelled capability compile  const     continue  cpp       defer
device   else     enum       error     export    extern    false     for
from     generate give       if        implements import   in        is
kernel   launch   let        load      macro     make      match     move
mut      not      nothing    null      ok        or        parallel  py
raw      receive  reflect    register  release   requires  revoke    say
send     specialize start    step      store     to        trait     true
type     unsafe   while      with

reserved-and-rejected (R16): catch  finally  throw  try
reserved-for-future:          async  class  fn  func  import!  lambda  return  yield
```

`acquire`, `add`, `close`, `disconnect`, `exchange`, `open`, `range`,
`subtract`, `apply`, `print`, `work`, `process` are **not** keywords — they are
prelude functions reached through the command-call rule (R7). This keeps the
keyword set small and makes the locked examples work without magic verbs.

---

## R18 — Statement vs. expression

Halka is **statement-oriented** (#9 gives `give` as the single return
mechanism; no expression-bodied functions were locked).

- `if`, `match`, `for`, `while`, `with`, `parallel`, `unsafe`, `defer` are
  **statements**.
- `match` is additionally usable as an **expression** when every arm's suite is a
  single expression statement — this is the one place a block yields a value,
  and it is needed for the locked `match` examples that bind results.
- Everything else that yields a value is an expression.

A function with no `give` returns `nothing` (the unit value, #16).

---

## R19 — FFI boundaries

`c`, `cpp`, `py` (#35–#37) are **prefix boundary markers**, parsed as part of the
following construct, not as expressions:

```
c   Declaration | Type | CallExpr | "struct" Name Block
cpp Declaration | Type | CallExpr | "class" Name Block
py  CallExpr | MemberExpr
```

Inside a marked construct, Halka's grammar still applies (#35: "The FFI layer,
not a second language grammar"). Foreign values cross the boundary through a
declared marshalling table; foreign exceptions become `Result` errors (#36, #37).

---

## R20 — Compile-time tier

`compile`, `macro`, `generate`, `reflect`, `specialize` (#39–#43) run in a
**compile-time interpreter** that is the same evaluator as the runtime VM, with:

- no I/O capability (#45) unless granted by the build manifest,
- a step budget; exceeding it is a compiler diagnostic, not a hang,
- failures reported as diagnostics, never as runtime `Result` (#39),
- output re-entering the normal pipeline: lex → parse → check (#40, #41).

Macros are hygienic: identifiers introduced by a macro body are renamed to a
fresh scope unless they came from the macro's arguments (#40).

---

## R21 — Division always yields a float

`/` on two `int`s yields a `float`: `7 / 2` is `3.5`, not `3`. This removes the
single most common beginner bug in C and Python 2 without adding an operator.

Truncating division is the prelude function `div(a, b)`, and `%` on two `int`s
yields an `int` with **floored** semantics (the sign follows the divisor), so
`div` and `%` agree: `a == div(a, b) * b + a % b` holds for every sign.

---

## R22 — `int` is 64-bit

Rule #11 lists `int` as a primitive and defers exact widths to "the formal
type-system specification". This is that specification.

- **`int` is a signed 64-bit two's-complement integer.** `uint` is its unsigned
  counterpart. `byte` is `uint8`. The sized names `int8`…`int64` and
  `uint8`…`uint64` are exact.
- **`float` is IEEE-754 binary64.** `float32` is binary32.
- Overflow **traps** in a debug build (`halka build`) and **wraps** in a release
  build (`halka build --release`), matching Rust. Wrapping is never silent in
  development, and never a branch in production.
- Arbitrary-precision arithmetic is a library type, `bigint`, not the default.

The reason is the whole point of the language: a value the native backend
compiles to a machine register cannot also be an arbitrary-precision heap
object. Python chose unbounded `int` and pays for it on every arithmetic
operation; a language claiming C-level performance cannot make that choice for
its default integer.

The reference interpreter applies the same 64-bit wrapping, so a program
produces identical results under `halka run` and `halka build`.

---

## R23 — What the native backend must guarantee

`halka build` and `halka run` are two implementations of one language. Where
they can differ, this is the contract:

1. **Identical observable behaviour** for any program both accept. The test
   suite runs golden-output cases under both and diffs them.
2. The native backend may **reject** programs the interpreter accepts, when a
   value's type is not concrete enough to compile without boxing. The error
   names the expression and suggests an annotation.
3. The native backend may not **accept** a program the checker rejects.
4. **One entry point, in both.** Top-level statements run in source order,
   and then, if the program declares a `main()` taking no parameters, it is
   called. A backend that skipped it would run the program and silently do
   nothing, which is the exact failure clause 1 rules out.
5. **Modules are linked, not separately compiled.** `halka build` folds every
   imported module into one program before emitting C: each imported
   declaration gets a unique name and each reference is rewritten
   (`compiler/src/sema/link.ts`). Only declarations cross the boundary — a
   module's top-level statements do not run on import, which is what the
   interpreter already does. The cost is that there is no incremental build;
   the benefit is that the C compiler can inline across modules and that
   inference, ownership and escape analysis need no notion of modules at all.

---

## Diagnostic numbering

| Range | Area |
|---|---|
| `E0001`–`E0099` | lexical (incl. `E0002` comma spacing, `E0003` tabs) |
| `E0100`–`E0199` | grammar / parse |
| `E0200`–`E0299` | resolution & names |
| `E0300`–`E0399` | locked-absence violations (R16) |
| `E0400`–`E0499` | types |
| `E0500`–`E0599` | ownership / borrow / capability |
| `E0600`–`E0699` | compile-time tier |
| `E0700`–`E0799` | native backend / codegen |
| `W1000`+ | warnings |
