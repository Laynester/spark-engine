import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SparkConfig } from "./types.js";
import { ensureArray } from "./types.js";

export function loadConfig(configPath?: string): SparkConfig {
  const resolvedPath = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(process.cwd(), "spark.config.json");

  if (!existsSync(resolvedPath)) {
    throw new Error(`spark.config.json not found at ${resolvedPath}`);
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("spark.config.json is not valid JSON");
  }

  const config: SparkConfig = {
    name: String(parsed.name ?? "Untitled"),
    version: String(parsed.version ?? "1.0.0"),
    entryScripts: ensureArray(parsed.entryScripts),
    scriptDirs: parsed.scriptDirs !== undefined ? ensureArray(parsed.scriptDirs) : ["scripts"],
    assetDirs: ensureArray(parsed.assetDirs),
    prefabDir: typeof parsed.prefabDir === "string" ? parsed.prefabDir : "prefabs",
    outputDir: ".built",
    audioBitrate: typeof parsed.audioBitrate === "number" ? parsed.audioBitrate : 128,
  };

  if (config.entryScripts.length === 0) {
    console.log("  Note: No entryScripts defined — package will contain assets/scripts for import only");
  }

  return config;
}
