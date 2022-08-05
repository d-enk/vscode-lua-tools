'use strict';
const vscode_languageserver = require("vscode-languageserver");
const vscode_uri = require("vscode-uri");
const ch = require('child_process');

const fs = require('fs');

let connection = vscode_languageserver.createConnection(
  new vscode_languageserver.IPCMessageReader(process),
  new vscode_languageserver.IPCMessageWriter(process)
);
let documents = new vscode_languageserver.TextDocuments();

let workspaceRoot;
let useLuacheck = false
let heckStyluaFormatting = false
let filesWithCoverage = []

connection.onInitialize((params) => {
  workspaceRoot = params.rootPath;
  return {
    capabilities: {

      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: documents.syncKind
    }
  };
});

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((params) => {
  heckStyluaFormatting = false
  useLuacheck = false
  filesWithCoverage = []

  const conf = params.settings["lua-tools"]
  if (conf) {
    if (conf.useLuacheck)
      useLuacheck = true

    if (conf.heckStyluaFormatting)
      heckStyluaFormatting = true

    if (typeof conf.filesWithCoverage === 'string')
      filesWithCoverage = conf.filesWithCoverage.split(",").map(file => workspaceRoot + "/" + file)

    if (conf.fullScanOnInit)
  getLuaFiles(workspaceRoot).forEach(file => sendDiagnostics(file.path, parse_coverage()))
  }
});
connection.onDidChangeWatchedFiles(() => {
  documents.all().forEach(validateTextDocument);
});
connection.onDidCloseTextDocument(() => {
  documents.all().forEach(validateTextDocument);
});
connection.onDidSaveTextDocument(() => {
  documents.all().forEach(validateTextDocument);
});

documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});
documents.onDidSave((e) => {
  validateTextDocument(e.document);
});

documents.onDidOpen((e) => {
  validateTextDocument(e.document);
});
documents.onDidClose((e) => {
  validateTextDocument(e.document);
});

documents.listen(connection);
connection.listen();

function validateTextDocument(textDocument) {
  sendDiagnostics(textDocument.uri)
}

async function sendDiagnostics(documentUri, map_with_coverage) {
  let diagnostics = [];
  if (useLuacheck) {
    diagnostics = luacheck(documentUri, diagnostics);
  }

  if (heckStyluaFormatting) {
    diagnostics = check_stylua(documentUri, diagnostics);
  }

  diagnostics = coverage(documentUri, diagnostics, map_with_coverage);

  connection.sendDiagnostics({ uri: documentUri, diagnostics: diagnostics });
}

function parse_coverage() {
  let map = new Map();

  filesWithCoverage.forEach(luaCovStatsPath => {
    if (fs.existsSync(luaCovStatsPath)) {
      const file = fs.readFileSync(luaCovStatsPath)
      const items = file.toString().split('\n')

      for (let i = 0; i < items.length; i += 2) {
        const file_name = items[i].slice(items[i].indexOf(':') + 1)
        map.set(file_name, items[i + 1])
      }
    }
  })

  return map
}

function coverage(documentUri, diagnostics, map = parse_coverage()) {
  const path = vscode_uri.default.parse(documentUri).fsPath
  if (map.has(path)) {
    const lines = map.get(path).trim().split(" ")

    for (let l = 0; l < lines.length; l++) {
      if (lines[l] != '0')
        diagnostics.push({
          severity: 4,
          range: {
            start: { line: l },
            end: { line: l }
          },
          source: "coverage",
          message: lines[l],
        })
    }
  }

  return diagnostics;
}

let sendStyLuaWarn = true;

function check_stylua(documentUri, diagnostics) {
  const stylua = ch.spawnSync("stylua", ['-c', '--color=Never', vscode_uri.default.parse(documentUri).fsPath])

  switch (stylua.status) {
    case null:
      if (sendStyLuaWarn) {
        connection.window.showWarningMessage(`github.com/JohnnyMorganz/StyLua not installed. \n
          Install it or disable this extension option.`)
        sendStyLuaWarn = false
      }
      break
    case 1:
      diagnostics.push({
        severity: 2,
        range: { start: { line: 0 }, end: { line: 0 } },
        source: "stylua",
        message: "file not formatted",
      })
  }

  return diagnostics;
}

let sendLuaCheckWarn = true

function luacheck(documentUri, diagnostics) {
  const cp = ch.spawnSync('luacheck', [
    vscode_uri.default.parse(documentUri).fsPath, '--no-color', '--ranges', '--codes',
  ], {});

  switch (cp.status) {
    case null:
      if (sendLuaCheckWarn) {
        connection.window.showWarningMessage(`luacheck not installed. \n
          Install it or disable this extension option.`)
        sendLuaCheckWarn = false
      }
      break
    default:
      parseDiagnostics(cp.output.toString(), diagnostics);
  }
  return diagnostics;
}

const errorRegex = /^.*:(\d+):(\d+)-(\d+): \(([EW]?)(\d+)\) (.*)$/mg;

function parseDiagnostics(data, diagnostics) {
  const matches = data.matchAll(errorRegex)
  for (const m of matches) {
    const [, lineStr, columnStr, endColumnStr, type, codeStr, message] = m;

    const line = Number(lineStr) - 1;
    const column = Number(columnStr) - 1;
    const columnEnd = Number(endColumnStr);
    const code = Number(codeStr);

    let severity = 3 // info
    switch (type) {
      case 'E':
        severity = 1; // error
      case 'W':
        severity = 2; // warn
    }

    diagnostics.push({
      severity: severity,
      range: {
        start: { line: line, character: column },
        end: { line: line, character: columnEnd }
      },
      source: "luacheck " + code,
      message: message
    });
  }
  return diagnostics;
}

function getLuaFiles(path = "./") {
  const entries = fs.readdirSync(path + '/', { withFileTypes: true });

  const files = entries
    .filter(file => !file.isDirectory())
    .filter(file => file.name.endsWith(".lua"))
    .map(file => ({ ...file, path: `${path}/${file.name}` }));

  entries.filter(folder => folder.isDirectory())
    // .filter(folder => !folder.name.startsWith("."))
    .forEach(folder => files.push(...getLuaFiles(`${path}/${folder.name}`)))

  return files;
}