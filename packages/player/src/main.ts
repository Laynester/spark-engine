import { SparkRuntime } from "@spark/runtime";
import { DebugPanel } from "./DebugPanel.js";
import { HotReload } from "./HotReload.js";

// Create the canvas element inside the container
const container = document.getElementById("spark-container")!;
const canvas = document.createElement("canvas");
canvas.id = "spark-canvas";
container.appendChild(canvas);

const runtime = new SparkRuntime({
  view: canvas,
  width: window.innerWidth,
  height: window.innerHeight,
});

const debug = new DebugPanel();
const dropHint = document.getElementById("spark-drop-hint")!;
let started = false;

function updateDebugStats() {
  debug.setEntityCount(runtime.getAllEntities().length);
  debug.setScriptCount(runtime.scripts.getInstances().length);
  // Count total assets across all loaded packages
  let totalAssets = 0;
  for (const ns of runtime.loadedPackages) {
    const manifest = runtime.getPackageManifest(ns);
    if (manifest) totalAssets += manifest.assets.length;
  }
  debug.setAssetCount(totalAssets);
}

// Wire up runtime events to debug panel
runtime.events.on("entity:spawned", () => debug.setEntityCount(runtime.getAllEntities().length));
runtime.events.on("entity:destroyed", () => debug.setEntityCount(runtime.getAllEntities().length));
runtime.events.on("package:loaded", (manifest: Record<string, unknown>) => {
  dropHint.classList.add("hidden");
  debug.logEvent(`Loaded: ${String(manifest.name)} v${String(manifest.version)}`);
  updateDebugStats();
});
runtime.events.on("start", () => { started = true; debug.logEvent("Started"); });
runtime.events.on("stop", () => { started = false; debug.logEvent("Stopped"); });

// FPS tracking — driven by the Pixi ticker so maxFPS is reflected
runtime.updateLoop.add(() => debug.tick(performance.now()));

function isSprkFile(file: File): boolean {
  return file.name.endsWith(".sprk");
}

// Drag and drop support — multiple files accepted
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragenter", () => dropHint.classList.add("dragging"));
document.addEventListener("dragleave", () => dropHint.classList.remove("dragging"));
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropHint.classList.remove("dragging");

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  // Filter to .sprk files
  const sprkFiles = Array.from(files).filter(isSprkFile);
  if (sprkFiles.length === 0) return;

  try {
    // Load each .sprk file — builds up the package registry
    for (const file of sprkFiles) {
      await runtime.loadPackage(file);
      debug.logEvent(`Loaded: ${file.name}`);
    }

    // Start after all packages are loaded
    await runtime.start();
    debug.logEvent(`Started with ${sprkFiles.length} package(s)`);
    updateDebugStats();
  } catch (err) {
    debug.logEvent(`Error: ${(err as Error).message}`);
  }
});

// Hot reload from URL param
const params = new URLSearchParams(window.location.search);
const sprkUrl = params.get("sprk");
if (sprkUrl) {
  const hotReload = new HotReload({
    sprkUrl,
    interval: 1500,
    onReload: async () => {
      if (started) {
        runtime.destroyAll();
        started = false;
      }
      try {
        const response = await fetch(sprkUrl);
        const blob = await response.blob();
        const file = new File([blob], sprkUrl.split("/").pop() ?? "package.sprk");
        await runtime.loadPackage(file);
        await runtime.start();
        debug.logEvent("Hot reloaded");
        updateDebugStats();
      } catch (err) {
        debug.logEvent(`Reload error: ${(err as Error).message}`);
      }
    },
  });
  hotReload.start();
}

// Handle window resize
window.addEventListener("resize", () => {
  runtime.display.resize(window.innerWidth, window.innerHeight);
});

// Show initial idle state
debug.logEvent("Drop .sprk file(s)");
