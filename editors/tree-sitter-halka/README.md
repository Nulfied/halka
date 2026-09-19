# tree-sitter-halka

Tree-sitter grammar for [Halka](https://github.com/halka-lang/halka), used by
Neovim, Helix and Zed for highlighting, folding, indentation and text objects.

`src/scanner.c` is the external scanner. It mirrors the reference lexer's layout
handling: a newline terminates a statement (#49), indentation opens and closes
blocks (R12), layout is suppressed inside brackets, and blank or comment-only
lines produce no layout tokens (#47).

## Status

The grammar **generates cleanly** (`tree-sitter generate`, no conflicts, no
warnings). The corpus tests in `test/corpus/` need a C compiler to build the
parser, so they run in CI rather than being verified on every developer machine.

This grammar exists for editors. The normative parser is
`compiler/src/parser/parser.ts`; when the two disagree, the reference parser is
right and this grammar has a bug worth reporting.

## Building

```bash
npm install
npx tree-sitter generate     # regenerate src/parser.c from grammar.js
npx tree-sitter build        # needs a C compiler
npx tree-sitter test         # run test/corpus
npx tree-sitter parse ../../examples/tour.hk
```

## Queries

| File | Purpose |
|---|---|
| `queries/highlights.scm` | syntax highlighting |
| `queries/locals.scm` | scopes, definitions and references |
| `queries/indents.scm` | indentation |
| `queries/folds.scm` | code folding |
| `queries/injections.scm` | embedded languages (none in V49) |

Editor setup lives in the sibling directories: [`../nvim`](../nvim),
[`../helix`](../helix), [`../zed`](../zed).
