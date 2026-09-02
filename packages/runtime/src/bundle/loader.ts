import { inflateSync, unzipSync } from 'fflate';
import type { BundleManifest, CastManifest } from './types.js';

const SPARK_MAGIC = 'SPK1';
const textDecoder = new TextDecoder();

function isSparkBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x50 && bytes[2] === 0x4b && bytes[3] === 0x31;
}

function inflateSpark(bytes: Uint8Array): { index: Record<string, [number, number]>; body: Uint8Array } {
  const payload = inflateSync(bytes.subarray(4));
  const nl = payload.indexOf(0x0a);
  if (nl < 0) throw new Error('bundle has no bundle-manifest.json entry');
  const index = JSON.parse(textDecoder.decode(payload.subarray(0, nl))) as Record<string, [number, number]>;
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
  const manifest = JSON.parse(textDecoder.decode(manifestEntry)) as BundleManifest;
  return { files: unzipped, manifest };
}

function bundleFromInflated(index: Record<string, [number, number]>, body: Uint8Array): BundleData {
  const files: Record<string, Uint8Array> = {};
  for (const [path, [off, len]] of Object.entries(index)) {
    files[path] = body.subarray(off, off + len);
  }
  const manifestEntry = files['bundle-manifest.json'];
  if (!manifestEntry) throw new Error('bundle has no bundle-manifest.json entry');
  const manifest = JSON.parse(textDecoder.decode(manifestEntry)) as BundleManifest;
  return { files, manifest };
}

export function createBundleFromSparkBytes(bytes: Uint8Array): BundleData {
  const { index, body } = inflateSpark(bytes);
  return bundleFromInflated(index, body);
}

export function createBundleFromBytes(bytes: Uint8Array): BundleData {
  if (isSparkBytes(bytes)) return createBundleFromSparkBytes(bytes);
  return createBundleFromZipBytes(bytes);
}

async function inflateSparkNative(bytes: Uint8Array): Promise<{ index: Record<string, [number, number]>; body: Uint8Array }> {
  const copy = new Uint8Array(bytes.length - 4);
  copy.set(bytes.subarray(4));
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  const payload = new Uint8Array(buf);
  const nl = payload.indexOf(0x0a);
  if (nl < 0) throw new Error('bundle has no bundle-manifest.json entry');
  const index = JSON.parse(textDecoder.decode(payload.subarray(0, nl))) as Record<string, [number, number]>;
  return { index, body: payload.subarray(nl + 1) };
}

export async function createBundleFromBytesAsync(bytes: Uint8Array): Promise<BundleData> {
  if (isSparkBytes(bytes) && typeof DecompressionStream !== 'undefined') {
    try {
      const { index, body } = await inflateSparkNative(bytes);
      return bundleFromInflated(index, body);
    } catch {
      return createBundleFromSparkBytes(bytes);
    }
  }
  return createBundleFromBytes(bytes);
}export class BundleLoader {
  private bundles = new Map<string, BundleData>();
  private files = new Map<string, Uint8Array>();

  constructor(private source?: BundleSource) {}

  private indexFiles(data: BundleData): void {
    for (const [path, bytes] of Object.entries(data.files)) {
      if (!this.files.has(path)) this.files.set(path, bytes);
    }
  }

  register(bytes: Uint8Array): CastManifest | null {
    const data = createBundleFromBytes(bytes);
    const cast = data.manifest.casts[0];
    if (cast) {
      this.bundles.set(cast.name, data);
      this.indexFiles(data);
    }
    return cast ?? null;
  }

  async loadCast(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<CastManifest | null> {
    const existing = this.getCast(name);
    if (existing) return existing;
    if (!this.source) return null;
    const bytes = await this.source.fetchBundle(name, onProgress, urlHint);
    if (!bytes) return null;
    const data = await createBundleFromBytesAsync(bytes);
    this.bundles.set(name, data);
    this.indexFiles(data);
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
    return this.files.get(path);
  }

  readText(path: string): string | undefined {
    const bytes = this.readBytes(path);
    if (!bytes) return undefined;
    return textDecoder.decode(bytes);

  }

  memberText(member: { file: string; inlineText?: string }): string | undefined {
    if (member.inlineText !== undefined) return member.inlineText;
    return this.readText(member.file);
  }
}
