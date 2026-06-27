import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { compileScripts } from "./compiler.js";
import { createPackage } from "./packager.js";
import { loadConfig } from "./config.js";
import type { SparkConfig, BuildResult, PrefabDefinition } from "./types.js";

/** Discover .prefab.json files recursively in a directory. */
async function discoverPrefabs(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  async function walk(current: string) {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(current, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile() && item.name.endsWith(".prefab.json")) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

export async function build(
  configOrPath?: SparkConfig | string,
  outputOverride?: string,
): Promise<BuildResult> {
  const config: SparkConfig =
    typeof configOrPath === "string" || configOrPath === undefined
      ? loadConfig(configOrPath as string | undefined)
      : configOrPath;

  const projectDir = process.cwd();
  const startTime = performance.now();

  console.log(`\n  Building ${config.name} v${config.version}...\n`);

  // Step 1: Compile all scripts with esbuild
  console.log(`  ── Compiling scripts...`);
  const compiledScripts = await compileScripts(config, projectDir);
  if (compiledScripts.length > 0) {
    for (const s of compiledScripts) {
      const isEntry = config.entryScripts.includes(s.entry);
      console.log(`     ${isEntry ? "▶" : " "} ${s.entry} → ${s.outputPath} (${s.code.length} bytes)`);
    }
  } else {
    console.log(`     (no scripts to compile)`);
  }

  // Step 2: Discover prefab definitions
  let prefabs: PrefabDefinition[] = [];
  if (config.prefabDir) {
    const prefabDir = join(projectDir, config.prefabDir);
    if (existsSync(prefabDir)) {
      const prefabFiles = await discoverPrefabs(prefabDir);
      if (prefabFiles.length > 0) {
        console.log(`  ── Loading ${prefabFiles.length} prefab(s)...`);
        for (const file of prefabFiles) {
          try {
            const raw = readFileSync(file, "utf-8");
            const def: PrefabDefinition = JSON.parse(raw);
            if (!def.name || (!Array.isArray(def.parts) && !def.variants)) {
              console.warn(`     ⚠ Skipping invalid prefab: ${file} (needs "parts" or "variants")`);
              continue;
            }
            if (def.variants) {
              let variantValid = true;
              for (const [vName, v] of Object.entries(def.variants)) {
                if (!Array.isArray(v.parts) && !v.states) {
                  console.warn(`     ⚠ Skipping invalid prefab: ${file} (variant "${vName}" needs "parts" or "states")`);
                  variantValid = false;
                  break;
                }
              }
              if (!variantValid) continue;
            }
            const partCount = def.parts?.length ?? Object.keys(def.variants!).length;
            const variantInfo = def.variants ? `, ${Object.keys(def.variants).length} variant(s)` : "";
            const stateInfo = def.variants
              ? (() => {
                  const total = Object.values(def.variants).reduce((sum, v) => sum + (v.states ? Object.keys(v.states).length : 0), 0);
                  return total > 0 ? `, ${total} state(s)` : "";
                })()
              : "";
            prefabs.push(def);
            console.log(`     ◆ ${def.name} (${partCount} part${partCount > 1 ? "s" : ""}${variantInfo}${stateInfo})`);
          } catch {
            console.warn(`     ⚠ Failed to parse prefab: ${file}`);
          }
        }
      }
    }
  }

  // Step 3: Create .sprk package
  const entryPaths = config.entryScripts.map((s) => s.replace(/\.ts$/, ".js"));
  console.log(`  ── Packaging assets from ${config.assetDirs.length} director(ies)...`);
  const pkg = await createPackage(config, projectDir, compiledScripts, entryPaths, outputOverride, prefabs);

  // Step 3: Report results with size breakdown
  const duration = (performance.now() - startTime).toFixed(1);
  const sizeKB = (pkg.size / 1024).toFixed(1);
  const sizeMBNum = pkg.size / (1024 * 1024);

  // Size breakdown
  const scriptBytes = compiledScripts.reduce((sum, s) => sum + s.code.length, 0);
  const stats = [
    `  ── Size breakdown:`,
    `     Scripts : ${(scriptBytes / 1024).toFixed(1)} KB (${compiledScripts.length} files)`,
    `     Assets  : ${pkg.manifest.assets.length} files`,
  ];
  if (pkg.audioBytesSaved > 0) {
    stats.push(`     Audio   : saved ${(pkg.audioBytesSaved / 1024).toFixed(0)} KB (${pkg.audioFilesOptimized} file${pkg.audioFilesOptimized > 1 ? "s" : ""})`);
  }
  stats.push(`     Total   : ${sizeMBNum.toFixed(2)} MB (${sizeKB} KB)`);
  if (sizeMBNum > 5) {
    stats.push(`     ⚠  Large .sprk — check for big audio/images or uncompressed assets`);
  }
  console.log(`\n  ✓ Built ${config.name}.sprk in ${duration}ms`);
  console.log(stats.join("\n"));
  console.log();

  return {
    outputPath: pkg.outputPath,
    size: pkg.size,
    duration: Number(duration),
    entryCount: config.entryScripts.length,
    assetCount: pkg.manifest.assets.length,
  };
}
