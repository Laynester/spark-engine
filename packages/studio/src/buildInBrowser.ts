import * as esbuild from "esbuild-wasm";
import JSZip from "jszip";
import type { SparkConfig, PackageManifest, PrefabDefinition } from "@spark/builder/types";
import { ensureArray } from "@spark/builder/types";
import {
  readFile,
  readFileBinary,
  writeFileBinary,
  listDirectoryRecursive,
  fileExists,
} from "./workspace";

// ── Types ────────────────────────────────────────────────────
// SparkConfig and PackageManifest are imported from @spark/builder

export interface BuildOutput {
  success: boolean;
  output_path: string | null;
  stdout: string;
  stderr: string;
}

// ── Simple POSIX path helpers for the browser ────────────────

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "") || ".";
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i <= 0) return ".";
  return p.slice(0, i);
}

// ── Singleton esbuild initialisation ─────────────────────────
// The .wasm file is served as a static asset from the public/ directory.
// This avoids CDN dependency issues in bundled Tauri apps.
//
// NOTE: In Vite dev mode, HMR may reload this module, resetting
// esbuildReady to null, but esbuild-wasm's internal "already initialized"
// flag persists. We catch that specific error and treat it as success.

let esbuildReady: Promise<void> | null = null;

function ensureEsbuild(): Promise<void> {
  if (!esbuildReady) {
    try {
      esbuildReady = esbuild
        .initialize({ wasmURL: "/esbuild.wasm" })
        .catch((err: unknown) => {
          // Async rejection — handle gracefuly
          const msg = String(err);
          if (msg.includes("Cannot call 'initialize' more than once")) {
            return; // Already initialized, carry on
          }
          throw err;
        });
    } catch (err: unknown) {
      // Synchronous throw — esbuild.initialize() throws immediately
      // if called a second time (HMR module reload resets our flag but
      // esbuild's internal state persists).
      const msg = String(err);
      if (msg.includes("Cannot call 'initialize' more than once")) {
        esbuildReady = Promise.resolve();
      } else {
        throw err;
      }
    }
  }
  return esbuildReady;
}

// ── Helper: ensure a path is relative to projectPath ───────
// The onResolve handler may receive absolute resolveDir values.
// This normalises them back to a relative path that onLoad can
// reconstruct with join(projectPath, relativePath).

function relativise(fullPath: string, projectPath: string): string {
  const prefix = projectPath + "/";
  if (fullPath.startsWith(prefix)) {
    return fullPath.slice(prefix.length);
  }
  if (fullPath.startsWith("/")) {
    return fullPath.slice(1);
  }
  return fullPath;
}

// ── Config loader ────────────────────────────────────────────

async function loadConfig(projectPath: string): Promise<SparkConfig> {
  const raw = await readFile(join(projectPath, "spark.config.json"));
  const parsed = JSON.parse(raw);
  return {
    name: String(parsed.name ?? "Untitled"),
    version: String(parsed.version ?? "1.0.0"),
    entryScripts: ensureArray(parsed.entryScripts),
    scriptDirs:
      parsed.scriptDirs !== undefined
        ? ensureArray(parsed.scriptDirs)
        : ["scripts"],
    assetDirs: ensureArray(parsed.assetDirs),
    outputDir: ".built",
    prefabDir:
      typeof parsed.prefabDir === "string" ? parsed.prefabDir : "prefabs",
    audioBitrate:
      typeof parsed.audioBitrate === "number" ? parsed.audioBitrate : 128,
  };
}

// ── Esbuild plugin — resolves imports via Tauri file APIs ────

function createFileResolvePlugin(projectPath: string): esbuild.Plugin {
  return {
    name: "spark-fs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Entry point files — load from disk relative to project root
        if (args.kind === "entry-point") {
          return { path: args.path, namespace: "spark-fs" };
        }

        // All @spark/* imports are provided by the player — never bundle them
        if (args.path.startsWith("@spark/")) {
          return { external: true };
        }

        // Bare specifiers (e.g. "three", "lodash") — never bundle
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          return { external: true };
        }

        // Relative imports — resolve against the importer's directory
        // resolveDir may be empty for custom namespaces, so we fall back to
        // projectPath. It may also be an absolute path.
        const baseDir = args.resolveDir || projectPath;
        const resolved = join(baseDir, args.path);

        // Normalise to a path relative to projectPath.
        // This prevents path doubling when onLoad prepends projectPath.
        const relative = relativise(resolved, projectPath);

        // Try with and without extensions — fileExists check uses
        // the full absolute path because the candidate may start with /
        const candidates = [
          relative,
          relative + ".ts",
          relative + ".js",
          join(relative, "index.ts"),
          join(relative, "index.js"),
        ];

        for (const candidate of candidates) {
          if (
            (candidate.endsWith(".ts") || candidate.endsWith(".js")) &&
            (await fileExists(join(projectPath, candidate)))
          ) {
            return { path: candidate, namespace: "spark-fs" };
          }
        }

        // No match found — let esbuild try other resolution methods
        return { path: relative, namespace: "spark-fs" };
      });

      // Load file contents via Tauri readFile
      // Critical: set resolveDir so esbuild can resolve relative imports
      // within this file against the correct directory.
      build.onLoad(
        { filter: /.*/, namespace: "spark-fs" },
        async (args) => {
          const fullPath = join(projectPath, args.path);
          const content = await readFile(fullPath);
          const loader: esbuild.Loader = args.path.endsWith(".ts")
            ? "ts"
            : args.path.endsWith(".json")
              ? "json"
              : "js";
          return {
            contents: content,
            loader,
            // Tell esbuild the absolute directory of this file so
            // imports like `./Logger` resolve to scripts/Logger
            resolveDir: dirname(fullPath),
          };
        },
      );
    },
  };
}

// ── Base64 helpers ────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Main build function ──────────────────────────────────────

export async function buildInBrowser(
  projectPath: string,
  outputOverride?: string,
): Promise<BuildOutput> {
  const logs: string[] = [];
  const errors: string[] = [];

  const log = (msg: string) => logs.push(msg);
  const error = (msg: string) => {
    errors.push(msg);
    logs.push(`  \u2717 ${msg}`);
  };

  try {
    // 1. Load config
    log(`  Reading spark.config.json...`);
    const config = await loadConfig(projectPath);

    // 2. Ensure esbuild is initialised
    log(`  Initialising esbuild (WASM)...`);
    await ensureEsbuild();

    // 3. Collect all files from the project
    log(`  Scanning files...`);
    const allFiles = await listDirectoryRecursive(projectPath);

    // 4. Discover prefab definitions
    let prefabs: PrefabDefinition[] = [];
    if (config.prefabDir) {
      const prefabDirPrefix = join(projectPath, config.prefabDir);
      const prefabFiles = allFiles.filter(
        (f) => !f.is_dir && f.name.endsWith(".prefab.json") && f.path.startsWith(prefabDirPrefix),
      );
      if (prefabFiles.length > 0) {
        log(`  Loading ${prefabFiles.length} prefab(s)...`);
        for (const file of prefabFiles) {
          try {
            const raw = await readFile(file.path);
            const def: PrefabDefinition = JSON.parse(raw);
            if (!def.name || (!Array.isArray(def.parts) && !def.variants)) {
              log(`     ⚠ Skipping invalid prefab: ${file.name} (needs "parts" or "variants")`);
              continue;
            }
            if (def.variants) {
              let variantValid = true;
              for (const [vName, v] of Object.entries(def.variants)) {
                if (!Array.isArray(v.parts) && !v.states) {
                  log(`     ⚠ Skipping invalid prefab: ${file.name} (variant "${vName}" needs "parts" or "states")`);
                  variantValid = false;
                  break;
                }
              }
              if (!variantValid) continue;
            }
            prefabs.push(def);
            const partCount = def.parts?.length ?? Object.keys(def.variants!).length;
            const variantInfo = def.variants ? `, ${Object.keys(def.variants).length} variant(s)` : "";
            const stateInfo = def.variants
              ? (() => {
                  const total = Object.values(def.variants).reduce((sum, v) => sum + (v.states ? Object.keys(v.states).length : 0), 0);
                  return total > 0 ? `, ${total} state(s)` : "";
                })()
              : "";
            log(`     ◆ ${def.name} (${partCount} part${partCount > 1 ? "s" : ""}${variantInfo}${stateInfo})`);
          } catch {
            log(`     ⚠ Failed to parse prefab: ${file.name}`);
          }
        }
      }
    }

    // 5. Collect all .ts files from script directories
    log(`  Scanning scripts...`);
    const scriptDirs = config.scriptDirs ?? ["scripts"];
    const allTsFiles: string[] = [];

    for (const file of allFiles) {
      if (!file.is_dir && file.name.endsWith(".ts")) {
        const relPath = file.path
          .slice(projectPath.length)
          .replace(/^\//, "");
        const belongs = scriptDirs.some(
          (dir) =>
            relPath.startsWith(dir + "/") || relPath === dir,
        );
        if (belongs) {
          allTsFiles.push(relPath);
        }
      }
    }

    // 6. Compile all scripts with esbuild
    let compiledScripts: Array<{
      entry: string;
      code: string;
      outputPath: string;
    }>;
    if (allTsFiles.length > 0) {
      log(`  Compiling ${allTsFiles.length} script(s)...`);

      const result = await esbuild.build({
        entryPoints: allTsFiles,
        bundle: true,
        external: ["@spark/runtime"],
        format: "esm",
        platform: "browser",
        target: "es2022",
        outdir: ".",
        write: false,
        sourcemap: false,
        minify: true,
        treeShaking: false,
        metafile: true,
        plugins: [createFileResolvePlugin(projectPath)],
      });

      // Surface any build errors
      if (result.errors && result.errors.length > 0) {
        for (const msg of result.errors) {
          error(msg.text);
        }
        compiledScripts = [];
      } else if (
        !result.outputFiles ||
        result.outputFiles.length === 0
      ) {
        error("esbuild produced no output files");
        compiledScripts = [];
      } else {
        // Map each entry point to its compiled output via metafile
        const metafile = result.metafile!;
        compiledScripts = [];

        for (const entry of allTsFiles) {
          const outputKey = Object.keys(metafile.outputs).find(
            (key) => {
              const inputs = metafile.outputs[key].inputs;
              return Object.keys(inputs).some((inputKey) =>
                inputKey.endsWith(entry),
              );
            },
          );

          if (!outputKey) {
            log(`     \u26a0 No metafile output for "${entry}"`);
            continue;
          }

          const outputFile = result.outputFiles.find((f) =>
            f.path.endsWith(outputKey),
          );
          if (!outputFile || !outputFile.text) {
            log(
              `     \u26a0 Output file missing for "${entry}" (key: ${outputKey})`,
            );
            continue;
          }

          const outputPath = entry.replace(/\.ts$/, ".js");
          compiledScripts.push({
            entry,
            code: outputFile.text,
            outputPath,
          });
        }

        // Log results
        for (const s of compiledScripts) {
          const isEntry = config.entryScripts.some((e) =>
            s.entry.endsWith(e),
          );
          log(
            `     ${isEntry ? "\u25b6" : " "} ${s.entry} \u2192 ${s.outputPath} (${s.code.length} bytes)`,
          );
        }
      }
    } else {
      log(`     (no scripts to compile)`);
      compiledScripts = [];
    }

    // 7. Create ZIP package — scripts + assets + manifest
    log(
      `  Packaging assets from ${config.assetDirs.length} director(ies)...`,
    );
    const zip = new JSZip();

    for (const script of compiledScripts) {
      zip.file(script.outputPath, script.code);
    }

    const allAssets: string[] = [];

    for (const assetDir of config.assetDirs) {
      const dirPrefix = join(projectPath, assetDir);
      for (const file of allFiles) {
        if (!file.is_dir && file.path.startsWith(dirPrefix)) {
          const relPath = file.path
            .slice(projectPath.length)
            .replace(/^\//, "");
          const b64 = await readFileBinary(file.path);
          zip.file(relPath, base64ToUint8Array(b64));
          allAssets.push(relPath);
        }
      }
    }

    // 8. Add prefab definitions as bundled JSON
    if (prefabs.length > 0) {
      const prefabDirPath = config.prefabDir ?? "prefabs";
      for (const def of prefabs) {
        const prefabPath = `${prefabDirPath}/${def.name}.prefab.json`;
        zip.file(prefabPath, JSON.stringify(def));
      }
    }

    // 9. Generate manifest
    const entryPaths = config.entryScripts.map((s) =>
      s.replace(/\.ts$/, ".js"),
    );
    const manifest: PackageManifest = {
      sparkVersion: "0.1.0",
      name: config.name,
      version: config.version,
      entryScripts: entryPaths,
      assets: allAssets,
      prefabs: prefabs.length > 0 ? prefabs : undefined,
      createdAt: new Date().toISOString(),
    };
    zip.file("manifest.json", JSON.stringify(manifest));

    // 10. Write .sprk output
    const outputDir =
      outputOverride ?? join(projectPath, "..", ".built");
    const outputPath = join(outputDir, `${config.name}.sprk`);

    const buffer = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await writeFileBinary(outputPath, uint8ArrayToBase64(buffer));

    const sizeKB = (buffer.length / 1024).toFixed(1);
    const sizeMBNum = buffer.length / (1024 * 1024);
    log(`\n  \u2713 Built ${config.name}.sprk (${sizeKB} KB)`);

    // Size breakdown
    const scriptBytes = compiledScripts.reduce((sum, s) => sum + s.code.length, 0);
    log(`  ── Size breakdown:`);
    log(`     Scripts : ${(scriptBytes / 1024).toFixed(1)} KB (${compiledScripts.length} files)`);
    log(`     Assets  : ${allAssets.length} files`);
    log(`     Total   : ${sizeMBNum.toFixed(2)} MB (${sizeKB} KB)`);
    if (sizeMBNum > 5) {
      log(`     ⚠  Large .sprk — check for big audio/images or uncompressed assets`);
    }

    return {
      success: true,
      output_path: outputPath,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } catch (err) {
    error(String(err instanceof Error ? err.message : err));
    return {
      success: false,
      output_path: null,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  }
}
