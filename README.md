# Spark

A game engine and visual editor for building 2D games with TypeScript.

## Project structure

```
spark/
├── packages/
│   ├── runtime/       # @spark/runtime — game engine (Pixi.js-based)
│   ├── builder/       # @spark/builder — CLI build tool (esbuild + JSZip)
│   ├── studio/        # @spark/studio — Tauri desktop app (Monaco editor + player)
│   └── player/        # @spark/player — standalone web player
├── package.json       # npm workspaces root
└── tsconfig.json      # shared TypeScript config
```

## Prerequisites

- **Node.js** 20+
- **Rust** (latest stable) — for the Tauri desktop app
- **Tauri system dependencies** — see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Build the runtime

The runtime needs to be built first because it copies its bundled JS and `.d.ts`
type declarations into the studio's static assets:

```bash
npm run build -w packages/runtime
```

This runs `esbuild` to bundle the runtime into `packages/runtime/dist/runtime.js`
and copies type declarations to `packages/studio/public/runtime/`.

### 3. Copy the esbuild WASM binary

The studio uses `esbuild-wasm` to compile game scripts in-browser. Copy the
WASM binary to the studio's public directory:

```bash
cp node_modules/esbuild-wasm/esbuild.wasm packages/studio/public/esbuild.wasm
```

> **Note:** This is required once after `npm install`. When building for
> production (via `tauri bundle`), you may want to automate this copy step.

### 4. Run the studio in development mode

```bash
cd packages/studio
npm run tauri:dev
```

This starts the Vite dev server on port 1420 and opens the Tauri desktop app.
The app auto-reloads on source changes.

## Development workflows

### Run studio without the Tauri shell (faster iteration)

```bash
cd packages/studio
npm run dev
```

Then open http://localhost:1420 in a browser. Note that native file-system
operations (reading/writing workspace files) require the Tauri shell, so some
features won't work in browser-only mode.

### Build the studio for production

```bash
# 1. Build runtime first
npm run build -w packages/runtime

# 2. Copy WASM binary
cp node_modules/esbuild-wasm/esbuild.wasm packages/studio/public/esbuild.wasm

# 3. Bundle the Tauri app
cd packages/studio
npm run build:tauri
```

Output bundles are placed in `packages/studio/src-tauri/target/release/bundle/`.

## Quick reference

| Command | What it does |
|---|---|
| `npm install` | Install all workspace dependencies |
| `npm run build -w packages/runtime` | Build @spark/runtime + copy types to studio |
| `npm run build -w packages/builder` | Typecheck the builder package |
| `cd packages/studio && npm run tauri:dev` | Run the Tauri desktop app (dev) |
| `cd packages/studio && npm run dev` | Run the Vite dev server only |
| `cd packages/studio && npm run build:tauri` | Build the final Tauri bundle |
| `cp node_modules/esbuild-wasm/esbuild.wasm packages/studio/public/esbuild.wasm` | Copy WASM for in-browser compilation |
