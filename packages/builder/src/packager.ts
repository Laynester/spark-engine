import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { spawn } from "node:child_process";
import JSZip from "jszip";
import { writeFileSync, mkdirSync } from "node:fs";
import type { SparkConfig, PackageManifest, PrefabDefinition } from "./types.js";
import type { CompiledScript } from "./compiler.js";

const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".wma"]);

/** ffmpeg format flag for each extension (required for pipe output). */
const FMT_MAP: Record<string, string> = {
  ".mp3": "mp3",
  ".ogg": "ogg",
  ".m4a": "ipod",
  ".aac": "adts",
  ".wma": "asf",
  ".wav": "mp3",
  ".flac": "mp3",
};

export interface PackageResult {
  outputPath: string;
  manifest: PackageManifest;
  size: number;
  /** Total bytes saved by audio optimization */
  audioBytesSaved: number;
  /** Number of audio files optimized */
  audioFilesOptimized: number;
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

/**
 * Optimize an audio file with ffmpeg via stdin/stdout piping.
 * Returns the compressed buffer. Falls back to the original on failure.
 */
function optimizeAudio(
  filePath: string,
  bitrate: number,
): Promise<{ buffer: Buffer; originalSize: number; optimizedSize: number; ext: string }> {
  return new Promise((resolve) => {
    const original = readFileSync(filePath);
    const originalSize = original.length;

    // Don't bother optimizing tiny files
    if (originalSize < 2048) {
      resolve({ buffer: original, originalSize, optimizedSize: originalSize, ext: extname(filePath) });
      return;
    }

    const ext = extname(filePath).toLowerCase();

    // Determine output format — WAV/FLAC → MP3, others keep original container
    const outFmt = FMT_MAP[ext] ?? ext.slice(1);

    const args = [
      "-i", "pipe:0",
      "-b:a", `${bitrate}k`,
      "-map_metadata", "-1",
      "-f", outFmt,
      "pipe:1",
    ];

    const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", () => {
      resolve({ buffer: original, originalSize, optimizedSize: originalSize, ext });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ buffer: original, originalSize, optimizedSize: originalSize, ext });
        return;
      }
      const optimized = Buffer.concat(chunks);
      // Only use the optimized version if it's actually smaller
      if (optimized.length > 0 && optimized.length < originalSize) {
        resolve({ buffer: optimized, originalSize, optimizedSize: optimized.length, ext: `.${outFmt}` });
      } else {
        resolve({ buffer: original, originalSize, optimizedSize: originalSize, ext });
      }
    });

    child.stdin.write(original);
    child.stdin.end();
  });
}

export async function createPackage(
  config: SparkConfig,
  projectDir: string,
  compiledScripts: CompiledScript[],
  entryPaths: string[] = [],
  outputOverride?: string,
  prefabs: PrefabDefinition[] = [],
): Promise<PackageResult> {
  const zip = new JSZip();

  // 1. Add all compiled scripts (entries + shared chunks)
  for (const script of compiledScripts) {
    zip.file(script.outputPath, script.code);
  }

  // 2. Copy assets with audio optimization
  const allAssets: string[] = [];
  const audioBitrate = config.audioBitrate ?? 128;

  interface AudioResult {
    outputPath: string;
    saved: number;
  }
  const audioResults: AudioResult[] = [];

  // Collect all asset files first, then optimize audio in parallel
  const audioTasks: Promise<AudioResult | null>[] = [];

  for (const assetDir of config.assetDirs) {
    const dirPath = join(projectDir, assetDir);
    const files = await collectFiles(dirPath);

    for (const filePath of files) {
      const originalRelativePath = relative(projectDir, filePath);
      const ext = extname(filePath).toLowerCase();

      if (AUDIO_EXTS.has(ext) && audioBitrate > 0) {
        audioTasks.push(
          optimizeAudio(filePath, audioBitrate).then((result) => {
            const outputPath = result.ext !== ext
              ? originalRelativePath.replace(new RegExp(ext.replace(/\./g, "\\.") + "$"), result.ext)
              : originalRelativePath;
            zip.file(outputPath, result.buffer);
            allAssets.push(outputPath);
            const saved = result.originalSize - result.optimizedSize;
            if (saved > 0) {
              console.log(
                `     🎵 ${originalRelativePath}: ${(result.originalSize / 1024).toFixed(0)} KB → ${(result.optimizedSize / 1024).toFixed(0)} KB (${((saved / result.originalSize) * 100).toFixed(0)}% saved)`,
              );
            }
            return { outputPath, saved };
          }),
        );
      } else {
        const content = readFileSync(filePath);
        zip.file(originalRelativePath, content);
        allAssets.push(originalRelativePath);
      }
    }
  }

  // Wait for all audio optimizations, then aggregate results
  const results = (await Promise.all(audioTasks)).filter((r): r is AudioResult => r !== null);
  const audioBytesSaved = results.reduce((sum, r) => sum + r.saved, 0);
  const audioFilesOptimized = results.filter((r) => r.saved > 0).length;

  // 3. Add prefab definitions as bundled JSON
  if (prefabs.length > 0) {
    const prefabDir = config.prefabDir ?? "prefabs";
    for (const def of prefabs) {
      const prefabPath = `${prefabDir}/${def.name}.prefab.json`;
      zip.file(prefabPath, JSON.stringify(def));
    }
  }

  // 4. Generate manifest
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

  // 5. Generate ZIP and write to disk
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  const outputDir = outputOverride ?? join(projectDir, config.outputDir!);
  const outputPath = join(outputDir, `${config.name}.sprk`);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputPath, buffer);

  return {
    outputPath,
    manifest,
    size: buffer.length,
    audioBytesSaved,
    audioFilesOptimized,
  };
}
