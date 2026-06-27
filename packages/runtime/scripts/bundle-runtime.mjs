import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, copyFileSync, mkdirSync, existsSync, writeFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(root, "dist/runtime.js"),
  format: "esm",
  bundle: true,
  platform: "browser",
  target: "esnext",
  sourcemap: false,
  minify: true,
  tsconfig: resolve(root, "tsconfig.json"),
  logLevel: "info",
});

// Copy .d.ts files to studio's public/runtime/ dir for Monaco intellisense
const studioPublicRuntime = resolve(root, "../studio/public/runtime");
if (!existsSync(studioPublicRuntime)) {
  mkdirSync(studioPublicRuntime, { recursive: true });
}

const distDir = resolve(root, "dist");
const dtsFiles = [];

for (const file of readdirSync(distDir)) {
  if (file.endsWith(".d.ts") && !file.endsWith(".d.ts.map")) {
    copyFileSync(resolve(distDir, file), resolve(studioPublicRuntime, file));
    dtsFiles.push(file);
  }
}

// Auto-generate index.json so Monaco knows which files to load
dtsFiles.sort();
const indexPath = resolve(studioPublicRuntime, "index.json");
writeFileSync(indexPath, JSON.stringify(dtsFiles) + "\n");
console.log(`  Copied ${dtsFiles.length} .d.ts file(s) to studio/public/runtime/`);
console.log(`  Generated index.json (${dtsFiles.length} entries)`);
