# Halka packages

How a Halka project declares what it depends on, how those dependencies are
resolved to exact versions, and how they are fetched and verified.

This document is the contract. `compiler/src/pkg/` implements it, and
`compiler/test/run.ts` asserts the parts that can be asserted offline.

---

## P1 — The manifest is `halka.pkg`, and it reads like Halka

A project is a directory containing `halka.pkg`. The file uses the same two
punctuation rules the language does (V49 #1 and #2): `:` associates a key with
a value, `,` separates entries, and indentation opens a block.

```
package:
    name: hello,
    version: 0.1.0,
    license: MIT,
    description: A greeting

deps:
    json: 1.2.0,
    http: 0.4.1

dev-deps:
    bench-kit: 0.2.0
```

This is deliberately *not* TOML, YAML or JSON. Two reasons, and neither is
aesthetics alone:

1. **One set of punctuation rules to learn.** Someone who can read Halka can
   read the manifest without being told anything new. A language whose config
   format contradicts its own syntax teaches two things where one would do.
2. **No dependency to parse it.** The toolchain has zero runtime dependencies
   and intends to keep them. A YAML parser is a large amount of someone
   else's code sitting in the trust path of every build.

The manifest is data, not a program. It has no expressions, no conditionals
and no includes — a manifest cannot execute anything, at install time or ever.
That is a security property, not a limitation: `halka add` must never be able
to run code from a package it has not built yet.

### Grammar

```
manifest  := section*
section   := NAME ":" NEWLINE INDENT entry ("," NEWLINE entry)* DEDENT
entry     := KEY ":" VALUE
```

Keys are `[a-z][a-z0-9-]*`. Values run to the end of the line (minus a
trailing comma) and are taken literally, with surrounding quotes stripped if
present. Lines whose first non-space character is `#` are comments. The
recognised sections are `package`, `deps` and `dev-deps`; an unknown section
is an error rather than a silent no-op, because a typo'd section name that is
ignored is how a dependency quietly fails to be installed.

### Reserved names

A dependency may not be called `math`, `strings`, `lists`, `maps`, `io`,
`time`, `os` or `json`. Those are the prelude's modules, and `import json`
already means the built-in one.

This is a hard error rather than a precedence rule, because the alternative
is worse than a restriction. If a package could take the name, `import json`
would mean the built-in module on a machine where that package was not
installed and the package on one where it was — the same source doing two
different things depending on the state of a cache.

For the same reason, a dependency the lockfile names but the cache does not
hold is an error telling you to run `halka install`, not a fallback to
whatever else the module search path can reach.

---

## P2 — Versions are semver, and ranges are caret-only

A version is `MAJOR.MINOR.PATCH`, optionally `-prerelease` and `+build`.
Ordering follows semver 2.0.0: numeric identifiers compare numerically,
a prerelease sorts *before* its release, and build metadata is ignored in
comparisons.

A dependency requirement is written one of two ways:

| requirement | means |
|---|---|
| `1.2.0` | at least `1.2.0`, and below the next incompatible version |
| `=1.2.0` | exactly `1.2.0` |

"The next incompatible version" is the usual caret rule, including its
behaviour below 1.0: `1.2.0` admits `<2.0.0`, `0.4.1` admits `<0.5.0`, and
`0.0.3` admits only `0.0.3`.

There is deliberately no `>=`, `<`, `~`, `*`, `||` or whitespace-joined range
syntax. Every one of those exists to let a package author express a
constraint that, in practice, is guesswork about software that does not exist
yet. The bare form is the common case and the `=` form is the escape hatch;
anything more expressive mostly buys unsolvable resolution.

---

## P3 — Resolution is Minimal Version Selection

Given the root manifest and the manifests of everything it reaches, the
selected version of a package is **the highest version any single requirement
in the graph asks for** — not the highest version that exists.

This is Go's algorithm, and it is chosen over Cargo's and npm's SAT-style
solvers on purpose:

- **It is deterministic without a lockfile.** The same inputs give the same
  answer on every machine, on every day. A lockfile then records what was
  chosen so a *changed* registry cannot silently change a build, rather than
  being the only thing standing between you and a different build.
- **It cannot backtrack, so it cannot hang.** Resolution is a graph walk. It
  is linear in the size of the graph, and there is no pathological input.
- **Upgrades are explicit.** Adding a dependency never silently upgrades an
  unrelated one. `halka add` and `halka update` change versions; building
  does not.

The cost is real and worth stating: MVS can select a version older than the
newest compatible one, so you do not get new patch releases for free. That is
the intended trade. Getting a different build than you got yesterday, without
having asked for one, is the failure mode this avoids.

If two requirements for the same package are in different incompatible ranges
— `1.x` and `2.x` — that is an error naming both requirers. Halka does not
silently link two major versions of the same package into one binary.

---

## P4 — The lockfile records exactly what was used

`halka.lock` is written by any command that resolves, and lists every selected
package with its exact version and the SHA-256 of the archive it came from:

```
lock:
    version: 1

json:
    version: 1.2.0,
    source: registry,
    sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

http:
    version: 0.4.1,
    source: registry,
    sha256: 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae
```

A build with a lockfile verifies every archive against the recorded hash and
fails if it differs. This is what makes a compromised or edited registry a
build failure instead of a supply-chain compromise. Hashing is SHA-256 from
`node:crypto` — the toolchain does not implement its own cryptography
anywhere, and will not.

The lockfile is committed. It is the answer to "it works on my machine".

---

## P5 — The registry is a static index

The default registry is a static file tree, served by GitHub Pages at no cost:

```
<registry>/index/<name>.json      the versions of one package
<registry>/pkg/<name>/<ver>.tar.gz  the archive
```

The index for a package lists each published version with the archive's
SHA-256 and its dependency requirements, so resolution can complete without
downloading anything:

```json
{
  "name": "json",
  "versions": [
    { "version": "1.2.0",
      "sha256": "9f86d0...",
      "deps": { "bytes": "0.3.0" } }
  ]
}
```

Nothing is executed on the registry's behalf. There is no install script, no
build script and no post-install hook, because a package manager that runs
arbitrary code on `add` is the single most reliably exploited part of every
ecosystem that has one. A Halka package is source code that gets compiled;
if it needs to run something at build time it does so through the same
`halka build` everyone else's code goes through.

A dependency may also name a path, for local development:

```
deps:
    mylib: path ../mylib
```

A path dependency is never fetched, never hashed and never published; a
package with one cannot be uploaded to the registry.

---

## P6 — Where packages land

Fetched archives are extracted into a per-user cache, not into the project:

```
~/.halka/cache/pkg/<name>/<version>/
```

The project directory stays clean and two projects sharing a dependency share
one copy. Module resolution (#33) searches the versions selected for *this*
project, so two projects on different versions do not interfere.

An extracted archive is treated as untrusted input: entry paths are rejected
if they are absolute, contain `..`, or are symbolic links. An archive cannot
write outside its own directory.

---

## Status

Implemented: P1 manifest, P2 versions and ranges, P3 resolution, P4 lockfile,
P6 cache layout and archive safety. P5's fetch path works against any static
registry; no public registry is published yet, so today's useful
configurations are path dependencies and a self-hosted index.
