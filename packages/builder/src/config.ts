import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SparkConfig } from "./types.js";

export function loadConfig(configPath?: string): SparkConfig {
  const resolvedPath = configPath
    ? resolve(process.cwd(), configPath)
    : resolve(process.cwd(), "spark.config.json");

  if (!existsSync(resolvedPath)) {
    console.error(`Error: spark.config.json not found at ${resolvedPath}`);
    process.exit(1);
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Error: spark.config.json is not valid JSON");
    process.exit(1);
  }

  const config: SparkConfig = {
    name: String(parsed.name ?? "Untitled"),
    version: String(parsed.version ?? "1.0.0"),
    entryScripts: ensureArray(parsed.entryScripts),
    scriptDirs: parsed.scriptDirs !== undefined ? ensureArray(parsed.scriptDirs) : ["scripts"],
    assetDirs: ensureArray(parsed.assetDirs),
    outputDir: ".built",
  };

  if (config.entryScripts.length === 0) {
    console.log("  Note: No entryScripts defined — package will contain assets/scripts for import only");
  }

  return config;
}

function ensureArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}
