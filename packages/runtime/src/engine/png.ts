// Minimal DEFLATE decompressor + PNG decoder — dependency-free so the runtime
// works in browser and Node alike. Powers member.image reads for raw bitmaps.
// Supports the subset Director exports use: 8-bit, non-interlaced, color
// types 0/2/3/4/6.


class BitReader {
  private pos = 0;
  private buf = 0;
  private cnt = 0;
  constructor(private data: Uint8Array) {}
  bits(n: number): number {
    while (this.cnt < n) {
      this.buf |= this.data[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }
  byteAlign(): void {
    this.buf = 0;
    this.cnt = 0;
  }
  /** Skip n raw bytes (must be byte-aligned — used by stored blocks). */
  skip(n: number): void {
    this.pos += n;
  }
  get raw(): Uint8Array {
    return this.data;
  }
  get rawPos(): number {
    return this.pos;
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface HuffTable {
  maxLen: number;
  /** code (as read LSB-first) | (len << 16) -> symbol */
  table: Map<number, number>;
}

function bitReverse(v: number, n: number): number {
  let r = 0;
  for (let i = 0; i < n; i++) {
    r = (r << 1) | (v & 1);
    v >>>= 1;
  }
  return r;
}

/** Build a canonical-Huffman decode table from per-symbol code lengths. */
function buildTable(lengths: number[]): HuffTable {
  const counts = new Array(16).fill(0);
  let maxLen = 0;
  for (const l of lengths) {
    if (l > 0) {
      counts[l]++;
      if (l > maxLen) maxLen = l;
    }
  }
  const nextCode = new Array(16).fill(0);
  let code = 0;
  for (let l = 1; l < 16; l++) {
    code = (code + counts[l - 1]) << 1;
    nextCode[l] = code;
  }
  const table = new Map<number, number>();
  for (let sym = 0; sym < lengths.length; sym++) {
    const l = lengths[sym];
    if (l === 0) continue;
    table.set(bitReverse(nextCode[l]++, l) | (l << 16), sym);
  }
  return { maxLen, table };
}

function decodeSym(br: BitReader, t: HuffTable): number {
  let v = 0;
  for (let len = 1; len <= t.maxLen; len++) {
    v |= br.bits(1) << (len - 1);
    const hit = t.table.get(v | (len << 16));
    if (hit !== undefined) return hit;
  }
  throw new Error('deflate: bad huffman code');
}

function fixedLitLen(): number[] {
  const l = new Array(288).fill(0);
  for (let i = 0; i <= 143; i++) l[i] = 8;
  for (let i = 144; i <= 255; i++) l[i] = 9;
  for (let i = 256; i <= 279; i++) l[i] = 7;
  for (let i = 280; i <= 287; i++) l[i] = 8;
  return l;
}

/** RFC 1951 inflate. Throws on malformed data. */
function inflate(data: Uint8Array): Uint8Array {
  const br = new BitReader(data);
  const out: number[] = [];
  const fixedLit = buildTable(fixedLitLen());
  const fixedDist = buildTable(new Array(32).fill(5));
  let litT = fixedLit;
  let distT = fixedDist;
  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      // Stored block: raw bytes, no Huffman-coded data.
      br.byteAlign();
      const len = br.bits(16);
      br.bits(16); // NLEN (one's complement of LEN)
      for (let i = 0; i < len; i++) out.push(br.raw[br.rawPos + i]);
      br.skip(len);
    } else {
      if (type === 1) {
        litT = fixedLit;
        distT = fixedDist;
      } else if (type === 2) {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = br.bits(3);
        const clTable = buildTable(clLengths);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const sym = decodeSym(br, clTable);
          if (sym < 16) {
            lengths.push(sym);
          } else if (sym === 16) {
            const prev = lengths[lengths.length - 1] ?? 0;
            const rep = 3 + br.bits(2);
            for (let i = 0; i < rep; i++) lengths.push(prev);
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let i = 0; i < rep; i++) lengths.push(0);
          } else {
            const rep = 11 + br.bits(7);
            for (let i = 0; i < rep; i++) lengths.push(0);
          }
        }
        litT = buildTable(lengths.slice(0, hlit));
        distT = buildTable(lengths.slice(hlit, hlit + hdist));
      } else {
        throw new Error('deflate: reserved block type 3');
      }
      // symbol loop (Huffman-coded blocks only)
      for (;;) {
        const sym = decodeSym(br, litT);
        if (sym < 256) {
          out.push(sym);
        } else if (sym === 256) {
          break; // end of block
        } else {
          const li = sym - 257;
          if (li >= LENGTH_BASE.length) throw new Error('deflate: bad length code');
          const length = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
          const ds = decodeSym(br, distT);
          const dist = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          if (dist === 0 || dist > out.length) throw new Error('deflate: bad distance');
          for (let i = 0; i < length; i++) out.push(out[out.length - dist]);
        }
      }
    }
    if (final) break;
  }
  return Uint8Array.from(out);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Decode a PNG into raw RGBA (color types 0/2/3/4/6, 8-bit, non-interlaced).
// For INDEXED art the per-pixel palette INDICES are returned too — wall/floor
// pattern remaps recolor by index, and an RGBA-only decode loses that mapping
// when several indices share one RGB.

export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array; indices?: Uint8Array } {
  let pos = 8; // skip 8-byte signature
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (width === 0 || height === 0) throw new Error('png: no IHDR');
  if (bitDepth !== 8) throw new Error(`png: bit depth ${bitDepth} unsupported`);
  const bppMap: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (bpp === undefined) throw new Error(`png: color type ${colorType} unsupported`);
  // IDAT holds a zlib stream (CMF/FLG header + deflate + adler32). Our
  // inflate is raw DEFLATE, so strip the zlib header.
  const zlib = concatChunks(idat);
  if (zlib.length < 2) throw new Error('png: empty IDAT');
  const raw = inflate(zlib.subarray(2));
  const stride = (width * bpp);
  const out = new Uint8Array(width * height * 4);
  const idxOut = colorType === 3 ? new Uint8Array(width * height) : null;
  const px = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  const paeth = (a: number, b: number, c: number): number => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a);
    const pb = Math.abs(pp - b);
    const pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= bpp ? px[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`png: bad filter ${filter}`);
      }
      px[i] = v & 0xff;
    }
    p += stride;
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 0) {
        r = g = b = px[s];
      } else if (colorType === 2) {
        r = px[s];
        g = px[s + 1];
        b = px[s + 2];
      } else if (colorType === 4) {
        r = g = b = px[s];
        a = px[s + 1];
      } else if (colorType === 6) {
        r = px[s];
        g = px[s + 1];
        b = px[s + 2];
        a = px[s + 3];
      } else {
        if (!palette) throw new Error('png: palette missing');
        const pi = px[s] * 3;
        r = palette[pi];
        g = palette[pi + 1];
        b = palette[pi + 2];
        if (idxOut) idxOut[y * width + x] = px[s];
      }
      out[o + x * 4] = r;
      out[o + x * 4 + 1] = g;
      out[o + x * 4 + 2] = b;
      out[o + x * 4 + 3] = a;
    }
    prev.set(px);
  }
  return { width, height, rgba: out, indices: idxOut ?? undefined };
}
