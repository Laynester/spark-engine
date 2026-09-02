import { decodePng } from './png.js';

/** Compact raw-indexed frame (replaces the PNG for indexed 8-bit art).
 *
 *  The bundle stores 8-bit colormap PNGs as raw palette indices + a shared
 *  palette (the bitmap's palRel table, byte-identical to the PNG PLTE). The
 *  single-stream deflate crushes flat pixel-art indices far better than the
 *  already-compressed PNG IDAT, and the runtime skips all PNG/zing parsing.
 *
 *  Layout: 'PIX8' + u16LE(width) + u16LE(height) + u16LE(flags) + w*h index
 *  bytes. flags bit 0: reserved (0). The palette is NOT inside the frame — the
 *  caller supplies it (member.palette), exactly the table decodePng would have
 *  used from the PLTE chunk (the bundler only converts when they are equal).
 */
export function isPix8(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 10 &&
    bytes[0] === 0x50 && bytes[1] === 0x49 && bytes[2] === 0x58 && bytes[3] === 0x38
  );
}

export function decodePix8(
  bytes: Uint8Array,
  palette: number[][],
): { width: number; height: number; rgba: Uint8Array; indices: Uint8Array } {
  if (!isPix8(bytes)) throw new Error('pix8: bad magic');
  const width = bytes[4] | (bytes[5] << 8);
  const height = bytes[6] | (bytes[7] << 8);
  const count = width * height;
  if (count === 0) throw new Error('pix8: empty frame');
  if (bytes.length < 10 + count) throw new Error('pix8: truncated indices');
  const indices = bytes.subarray(10, 10 + count);
  const rgba = new Uint8Array(count * 4);
  let o = 0;
  for (let i = 0; i < count; i++) {
    const c = palette[indices[i]];
    if (c) {
      rgba[o++] = c[0];
      rgba[o++] = c[1];
      rgba[o++] = c[2];
    } else {
      o += 3;
    }
    rgba[o++] = 255;
  }
  return { width, height, rgba, indices };
}

/** Decode bundle image bytes to RGBA. PIX8 frames need their palette (the
 *  member's table); anything else falls through to the PNG decoder. */
export function decodeImage(
  bytes: Uint8Array,
  palette?: number[][],
): { width: number; height: number; rgba: Uint8Array; indices?: Uint8Array } {
  if (isPix8(bytes)) {
    if (!palette || palette.length === 0) throw new Error('pix8: palette missing');
    return decodePix8(bytes, palette);
  }
  return decodePng(bytes);
}