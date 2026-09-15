/**
 * `member.media` for a bitmap cast member — the bytes the camera/photo feature
 * puts in a propList (`[#image: tmember.media, ...]`), ships over MUS
 * (`sendBinary`), and the server stores verbatim in `items_photos.photo_data`.
 *
 * THE FORMAT IS DIRECTOR'S, NOT OURS. A real client sends the member's own
 * media, so anything else is unreadable by a real client and a real photo is
 * unreadable by us. Decoded from the one real row in the server's database
 * (written by a real client — 3273 bytes for the 161x117 camera frame):
 *
 *   offset  size  contents
 *   0x00    60    member header — magic `60 74 67 75`, and the raster geometry:
 *                 height as a BIG-endian u16 at 0x22, width at 0x24
 *                 (`00 75` = 117, `00 a1` = 161). The remaining fields are
 *                 copied from that real sample verbatim; only 0x22/0x24 are
 *                 understood, which is all a decode needs.
 *   0x3c    4     chunk id `DTIB` — `BITD` with the four characters byte-
 *                 reversed, the way Director writes Intel-order bitmap chunks
 *   0x40    4     chunk length, little-endian u32 (3205)
 *   0x44    ...   PackBits RLE of 8-bit PALETTE INDICES, one independently
 *                 compressed run per row, rows word-aligned to an EVEN stride
 *                 (a 161-wide member stores 162-byte rows, the pad byte 0):
 *                 162 * 117 = 18954 decoded bytes for 18837 pixels
 *
 * Verified end to end rather than assumed: the corpus's own
 * `Photo Component Class::countCS` over the decoded raster returns 12831, exactly
 * the `photo_checksum` the server stored beside that photo (`node
 * scripts/probe-photo-format.mjs`). Two consequences are pinned by that:
 *
 *   * the raster is palette indices and `image.getPixel(x, y).paletteIndex` must
 *     return the STORED index (not a nearest-palette-entry lookup), or a real
 *     photo fails the client's own check and paints `photo_invalid`;
 *   * the rows really are even-strided, and the pad column really is 0 — the
 *     real raster's only index-0 pixels are exactly one per row.
 *
 * The header carries no palette, so a decoded photo is displayed through the
 * camera's own palette (the corpus declares `#palette: #grayscale` on both the
 * camera display and the photo window element).
 *
 * An older, self-invented `MDP1` blob is still DECODED (photos 28/29 in that
 * database were saved with it) but is never written: see `encodeMdp1`'s absence
 * and the `MDP1` constants below.
 */

/** Legacy self-describing blob (header + optional palette + pixels), decode only. */
const MDP1_MAGIC = [0x4d, 0x44, 0x50, 0x31]; // 'MDP1'
const MDP1_HEADER = 11;
const MDP1_MIN = MDP1_HEADER + 4;

/** Director member header + chunk header, taken byte-for-byte from photo 31. */
const DIR_HEADER = 60;
const DIR_CHUNK = 0x3c;
const DIR_DATA = DIR_CHUNK + 8;

/**
 * The 60-byte header of a real bitmap member, with the two geometry fields
 * (`HEIGHT`/`WIDTH` placeholders) patched per encode. Copied from the real
 * sample: the fields that are not understood must not be invented.
 */
const DIR_HEADER_TEMPLATE: number[] = [
  // 0x00                                                                             0x0f
  0x60, 0x74, 0x67, 0x75, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // 0x10                                                                             0x1f
  0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0xa2, 0x00, 0x00,
  // 0x20  0x22/0x23 = height, 0x24/0x25 = width (both patched per encode)          0x2f
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // 0x30                                                                             0x3b
  0x00, 0x00, 0xc0, 0x08, 0xff, 0xff, 0xff, 0xfe, 0x01, 0x00, 0x00, 0x00,
];
const DIR_HEIGHT_OFF = 0x22;
const DIR_WIDTH_OFF = 0x24;

export interface MediaBlob {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Palette indices, when the blob stored them. */
  indices?: Uint8Array;
  /** Palette table, when the blob carried one (MDP1 only). */
  palette?: number[][];
}

/** Nearest palette entry, first-wins — the same rule the camera's capture path
 *  quantises with, used only when a surface exists as RGBA with no indices. */
function nearestIndex(palette: number[][], r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Director word-aligns bitmap rows: an odd width is padded to the next byte. */
export function evenStride(width: number): number {
  return width + (width & 1);
}

const isMdp1 = (bytes: Uint8Array | null | undefined): boolean =>
  !!bytes &&
  bytes.length >= MDP1_MIN &&
  bytes[0] === MDP1_MAGIC[0] &&
  bytes[1] === MDP1_MAGIC[1] &&
  bytes[2] === MDP1_MAGIC[2] &&
  bytes[3] === MDP1_MAGIC[3];

const isDirectorMedia = (bytes: Uint8Array | null | undefined): boolean =>
  !!bytes && bytes.length > DIR_DATA && bytes[DIR_CHUNK] === 0x44 && bytes[DIR_CHUNK + 1] === 0x54;

export function isMemberMedia(bytes: Uint8Array | null | undefined): boolean {
  return isMdp1(bytes) || isDirectorMedia(bytes);
}

/* ------------------------------------------------------------------ PackBits */

/**
 * One row of PackBits, the grammar the real raster uses: a control byte below
 * 0x80 is `n + 1` literal bytes, 0x80 is a no-op, anything else repeats the
 * following byte `0x101 - c` times. Runs shorter than three are left literal —
 * that is what Director's own compressor does (per-row, minRun 3 reproduces its
 * 3205 bytes to within one opcode), and it is what keeps an encoder's rows
 * aligned with its decoder's.
 */
function packBitsRow(row: Uint8Array): number[] {
  const out: number[] = [];
  const n = row.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && row[i + run] === row[i] && run < 128) run++;
    if (run >= 3) {
      out.push((0x101 - run) & 0xff, row[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < n && i - start < 128) {
      if (i + 2 < n && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++;
    }
    if (i === start) i = start + 1;
    const count = i - start;
    out.push(count - 1);
    for (let k = 0; k < count; k++) out.push(row[start + k]);
  }
  return out;
}

/** Decode `rows` rows of `stride` bytes each from a PackBits stream. Returns the
 *  number of stream bytes consumed, or -1 if the stream is malformed/short. */
function packBitsRows(src: Uint8Array, into: Uint8Array, stride: number, rows: number): number {
  let i = 0;
  for (let row = 0; row < rows; row++) {
    let out = row * stride;
    const end = out + stride;
    while (out < end) {
      if (i >= src.length) return -1;
      const c = src[i++];
      if (c < 0x80) {
        const n = c + 1;
        if (i + n > src.length || out + n > end) return -1;
        into.set(src.subarray(i, i + n), out);
        i += n;
        out += n;
      } else if (c === 0x80) {
        // no-op
      } else {
        const n = 0x101 - c;
        if (i >= src.length || out + n > end) return -1;
        into.fill(src[i++], out, out + n);
        out += n;
      }
    }
  }
  return i;
}

/* ------------------------------------------------------------------- encode */

/**
 * The bytes a real client reads as `member.media`. The raster is written as
 * palette indices; a surface that only exists as RGBA (the camera paints the
 * stage into an 8-bit image) is quantised with the same nearest-entry rule
 * `image.getPixel().paletteIndex` resolves with, so both ends hash the same
 * indices in `countCS`.
 */
export function encodeMemberMedia(image: {
  width: number;
  height: number;
  data?: Uint8Array | null;
  indices?: Uint8Array | null;
  palette?: number[][];
}): Uint8Array | null {
  const width = Math.max(0, Math.round(image.width));
  const height = Math.max(0, Math.round(image.height));
  const count = width * height;
  if (count <= 0) return null;
  const palette = image.palette && image.palette.length > 0 ? image.palette : null;
  let indices: Uint8Array | null = image.indices && image.indices.length >= count ? image.indices : null;
  if (!indices) {
    const src = image.data ?? null;
    if (!src || src.length < count * 4) return null;
    if (!palette) return null; // indices cannot be derived without a palette
    indices = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      indices[i] = nearestIndex(palette, src[o], src[o + 1], src[o + 2]);
    }
  }

  const stride = evenStride(width);
  const raster = new Uint8Array(stride * height); // zero-filled: the pad byte is 0
  for (let y = 0; y < height; y++) raster.set(indices.subarray(y * width, y * width + width), y * stride);

  const body: number[] = [];
  for (let y = 0; y < height; y++) {
    for (const b of packBitsRow(raster.subarray(y * stride, y * stride + stride))) body.push(b);
  }

  const out = new Uint8Array(DIR_DATA + body.length);
  out.set(DIR_HEADER_TEMPLATE, 0);
  const dv = new DataView(out.buffer);
  dv.setUint16(DIR_HEIGHT_OFF, height, false);
  dv.setUint16(DIR_WIDTH_OFF, width, false);
  out[DIR_CHUNK] = 0x44; // 'D'
  out[DIR_CHUNK + 1] = 0x54; // 'T'
  out[DIR_CHUNK + 2] = 0x49; // 'I'
  out[DIR_CHUNK + 3] = 0x42; // 'B'   -> `DTIB`, Director's byte-reversed `BITD`
  dv.setUint32(DIR_CHUNK + 4, body.length, true);
  out.set(Uint8Array.from(body), DIR_DATA);
  return out;
}

/* ------------------------------------------------------------------- decode */

function rgbaFromIndices(indices: Uint8Array, count: number, palette: number[][] | undefined): Uint8Array {
  const rgba = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const c = palette ? palette[indices[i]] : undefined;
    const o = i * 4;
    if (c) {
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = indices[i];
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}

export function decodeMemberMedia(
  bytes: Uint8Array,
  fallbackPalette?: number[][],
): MediaBlob | null {
  if (isMdp1(bytes)) return decodeMdp1(bytes);
  if (!isDirectorMedia(bytes)) return null;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = dv.getUint16(DIR_HEIGHT_OFF, false);
  const width = dv.getUint16(DIR_WIDTH_OFF, false);
  const chunkLength = dv.getUint32(DIR_CHUNK + 4, true);
  const body = bytes.subarray(DIR_DATA, Math.min(bytes.length, DIR_DATA + chunkLength));
  if (width <= 0 || height <= 0 || body.length === 0) return null;

  // The rows are word-aligned, so the decoded size is the stride, not the width.
  // Cross-check the header against it and prefer the measurement when a writer
  // ever disagrees: stride = decoded / height, width = stride rounded down to an
  // even pixel count.
  const stride = evenStride(width);
  let raster = new Uint8Array(stride * height);
  let rowStride = stride;
  let w = width;
  if (packBitsRows(body, raster, stride, height) < 0) {
    // A writer that disagrees with us about the pitch: measure it from the
    // stream instead of trusting the header (total / height, rounded down to an
    // even pixel count).
    const total = decodeAll(body);
    if (total < 0 || total % height !== 0 || total / height <= 0) return null;
    rowStride = total / height;
    w = rowStride - (rowStride & 1);
    if (w <= 0) return null;
    raster = new Uint8Array(rowStride * height);
    if (packBitsRows(body, raster, rowStride, height) < 0) return null;
  }

  // Crop the pad column(s) out of each row.
  const cropped = new Uint8Array(w * height);
  for (let y = 0; y < height; y++) cropped.set(raster.subarray(y * rowStride, y * rowStride + w), y * w);
  return finish(cropped, w, height, fallbackPalette);
}

/** Total decoded bytes of a PackBits stream, ignoring row structure. */
function decodeAll(src: Uint8Array): number {
  let i = 0;
  let out = 0;
  while (i < src.length) {
    const c = src[i++];
    if (c < 0x80) {
      const n = c + 1;
      if (i + n > src.length) return -1;
      i += n;
      out += n;
    } else if (c === 0x80) {
      // no-op
    } else {
      if (i >= src.length) return -1;
      i++;
      out += 0x101 - c;
    }
  }
  return out;
}

function finish(indices: Uint8Array, width: number, height: number, palette?: number[][]): MediaBlob {
  return {
    width,
    height,
    rgba: rgbaFromIndices(indices, width * height, palette),
    indices,
    palette,
  };
}

function decodeMdp1(bytes: Uint8Array): MediaBlob | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[4];
  const width = dv.getUint16(5, true);
  const height = dv.getUint16(7, true);
  const paletteCount = dv.getUint16(9, true);
  const count = width * height;
  if (count <= 0) return null;
  let off = MDP1_HEADER;
  const palette: number[][] = [];
  for (let i = 0; i < paletteCount; i++) {
    if (off + 3 > bytes.length) return null;
    palette.push([bytes[off], bytes[off + 1], bytes[off + 2]]);
    off += 3;
  }
  if (off + 4 > bytes.length) return null;
  const dataLength = dv.getUint32(off, true);
  off += 4;
  if (off + dataLength > bytes.length) return null;
  const table = palette.length ? palette : undefined;
  if ((flags & 1) !== 0) {
    if (dataLength < count) return null;
    return finish(bytes.slice(off, off + count), width, height, table);
  }
  if (dataLength < count * 4) return null;
  return { width, height, rgba: bytes.slice(off, off + count * 4), palette: table };
}
