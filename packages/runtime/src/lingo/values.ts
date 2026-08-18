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
  | null; // VOID

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

// Ordered key/value pair list backing a Lingo proplist. Real proplists are
// ORDERED and allow DUPLICATE keys (the wire encoder sends `[#integer: a,
// #integer: b, #integer: c]` positionally — a Map would collapse them), so
// this keeps the Map surface but stores pairs in an array. `get` returns the
// FIRST match, `set` replaces the first match or appends, `append` always
// appends; getAt/setAt/deleteAt are 1-based like Lingo's.
export class PropPairs implements Map<string, LVal> {
  // Keyed lookups scan O(n) since a Map can't hold duplicate keys — fine for
  // small proplists, but the Variable Container's pItemList (200+ entries)
  // is read on every getVariable(), so keyed reads carry a lazy first-index
  // cache. Structural edits that shift indices (delete/splice/clear) drop
  // the cache; in-place replaces and appends keep it valid.
  private pairs: Array<[string, LVal]> = [];
  private index: Map<string, number> | null = null;

  constructor(entries?: Iterable<[string, LVal]> | null) {
    if (entries) for (const [k, v] of entries) this.pairs.push([k, v]);
  }

  get size(): number {
    return this.pairs.length;
  }

  private ensureIndex(): void {
    if (this.index) return;
    const idx = new Map<string, number>();
    for (let i = 0; i < this.pairs.length; i++) {
      const k = this.pairs[i][0];
      if (!idx.has(k)) idx.set(k, i); // first occurrence, matching firstIndex
    }
    this.index = idx;
  }

  private firstIndex(key: string): number {
    this.ensureIndex();
    const i = this.index!.get(key);
    return i === undefined ? -1 : i;
  }

  clear(): void {
    this.pairs = [];
    this.index = null;
  }

  delete(key: string): boolean {
    const i = this.firstIndex(key);
    if (i < 0) return false;
    this.pairs.splice(i, 1);
    this.index = null; // splice shifts every later index
    return true;
  }

  forEach(callbackfn: (value: LVal, key: string, map: Map<string, LVal>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.pairs) callbackfn.call(thisArg, v, k, this);
  }

  get(key: string): LVal | undefined {
    const i = this.firstIndex(key);
    return i >= 0 ? this.pairs[i][1] : undefined;
  }

  has(key: string): boolean {
    return this.firstIndex(key) >= 0;
  }

  set(key: string, value: LVal): this {
    const i = this.firstIndex(key);
    if (i >= 0) this.pairs[i] = [key, value]; // C++ putTyped: replace FIRST match
    else {
      this.pairs.push([key, value]);
      this.index!.set(key, this.pairs.length - 1); // new key at the tail
    }
    return this;
  }

  // addProp / literal construction: ALWAYS append.
  append(key: string, value: LVal): void {
    this.pairs.push([key, value]);
    // A duplicate key keeps the EARLIER index (firstIndex semantics); only a
    // brand-new key needs an index entry.
    if (this.index && !this.index.has(key)) this.index.set(key, this.pairs.length - 1);
  }

  // 1-based positional read (getAt(n) → value at position n).
  getAt(n: number): LVal | undefined {
    return this.pairs[n - 1]?.[1];
  }

  // 1-based positional write — replaces the VALUE, keeps the key.
  setAt(n: number, value: LVal): void {
    const i = n - 1;
    if (i >= 0 && i < this.pairs.length) this.pairs[i] = [this.pairs[i][0], value];
  }

  // 1-based positional delete.
  deleteAt(n: number): void {
    const i = n - 1;
    if (i >= 0 && i < this.pairs.length) {
      this.pairs.splice(i, 1);
      this.index = null; // splice shifts every later index
    }
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.pairs) yield k;
  }

  *values(): IterableIterator<LVal> {
    for (const [, v] of this.pairs) yield v;
  }

  *entries(): IterableIterator<[string, LVal]> {
    for (const p of this.pairs) yield p;
  }

  [Symbol.iterator](): IterableIterator<[string, LVal]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'Map';
  }
}

export class LPropList {
  // The ordered pair backing. Engine code builds proplists with plain Maps;
  // the constructor converts them to a PropPairs COPY (never mutate the
  // source Map afterwards). `props` keeps the Map type so engine call sites
  // compile unchanged.
  props: PropPairs;
  constructor(props: Map<string, LVal> = new PropPairs()) {
    if (props instanceof PropPairs) this.props = props;
    else {
      const converted = new PropPairs();
      for (const [k, v] of props) converted.append(k, v);
      this.props = converted;
    }
  }

  // 1-based positional read (getAt(n)).
  getAt(n: number): LVal | undefined {
    return this.props.getAt(n);
  }

  // 1-based positional write — replaces the value, keeps the key.
  setAt(n: number, value: LVal): void {
    this.props.setAt(n, value);
  }

  // 1-based positional delete.
  deleteAt(n: number): void {
    this.props.deleteAt(n);
  }
}

export class LObject {
  // Script this instance was created from (null for engine-made stubs).
  script: Script | null;
  // Stub objects (connections, managers) suppress missing-handler warnings.
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

// A reference to a parent script; .new() / .construct() instantiate it.
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

export class LImage {
  // Lazily-allocated RGBA pixel buffer (width*height*4).
  data: Uint8Array | null = null;
  // Set by every pixel-writing method; the stage re-uploads the surface to
  // its texture only when dirty.
  dirty = false;
  // The bitmap's own JASC-PAL palette (index 0 = background, per DirPlayer);
  // the ink-8 matte keys off it.
  palette?: number[][];
  // Bit depth (the depth of image). Window buffers are 8-bit with a palette;
  // media images and Image Wrapper buffers default to 32.
  depth = 32;
  // Raw per-pixel palette indices when decoded from an indexed PNG — lets
  // the flood matte key palette INDEX 0 exactly (other indices whose RGB
  // matches index 0's are art and must survive). Null for RGBA surfaces.
  indices?: Uint8Array | null = null;
  // Palette member ref behind an 8-bit image (image.paletteRef) — stored so
  // `the paletteRef of image` reads back correctly; the RGBA pipeline
  // ignores it.
  paletteRef: LVal = VOID;
  // Director image.useAlpha — whether the alpha channel is honored when the
  // image is drawn (LibreShockwave's native-alpha flag). setAlpha() and
  // `image.useAlpha = ...` flip it; `the useAlpha of image` reads it back.
  useAlpha = false;

  constructor(public width = 0, public height = 0) {}

  // Ensure the RGBA buffer exists and return it.
  ensure(): Uint8Array {
    const w = Math.max(0, Math.round(this.width));
    const h = Math.max(0, Math.round(this.height));
    const need = w * h * 4;
    if (!this.data || this.data.length < need) this.data = new Uint8Array(need);
    return this.data;
  }

  // Resize the surface IN PLACE (same object identity, buffer reallocated) —
  // references captured before an image= assignment stay live.
  resize(w: number, h: number): void {
    this.width = Math.max(0, Math.round(w));
    this.height = Math.max(0, Math.round(h));
    this.data = null;
    this.dirty = true;
  }

  // Remap pixels through `target` by palette index (image.paletteRef = ...):
  // each pixel's RGB finds its index in this.palette and takes that index's
  // color from target. Swaps this.palette so remaps chain. No-op without
  // palettes or a buffer.
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

  // Indexed-PNG variant of remapPalette: recolors by TRUE palette index (from
  // the decoder) — the RGB reverse-lookup is ambiguous when several indices
  // share a color, so indexed art must remap by index.
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

  // Clamp a region to image bounds; null when fully outside.
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

  // Director image.fill(region, color) — solid fill.
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

  // Outline rectangle with `lineSize` thickness.
  drawRect(l: number, t: number, r: number, b: number, color: LColor | null, lineSize = 1): void {
    const rc = this.clamp(l, t, r, b);
    if (!rc || !color) return;
    const ls = Math.max(1, Math.round(lineSize) || 1);
    this.fillRect(rc.x1, rc.y1, rc.x2, Math.min(rc.y2, rc.y1 + ls), color);
    this.fillRect(rc.x1, Math.max(rc.y1, rc.y2 - ls), rc.x2, rc.y2, color);
    this.fillRect(rc.x1, rc.y1, Math.min(rc.x2, rc.x1 + ls), rc.y2, color);
    this.fillRect(Math.max(rc.x1, rc.x2 - ls), rc.y1, rc.x2, rc.y2, color);
  }

  // Outline ellipse (scanline ring).
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

  // Bresenham line.
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

  // Director image.copyPixels(src, destRect, srcRect, [#ink, #blend,
  // #bgColor, #maskImage]) — a port of LibreShockwave's opcode: nearest-
  // neighbor sampling (so stretched 9-slice pieces stay crisp), with MATTE
  // (8) flood-filling the source's edge-connected background to alpha 0,
  // BACKGROUND_TRANSPARENT (36) keying bg/white, the ADD/SUBTRACT/LIGHTEST/
  // DARKEST family compositing per channel, BLEND (32) + #blend alpha,
  // TRANSPARENT (1) keying exact white, and NOT_* inverting. Unmatched inks
  // copy RGBA verbatim.
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

    // Pasting an image's FULL surface into a palette-less image adopts the
    // source's palette — flipH/flipV rebuilds copy the original back over a
    // fresh image and would otherwise lose palette index 0, breaking the
    // later ink-8 matte. Restricted to full-surface copies so shared 32-bit
    // buffers never inherit a piece's palette from a partial paste.
    const fullSurface =
      dx === 0 && dy === 0 && destW === dw && destH === dh &&
      sx0 === 0 && sy0 === 0 && srcW === sw && srcH === sh;
    if (fullSurface && !this.palette && src.palette) this.palette = src.palette;

    // #maskImage: an alpha mask sized to the SOURCE, sampled at the source
    // pixel — alpha 0 there skips the copy (Human Class part masks).
    const maskData = mask ? mask.ensure() : null;
    const maskW = mask ? Math.max(0, Math.round(mask.width)) : 0;
    const maskH = mask ? Math.max(0, Math.round(mask.height)) : 0;

    // A palette-carrying source's background — palette index 0 — is
    // transparent in the copy regardless of ink. Key it EDGE-CONNECTED via a
    // whole-image flood (not a blanket RGB key) so enclosed same-RGB art
    // (cloud puffs, the avatar's white body/hair) survives. Ink 36 keeps its
    // blanket bg key below (gated to indexed depth).
    const srcPalette = src.palette;
    const hasPalette = srcPalette && srcPalette.length > 0;
    const matteMask =
      ink === 8 || (hasPalette && ink !== 36)
        ? matteRegionMask(s, sw, sh, sx0, sy0, srcW, srcH, srcPalette, src.indices)
        : null;
    // The old ink-36 near-white RGB matte is gone — the exporter blanket-keys
    // palette index 0 into every indexed PNG, so a runtime near-white
    // heuristic keyed the avatar eye whites away. Only palette-less 32-bit
    // sources rely on the ink-36 srcBgRgb blanket below.
    const srcBgRgb = ink === 36 && hasPalette && (src.depth ?? 32) <= 8 ? srcPalette[0] : null;

    // Quad orientation: non-trivial src→dest affines (90/270° rotations,
    // diagonal reflections — dropmenu/scrollbar #rotate rebuilds) sample the
    // source through the INVERSE mapping (X' = a·x' + b·y' + c, Y' = d·x' +
    // e·y' + f), like DirPlayer's copy_pixels_quad.
    const orientDet = orient ? orient.a * orient.e - orient.b * orient.d : 0;
    const orientInv = orientDet !== 0 ? 1 / orientDet : 0;
    for (let y = 0; y < destH; y++) {
      const py = dy + y;
      if (py < 0 || py >= dh) continue;
      // Quad-flip mapping: flipH/flipV mirror within the dest rect — the
      // source sample comes from the mirrored destination position.
      const fy = flipV ? destH - 1 - y : y;
      // Nearest-neighbor sampling with integer division (C++: srcTop + dy*srcH/destH).
      const syRow = sy0 + Math.trunc((fy * srcH) / destH);
      const orientV = orient && orientInv !== 0 ? (py - dy) / destH : 0;
      if (!orient && (syRow < 0 || syRow >= sh)) continue;
      for (let x = 0; x < destW; x++) {
        const px = dx + x;
        if (px < 0 || px >= dw) continue;
        let sx: number;
        let sy: number;
        if (orient && orientInv !== 0) {
          const u = (px - dx) / destW;
          // Sample through the inverse affine at the dest pixel's top-left;
          // the quad's far edge maps one pixel past srcRect.right, so clamp
          // it to the last source row/column instead of dropping it.
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
        // Ink-8 MATTE copies of ALREADY-ALPHA-KEYED sources (transparent
        // border -> borderIsTransparent skips the color matte, so the
        // transparent background is copied verbatim): into a 32-bit dest that
        // is a no-op (alpha 0), but the depth<=8 rule below forces every
        // 8-bit dest pixel opaque — an 8-bit mask built like the mode-2 text
        // path (`tFakeAlpha = image(w,h,8); copyPixels(textImage, [#ink: 8])`)
        // came out fully opaque and the maskImage composite pasted a solid
        // color block (white text -> white rectangle, black -> black boxes;
        // text.render.compatibility.mode=2, U141). Skipping alpha-0 source
        // pixels keeps the dest's own (transparent) state as the mask.
        if (ink === 8 && s[si + 3] === 0) continue;
        // #maskImage is sampled at the source pixel; out-of-range mask reads
        // DRAW (a mismatched/partial mask must not punch holes in the art).
        if (mask && maskData && sx >= 0 && sx < maskW && sy >= 0 && sy < maskH) {
          const mi = (sy * maskW + sx) * 4;
          if (mask.depth <= 8) {
            // 8-bit masks are WHITE-BACKED (image(w,h,8) pre-fills opaque
            // white, U122) — the mode-2 text path builds tFakeAlpha by an
            // ink-8 copy that leaves the white fill at the transparent bg and
            // writes the dark glyphs. Real Director samples these by LUMA,
            // inverted: white blocks, any darker pixel allows (LSW
            // maskAllowsPixel: maskAlphaFromPixel(pixel) < 255; setAlpha
            // applies the same inversion). Sampling the alpha channel saw
            // 255 everywhere and pasted the whole solid color block (U141:
            // navigator tabs/entry_bar text as white/black boxes).
            const luma = ((77 * maskData[mi] + 150 * maskData[mi + 1] + 29 * maskData[mi + 2] + 128) >> 8) & 0xff;
            if (luma >= 250) continue;
          } else if (maskData[mi + 3] === 0) {
            // 32-bit masks (createMatte) are alpha-keyed: alpha 0 blocks.
            continue;
          }
        }
        // Key the source's own background color (8-bit palette index 0),
        // leaving the destination pixel untouched so it shows what's beneath.
        if (srcBgRgb && s[si + 3] >= 128 && s[si] === srcBgRgb[0] && s[si + 1] === srcBgRgb[1] && s[si + 2] === srcBgRgb[2]) {
          continue;
        }
        const di = (py * dw + px) * 4;
        const out = applyInkPixel(s, si, d, di, ink, blend, backgroundKeyRgb, foreColorRgb, fgExplicit, bgExplicit);
        d[di] = out[0];
        d[di + 1] = out[1];
        d[di + 2] = out[2];
        d[di + 3] = out[3];
        // 8-bit destinations have no alpha channel — every pixel is an opaque
        // palette entry (blends were applied inside the group buffer). An
        // alpha < 255 here would render the whole sprite translucent against
        // the room. 32-bit surfaces keep their alpha.
        if (this.depth <= 8) d[di + 3] = 255;
      }
    }
  }

  // Copy a region into a new image (Director image.crop(rect)).
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
    // A crop of an indexed/paletted image keeps the source's palette and
    // index grid (Director semantics — image.crop returns an image with the
    // same palette). The navigator does `member.image.trimWhiteSpace()`
    // (crop) then pastes the result with ink 8: the matte must still key
    // palette index 0. The thumbnail palettes put WHITE at index 0, which
    // resolves a matte that no pixel matches -> no mask -> the black border
    // frame survives. Dropping the palette here fell back to the (0,0)-pixel
    // key, which keyed the black border itself and "clipped" it off.
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

// Director color object (ilk #color; rgb()/color() return one).
export class LColor {
  // Optional palette index behind this color — getPixel() fills it from the
  // source image's .pal so color.paletteIndex resolves without a movie-wide
  // palette lookup.
  paletteIndex?: number;
  constructor(public red = 0, public green = 0, public blue = 0) {}
}

// Combined src-alpha with blend-alpha.
function combineAlpha(srcAlpha: number, blendAlpha: number): number {
  if (srcAlpha <= 0 || blendAlpha <= 0) return 0;
  if (srcAlpha >= 255) return blendAlpha;
  if (blendAlpha >= 255) return srcAlpha;
  return Math.trunc((srcAlpha * blendAlpha) / 255);
}

// Source-over blend; output is always opaque.
function alphaBlendPixel(sr: number, sg: number, sb: number, sa: number, dr: number, dg: number, db: number, da: number): [number, number, number, number] {
  if (sa <= 0) return [dr, dg, db, da];
  if (sa >= 255) return [sr, sg, sb, 255];
  const inv = 255 - sa;
  const r = Math.trunc((sr * sa + dr * inv) / 255);
  const g = Math.trunc((sg * sa + dg * inv) / 255);
  const b = Math.trunc((sb * sa + db * inv) / 255);
  const a = Math.trunc((sa * sa + da * inv) / 255);
  return [r, g, b, Math.max(a, sa)];
}

// The source pixel's alpha channel.
function maskAlphaFromPixel(s: Uint8Array, si: number): number {
  return s[si + 3];
}

// (The old near-white matte gate was removed with the exporter's blanket
// palette-0 keying — see the copyPixels note above.)

// Per-pixel compositing rule for every Director ink: given the source pixel
// RGBA at `si` and destination at `di`, return the new dest RGBA.
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

  // Director grayscale tint: when #color/#bgColor were EXPLICITLY passed to
  // copyPixels, near-grayscale source pixels (channel span <= 16) are lerped
  // along the gray->(fg,bg) ramp — black becomes #color, white becomes
  // #bgColor — while colored detail pixels keep their RGB. This tints window
  // title text into the layout's header colors. Pixels already within 24 gray
  // of the foreground are left alone (the rasterizer draws text glyphs in
  // member.color; they must not be re-lerped).
  //
  // The ramp applies to INK 0 ONLY. Ink 8 (MATTE) tints on an explicit
  // #color alone — bgColor is inert there (DirPlayer drawing.rs: the ink-8
  // path multiplies by foreColor; bgColor belongs to ink 0 / ink 36). The
  // catalog Product Preview passes [#ink: 8, #bgColor: paletteIndex(...)] and
  // the "*ffffff" no-color marker resolves to the last palette entry (black
  // in the radiator's palette) — tinting by it turned the grunge radiator's
  // native gray art BLACK. Native art must survive an ink-8 copy that passes
  // only #bgColor.
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

  if (ink === 1) { // TRANSPARENT: exact-white key
    return srcRgb === 0xffffff ? [dr, dg, db, da] : [sr, sg, sb, 255];
  }
  if (ink === 2) { // REVERSE: dest XOR src
    return [dr ^ sr, dg ^ sg, db ^ sb, 255];
  }
  if (ink === 3) { // GHOST: average
    return [Math.trunc((sr + dr) / 2), Math.trunc((sg + dg) / 2), Math.trunc((sb + db) / 2), 255];
  }
  if (ink === 4) { // NOT_COPY: invert src
    return [255 - sr, 255 - sg, 255 - sb, 255];
  }
  if (ink === 5) { // NOT_TRANSPARENT: invert src, black key
    return srcRgb === 0 ? [dr, dg, db, da] : [255 - sr, 255 - sg, 255 - sb, 255];
  }
  if (ink === 6) { // NOT_REVERSE
    return [dr ^ (255 - sr), dg ^ (255 - sg), db ^ (255 - sb), 255];
  }
  if (ink === 7) { // NOT_GHOST
    return [
      Math.trunc(((255 - sr) + dr) / 2),
      Math.trunc(((255 - sg) + dg) / 2),
      Math.trunc(((255 - sb) + db) / 2),
      255,
    ];
  }
  if (ink === 8) { // MATTE (source already flood-filled by the mask skip)
    if (sa === 0) return [dr, dg, db, da];
    if (blend < 255) {
      const matteAlpha = Math.trunc((sa * blend) / 255);
      return matteAlpha === 0 ? [dr, dg, db, da] : alphaBlendPixel(sr, sg, sb, matteAlpha, dr, dg, db, da);
    }
    return alphaBlendPixel(sr, sg, sb, sa, dr, dg, db, da);
  }
  if (ink === 9) { // MASK: use the source's own alpha as the mask
    const alpha = combineAlpha(sa, maskAlphaFromPixel(s, si));
    return alpha === 0 ? [dr, dg, db, da] : alphaBlendPixel(sr, sg, sb, alpha, dr, dg, db, da);
  }
  if (ink === 36) { // BACKGROUND_TRANSPARENT: key the source bg color only
    if (sa === 0 || srcRgb === (backgroundKeyRgb & 0x00ffffff)) return [dr, dg, db, da];
    if (blend < 255 || sa < 255) {
      return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
    }
    return [sr, sg, sb, 255];
  }
  if (ink === 32) { // BLEND
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (ink === 33) { // ADD_PIN: clamped channel sum, alpha forced opaque
    return [Math.min(255, sr + dr), Math.min(255, sg + dg), Math.min(255, sb + db), 255];
  }
  if (ink === 34) { // ADD: unclamped channel sum, alpha forced opaque
    return [sr + dr, sg + dg, sb + db, 255];
  }
  if (ink === 35) { // SUBTRACT_PIN: dest - src clamped >= 0
    return [Math.max(0, dr - sr), Math.max(0, dg - sg), Math.max(0, db - sb), 255];
  }
  if (ink === 37 || ink === 40) { // LIGHTEST / LIGHTEN
    if (sa === 0) return [dr, dg, db, da];
    return [Math.max(sr, dr), Math.max(sg, dg), Math.max(sb, db), 255];
  }
  if (ink === 38) { // SUBTRACT: unclamped dest - src
    return [dr - sr, dg - sg, db - sb, 255];
  }
  if (ink === 39) { // DARKEST: per-channel min
    if (sa === 0) return [dr, dg, db, da];
    return [Math.min(sr, dr), Math.min(sg, dg), Math.min(sb, db), 255];
  }
  if (ink === 41) { // DARKEN: source * bgColor (LibreShockwave
    // imageMultiplyDarkenPixel + Drawing.cpp alphaBlend). Habbo avatar parts
    // are grayscale masks tinted this way — `[#ink: 41, #bgColor: tColor]`
    // (Bodypart Template defineInk): white art -> the tint, gray shading -> a
    // darker tint, black outlines stay black. The default bgColor is white,
    // which is a no-op, so plain DARKEN sprites keep copying the source.
    if (sa === 0) return [dr, dg, db, da];
    const br = (backgroundKeyRgb >> 16) & 0xff;
    const bg = (backgroundKeyRgb >> 8) & 0xff;
    const bb = backgroundKeyRgb & 0xff;
    const tr = Math.trunc((sr * br) / 255);
    const tg = Math.trunc((sg * bg) / 255);
    const tb = Math.trunc((sb * bb) / 255);
    return alphaBlendPixel(tr, tg, tb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (ink === 42 || ink === 43) { // LIGHTEN/DARKEN fallback family
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }

  // COPY (0) + unknown inks: blend when set, else source-over by alpha.
  if (blend < 255) {
    return alphaBlendPixel(sr, sg, sb, combineAlpha(sa, blend), dr, dg, db, da);
  }
  if (sa === 0) return [dr, dg, db, da];
  if (sa < 255) return alphaBlendPixel(sr, sg, sb, sa, dr, dg, db, da);
  return [sr, sg, sb, 255];
}

// Coerce a Lingo color-ish value to an LColor (null when unusable).
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

// 0xRRGGBB -> LColor.
export function intColor(n: number): LColor {
  const i = Math.round(n);
  return new LColor((i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff);
}

// "#RRGGBB" / "#RGB" -> LColor (null when unparseable).
export function hexColor(s: string): LColor | null {
  let h = s.trim().replace(/^#/, '');
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

// Engine-side host answering member/sprite/castLib/window property access.
export interface MemberHost {
  getMemberProp(m: LMemberRef, prop: string): LVal;
  setMemberProp(m: LMemberRef, prop: string, value: LVal): void;
  getSpriteProp(s: LSpriteRef, prop: string): LVal;
  setSpriteProp(s: LSpriteRef, prop: string, value: LVal): void;
  getCastLibProp(c: LCastLibRef, prop: string): LVal;
  setCastLibProp(c: LCastLibRef, prop: string, value: LVal): void;
  getWindowProp(w: LWindowRef, prop: string): LVal;
  setWindowProp(w: LWindowRef, prop: string, value: LVal): void;
  /** `member.char[1..n].font = v` — apply a property to a char range of a
   *  text member (Balloon Manager bolds the speaker name). */
  setMemberChunkProp(m: LMemberRef, chunk: string, from: number | undefined, to: number | undefined, prop: string, value: LVal): void;
  /** The Script behind a script-type cast member ref (`script(member(...))`), or null. */
  memberScript(m: LMemberRef): Script | null;
}

export function isTruthy(v: LVal): boolean {
  if (v === null) return false;
  if (v instanceof LEmptyValue) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return true;
}

// Sort comparator: both numeric -> value compare, else case-insensitive
// string compare (mismatched types stringify). Shared by sort(list) and the
// interpreter's listMethod sort.
export function lingoListCompare(x: LVal, y: LVal): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const sx = toLingoString(x).toLowerCase();
  const sy = toLingoString(y).toLowerCase();
  return sx < sy ? -1 : sx > sy ? 1 : 0;
}

export function lingoEquals(a: LVal, b: LVal): boolean {
  if (a === null || b === null) {
    // VOID coerces to 0 in numeric equality (void() = 0 is true) — the
    // corpus's `repeat while getSprById(...) <> 0` relies on it.
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
    // Director string equality ignores case (compareLingo below already
    // lowercases for < >). The pool diving game's swimjump.key.list is
    // UPPERCASE ("A","D") while `the key` reports the lowercase char from
    // the browser — translateKey's `tPelleKey = pPelleKeys[i]` needs
    // `'a' = "A"` to be true for the run keys to work.
    return a.toLowerCase() === b.toLowerCase();
  }
  if (a instanceof LSymbol && b instanceof LSymbol) return a.name === b.name;
  if (a instanceof LSymbol && typeof b === 'string') return a.name === b;
  if (typeof a === 'string' && b instanceof LSymbol) return a === b.name;
  // number <-> numeric string
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
  // Director compares lists and proplists by VALUE: `[1,2] = [1,2]` is TRUE.
  // The FUSE receipt check (Friend List/IM/Figure System checkDataLoaded)
  // compares two INDEPENDENTLY-built lists (`tReceipt <> getSpecialServices()
  // .getReceipt(tStamp)`) — reference identity made every check fail
  // ("Invalid build structure" x3). Same-reference is the fast path; deeper
  // comparisons recurse element-wise. Proplists are unordered key->value
  // maps, so equality matches every key of a to a distinct equal value in b.
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

// Value → string for concatenation, string(), value() and printing. VOID
// prints as "VOID" and EMPTY as "" (the corpus &s EMPTY into packets).
const INTEGER_KEY_RE = /^\d+$/;
const IDENT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function propKeyToString(k: string): string {
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
    // Manual join: `.map().join()` would allocate an intermediate array for
    // every stringify — wire encoders stringify big lists constantly (the
    // room-object packet builds a multi-KB list each room load).
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
  if (v instanceof LColor) return `color(${v.red}, ${v.green}, ${v.blue})`;
  if (v instanceof LStageRef) return `stage(${v.width}, ${v.height})`;
  return String(v);
}

export function keyOf(v: LVal): string | undefined {
  if (v instanceof LSymbol) return v.name;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

// Parse a Director fontStyle value ([#plain] / [#bold] / [#italic] /
// [#underline], or a bare symbol/string) into flags for the rasterizer.
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
  // Director: instances of parent scripts are ilk #instance.
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

// Clone a composite value (duplicate()). Lists/proplists are copied
// RECURSIVELY (the Layout Parser caches defs and hands out duplicates — a
// shallow copy would let buildVisual's mutations corrupt the cache).
// Points/rects/colors are value types; images are copied; script objects,
// member/sprite refs and symbols are shared.
export function duplicateValue(v: LVal): LVal {
  if (v instanceof LList) return new LList(v.items.map(duplicateValue));
  if (v instanceof LPropList) {
    // Append in insertion order so duplicate keys survive the copy.
    const props = new PropPairs();
    for (const [k, val] of v.props) props.append(k, duplicateValue(val));
    return new LPropList(props);
  }
  if (v instanceof LPoint) return new LPoint(v.locH, v.locV);
  if (v instanceof LRect) return new LRect(v.left, v.top, v.right, v.bottom);
  if (v instanceof LColor) return new LColor(v.red, v.green, v.blue);
  if (v instanceof LImage) {
    // image.duplicate() must keep palette + depth — the paletteRef remap
    // needs the source palette to recover pixel indices, and flipH/flipV
    // re-create via image(w,h,depth,paletteRef).
    const d = new LImage(v.width, v.height);
    if (v.data) d.data = v.data.slice();
    d.palette = v.palette;
    d.paletteRef = v.paletteRef;
    d.depth = v.depth;
    return d;
  }
  return v;
}

// Element-wise add of two linear lists, min length.
function listPlusList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) + asNum(b.items[i]));
  return new LList(out);
}

// Scalar added to every list item.
function listPlusScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) + n));
}

// Element-wise subtract of two linear lists, min length.
function listMinusList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) - asNum(b.items[i]));
  return new LList(out);
}

// Scalar subtracted from every list item.
function listMinusScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) - n));
}

// Scalar minus every list item.
function scalarMinusList(s: LVal, a: LList): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => n - asNum(it)));
}

// Element-wise multiply of two linear lists, min length.
function listMulList(a: LList, b: LList): LList {
  const n = Math.min(a.items.length, b.items.length);
  const out: LVal[] = [];
  for (let i = 0; i < n; i++) out.push(asNum(a.items[i]) * asNum(b.items[i]));
  return new LList(out);
}

// Scalar multiplied with every list item (commutative).
function listMulScalar(a: LList, s: LVal): LList {
  const n = asNum(s);
  return new LList(a.items.map((it) => asNum(it) * n));
}

// Arithmetic with point/rect/list shapes: point/rect accept point|list|scalar,
// list+list is element-wise (min length), list+scalar broadcasts,
// color+color clamps to 255. The corpus does window rect math on [0,0,0,0]
// lists — without it the rect collapsed to 0 and window sizing broke.
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

// `*` with point/rect/list shapes — same shape rules as lingoAdd; list*scalar
// broadcasts both ways (the avatar walk lerp is `(a - b) * t + b` on lists).
// DirPlayer float_impl parity: "" is NOT a number, whitespace-only and "-"
// coerce to 0, everything else parses normally.
function parseDirFloat(s: string): number | null {
  if (s === '') return null;
  const t = s.trim();
  if (t === '' || t === '-') return 0;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

export function lingoMultiply(a: LVal, b: LVal): LVal {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  // DirPlayer parity: an empty/non-numeric string times a NON-ZERO int yields
  // Director's arbitrary 123456789, not 0 (× 0 still gives 0). The catalogue's
  // deal gate `count >= 11 + tItemCount * 3` with tItemCount="" depends on
  // this — 0 would attach an empty dealList to every plain item.
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

// Safe modulo: a zero divisor yields 0 (not NaN), and lists mod element-wise.
// Returns null for non-numeric operands so the interpreter falls back to its
// scalar path (pet parts do `1 mod me.pAnimCounter` with a 0 counter).
export function lingoMod(a: LVal, b: LVal): LVal | null {
  if (a instanceof LList) {
    const d = asNum(b);
    const safe = (x: number): number => (d === 0 ? 0 : Math.trunc(x % d));
    return new LList(a.items.map((it) => (typeof it === 'number' ? safe(it) : safe(asNum(it)))));
  }
  return null;
}

// Unary minus: negates points/rects element-wise and lists item-wise, VOID
// coerces to 0. Returns null for scalar-incompatible values so the
// interpreter falls back to -asNum (bodypart reg-point negates rely on it).
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
  // Sprite refs coerce to their CHANNEL number, member refs to their member
  // number — `integer(sprite(5))` is 5. The visualizer does
  // `sprite(integer(tSpr))` on sprite refs; without this the wrapper would
  // write to channel 0 and walls/floors never rendered.
  if (v instanceof LSpriteRef) return v.channel;
  if (v instanceof LMemberRef) return v.number;
  return 0;
}

// String form for the `&`/`&&` operators: VOID/EMPTY concatenate as "" and a
// symbol as its name WITHOUT the # (string(sym) keeps the #, & does not) —
// CreateElement builds "window.image.class" exactly this way.
export function lingoConcat(v: LVal): string {
  if (v === null) return '';
  if (v instanceof LEmptyValue) return '';
  if (v instanceof LSymbol) return v.name;
  return toLingoString(v);
}
