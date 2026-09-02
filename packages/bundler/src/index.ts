import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCastManifest, buildManifest, nodeFs } from './manifest.js';
import type { CastUnit } from './manifest.js';
import type { BundleManifest } from './types.js';
import { buildZip, isTextPath, buildSpark, isSparkBytes, readSpark, SPARK_MAGIC } from './zip.js';
import { encodePalette, parsePalTable } from './pal.js';
import { decodeImage, encodeScript, inferScriptType, parseLingo } from '@habbo/runtime';

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

/** PNG chunk scan for the PIX8 conversion gate: indexed color type, PLTE
 *  bytes, interlace flag, tRNS presence. Null when the file is not a PNG or
 *  has no PLTE (truecolor frames are never converted). */
function parsePngMeta(bytes: Uint8Array): {
  plte: Uint8Array;
  bitDepth: number;
  interlace: number;
  hasTrns: boolean;
} | null {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  let pos = 8;
  let plte: Uint8Array | null = null;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let hasTrns = false;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = new Uint8Array(data);
    } else if (type === 'tRNS') {
      hasTrns = true;
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  return colorType === 3 && plte !== null ? { plte, bitDepth, interlace, hasTrns } : null;
}

/** 32-bit FNV-1a over a string; used to content-address shared palette files. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Compile a .ls script to LBC1 bytecode. Null on ANY failure (parse or
 *  encode) — callers keep shipping the text form then. */
function compileScriptBytes(source: string, name: string): Uint8Array | null {
  try {
    const script = parseLingo(source);
    script.name = name;
    script.type = inferScriptType(source);
    return encodeScript(script);
  } catch {
    return null;
  }
}

/** Collect bundle entries from a manifest: text files as strings, media as
 *  raw bytes, and JASC-PAL files re-encoded into the compact PALB binary form
 *  (falling back to the raw text when unparseable). Shared by the zip and
 *  spark builders so both formats ship identical payloads. */
function collectEntries(exportRoot: string, manifest: BundleManifest): Record<string, Uint8Array | string> {
  const entries: Record<string, Uint8Array | string> = {};

  // Bitmap-companion palettes ship ONCE per unique palette as a shared entry,
  // with every member's palRel rewired to it (the CCT stores the cast palette
  // once too, and the corpus repeats palettes constantly — badges: 104
  // companions, 2 unique). The runtime reads palRel as a plain path, so this
  // changes nothing on the load side; the pruned duplicates never hit the
  // wire, and the survivors sit in the same deflate stream as before.
  // Convert indexed 8-bit PNGs to compact PIX8 raw-index frames: the palette
  // comes from the palRel table (which must equal the PNG's PLTE, so the
  // runtime produces byte-identical pixels with zero PNG parsing), and the
  // single deflate stream crushes flat pixel-art indices far better than the
  // already-compressed IDAT. Truecolor frames whose art is really 8-bit
  // (fully opaque with <=256 unique colors — Director stored these as
  // indexed cast members; the exporter up-converted them) are losslessly
  // re-indexed into PIX8 with a synthesized palette. Anything else
  // (interlaced, tRNS, indexed-without-palette, >256 colors, partial alpha,
  // PLTE mismatch, decode failure) stays a PNG untouched.
  const pix8ByFile = new Map<string, Uint8Array>();
  const synthesizedPals = new Map<string, Uint8Array>();
  for (const cast of manifest.casts) {
    for (const m of cast.members) {
      if (m.kind !== 'bitmap' || !m.file.toLowerCase().endsWith('.png')) continue;
      try {
        const png = new Uint8Array(readFileSync(join(exportRoot, m.file)));
        if (m.palRel) {
          const pal = new Uint8Array(readFileSync(join(exportRoot, m.palRel)));
          const meta = parsePngMeta(png);
          const enc = encodePalette(pal);
          if (meta !== null && enc !== null) {
            if (meta.bitDepth !== 8 || meta.interlace !== 0 || meta.hasTrns) continue;
            if (meta.plte.length !== enc.length - 6) continue;
            let same = true;
            for (let i = 0; i < meta.plte.length; i++) {
              if (meta.plte[i] !== enc[6 + i]) {
                same = false;
                break;
              }
            }
            if (!same) continue;
            const decoded = decodeImage(png);
            if (!decoded.indices) continue;
            const w = decoded.width;
            const h = decoded.height;
            if (w < 1 || h < 1 || w > 65535 || h > 65535 || decoded.indices.length !== w * h) continue;
            const out = new Uint8Array(10 + decoded.indices.length);
            out[0] = 0x50; out[1] = 0x49; out[2] = 0x58; out[3] = 0x38; // 'PIX8'
            out[4] = w & 0xff;
            out[5] = (w >> 8) & 0xff;
            out[6] = h & 0xff;
            out[7] = (h >> 8) & 0xff;
            out[8] = 0;
            out[9] = 0;
            out.set(decoded.indices, 10);
            pix8ByFile.set(m.file, out);
            continue;
          }
        }
        const decoded = decodeImage(png);
        if (decoded.indices) continue;
        const w = decoded.width;
        const h = decoded.height;
        const rgba = decoded.rgba;
        if (w < 1 || h < 1 || w > 65535 || h > 65535 || rgba.length !== w * h * 4) continue;
        if (m.palRel) {
          // Palette companion present: the member is palette-ref-remapped in
          // the movie (entry corners use #systemWin/#systemMac, clouds
          // #grayscale — see engine.memberImage's remapPaletteByIndices
          // path, which maps pixel INDICES through the target table). The
          // indices must therefore be the palette's NATURAL slots, exactly
          // as Director's original 8-bit bitmap had them; a first-seen order
          // would remap to arbitrary system colors. If any pixel color is
          // absent from the table (up-converted art), keep the PNG.
          let palTable: number[][] | null = null;
          try {
            palTable = parsePalTable(new Uint8Array(readFileSync(join(exportRoot, m.palRel))));
          } catch {
            palTable = null;
          }
          if (!palTable || palTable.length === 0) continue;
          const pal = new Uint8Array(6 + palTable.length * 3);
          pal[0] = 0x50; pal[1] = 0x41; pal[2] = 0x4c; pal[3] = 0x42; // 'PALB'
          pal[4] = palTable.length & 0xff;
          pal[5] = (palTable.length >> 8) & 0xff;
          let po = 6;
          for (const c of palTable) {
            pal[po++] = c[0];
            pal[po++] = c[1];
            pal[po++] = c[2];
          }
          const natural = new Map<number, number>();
          const naturalIndex = (r: number, g: number, b: number): number => {
            const key = (r << 16) | (g << 8) | b;
            let i = natural.get(key);
            if (i === undefined) {
              for (let j = 0; j < palTable!.length; j++) {
                if (palTable![j][0] === r && palTable![j][1] === g && palTable![j][2] === b) {
                  i = j;
                  break;
                }
              }
              if (i === undefined) return -1;
              natural.set(key, i);
            }
            return i;
          };
          const indices = new Uint8Array(w * h);
          let ok = true;
          for (let i = 0; i < w * h; i++) {
            const o = i * 4;
            if (rgba[o + 3] !== 255) {
              ok = false;
              break;
            }
            const idx = naturalIndex(rgba[o], rgba[o + 1], rgba[o + 2]);
            if (idx < 0) {
              ok = false;
              break;
            }
            indices[i] = idx;
          }
          if (!ok) continue;
          const frame = new Uint8Array(10 + indices.length);
          frame[0] = 0x50; frame[1] = 0x49; frame[2] = 0x58; frame[3] = 0x38; // 'PIX8'
          frame[4] = w & 0xff;
          frame[5] = (w >> 8) & 0xff;
          frame[6] = h & 0xff;
          frame[7] = (h >> 8) & 0xff;
          frame[8] = 0;
          frame[9] = 0;
          frame.set(indices, 10);
          pix8ByFile.set(m.file, frame);
          synthesizedPals.set(m.file, pal);
          m.palRel = '__synthesized__';
          continue;
        }
        // No palette companion (e.g. entry backdrops): first-seen order is
        // fine — nothing index-remaps these members. Same PIX8 emission as
        // the indexed path, with a synthesized table.
        const colorToIndex = new Map<number, number>();
        const colors: number[] = [];
        const indices = new Uint8Array(w * h);
        let count = 0;
        let ok = true;
        for (let i = 0; i < w * h; i++) {
          const o = i * 4;
          if (rgba[o + 3] !== 255) {
            ok = false;
            break;
          }
          const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
          let idx = colorToIndex.get(key);
          if (idx === undefined) {
            if (count >= 256) {
              ok = false;
              break;
            }
            idx = count++;
            colors.push(rgba[o], rgba[o + 1], rgba[o + 2]);
            colorToIndex.set(key, idx);
          }
          indices[i] = idx;
        }
        if (!ok) continue;
        const pal = new Uint8Array(6 + colors.length);
        pal[0] = 0x50; pal[1] = 0x41; pal[2] = 0x4c; pal[3] = 0x42; // 'PALB'
        pal[4] = count & 0xff;
        pal[5] = (count >> 8) & 0xff;
        pal.set(colors, 6);
        const frame = new Uint8Array(10 + indices.length);
        frame[0] = 0x50; frame[1] = 0x49; frame[2] = 0x58; frame[3] = 0x38; // 'PIX8'
        frame[4] = w & 0xff;
        frame[5] = (w >> 8) & 0xff;
        frame[6] = h & 0xff;
        frame[7] = (h >> 8) & 0xff;
        frame[8] = 0;
        frame[9] = 0;
        frame.set(indices, 10);
        pix8ByFile.set(m.file, frame);
        synthesizedPals.set(m.file, pal);
        m.palRel = '__synthesized__';
      } catch {
        // unreadable/undecodable: keep the PNG path
      }
    }
  }

  const sharedPalettes = new Map<string, Uint8Array>();
  const sharedPathByKey = new Map<string, string>();
  const prunedPals = new Set<string>();
  for (const cast of manifest.casts) {
    for (const m of cast.members) {
      if (m.kind !== 'bitmap' || !m.palRel) continue;
      const synthesized = synthesizedPals.get(m.file);
      let raw: Uint8Array;
      try {
        raw = synthesized ?? new Uint8Array(readFileSync(join(exportRoot, m.palRel)));
      } catch {
        continue;
      }
      const enc = encodePalette(raw) ?? raw;
      // Shared entries are content-addressed (pals/pal_<len>_<hash>.pal) so
      // the name is unique to the palette bytes. The runtime's bundle loader
      // resolves a path against EVERY registered bundle (a movie registers
      // dozens), so a flat dedup_N name would collide across bundles and hand
      // members arbitrary palettes; identical content may share a name freely
      // (same bytes either way), different content never collides.
      const key = enc.toString();
      let shared = sharedPathByKey.get(key);
      if (!shared) {
        shared = `pals/pal_${enc.length}_${fnv1a(key).toString(16)}.pal`;
        sharedPathByKey.set(key, shared);
        sharedPalettes.set(shared, enc);
      }
      if (!synthesized) prunedPals.add(m.palRel);
      m.palRel = shared;
    }
  }
  if (prunedPals.size > 0) {
    manifest.files = manifest.files.filter((f) => !prunedPals.has(f));
  }

  // Compile every script member to bytecode first (before the manifest is
  // serialized): on success the .ls path carries LBC1 bytes and the member
  // entry is flagged; on failure the plain text ships and the runtime
  // parses it exactly as before. inlineText scripts (no disk file) stay text.
  const compiled = new Map<string, Uint8Array>();
  for (const cast of manifest.casts) {
    for (const m of cast.members) {
      if (m.kind !== 'script' || m.inlineText !== undefined) continue;
      const path = m.file;
      try {
        const source = readFileSync(join(exportRoot, path), 'utf8');
        const bc = compileScriptBytes(source, m.name);
        if (bc) {
          compiled.set(path, bc);
          m.bytecode = true;
        }
      } catch {
        // file missing/unreadable: keep the text entry (runtime falls back)
      }
    }
  }

  entries['bundle-manifest.json'] = JSON.stringify(manifest);
  for (const [path, payload] of sharedPalettes) entries[path] = payload;
  for (const file of manifest.files) {
    const compiledBytes = compiled.get(file);
    if (compiledBytes) {
      entries[file] = compiledBytes;
      continue;
    }
    const pix8 = pix8ByFile.get(file);
    if (pix8) {
      entries[file] = pix8;
      continue;
    }
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
