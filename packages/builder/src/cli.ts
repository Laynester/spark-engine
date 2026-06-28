#!/usr/bin/env node
import { build } from "./build.js";
import { watch } from "./watch.js";
import { preview } from "./preview.js";
import { buildWorkspace } from "./workspace.js";
import { createGame, createProject } from "./init.js";

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

function printUsage() {
  console.log(`
  Spark Builder v0.2.0

  Usage:
    spark new game [dir]             Create a game workspace with tsconfig + manifest
    spark new project <name>         Create a new project with scripts/prefabs/assets
    spark build [config-path]        Build a .sprk package
    spark build --workspace [...]    Build all projects in the workspace
    spark watch [config-path]        Watch files and rebuild on change
    spark preview [--watch]          Build workspace + open browser preview
    spark --help                     Show this help message
  `);
}

function isHelp(arg?: string): boolean {
  return arg === "--help" || arg === "-h";
}

async function main() {
  if (command === undefined || isHelp(command)) {
    printUsage();
    return;
  }

  switch (command) {
    case "build":
      if (isHelp(restArgs[0])) {
        console.log(`\n  Usage: spark build [config-path] [--output-dir <dir>] [--workspace]\n`);
        console.log(`  Builds a .sprk package from the current project.\n`);
        console.log(`  If config-path is omitted, looks for spark.config.json in the current directory.\n`);
        console.log(`  With --workspace, builds all projects in the workspace to ./dist/.\n`);
        return;
      }
      let configPath: string | undefined;
      let outputDir: string | undefined;
      let isWorkspaceBuild = false;
      for (let i = 0; i < restArgs.length; i++) {
        if (restArgs[i] === "--output-dir") {
          outputDir = restArgs[++i];
        } else if (restArgs[i] === "--workspace" || restArgs[i] === "-w") {
          isWorkspaceBuild = true;
        } else if (!isHelp(restArgs[i])) {
          configPath = restArgs[i];
        }
      }
      if (isWorkspaceBuild) {
        await buildWorkspace(configPath, outputDir);
      } else {
        await build(configPath, outputDir);
      }
      break;

    case "watch":
      if (isHelp(restArgs[0])) {
        console.log(`\n  Usage: spark watch [config-path]\n`);
        console.log(`  Watches project files and rebuilds on change.\n`);
        return;
      }
      await watch(restArgs[0]);
      break;

    case "preview":
      if (isHelp(restArgs[0])) {
        console.log(`\n  Usage: spark preview [--watch]\n`);
        console.log(`  Builds the workspace (or single project) and opens a browser preview.\n`);
        console.log(`  With --watch, watches files and hot-reloads the preview on changes.\n`);
        return;
      }
      let shouldWatch = false;
      for (let i = 0; i < restArgs.length; i++) {
        if (restArgs[i] === "--watch" || restArgs[i] === "-w") {
          shouldWatch = true;
        }
      }
      await preview(undefined, shouldWatch);
      break;

    case "new": {
      const subcommand = restArgs[0];
      const subArgs = restArgs.slice(1);

      if (subcommand === "game") {
        const dir = subArgs[0] || ".";
        let name: string | undefined;
        for (let i = 1; i < subArgs.length; i++) {
          if (subArgs[i] === "--name" || subArgs[i] === "-n") {
            name = subArgs[++i];
          }
        }
        createGame(dir, { name });
      } else if (subcommand === "project") {
        const projectName = subArgs[0];
        if (!projectName || isHelp(projectName) || projectName.startsWith("-")) {
          console.log(`\n  Usage: spark new project <name> [--name <display-name>]\n`);
          console.log(`  Creates a new project directory with scripts/, prefabs/, and assets/.\n`);
          process.exit(projectName && !isHelp(projectName) ? 1 : 0);
        }
        let displayName: string | undefined;
        for (let i = 1; i < subArgs.length; i++) {
          if (subArgs[i] === "--name" || subArgs[i] === "-n") {
            displayName = subArgs[++i];
          }
        }
        createProject(projectName, { name: displayName });
      } else {
        console.log(`\n  Usage: spark new <game|project> [options]\n`);
        console.log(`  Commands:`);
        console.log(`    spark new game [dir]          Create a game workspace`);
        console.log(`    spark new project <name>      Create a new project`);
        console.log(`\n  Options:`);
        console.log(`    --name, -n <name>            Display name for the game/project\n`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
