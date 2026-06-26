#!/usr/bin/env node
import { build } from "./build.js";
import { watch } from "./watch.js";

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

function printUsage() {
  console.log(`
  Spark Builder v0.1.0

  Usage:
    spark build [config-path]    Build a .sprk package
    spark watch [config-path]    Watch files and rebuild on change
    spark --help                 Show this help message
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
        console.log(`\n  Usage: spark build [config-path]\n`);
        console.log(`  Builds a .sprk package from the current project.\n`);
        console.log(`  If config-path is omitted, looks for spark.config.json in the current directory.\n`);
        return;
      }
      let configPath: string | undefined;
      let outputDir: string | undefined;
      for (let i = 0; i < restArgs.length; i++) {
        if (restArgs[i] === "--output-dir") {
          outputDir = restArgs[++i];
        } else if (!isHelp(restArgs[i])) {
          configPath = restArgs[i];
        }
      }
      await build(configPath, outputDir);
      break;

    case "watch":
      if (isHelp(restArgs[0])) {
        console.log(`\n  Usage: spark watch [config-path]\n`);
        console.log(`  Watches project files and rebuilds on change.\n`);
        return;
      }
      await watch(restArgs[0]);
      break;

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
