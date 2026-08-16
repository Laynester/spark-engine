/** Compact binary palette encoding used inside bundles.
 *
 *  Palettes are the corpus's biggest text bucket (~98MB raw across ~45k
 *  files). The JASC-PAL text form ("255 255 255\n" x256) deflates to ~21%,
 *  but the same colors as raw RGB triples deflate measurably smaller (23%
 *  measured on real casts) — plus the runtime skips the text parse entirely.
 *
 *  Format: 'PALB' + u16LE(count) + count*3 RGB bytes.
 *  Any .pal that isn't clean JASC triplets falls back to shipping the text
 *  (the runtime's parsePaletteBytes detects the magic and handles both).
 */

/** Encode a JASC-PAL text payload into the binary form, or null when it
 *  isn't parseable (caller ships the raw text instead). Uses the SAME
 *  per-line triplet regex as the runtime's parsePalette, so the decoded
 *  table is byte-identical to what the text parse would produce. */
export function encodePalette(bytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder().decode(bytes);
  const colors: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/.exec(line);
    if (m) colors.push([parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]);
  }
  if (colors.length === 0 || colors.length > 65535) return null;
  const out = new Uint8Array(6 + colors.length * 3);
  out[0] = 0x50; out[1] = 0x41; out[2] = 0x4c; out[3] = 0x42; // 'PALB'
  out[4] = colors.length & 0xff;
  out[5] = (colors.length >> 8) & 0xff;
  let o = 6;
  for (const c of colors) {
    out[o++] = c[0];
    out[o++] = c[1];
    out[o++] = c[2];
  }
  return out;
}

export function isPaletteBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x4c && bytes[3] === 0x42;
}
