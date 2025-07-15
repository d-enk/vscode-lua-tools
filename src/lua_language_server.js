"use strict";

const vscode_languageserver = require("vscode-languageserver");
const ch = require("child_process");
const uri = require("vscode-uri").default;
const fs = require("fs");

const luacheckRegex = /^    (.*):(\d+):(\d+)-(\d+): \(([EW]?)(\d+)\) (.*)$/gm;
const styluaRegex = /Diff in (.*):$/gm;

let connection = vscode_languageserver.createConnection(
  new vscode_languageserver.IPCMessageReader(process),
  new vscode_languageserver.IPCMessageWriter(process),
);
let documents = new vscode_languageserver.TextDocuments();

let workspaceRoot;

let useLuacheck = false;
let checkStyluaFormatting = false;
let luacheckPath = "luacheck";
let styluaPath = "stylua";
let filesWithCoverage = [];

let coverage = new Map();

connection.onInitialize((params) => {
  workspaceRoot = params.rootPath;
  return {
    capabilities: {
      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: documents.syncKind,
    },
  };
});

let initialCheckState = false;

function initialCheck() {
  if (initialCheckState) return;
  initialCheckState = true;

  let file2diagnostics = new Map();

  function diagnosticsByFile(file) {
    if (!file2diagnostics.has(file)) file2diagnostics.set(file, []);

    return file2diagnostics.get(file);
  }

  for (const m of luacheck(workspaceRoot))
    pushDiagnostic(diagnosticsByFile(m[1]), ...m.slice(2));

  const p = stylua(workspaceRoot);
  if (p.status === 1 && p.output)
    for (const m of p.output.toString().matchAll(styluaRegex))
      pushStyluaDiagnostic(diagnosticsByFile(m[1]));

  file2diagnostics.forEach((diagnostics, file) =>
    connection.sendDiagnostics({
      uri: file,
      diagnostics: diagnostics,
    }),
  );
}

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((params) => {
  checkStyluaFormatting = false;
  useLuacheck = false;
  luacheckPath = "luacheck";
  styluaPath = "stylua";
  filesWithCoverage = [];

  const conf = params.settings["lua-tools"];

  if (conf) {
    useLuacheck = conf.useLuacheck;
    checkStyluaFormatting = conf.checkStyluaFormatting;
    luacheckPath = conf.luacheckPath;
    styluaPath = conf.styluaPath;

    if (typeof conf.filesWithCoverage === "string")
      filesWithCoverage = conf.filesWithCoverage
        .split(",")
        .map((file) => "./" + file);

    if (conf.fullScanOnInit) initialCheck();
  }
});

documents.onDidChangeContent((e) => {
  sendDocumnetDiagnostics(e.document.uri);
});

documents.onDidOpen((e) => {
  parseCoverage();
  sendDocumnetDiagnostics(e.document.uri);
});

documents.onDidSave((e) => {
  parseCoverage();
  sendDocumnetDiagnostics(e.document.uri);
});

// watch coverage changes
connection.onDidChangeWatchedFiles((c) => {
  parseCoverage();
  documents.all().forEach((document) => sendDocumnetDiagnostics(document.uri));
});

documents.listen(connection);
connection.listen();

async function sendDocumnetDiagnostics(documentUri) {
  const path = uri.parse(documentUri).path;

  let diagnostics = [];

  luacheck(path).forEach((m) => pushDiagnostic(diagnostics, ...m.slice(2)));

  if (stylua(path).status === 1) pushStyluaDiagnostic(diagnostics);

  diagnostics = pushCoverage(path, diagnostics);

  connection.sendDiagnostics({ uri: documentUri, diagnostics: diagnostics });
}

function parseCoverage() {
  coverage.clear();

  filesWithCoverage.forEach((luaCovStatsPath) => {
    if (fs.existsSync(luaCovStatsPath)) {
      const file = fs.readFileSync(luaCovStatsPath);
      const items = file.toString().split("\n");

      for (let i = 0; i < items.length; i += 2) {
        const file_name = items[i].slice(items[i].indexOf(":") + 1);
        coverage.set(file_name, items[i + 1]);
      }
    }
  });
}

function pushCoverage(path, diagnostics) {
  const relative = path.substring(workspaceRoot.length + 1);

  for (let p of ["./" + relative, relative, path]) {
    if (coverage.has(p)) {
      const lines = coverage.get(p).trim().split(" ");

      for (let l = 0; l < lines.length; l++) {
        if (lines[l] != "0")
          diagnostics.push({
            severity: 4,
            range: {
              start: { line: l },
              end: { line: l },
            },
            source: "coverage",
            message: lines[l],
          });
      }
      break;
    }
  }

  return diagnostics;
}

function pushStyluaDiagnostic(diagnostics) {
  diagnostics.push({
    severity: 2,
    range: { start: { line: 0 }, end: { line: 0 } },
    source: "stylua",
    message: "file not formatted",
  });
}

let sendStyLuaWarn = true;

function stylua(path) {
  if (!checkStyluaFormatting) return {};

  const p = ch.spawnSync(styluaPath, ["-c", "--color=Never", path]);

  if (p.pid == 0) {
    if (sendStyLuaWarn) {
      connection.window
        .showWarningMessage(`github.com/JohnnyMorganz/StyLua not installed. \n
        Install it or disable this extension option.\n
        You can set stylua path as "lua-tools.luacheckPath".`);
      sendStyLuaWarn = false;
    }
    return {};
  }

  return p;
}

let sendLuaCheckWarn = true;

function luacheck(path) {
  if (!useLuacheck) return [];

  const p = ch.spawnSync(
    luacheckPath,
    [path, "--no-color", "--ranges", "--codes", "-q"],
    {},
  );

  if (p.pid === 0) {
    if (sendLuaCheckWarn) {
      connection.window.showWarningMessage(`luacheck not installed. \n
      Install it or disable this extension option.\n
      You can set luacheck path as "lua-tools.luacheckPath".`);
      sendLuaCheckWarn = false;
    }
    return [];
  }

  if (p.status !== 0 && p.output)
    return p.output.toString().matchAll(luacheckRegex);

  return [];
}

function pushDiagnostic(diagnostics, line, start, end, type, code, msg) {
  line = Number(line) - 1;

  let severity = 3; // info
  switch (type) {
    case "E":
      severity = 1; // error
    case "W":
      severity = 2; // warn
  }

  diagnostics.push({
    severity: severity,
    range: {
      start: { line: line, character: Number(start) - 1 },
      end: { line: line, character: Number(end) },
    },
    source: "luacheck " + code,
    message: msg,
  });
}
