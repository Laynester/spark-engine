import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCastManifest, buildManifest, nodeFs } from './manifest.js';
import type { CastUnit } from './manifest.js';
import type { BundleManifest } from './types.js';
import { buildZip, isTextPath, buildSpark, isSparkBytes, readSpark, SPARK_MAGIC } from './zip.js';
import { encodePalette } from './pal.js';

export * from './pal.js';

export * from './types.js';
export * from './manifest.js';
export * from './scan.js';
export { buildZip, isTextPath, buildSpark, isSparkBytes, readSpark, SPARK_MAGIC };

export interface BundleResult {
  zip: Uint8Array;
  manifest: BundleManifest;
}

/**
 * Build ONE cast's bundle straight from its unit, without re-enumerating the
 * export tree. The per-cast CLI path (bundleAll) enumerates units once up
 * front and then calls this per cast — re-running `buildSparkBundle` there
 * would re-walk every directory under the root for every cast (O(casts^2)
 * stat calls; with deep containers like hof_furni that is minutes of pure
 * fs churn). Returns null when the cast directory has no files.
 */
export function buildCastSparkBundle(exportRoot: string, unit: CastUnit): SparkBundleResult | null {
  const built = buildCastManifest(unit, nodeFs);
  if (!built) return null;
  const { cast, files: castFiles } = built;
  const manifest: BundleManifest = { version: 1, casts: [cast], files: castFiles };
  return { spark: buildSpark(collectEntries(exportRoot, manifest)), manifest };
}

export interface SparkBundleResult {
  /** Single-stream spark container (see buildSpark) — ~40% smaller than the zip. */
  spark: Uint8Array;
  manifest: BundleManifest;
}

/**
 * Build a distributable bundle from an export directory. Casts stay as
 * separate bundles (Director linked-cast model); the manifest records
 * linkedCasts so the runtime can fetch them on demand.
 * @param exportRoot path to the exported casts
 * @param casts cast names to include (all when omitted)
 */
export function buildBundle(exportRoot: string, casts?: string[]): BundleResult {
  const manifest = buildManifest(exportRoot, casts, nodeFs);
  return { zip: buildZip(collectEntries(exportRoot, manifest)), manifest };
}

/** Collect bundle entries from a manifest: text files as strings, media as
 *  raw bytes, and JASC-PAL files re-encoded into the compact PALB binary form
 *  (falling back to the raw text when unparseable). Shared by the zip and
 *  spark builders so both formats ship identical payloads. */
function collectEntries(exportRoot: string, manifest: BundleManifest): Record<string, Uint8Array | string> {
  const entries: Record<string, Uint8Array | string> = {};
  entries['bundle-manifest.json'] = JSON.stringify(manifest);
  for (const file of manifest.files) {
    const raw = readFileSync(join(exportRoot, file));
    if (file.toLowerCase().endsWith('.pal')) {
      entries[file] = encodePalette(new Uint8Array(raw)) ?? (isTextPath(file) ? new TextDecoder().decode(raw) : new Uint8Array(raw));
    } else {
      entries[file] = isTextPath(file) ? new TextDecoder().decode(raw) : new Uint8Array(raw);
    }
  }
  return entries;
}

/** Like buildBundle but emits the single-stream spark container. */
export function buildSparkBundle(exportRoot: string, casts?: string[]): SparkBundleResult {
  const manifest = buildManifest(exportRoot, casts, nodeFs);
  return { spark: buildSpark(collectEntries(exportRoot, manifest)), manifest };
}
