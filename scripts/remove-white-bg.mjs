#!/usr/bin/env node
/**
 * remove-white-bg.mjs — Magic-wand white background removal
 *
 * Flood-fills from all four edges: any white/near-white pixel connected to an
 * edge is made transparent. Only removes the contiguous background — interior
 * white pixels (e.g. eyes, teeth) are left untouched.
 *
 * Usage:
 *   node scripts/remove-white-bg.mjs <input> [output] [--fuzz 15]
 *
 *   <input>    BMP, PNG, JPEG — anything sharp can read, or a directory (batch)
 *   [output]   Defaults to <input-stem>.png (ignored for directories)
 *   --fuzz N   Tolerance 0–255 (default 15). Higher = more aggressive removal.
 *              Pixels with R,G,B each ≥ (255 - fuzz) are considered "white".
 *
 * Examples:
 *   node scripts/remove-white-bg.mjs assets/sprites/hero.bmp
 *   node scripts/remove-white-bg.mjs hero.bmp hero-clean.png --fuzz 25
 *   node scripts/remove-white-bg.mjs assets/sprites/
 */

import sharp from "sharp";
import { readdirSync, statSync } from "fs";
import { resolve, parse, join } from "path";

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fuzzFlag = args.indexOf("--fuzz");
const fuzz = fuzzFlag !== -1 ? Math.max(0, Math.min(255, Number(args[fuzzFlag + 1]) || 15)) : 15;
const positional = args.filter((_, i) => i !== fuzzFlag && i !== fuzzFlag + 1);

if (positional.length === 0) {
  console.log("Usage: node scripts/remove-white-bg.mjs <input> [output] [--fuzz 15]");
  process.exit(1);
}

const inputPath = resolve(positional[0]);
const outputPath = resolve(positional[1] ?? join(parse(inputPath).dir, `${parse(inputPath).name}.png`));

function hasExtension(file, ext) {
  return file.toLowerCase().endsWith(ext.toLowerCase());
}

// ── Core algorithm ───────────────────────────────────────────────────────────

/**
 * Flood-fill from all four edges: find every white/near-white pixel connected
 * to the background at any edge. Returns a Uint8Array where 1 = background
 * (should be made transparent), 0 = keep.
 */
function floodFillEdges(
  pixels,
  width,
  height,
  channels,
  fuzz,
) {
  const visited = new Uint8Array(width * height);
  const queue = [];

  const isWhite = (idx) => {
    return pixels[idx] >= 255 - fuzz
      && pixels[idx + 1] >= 255 - fuzz
      && pixels[idx + 2] >= 255 - fuzz;
  };

  // Seed queue with all edge pixels that are white-ish
  for (let x = 0; x < width; x++) {
    // Top edge
    const topIdx = x * channels;
    if (isWhite(topIdx)) { visited[x] = 1; queue.push(x, 0); }
    // Bottom edge
    const botIdx = ((height - 1) * width + x) * channels;
    if (isWhite(botIdx)) { visited[(height - 1) * width + x] = 1; queue.push(x, height - 1); }
  }
  for (let y = 1; y < height - 1; y++) {
    // Left edge
    const leftIdx = y * width * channels;
    if (isWhite(leftIdx)) { visited[y * width] = 1; queue.push(0, y); }
    // Right edge
    const rightIdx = ((y + 1) * width - 1) * channels;
    if (isWhite(rightIdx)) { visited[(y + 1) * width - 1] = 1; queue.push(width - 1, y); }
  }

  // BFS flood-fill
  let head = 0;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  while (head < queue.length) {
    const cx = queue[head++];
    const cy = queue[head++];

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (visited[nIdx]) continue;

      const pIdx = nIdx * channels;
      if (isWhite(pIdx)) {
        visited[nIdx] = 1;
        queue.push(nx, ny);
      }
    }
  }

  return visited;
}

/**
 * Process a single image: flood-fill edges, make background transparent, save.
 */
async function processImage(
  inputFile,
  outputFile,
  verbose,
) {
  const { data, info } = await sharp(inputFile)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8ClampedArray(data.buffer);

  const visited = floodFillEdges(pixels, width, height, channels, fuzz);

  // Set alpha to 0 for all visited (background) pixels
  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) {
      pixels[i * channels + 3] = 0;
    }
  }

  await sharp(pixels, { raw: { width, height, channels } })
    .png()
    .toFile(outputFile);

  const removedCount = visited.reduce((sum, v) => sum + v, 0);

  if (verbose) {
    console.log(`✓ ${parse(inputFile).base} → ${parse(outputFile).base}`);
    console.log(`  ${width}×${height}, removed ${removedCount} px (${(removedCount / (width * height) * 100).toFixed(1)}%), fuzz=${fuzz}`);
  } else {
    console.log(`  ✓ ${parse(inputFile).base} → ${parse(outputFile).base}  (${removedCount} px removed)`);
  }
}

// ── Batch mode ───────────────────────────────────────────────────────────────

async function batch(dir) {
  const entries = readdirSync(dir);
  const images = entries.filter(
    (f) => hasExtension(f, ".png") || hasExtension(f, ".jpg") || hasExtension(f, ".jpeg"),
  );

  if (images.length === 0) {
    console.log(`No images found in '${dir}'`);
    return;
  }

  console.log(`Batch converting ${images.length} image(s) in '${dir}' (fuzz=${fuzz})...\n`);

  for (const file of images) {
    const inFile = join(dir, file);
    const outFile = join(dir, `${parse(file).name}_trans.png`);

    if (hasExtension(file, ".png") && inFile === outFile) {
      console.log(`⚠ skipping ${file} (would overwrite itself)`);
      continue;
    }

    await processImage(inFile, outFile, false);
  }
  console.log(`\nDone.`);
}

// ── Entry ────────────────────────────────────────────────────────────────────

if (statSync(inputPath).isDirectory()) {
  batch(inputPath).catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
} else {
  if (hasExtension(inputPath, ".png") && inputPath === outputPath) {
    console.error("Error: input and output are the same file. Overwriting is not allowed.");
    console.error("Specify a different output path or use a different input format.");
    process.exit(1);
  }
  processImage(inputPath, outputPath, true).catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
