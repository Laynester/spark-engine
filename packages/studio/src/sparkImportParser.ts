import { readFile, listDirectory, fileExists } from "./workspace";

// ── Types ───────────────────────────────────────────────

export interface SparkImportInfo {
  qualified: string;  // "library:scripts/Manager.js"
  namespace: string;  // "library"
  scriptPath: string; // "scripts/Manager.js"
}

export interface LibraryScript {
  namespace: string;
  /** Label shown in autocomplete e.g. "library:scripts/Manager.js" */
  qualified: string;
  /** The .ts source path on disk (absolute) */
  diskPath: string;
}

export interface LibraryProject {
  name: string;
  dir: string;
  scripts: LibraryScript[];
}

// ── Parse spark.import("...") calls from source ────────

/**
 * Extract all spark.import("...") calls from a source string.
 */
export function parseSparkImports(content: string): SparkImportInfo[] {
  const imports: SparkImportInfo[] = [];
  // Matches: spark.import("...") or spark.import('...')
  const regex = /spark\.import\(\s*["']([^"']+)["']\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const qualified = match[1];
    const colonIdx = qualified.indexOf(":");
    if (colonIdx !== -1) {
      imports.push({
        qualified,
        namespace: qualified.slice(0, colonIdx),
        scriptPath: qualified.slice(colonIdx + 1),
      });
    }
  }

  return imports;
}

// ── Discover library projects from workspace ────────────

/**
 * Scan a workspace root to discover library projects and their scripts.
 *
 * @param workspacePath  Absolute path to the workspace root.
 * @param projectNames   List of project directory names (as returned by findProjects).
 */
export async function discoverLibraryScripts(
  workspacePath: string,
  projectNames: string[]
): Promise<LibraryProject[]> {
  const results: LibraryProject[] = [];

  for (const projectName of projectNames) {
    const projectDir = `${workspacePath}/${projectName}`;
    const configPath = `${projectDir}/spark.config.json`;

    try {
      const configExists = await fileExists(configPath);
      if (!configExists) continue;

      const raw = await readFile(configPath);
      let config: Record<string, unknown>;
      try {
        config = JSON.parse(raw);
      } catch {
        continue;
      }

      const namespace = String(config.name ?? projectName);
      const scriptDirs: string[] = Array.isArray(config.scriptDirs)
        ? (config.scriptDirs as string[]).map(String)
        : ["scripts"];

      const scripts: LibraryScript[] = [];

      for (const dir of scriptDirs) {
        try {
          const contents = await listDirectory(`${projectDir}/${dir}`);
          for (const entry of contents.entries) {
            if (entry.is_dir) continue;
            // Only scan .ts files; skip .js in source dirs (they're compiled output)
            if (!entry.name.endsWith(".ts")) continue;
            // Build qualified path with .js extension (matching runtime spark.import() convention)
            const scriptRelativeJS = `${dir}/${entry.name.replace(/\.ts$/, ".js")}`;
            scripts.push({
              namespace,
              qualified: `${namespace}:${scriptRelativeJS}`,
              diskPath: entry.path,
            });
          }
        } catch {
          // skip directories that don't exist
        }
      }

      if (scripts.length > 0) {
        results.push({ name: namespace, dir: projectDir, scripts });
      }
    } catch {
      // skip projects that can't be read
    }
  }

  return results;
}

// ── Resolve a qualified import to disk path ─────────────

/**
 * Resolve a spark.import qualified name to a source file on disk.
 */
export function resolveSparkImport(
  importInfo: SparkImportInfo,
  libraryProjects: LibraryProject[]
): LibraryScript | null {
  for (const project of libraryProjects) {
    if (project.name !== importInfo.namespace) continue;
    for (const script of project.scripts) {
      if (script.qualified === importInfo.qualified) {
        return script;
      }
    }
  }
  return null;
}

// ── Monaco completion detail builder ────────────────────

export function buildCompletionDetail(script: LibraryScript): string {
  return `${script.namespace} library — ${script.diskPath.split("/").slice(-2).join("/")}`;
}
