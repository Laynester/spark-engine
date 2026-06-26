import { resolve } from "node:path";
import { compileScripts } from "./compiler.js";
import { createPackage } from "./packager.js";
import { loadConfig } from "./config.js";
import type { SparkConfig, BuildResult } from "./types.js";

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

  // Step 2: Create .sprk package
  const entryPaths = config.entryScripts.map((s) => s.replace(/\.ts$/, ".js"));
  console.log(`  ── Packaging assets from ${config.assetDirs.length} director(ies)...`);
  const pkg = await createPackage(config, projectDir, compiledScripts, entryPaths, outputOverride);

  // Step 3: Report results
  const duration = (performance.now() - startTime).toFixed(1);
  const sizeKB = (pkg.size / 1024).toFixed(1);

  console.log(`\n  ✓ Built ${config.name}.sprk (${sizeKB} KB) in ${duration}ms\n`);

  return {
    outputPath: pkg.outputPath,
    size: pkg.size,
    duration: Number(duration),
    entryCount: config.entryScripts.length,
    assetCount: pkg.manifest.assets.length,
  };
}
