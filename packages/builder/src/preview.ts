import { createServer } from "vite";
import type { InlineConfig } from "vite";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, createReadStream, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildWorkspace, loadWorkspace, findProjects } from "./workspace.js";
import { loadConfig } from "./config.js";
import type { SparkConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYER_DIR = resolve(__dirname, "../../player");

// Build heartbeat — incremented on every rebuild so the player can detect
// changes regardless of which project was rebuilt.
let _buildCount = 0;

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
      : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true });
}

/**
 * Build the workspace (or single project) and start a preview server that serves:
 *   - The Spark Player (Vite dev server from `packages/player`)
 *   - All built `.sprk` files from `./dist/`
 *
 * Opens the browser to `http://localhost:PORT/?sprk=/Name.sprk` (entry project).
 * If `shouldWatch` is true, also watches for file changes and rebuilds.
 */
export async function preview(
  _configPath?: string,
  shouldWatch?: boolean,
): Promise<void> {
  const projectDir = process.cwd();

  // Determine if we're in a workspace or single-project mode
  const workspaceManifest = loadWorkspace(projectDir);
  const distDir = resolve(projectDir, "dist");

  // ── 1. Initial build ──────────────────────────────────────────────
  if (workspaceManifest) {
    console.log(`  Workspace: ${workspaceManifest.name}`);
  }
  await buildWorkspace(projectDir);

  // Determine the entry .sprk file to pass to the player
  let entrySprkFilename: string | null = null;
  if (workspaceManifest?.entry_project) {
    // Workspace with explicit entry — find that project's config and get its name
    const entryPath = resolve(projectDir, workspaceManifest.entry_project, "spark.config.json");
    if (existsSync(entryPath)) {
      const cfg = loadConfig(entryPath);
      entrySprkFilename = `${cfg.name}.sprk`;
    }
  }
  if (!entrySprkFilename) {
    // Fallback: use the first .sprk file found in dist/
    const files = existsSync(distDir)
      ? readdirSync(distDir).filter((f) => f.endsWith(".sprk"))
      : [];
    entrySprkFilename = files[0] ?? null;
  }

  // ── 2. Start Vite dev server for the player ──────────────────────
  const viteConfig: InlineConfig = {
    root: PLAYER_DIR,
    logLevel: "warn",
    server: {
      port: 3000,
      open: false,
      fs: {
        allow: [PLAYER_DIR, distDir],
      },
    },
    plugins: [
      {
        name: "spark-sprk-server",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url ?? "";

            // ── Build heartbeat endpoint ──
            if (url === "/__spark_build") {
              const body = JSON.stringify({ build: _buildCount });
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*",
              });
              res.end(body);
              return;
            }

            // ── .sprk file serving ──
            if (!url.endsWith(".sprk")) return next();

            const filename = url.startsWith("/") ? url.slice(1) : url;
            const filePath = resolve(distDir, filename);

            if (!existsSync(filePath)) return next();

            const stats = statSync(filePath);

            if (req.method === "HEAD") {
              res.writeHead(200, {
                "Content-Type": "application/octet-stream",
                "Last-Modified": stats.mtime.toUTCString(),
                ETag: `"${stats.size}-${stats.mtimeMs}"`,
              });
              res.end();
              return;
            }

            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-cache",
              "Last-Modified": stats.mtime.toUTCString(),
              ETag: `"${stats.size}-${stats.mtimeMs}"`,
            });
            createReadStream(filePath).pipe(res);
          });
        },
      },
    ],
  };

  const server = await createServer(viteConfig);
  await server.listen();

  const localUrl = server.resolvedUrls?.local?.[0];
  if (!localUrl) {
    console.error("  ✗ Could not determine preview URL");
    await server.close();
    process.exit(1);
  }

  if (!entrySprkFilename) {
    console.error("  ✗ No .sprk files found in dist/");
    await server.close();
    process.exit(1);
  }

  const previewUrl = `${localUrl}?sprk=/${entrySprkFilename}&width=${workspaceManifest?.width}&height=${workspaceManifest?.height}`;

  console.log(`\n  ── Preview ────────────────────────────────────`);
  console.log(`     ${previewUrl}`);
  if (workspaceManifest) {
    console.log(`     Workspace: ${workspaceManifest.name}`);
  }
  console.log(`     Entry: ${entrySprkFilename}`);
  console.log(`  ────────────────────────────────────────────────\n`);

  openBrowser(previewUrl);

  // ── 3. Watch mode ────────────────────────────────────────────────
  let closeWatcher: (() => void) | null = null;

  if (shouldWatch) {
    console.log("  Watching for changes... Press Ctrl+C to stop.\n");

    const { watch } = await import("chokidar");

    // Watch the entire workspace directory recursively — simpler and more
    // reliable than maintaining per-project patterns, and projects are small.
    console.log(`  Watching: ${projectDir}`);

    const watcher = watch(projectDir, {
      ignoreInitial: true,
      persistent: true,
      ignored: /(^|[/\\])node_modules[/\\]|\.git[/\\]|\.sprk$/,  // skip noise
    });

    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    const debounceMs = 100;

    const doRebuild = async (filePath: string) => {
      const relativePath = filePath.replace(projectDir + "/", "");
      console.log(`\n  Change detected: ${relativePath}`);
      console.log(`  Rebuilding...`);

      try {
        await buildWorkspace(projectDir);
        _buildCount++;
        console.log(`  Rebuild complete. (build #${_buildCount})\n`);
      } catch (err) {
        _buildCount++;
        console.error(`  ✗ Build failed:`, (err as Error).message);
      }
    };

    watcher.on("change", (filePath) => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => doRebuild(filePath), debounceMs);
    });

    watcher.on("add", (filePath) => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => doRebuild(filePath), debounceMs);
    });

    closeWatcher = () => {
      watcher.close();
    };
  }

  // ── 4. Wait for Ctrl+C ──────────────────────────────────────────
  const cleanup = () => {
    console.log("\n  Shutting down...");
    if (closeWatcher) closeWatcher();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep alive
  await new Promise(() => { });
}
