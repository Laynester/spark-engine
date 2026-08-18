import { inflateSync, unzipSync } from 'fflate';
import type { BundleManifest, CastManifest } from './types.js';

// Spark container magic + reader (shared with the bundler's buildSpark).
const SPARK_MAGIC = 'SPK1';

function isSparkBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x50 && bytes[2] === 0x4b && bytes[3] === 0x31;
}

// Inflate a spark bundle: first line is the JSON file index, the rest is the
// concatenated file bodies.
function inflateSpark(bytes: Uint8Array): { index: Record<string, [number, number]>; body: Uint8Array } {
  const payload = inflateSync(bytes.subarray(4));
  const nl = payload.indexOf(0x0a);
  if (nl < 0) throw new Error('bundle has no bundle-manifest.json entry');
  const index = JSON.parse(new TextDecoder().decode(payload.subarray(0, nl))) as Record<string, [number, number]>;
  return { index, body: payload.subarray(nl + 1) };
}

export interface BundleData {
  files: Record<string, Uint8Array>;
  manifest: BundleManifest;
}

// Fetches a cast's bundle bytes. The progress callback lets the corpus's
// download flow animate real progress; urlHint is the original Lingo preload
// URL (sub-cast containers resolve relative to it).
export interface BundleSource {
  fetchBundle(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<Uint8Array | null>;
}

/** Resolve a cast-preload URL hint down to its directory. A RELATIVE hint
 *  (v31's `dynamic.download.url=hof_furni/` — the original hotel config) is
 *  relative to the movie's directory, so it must be resolved against
 *  `movieDir` first or the nested container lookup misses (the v31 furniture
 *  bundles live at casts/31/hof_furni/<furni>.spark). An absolute hint (v14's
 *  hand-tuned `http://…/casts/14/` base) passes through unchanged. */
export function castHintDir(urlHint: string, movieDir: string): string {
  const q = urlHint.indexOf('?');
  let clean = q >= 0 ? urlHint.slice(0, q) : urlHint;
  try {
    clean = new URL(clean, movieDir).href;
  } catch {
    // Not a parseable URL at all — leave as-is; the fetch attempts below will
    // fail and fall through to the movie dir.
  }
  return clean.slice(0, clean.lastIndexOf('/') + 1);
}

// Unpack a zip-format bundle (legacy bundler output).
export function createBundleFromZipBytes(bytes: Uint8Array): BundleData {
  const unzipped = unzipSync(bytes);
  const manifestEntry = unzipped['bundle-manifest.json'];
  if (!manifestEntry) throw new Error('bundle has no bundle-manifest.json entry');
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as BundleManifest;
  return { files: unzipped, manifest };
}

// Unpack a single-stream spark bundle.
export function createBundleFromSparkBytes(bytes: Uint8Array): BundleData {
  const { index, body } = inflateSpark(bytes);
  const files: Record<string, Uint8Array> = {};
  for (const [path, [off, len]] of Object.entries(index)) {
    files[path] = body.subarray(off, off + len);
  }
  const manifestEntry = files['bundle-manifest.json'];
  if (!manifestEntry) throw new Error('bundle has no bundle-manifest.json entry');
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as BundleManifest;
  return { files, manifest };
}

// Unpack whatever the bundler emitted — spark container or legacy zip.
export function createBundleFromBytes(bytes: Uint8Array): BundleData {
  if (isSparkBytes(bytes)) return createBundleFromSparkBytes(bytes);
  return createBundleFromZipBytes(bytes);
}

// Loads per-cast bundles on demand (Director linked-cast model) and keeps
// them in memory. Files are addressed by bundle path, e.g.
// "fuse_client/0001_script_X.ls".
export class BundleLoader {
  private bundles = new Map<string, BundleData>();

  constructor(private source?: BundleSource) {}

  // Register an already-unpacked bundle (tests, direct injection).
  register(bytes: Uint8Array): CastManifest | null {
    const data = createBundleFromBytes(bytes);
    const cast = data.manifest.casts[0];
    if (cast) this.bundles.set(cast.name, data);
    return cast ?? null;
  }

  // Fetch and register a cast's bundle (no-op when already loaded).
  async loadCast(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<CastManifest | null> {
    const existing = this.getCast(name);
    if (existing) return existing;
    if (!this.source) return null;
    const bytes = await this.source.fetchBundle(name, onProgress, urlHint);
    if (!bytes) return null;
    const data = createBundleFromBytes(bytes);
    this.bundles.set(name, data);
    return this.getCast(name);
  }

  listCasts(): string[] {
    return [...this.bundles.keys()];
  }

  getCast(name: string): CastManifest | null {
    const data = this.bundles.get(name);
    if (!data) return null;
    return data.manifest.casts.find((c) => c.name === name) ?? null;
  }

  hasFile(path: string): boolean {
    return this.readBytes(path) !== undefined;
  }

  // Search all bundles for a file path.
  readBytes(path: string): Uint8Array | undefined {
    for (const data of this.bundles.values()) {
      const bytes = data.files[path];
      if (bytes) return bytes;
    }
    return undefined;
  }

  readText(path: string): string | undefined {
    const bytes = this.readBytes(path);
    if (!bytes) return undefined;
    return new TextDecoder().decode(bytes);
  }

  // Read a member's payload (inline text when the manifest embedded it).
  memberText(member: { file: string; inlineText?: string }): string | undefined {
    if (member.inlineText !== undefined) return member.inlineText;
    return this.readText(member.file);
  }
}
