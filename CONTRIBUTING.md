# Contributing to Halka

Thanks for being here. Halka is young and almost everything is open.

## The one hard rule

**The V49 syntax is locked.** The 54 rules in [`spec/V49-LOCKED.md`](spec/V49-LOCKED.md)
are the source of truth, transcribed from the authored documents archived in
`spec/source/`. CI fails if they drift.

Changing locked syntax requires a **HEP** (Halka Enhancement Proposal): a file
in `spec/heps/` that states the rule being changed, the motivation, every
program the change would break, and the migration path. A HEP also bumps the
version past V49.

Everything else — the type checker, backends, the standard library, editor
support, docs, examples, error messages — needs no ceremony. Open a PR.

## Where the spec is silent

Rule #52 requires that every valid program has exactly one parse. Where the
locked rules leave a genuine ambiguity, the answer goes in
[`spec/RESOLUTIONS.md`](spec/RESOLUTIONS.md) as a numbered R-rule.

A resolution may only **narrow** a locked rule. If a resolution contradicts a
locked rule, the locked rule wins and the resolution is a bug. Every resolution
needs a test.

## Getting set up

You need Node 22.6 or newer. Nothing else.

```bash
git clone https://github.com/halka-lang/halka.git
cd halka/compiler
node bin/halka.mjs run ../examples/hello.hk
node --experimental-strip-types test/run.ts
```

For the optional type check of the toolchain itself:

```bash
npm install
npx tsc -p tsconfig.json --noEmit
```

## The test suites

`test/run.ts` runs four suites. A PR must keep all of them green.

| Suite | What it guarantees |
|---|---|
| `spec` | Every executable code block in the locked spec still parses |
| `reject` | Invalid programs produce the documented diagnostic code |
| `run` | `test/cases/*.hk` prints exactly `test/cases/*.out` |
| `fmt` | Formatting is idempotent and never changes what a program prints |

Adding a language feature means adding to `run`. Adding a diagnostic means
adding to `reject`.

## Error messages

Halka's diagnostics are part of the product. A good one:

- names what is wrong in one line, without jargon,
- points at the exact span,
- cites the locked rule when one applies (`rule: "#23 — Exception model"`),
- and offers the alternative (`help: ...`).

If you add an error, give it a code from the range table at the bottom of
`spec/RESOLUTIONS.md`, and write the `help` line for someone who has never read
the spec.

## Style

The toolchain is written in erasable TypeScript so Node runs it without a build
step. That means: no `enum`, no `namespace`, no parameter properties, no
decorators. Use `const` objects and explicit field assignment instead.

Halka source in the repo must be formatted:

```bash
node bin/halka.mjs fmt --write ../examples ../stdlib test/cases
```

## Good first issues

- A runnable example for a locked rule that does not have one yet.
- A standard-library function in `stdlib/`, written in Halka.
- An editor integration, or Tree-sitter highlight queries.
- An adversarial test: find a program with two parses, or one the checker
  wrongly accepts or wrongly rejects. Rule #52 says that is a bug worth fixing.

## Code of conduct

Be decent to people. Disagree about the work, not the person. Maintainers will
remove anyone who makes this a worse place to contribute.
