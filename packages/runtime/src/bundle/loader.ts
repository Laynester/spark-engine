import { inflateSync, unzipSync } from 'fflate';
import type { BundleManifest, CastManifest } from './types.js';

const SPARK_MAGIC = 'SPK1';

function isSparkBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x50 && bytes[2] === 0x4b && bytes[3] === 0x31;
}

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

export interface BundleSource {
  fetchBundle(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<Uint8Array | null>;
}

export function castHintDir(urlHint: string, movieDir: string): string {
  const q = urlHint.indexOf('?');
  let clean = q >= 0 ? urlHint.slice(0, q) : urlHint;
  try {
    clean = new URL(clean, movieDir).href;
  } catch {
  }
  return clean.slice(0, clean.lastIndexOf('/') + 1);
}

export function createBundleFromZipBytes(bytes: Uint8Array): BundleData {
  const unzipped = unzipSync(bytes);
  const manifestEntry = unzipped['bundle-manifest.json'];
  if (!manifestEntry) throw new Error('bundle has no bundle-manifest.json entry');
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as BundleManifest;
  return { files: unzipped, manifest };
}

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

export function createBundleFromBytes(bytes: Uint8Array): BundleData {
  if (isSparkBytes(bytes)) return createBundleFromSparkBytes(bytes);
  return createBundleFromZipBytes(bytes);
}

export class BundleLoader {
  private bundles = new Map<string, BundleData>();

  constructor(private source?: BundleSource) {}

  register(bytes: Uint8Array): CastManifest | null {
    const data = createBundleFromBytes(bytes);
    const cast = data.manifest.casts[0];
    if (cast) this.bundles.set(cast.name, data);
    return cast ?? null;
  }

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

  memberText(member: { file: string; inlineText?: string }): string | undefined {
    if (member.inlineText !== undefined) return member.inlineText;
    return this.readText(member.file);
  }
}
