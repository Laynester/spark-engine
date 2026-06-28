import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── spark new game ──────────────────────────────────────────────────

export interface CreateGameOptions {
  name?: string;
  width?: number;
  height?: number;
}

export function createGame(dir: string, options: CreateGameOptions = {}): void {
  const projectDir = resolve(process.cwd(), dir);
  const name = options.name ?? "My Game";

  if (existsSync(projectDir) && readdirSync(projectDir).length > 0) {
    console.log(`  ✗ Directory "${dir}" already exists and is not empty.`);
    process.exit(1);
  }

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  // ── spark-workspace.json ──────────────────────────────────────────
  const workspaceManifest = {
    spark_version: "0.1.0",
    name,
    entry_project: null,
    width: options.width ?? 800,
    height: options.height ?? 600,
  };
  writeFileSync(
    join(projectDir, "spark-workspace.json"),
    JSON.stringify(workspaceManifest, null, 2) + "\n",
  );

  // ── tsconfig.json (permissive, for VSCode intellisense) ───────────
  const tsconfig = {
    compilerOptions: {
      "moduleResolution": "bundler",
    },
    "paths": {
      "@spark/runtime": ["../spark/packages/runtime/src"]
    }
  };
  writeFileSync(
    join(projectDir, "tsconfig.json"),
    JSON.stringify(tsconfig, null, 2) + "\n",
  );

  console.log(`\n  ✓ Created game workspace: ${name}`);
  console.log(`    ${join(projectDir, "spark-workspace.json")}`);
  console.log(`    ${join(projectDir, "tsconfig.json")}`);
  console.log(`\n  Next steps:`);
  console.log(`    cd ${dir}`);
  console.log(`    spark new project <project-name>   # add a project`);
  console.log(`    spark preview                      # build & preview\n`);
}

// ── spark new project ───────────────────────────────────────────────

export interface CreateProjectOptions {
  name?: string;
}

export function createProject(dir: string, options: CreateProjectOptions = {}): void {
  const projectDir = resolve(process.cwd(), dir);
  const name = options.name ?? dir;

  if (existsSync(projectDir)) {
    console.log(`  ✗ Directory "${dir}" already exists.`);
    process.exit(1);
  }

  mkdirSync(projectDir, { recursive: true });

  // ── spark.config.json ─────────────────────────────────────────────
  const config = {
    name,
    version: "1.0.0",
    entryScripts: ["scripts/main.ts"],
    scriptDirs: ["scripts"],
    assetDirs: ["assets"],
    prefabDir: "prefabs",
    outputDir: "../dist",
    audioBitrate: 128,
  };
  writeFileSync(
    join(projectDir, "spark.config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );

  // ── Directory structure ───────────────────────────────────────────
  mkdirSync(join(projectDir, "scripts"));
  mkdirSync(join(projectDir, "prefabs"));
  mkdirSync(join(projectDir, "assets"));

  // ── Sample entry script ───────────────────────────────────────────
  const sampleScript = `import type { SparkAPI } from "@spark/runtime";

export default class ${name.replace(/[^a-zA-Z0-9_]/g, "_")} {
  private spark: SparkAPI;

  constructor(spark: SparkAPI) {
    this.spark = spark;
  }

  async onCreate() {
    console.log("Hello from ${name}!");

    this.spark.spawn({
      x: 400,
      y: 300,
      text: {
        text: "Hello, Spark!",
        fontSize: 32,
        fill: 0xffcc00,
      },
    });

    this.spark.setBackgroundColor(0x1a1a2e);
  }

  onUpdate(dt: number) {
    // Called every frame — dt is seconds since last frame
  }

  onDestroy() {
    console.log("Goodbye from ${name}!");
  }
}
`;
  writeFileSync(join(projectDir, "scripts", "main.ts"), sampleScript);

  console.log(`\n  ✓ Created project: ${name}`);
  console.log(`    ${join(projectDir, "spark.config.json")}`);
  console.log(`    ${join(projectDir, "scripts/main.ts")}`);
  console.log(`    ${join(projectDir, "scripts/")}`);
  console.log(`    ${join(projectDir, "prefabs/")}`);
  console.log(`    ${join(projectDir, "assets/")}`);
  console.log(`\n  Next steps:`);
  console.log(`    cd ${dir}                  # move into the project directory`);
  console.log(`    spark build     # build your first .sprk package\n`);
}


