
export type BakeMode = 'matte' | 'matteIdentity' | 'backgroundTransparent' | 'key' | 'notGhost';

export interface MatteSpec {
  rgb: number;
  tolerance: number;
}

const NEAR_WHITE_MIN = 232;
const NEAR_WHITE_DELTA = 16;
const CONTENT_MIN_PIXELS = 8;

/**
 * Whether an ink-39 (Darkest) bake writes its keyed rectangle as OPAQUE WHITE
 * rather than transparent (see `bakeEdgeBackground`).
 *
 * Ink 39's blend is GL MIN, which folds the keyed rectangle into the destination
 * as well: white is the identity for MIN, so an opaque white rectangle leaves the
 * room untouched where a transparent one arrives at the GPU as `(0,0,0,0)`
 * (pixi's `alphaMode` premultiplies on upload) and MINs pure black over it. The
 * identity fill is therefore only correct while a MIN blend is actually bound —
 * `PixiStage.registerInkBlendModes` sets this from `EXT_blend_minmax` / WebGL2
 * before the first bake; everywhere else (the canvas fallback) it stays off and
 * ink 39 degrades to a plain matte composite instead of pasting a white box.
 */
let matteIdentityFill = false;

export function setMatteIdentityFill(enabled: boolean): void {
  matteIdentityFill = !!enabled;
}

function matchesRgb(pixel: number, matteRgb: number, tolerance: number): boolean {
  const pr = (pixel >> 16) & 0xff;
  const pg = (pixel >> 8) & 0xff;
  const pb = pixel & 0xff;
  const mr = (matteRgb >> 16) & 0xff;
  const mg = (matteRgb >> 8) & 0xff;
  const mb = matteRgb & 0xff;
  return Math.abs(pr - mr) <= tolerance && Math.abs(pg - mg) <= tolerance && Math.abs(pb - mb) <= tolerance;
}

function isNearWhiteGrayscale(rgb: number, minChannel: number, maxDelta: number): boolean {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return (
    r >= minChannel && g >= minChannel && b >= minChannel &&
    Math.abs(r - g) <= maxDelta && Math.abs(g - b) <= maxDelta && Math.abs(r - b) <= maxDelta
  );
}

function isOpaque(rgba: Uint8Array | Uint8Array | Uint8ClampedArray, i: number): boolean {
  return rgba[i * 4 + 3] !== 0;
}

function rgbAt(rgba: Uint8Array | Uint8Array | Uint8ClampedArray, i: number): number {
  return (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
}

function cornerIndices(width: number, height: number): number[] {
  if (width <= 0 || height <= 0) return [];
  return [0, width - 1, (height - 1) * width, (height - 1) * width + (width - 1)];
}

function edgeIndices(width: number, height: number): number[] {
  const out: number[] = [];
  if (width <= 0 || height <= 0) return out;
  for (let x = 0; x < width; x++) {
    out.push(x);
    if (height > 1) out.push((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    out.push(y * width);
    if (width > 1) out.push(y * width + (width - 1));
  }
  return out;
}

function inferDominantEdgeRgb(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): number | null {
  const counts = new Map<number, number>();
  let opaqueEdgeCount = 0;
  let dominant = -1;
  let dominantCount = 0;
  for (const i of edgeIndices(width, height)) {
    if (!isOpaque(rgba, i)) continue;
    const rgb = rgbAt(rgba, i);
    const count = (counts.get(rgb) ?? 0) + 1;
    counts.set(rgb, count);
    opaqueEdgeCount++;
    if (count > dominantCount) {
      dominantCount = count;
      dominant = rgb;
    }
  }
  if (opaqueEdgeCount === 0 || dominant < 0) return null;
  let uniform = true;
  for (let i = 0; i < width * height; i++) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) !== dominant) {
      uniform = false;
      break;
    }
  }
  if (uniform) return null;
  let opaqueCornerCount = 0;
  for (const i of cornerIndices(width, height)) {
    if (!isOpaque(rgba, i)) continue;
    opaqueCornerCount++;
    if (rgbAt(rgba, i) !== dominant) return null;
  }
  if (opaqueCornerCount === 0 || dominantCount * 4 < opaqueEdgeCount * 3) return null;
  return dominant;
}

/**
 * True when a surface's opaque corners form a near-white mask ring — the
 * signature of a buffer composed at runtime whose mask was flattened to white
 * (Common Button's pieces), which therefore needs the background-transparent
 * bake even though its sprite ink is 0 (Copy).
 *
 * A surface where *every* opaque pixel is near-white is not a mask ring: it is
 * a flat fill, and keying it deletes the fill entirely. That is the catalogue
 * and purse windows' background: `catalog_bg_pixel` is a 1x1 #f0f0f0 member
 * stretched over the whole 346x412 panel at ink 0 (`ctlg_purse.window`, and the
 * same member in `habbo_catalogue.window`), so keying it punched a hole in the
 * window and let the room show through. Director's Copy ink draws all colours —
 * "including white" — opaque, so a flat fill must stay opaque. This mirrors the
 * uniform-surface bail-out in inferDominantEdgeRgb above.
 */
export function cornersAreNearWhite(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  const opaqueCorners: number[] = [];
  for (const i of cornerIndices(width, height)) {
    if (isOpaque(rgba, i)) opaqueCorners.push(rgbAt(rgba, i));
  }
  if (opaqueCorners.length === 0) return false;
  if (!opaqueCorners.every((rgb) => isNearWhiteGrayscale(rgb, NEAR_WHITE_MIN, NEAR_WHITE_DELTA))) return false;
  // Require the art the white is bordering. No opaque non-near-white pixel means
  // the white IS the whole surface (a solid panel), not a mask around artwork.
  return hasOpaqueNonNearWhiteContent(rgba, width, height, NEAR_WHITE_MIN, NEAR_WHITE_DELTA, 1);
}

function hasOpaqueNonNearWhiteContent(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  minChannel: number,
  maxDelta: number,
  minCount: number,
): boolean {
  let content = 0;
  for (let i = 0; i < width * height; i++) {
    if (!isOpaque(rgba, i)) continue;
    if (!isNearWhiteGrayscale(rgbAt(rgba, i), minChannel, maxDelta)) {
      content++;
      if (content >= minCount) return true;
    }
  }
  return false;
}

function whiteEdgeDominates(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): boolean {
  let opaqueEdge = 0;
  let whiteEdge = 0;
  for (const i of edgeIndices(width, height)) {
    if (!isOpaque(rgba, i)) continue;
    opaqueEdge++;
    if (rgbAt(rgba, i) === 0xffffff) whiteEdge++;
  }
  if (opaqueEdge === 0 || whiteEdge * 4 < opaqueEdge * 3) return false;
  for (const i of cornerIndices(width, height)) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) !== 0xffffff) return false;
  }
  return true;
}

function edgeMatteColor(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): number | null {
  if (width < 1 || height < 1 || rgba.length < 4) return null;
  if (!isOpaque(rgba, 0)) return null;
  return rgbAt(rgba, 0);
}

function resolveMatteMode(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): MatteSpec | null {
  if (borderIsTransparent(rgba, width, height)) return null;
  const p00 = edgeMatteColor(rgba, width, height);
  if (p00 === null) return null;
  return { rgb: p00, tolerance: 0 };
}

function borderIsTransparent(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, threshold = 0.5): boolean {
  let total = 0;
  let transparent = 0;
  for (const i of edgeIndices(width, height)) {
    total++;
    if (rgba[i * 4 + 3] === 0) transparent++;
  }
  return total > 0 && transparent / total >= threshold;
}

function resolveBackgroundTransparent(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): MatteSpec | null {
  let nearWhiteEdge = false;
  for (const i of edgeIndices(width, height)) {
    if (isOpaque(rgba, i) && isNearWhiteGrayscale(rgbAt(rgba, i), NEAR_WHITE_MIN, NEAR_WHITE_DELTA)) {
      nearWhiteEdge = true;
      break;
    }
  }
  if (!nearWhiteEdge) return null;
  if (!hasOpaqueNonNearWhiteContent(rgba, width, height, NEAR_WHITE_MIN, NEAR_WHITE_DELTA, CONTENT_MIN_PIXELS)) {
    return null;
  }
  return { rgb: 0xffffff, tolerance: 24 };
}

function resolveChannelMatte(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: BakeMode,
  palette?: number[][],
): MatteSpec | null {
  const p0 = paletteIndex0Rgb(palette);
  if (p0 !== null) {
    // backgroundTransparent/key honour the member's palette index 0. Matte paints
    // WHITE, so when the border is overwhelmingly white and index 0 is not, the
    // palette pick is the wrong key (see whiteBorderDominates).
    if (paintsMatteWhite(mode) && p0 !== 0xffffff && whiteBorderDominates(rgba, width, height)) {
      return { rgb: 0xffffff, tolerance: 0 };
    }
    return { rgb: p0, tolerance: 0 };
  }
  if (mode === 'backgroundTransparent') return resolveBackgroundTransparent(rgba, width, height);
  if (borderIsTransparent(rgba, width, height)) return null;
  const p00 = edgeMatteColor(rgba, width, height);
  if (p00 !== null && p00 === 0xffffff) return { rgb: p00, tolerance: 0 };
  if (whiteEdgeDominates(rgba, width, height)) return { rgb: 0xffffff, tolerance: 0 };
  if (
    whiteEdgeExists(rgba, width, height) &&
    hasOpaqueNonNearWhiteContent(rgba, width, height, NEAR_WHITE_MIN, NEAR_WHITE_DELTA, CONTENT_MIN_PIXELS)
  ) {
    return { rgb: 0xffffff, tolerance: 0 };
  }
  // Last resort for matte: an overwhelmingly white border is the white bounding
  // rectangle Director removes, even when there is no dark content to key around.
  if (paintsMatteWhite(mode) && whiteBorderDominates(rgba, width, height)) return { rgb: 0xffffff, tolerance: 0 };
  return null;
}

/** Ink 8 (matte) and ink 39 (Darkest, baked with the same keying — see
 *  `bakeModeForInk`) both paint the white bounding rectangle out. */
function paintsMatteWhite(mode: BakeMode): boolean {
  return mode === 'matte' || mode === 'matteIdentity';
}

function whiteEdgeExists(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): boolean {
  for (const i of edgeIndices(width, height)) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) === 0xffffff) return true;
  }
  return false;
}

/** At least 3/4 of the OPAQUE edge pixels are exact white.
 *
 *  Director's matte ink is defined as "Removes the white bounding rectangle
 *  around a sprite" (Adobe Director 11.5, inks table), so an overwhelmingly
 *  white border means white is the key — whatever the other pickers chose.
 *  This is the guard for the two ways a matte can go unkeyed:
 *
 *  - `resolveChannelMatte` rule 6 also demands opaque non-near-white content,
 *    so an all-white/near-white member (an empty label, a not-yet-painted
 *    element buffer such as `RoomInfoWindow_room_info_room_name`: 329 of 350
 *    edge px pure white, zero dark content) bailed out and rendered as a solid
 *    light rectangle over the room.
 *  - the pixel-(0,0) / palette-index-0 picks below can land on CONTENT — a
 *    composed buffer whose top-left pixel is a glyph or a label (obj.disp
 *    buffers: pixel00 #444444/#eeeeee with a 95% white border) — and then the
 *    white rectangle was never matched by the flood fill and got pasted in.
 *
 *  Deliberately conservative: it only fires on an overwhelmingly white border,
 *  so art that keys a non-white background colour by palette index 0 (key ink)
 *  is untouched. */
function whiteBorderDominates(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): boolean {
  let opaque = 0;
  let white = 0;
  for (const i of edgeIndices(width, height)) {
    if (!isOpaque(rgba, i)) continue;
    opaque++;
    if (rgbAt(rgba, i) === 0xffffff) white++;
  }
  return opaque > 0 && white * 4 >= opaque * 3;
}

function paletteIndex0Rgb(palette: number[][] | undefined): number | null {
  const p0 = palette && palette.length > 0 ? palette[0] : null;
  if (!p0 || p0.length < 3) return null;
  return (p0[0] << 16) | (p0[1] << 8) | p0[2];
}

export function bakeEdgeBackground(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: BakeMode,
  palette?: number[][],
  indices?: Uint8Array | null,
   keyRgb?: number | null,
   /** Optional out-param: 1 for every pixel this bake keyed (see the tint pass). */
   keyed?: Uint8Array | null,
): boolean {
  const n = width * height;
  if (width <= 0 || height <= 0 || rgba.length < n * 4) return false;

  if (mode === 'key') {
    const keyRgb = paletteIndex0Rgb(palette) ?? 0xffffff;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (isOpaque(rgba, i) && rgbAt(rgba, i) === keyRgb) {
        rgba[i * 4] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 0;
        changed = true;
      }
    }
    return changed;
  }

  let matte: MatteSpec | null = null;
  let matchByIndex = false;
  if (mode === 'notGhost') {
    const key = keyRgb !== undefined && keyRgb !== null ? keyRgb : 0xffffff;
    if (!indices || indices.length < n) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (!isOpaque(rgba, i)) continue;
        if (rgbAt(rgba, i) !== key) {
          rgba[i * 4] = 0;
          rgba[i * 4 + 1] = 0;
          rgba[i * 4 + 2] = 0;
          rgba[i * 4 + 3] = 0;
          changed = true;
        }
      }
      return changed;
    }
    matte = { rgb: key, tolerance: 0 };
  } else {
    matchByIndex = !!indices && indices.length >= n;
    matte = matchByIndex ? { rgb: 0, tolerance: 0 } : resolveChannelMatte(rgba, width, height, mode, palette);
    if (!matte) return false;
  }

  const connected = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    const i = y * width + x;
    if (connected[i]) return;
    const opaque = isOpaque(rgba, i);
    if (!opaque || (matchByIndex ? indices![i] === 0 : matchesRgb(rgbAt(rgba, i), matte.rgb, matte.tolerance))) {
      connected[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(0, y);
    seed(width - 1, y);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) seed(x - 1, y);
    if (x + 1 < width) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y + 1 < height) seed(x, y + 1);
  }

  // The keyed rectangle is written as transparent black, EXCEPT for
  // 'matteIdentity' (ink 39, Darkest): its blend is GL MIN with RGB factors
  // (ONE, ONE), so a zeroed RGB is MIN'd into the destination as pure black and
  // paints a black box where Director paints nothing. White is the identity for
  // MIN (min(255, dst) == dst), so ink 39 keys to white.
  //
  // The white has to arrive at the GPU as white, which is why the identity fill
  // is OPAQUE (255,255,255,255) and not (255,255,255,0): pixi uploads surfaces
  // with UNPACK_PREMULTIPLY_ALPHA_WEBGL on (TextureSource.alphaMode defaults to
  // 'premultiply-alpha-on-upload'), so an alpha-0 white is premultiplied to
  // (0,0,0,0) and MIN paints pure black — the black box the HC lantern's Darkest
  // layer put over its own bounding rectangle. GL MIN never looks at the source
  // alpha anyway, and the darkest blend mode carries the destination alpha
  // through (srcAlpha factor 0, dstAlpha 1), so an opaque rectangle is harmless.
  // Sprites that are not allowed the opaque fill (no MIN available) keep the
  // transparent key so a normal composite still lets the room through.
  const identity = mode === 'matteIdentity' && matteIdentityFill;
  const fill = identity ? 255 : 0;
  const fillAlpha = identity ? 255 : 0;
  let changed = false;
  for (let i = 0; i < n; i++) {
    if (!connected[i] || rgba[i * 4 + 3] === 0) continue;
    rgba[i * 4] = fill;
    rgba[i * 4 + 1] = fill;
    rgba[i * 4 + 2] = fill;
    rgba[i * 4 + 3] = fillAlpha;
    if (keyed) keyed[i] = 1;
    changed = true;
  }

  if (mode === 'notGhost') {
    for (let i = 0; i < n; i++) {
      if (rgba[i * 4 + 3] === 0) continue;
      if (!matchesRgb(rgbAt(rgba, i), matte.rgb, matte.tolerance)) {
        rgba[i * 4] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 0;
        changed = true;
      }
    }
  }
  return changed;
}

export function matteRegionMask(
  rgba: Uint8Array | Uint8ClampedArray,
  imgW: number,
  imgH: number,
  left: number,
  top: number,
  w: number,
  h: number,
  palette?: number[][],
  indices?: Uint8Array | null,
  /** ink 8 (matte paints white) rather than ink 7 (notGhost keys a colour). */
  matteInk = false,
): Uint8Array | null {
  const rl = Math.max(0, left);
  const rt = Math.max(0, top);
  const rw = Math.min(imgW, left + w) - rl;
  const rh = Math.min(imgH, top + h) - rt;
  if (rw <= 0 || rh <= 0 || imgW <= 0 || imgH <= 0) return null;

  const paletteRgb = paletteIndex0Rgb(palette);
  const indexKeyed = !!indices && indices.length >= imgW * imgH;
  let matte =
    indexKeyed ? { rgb: 0, tolerance: 0 } : paletteRgb !== null ? { rgb: paletteRgb, tolerance: 0 } : resolveMatteMode(rgba, imgW, imgH);
  // This picker has no white rule of its own, so it keys whatever sits at pixel
  // (0,0) (or a palette index 0 that is not the background). In a COMPOSED buffer
  // the top-left pixel is frequently content — a glyph, a label (“obj.disp.*
  // buffers: pixel00 #444444/#eeeeee with a 95%-white border”) — and the white
  // rectangle was then pasted in instead of keyed. Matte paints white, so prefer
  // the documented white key when the border is overwhelmingly white.
  if (matte && matteInk && !indexKeyed && matte.rgb !== 0xffffff && whiteBorderDominates(rgba, imgW, imgH)) {
    matte = { rgb: 0xffffff, tolerance: 0 };
  }
  if (!matte) return null;

  const full = new Uint8Array(imgW * imgH);
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    const i = y * imgW + x;
    if (full[i]) return;
    if (
      rgba[i * 4 + 3] === 0 ||
      (indexKeyed ? indices![i] === 0 : matchesRgb(rgbAt(rgba, i), matte.rgb, matte.tolerance))
    ) {
      full[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < imgW; x++) {
    seed(x, 0);
    seed(x, imgH - 1);
  }
  for (let y = 1; y < imgH - 1; y++) {
    seed(0, y);
    seed(imgW - 1, y);
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    const x = i % imgW;
    const y = (i - x) / imgW;
    if (x > 0) seed(x - 1, y);
    if (x + 1 < imgW) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y + 1 < imgH) seed(x, y + 1);
  }

  const mask = new Uint8Array(rw * rh);
  let background = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (full[(rt + y) * imgW + (rl + x)]) {
        mask[y * rw + x] = 1;
        background++;
      }
    }
  }
  return background > 0 ? mask : null;
}


export function tintSpriteBackground(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bgRgb: number,
  /** Pixels the bake keyed, which must keep the colour the ink needs (see bakeEdgeBackground). */
  keyed?: Uint8Array | null,
): boolean {
  const bgR = (bgRgb >> 16) & 0xff;
  const bgG = (bgRgb >> 8) & 0xff;
  const bgB = bgRgb & 0xff;
  let changed = false;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
    // An ink-39 identity rectangle is keyed to white but left OPAQUE, so the
    // alpha test above no longer filters it — recolouring it to the sprite
    // bgColor would MIN that colour over the whole rectangle.
    if (keyed && keyed[i]) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn > 16) continue;
    const t = (r + g + b) / 3 / 255;
    const nr = Math.round(t * bgR);
    const ng = Math.round(t * bgG);
    const nb = Math.round(t * bgB);
    if (nr !== r || ng !== g || nb !== b) changed = true;
    rgba[o] = nr;
    rgba[o + 1] = ng;
    rgba[o + 2] = nb;
  }
  return changed;
}

export function tintSpriteDarken(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bgRgb: number,
  fgRgb = 0,
): boolean {
  const bgR = (bgRgb >> 16) & 0xff;
  const bgG = (bgRgb >> 8) & 0xff;
  const bgB = bgRgb & 0xff;
  const fgR = (fgRgb >> 16) & 0xff;
  const fgG = (fgRgb >> 8) & 0xff;
  const fgB = fgRgb & 0xff;
  let changed = false;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const nr = Math.round(fgR + ((bgR - fgR) * r) / 255);
    const ng = Math.round(fgG + ((bgG - fgG) * g) / 255);
    const nb = Math.round(fgB + ((bgB - fgB) * b) / 255);
    if (nr !== r || ng !== g || nb !== b) changed = true;
    rgba[o] = nr;
    rgba[o + 1] = ng;
    rgba[o + 2] = nb;
  }
  return changed;
}

export function applyMaskAlpha(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  mask: Uint8Array | Uint8ClampedArray,
  mw: number,
  mh: number,
  offX: number,
  offY: number,
): boolean {
  let changed = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = x + offX;
      const my = y + offY;
      const o = (y * w + x) * 4;
      let a = rgba[o + 3];
      if (mx < 0 || my < 0 || mx >= mw || my >= mh) {
        if (a !== 0) changed = true;
        rgba[o + 3] = 0;
        continue;
      }
      const mi = (my * mw + mx) * 4;
      const gray = (mask[mi] + mask[mi + 1] + mask[mi + 2]) / 3;
      const na = Math.round((255 - gray) * (a / 255));
      if (na !== a) changed = true;
      rgba[o + 3] = na;
    }
  }
  return changed;
}

export function bakeModeForInk(ink: number): BakeMode | null {
  switch (ink) {
    case 1:
    case 36:
      return 'key';
    case 7:
      return 'notGhost';
    // 39 (Darkest) keys the same rectangle as matte but keeps it opaque WHITE:
    // GL MIN blends the keyed pixels too, so they have to be MIN's identity (see
    // the fill in bakeEdgeBackground).
    case 39:
      return 'matteIdentity';
    case 6:
      // Not Reverse composites against the destination, and its blend is the
      // shader in stage/blendFilters.ts. The matte is baked anyway: white is
      // the identity for `dst XOR ~src`, so keying it changes nothing on the
      // shader path, but it keeps the white rectangle out of the frame on
      // renderers that cannot run the shader (pixi's canvas fallback drops
      // every custom blend mode).
      return 'matte';
    case 8:
    case 32:
    case 33:
    case 34:
    case 35:
    case 37:
    case 38:
    case 40:
    case 41:
      return 'matte';
    default: return null;
  }
}

export const SUBTRACT_BLEND_MODE = 'subtract-gl';
/** Ink 39 (Darkest) — GL MIN with the destination ALPHA left alone. */
export const DARKEST_BLEND_MODE = 'darkest-gl';
/** Inks 37/40 (Lightest/Lighten) — GL MAX with the destination ALPHA left alone. */
export const LIGHTEST_BLEND_MODE = 'lightest-gl';
/** Ink 2 (Reverse) — `dst XOR src`, a shader pass (stage/blendFilters.ts). */
export const REVERSE_BLEND_MODE = 'reverse-ink-gl';
/** Ink 6 (Not Reverse) — `dst XOR ~src`, a shader pass (stage/blendFilters.ts). */
export const NOT_REVERSE_BLEND_MODE = 'notReverse-ink-gl';

/**
 * Whether ink 6 (Not Reverse) composites through the XOR shader.
 *
 * The XOR itself is faithful and verified bit-exact against the live renderer
 * (`scripts/ink-xor-blend-snippet.js`: dst ^ ~src matches the JS reference to
 * the byte, on WebGL with the back buffer on). What is NOT settled is whether
 * that is the look the HC lantern was authored for: the lantern stacks the SAME
 * stem art three times — 39 Darkest (min), 38 Subtract, then 6 — so by the time
 * ink 6 runs, the destination under the stems is already `min(green, room) -
 * green` == black, and `black XOR ~green` is (255,170,255) light pink, while
 * the keyed white shows the (black) destination. Rendered in the client that
 * reads as a broken lantern, so the destination op is left off and ink 6 stays
 * a plain composite of its matte-baked art.
 *
 * Flip this to true to see the XOR; the open question (with the exact evidence)
 * is recorded in AGENTS/MyCurrentWork.md.
 */
const INK6_XOR = false;

/**
 * Sprite-level blend mode for a Director ink.
 *
 * The three custom modes are registered by PixiStage with the destination
 * ALPHA preserved (srcAlphaFactor 0, dstAlphaFactor 1). Pixi's built-in `min` /
 * `max` use `[ONE, ONE, ONE, ONE, MIN, MIN]`, i.e. they take the MIN/MAX of the
 * alpha too, so a sprite's transparent pixels drive the destination alpha to 0
 * over the WHOLE sprite quad — every subtract/darkest part punched a hole in
 * the room behind it, the same failure the CPU composite had (see
 * alphaBlendPixel). `add` is safe because its alpha factors are (ONE, ONE) and
 * the transparent pixels contribute 0.
 *
 * Inks 3 (Ghost), 4 (Not Copy), 5 (Not Transparent) and 7 (Not Ghost) are
 * PIXEL operations against the destination (average / inverted-copy) with no
 * blend-function equivalent and no user in the corpus; they are deliberately
 * not mapped here. Inks 2 (Reverse) and 6 (Not Reverse) are XOR against the
 * destination, which GL cannot express either — they are served by shader blend
 * modes registered in stage/blendFilters.ts (name strings below).
 */
export function blendModeForInk(ink: number): 'normal' | 'add' | 'subtract-gl' | 'darkest-gl' | 'lightest-gl' | 'reverse-ink-gl' | 'notReverse-ink-gl' {
  switch (ink) {
    case 33:
    case 34:
      return 'add';
    case 35:
    case 38:
      return SUBTRACT_BLEND_MODE;
    case 37:
    case 40:
      return LIGHTEST_BLEND_MODE;
    case 39:
      return DARKEST_BLEND_MODE;
    case 2:
      return REVERSE_BLEND_MODE;
    case 6:
      return INK6_XOR ? NOT_REVERSE_BLEND_MODE : 'normal';
    case 41:
      return 'normal';
    default:
      return 'normal';
  }
}

/**
 * Bake + tint a decoded RGBA surface exactly like the image-member render path
 * (PixiStage.bakeImagePixels). Shared so the palette-forwarding rule is
 * unit-testable: key/matte/notGhost bakes key against the member's palette-0
 * (DirPlayer resolves the sprite bg color against the source bitmap's
 * palette), while the backgroundTransparent heuristic keeps its no-palette
 * path (ink-0 painted images with near-white corners). Dropping the palette
 * here made ink-36 members with a black palette-0 (hh_entry_jp's screen3d,
 * once the imagescroller paints onto its image) key white instead and render
 * as a black rectangle.
 */
export function bakeSurface(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bake: BakeMode | null,
  tint: number | null,
  ink7Key?: number | null,
  ink = 0,
  fgRgb = 0,
  palette?: number[][],
   /** Optional pre-allocated buffer to avoid per-bake allocation (see pixi.ts `bakeImagePixels`). */
   keyed?: Uint8Array | null,
): { pixels: Uint8ClampedArray; changed: boolean } {
   const n = w * h * 4;
   const buf = new Uint8ClampedArray(n);
   buf.set(src.subarray(0, n));
   // The ink-39 identity rectangle is the one keyed region that stays OPAQUE, so
   // mark it: the tint pass below skips transparent pixels but must skip these too.
   const keyedBuf = bake === 'matteIdentity' ? (keyed ?? new Uint8Array(w * h)) : null;
   const changed = bake
     ? bakeEdgeBackground(buf, w, h, bake, bake === 'backgroundTransparent' ? undefined : palette, undefined, ink7Key, keyedBuf)
     : false;
  const tinted =
    tint !== null ? (ink === 41 ? tintSpriteDarken(buf, w, h, tint, fgRgb) : tintSpriteBackground(buf, w, h, tint, keyedBuf)) : false;
  return { pixels: buf, changed: changed || tinted };
}

export function matteSpriteHitTest(
  ink: number,
  pixels: Uint8Array | Uint8ClampedArray | null | undefined,
  w: number,
  h: number,
  px: number,
  py: number,
): boolean {
  if (ink !== 8) return true;
  if (!pixels || w < 1 || h < 1) return true;
  if (px < 0 || py < 0 || px >= w || py >= h) return true;
  return pixels[(py * w + px) * 4 + 3] !== 0;
}
