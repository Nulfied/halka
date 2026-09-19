# Halka for Sublime Text

## Syntax highlighting

Sublime reads TextMate grammars directly. Copy the grammar into your packages
directory as `Halka.tmLanguage.json`:

```bash
# macOS
cp ../vscode/syntaxes/halka.tmLanguage.json \
   ~/Library/Application\ Support/Sublime\ Text/Packages/User/Halka.tmLanguage.json

# Linux
cp ../vscode/syntaxes/halka.tmLanguage.json \
   ~/.config/sublime-text/Packages/User/Halka.tmLanguage.json

# Windows
copy ..\vscode\syntaxes\halka.tmLanguage.json ^
   "%APPDATA%\Sublime Text\Packages\User\Halka.tmLanguage.json"
```

## Language server

Install the **LSP** package, then add to `Preferences: LSP Settings`:

```json
{
  "clients": {
    "halka": {
      "enabled": true,
      "command": ["halka", "lsp"],
      "selector": "source.halka",
      "schemes": ["file"]
    }
  }
}
```

## Build system

Save as `Packages/User/Halka.sublime-build`:

```json
{
  "shell_cmd": "halka run \"$file\"",
  "file_regex": "^\s*--> ([^:]+):(\d+):(\d+)",
  "selector": "source.halka",
  "variants": [
    { "name": "Check", "shell_cmd": "halka check \"$file\"" },
    { "name": "Format", "shell_cmd": "halka fmt --write \"$file\"" }
  ]
}
```
