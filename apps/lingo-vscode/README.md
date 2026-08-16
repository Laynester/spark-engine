# Lingo (Director) — VS Code extension

Lingo language support for the Habbo v14 client scripts (`*.ls`). Uses the
**actual** tokenizer + parser from `@habbo/runtime`, so syntax errors,
keywords and completions match the engine that runs the scripts.

## What you get

- **Syntax highlighting** — TextMate grammar (`syntaxes/lingo.tmLanguage.json`,
  generated from `packages/lingo-lsp/src/keywords.ts` so it never drifts) plus
  semantic tokens from the server for precise identifier classification.
- **Diagnostics** — real parse errors (unterminated strings, bad blocks, …)
  reported on open/change/save, via `parseLingo`/`tokenize` from the runtime.
- **Completions** — all control-flow keywords, `the`-properties, constants and
  **every builtin** from the runtime's builtin table (so new builtins show up
  without touching the LSP), plus every global function from the workspace's
  **Movie Scripts** (the `*_API` files) with its signature. Inside `the …` only
  properties are suggested.
- **Go to definition / find references** — Cmd+click a call like
  `convertToPropList(...)` and jump to its `on convertToPropList` in another
  file; find-references lists every call site across the workspace.
- **Hover** — one-liners for keywords, `the`-props and builtins, and the
  signature + defining file for workspace globals.
- **Outline** — every `on <handler>` in the file as a document symbol.

### What counts as a "global"

Only scripts whose header says `-- Type: Movie Script` (the corpus's 33 `*_API`
files) contribute handlers to the cross-file index — those are the functions
any script can call by bare name. Parent/Behavior/Score script handlers
(`exitFrame`, `mouseDown`, instance methods…) are deliberately **not** indexed,
so they don't pollute completions. The workspace is scanned on startup and
kept in sync as files are edited/created/deleted.

## Running it (from the repo)

```sh
npm install          # links vscode-languageclient etc.
npm run build        # builds runtime -> lingo-lsp -> this extension
code apps/lingo-vscode
```

In the opened window press **F5** (Run Extension) to launch the Extension
Development Host, then open any `.ls` file from `exported/`.

## Distribution (`.vsix`)

The extension is fully self-contained: at build time `esbuild` bundles the
language server (parser, tokenizer, keywords, LSP stack) into
`server/server.cjs` and the client (`vscode-languageclient`) into
`dist/extension.js` — the `vscode` module is the only thing left external,
because VS Code provides it. No `node_modules` ships.

```sh
npm run package -w lingo-vscode
# -> apps/lingo-vscode/lingo-vscode-0.1.0.vsix (~200 KB)
```

Install the file anywhere (no repo needed):

```sh
code --install-extension lingo-vscode-0.1.0.vsix
# or: drag it onto the Extensions panel
```

Notes:
- `--no-dependencies` is passed to `vsce` on purpose — inside an npm
  workspace `npm list --production` reports the workspace root and vsce would
  package the entire repo. Everything is bundled, so nothing is lost.
- To publish to the **VS Code Marketplace** you need a publisher account
  (marketplace.visualstudio.com), then:
  `npx vsce login <publisher>` and `npx vsce publish --no-dependencies`.
- To publish to **Open VSX** (open-vsx.org), upload the same `.vsix` file on
  the site after creating a publisher namespace.

## Standalone

The server itself is plain stdio LSP and doesn't need VS Code:

```sh
node packages/lingo-lsp/dist/server.js   # speak LSP on stdin/stdout
scripts/smoke-lingo-lsp.mjs              # end-to-end smoke test (10 checks)
```

## Files

```
packages/lingo-lsp/          the language server (reuses @habbo/runtime)
  src/keywords.ts            curated keywords / the-props / builtin docs
  src/semantic.ts            tokenizer output -> semantic token types
  src/server.ts              diagnostics, completion, hover, symbols, tokensapps/lingo-vscode/           the VS Code extension
  src/extension.ts            spawns the bundled server
  scripts/gen-grammar.mjs    regenerates the TextMate grammar from keywords.ts
  scripts/bundle-server.mjs  esbuild: server -> server/server.cjs (self-contained)
  scripts/bundle-client.mjs  esbuild: client -> dist/extension.js (vscode external)
  server/                    bundled server (built, committed or built in CI)
  syntaxes/                  generated grammar (commit it)
```
