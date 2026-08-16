#!/usr/bin/env node
// Lingo language server — stdio JSON-RPC. Reuses the runtime's real tokenizer
// + parser so syntax errors match the engine exactly.

import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  DocumentSymbol,
  Hover,
  InitializeResult,
  Location,
  SemanticTokens,
  SemanticTokensBuilder,
  SymbolKind,
  TextDocumentPositionParams,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  SemanticTokensRequest,
} from 'vscode-languageserver/node.js';
import type { ReferenceParams } from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize, LingoSyntaxError, type Token } from '@habbo/runtime/dist/lingo/tokenizer.js';
import { parseLingo } from '@habbo/runtime/dist/lingo/parser.js';
import { createBuiltinTable } from '@habbo/runtime/dist/lingo/builtins.js';
import { KEYWORDS, CONSTANTS, THE_PROPS, BUILTIN_DOCS, type DocEntry } from './keywords.js';
import { semanticTokens, TOKEN_TYPES, typeIndex } from './semantic.js';
import { WorkspaceIndex, handlerPositions } from './workspace.js';

// Explicit stdio so it works whether launched with --stdio, by the VS Code
// client, or directly by a test harness.
const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

// Every `.ls` file under the workspace, indexed for cross-file navigation.
// Built from initialize's workspaceFolders (or rootUri); single-file sessions
// (no folder open) just get an empty index and still work on open documents.
const workspace = new WorkspaceIndex();

// ------------------------------------------------------------------ helpers

const KW_BY_NAME = new Map(KEYWORDS.map((k) => [k.name.toLowerCase(), k]));
const THE_BY_NAME = new Map(THE_PROPS.map((p) => [p.name.toLowerCase(), p]));
const BUILTIN_BY_NAME = new Map([...createBuiltinTable().keys()].map((n) => [n.toLowerCase(), n]));
// Lowercased builtin names — call sites of these get `function` semantic
// tokens so they're colored, not plain identifiers.
const BUILTIN_LOWER = new Set(BUILTIN_BY_NAME.keys());

/** The identifier under `pos` in the document, or null when not on a word. */
function wordRangeAt(doc: TextDocument, pos: { line: number; character: number }): Range | null {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  if (offset < 0 || offset > text.length) return null;
  const isWord = (i: number) => i >= 0 && i < text.length && /[A-Za-z0-9_]/.test(text[i]);
  if (!isWord(offset)) return null;
  let start = offset;
  while (isWord(start - 1)) start--;
  let end = offset;
  while (isWord(end)) end++;
  return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

function toDoc(entry: DocEntry): CompletionItem {
  return {
    label: entry.name,
    kind: entry.kind === 'function' ? CompletionItemKind.Function
      : entry.kind === 'property' ? CompletionItemKind.Property
      : entry.kind === 'constant' ? CompletionItemKind.Constant
      : CompletionItemKind.Keyword,
    detail: entry.doc,
    insertText: entry.name,
  };
}

/** Parse + report every syntax error the runtime can throw for a document. */
function lint(doc: TextDocument): Diagnostic[] {
  const src = doc.getText();
  const out: Diagnostic[] = [];
  let tokens: Token[] = [];
  try {
    tokens = tokenize(src);
  } catch (e) {
    if (e instanceof LingoSyntaxError) {
      const p = doc.positionAt(0);
      const lineText = src.split('\n')[e.line - 1] ?? '';
      out.push({
        range: {
          start: { line: e.line - 1, character: 0 },
          end: { line: e.line - 1, character: lineText.length },
        },
        severity: DiagnosticSeverity.Error,
        source: 'lingo',
        message: e.message,
      });
      return out;
    }
    throw e;
  }
  try {
    parseLingo(src);
  } catch (e) {
    if (e instanceof LingoSyntaxError) {
      const lineText = src.split('\n')[e.line - 1] ?? '';
      out.push({
        range: {
          start: { line: e.line - 1, character: 0 },
          end: { line: e.line - 1, character: lineText.length },
        },
        severity: DiagnosticSeverity.Error,
        source: 'lingo',
        message: e.message,
      });
    } else {
      throw e;
    }
  }
  void tokens;
  return out;
}

function completionFor(linePrefix: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const k of KEYWORDS) items.push(toDoc(k));
  for (const c of CONSTANTS) items.push(toDoc(c));
  for (const p of THE_PROPS) items.push(toDoc(p));
  for (const name of BUILTIN_BY_NAME.values()) {
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: BUILTIN_DOCS[name] ?? 'Lingo builtin function',
      insertText: name,
    });
  }
  // User handlers from the whole workspace (deduped against the builtins).
  const seen = new Set(items.map((i) => i.label.toLowerCase()));
  for (const name of workspace.handlerNames()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const defs = workspace.lookup(name);
    const d = defs[0];
    items.push({
      label: d ? d.name : name,
      kind: CompletionItemKind.Function,
      detail: d ? `on ${d.name}(${d.params.join(', ')})  — ${d.uri.split('/').pop()}` : 'Lingo handler',
      insertText: d ? d.name : name,
    });
  }
  // Keep the list honest: when typing inside `the `, only props matter.
  const afterThe = /the\s+$/i.test(linePrefix);
  if (afterThe) return items.filter((i) => i.kind === CompletionItemKind.Property);
  return items;
}

/** True when the cursor sits on the callee of a call (`name(` or `me.name(`). */
function isCallSite(doc: TextDocument, pos: { line: number; character: number }): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(doc.getText());
  } catch {
    return false;
  }
  const offset = doc.offsetAt(pos);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'eof' || t.type === 'punct') continue;
    if (offset >= t.pos && offset <= t.pos + t.value.length) {
      return tokens[i + 1]?.value === '(';
    }
  }
  return false;
}

function defLocation(def: { uri: string; line: number; char: number; endChar: number }): Location {
  return Location.create(def.uri, {
    start: { line: def.line, character: def.char },
    end: { line: def.line, character: def.endChar },
  });
}

// ---------------------------------------------------------------- lifecycle

connection.onInitialize((params): InitializeResult => {
  // Remember where the workspace lives so we can index every .ls file in it
  // (the corpus scripts are usually in sibling folders of the file you open).
  const folders = params.workspaceFolders ?? [];
  const roots = folders.length
    ? folders.map((f) => f.uri)
    : params.rootUri ? [params.rootUri] : [];
  workspace.setRoots(roots);
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
      },
      completionProvider: {
        triggerCharacters: [],
        resolveProvider: false,
      },
      hoverProvider: true,
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...TOKEN_TYPES],
          tokenModifiers: [],
        },
        full: true,
      },
    },
  };
});

connection.onInitialized(() => {
  // Kick off the corpus scan in the background — initialize already answered.
  void workspace.scan();
});

// Keep the index in sync with open documents (didChange covers edits; didSave
// covers external saves the client tells us about).
documents.onDidOpen((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: lint(e.document) });
  workspace.indexFile(e.document.uri, e.document.getText());
});
documents.onDidChangeContent((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: lint(e.document) });
  workspace.indexFile(e.document.uri, e.document.getText());
});
documents.onDidSave((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: lint(e.document) });
  workspace.indexFile(e.document.uri, e.document.getText());
});

// Files created/deleted on disk (git checkout, new script, …).
connection.onDidChangeWatchedFiles((params) => {
  for (const c of params.changes) {
    if (!c.uri.endsWith('.ls')) continue;
    if (c.type === 1 || c.type === 2) workspace.indexFile(c.uri); // created/changed
    else if (c.type === 3) workspace.dropFile(c.uri); // deleted
  }
});

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const prefix = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });
  return completionFor(prefix);
});

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordRangeAt(doc, params.position);
  if (!word) return null;
  const name = doc.getText(word).toLowerCase();
  // Workspace handler (possibly defined in another file) wins over builtins.
  const defs = workspace.lookup(name);
  if (defs.length > 0) {
    const d = defs[0];
    const file = d.uri.split('/').pop();
    return {
      contents: {
        kind: 'markdown',
        value: ['```lingo', `on ${d.name}(${d.params.join(', ')})`, '```', '', `Defined in **${file}**`, ...(defs.length > 1 ? [`(${defs.length} definitions)`] : [])].join('\n'),
      },
      range: word,
    };
  }
  const entry = KW_BY_NAME.get(name) ?? THE_BY_NAME.get(name);
  let docStr: string | undefined;
  if (entry) docStr = entry.doc;
  else if (BUILTIN_DOCS[name]) docStr = BUILTIN_DOCS[name];
  else if (BUILTIN_BY_NAME.has(name)) docStr = 'Lingo builtin function.';
  if (!docStr) return null;
  return {
    contents: { kind: 'markdown', value: ['```lingo', name, '```', '', docStr].join('\n') },
    range: word,
  };
});

// Cmd/Ctrl+click a call -> jump to the `on <name>` in the defining file.
connection.onDefinition((params: TextDocumentPositionParams): Location[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordRangeAt(doc, params.position);
  if (!word) return null;
  const name = doc.getText(word).toLowerCase();
  const defs = workspace.lookup(name);
  if (defs.length === 0) return null;
  // Only resolve actual calls (next token is `(`), not same-named variables.
  if (!isCallSite(doc, params.position)) return null;
  return defs.map(defLocation);
});

// Find every call site of a handler across the workspace.
connection.onReferences((params: ReferenceParams): Location[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const word = wordRangeAt(doc, params.position);
  if (!word) return null;
  const name = doc.getText(word).toLowerCase();
  const defs = workspace.lookup(name);
  if (defs.length === 0) return null;
  const out: Location[] = [];
  // LSP: with includeDeclaration, the definition itself is part of the result.
  if (params.context?.includeDeclaration) {
    for (const d of defs) out.push(defLocation(d));
  }
  const seen = new Set<string>();
  for (const uri of workspace.indexedUris()) {
    const tokens = workspace.tokensOf(uri);
    const starts = workspace.lineStartsOf(uri);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'ident' || t.value.toLowerCase() !== name) continue;
      if (tokens[i + 1]?.value !== '(') continue;
      const key = `${uri}:${t.pos}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = t.line - 1;
      const char = t.pos - (starts[line] ?? 0);
      out.push(Location.create(uri, {
        start: { line, character: char },
        end: { line, character: char + t.value.length },
      }));
    }
  }
  return out;
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const src = doc.getText();
  let script;
  try {
    script = parseLingo(src);
  } catch {
    return [];
  }
  const positions = handlerPositions(src);
  const symbols: DocumentSymbol[] = [];
  for (const h of script.handlers) {
    const pos = positions.get(h.name.toLowerCase());
    if (!pos) continue;
    const start = { line: pos.line, character: pos.char };
    const end = { line: pos.line, character: pos.char + h.name.length + 3 };
    symbols.push({
      name: h.name,
      detail: `on ${h.name}(${h.params.join(', ')})`,
      kind: SymbolKind.Function,
      range: { start, end },
      selectionRange: { start, end },
    });
  }
  return symbols;
});

connection.onRequest(SemanticTokensRequest.type, (params: { textDocument: { uri: string } }): SemanticTokens | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const src = doc.getText();
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch {
    return null;
  }
  const builder = new SemanticTokensBuilder();
  for (const t of semanticTokens(src, tokens, {
    builtins: BUILTIN_LOWER,
    globals: new Set(workspace.handlerNames()),
  })) {
    builder.push(t.line, t.char, t.length, typeIndex(t.type), 0);
  }
  return builder.build();
});

// -------------------------------------------------------------------- main

documents.listen(connection);
connection.listen();
