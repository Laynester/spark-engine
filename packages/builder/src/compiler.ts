import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SparkConfig } from "./types.js";

export interface CompiledScript {
  /** Original script path relative to project root (e.g. "scripts/main.ts") */
  entry: string;
  /** Compiled JS content */
  code: string;
  /** Output filename within the package (e.g. "scripts/main.js") */
  outputPath: string;
}

async function findTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  async function walk(current: string) {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(current, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile() && item.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

export async function compileScripts(
  config: SparkConfig,
  projectDir: string
): Promise<CompiledScript[]> {
  const scriptDirs = config.scriptDirs ?? ["scripts"];
  const allScriptFiles: string[] = [];

  for (const dir of scriptDirs) {
    const dirPath = join(projectDir, dir);
    const tsFiles = await findTsFiles(dirPath);
    allScriptFiles.push(...tsFiles);
  }

  if (allScriptFiles.length === 0) {
    return [];
  }

  // Build all scripts with esbuild (each file becomes a separate output).
  // @spark/runtime is provided by the player — never bundle it.
  const result = await esbuild.build({
    entryPoints: allScriptFiles,
    bundle: true,
    external: ["@spark/runtime"],
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: ".spark-tmp",
    write: false,
    sourcemap: false,
    minify: true,
    treeShaking: false,
    metafile: true,
  });

  const compiled: CompiledScript[] = [];
  const metafile = result.metafile!;

  for (const fullPath of allScriptFiles) {
    const relativePath = relative(projectDir, fullPath);

    const outputKey = Object.keys(metafile.outputs).find((key) => {
      return relativePath in metafile.outputs[key].inputs;
    });

    if (!outputKey) {
      console.warn(`  ⚠ Could not find compiled output for "${relativePath}"`);
      continue;
    }

    const outputFile = result.outputFiles.find((f) => f.path.endsWith(outputKey));
    if (!outputFile) {
      console.warn(`  ⚠ Compiled output file not found for "${relativePath}"`);
      continue;
    }

    compiled.push({
      entry: relativePath,
      code: outputFile.text,
      outputPath: relativePath.replace(/\.ts$/, ".js"),
    });
  }

  return compiled;
}
