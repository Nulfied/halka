# Halka for Helix

Add to `~/.config/helix/languages.toml`:

```toml
[language-server.halka]
command = "halka"
args = ["lsp"]

[[language]]
name = "halka"
scope = "source.halka"
injection-regex = "halka"
file-types = ["hk"]
comment-token = "#"
block-comment-tokens = { start = "###", end = "###" }
indent = { tab-width = 4, unit = "    " }
language-servers = ["halka"]
auto-format = true
roots = ["package.hk", ".git"]

[[grammar]]
name = "halka"
source = { git = "https://github.com/Nulfied/halka", subpath = "editors/tree-sitter-halka", rev = "main" }
```

Then:

```bash
hx --grammar fetch
hx --grammar build
```

Copy the highlight queries so Helix can find them:

```bash
mkdir -p ~/.config/helix/runtime/queries/halka
cp editors/tree-sitter-halka/queries/*.scm ~/.config/helix/runtime/queries/halka/
```
