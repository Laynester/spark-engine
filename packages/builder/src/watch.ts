import { resolve } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { build } from "./build.js";
import { loadConfig } from "./config.js";
import type { SparkConfig } from "./types.js";

export async function watch(configOrPath?: SparkConfig | string): Promise<void> {
  const config: SparkConfig =
    typeof configOrPath === "string" || configOrPath === undefined
      ? loadConfig(configOrPath as string | undefined)
      : configOrPath;

  const projectDir = process.cwd();

  // Do an initial build
  console.log(`\n  Watching ${config.name} v${config.version}...\n`);
  await build(config);

  // Watch all scripts, assets, and the config file
  const watchPatterns = [
    ...config.entryScripts.map((s) => resolve(projectDir, s)),
    ...config.assetDirs.map((d) => resolve(projectDir, d, "**/*")),
    resolve(projectDir, "spark.config.json"),
  ];

  const watcher = chokidarWatch(watchPatterns, {
    ignoreInitial: true,
    persistent: true,
  });

  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = 100;

  const rebuild = async (filePath: string) => {
    const relativePath = filePath.replace(projectDir + "/", "");
    console.log(`\n  Change detected: ${relativePath}`);
    console.log(`  Rebuilding...`);

    try {
      await build(config);
    } catch (err) {
      console.error(`  ✗ Build failed:`, (err as Error).message);
    }
  };

  watcher.on("change", (filePath) => {
    // Debounce rapid changes (e.g. editor auto-save)
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild(filePath), debounceMs);
  });

  watcher.on("add", (filePath) => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => rebuild(filePath), debounceMs);
  });

  console.log(`  Waiting for changes... Press Ctrl+C to stop.\n`);
}
