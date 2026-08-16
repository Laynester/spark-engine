# spark-engine

A re-implementation of the Adobe Shockwave / Director runtime in TypeScript,
built to run the 2001–2006-era Habbo Hotel (v31) client in the browser: the
Lingo interpreter, the Director movie engine, the rendering stage, and the
Multiuser Xtra.

This repo also ships the tooling around the runtime:

| Package | What it is |
|---|---|
| `packages/runtime` — `@habbo/runtime` | the engine: Lingo interpreter, Director movie player, PixiJS stage, and the `<spark-player>` web component |
| `packages/bundler` — `@spark/bundler` | packs decompiled Director casts into `.spark`/`.zip` bundles the runtime fetches |
| `packages/lingo-lsp` + `apps/lingo-vscode` | a Lingo language server and VS Code extension for editing decompiled scripts |

The client movie itself is **not** in this repo. You bring the (decompiled)
client data; this repo runs it.

## Pipeline: decompile → bundle → run

The runtime never reads Director `.cct`/`.dcr` files directly — those are
proprietary data, and the engine needs the casts as plain files first. The
whole pipeline is:

```
sparkd client_dir ./exported     # 1. decompile the casts (spark-dumper)
spark bundle ./exported ./out    # 2. bundle them (.spark archives)
# 3. serve ./out + lingo-runtime.iife.min.js and drop in a <spark-player>
```

### 1. Decompile the casts — requires custom decompilation

[spark-dumper](https://github.com/Laynester/spark-dumper) (a fork of rusty-air)
exports Director/Shockwave casts (`.cct`, `.dcr`, `.cst`) into editable project
folders — decompiled Lingo scripts, bitmaps, texts, palettes, fonts — as plain
files the rest of this pipeline consumes.

```bash
# install (or grab a prebuilt binary for your OS from its Releases page)
curl -sSL https://raw.githubusercontent.com/Laynester/spark-dumper/main/install.sh | sh

# export a single cast file, or a whole tree (18 threads)
sparkd habbo.dcr ./exported
sparkd ./client_dir ./exported -j 18
```

This is the **custom decompilation** step the engine depends on. The runtime's
behavior is tied to how the export looks: `variable.index` text members define
figure part data, `.props` members describe sprite inks, `casts.txt` lists the
linked casts, and so on — so the dumps must come from spark-dumper (or a tool
that produces the same layout).

### 2. Bundle the casts — `@spark/bundler`

The runtime fetches casts over HTTP as `.spark` (zip) archives. The bundler
turns the decompiled folders into those archives:

```bash
# npm route:
npm i -g @spark/bundler
spark bundle ./exported ./out      # every cast under ./exported -> ./out/<cast>.spark

# single-file route (no npm): download bundler.js from the latest Release
chmod +x bundler.js
./bundler.js ./exported ./out      # or: node bundler.js ./exported ./out
```

`spark bundle <root> [<outDir>]` bundles every cast under `<root>` into
`<outDir>` (one archive per cast). Useful flags: `--casts a,b,c` (subset),
`--ext zip|spark`, `--jobs N` (parallel workers; `1` = sequential),
`--out <file>` (single combined bundle instead of a directory). The old alias
`habbo-bundle` still works.

### 3. Run it — the runtime's `<spark-player>`

Download `lingo-runtime.iife.min.js` from the latest
[Release](https://github.com/Laynester/spark-engine/releases) (or use the
un-minified `.js`), drop it on a page next to your bundles, and embed:

```html
<!doctype html>
<script src="lingo-runtime.iife.min.js"></script>

<spark-player movie="./habbo.spark"
  sw1="site.url=http://www.habbo.ch;url.prefix=http://www.habbo.ch"
  sw2="connection.info.host=localhost;connection.info.port=3000"
  sw4="connection.mus.host=localhost;connection.mus.port=3004"
  sw5="external.variables.txt=/external_vars.txt;external.texts.txt=/external_texts.txt"
  sw6="use.sso.ticket=1;sso.ticket=test-sso"
  log="#log"></spark-player>

<pre id="log"></pre>
```

- `movie` (required) — the movie's own cast bundle. Linked casts are fetched
  as `<name>.spark` / `<name>.zip` from the same directory (the `spark bundle`
  output).
- `sw1`…`sw9` — external params, exposed to Lingo via `externalParamValue`.
  `sw2`/`sw4` configure the Multiuser connections (`connection.info.*` and
  `connection.mus.*`); `sw5` points at the client's `external_variables.txt` /
  `external_texts.txt`; `sw6` carries the SSO ticket. The Multiuser Xtra opens
  its own WebSockets (wss on https pages) — the embed opens nothing itself.
- `width` / `height` — optional stage size override (defaults to the movie's
  `movie.txt`).
- `log` — a CSS selector for a `<pre>` to stream the engine log into.

The running engine is exposed as `element.engine` (`element.directorEngine`),
and a `spark-ready` event fires once boot starts. For a full working example
see `apps/demo`.

### 4. Edit the scripts — the Lingo LSP

`lingo-vscode.vsix` from the Releases page installs the VS Code extension
(powered by `@habbo/lingo-lsp`): decompiled `.ls` scripts get syntax
highlighting, outline, diagnostics, and hover/definition info.

## Third-party code and licenses

The engine's Lingo semantics were developed against three existing Director
reimplementations. Reading GPL/AGPL code and porting from it is allowed, but it
**does impose obligations** if this code is ever distributed (which a web
client, by serving its JS, does):

| Project | License | What this repo borrows | Source |
|---|---|---|---|
| LibreShockwave | **AGPL-3.0** | ink compositing (`applyInkPixel`), image opcodes (`copyPixels`, flood-fill mattes), Director file parsing | https://github.com/LibreShockwave/LibreShockwave |
| dirplayer-rs | **GPL-3.0** | Lingo number/string semantics (`integer()` rounding, i32 wrapping), ink colorization, text/bitmap behavior | https://github.com/igorlira/dirplayer-rs |
| ScummVM | **GPL-3.0+** | Director format reference (archive parsing) | https://github.com/scummvm/scummvm |

- **License texts:** `licenses/` — `LibreShockwave-LICENCE.txt` (AGPL-3.0),
  `DirPlayer-LICENSE.txt` (GPL-3.0), `ScummVM-COPYING.txt` (GPL-3.0), copied
  verbatim from those projects.
- **Detailed audit:** [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — every
  source comment that cites these projects, classified as direct port /
  derived rules / behavioral parity, with the exact file+line references.

This repo itself currently ships **without a license** (all rights reserved by
default). Before distributing the compiled client, decide between a clean-room
rewrite of the ported functions (see the audit's remediation paths) or
re-licensing this project under an AGPL-3.0-compatible license. The
`hh_*` client assets are Sulake's proprietary data — a separate copyright
question that a tool license doesn't resolve.

## Development

```bash
npm install
npm run build        # all workspaces
npm run typecheck    # all workspaces
npm test             # bundler + runtime test suites
npm run dev:demo     # the apps/demo dev server (vite)
```

The demo loads the runtime straight from `packages/runtime/src` via Vite, so
edits hot-reload without a rebuild. `npm run bundle:browser` produces the
distributable `lingo-runtime.iife(.min).js`.

## Releasing

Pushing to `master` runs CI; when it succeeds the Release workflow
automatically bumps the patch version (`v0.1.0` → `v0.1.1` → …), builds, and
attaches the runtime bundle, the bundler tarball + single-file `bundler.js`,
and the LSP `.vsix` to a GitHub Release — no manual tagging. Details in
[RELEASE.md](RELEASE.md).
