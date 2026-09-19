<!--
  HALKA V49 — LOCKED SYNTAX SPECIFICATION
  ======================================
  This file is the canonical, machine-transcribed record of the 54 locked
  syntax rules authored during the V49 design phase.

  STATUS: LOCKED. Do not edit the rules in this file.

  The original authored documents are preserved byte-for-byte in
  `spec/source/*.docx`. This markdown is generated from them by
  `spec/tools/gen_spec.py` and must stay faithful to them.

  Changing a locked rule requires a numbered HEP (Halka Enhancement Proposal)
  under `spec/heps/` plus a version bump past V49. Implementation questions
  that the locked rules leave open are answered in `spec/RESOLUTIONS.md`,
  which may ONLY narrow, never contradict, this document.
-->

# HALKA V49 — Locked Syntax Specification

**Status:** LOCKED · **Rules:** 1–54 · **Baseline:** V49


HALKA V49 — Syntax Design
Locked Rules 1–15


Canonical syntax baseline — design phase


Design note: This document consolidates the syntax decisions locked during the V49 design phase. It is a syntax/design specification, not an implementation claim.


## Global Syntax Rules


🔒 LOCKED

- `:` is the universal assignment / association operator where a genuine assignment or relationship exists.
- `,` is the universal continuation / separation mechanism.
- The syntax must remain homogeneous across the whole language; equivalent operations should not gain unrelated alternate forms.
- Type annotations are optional whenever the compiler can infer the type unambiguously.
- For comma spacing, 0, 1, or 2 spaces before `,` are valid; 3 or more spaces before `,` are lexically invalid.
```halka
value,
value ,
value  ,

# invalid:
value   ,
```

- For bracketed constructs, horizontal and vertical layouts are both valid wherever the grammar permits brackets.

## 1. Operators & Expressions


🔒 LOCKED


Design note: Expressions use the same `:` and `,` principles as the rest of HALKA. `:` associates a name/target with a value where assignment is intended; `,` separates or continues expressions/statements.

```halka
let total: price * quantity,
let ok: age >= 18,
let value: add(a, b)
age: 25,
name: "HALKA"
user.name: "HALKA",
user.age: 25
let first: items[0],
items[0]: "build"
let numbers: 1..10
```


Design note: Implicit conversions should be limited to safe, unambiguous cases; potentially lossy or unsafe conversions are explicit (see Rule 15).


## 2. Strings & Interpolation


🔒 LOCKED

- `"..."` is the normal string form.
- `'...'` is the character form.
- `{expression}` performs string interpolation.
- `"""..."""` is the multiline string form.
- `r"..."` is the raw string form.
- Interpolation is preferred over competing concatenation syntaxes.
```halka
let name: "HALKA",
let message: "Hello {name}"
let age: 25,
let message: "I am {name} and I am {age} years old"
let message: """
HALKA is simple,
readable,
and powerful.
"""
```


## 3. Multiline Code & Structure


🔒 LOCKED

- A construct that is valid on one line must remain naturally valid across multiple lines without changing meaning.
- Indentation expresses hierarchy, not accidental grammar changes.
- Multiline collections, calls, expressions, and nested structures must be natural.
```halka
let tasks: [
    "build",
    "test",
    "release"
]
result: process(
    input,
    options,
    configuration
)
page:
    header:
        title: "HALKA",
    content:
        say "Welcome"
```


## 4. Destructuring / Unpacking


🔒 LOCKED

- Destructuring uses the same structural notation as the value being unpacked.
- `:` associates the destructuring pattern with the source value.
- `,` separates destructured elements.
- `_` ignores a value.
- `...rest` captures remaining elements.
- Horizontal and vertical forms are both valid.
```halka
let point: (10, 20),
let (x, y): point
let [a, b, c]: [10, 20, 30]
let [a, b, c]: [
    10,
    20,
    30
]
let [first, _, third]: [10, 20, 30]
let [first, second, ...rest]: numbers
let [(x1, y1), (x2, y2)]: data
```


## 5. Data Structures


🔒 LOCKED

- Tuples, arrays, lists, maps, and sets follow the same syntax system.
- Type inference is the default when the element/value type can be determined unambiguously from contents/context.
- Explicit container types remain available when needed.
- Horizontal and vertical bracket layouts are equally valid.
```halka
let point: (10, 20)
let numbers: [1, 2, 3, 4]
let numbers: [
    1,
    2,
    3,
    4
]
let numbers: array(int): [1, 2, 3, 4]
let numbers: array(int): [
    1,
    2,
    3,
    4
]
let tasks: list(string): [
    "build",
    "test",
    "release"
]
let users: [
    "alice": 20,
    "bob": 25
]
let tags: {
    "compiler",
    "runtime",
    "web"
}
```


Design note: Within a map, `:` expresses key → value association. Collection elements themselves remain comma-separated.


## 6. Indexing, Slicing & Ranges


🔒 LOCKED

- Indexing uses bracket access: `items[index]`.
- Ranges use `..`.
- Slicing uses bracket ranges; exact slice bounds will be finalized in the formal grammar, but must obey the same multiline and comma rules.
```halka
let first: items[0],
items[0]: "build"
let numbers: 1..10
for i in 1..10,
    say i
```


Design note: The surface forms above are locked. Exact inclusive/exclusive slice-bound semantics are a semantic/grammar detail to specify consistently during the formal specification pass.


## 7. `null` & Optionals


🔒 LOCKED

- `null` represents absence of a value.
- `T?` denotes an optional value of type `T`.
- Optionality is inferred when the compiler can determine it unambiguously.
- `if`, `match`, and `or` are normal mechanisms for handling optional values.
```halka
let value: null
let name: string?
let name: string?: "HALKA"
if name is null,
    say "no name",
else,
    say name
let name: user.name or "Unknown"
match name,
    value,
        say value,
    null,
        say "No name"
```


## 8. `break` / `continue`


🔒 LOCKED

- `break` exits the nearest enclosing loop.
- `continue` skips the current iteration of the nearest enclosing loop.
- Both are standalone control-flow statements and use the normal comma + indentation grammar.
```halka
for item in items,
    if item == "stop",
        break
for item in items,
    if item == "skip",
        continue,
    say item
```


## 9. Early `give` / Control-Flow Behavior


🔒 LOCKED

- `give` is the single return / early-exit mechanism for functions.
- `give` may return a value or nothing.
- `give` always exits the current function, even when nested inside an `if` or loop.
- `if`, `else if`, and `else` use the same comma + indentation grammar in these contexts.
```halka
check(age),
    if age < 18,
        give false,
    else,
        give true
process(data),
    if data is null,
        give,
    else,
        work(data)
find(items, target),
    for item in items,
        if item == target,
            give item,
    give null
```


## 10. Pattern Details for `match`


🔒 LOCKED

- Supported patterns: literals, variable bindings, enum/variant patterns, struct patterns, tuple patterns, collection patterns, wildcard `_`, and guarded patterns.
- Guarded patterns use `if`.
- The fallback uses `else`.
- Every case follows the same comma + indentation structure.
```halka
match value,
    0,
        say "zero",
    1,
        say "one",
    n if n > 1,
        say "many",
    else,
        say "other"
match result,
    Ok(value),
        say value,
    Error(message),
        say message,
    else,
        say "unknown"
match point,
    (0, 0),
        say "origin",
    (x, y),
        say x
match items,
    [],
        say "empty",
    [first, ...rest],
        say first,
    else,
        say "other"
```


## 11. Primitive Types


🔒 LOCKED

- Core primitive family: `int`, `uint`, `float`, `byte`, `bool`, `string`, `char`, plus `null` as the absence value.
- Exact-width numeric types such as `int8`/`int64` may be specified in the formal type-system specification; the surface rule here is that explicit primitive annotations remain optional when inference is unambiguous.
```halka
let age: 25,
let price: 10.5,
let active: true,
let name: "HALKA",
let initial: 'H'
let age: int: 25,
let price: float: 10.5,
let active: bool: true,
let name: string: "HALKA"
```


## 12. Type Aliases


🔒 LOCKED

- `type Name: ExistingType` creates an alias, not a new nominal type.
- Aliases can name primitive, collection, tuple, compound, and generic types.
```halka
type UserId: int
type Username: string
let id: UserId: 25,
let name: Username: "HALKA"
type Scores: list(int)
type Tags: set(string)
type Users: map(string, int)
type Point: (int, int)
type Pair<T>: (T, T)
```


## 13. Optional Types


🔒 LOCKED

- `T?` means an optional `T`.
- Optional values may contain `null`.
- Global type inference remains active.
```halka
let name: string?
let name: string?: "HALKA",
let age: int?: 25
greet(name: string?),
    if name is null,
        say "Hello",
    else,
        say name
find_user(id: int): User?,
    give user or null
```


## 14. References / Pointers


🔒 LOCKED

- Safe borrowing uses `borrow` and `borrow mut`.
- Explicit reference types use `&T` and `&mut T`.
- Dereferencing uses `*`.
- Raw pointers are explicitly marked `raw`; operations that can violate safety require `unsafe`.
```halka
let data: [1, 2, 3],
let view: borrow data
let data: [1, 2, 3],
let view: borrow mut data
let value: 25,
let ref: &value,
say *ref
let value: 25,
let ref: &mut value,
*ref: 30
let ptr: raw *int
unsafe:
    say *ptr
```


Design note: The safe borrowing syntax above is normalized to the global `:` assignment/association rule; the semantic distinction remains the same as the locked `borrow` / `borrow mut` design.


## 15. Casting / Conversions


🔒 LOCKED

- Safe, obvious conversions may be implicit.
- Potentially lossy or unsafe conversions must be explicit.
- `as` is the explicit cast/conversion form expected to succeed.
- `to` represents a conversion that may fail and therefore fits the existing `Result` model.
- C-style cast syntax is not part of V49.
```halka
let value: 25,
let decimal: value as float
let value: 3.14,
let whole: value as int
let text: value as string,
let number: text as int
result: text to int,
if result is error,
    give result,
else,
    use result
```


## Final Locked Status — Rules 1–15


| No. | Area | Status |
|---|---|---|
| 1 | Operators & expressions | LOCKED |
| 2 | Strings & interpolation | LOCKED |
| 3 | Multiline code & structure | LOCKED |
| 4 | Destructuring / unpacking | LOCKED |
| 5 | Data structures | LOCKED |
| 6 | Indexing, slicing & ranges | LOCKED |
| 7 | null & optionals | LOCKED |
| 8 | break / continue | LOCKED |
| 9 | Early give / control-flow behavior | LOCKED |
| 10 | Pattern details for match | LOCKED |
| 11 | Primitive types | LOCKED |
| 12 | Type aliases | LOCKED |
| 13 | Optional types | LOCKED |
| 14 | References / pointers | LOCKED |
| 15 | Casting / conversions | LOCKED |


Review note: The document was checked for internal consistency against the locked decisions: comma continuation/separation, the global colon rule, optional type inference, horizontal/vertical bracket forms, and consistency of the syntax patterns used across Rules 1–15. No alternate syntax is introduced within these rules.


HALKA V49


Syntax Design — Locked Rules 16–34


Canonical language-design record • No implementation changes


## Global V49 Syntax Rules

- `:` is the universal assignment / association operator wherever a genuine assignment, mapping, annotation, or relationship exists.
- `,` is the universal continuation / separation mechanism.
- A complete single-line statement does not require a comma.
- When a construct continues across two or more lines within the same set / sequence / block, the comma is used to mark continuation / separation.
- Spaces before `,`: 0, 1, or 2 are valid; 3+ spaces before `,` are lexically invalid.
- Both horizontal and vertical forms are valid for bracketed constructs where the grammar permits them.
- Explicit type annotations are optional when the compiler can infer the type unambiguously.

## #16 — Interfaces beyond traits


HALKA V49 does not have a separate interface construct. Traits provide the interface / behavior-contract role, including implementation and generic constraints.

- A second interface system is intentionally avoided to prevent overlapping abstraction mechanisms.

Trait contract


trait Printable:
    print(),
        give nothing


Implementation


User implements Printable:
    print(),
        say name


Multiple traits


User implements Printable, Serializable:
    print(),
        say name


## #17 — Function values / references


Named functions are first-class values. A function can be stored, passed, returned, placed in collections, and applied through the canonical apply syntax. There is no lambda syntax and no separate function-reference operator.


Named function


square(x),
    give x * x


Store a function


let operation: square


Apply a function value


let result: apply 5 : operation


Use a named function directly


let result: apply 5 : square


Function values in a collection


let operations: [
    square,
    cube
]


## #18 — Default parameters


Default parameters use the same canonical function syntax. `:` associates a parameter with its type and default value; `,` separates parameters and continues a multi-line function body. Required parameters precede default parameters.


Typed default


greet(name: string: "HALKA"),
    say name


Inferred default type


greet(name: "HALKA"),
    say name


Multiple parameters


connect(host: string: "localhost", port: int: 8080),
    say host,
    say port


Call with defaults


connect()


Override defaults


connect("example.com", 443)


## #19 — Variadic parameters


Variadic parameters use `...T`, accept zero or more values, follow required parameters, and do not have defaults. Calls remain ordinary comma-separated argument lists.


Variadic function


sum(values: ...int),
    give total


Required + variadic


multiply(factor: int, values: ...int),
    give total


Call


sum(1, 2, 3, 4)


## #20 — Recursive functions


Recursion is a normal property of functions. A function may call itself or another function without any special recursive syntax.


Basic recursion


factorial(n),
    if n <= 1,
        give 1,
    else,
        give n * factorial(n - 1)


Mutual recursion


even(n),
    if n == 0,
        give true,
    else,
        give odd(n - 1)


Generic recursion


find<T>(items: list(T), target: T),
    if items == [],
        give null,
    else if items[0] == target,
        give items[0],
    else,
        give find(items[1:], target)


## #21 — Function overloading


HALKA V49 does not support traditional function overloading. Each function name has one canonical definition. Generics and distinct function names are used instead.


Not allowed


add(a: int, b: int),
    give a + b

add(a: float, b: float),
    give a + b


Preferred generic form


add<T>(a: T, b: T),
    give a + b


## #22 — Result model


Result<T> is the standard success / failure model. Recoverable failures use Ok(value) and Error(message), handled through the existing if / else, match, and give grammar.


Result type


enum Result<T>
    Ok(value),
    Error(message)


Successful result


result: Ok(value)


Error result


result: Error("File not found")


Handling


result: load("data.txt"),
if result is error,
    give result,
else,
    process result


Match handling


match result,
    Ok(value),
        process value,
    Error(message),
        say message


## #23 — Exception model


HALKA V49 has no traditional exception system. Result<T> is the standard recoverable error mechanism. Fatal runtime / system failures are outside ordinary Result flow.

- No try / catch / throw / finally language family is introduced.

Standard pattern


result: load("data.txt"),
if result is error,
    give result,
else,
    process result


## #24 — defer / cleanup


defer schedules cleanup for the current function exit. Deferred operations run even when the function exits through give and execute in reverse registration order. defer works with the ownership / resource system.


Basic cleanup


process(),
    file: open("data.txt"),
    defer close file,
    work()


Early give still cleans up


process(),
    file: open("data.txt"),
    defer close file,
    if invalid,
        give,
    work()


Reverse registration order


process(),
    file: open("data.txt"),
    connection: connect(),
    defer close file,
    defer disconnect connection,
    work()


## #25 — Resource acquisition / release


Resources are acquired through ordinary expressions and assigned with `:`. Ownership determines responsibility and automatic lifetime cleanup; defer provides explicit deterministic release ordering; move / borrow / borrow mut control ownership and access.


Acquire


let file: open("data.txt")


Explicit release


close file


Acquire + cleanup


process(),
    let file: open("data.txt"),
    defer close file,
    work()


Move ownership


let file: open("data.txt"),
let other: move file


Borrow


let file: open("data.txt"),
let view: borrow file


Multiple resources


process(),
    let file: open("data.txt"),
    let connection: connect(),
    defer close file,
    defer disconnect connection,
    work()


## #26 — Tasks


Tasks are the basic unit of concurrent execution. start creates a task; await obtains its completion / result. Tasks execute normal functions and integrate with Result.


Start


task: start worker(),


Start with arguments


task: start process(data, config),


Await


task: start worker(),
result: await task


Multiple tasks


first: start worker_one(),
second: start worker_two(),
result1: await first,
result2: await second


Task result


task: start square(5),
result: await task


## #27 — Channels


Channels are typed communication values. make channel(T) creates a channel; send channel : value sends; receive channel receives; close channel closes. `:` associates the channel operation with the value.

- A complete single-line statement such as `value: receive channel` does not require a comma. Commas are used when the channel sequence continues across multiple lines.

Create


channel: make channel(int),


Send


send channel : 10,


Receive


value: receive channel


Full example


channel: make channel(int),
send channel : 10,
send channel : 20,
first: receive channel,
second: receive channel


Buffered channel


channel: make channel(int): 10,


## #28 — await semantics


await expression waits for the asynchronous task represented by the expression and yields its result. It does not create or start the task.


Basic


task: start worker(),
result: await task


Single line


result: await task


Direct await


result: await start worker()


Control flow


if ready,
    result: await task,
    process result


Result handling


result: await task,
if result is error,
    give result,
else,
    process result


## #29 — Mutexes / locks


Mutexes provide explicit synchronization through acquire and release, with scoped with locking for automatic release. The same : / , system applies.


Create


lock: make mutex


Explicit lock / unlock


acquire lock,
work(),
release lock


Scoped locking


with lock,
    work()


Shared data


lock: make mutex,
counter: 0,
with lock,
    counter: counter + 1


Read / write lock


lock: make rwmutex


## #30 — Atomics


Atomics provide thread-safe operations on shared primitive values without requiring a mutex. `:` associates operations with their operands; `,` continues multi-line sequences.


Create


counter: atomic(0)


Explicit type


counter: atomic(int): 0


Load


value: load counter


Store


store counter : 10


Add / subtract


add counter : 1,
subtract counter : 1


Exchange


old: exchange counter : 100


Atomic flag


ready: atomic(false),
store ready : true


## #31 — Cancellation


Task cancellation uses cancel task. Tasks may detect cancellation through cancelled, perform cleanup, and exit. Cancellation is observable distinctly from ordinary errors when awaiting a task.


Cancel


cancel task


Detect


if cancelled,
    give


Graceful cancellation


worker(),
    if cancelled,
        cleanup(),
        give,
    work()


Cancel + await


task: start worker(),
cancel task,
result: await task


Observe cancellation


result: await task,
if result is cancelled,
    say "task cancelled",
else if result is error,
    say "task failed",
else,
    process result


## #32 — Parallelism vs async


HALKA distinguishes asynchronous task execution from explicit parallel work. start / await provide task concurrency; parallel: expresses explicitly parallel computation. The runtime manages scheduling by default.

- Ordinary code should not require manual specification of threads or CPU cores unless a separate low-level facility is explicitly introduced.

Async


task: start fetch_data(),
result: await task


Concurrent tasks


first: start calculate_a(),
second: start calculate_b(),
result1: await first,
result2: await second


Explicit parallel block


parallel:
    first: calculate_a(),
    second: calculate_b()


## #33 — Import / export details


Modules use import, from ... import, and export. `:` expresses genuine associations such as aliases or metadata; `,` separates and continues multi-line import / export sets.


Single import


import math


Multiple imports


import math,
import net.http,
import graphics


Specific names


from math import sqrt


Alias


import mathematics: math


Export


export User,
export connect,
export version


Export block


export:
    User,
    connect,
    version


## #34 — Packages


Packages organize, version, distribute, and depend on collections of HALKA modules. Package metadata and dependency mappings use `:`; multi-line collections use `,`. Package organization comes from project structure rather than a redundant package-specific language declaration.


Project structure


halka-project/
    package.hk
    src/
        math.hk
        utils.hk


Package metadata


package:
    name: "halka-tools",
    version: "1.0.0",


Dependencies


dependencies:
    mathlib: "2.1.0",
    netlib: "1.4.0",


Import package


import "halka-tools"


Import module


import "halka-tools/math"


Import names


from "halka-tools/math" import sqrt, sin


## Consistency Review — 16–34

- No lambda syntax was introduced; function values use named functions only.
- No traditional function overloading was introduced.
- No traditional exception syntax was introduced; Result is the recoverable error model.
- The global `:` association principle is preserved across types, traits, values, channels, atomics, metadata, and package mappings where a genuine relationship exists.
- The global comma principle is preserved: commas separate / continue multi-line sets; complete single-line statements do not require a comma.
- The earlier channel correction is preserved: `send channel : 10,` includes a comma when the sequence continues to the next line.
- Type inference remains global and explicit annotations remain optional when inference is unambiguous.
- No separate interface language construct is introduced beyond traits.
- The 16–34 set remains compatible with the previously locked core syntax direction.

HALKA V49 • Rules 16–34 • LOCKED


HALKA V49 — Syntax Design
Locked Rules #35–#54


Third and final locked syntax-design record for the current V49 sequence


Scope. This document records the syntax decisions locked after Rules #1–#34. It preserves the global V49 principles established during the design process and includes the later-added #54 Indexing, Slicing & Ranges rule.


## Global V49 Syntax Principles

- `:` is the universal assignment / association property where a genuine relationship exists.
- `,` is the universal separation / continuation mechanism.
- A complete single-line statement or construct does not require a comma.
- When a related construct continues across multiple lines, commas are used according to its grammar.
- Exactly 0, 1, or 2 spaces may appear before `,`; 3 or more spaces before `,` are lexically invalid.
- Type annotations are optional when the compiler can infer the type unambiguously.
- Horizontal and vertical forms are both valid for bracketed constructs wherever the grammar permits them.
```halka
Valid:   value,    value ,    value  ,
Invalid: value   ,
```


## #35 — C FFI


C interoperability uses an explicit `c` boundary while preserving ordinary HALKA syntax. The FFI layer, not a second language grammar, handles C ABI details.

```halka
import c "stdio.h"
import c "stdio.h",
import c "stdlib.h"
c printf(format: string, ...)
c printf("Hello from HALKA\n")
c struct Point:
    x: c double,
    y: c double
let data: c malloc(100),
defer c free(data)
```


> **LOCKED RULE — #35**


C FFI is explicit through `c` markers for external C declarations, types, and operations. HALKA function syntax remains canonical, C ABI and ownership details are explicit at the boundary, and HALKA safety rules remain in force.


## #36 — C++ FFI


C++ interoperability extends the same FFI model to classes, methods, namespaces, templates, callbacks, and C++ ownership without importing C++ grammar into HALKA.

```halka
import cpp "iostream"
import cpp "iostream",
import cpp "vector"
cpp function_name(value: int)
cpp function_name(25)
cpp class Point:
    x: cpp double,
    y: cpp double
let point: cpp Point(10, 20)
point.move(5, 10)
let values: cpp vector<int>()
cpp register_callback(handler)
```


> **LOCKED RULE — #36**


C++ FFI uses an explicit `cpp` boundary while preserving normal HALKA syntax. C++ classes, methods, namespaces, templates, callbacks, and ownership are handled by the FFI layer; C++ exceptions crossing the boundary are converted into HALKA-safe error handling.


## #37 — Python Interop


Python interoperability uses an explicit `py` boundary. Python grammar does not become part of HALKA.

```halka
import py "numpy"
import py "numpy",
import py "pandas",
import py "requests"
from py "math" import sqrt
from py "math" import sin, cos
let result: py math.sqrt(25)
result: py requests.get(url)
result: py requests.get(
    url: endpoint,
    timeout: 10
)
operation: py math.sqrt,
result: apply 25 : operation
handler(value: int),
    say value
py library.register(handler)
```


> **LOCKED RULE — #37**


Python interop uses `py` markers for external Python modules, functions, and objects. Python values and exceptions are translated at the boundary into HALKA-compatible values and safe error results where appropriate. HALKA function-value rules remain unchanged.


## #38 — Callbacks / ABI Syntax


Callbacks use ordinary HALKA functions plus an explicit `callback` marker when an ABI boundary requires it. ABI metadata is explicit but does not create another function grammar.

```halka
callback handler(value: int),
    say value
register handler
register callback: handler
extern c printf
extern cpp function_name
extern py operation
extern:
    abi: c,
    calling: cdecl,
    name: "printf"
c register_callback(handler)
cpp register_callback(handler)
py register_callback(handler)
```


> **LOCKED RULE — #38**


Callbacks are ordinary HALKA functions marked `callback` when required by an ABI. `extern` declarations make ABI details explicit. `:` expresses genuine associations and `,` separates or continues multi-line ABI sets.


## #39 — Compile-Time Evaluation


Compile-time evaluation uses the normal HALKA grammar plus an explicit `compile` marker.

```halka
const value: compile compute()
const answer: compile factorial(10)
compile factorial(n),
    if n <= 1,
        give 1,
    else,
        give n * factorial(n - 1)
const result: compile factorial(10)
const fields: compile reflect User
```


> **LOCKED RULE — #39**


`compile` marks computation that must happen during compilation. Compile-time failures are compiler diagnostics rather than runtime `Result` values. The normal `:` and `,` rules remain global.


## #40 — Macros


Macros are compile-time source-transformation constructs and use the same declaration shape as functions.

```halka
macro log(value),
    say value
log "Hello HALKA"
macro show(value: string),
    say value
macro log_and_process(value),
    say value,
    process value
```


> **LOCKED RULE — #40**


`macro name(parameters),` defines a macro. Macro expansion happens during compilation. Macros are hygienic by default and generated/expanded code must pass the normal V49 validation pipeline. No separate macro grammar is introduced.


## #41 — Code Generation


`generate` is the explicit compile-time construct for creating new HALKA declarations or supported foreign/native code.

```halka
generate User:
    ...
generate:
    square(x),
        give x * x
generate:
    const version: "1.0",
    User:
        name: string,
        age: int
generate c:
    ...

generate cpp:
    ...
```


> **LOCKED RULE — #41**


`generate` creates code or declarations at compile time. Generated output must pass the appropriate normal validation/compiler pipeline. `macro` is for source transformation; `generate` is for code creation. `:` and `,` keep their global meanings.


## #42 — Reflection


Reflection provides inspection of types, values, fields, methods, and metadata through one normal HALKA mechanism.

```halka
let info: reflect User
let user: User(...)
let info: reflect user
let fields: reflect User,
let methods: reflect User
const fields: compile reflect User
match info.kind,
    Struct,
        say "struct",
    Class,
        say "class",
    else,
        say "other"
```


> **LOCKED RULE — #42**


`reflect` is the general reflection mechanism and can operate at runtime or compile time. It integrates with `match`, `macro`, and `generate` without introducing a separate reflection language.


## #43 — Specialization


Specialization is primarily compiler behavior applied to generic code. The compiler may specialize automatically; explicit control is available only when needed.

```halka
max<T>(a: T, b: T),
    if a > b,
        give a,
    else,
        give b
specialize max<int>
specialize:
    max<int>,
    max<float>
```


> **LOCKED RULE — #43**


Specialization is a compile-time concern. Generic code may be specialized automatically, while explicit specialization uses `specialize` when programmer control is required. Specialized implementations remain governed by the original generic contract.


## #44 — GPU / Device Syntax


GPU/device programming is integrated through explicit execution-domain markers while retaining the normal V49 grammar.

```halka
kernel add(a, b),
    give a + b
result: launch add(a, b)
result: launch add(a, b):
    blocks: 64,
    threads: 256
data: device [1, 2, 3, 4]
device process(data),
    ...
device: gpu(0)
```


> **LOCKED RULE — #44**


GPU/device syntax uses markers such as `kernel`, `device`, and `launch`. Device configuration and memory placement use `:` for association and `,` for multi-line separation/continuation. Runtime/backend semantics determine actual scheduling and device execution.


## #45 — Capability / Security Syntax


Capabilities make security-sensitive permissions explicit and composable.

```halka
capability FileAccess:
    read,
    write
read_config() requires FileAccess,
    ...
deploy() requires FileAccess, NetworkAccess,
    ...
let file_access: acquire FileAccess
read_config(file_access)
with capability FileAccess,
    read file
give FileAccess to worker
revoke FileAccess from worker
load_users() requires Database.read,
    ...
```


> **LOCKED RULE — #45**


Capabilities are explicit security permissions that may be defined, required, acquired, passed, scoped, delegated, or revoked. Ordinary code receives no ambient unrestricted privileges. `:` and `,` preserve their global meanings.


## #46 — Unsafe / Raw-Pointer Syntax


Unsafe syntax is the explicit escape hatch for low-level pointer operations while ordinary HALKA remains protected by the ownership and safety system.

```halka
unsafe:
    value: *ptr
let ptr: raw *int
let value: 25,
let ptr: raw &value
unsafe:
    *ptr: 30
unsafe:
    next: ptr + 1
let ptr: raw *int,
c operation(ptr)
```


> **LOCKED RULE — #46**


Raw pointers are explicitly marked `raw`; dereferencing, pointer arithmetic, and other potentially unsafe operations require an `unsafe` context. Safe references and raw pointers do not implicitly convert into one another. FFI and low-level work may use raw pointers while normal HALKA remains safety-checked.


## #47 — Comments


Comments are purely lexical and do not alter executable structure or semantics.

```halka
# This is a comment
let name: "HALKA"
let age: 25 # user age
###
This is a multi-line comment.
It can span several lines.
###
let name: "HALKA", # continue
let age: 25
```


> **LOCKED RULE — #47**


HALKA V49 uses `#` for single-line comments and `### ... ###` for multi-line comments. Comments cannot replace commas, expressions, indentation, or other required syntax. The global comma lexical rule still applies.


## #48 — Formatting Rules


Formatting is canonical but semantics-preserving. The formatter should understand the parsed structure rather than perform blind text replacement.

```halka
if age >= 18,
    say "adult",
else,
    say "minor"
let numbers: [1, 2, 3, 4]
let numbers: [
    1,
    2,
    3,
    4
]
value,
value ,
value  ,
```


> **LOCKED RULE — #48**


Formatting should standardize indentation, readable operator spacing, structural layout, and comma presentation without changing meaning. Both horizontal and vertical bracketed forms remain valid, while invalid syntax must not be silently `formatted` into something with a different meaning.


## #49 — Whitespace / Newlines


Whitespace is generally insignificant except where it separates tokens, defines indentation, or participates in an explicit lexical rule.

```halka
let name: "HALKA"
let age: 25
value: receive channel
channel: make channel(int),
send channel : 10,
value: receive channel
let numbers: [
    1,
    2,
    3
]
```


> **LOCKED RULE — #49**


A newline normally terminates a statement. The grammar can keep a construct open through explicit comma continuation or enclosing brackets. Indentation defines blocks; bracketed constructs remain naturally layout-independent.


## #50 — Exact Comma-Continuation Rules


This is the formal, language-wide comma rule.

```halka
value: receive channel
let name: "HALKA",
let age: 25,
let active: true
value,
value ,
value  ,
value   ,  # INVALID
```

- `,` means separation / continuation.
- A complete single-line construct does not require a comma.
- A related construct that continues across multiple lines uses commas according to its grammar.
- Inside collections, parameters, blocks, imports, traits, generics, channels, tasks, FFI, compile-time constructs, and other multi-item sets, commas retain the same role.
- Exactly 0–2 spaces may precede `,`. Three or more spaces before `,` are lexically invalid.

> **LOCKED RULE — #50**


`,` is the universal separation/continuation mechanism in HALKA V49. Comma use is structural, not an arbitrary expression operator, and the 0–2-space lexical limit applies everywhere.


## #51 — Operator Precedence


V49 uses a small, fixed precedence hierarchy so expressions are deterministic and readable.

- 1. Grouping: ( ... )
- 2. Calls / member access / indexing: f(...), obj.x, items[i]
- 3. Unary operators: not, -, +, *, and other explicitly unary forms
- 4. Multiplicative: *, /, %
- 5. Additive: +, -
- 6. Comparisons: <, <=, >, >=, ==, !=
- 7. Logical not: not
- 8. Logical and: and
- 9. Logical or: or
- 10. `:` association / assignment
- 11. `,` is structural, not an expression operator.
```halka
let value: (a + b) * c
let total: price + quantity * tax
```


> **LOCKED RULE — #51**


Parentheses override precedence. Calls, member access, and indexing bind tightly. Arithmetic precedes comparisons; comparisons precede logical operations; `:` is low-precedence association/assignment syntax; `,` is not an expression operator.


## #52 — Grammar / Ambiguity Rules


V49 grammar must be explicit and deterministic. The parser must not guess between historical or overlapping grammar generations.

- Every valid program has one canonical parse.
- `:` has a defined association/assignment role.
- `,` has a defined structural separation/continuation role.
- Indentation controls blocks and must not accidentally turn bracketed data into blocks.
- Parentheses, brackets, and braces establish their own grammatical contexts.
- Keywords have fixed grammatical roles.
- Parser-specific edge-case exceptions are not an acceptable design substitute for a coherent grammar.
- If the source is genuinely ambiguous or invalid, the compiler rejects it with a clear diagnostic rather than guessing.
```halka
source
  ↓
lexer
  ↓
deterministic parser
  ↓
one canonical AST
```


> **LOCKED RULE — #52**


The V49 grammar must be deterministic, explicit, and unambiguous. No contextual guessing or accumulated parser exception patches may be used to define ordinary language meaning.


## #53 — Canonical Style Guide


The style guide defines the preferred appearance of V49 code without creating new language semantics.

```halka
let name: "HALKA"
let age: 25
square(x),
    give x * x
if age >= 18,
    say "adult",
else,
    say "minor"
channel: make channel(int),
send channel : 10,
value: receive channel
```

- Prefer the simplest valid form and use type inference where unambiguous.
- Use one canonical function style.
- Use `:` consistently for real assignment/association relationships.
- Use `,` consistently for separation/continuation; do not force it onto complete single-line statements.
- Use indentation for hierarchy.
- Treat horizontal and vertical bracketed layouts as semantically equivalent.
- Avoid redundant equivalent syntax.
- Use readability and parser determinism as final tests for proposed syntax.

> **LOCKED RULE — #53**


HALKA V49 code follows one canonical, readable, homogeneous style across the language. Global `:`, global `,`, type inference, indentation hierarchy, and layout-independent bracketed constructs form the final style foundation.


## #54 — Indexing, Slicing & Ranges


The missing roadmap item is added as Rule #54 and completes the currently defined core syntax sequence.

```halka
let numbers: [10, 20, 30, 40],
let first: numbers[0],
let last: numbers[-1]
numbers[0]: 100
let part: numbers[1:3]
let first_three: numbers[:3]
let last_three: numbers[1:]
let copy: numbers[:]
let every_second: numbers[0:10:2]
let reversed: numbers[::-1]
let values: 1..10
for i in 1..10,
    say i
let values: 1..=10
range 1..10 step 2
let users: [
    "alice": 20,
    "bob": 25
],
let age: users["alice"],
users["alice"]: 21
```

- Indexing uses `[index]`.
- Negative indices count from the end.
- Slicing uses `[start:end:step]`; omitted bounds are permitted.
- `..` is an exclusive-upper-bound range; `..=` is inclusive.
- `range ... step ...` expresses a stepped range.
- The same indexing grammar works for lists, arrays, tuples where supported, strings where supported, and maps using keys.
- Indexed/map assignment uses `:`.
- Horizontal and vertical bracketed forms remain equivalent.

> **LOCKED RULE — #54**


Indexing, slicing, and ranges use a single predictable family of operators: `[index]`, `[start:end:step]`, `..`, and `..=`. `:` remains assignment/association, and `,` remains separation/continuation under the global comma rule.


## Status


Rules #35–#54: LOCKED


This document records the final syntax decisions made for this section. Later implementation work should treat these rules as the specification baseline unless an explicit future design revision supersedes them.
