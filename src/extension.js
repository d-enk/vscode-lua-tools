"use strict";

const vscode = require("vscode");
const vscode_languageclient = require("vscode-languageclient");
function activate(context) {
  let serverModule = context.asAbsolutePath("src/lua_language_server.js");
  let debugOptions = {};
  let serverOptions = {
    run: {
      module: serverModule,
      transport: vscode_languageclient.TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: vscode_languageclient.TransportKind.ipc,
      options: debugOptions,
    },
  };

  let fileEvents = [
    vscode.workspace.createFileSystemWatcher("**/.luacheckrc"),
  ];

  vscode.workspace
    .getConfiguration("lua-tools")
    .get("filesWithCoverage", "")
    .split(",")
    .forEach((file) => {
      fileEvents.push(
        vscode.workspace.createFileSystemWatcher("**/" + file)
      );
    });

  let clientOptions = {
    documentSelector: ["lua"],
    synchronize: {
      configurationSection: "lua-tools",
      fileEvents: fileEvents,
    },
  };
  let disposable = new vscode_languageclient.LanguageClient(
    "lua-tools",
    "lua-tools",
    serverOptions,
    clientOptions
  ).start();
  context.subscriptions.push(disposable);
}
exports.activate = activate;

function deactivate() { }
exports.deactivate = deactivate;
