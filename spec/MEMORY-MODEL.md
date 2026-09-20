# Halka Memory Model — safe by default, no lifetime annotations

**Status:** design, normative for the implementation · **Implements** locked rules #14, #25, #46

---

## The goal

Rust proved memory safety without a garbage collector is possible. It also
proved the price: lifetime annotations, generic lifetime parameters, and a
borrow checker that people spend weeks fighting before they are productive.

C and C++ have no price at the keyboard and pay it in production: use-after-free
and buffer overflows remain the largest single source of CVEs in C/C++ code.

Halka takes a third position:

> **Memory safety with no garbage collector, no lifetime annotations, and an
> aliasing rule that fits in one paragraph — at the cost of not being able to
> return a borrow.**

That last clause is the whole trade. It is what lets the analysis stay local and
the error messages stay short. Everything below follows from it.

---

## M1 — Every value has exactly one owner

Heap data (lists, maps, sets, strings, structs, enum payloads) is **uniquely
owned**. Assigning, passing, or returning a value **moves** ownership.

```halka
let a: [1, 2, 3],
let b: a          # ownership moves from `a` to `b`
say a             # error: `a` was moved
```

When an owner goes out of scope, its value is freed. Deterministically, at a
known point, with no collector and no pause.

`move` (#25) is the **explicit** spelling of what already happens, used when the
author wants the transfer to be obvious at the call site:

```halka
let other: move file
```

Scalars — `int`, `float`, `bool`, `char`, `byte` — are **copied**, not moved.
They have no heap identity, so aliasing them is harmless.

### M1.1 — Implicit copy for small plain data

A struct whose fields are all scalars is copied rather than moved. The compiler
decides this from the type, and reports it in `halka check --explain` so the
behaviour is never a mystery. This removes the most common source of
"unnecessary clone" noise in Rust code.

---

## M2 — Borrows are lexical and non-escaping

`borrow` and `borrow mut` (#14) create a **view** of a value you do not own.

The entire rule:

> A borrow is valid from the point it is created to the end of the enclosing
> block. It may not be stored in a data structure, returned from a function,
> captured by a task, or outlive the value it borrows.

That is checkable with a single scope-depth comparison. No lifetime variables,
no annotations, no variance, no subtyping. The compiler never asks you to name a
lifetime because it never needs to reason about two of them at once.

```halka
sum_of(numbers),               # `numbers` is borrowed, not moved
    let total: 0,
    for n in numbers,
        total: total + n,
    give total

let data: [1, 2, 3],
say sum_of(borrow data),
say data                        # still usable — it was never moved
```

### M2.1 — Aliasing

At any point a value has **either** one `borrow mut` **or** any number of
`borrow`, never both. This is the same core rule as Rust's, and it is what makes
data races impossible. It is cheap to check because M2 guarantees every borrow
dies at a block boundary the compiler can see.

### M2.2 — Parameters borrow by default, and ownership is inferred

A function parameter **borrows** its argument. This is the single most
important ergonomic decision in this document: ordinary code — the
overwhelming majority of code — never writes `borrow`, never moves anything by
accident, and never sees a "value used after move" error.

```halka
render(user),                  # borrows; the caller keeps its value
    say user.name

let u: User("Asha", 31),
render(u),
render(u)                      # fine, twice
```

A function that needs to **keep** its argument — store it, return it, hand it
to a task — cannot do that with a borrow (M2). Rather than make the author
annotate that, the compiler **infers it**:

> A parameter is *owning* if and only if the function body moves it. Every call
> site then moves the corresponding argument.

```halka
Registry:
    users: list(User)

remember(r, u),                # `u` is stored, so `u` is an owning parameter
    r.users.push(u)

let u: User("Asha", 31),
remember(registry, u),
say u.name                     # error E0504: `u` was moved into `remember`
```

The error names the call that took ownership, so the inference is never
invisible:

```
error[E0504]: `u` was moved and can no longer be used
  --> app.hk:9:5
   |
 8 | remember(registry, u),
   |                    - moved here, because `remember` keeps its argument
 9 | say u.name
   |     ^ used after the move
```

This is a deliberate reading of rule #11 — "type annotations are optional
whenever the compiler can infer the type unambiguously" — applied to ownership
rather than to types. It also means **no new syntax**: a `move` marker in
parameter position would be a grammar change, and the V49 syntax is locked.

`move` at a call site (#25) stays available and forces the transfer explicitly
when an author wants it visible there.

The inference is a fixpoint over the call graph: passing a parameter to another
function's owning parameter is itself a move.

### M2.3 — What you give up

You cannot return a borrow, or store one in a struct.

```halka
first_of(items),
    give borrow items[0]       # error E0510: a borrow cannot leave its block
```

Three ways out, in order of preference:

1. **Return the value** — moves or copies, and is what most code wants.
2. **Return an index or key** — the standard pattern for "a handle into a
   collection", and it stays valid across mutation in a way a pointer would not.
3. **Use `shared(T)`** (M3) when the data genuinely has several owners.

This restriction is the deliberate cost. It rules out some zero-copy designs
that Rust expresses. In exchange there are no lifetime annotations anywhere in
the language, and the borrow checker has no state to explain.

---

## M3 — `shared(T)` for genuine shared ownership

When several owners really are needed — a graph, a cache, an observer list —
ownership becomes explicit and visible:

```halka
let cache: shared(Cache): Cache(),
let worker_copy: cache          # a second owner; refcount 2
```

`shared(T)` is reference counted. Non-atomic by default; the compiler switches
to atomic counting automatically when the value can reach another task, and says
so under `--explain`.

Cycles leak. This is stated plainly rather than hidden: `halka check` warns when
a `shared` type can reach itself (`W1010`), and `weak(T)` breaks the cycle --
a `weak` edge is not followed when working out whether a type reaches itself.

**Implemented in the checker.** `shared(T)` and `weak(T)` type-check, read
through to what they hold, and are copied rather than moved, so several
owners of one value are allowed where a plain struct would be a move error.
The cycle warning is implemented. What is *not* yet implemented is the
runtime half: the interpreter is garbage-collected, so `shared` needs no
counting there, and the native backend refuses `shared` by name (R23)
rather than compiling it without one. Refcounting
with an honest cycle warning is a better trade for a systems language than a
tracing collector with unpredictable pauses.

**`shared` is opt-in and rare.** If a program is full of `shared`, that is a
design smell the compiler will point out, not the default path.

---

## M4 — The compiler removes the cost

**Implemented for deallocation; the optimisations below are in progress.**

The safety rules above are enforced statically, so the generated C contains:

- **No refcount traffic for owned values.** ✅ M1 means ownership is known at
  compile time, so the backend emits a plain `free` at the owner's scope exit —
  at the end of the *block* that declared the value, so something built inside
  a loop is freed every iteration rather than accumulating. Values created
  inside an expression and never named are freed when their statement ends.
  The runtime counts live heap objects, so this is a test rather than a claim:
  every compiled program in the repo exits with zero live objects.
- **No bounds checks where the index is provably in range.** Loop-invariant
  index analysis covers the common `for i in 0..len(xs)` case entirely. *Not
  yet implemented; `--release` currently drops every bounds check, which is the
  blunt version of the same thing.*
- **Stack allocation wherever escape analysis proves a value does not outlive
  its frame** — which, given M2, is most values. *The analysis identifies these;
  the backend does not yet place them on the stack.*
- **Refcounting only for `shared`**, and non-atomic unless the value escapes to
  another task.

The target is that idiomatic Halka compiles to the same machine code an
equivalent C program would produce, with the bounds checks that C omits and
Halka can prove away. Where a check cannot be proven away it stays, and
`halka build --explain-checks` lists every one that survived, so the cost is
auditable instead of invisible.

### Checking it yourself

"The compiler frees what it allocates" is the kind of claim that rots quietly,
so the runtime keeps two counters and any compiled binary will report them:

```
$ HALKA_REPORT_LEAKS=1 ./myprogram
halka: 0 heap object(s) still live at exit, of 4021 allocated
```

String literals are interned and excluded from the live count, since they are
never freed by design. The test suite runs every native and FFI test this way
and fails the build on a non-zero count, which is why the analysis cannot
regress without someone noticing.

---

## M5 — Concurrency safety falls out of M2

There is no GIL and no global lock. Real OS threads, real parallelism.

Data races are prevented by the same aliasing rule, applied across tasks:

- A task may capture values it **owns** (moved in at `start`).
- A task may capture `shared(T)` — refcounted atomically.
- A task may **not** capture a borrow (M2 forbids a borrow escaping its block,
  and a task outlives the block that spawned it).

So `start f(x)` moves `x` into the task, and the compiler rejects the race
rather than documenting it. Channels (#27) move values between tasks; mutexes
(#29) and atomics (#30) cover shared mutable state.

This is the property Python cannot offer at any price, and the property C
offers only if you never make a mistake.

---

## M6 — `unsafe` is the only escape hatch

Raw pointers (#46) are explicitly marked `raw`, and dereferencing one, doing
pointer arithmetic, or crossing an FFI boundary with one requires an `unsafe:`
block. Safe references and raw pointers never implicitly convert.

Everything unsafe in a Halka program is therefore greppable — a property C
cannot offer, because in C everything is unsafe.

---

## How this compares

| | C / C++ | Rust | Go / Java | **Halka** |
|---|---|---|---|---|
| Memory safe by default | no | yes | yes | **yes** |
| Garbage collector | no | no | yes | **no** |
| Pauses | none | none | yes | **none** |
| Lifetime annotations | n/a | required | n/a | **never** |
| Can return a borrow | yes (unsafely) | yes | n/a | **no** |
| Data races prevented | no | yes | no (Go) | **yes** |
| Learning curve of the model | low, then production bugs | high | low | **low** |

The honest summary: Halka gives you most of Rust's guarantees for a fraction of
Rust's conceptual load, and pays for it by ruling out returned borrows. For
application, server, and numeric code — including the ML workloads this language
is aimed at — that restriction almost never binds. For a zero-copy parser or an
intrusive data structure, it does, and `unsafe:` is there.

---

## Diagnostics

| Code | Meaning |
|---|---|
| `E0504` | value used after move — *shows where it moved, and why* |
| `E0508` | cannot move out of a borrow |
| `E0509` | cannot mutate through a shared borrow |
| `E0510` | a borrow cannot leave the block that created it |
| `E0511` | `borrow mut` while other borrows are live |
| `E0512` | a task cannot capture a borrow — move it, or use `shared` |
| `W1010` | a `shared` type can reach itself; the cycle will leak — use `weak` |

Every one of these names the variable, points at both the offending use and the
earlier event that caused it, and suggests the fix. A memory-safety error that
does not teach is a failure of this design.
