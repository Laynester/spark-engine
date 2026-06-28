import { SparkRuntime } from "@spark/runtime";
import { DebugPanel } from "./DebugPanel.js";
import { HotReload } from "./HotReload.js";

let debugPanel: DebugPanel | null = null;

// ── Init ───────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const container = document.getElementById("spark-container")!;
const canvas = document.createElement("canvas");
canvas.id = "spark-canvas";
container.appendChild(canvas);
canvas.width = parseInt(params.get("width") ?? "")

const runtime = new SparkRuntime({
  view: canvas,
  width: parseInt(params.get("width") ?? ""),
  height: parseInt(params.get("height") ?? ""),
});

const debug = new DebugPanel();
debugPanel = debug;

const dropHint = document.getElementById("spark-drop-hint")!;
let started = false;


function updateDebugStats() {
  debug.setEntityCount(runtime.getAllEntities().length);
  debug.setPackages(runtime.loadedPackages);
}

// Wire up runtime events to debug panel
runtime.events.on("entity:spawned", () => debug.setEntityCount(runtime.getAllEntities().length));
runtime.events.on("entity:destroyed", () => debug.setEntityCount(runtime.getAllEntities().length));
runtime.events.on("package:loaded", (manifest: Record<string, unknown>) => {
  dropHint.classList.add("hidden");
  console.log(`Loaded: ${String(manifest.name)} v${String(manifest.version)}`);
  updateDebugStats();
});
runtime.events.on("start", () => { started = true; console.log("Started"); });
runtime.events.on("stop", () => { started = false; console.log("Stopped"); });

// FPS tracking — driven by the Pixi ticker so maxFPS is reflected
runtime.updateLoop.add(() => debug.tick(performance.now()));

function isSprkFile(file: File): boolean {
  return file.name.endsWith(".sprk");
}

// Hot reload from URL param — just reloads the page on change
const sprkUrl = params.get("sprk");
if (sprkUrl) {
  (async () => {
    try {
      await runtime.loadPackageUrl(sprkUrl);
      await runtime.start();
      console.log("Started");
      updateDebugStats();
    } catch (err) {
      console.error(`Load error: ${(err as Error).message}`);
    }
  })();

  const hotReload = new HotReload({
    sprkUrl,
    interval: 1500,
    onReload: async () => {
      console.log("Change detected, reloading...");
      location.reload();
    },
  });
  hotReload.start();
}
