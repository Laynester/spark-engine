# Spark Platform Specification

## Overview

Spark is a Flash, Shockwave, and Director-inspired multimedia runtime platform for the modern web.

Spark is not a traditional game engine.

Spark is a platform that loads packaged content files (`.sprk`) containing assets, scripts, and metadata, then executes them inside a sandboxed runtime.

The architecture should resemble:

```text
Authoring Project
       ↓
Spark Builder
       ↓
game.sprk
       ↓
Spark Runtime
       ↓
Spark Player
```

---

# Core Philosophy

## Scripts Own The World

Spark is script-driven.

Scripts are responsible for creating and managing their own entities.

The runtime does not define entities in scene files.

The runtime provides APIs that allow scripts to create visual objects dynamically.

Example:

```ts
const player = spark.spawn({
  texture: "player.png",
  x: 100,
  y: 100,
});
```

The script controls the lifecycle of the entity.

---

## Runtime First

The runtime is the most important component.

Editor tooling should not be considered during the initial implementation.

Focus on:

- Runtime
- Package format
- Asset loading
- Script execution
- Debugging

Do not build:

- Visual editors
- Timeline editors
- Custom scripting languages
- ECS frameworks

during the MVP phase.

---

# Monorepo Structure

```text
spark/
├─ packages/
│  ├─ runtime/
│  ├─ builder/
│  └─ player/
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

# Package Format

Spark packages use the extension:

```text
.sprk
```

Internally, a `.sprk` file is simply a ZIP archive.

Example:

```text
game.sprk
├─ manifest.json
├─ assets/
├─ scripts/
└─ data/
```

---

# Runtime

Package:

```text
packages/runtime
```

Technology:

- TypeScript
- PixiJS
- JSZip
- EventEmitter3

Responsibilities:

- Package loading
- Asset loading
- Script execution
- Display tree
- Update loop
- Input events
- Runtime APIs

---

## Runtime API

The runtime should expose:

```ts
loadPackage(file);

start();
stop();

spawn(config);
destroy(entity);

loadAsset(path);
loadScript(path);

on(event, callback);
emit(event, payload);
```

---

## Script Lifecycle

Scripts are ES Modules.

Scripts export a default class.

Example:

```ts
export default class Player {
  constructor(spark) {}

  onCreate() {}

  onUpdate(dt) {}

  onDestroy() {}

  onClick() {}
}
```

The runtime automatically invokes lifecycle methods.

---

## Entity Model

Scripts create entities dynamically.

Example:

```ts
const entity = spark.spawn({
  texture: "player.png",
  x: 100,
  y: 100,
});
```

Entities support:

```ts
entity.x;
entity.y;
entity.rotation;
entity.scale;
entity.visible;

entity.destroy();
```

Scripts should never interact directly with PixiJS objects.

Spark should provide a simplified abstraction layer.

---

## Display Tree

Internally use PixiJS.

Expose:

```ts
Container;
Sprite;
Text;
```

through Spark APIs.

The goal is to provide a Flash-like display list.

---

# Builder

Package:

```text
packages/builder
```

Technology:

- TypeScript
- esbuild
- JSZip
- chokidar

Responsibilities:

- Compile TypeScript
- Bundle scripts
- Package assets
- Generate manifests
- Create `.sprk` files

---

## CLI Commands

```bash
spark build
spark watch
```

---

## Project Structure

Input project:

```text
project/
├─ assets/
├─ scripts/
├─ data/
└─ spark.config.json
```

Output:

```text
dist/game.sprk
```

---

## Build Pipeline

1. Compile TypeScript to JavaScript
2. Copy assets
3. Generate manifest
4. Package into ZIP
5. Rename ZIP to `.sprk`

---

# Player

Package:

```text
packages/player
```

Technology:

- TypeScript
- Vite
- Spark Runtime

Responsibilities:

- Development player
- Runtime host
- Package inspector
- Debugging environment

---

## Features

### Drag And Drop

Allow users to drag and drop:

```text
game.sprk
```

The player should automatically:

```ts
runtime.loadPackage(file);
runtime.start();
```

---

### Debug Panel

Display:

- FPS
- Loaded assets
- Loaded scripts
- Active entities
- Runtime events
- Memory statistics

---

### Hot Reload

When Builder is running in watch mode:

```bash
spark watch
```

The player should automatically reload the latest package.

---

# Future Components

These are not part of the MVP.

Future packages may include:

```text
packages/studio
packages/devtools
packages/networking
packages/physics
```

Potential future products:

```text
Spark Studio
Spark DevTools
Spark Inspector
```

---

# Inspiration

Spark is inspired by:

- Adobe Flash Player
- Adobe Director
- Shockwave
- Roblox
- Unity

However, Spark should remain modern and TypeScript-based.

---

# Non-Goals

Do not implement:

- Custom scripting language
- Timeline editor
- Visual editor
- ECS architecture
- Custom bytecode VM

for the MVP.

---

# MVP Success Criteria

A successful MVP should be able to:

1. Build a `.sprk` package.
2. Load a `.sprk` package.
3. Execute scripts.
4. Spawn entities dynamically.
5. Render sprites through PixiJS.
6. Handle input events.
7. Run an update loop.
8. Display debugging information.

Once these goals are achieved, Spark can be considered a functioning runtime platform.
