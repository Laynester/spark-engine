import type { Handler, Script } from './ast.js';
import { matteRegionMask } from '../stage/matte.js';

export type LVal =
  | number
  | string
  | LSymbol
  | LPoint
  | LRect
  | LList
  | LPropList
  | LObject
  | LMemberRef
  | LSpriteRef
  | LCastLibRef
  | LWindowRef
  | LImage
  | LColor
  | LStageRef
  | LScriptRef
  | LEmptyValue
  | null;

export class LSymbol {
  constructor(public name: string) {}
}

export class LPoint {
  constructor(public locH = 0, public locV = 0) {}
}

export class LRect {
  constructor(public left = 0, public top = 0, public right = 0, public bottom = 0) {}
  get width(): number {
    return this.right - this.left;
  }
  get height(): number {
    return this.bottom - this.top;
  }
}

export class LList {
  constructor(public items: LVal[] = []) {}
}

export class PropPairs implements Map<string, LVal> {
  private ks: string[] = [];
  private vs: LVal[] = [];
  private index: Map<string, number> | null = null;
  /**
   * lowercased key -> the first stored key with that fold, plus how many stored
   * keys share it. This is the O(1) accelerator for [`resolvePropKey`], and every
   * mutator below keeps it in step, so it can never go stale. Built lazily, so a
   * small proplist never pays for it.
   *
   * Why it matters: without it a case-insensitive proplist WRITE is a linear scan
   * of the whole key list, and the corpus writes huge proplists — `Resource
   * Manager Class::preIndexMembers` keys `pAllMemNumList` by every member name in
   * every castLib (~10k inserts at boot). Measured in isolation: 10k inserts cost
   * 786ms linear vs 4ms indexed (and 1000 misses on the 10k map 133ms vs 0ms),
   * which is ~800ms of the client's boot.
   */
  private lower: Map<string, { key: string; n: number }> | null = null;

  private addLower(key: string): void {
    if (!this.lower) return;
    const fold = key.toLowerCase();
    const entry = this.lower.get(fold);
    if (entry) entry.n++;
    else this.lower.set(fold, { key, n: 1 });
  }

  /** Called AFTER the key is spliced out, so the successor lookup sees the rest. */
  private removeLower(key: string): void {
    const lower = this.lower;
    if (!lower) return;
    const fold = key.toLowerCase();
    const entry = lower.get(fold);
    if (!entry) return;
    if (--entry.n <= 0) {
      lower.delete(fold);
      return;
    }
    if (entry.key === key) {
      // The fold's representative went away (a proplist with two spellings of one
      // key, e.g. #Foo and #foo); the next stored key with that fold takes over.
      const next = this.ks.find((k) => k.toLowerCase() === fold);
      if (next !== undefined) entry.key = next;
    }
  }

  private ensureLower(): Map<string, { key: string; n: number }> {
    if (this.lower) return this.lower;
    const lower = new Map<string, { key: string; n: number }>();
    for (const k of this.ks) {
      const fold = k.toLowerCase();
      const entry = lower.get(fold);
      if (entry) entry.n++;
      else lower.set(fold, { key: k, n: 1 });
    }
    this.lower = lower;
    return lower;
  }

  /**
   * The first stored key whose lowercase form matches `key` (the caller checks for
   * an exact match first — see `resolvePropKey`). A miss is authoritative: every
   * key added through `set`/`append` and removed through `delete`/`deleteAt` is
   * counted, so no unaccounted key can be holding that fold.
   */
  lowerKey(key: string): string | undefined {
    return this.ensureLower().get(key.toLowerCase())?.key;
  }

  constructor(entries?: Iterable<[string, LVal]> | null) {
    if (entries) {
      for (const [k, v] of entries) {
        this.ks.push(k);
        this.vs.push(v);
      }
    }
  }

  get size(): number {
    return this.ks.length;
  }

  private ensureIndex(): void {
    if (this.index) return;
    const idx = new Map<string, number>();
    const ks = this.ks;
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (!idx.has(k)) idx.set(k, i);
    }
    this.index = idx;
  }

  private firstIndex(key: string): number {
    const ks = this.ks;
    const n = ks.length;
    if (n < 12) {
      for (let i = 0; i < n; i++) if (ks[i] === key) return i;
      return -1;
    }
    this.ensureIndex();
    const i = this.index!.get(key);
    return i === undefined ? -1 : i;
  }

  clear(): void {
    this.ks = [];
    this.vs = [];
    this.index = null;
    this.lower = null;
  }

  delete(key: string): boolean {
    const i = this.firstIndex(key);
    if (i < 0) return false;
    this.ks.splice(i, 1);
    this.vs.splice(i, 1);
    this.index = null;
    this.removeLower(key);
    return true;
  }

  forEach(callbackfn: (value: LVal, key: string, map: Map<string, LVal>) => void, thisArg?: unknown): void {
    const ks = this.ks;
    const vs = this.vs;
    for (let i = 0; i < ks.length; i++) callbackfn.call(thisArg, vs[i], ks[i], this);
  }

  get(key: string): LVal | undefined {
    const i = this.firstIndex(key);
    return i >= 0 ? this.vs[i] : undefined;
  }

  has(key: string): boolean {
    return this.firstIndex(key) >= 0;
  }

  set(key: string, value: LVal): this {
    const i = this.firstIndex(key);
    if (i >= 0) this.vs[i] = value;
    else {
      this.ks.push(key);
      this.vs.push(value);
      if (this.index) this.index.set(key, this.vs.length - 1);
      this.addLower(key);
    }
    return this;
  }

  append(key: string, value: LVal): void {
    this.ks.push(key);
    this.vs.push(value);
    if (this.index && !this.index.has(key)) this.index.set(key, this.vs.length - 1);
    this.addLower(key);
  }

  getAt(n: number): LVal | undefined {
    return this.vs[n - 1];
  }

  setAt(n: number, value: LVal): void {
    if (n >= 1 && n <= this.vs.length) this.vs[n - 1] = value;
  }

  deleteAt(n: number): void {
    const i = n - 1;
    if (i >= 0 && i < this.vs.length) {
      const key = this.ks[i];
      this.ks.splice(i, 1);
      this.vs.splice(i, 1);
      this.index = null;
      this.removeLower(key);
    }
  }

  *keys(): IterableIterator<string> {
    for (const k of this.ks) yield k;
  }

  *values(): IterableIterator<LVal> {
    for (const v of this.vs) yield v;
  }

  *entries(): IterableIterator<[string, LVal]> {
    const ks = this.ks;
    const vs = this.vs;
    for (let i = 0; i < ks.length; i++) yield [ks[i], vs[i]] as [string, LVal];
  }

  [Symbol.iterator](): IterableIterator<[string, LVal]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }
}

export class LPropList {
  props: PropPairs;
  constructor(props: Map<string, LVal> = new PropPairs()) {
    if (props instanceof PropPairs) this.props = props;
    else {
      const converted = new PropPairs();
      for (const [k, v] of props) converted.append(k, v);
      this.props = converted;
    }
  }

  getAt(n: number): LVal | undefined {
    return this.props.getAt(n);
  }

  setAt(n: number, value: LVal): void {
    this.props.setAt(n, value);
  }

  deleteAt(n: number): void {
    this.props.deleteAt(n);
  }
}

export class LObject {
  script: Script | null;
  lenient = false;
  constructor(
    public scriptName: string,
    script: Script | null,
    public handlers: Map<string, Handler>,
    public props: Map<string, LVal> = new Map(),
    public id = '',
  ) {
    this.script = script;
  }
}

export class LScriptRef {
  constructor(public script: Script) {}
}

export class LMemberRef {
  constructor(
    public number: number,
    public name: string,
    public kind: string,
    public castLibNumber = 1,
    public host?: MemberHost,
  ) {}
}

export class LSpriteRef {
  constructor(public channel: number, public host?: MemberHost) {}
}

export class LCastLibRef {
  constructor(public number: number, public name: string, public host?: MemberHost) {}
}

export class LWindowRef {
  constructor(public id: string, public host?: MemberHost) {}
}

/**
 * Inverse of the projective map that sends the unit square to the four
 * destination points `quad` = [x0,y0, x1,y1, x2,y2, x3,y3] (top-left,
 * top-right, bottom-right, bottom-left), returned row-major as a 3x3 matrix
 * [m00,m01,m02, m10,m11,m12, m20,m21,m22]. Applying it to a destination pixel
 * `(X, Y, 1)` yields the normalized source coordinate `(u, v)`. Returns `null`
 * when the quad is degenerate (a zero-area or unbounded projective map).
 *
 * This is what Director does for a four-point `destinationRect`:
 * `image.copyPixels(src, [p0, p1, p2, p3], srcRect)` paints the source rect onto
 * the QUADRILATERAL, not into its bounding box — the hh_entry_jp 3D screen
 * scroller folds its 2D canvas through exactly such quads. For a parallelogram
 * the projective map is exactly affine, which is every quad the corpus builds
 * by shearing; a true perspective quad (the four corners not forming a
 * parallelogram) is handled by the same matrix.
 */
export function inverseQuadTransform(quad: readonly number[]): number[] | null {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const sq = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const g = (sq * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sq * dy1) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  // Invert [a b c; d e f; g h 1].
  const det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    (e - f * h) * inv, (c * h - b) * inv, (b * f - c * e) * inv,
    (f * g - d) * inv, (a - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

export class LImage {
  data: Uint8Array | null = null;
  dirty = false;
  palette?: number[][];
  depth = 32;
  indices?: Uint8Array | null = null;
  paletteRef: LVal = VOID;
  useAlpha = false;

  constructor(public width = 0, public height = 0) {}

  ensure(): Uint8Array {
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    const need = w * h * 4;
    if (!this.data || this.data.length < need) this.data = new Uint8Array(need);
    return this.data;
  }

  resize(w: number, h: number): void {
    this.width = Math.max(0, Math.round(w));
    this.height = Math.max(0, Math.round(h));
    this.data = null;
    this.dirty = true;
  }

  remapPalette(target: number[][]): void {
    const src = this.palette;
    if (!src || !target || src.length < 2 || target.length < 2) return;
    const data = this.data;
    if (!data) return;
    const lut = new Map<string, number>();
    for (let i = 0; i < src.length; i++) {
      const k = `${src[i][0]},${src[i][1]},${src[i][2]}`;
      if (!lut.has(k)) lut.set(k, i);
    }
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    for (let y = 0; y < h; y++) {
      let o = y * w * 4;
      for (let x = 0; x < w; x++) {
        const k = `${data[o]},${data[o + 1]},${data[o + 2]}`;
        const idx = lut.get(k);
        if (idx !== undefined && idx < target.length) {
          data[o] = target[idx][0];
          data[o + 1] = target[idx][1];
          data[o + 2] = target[idx][2];
        }
        o += 4;
      }
    }
    this.palette = target;
    this.dirty = true;
  }

  remapPaletteByIndices(indices: Uint8Array, target: number[][]): void {
    if (!target || target.length < 2) return;
    const data = this.data;
    if (!data) return;
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    for (let y = 0; y < h; y++) {
      let o = y * w * 4;
      for (let x = 0; x < w; x++) {
        const idx = indices[y * w + x];
        if (idx < target.length) {
          data[o] = target[idx][0];
          data[o + 1] = target[idx][1];
          data[o + 2] = target[idx][2];
        }
        o += 4;
      }
    }
    this.palette = target;
    this.dirty = true;
  }

  private clamp(l: number, t: number, r: number, b: number) {
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    const x1 = Math.max(0, Math.min(w, Math.round(l)));
    const y1 = Math.max(0, Math.min(h, Math.round(t)));
    const x2 = Math.max(0, Math.min(w, Math.round(r)));
    const y2 = Math.max(0, Math.min(h, Math.round(b)));
    if (x1 >= x2 || y1 >= y2) return null;
    return { x1, y1, x2, y2 };
  }

  fillRect(l: number, t: number, r: number, b: number, color: LColor | null): void {
    const rc = this.clamp(l, t, r, b);
    if (!rc || !color) return;
    this.dirty = true;
    const data = this.ensure();
    const w = Math.max(0, Math.round(this.width));
    for (let y = rc.y1; y < rc.y2; y++) {
      let o = (y * w + rc.x1) * 4;
      for (let x = rc.x1; x < rc.x2; x++) {
        data[o++] = color.red;
        data[o++] = color.green;
        data[o++] = color.blue;
        data[o++] = 255;
      }
    }
  }

  drawRect(l: number, t: number, r: number, b: number, color: LColor | null, lineSize = 1): void {
    const rc = this.clamp(l, t, r, b);
    if (!rc || !color) return;
    const ls = Math.max(1, Math.round(lineSize) || 1);
    this.fillRect(rc.x1, rc.y1, rc.x2, Math.min(rc.y2, rc.y1 + ls), color);
    this.fillRect(rc.x1, Math.max(rc.y1, rc.y2 - ls), rc.x2, rc.y2, color);
    this.fillRect(rc.x1, rc.y1, Math.min(rc.x2, rc.x1 + ls), rc.y2, color);
    this.fillRect(Math.max(rc.x1, rc.x2 - ls), rc.y1, rc.x2, rc.y2, color);
  }

  drawOval(l: number, t: number, r: number, b: number, color: LColor | null, lineSize = 1): void {
    const rc = this.clamp(l, t, r, b);
    if (!rc || !color) return;
    const cx = (rc.x1 + rc.x2) / 2;
    const cy = (rc.y1 + rc.y2) / 2;
    const rx = Math.max(0.5, (rc.x2 - rc.x1) / 2);
    const ry = Math.max(0.5, (rc.y2 - rc.y1) / 2);
    const ls = Math.max(1, Math.round(lineSize) || 1);
    this.dirty = true;
    const data = this.ensure();
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    for (let y = rc.y1; y < rc.y2; y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (dy < -1 || dy > 1) continue;
      const half = Math.sqrt(Math.max(0, 1 - dy * dy)) * rx;
      const x1 = Math.max(rc.x1, Math.ceil(cx - half));
      const x2 = Math.min(rc.x2 - 1, Math.floor(cx + half));
      for (let x = x1; x <= x2; x++) {
        const fromEdge = Math.min(x - x1, x2 - x);
        if (fromEdge >= ls || x < 0 || x >= w || y < 0 || y >= h) continue;
        const o = (y * w + x) * 4;
        data[o] = color.red;
        data[o + 1] = color.green;
        data[o + 2] = color.blue;
        data[o + 3] = 255;
      }
    }
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: LColor | null): void {
    if (!color) return;
    this.dirty = true;
    const data = this.ensure();
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    let x = Math.round(x1);
    let y = Math.round(y1);
    const ex = Math.round(x2);
    const ey = Math.round(y2);
    const dx = Math.abs(ex - x);
    const sx = x < ex ? 1 : -1;
    const dy = -Math.abs(ey - y);
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      if (x >= 0 && x < w && y >= 0 && y < h) {
        const o = (y * w + x) * 4;
        data[o] = color.red;
        data[o + 1] = color.green;
        data[o + 2] = color.blue;
        data[o + 3] = 255;
      }
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  copyPixels(
    src: LImage,
    destRect: LRect,
    srcRect: LRect,
    ink = 0,
    blend = 255,
    backgroundKeyRgb = 0xffffff,
    mask: LImage | null = null,
    flipH = false,
    flipV = false,
    foreColorRgb = 0x000000,
    fgExplicit = false,
    bgExplicit = false,
    orient?: { a: number; b: number; c: number; d: number; e: number; f: number },
    quad?: readonly number[] | null,
  ): void {
    const s = src.ensure();
    const d = this.ensure();
    const sw = Math.max(0, Math.round(src.width));
    const sh = Math.max(0, Math.round(src.height));
    const dw = Math.max(0, Math.round(this.width));
    const dh = Math.max(0, Math.round(this.height));
    const dx = Math.round(destRect.left);
    const dy = Math.round(destRect.top);
    const sx0 = Math.round(srcRect.left);
    const sy0 = Math.round(srcRect.top);
    const srcW = Math.round(srcRect.right - srcRect.left);
    const srcH = Math.round(srcRect.bottom - srcRect.top);
    const destW = Math.round(destRect.right - destRect.left);
    const destH = Math.round(destRect.bottom - destRect.top);
    if (srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) return;
    this.dirty = true;

    const fullSurface =
      dx === 0 && dy === 0 && destW === dw && destH === dh &&
      sx0 === 0 && sy0 === 0 && srcW === sw && srcH === sh;
    if (fullSurface && !this.palette && src.palette) this.palette = src.palette;

    const maskData = mask ? mask.ensure() : null;
    const maskW = mask ? Math.max(0, Math.round(mask.width)) : 0;
    const maskH = mask ? Math.max(0, Math.round(mask.height)) : 0;

    const srcPalette = src.palette;
    const hasPalette = srcPalette && srcPalette.length > 0;
    const matteMask = (ink === 8 || ink === 7) ? matteRegionMask(s, sw, sh, sx0, sy0, srcW, srcH, srcPalette, src.indices, ink === 8) : null;
    const srcBgRgb = ink === 36 && hasPalette && (src.depth ?? 32) <= 8 ? srcPalette[0] : null;

    const orientDet = orient ? orient.a * orient.e - orient.b * orient.d : 0;
    const orientInv = orientDet !== 0 ? 1 / orientDet : 0;
    // A four-point destination maps the source onto the quad: sample through
    // the inverse projective map and skip every destination pixel whose (u, v)
    // falls outside the unit square (the quad's bounding-box corners are NOT
    // part of a sheared quad).
    const quadInv = quad ? inverseQuadTransform(quad) : null;
    for (let y = 0; y < destH; y++) {
      const py = dy + y;
      if (py < 0 || py >= dh) continue;
      const fy = flipV ? destH - 1 - y : y;
      const syRow = sy0 + Math.trunc((fy * srcH) / destH);
      const orientV = orient && orientInv !== 0 ? (py - dy) / destH : 0;
      if (!quadInv && !orient && (syRow < 0 || syRow >= sh)) continue;
      for (let x = 0; x < destW; x++) {
        const px = dx + x;
        if (px < 0 || px >= dw) continue;
        let sx: number;
        let sy: number;
        if (quadInv) {
          const qx = px + 0.5;
          const qy = py + 0.5;
          const w = quadInv[6] * qx + quadInv[7] * qy + quadInv[8];
          if (w === 0) continue;
          const u = (quadInv[0] * qx + quadInv[1] * qy + quadInv[2]) / w;
          const v = (quadInv[3] * qx + quadInv[4] * qy + quadInv[5]) / w;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          sx = sx0 + Math.trunc(u * srcW);
          sy = sy0 + Math.trunc(v * srcH);
        } else if (orient && orientInv !== 0) {
          const u = (px - dx) / destW;
          sx = sx0 + Math.trunc((orient.e * (u - orient.c) - orient.b * (orientV - orient.f)) * orientInv * srcW);
          sy = sy0 + Math.trunc((-orient.d * (u - orient.c) + orient.a * (orientV - orient.f)) * orientInv * srcH);
          if (sx >= sx0 + srcW) sx = sx0 + srcW - 1;
          if (sy >= sy0 + srcH) sy = sy0 + srcH - 1;
        } else {
          const fx = flipH ? destW - 1 - x : x;
          sx = sx0 + Math.trunc((fx * srcW) / destW);
          sy = syRow;
        }
        if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;
        if (matteMask && matteMask[(sy - sy0) * srcW + (sx - sx0)] === 1) continue;
        const si = (sy * sw + sx) * 4;
        if (ink === 8 && s[si + 3] === 0) continue;
        if (ink === 1 && s[si + 3] === 0) continue;
        if (mask && maskData && sx >= 0 && sx < maskW && sy >= 0 && sy < maskH) {
          const mi = (sy * maskW + sx) * 4;
          if (mask.depth <= 8) {
            const luma = ((77 * maskData[mi] + 150 * maskData[mi + 1] + 29 * maskData[mi + 2] + 128) >> 8) & 0xff;
            if (luma >= 250) continue;
          } else if (maskData[mi + 3] === 0) {
            continue;
          }
        }
        if (srcBgRgb && s[si + 3] >= 128 && s[si] === srcBgRgb[0] && s[si + 1] === srcBgRgb[1] && s[si + 2] === srcBgRgb[2]) {
          continue;
        }
        const di = (py * dw + px) * 4;
        const out = applyInkPixel(s, si, d, di, ink, blend, backgroundKeyRgb, foreColorRgb, fgExplicit, bgExplicit);
        d[di] = out[0];
        d[di + 1] = out[1];
        d[di + 2] = out[2];
        d[di + 3] = out[3];
        if (this.depth <= 8) d[di + 3] = 255;
      }
    }
  }

  crop(l: number, t: number, r: number, b: number): LImage {
    const rc = this.clamp(l, t, r, b);
    if (!rc || !this.data) return new LImage(0, 0);
    const out = new LImage(rc.x2 - rc.x1, rc.y2 - rc.y1);
    const srcW = Math.max(0, Math.round(this.width));
    const dst = out.ensure();
    const row = out.width * 4;
    for (let y = rc.y1; y < rc.y2; y++) {
      const so = (y * srcW + rc.x1) * 4;
      dst.set(this.data.subarray(so, so + row), (y - rc.y1) * row);
    }
    out.palette = this.palette;
    const srcH = Math.max(0, Math.round(this.height));
    if (this.indices && this.indices.length >= srcW * srcH) {
      const oi = new Uint8Array(out.width * out.height);
      for (let y = rc.y1; y < rc.y2; y++) {
        oi.set(this.indices.subarray(y * srcW + rc.x1, y * srcW + rc.x2), (y - rc.y1) * out.width);
      }
      out.indices = oi;
    }
    return out;
  }
}

export class LColor {
  paletteIndex?: number;
  constructor(public red = 0, public green = 0, public blue = 0) {}
}

function combineAlpha(srcAlpha: number, blendAlpha: number): number {
  if (srcAlpha <= 0 || blendAlpha <= 0) return 0;
  if (srcAlpha >= 255) return blendAlpha;
  if (blendAlpha >= 255) return srcAlpha;
  return Math.trunc((srcAlpha * blendAlpha) / 255);
}

function alphaBlendPixel(sr: number, sg: number, sb: number, sa: number, dr: number, dg: number, db: number, da: number): [number, number, number, number] {
  if (sa <= 0) return [dr, dg, db, da];
  if (sa >= 255) return [sr, sg, sb, 255];
  // Straight-alpha "over": a_out = sa + da * (1 - sa).
  //
  // The old formula divided the SOURCE term by sa a second time
  // (`(sa * sa + da * inv) / 255`) and clamped with max(., sa), which silently
  // DROPPED the destination alpha on every blended draw: an ink-36 element at
  // blend 50 over a solid panel left the panel at alpha 191, so the room showed
  // through it. That is the catalogue purse/credits row (`habbo_catalogue.window`
  // blends 20/30) and the kiosk roommatic input veils (`whitepixel`, blends 70
  // and 20); measuring the element buffers showed exactly the broken outputs,
  // alpha 201/214 where a 21%-transparent hole sat over the panel.
  //
  // The destination weight also has to carry da, not 255, or the colour is
  // darkened when drawing onto a still-transparent buffer. For an opaque
  // destination (da = 255, the common case) both terms collapse to the previous
  // colour maths, so only the alpha — and the transparent-destination colour —
  // change.
  const dw = (da * (255 - sa)) / 255;
  const a = sa + dw;
  if (a <= 0) return [dr, dg, db, da];
  const r = Math.round((sr * sa + dr * dw) / a);
  const g = Math.round((sg * sa + dg * dw) / a);
  const b = Math.round((sb * sa + db * dw) / a);
  return [r, g, b, Math.round(a)];
}

function maskAlphaFromPixel(s: Uint8Array, si: number): number {
  return s[si + 3];
}


function applyInkPixel(
  s: Uint8Array,
  si: number,
  d: Uint8Array,
  di: number,
  ink: number,
  blend: number,
  backgroundKeyRgb: number,
  foreColorRgb = 0x000000,
  fgExplicit = false,
  bgExplicit = false,
): [number, number, number, number] {
  const sa = s[si + 3];
  let sr = s[si];
  let sg = s[si + 1];
  let sb = s[si + 2];
  const dr = d[di];
  const dg = d[di + 1];
  const db = d[di + 2];
  const da = d[di + 3];

  const srcRgb = (sr << 16) | (sg << 8) | sb;
  if ((ink === 0 && (fgExplicit || bgExplicit)) || (ink === 8 && fgExplicit)) {
    const maxC = Math.max(sr, sg, sb);
    const minC = Math.min(sr, sg, sb);
    if (maxC - minC <= 16) {
      const effFgR = fgExplicit ? (foreColorRgb >> 16) & 0xff : 0;
      const effFgG = fgExplicit ? (foreColorRgb >> 8) & 0xff : 0;
      const effFgB = fgExplicit ? foreColorRgb & 0xff : 0;
      const effBgR = bgExplicit ? (backgroundKeyRgb >> 16) & 0xff : 255;
      const effBgG = bgExplicit ? (backgroundKeyRgb >> 8) & 0xff : 255;
      const effBgB = bgExplicit ? backgroundKeyRgb & 0xff : 255;
      if (effFgR !== 0 || effFgG !== 0 || effFgB !== 0 || effBgR !== 255 || effBgG !== 255 || effBgB !== 255) {
        const gray = (sr + sg + sb) / 3;
        const fgGray = (effFgR + effFgG + effFgB) / 3;
        if (Math.abs(gray - fgGray) > 24) {
          const t = gray / 255;
          sr = Math.round((1 - t) * effFgR + t * effBgR);
          sg = Math.round((1 - t) * effFgG + t * effBgG);
          sb = Math.round((1 - t) * effFgB + t * effBgB);
        }
      }
    }
  }

  if (ink === 1) {
    if (sa === 0) return [dr, dg, db, da];
    return srcRgb === 0xffffff ? [dr, dg, db, da] : [sr, sg, sb, 255];
  }
  if (ink === 2) {
    return [dr ^ sr, dg ^ sg, db ^ sb, 255];
  }
  if (ink === 3) {
    return [Math.trunc((sr + dr) / 2), Math.trunc((sg + dg) / 2), Math.trunc((sb + db) / 2), 255];
  }
  if (ink === 4) {
    return [255 - sr, 255 - sg, 255 - sb, 255];
  }
  if (ink === 5) {
    return srcRgb === 0 ? [dr, dg, db, da] : [255 - sr, 255 - sg, 255 - sb, 255];
  }
  if (ink === 6) {
    return [dr ^ (255 - sr), dg ^ (255 - sg), db ^ (255 - sb), 255];
  }
  if (ink === 7) {
    return [
      Math.trunc(((255 - sr) + dr) / 2),
      Math.trunc(((255 - sg) + dg) / 2),
      Math.trunc(((255 - sb) + db) / 2),
      255,
    ];
  }
  if (ink === 8) {
    if (sa === 0) return [dr, dg, db, da];
    if (blend < 255) {
      const matteAlpha = Math.trunc((sa * blend) / 255);
      return matteAlpha === 0 ? [dr, dg, db, da] : alphaBlendPixel(sr, sg, sb, matteAlpha, dr, dg, db, da);
    }
    return alphaBlendPixel(sr, sg, sb, sa, dr, dg, db, da);
  }
  if (ink === 9) {
    const alpha = combineAlpha(sa, maskAlphaFromPixel(s, si));
    return alpha === 0 ? [dr, dg, db, da] : alphaBlendPixel(sr, sg, sb, alpha, dr, dg, db, da);
  }
  if (ink === 36) {
    if (sa === 0 || srcRgb === (backgroundKeyRgb & 0x00ffffff)) return [dr, dg, db, da];
    if (blend < 255 || sa < 255) {
      return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
    }
    return [sr, sg, sb, 255];
  }
  if (ink === 32) {
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (ink === 33) {
    return [Math.min(255, sr + dr), Math.min(255, sg + dg), Math.min(255, sb + db), 255];
  }
  if (ink === 34) {
    return [sr + dr, sg + dg, sb + db, 255];
  }
  if (ink === 35) {
    return [Math.max(0, dr - sr), Math.max(0, dg - sg), Math.max(0, db - sb), 255];
  }
  if (ink === 37 || ink === 40) {
    if (sa === 0) return [dr, dg, db, da];
    return [Math.max(sr, dr), Math.max(sg, dg), Math.max(sb, db), 255];
  }
  if (ink === 38) {
    return [dr - sr, dg - sg, db - sb, 255];
  }
  if (ink === 39) {
    if (sa === 0) return [dr, dg, db, da];
    return [Math.min(sr, dr), Math.min(sg, dg), Math.min(sb, db), 255];
  }
  if (ink === 41) {
    if (sa === 0) return [dr, dg, db, da];
    const br = (backgroundKeyRgb >> 16) & 0xff;
    const bg = (backgroundKeyRgb >> 8) & 0xff;
    const bb = backgroundKeyRgb & 0xff;
    const tr = Math.trunc((sr * br) / 255);
    const tg = Math.trunc((sg * bg) / 255);
    const tb = Math.trunc((sb * bb) / 255);
    return alphaBlendPixel(tr, tg, tb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (ink === 42 || ink === 43) {
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }

  if (blend < 255) {
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (sa === 0) return [dr, dg, db, da];
  if (sa < 255) return alphaBlendPixel(sr, sg, sb, sa, dr, dg, db, da);
  return [sr, sg, sb, 255];
}

export function colorFrom(v: LVal): LColor | null {
  if (v instanceof LColor) return v;
  if (typeof v === 'number') return intColor(v);
  if (typeof v === 'string') return hexColor(v);
  if (v instanceof LList && v.items.length >= 3) {
    return new LColor(Math.round(asNum(v.items[0])), Math.round(asNum(v.items[1])), Math.round(asNum(v.items[2])));
  }
  if (v instanceof LPropList && v.props.has('color')) return colorFrom(v.props.get('color')!);
  return null;
}

export function intColor(n: number): LColor {
  const i = Math.round(n);
  return new LColor((i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff);
}

export function hexColor(s: string): LColor | null {
  let h = s.trim().replace(/^#/, '');
  // Director reads the colour from the LEADING hex digits and ignores whatever
  // follows them, so `rgb("FFFF33 Hello")` is the same yellow as `rgb("FFFF33")`.
  // The corpus depends on that: the stickie note window takes its paper colour
  // from `rgb(ttype)` where `ttype` is the first word of the item-data string the
  // server sends (Havana/R39 `IDATA` writes the colour, a SPACE, then the note
  // text into one field). A strict six-character test made every note with text
  // black while an empty one (colour alone) rendered fine.
  const leading = /^[0-9a-fA-F]{6}/.exec(h);
  if (leading) return intColor(parseInt(leading[0], 16));
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return intColor(parseInt(h, 16));
}

export class LStageRef {
  constructor(public width = 720, public height = 540) {}
}

export class LEmptyValue {}

export const LEMPTY = new LEmptyValue();
export const VOID: LVal = null;

export interface MemberHost {
  getMemberProp(m: LMemberRef, prop: string): LVal;
  setMemberProp(m: LMemberRef, prop: string, value: LVal): void;
  getSpriteProp(s: LSpriteRef, prop: string): LVal;
  setSpriteProp(s: LSpriteRef, prop: string, value: LVal): void;
  getCastLibProp(c: LCastLibRef, prop: string): LVal;
  setCastLibProp(c: LCastLibRef, prop: string, value: LVal): void;
  getWindowProp(w: LWindowRef, prop: string): LVal;
  setWindowProp(w: LWindowRef, prop: string, value: LVal): void;
  setMemberChunkProp(m: LMemberRef, chunk: string, from: number | undefined, to: number | undefined, prop: string, value: LVal): void;
  memberScript(m: LMemberRef): Script | null;
}

export function isTruthy(v: LVal): boolean {
  if (v === null) return false;
  if (v instanceof LEmptyValue) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

export function lingoListCompare(x: LVal, y: LVal): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const sx = toLingoString(x).toLowerCase();
  const sy = toLingoString(y).toLowerCase();
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

export function lingoEquals(a: LVal, b: LVal): boolean {
  if (a === null || b === null) {
    if (a === null && typeof b === 'number') return 0 === b;
    if (b === null && typeof a === 'number') return a === 0;
    return a === b;
  }
  if (a instanceof LEmptyValue || b instanceof LEmptyValue) {
    if (a instanceof LEmptyValue && b instanceof LEmptyValue) return true;
    if (a instanceof LEmptyValue && typeof b === 'string') return b.length === 0;
    if (b instanceof LEmptyValue && typeof a === 'string') return a.length === 0;
    return false;
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  // Lingo symbols fold case (#Info and #info are the SAME symbol) — and `=` is
  // the comparison proplist lookups use, so this is what makes symbol keys and
  // FUSE id lists case-insensitive (getOne/getPos/deleteOne/case-of).
  if (a instanceof LSymbol && b instanceof LSymbol) return a.name.toLowerCase() === b.name.toLowerCase();
  if (a instanceof LSymbol && typeof b === 'string') return a.name.toLowerCase() === b.toLowerCase();
  if (typeof a === 'string' && b instanceof LSymbol) return a.toLowerCase() === b.name.toLowerCase();
  if (typeof a === 'number' && typeof b === 'string') {
    const nb = Number(b);
    return !Number.isNaN(nb) && a === nb;
  }
  if (typeof a === 'string' && typeof b === 'number') {
    const na = Number(a);
    return !Number.isNaN(na) && na === b;
  }
  if (a instanceof LPoint && b instanceof LPoint) return a.locH === b.locH && a.locV === b.locV;
  if (a instanceof LRect && b instanceof LRect) return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  if (a instanceof LSpriteRef && b instanceof LSpriteRef) return a.channel === b.channel;
  if (a instanceof LMemberRef && b instanceof LMemberRef) return a.number === b.number && a.castLibNumber === b.castLibNumber;
  if (a instanceof LColor && b instanceof LColor) {
    return a.red === b.red && a.green === b.green && a.blue === b.blue;
  }
  if (a instanceof LObject && b instanceof LObject) return a === b;
  if (a instanceof LList && b instanceof LList) {
    if (a === b) return true;
    if (a.items.length !== b.items.length) return false;
    for (let i = 0; i < a.items.length; i++) {
      if (!lingoEquals(a.items[i], b.items[i])) return false;
    }
    return true;
  }
  if (a instanceof LPropList && b instanceof LPropList) {
    if (a === b) return true;
    if (a.props.size !== b.props.size) return false;
    const bKeys = [...b.props.keys()];
    for (const [k, v] of a.props) {
      const bi = bKeys.findIndex((bk) => bk === k && b.props.get(bk) !== undefined && lingoEquals(b.props.get(bk) as LVal, v));
      if (bi < 0) return false;
      bKeys.splice(bi, 1);
    }
    return true;
  }
  return false;
}

const INTEGER_KEY_RE = /^\d+$/;
const IDENT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function propKeyToString(k: string): string {
  const raw = rawKeyOf(k);
  if (raw !== k) return toLingoString(raw);
  if (INTEGER_KEY_RE.test(k)) return k;
  if (IDENT_KEY_RE.test(k)) return '#' + k;
  return JSON.stringify(k);
}

export function toLingoString(v: LVal): string {
  if (v === null) return 'VOID';
  if (v instanceof LEmptyValue) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof LSymbol) return '#' + v.name;
  if (v instanceof LPoint) return `point(${v.locH}, ${v.locV})`;
  if (v instanceof LRect) return `rect(${v.left}, ${v.top}, ${v.right}, ${v.bottom})`;
  if (v instanceof LList) {
    const n = v.items.length;
    if (n === 0) return '[]';
    let s = '[';
    for (let i = 0; i < n; i++) {
      if (i > 0) s += ', ';
      s += toLingoString(v.items[i]);
    }
    return s + ']';
  }
  if (v instanceof LPropList) {
    const parts: string[] = [];
    for (const [k, val] of v.props) {
      parts.push(`${propKeyToString(k)}: ${toLingoString(val)}`);
    }
    return '[' + parts.join(', ') + ']';
  }
  if (v instanceof LObject) return v.scriptName;
  if (v instanceof LScriptRef) return `script(${v.script.name || 'unnamed'})`;
  if (v instanceof LMemberRef) return `member(${v.number} of castLib ${v.castLibNumber})`;
  if (v instanceof LSpriteRef) return `sprite(${v.channel})`;
  if (v instanceof LCastLibRef) return `castLib(${v.number})`;
  if (v instanceof LWindowRef) return `window(${v.id})`;
  if (v instanceof LImage) return `image(${v.width}, ${v.height})`;
  // Director stringifies a colour as `rgb(r, g, b)` (or `paletteIndex(n)`), not
  // `color(...)`. The corpus slices that text apart: the pool's swimsuit window
  // builds what it sends to the server from `string(pSwimSuitColor)` by cutting
  // `char[5..length]` off the first item and `char[1..length-1]` off the third
  // (`Pellehyppy Interface Class` / `Mountain Interface Class`), i.e. it assumes
  // the "rgb(" prefix and the trailing ")". With `color(` the red channel came
  // out as `value("r(255")` = 0, so every swimsuit colour was sent to the room
  // as "0,G,B".
  if (v instanceof LColor) {
    if (v.paletteIndex !== undefined) return `paletteIndex(${v.paletteIndex})`;
    return `rgb(${v.red}, ${v.green}, ${v.blue})`;
  }
  if (v instanceof LStageRef) return `stage(${v.width}, ${v.height})`;
  return String(v);
}

/** The subset of PropPairs/Map used to resolve a stored key. */
export interface PropKeyLookup {
  keys(): IterableIterator<string>;
  has(k: string): boolean;
  /** Optional O(1) case-fold accelerator (PropPairs provides it — see lowerKey). */
  lowerKey?(k: string): string | undefined;
}

/**
 * Resolve a proplist/object key the way Lingo compares it. SYMBOL lookups
 * fold case (Director: "In property lists, symbols aren't case-sensitive, but
 * strings are case-sensitive" — drmx2004 scripting ref); STRING lookups match
 * the stored spelling exactly. Keys are STORED as written (getPropAt/
 * toLingoString keep the author's casing); a folded symbol hit returns the
 * stored key so writes reuse it — a mixed-case read/write pair can never grow
 * a case twin. Pass `symbol` from the access form: bracket/getaProp keys keep
 * symbolness when the source was `#name`; dot/identifier keys always fold.
 *
 * Corpus reason: `hh_room_utils/0071 Respect Manager Class` asks for `#Info`
 * on a table created under `#info`, and the dropmenu margin keys mix
 * `#marginh`/`#marginH`. The friend_list_drag regression (U169) came from
 * ALSO folding the STRING `"Friend List_drag"` onto the art key
 * `"friend_list_drag"`: `Resource_Manager::createMember`'s
 * `not voidp(pAllMemNumList[tMemName])` guard then found the art member's
 * number and returned it instead of allocating a buffer, so
 * `Window_Instance::buildVisual` painted the 220x29 window buffer over the
 * drag-strip art (invisible in-game, fine in the standalone probe).
 */
export function resolvePropKey(props: PropKeyLookup, key: string, symbol = true): string | undefined {
  if (props.has(key)) return key;
  if (!symbol) return undefined;
  // PropPairs carries a maintained fold index, so the fallback scan is only for a
  // plain Map (object instance props) and never runs for corpus proplists.
  if (props.lowerKey) return props.lowerKey(key);
  const lower = key.toLowerCase();
  for (const k of props.keys()) {
    if (k.toLowerCase() === lower) return k;
  }
  return undefined;
}

export function keyOf(v: LVal): string | undefined {
  if (v instanceof LSymbol) return v.name;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v instanceof LPoint) return `\u0000point:${v.locH},${v.locV}`;
  if (v instanceof LRect) return `\u0000rect:${v.left},${v.top},${v.right},${v.bottom}`;
  return undefined;
}

export function rawKeyOf(key: string): LVal {
  if (key.startsWith('\u0000point:')) {
    const parts = key.slice(7).split(',');
    if (parts.length === 2) return new LPoint(Number(parts[0]), Number(parts[1]));
  }
  if (key.startsWith('\u0000rect:')) {
    const parts = key.slice(6).split(',');
    if (parts.length === 4) {
      return new LRect(Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3]));
    }
  }
  return key;
}

export function fontStyleFlags(fontStyle: LVal | undefined): { italic: boolean; bold: boolean; underline: boolean } {
  const flags = { italic: false, bold: false, underline: false };
  if (fontStyle === undefined || fontStyle === null) return flags;
  const items: LVal[] =
    fontStyle instanceof LList ? fontStyle.items :
    fontStyle instanceof LPropList ? [...fontStyle.props.values()] :
    [fontStyle];
  for (const it of items) {
    const n = it instanceof LSymbol ? it.name : typeof it === 'string' ? it : '';
    const lower = n.toLowerCase();
    if (lower === 'italic') flags.italic = true;
    else if (lower === 'bold') flags.bold = true;
    else if (lower === 'underline') flags.underline = true;
  }
  return flags;
}

export function ilkOf(v: LVal): LSymbol {
  if (v === null) return new LSymbol('void');
  if (v instanceof LEmptyValue) return new LSymbol('empty');
  if (typeof v === 'number') return new LSymbol(Number.isInteger(v) ? 'integer' : 'float');
  if (typeof v === 'string') return new LSymbol('string');
  if (v instanceof LSymbol) return new LSymbol('symbol');
  if (v instanceof LPoint) return new LSymbol('point');
  if (v instanceof LRect) return new LSymbol('rect');
  if (v instanceof LList) return new LSymbol('list');
  if (v instanceof LPropList) return new LSymbol('propList');
  if (v instanceof LObject) return new LSymbol('instance');
  if (v instanceof LScriptRef) return new LSymbol('script');
  if (v instanceof LMemberRef) return new LSymbol('member');
  if (v instanceof LSpriteRef) return new LSymbol('sprite');
  if (v instanceof LCastLibRef) return new LSymbol('castLib');
  if (v instanceof LWindowRef) return new LSymbol('window');
  if (v instanceof LImage) return new LSymbol('image');
  if (v instanceof LColor) return new LSymbol('color');
  return new LSymbol('datatype');
}

export function duplicateValue(v: LVal): LVal {
  if (v instanceof LList) return new LList(v.items.map(duplicateValue));
  if (v instanceof LPropList) {
    const props = new PropPairs();
    for (const [k, val] of v.props) props.append(k, duplicateValue(val));
    return new LPropList(props);
  }
  if (v instanceof LPoint) return new LPoint(v.locH, v.locV);
  if (v instanceof LRect) return new LRect(v.left, v.top, v.right, v.bottom);
  if (v instanceof LColor) return new LColor(v.red, v.green, v.blue);
  if (v instanceof LImage) {
    const d = new LImage(v.width, v.height);
    if (v.data) d.data = v.data.slice();
    d.palette = v.palette;
    d.paletteRef = v.paletteRef;
    d.depth = v.depth;
    if (v.indices) d.indices = v.indices.slice();
    return d;
  }
  return v;
}

function listPlusList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) + asNum(b.items[i]));
  return new LList(out);
}

function listPlusScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) + n));
}

function listMinusList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) - asNum(b.items[i]));
  return new LList(out);
}

function listMinusScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) - n));
}

function scalarMinusList(s: LVal, a: LList): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => n - asNum(it)));
}

function listMulList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) * asNum(b.items[i]));
  return new LList(out);
}

function listMulScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) * n));
}

export function lingoAdd(a: LVal, b: LVal): LVal {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (a instanceof LPoint && b instanceof LPoint) return new LPoint(a.locH + b.locH, a.locV + b.locV);
  if (a instanceof LPoint && b instanceof LList && b.items.length >= 2) {
    return new LPoint(a.locH + asNum(b.items[0]), a.locV + asNum(b.items[1]));
  }
  if (a instanceof LPoint && typeof b === 'number') return new LPoint(a.locH + b, a.locV + b);
  if (a instanceof LList && a.items.length >= 2 && b instanceof LPoint) {
    return new LPoint(asNum(a.items[0]) + b.locH, asNum(a.items[1]) + b.locV);
  }
  if (typeof a === 'number' && b instanceof LPoint) return new LPoint(a + b.locH, a + b.locV);
  if (a instanceof LRect && b instanceof LRect) return new LRect(a.left + b.left, a.top + b.top, a.right + b.right, a.bottom + b.bottom);
  if (a instanceof LRect && b instanceof LPoint) return new LRect(a.left + b.locH, a.top + b.locV, a.right + b.locH, a.bottom + b.locV);
  if (a instanceof LPoint && b instanceof LRect) return new LRect(b.left + a.locH, b.top + a.locV, b.right + a.locH, b.bottom + a.locV);
  if (a instanceof LRect && b instanceof LList && b.items.length >= 4) {
    return new LRect(a.left + asNum(b.items[0]), a.top + asNum(b.items[1]), a.right + asNum(b.items[2]), a.bottom + asNum(b.items[3]));
  }
  if (a instanceof LRect && typeof b === 'number') return new LRect(a.left + b, a.top + b, a.right + b, a.bottom + b);
  if (typeof a === 'number' && b instanceof LRect) return new LRect(a + b.left, a + b.top, a + b.right, a + b.bottom);
  if (a instanceof LList && b instanceof LList) return listPlusList(a, b);
  if (a instanceof LList && !(b instanceof LList)) return listPlusScalar(a, b);
  if (b instanceof LList && !(a instanceof LList)) return listPlusScalar(b, a);
  if (a instanceof LColor && b instanceof LColor) {
    return new LColor(Math.min(255, a.red + b.red), Math.min(255, a.green + b.green), Math.min(255, a.blue + b.blue));
  }
  if (typeof a === 'string' || typeof b === 'string') return toLingoString(a) + toLingoString(b);
  return null;
}

export function lingoSubtract(a: LVal, b: LVal): LVal {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof LPoint && b instanceof LPoint) return new LPoint(a.locH - b.locH, a.locV - b.locV);
  if (a instanceof LPoint && b instanceof LList && b.items.length >= 2) {
    return new LPoint(a.locH - asNum(b.items[0]), a.locV - asNum(b.items[1]));
  }
  if (a instanceof LPoint && typeof b === 'number') return new LPoint(a.locH - b, a.locV - b);
  if (a instanceof LList && a.items.length >= 2 && b instanceof LPoint) {
    return new LPoint(asNum(a.items[0]) - b.locH, asNum(a.items[1]) - b.locV);
  }
  if (typeof a === 'number' && b instanceof LPoint) return new LPoint(a - b.locH, a - b.locV);
  if (a instanceof LRect && b instanceof LRect) return new LRect(a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom);
  if (a instanceof LRect && b instanceof LPoint) return new LRect(a.left - b.locH, a.top - b.locV, a.right - b.locH, a.bottom - b.locV);
  if (a instanceof LRect && b instanceof LList && b.items.length >= 4) {
    return new LRect(a.left - asNum(b.items[0]), a.top - asNum(b.items[1]), a.right - asNum(b.items[2]), a.bottom - asNum(b.items[3]));
  }
  if (a instanceof LRect && typeof b === 'number') return new LRect(a.left - b, a.top - b, a.right - b, a.bottom - b);
  if (typeof a === 'number' && b instanceof LRect) return new LRect(a - b.left, a - b.top, a - b.right, a - b.bottom);
  if (a instanceof LList && b instanceof LList) return listMinusList(a, b);
  if (a instanceof LList && !(b instanceof LList)) return listMinusScalar(a, b);
  if (b instanceof LList && !(a instanceof LList)) return scalarMinusList(a, b);
  if (a instanceof LColor && b instanceof LColor) {
    return new LColor(Math.max(0, a.red - b.red), Math.max(0, a.green - b.green), Math.max(0, a.blue - b.blue));
  }
  return null;
}

function parseDirFloat(s: string): number | null {
  if (s === '') return null;
  const t = s.trim();
  if (t === '' || t === '-') return 0;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

export function lingoMultiply(a: LVal, b: LVal): LVal {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  if (typeof a === 'string' && typeof b === 'number') {
    if (b === 0) return 0;
    const n = parseDirFloat(a);
    return n === null ? 123456789 : n * b;
  }
  if (typeof a === 'number' && typeof b === 'string') {
    return (parseDirFloat(b) ?? 0) * a;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return (parseDirFloat(a) ?? 0) * (parseDirFloat(b) ?? 0);
  }
  if (a instanceof LPoint && b instanceof LPoint) return new LPoint(a.locH * b.locH, a.locV * b.locV);
  if (a instanceof LPoint && b instanceof LList && b.items.length >= 2) {
    return new LPoint(a.locH * asNum(b.items[0]), a.locV * asNum(b.items[1]));
  }
  if (a instanceof LPoint && typeof b === 'number') return new LPoint(a.locH * b, a.locV * b);
  if (a instanceof LList && a.items.length >= 2 && b instanceof LPoint) {
    return new LPoint(asNum(a.items[0]) * b.locH, asNum(a.items[1]) * b.locV);
  }
  if (typeof a === 'number' && b instanceof LPoint) return new LPoint(a * b.locH, a * b.locV);
  if (a instanceof LRect && b instanceof LRect) return new LRect(a.left * b.left, a.top * b.top, a.right * b.right, a.bottom * b.bottom);
  if (a instanceof LRect && b instanceof LList && b.items.length >= 4) {
    return new LRect(a.left * asNum(b.items[0]), a.top * asNum(b.items[1]), a.right * asNum(b.items[2]), a.bottom * asNum(b.items[3]));
  }
  if (a instanceof LRect && typeof b === 'number') return new LRect(a.left * b, a.top * b, a.right * b, a.bottom * b);
  if (typeof a === 'number' && b instanceof LRect) return new LRect(a * b.left, a * b.top, a * b.right, a * b.bottom);
  if (a instanceof LList && b instanceof LList) return listMulList(a, b);
  if (a instanceof LList && !(b instanceof LList)) return listMulScalar(a, b);
  if (b instanceof LList && !(a instanceof LList)) return listMulScalar(b, a);
  return null;
}

function divSafe(x: number, d: number): number {
  return d === 0 ? 0 : x / d;
}

function listDivScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => divSafe(asNum(it), n)));
}

function scalarDivList(s: LVal, a: LList): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => divSafe(n, asNum(it))));
}

function listDivList(a: LList, b: LList): LList {
  return new LList(a.items.map((it, i) => divSafe(asNum(it), asNum(b.items[i] ?? 0))));
}

/**
 * Element-wise list division, the `/` counterpart of lingoAdd/lingoSubtract/
 * lingoMultiply. Director applies an arithmetic operator to every element when
 * one side is a list (`[255, 128, 0] / 255.0` -> `[1.0, 0.50196, 0]`), but `/`
 * had no list branch and fell through to `asNum(list)` = 0, so the whole
 * expression became 0 (or truncated toward zero for integer lists).
 *
 * hh_roomdimmer's Color Converter Class opens both converters with a list
 * divide (`RGBtoHSL`: `tRGB = tRGB / 255.0`, `HSLtoRGB`: `tHSL = tHSL / 255.0`),
 * so without this the room dimmer's entire colour pipeline evaluates to 0 and
 * the dimmer never applies a preset. Returns null when neither side is a list
 * so the interpreter keeps its float-aware scalar path.
 */
export function lingoDivide(a: LVal, b: LVal): LVal {
  if (a instanceof LList && b instanceof LList) return listDivList(a, b);
  if (a instanceof LList) return listDivScalar(a, b);
  if (b instanceof LList) return scalarDivList(a, b);
  return null;
}

export function lingoMod(a: LVal, b: LVal): LVal | null {
  if (a instanceof LList) {
    const d = asNum(b);
    const safe = (x: number): number => (d === 0 ? 0 : Math.trunc(x % d));
    return new LList(a.items.map((it) => (typeof it === 'number' ? safe(it) : safe(asNum(it)))));
  }
  return null;
}

export function lingoNegate(v: LVal): LVal | null {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return -v;
  if (v instanceof LPoint) return new LPoint(-v.locH, -v.locV);
  if (v instanceof LRect) return new LRect(-v.left, -v.top, -v.right, -v.bottom);
  if (v instanceof LList) {
    return new LList(v.items.map((it) => -asNum(it)));
  }
  return null;
}

export function asNum(v: LVal): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  if (v instanceof LSpriteRef) return v.channel;
  if (v instanceof LMemberRef) return v.number;
  return 0;
}

export function lingoConcat(v: LVal): string {
  if (v === null) return '';
  if (v instanceof LEmptyValue) return '';
  if (v instanceof LSymbol) return v.name;
  return toLingoString(v);
}
