import { resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { build } from "./build.js";
import type { SparkConfig, WorkspaceManifest } from "./types.js";

// ── Local types ────────────────────────────────────────────────────

export interface WorkspaceBuildResult {
  project: string;
  outputPath: string;
  success: boolean;
  error?: string;
}

// ── Workspace loading ──────────────────────────────────────────────

/**
 * Load a workspace manifest from the given directory.
 * Looks for `spark-workspace.json` in that directory.
 * If not found, returns null (single-project mode).
 *
 * Projects are auto-discovered by scanning subdirectories for
 * `spark.config.json` — no need to list them in the manifest.
 */
export function loadWorkspace(dir?: string): WorkspaceManifest | null {
  const workspaceDir = dir ? resolve(process.cwd(), dir) : process.cwd();
  const manifestPath = join(workspaceDir, "spark-workspace.json");

  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, "utf-8");
  const parsed: Record<string, unknown> = JSON.parse(raw);

  return {
    spark_version: String(parsed.spark_version ?? "0.1.0"),
    name: String(parsed.name ?? "Untitled Workspace"),
    entry_project: parsed.entry_project ? String(parsed.entry_project) : null,
    last_opened: parsed.last_opened ? String(parsed.last_opened) : null,
    width: typeof parsed.width === "number" ? parsed.width : undefined,
    height: typeof parsed.height === "number" ? parsed.height : undefined,
  };
}

/**
 * Scan a directory for project folders (those containing spark.config.json).
 * Returns project folder names relative to the given directory.
 */
export async function findProjects(dir?: string): Promise<string[]> {
  const workspaceDir = dir ? resolve(process.cwd(), dir) : process.cwd();

  if (!existsSync(workspaceDir)) return [];

  const entries = await readdir(workspaceDir, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = join(workspaceDir, entry.name, "spark.config.json");
    if (existsSync(configPath)) {
      projects.push(entry.name);
    }
  }

  return projects.sort();
}

/**
 * Build all projects in the workspace, outputting .sprk files to
 * `<workspace_root>/dist/`. Returns build results for each project.
 *
 * If no workspace manifest exists, falls back to building the single
 * project at the current directory (traditional mode).
 */
export async function buildWorkspace(
  workspaceDir?: string,
  outputDir?: string,
): Promise<WorkspaceBuildResult[]> {
  const wDir = workspaceDir ? resolve(process.cwd(), workspaceDir) : process.cwd();
  const distDir = outputDir ? resolve(process.cwd(), outputDir) : join(wDir, "dist");
  const manifest = loadWorkspace(wDir);

  const results: WorkspaceBuildResult[] = [];

  if (manifest) {
    // ── Workspace mode — auto-discover and build all projects ───
    console.log(`\n  Building workspace: ${manifest.name}\n`);

    const discovered = await findProjects(wDir);

    if (discovered.length === 0) {
      console.log("  (no projects found in workspace)");
      return [];
    }

    for (const name of discovered) {
      const projectPath = resolve(wDir, name);
      const configPath = join(projectPath, "spark.config.json");

      try {
        const result = await build(configPath, distDir);
        results.push({
          project: name,
          outputPath: result.outputPath,
          success: true,
        });
      } catch (err) {
        console.error(`  ✗ Failed to build project "${name}":`, (err as Error).message);
        results.push({
          project: name,
          outputPath: "",
          success: false,
          error: (err as Error).message,
        });
      }
    }

    // Summary
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    console.log(`\n  ── Build summary ──────────────────────────────`);
    console.log(`     ${succeeded} project(s) built, ${failed} failed`);
    if (failed > 0) {
      for (const r of results) {
        if (!r.success) console.log(`     ✗ ${r.project}: ${r.error}`);
      }
    }
    console.log(`  ────────────────────────────────────────────────\n`);

    return results;
  }

  // ── Single-project mode ──────────────────────────────────────
  console.log(`  (no workspace manifest found — building single project)\n`);
  try {
    const result = await build(undefined, distDir);
    const projectName = result.outputPath.split("/").pop()?.replace(".sprk", "") ?? "project";
    results.push({
      project: projectName,
      outputPath: result.outputPath,
      success: true,
    });
  } catch (err) {
    results.push({
      project: "unknown",
      outputPath: "",
      success: false,
      error: (err as Error).message,
    });
  }

  return results;
}
