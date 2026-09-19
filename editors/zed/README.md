# Halka for Zed

Zed extensions are Tree-sitter plus a language-server declaration.

Create `extension.toml`:

```toml
id = "halka"
name = "Halka"
description = "Halka language support"
version = "0.1.0"
schema_version = 1
authors = ["The Halka Project"]
repository = "https://github.com/Nulfied/halka"

[language_servers.halka]
name = "Halka Language Server"
languages = ["Halka"]

[grammars.halka]
repository = "https://github.com/Nulfied/halka"
commit = "main"
path = "editors/tree-sitter-halka"
```

And `languages/halka/config.toml`:

```toml
name = "Halka"
grammar = "halka"
path_suffixes = ["hk"]
line_comments = ["# "]
block_comment = ["### ", " ###"]
tab_size = 4
hard_tabs = false
autoclose_before = ",)]}"

[[brackets]]
start = "("
end = ")"
close = true
newline = false

[[brackets]]
start = "["
end = "]"
close = true
newline = true

[[brackets]]
start = "\""
end = "\""
close = true
newline = false
```

Copy the highlight queries from `editors/tree-sitter-halka/queries/` into
`languages/halka/`.

Until the extension is published, add it through **zed: install dev extension**
and point Zed at this directory.
