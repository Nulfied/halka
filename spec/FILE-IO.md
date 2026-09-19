# File I/O

How a Halka program reads and writes files.

This document is the contract. `compiler/src/runtime/prelude.ts` implements it
for the interpreter, and `compiler/test/cases/files.hk` asserts it.

---

## F1 — Every file operation needs the `FileAccess` capability

Rule #45 is explicit: *"Ordinary code receives no ambient unrestricted
privileges."* It names this exact case in its own example:

```halka
capability FileAccess:
    read,
    write
read_config() requires FileAccess,
    ...
```

So file access is capability-gated, and that is a locked-rule requirement
rather than a library choice. `FileAccess` is built in, with two permissions:

| permission | covers |
|---|---|
| `FileAccess.read` | `read`, `read_bytes`, `lines`, `exists`, `size`, `is_dir`, `list_dir` |
| `FileAccess.write` | `write`, `append`, `remove`, `make_dir` |

Holding `FileAccess` grants both. A program obtains it the way #45 says —
`with capability`, a `requires` clause, `acquire`, or the `HALKA_GRANTS`
environment variable at the top level:

```halka
import files

with capability FileAccess,
    let text: files.read("notes.txt")
```

Calling a file operation without the capability is an `E0505` error naming
the permission that was missing. This is checked at the point of the call,
against the capability set in force there.

## F2 — Failure is a `Result`, never an exception

Halka has no exceptions (#23) and one recoverable-failure type (#22), so
every operation that can fail returns `Result<T>`:

```halka
let text: files.read("notes.txt")
if text is Error,
    say "could not read it: {text.message}"
else,
    say "{len(text.value)} bytes"
```

The `Error` message is the operating system's, prefixed with the operation
and the path, so a failure says what was attempted and to what.

Two operations deliberately return a plain `bool` rather than a `Result`,
because "no" is an answer and not a failure: `exists` and `is_dir`. A path
that cannot be examined at all reads as `false`.

## F3 — The surface

```
files.read(path: string): Result<string>
files.read_bytes(path: string): Result<list(int)>
files.lines(path: string): Result<list(string)>
files.write(path: string, contents: string): Result<nothing>
files.append(path: string, contents: string): Result<nothing>
files.remove(path: string): Result<nothing>
files.size(path: string): Result<int>
files.exists(path: string): bool
files.is_dir(path: string): bool
files.list_dir(path: string): Result<list(string)>
files.make_dir(path: string): Result<nothing>
```

`write` creates the file or truncates it; `append` creates it or adds to the
end. `make_dir` creates parent directories as needed and succeeds if the
directory already exists, because the alternative is that every caller
writes the same "does it exist yet" dance.

`remove` deletes one file, or one **empty** directory. It never recurses: an
accidental `files.remove("src")` has to fail rather than delete a tree, and a
caller that genuinely wants a recursive delete should have to write the walk
and see what it is doing.

`list_dir` gives names, not paths — joining them is the caller's business and
it is the only answer that does not depend on how the directory was named.

## F4 — Text is UTF-8, and that is not negotiable

`read`, `lines`, `write` and `append` are UTF-8. A file that is not valid
UTF-8 is an `Error` from `read`, not a string full of replacement
characters: silently substituting U+FFFD turns a data problem into a
correctness problem further downstream.

`read_bytes` is the escape hatch, and is the right operation for anything
that is not text. It gives a list of `int`, each 0–255, because that is what
the runtime actually holds — there is no distinct byte value at run time,
only the `byte` type at compile time.

`lines` splits on `\n` and drops a single trailing `\r` from each line, so a
file written on Windows reads the same as one written anywhere else. A
trailing newline at the end of the file does not produce a final empty
line.

## F5 — Paths are passed through

A path is a string, handed to the operating system as given. Halka does not
normalise it, resolve symlinks, or interpret `~`. Relative paths resolve
against the process's working directory.

There is deliberately no sandbox or path allow-list here. The capability in
F1 governs *whether* a program touches the filesystem; confining it to a
subtree is a policy the host imposes, and pretending a library-level check
is a security boundary would be worse than not offering one.

## Status

Implemented for the interpreter. The native backend cannot compile these
yet, because it cannot represent `Result<T>` — enums are not in the C
backend. `halka build` reports `E0701` naming the type rather than
mis-compiling, which is R23's contract. The API will not change when the
backend catches up; only what `halka build` accepts will.
