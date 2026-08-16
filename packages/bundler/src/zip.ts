import { deflateSync, inflateSync, strToU8, zipSync } from 'fflate';

const TEXT_EXT = new Set(['.ls', '.txt', '.regpoint', '.pal', '.json']);

export function isTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  return [...TEXT_EXT].some((ext) => lower.endsWith(ext));
}

/**
 * Build a zip archive (deflate level 6). PNG/MP3 media barely compress, so a
 * per-file level-0 optimisation could be added later via fflate's async zip().
 */
export function buildZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    files[path] = typeof data === 'string' ? strToU8(data) : data;
  }
  return zipSync(files, { level: 6 });
}

/** Magic for the single-stream spark container (see buildSpark). */
export const SPARK_MAGIC = 'SPK1';

export function isSparkBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x50 && bytes[2] === 0x4b && bytes[3] === 0x31;
}

/**
 * Build a single-stream bundle: one deflate pass over [index + all file
 * bytes] instead of per-file zip streams. The zip format compresses each
 * entry independently, so content shared across the corpus's many tiny files
 * (identical 256-entry JASC-PAL palettes, similar sprite art, repeated script
 * prologues) repeats in every stream. A single deflate window reuses that
 * redundancy — measured ~40% smaller on real casts (537KB -> 303KB furniture,
 * 118KB -> 73KB fuse_client) — and the flat layout means the loader does one
 * inflate + slice per file instead of unzipping per entry.
 *
 * Layout: 'SPK1' + deflate( indexJson + '\n' + concatenated file bytes )
 * where indexJson = { "path": [offset, length], ... } — offsets into the
 * concatenated body, so the runtime slices the inflated buffer directly.
 */
export function buildSpark(entries: Record<string, Uint8Array | string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    files[path] = typeof data === 'string' ? strToU8(data) : data;
  }
  const paths = Object.keys(files);
  const index: Record<string, [number, number]> = {};
  const body = new Uint8Array(paths.reduce((n, p) => n + files[p].length, 0));
  let off = 0;
  for (const p of paths) {
    index[p] = [off, files[p].length];
    body.set(files[p], off);
    off += files[p].length;
  }
  const head = strToU8(JSON.stringify(index) + '\n');
  const payload = new Uint8Array(head.length + body.length);
  payload.set(head, 0);
  payload.set(body, head.length);
  const deflated = deflateSync(payload, { level: 9 });
  const out = new Uint8Array(4 + deflated.length);
  out.set(strToU8(SPARK_MAGIC), 0);
  out.set(deflated, 4);
  return out;
}

/** Inflate a spark container back into { index, body } (loader side). */
export function readSpark(bytes: Uint8Array): { index: Record<string, [number, number]>; body: Uint8Array } {
  const payload = inflateSync(bytes.subarray(4));
  const nl = payload.indexOf(0x0a);
  if (nl < 0) throw new Error('spark bundle: missing index separator');
  const index = JSON.parse(new TextDecoder().decode(payload.subarray(0, nl))) as Record<string, [number, number]>;
  return { index, body: payload.subarray(nl + 1) };
}
