// Halka VS Code extension.
//
// Syntax highlighting comes from the TextMate grammar and needs nothing here.
// This module wires up the language server (`halka lsp`) and the run command.

const { workspace, window, commands, Uri } = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { existsSync } = require("node:fs");
const path = require("node:path");

/** @type {import("vscode-languageclient/node").LanguageClient | undefined} */
let client;

/** Locate the `halka` launcher: the configured path, a repo checkout, or $PATH. */
function resolveServer(context) {
  const configured = workspace.getConfiguration("halka").get("path");
  if (configured && configured !== "halka" && existsSync(configured)) {
    return { command: process.execPath, args: [configured, "lsp"] };
  }
  // Running from a checkout of the Halka repo (editors/vscode -> compiler/bin).
  const local = path.join(context.extensionPath, "..", "..", "compiler", "bin", "halka.mjs");
  if (existsSync(local)) {
    return { command: process.execPath, args: [local, "lsp"] };
  }
  // Fall back to whatever `halka` is on PATH.
  return { command: process.platform === "win32" ? "halka.cmd" : "halka", args: ["lsp"] };
}

function activate(context) {
  const config = workspace.getConfiguration("halka");

  if (config.get("enableLanguageServer")) {
    const { command, args } = resolveServer(context);
    /** @type {import("vscode-languageclient/node").ServerOptions} */
    const serverOptions = {
      run: { command, args, transport: TransportKind.stdio },
      debug: { command, args, transport: TransportKind.stdio },
    };
    /** @type {import("vscode-languageclient/node").LanguageClientOptions} */
    const clientOptions = {
      documentSelector: [{ scheme: "file", language: "halka" }],
      synchronize: { fileEvents: workspace.createFileSystemWatcher("**/*.hk") },
      outputChannelName: "Halka Language Server",
    };
    client = new LanguageClient("halka", "Halka Language Server", serverOptions, clientOptions);
    client.start().catch((err) => {
      window.showWarningMessage(
        `Halka: could not start the language server (${err.message}). ` +
        "Syntax highlighting still works. Set `halka.path` to your halka executable.",
      );
    });
    context.subscriptions.push({ dispose: () => client?.stop() });
  }

  context.subscriptions.push(
    commands.registerCommand("halka.run", async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== "halka") {
        window.showInformationMessage("Halka: open a .hk file first.");
        return;
      }
      await editor.document.save();
      const { command, args } = resolveServer(context);
      const terminal =
        window.terminals.find((t) => t.name === "Halka") ?? window.createTerminal("Halka");
      const runArgs = [...args.slice(0, -1), "run", editor.document.fileName];
      terminal.show(true);
      terminal.sendText(`${quote(command)} ${runArgs.map(quote).join(" ")}`);
    }),

    commands.registerCommand("halka.restartServer", async () => {
      if (!client) return;
      await client.restart();
      window.showInformationMessage("Halka: language server restarted.");
    }),
  );
}

function quote(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
