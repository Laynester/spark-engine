import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import JSZip from "jszip";
import { writeFileSync, mkdirSync } from "node:fs";
import type { SparkConfig, PackageManifest } from "./types.js";
import type { CompiledScript } from "./compiler.js";

export interface PackageResult {
  outputPath: string;
  manifest: PackageManifest;
  size: number;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries: string[] = [];

  if (!existsSync(dir)) return entries;

  async function walk(current: string) {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(current, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        entries.push(fullPath);
      }
    }
  }

  await walk(dir);
  return entries;
}

export async function createPackage(
  config: SparkConfig,
  projectDir: string,
  compiledScripts: CompiledScript[],
  entryPaths: string[] = [],
  outputOverride?: string,
): Promise<PackageResult> {
  const zip = new JSZip();

  // 1. Add all compiled scripts (entries + library scripts)
  for (const script of compiledScripts) {
    zip.file(script.outputPath, script.code);
  }

  // 2. Copy assets and data directories
  const allAssets: string[] = [];

  for (const assetDir of config.assetDirs) {
    const dirPath = join(projectDir, assetDir);
    const files = await collectFiles(dirPath);

    for (const filePath of files) {
      const relativePath = relative(projectDir, filePath);
      const content = readFileSync(filePath);
      zip.file(relativePath, content);
      allAssets.push(relativePath);
    }
  }

  // 3. Generate manifest — only mark entry scripts for auto-start
  const manifest: PackageManifest = {
    sparkVersion: "0.1.0",
    name: config.name,
    version: config.version,
    entryScripts: entryPaths,
    assets: allAssets,
    createdAt: new Date().toISOString(),
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  // 4. Generate ZIP and write to disk
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // If an output override is provided, use it directly; otherwise use config.outputDir relative to projectDir
  const outputDir = outputOverride ?? join(projectDir, config.outputDir!);
  const outputPath = join(outputDir, `${config.name}.sprk`);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return {
    outputPath,
    manifest,
    size: buffer.length,
  };
}
