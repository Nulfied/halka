# Halka for Neovim

Two pieces: the language server (diagnostics, hover, completion, formatting)
and the Tree-sitter grammar (highlighting, indentation, text objects).

## Language server

`halka lsp` speaks LSP over stdio, so `nvim-lspconfig` needs only a definition:

```lua
-- lua/halka.lua
vim.filetype.add({ extension = { hk = "halka" } })

local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

if not configs.halka then
  configs.halka = {
    default_config = {
      cmd = { "halka", "lsp" },
      filetypes = { "halka" },
      root_dir = lspconfig.util.root_pattern("package.hk", ".git"),
      settings = {},
    },
    docs = { description = "The Halka language server" },
  }
end

lspconfig.halka.setup({
  on_attach = function(_, bufnr)
    local opts = { buffer = bufnr }
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)
    vim.keymap.set("n", "<leader>f", function() vim.lsp.buf.format({ async = true }) end, opts)
  end,
})
```

If `halka` is not on your `PATH`, use the launcher directly:

```lua
cmd = { "node", "/path/to/halka/compiler/bin/halka.mjs", "lsp" },
```

## Format on save

```lua
vim.api.nvim_create_autocmd("BufWritePre", {
  pattern = "*.hk",
  callback = function() vim.lsp.buf.format({ async = false }) end,
})
```

## Tree-sitter

The grammar lives in [`../tree-sitter-halka`](../tree-sitter-halka).

```lua
local parsers = require("nvim-treesitter.parsers").get_parser_configs()
parsers.halka = {
  install_info = {
    url = "https://github.com/Nulfied/halka",
    location = "editors/tree-sitter-halka",
    files = { "src/parser.c" },
    branch = "main",
  },
  filetype = "halka",
}
```

Then `:TSInstall halka`. Copy `editors/tree-sitter-halka/queries/*.scm` into
`~/.config/nvim/queries/halka/`.

## Indentation without Tree-sitter

```vim
" ftplugin/halka.vim
setlocal expandtab shiftwidth=4 tabstop=4 softtabstop=4
setlocal commentstring=#\ %s
setlocal comments=b:#
setlocal indentkeys+=0=else,0=else\ if
```
