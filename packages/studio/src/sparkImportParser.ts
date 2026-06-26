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

// ── Generate declare class declarations from source ─────

/**
 * Given a TypeScript source string, returns an array of `declare class`
 * declaration strings with method signatures extracted.
 *
 * Skips private/protected members and constructors.
 * Handles `export class X` and `export default class X`.
 * Handles params with nested parens like `(cb: () => void)`.
 */
export function generateClassDeclarations(source: string): string[] {
  const declarations: string[] = [];

  // Find each exported class
  const classRegex = /export(?:\s+default)?\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
  let classMatch: RegExpExecArray | null;

  while ((classMatch = classRegex.exec(source)) !== null) {
    const className = classMatch[1];
    const extendsClass = classMatch[2];

    // Find the opening brace of the class body
    const bodyStart = source.indexOf("{", classMatch.index + classMatch[0].length);
    if (bodyStart === -1) continue;

    // Extract class body by counting braces
    let depth = 1;
    let lineStart = bodyStart + 1;
    const bodyLines: string[] = [];

    for (let i = bodyStart + 1; i < source.length && depth > 0; i++) {
      if (source[i] === "{") {
        depth++;
      } else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          bodyLines.push(source.slice(lineStart, i));
        }
      } else if (source[i] === "\n") {
        bodyLines.push(source.slice(lineStart, i));
        lineStart = i + 1;
      }
    }

    const body = bodyLines.join("\n");
    const methods: string[] = [];

    // Match method signatures: skips private/protected and constructor
    // Params can have one level of nested parens for functions like `() => void`
    const methodRegex = /^\s*(?:(?:private\s+|protected\s+)?(?:static\s+)?(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?::\s*([^{]+?))?\s*\{)/gm;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodRegex.exec(body)) !== null) {
      const fullMatch = methodMatch[0];
      const methodName = methodMatch[1];
      const params = methodMatch[2];
      const returnType = methodMatch[3] ? methodMatch[3].trim() : "void";

      // Skip private/protected and constructor
      if (/^\s*(private|protected)\s/.test(fullMatch)) continue;
      if (methodName === "constructor") continue;

      const isStatic = /\bstatic\s/.test(fullMatch);
      methods.push(`  ${isStatic ? "static " : ""}${methodName}(${params}): ${returnType};`);
    }

    const extendsClause = extendsClass ? ` extends ${extendsClass}` : "";
    if (methods.length > 0) {
      declarations.push(
        `declare class ${className}${extendsClause} {\n${methods.join("\n")}\n}`
      );
    } else {
      // Fallback: still register empty class so <ClassName> is a valid type
      declarations.push(`declare class ${className}${extendsClause} { }`);
    }
  }

  return declarations;
}

// ── Monaco completion detail builder ────────────────────

export function buildCompletionDetail(script: LibraryScript): string {
  return `${script.namespace} library — ${script.diskPath.split("/").slice(-2).join("/")}`;
}
