
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
 * and purse windows' background: a 1x1 #f0f0f0 member stretched over the whole
 * 346x412 panel at ink 0, so keying it punched a hole in the window and let the
 * room show through. Director's Copy ink draws all colours — "including white" —
 * opaque, so a flat fill must stay opaque. This mirrors the uniform-surface
 * bail-out in inferDominantEdgeRgb above.
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
    // The matte/notGhost paths honour the member's palette index 0 (ink 8's
    // "palette-0 background" rule; ink 36 keys the sprite bgColor instead and
    // returns before this — see the `key` branch of bakeEdgeBackground).
    // Matte paints WHITE, so when the border is overwhelmingly white and index 0
    // is not, the palette pick is the wrong key (see whiteBorderDominates).
    if (paintsMatteWhite(mode) && p0 !== 0xffffff && whiteBorderDominates(rgba, width, height)) {
      return { rgb: 0xffffff, tolerance: 0 };
    }
    return { rgb: p0, tolerance: 0 };
  }
  if (mode === 'backgroundTransparent') return resolveBackgroundTransparent(rgba, width, height);
  if (borderIsTransparent(rgba, width, height)) {
    // A transparent border usually means the alpha channel already IS the mask
    // (text bitmaps are (0,0,0,0)-filled with white glyphs), so a
    // colour matte must not eat the artwork. It is NOT a reason to skip the key
    // when the surface carries a real opaque white block: the avatar canvas is
    // exactly that — `image(w,h,32)` starts transparent, `render` copies the
    // WHITE-FILLED pBuffer out of just pUpdateRect, so the drawn body sits in an
    // opaque white block surrounded by transparent canvas. Ink 36 blanket-keys
    // that block (see the 'key' path, `bakeEdgeBackground`), but the matte
    // pickers bailed out here and the white bounding rectangle around every
    // avatar came back the moment a sprite switched to matte-family ink — the
    // respect flash (ink 41) and the X-ray effect (ink 8). Key white when there
    // is opaque art for it to bound; when white IS the art, keep the bail-out.
    if (!hasOpaqueNonNearWhiteContent(rgba, width, height, NEAR_WHITE_MIN, NEAR_WHITE_DELTA, CONTENT_MIN_PIXELS)) return null;
    return { rgb: 0xffffff, tolerance: 0 };
  }
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

/**
 * Mark every pixel reachable from the image border through palette-index-0 (or
already transparent) pixels.
 *
 * This is the INDEX form of "the member's background": for indexed art the
 * palette entry IS the background, so it is the one rule that survives a palette
 * REMAP (a `paletteTarget` rewrites the RGB the pixels carry — see
 * `Engine.memberImage` -> `remapPaletteByIndices` — so a rule that matches the
 * background COLOUR by RGB stops matching the moment the art is recoloured).
 * Flood, not blanket, so art that happens to use index 0 for a sealed interior
 * region keeps it.
 *
 * Returns the reachability mask, or null when there are no usable indices. It is
 * computed against the surface AS IT ARRIVED: a pixel that a previous pass made
 * transparent must not turn into a conduit into a sealed interior region, so the
 * caller resolves it BEFORE its colour pass.
 */
function indexZeroFloodMask(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  indices: Uint8Array,
): Uint8Array | null {
  const n = width * height;
  if (width <= 0 || height <= 0 || indices.length < n) return null;
  const reachable = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    const i = y * width + x;
    if (reachable[i]) return;
    if (rgba[i * 4 + 3] !== 0 && indices[i] !== 0) return;
    reachable[i] = 1;
    queue.push(i);
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
  return reachable;
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
    // Ink 36 (Background transparent) keys the SPRITE's background colour, not
    // the member's palette entry: "Makes all the pixels in the background color
    // of the selected sprite appear transparent" (adobe_director_11.5.txt:3343),
    // where that colour is the swatch picked in the Tools window — the sprite's
    // `bgColor` — and its default is white (`copyPixels`' own `#bgColor`
    // doc, drmx2004_scripting_ref.txt:10640). `keyRgb` carries the sprite's
    // explicit bgColor when the movie set one (`tSpr.bgColor = rgb(...)`).
    //
    // The corpus agrees, and says so in code: Room_Interface_Class::validateEvent
    // (`hh_room/scripts/0003`, ~line 801) only lets a click through an ink-36
    // bitmap sprite when `tSpr.member.image.getPixel(...).hexString()` is NOT
    // "#FFFFFF" — white is the transparent colour for these sprites.
    //
    // For INDEXED art the colour pass alone is not enough: the background of the
    // window furniture and of the placed-item previews IS the member's palette
    // entry 0, and it is frequently NOT white (the window frames' `#dddddd`
    // panel, a poster's own ink), so nothing the white default matches goes and
    // the box stays — the "weirdly white unkeyed things" on wall items and the
    // white box behind an item being placed.
    //
    // That background is removed the way ink 8 removes it, and NOT by keying
    // palette-0's colour: the placed sprite is ink 8 and keys the BORDER-CONNECTED
    // index-0 region (`matteRegionMask`'s flood), which is why a placed item looks
    // right while its ink-36 preview did not. Keying the colour instead is
    // blanket, so art that happens to sit at index 0 dies with the background —
    // for an item whose palette-0 is BLACK that reads as "the black pixels are
    // transparent and the background is still there".
    //
    // The flood is a FALLBACK, run only when the colour pass keyed nothing, so it
    // can never take a second colour away from art the ink already dealt with. A
    // raster that no longer describes its pixels (`indicesStale` — the movie
    // painted over the art) is never used: hh_entry_jp's `screen3d` is a 29-entry
    // palette with BLACK at index 0, the Entry Image Scroller repaints that member
    // every tick, and the frame it paints is mostly white — a flood seeded from
    // that border keyed pixels of the freshly painted screen.
    const hasFreshRaster = !!indices && indices.length >= n;
    const key = keyRgb ?? 0xffffff;
    // Resolved BEFORE the colour pass: the pass makes every key-coloured pixel
    // transparent, and a transparent pixel is a conduit, so computing this
    // afterwards would let the keyed backdrop tunnel into a sealed interior
    // region (see indexZeroFloodMask).
    const indexMask = hasFreshRaster ? indexZeroFloodMask(rgba, width, height, indices!) : null;
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (isOpaque(rgba, i) && rgbAt(rgba, i) === key) {
        rgba[i * 4] = 0;
        rgba[i * 4 + 1] = 0;
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 0;
        changed = true;
      }
    }
    // Nothing in the colour pass matched, so the art's own background is not the
    // colour this ink names: key the border-connected index-0 region, which is the
    // background ink 8 removes from the placed sprite. `indexMask` was resolved
    // BEFORE the colour pass on purpose: keying makes a pixel a conduit for the
    // flood, so computing it afterwards would let the keyed backdrop tunnel into a
    // sealed interior region (see indexZeroFloodMask).
    if (!changed && indexMask) {
      for (let i = 0; i < n; i++) {
        if (!indexMask[i] || indices![i] !== 0 || rgba[i * 4 + 3] === 0) continue;
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
      // Not Reverse composites against the destination (the band duotone in
      // stage/blendFilters.ts), so the art's opaque WHITE corner triangles have
      // to be keyed out — the shader only ramps where the sprite has alpha, and
      // the room is what shows through where it does not. On a renderer that
      // cannot run the shader (pixi's canvas fallback) the same bake is what
      // keeps those white triangles out of the frame.
      return 'matte';
    // 4 (Not copy) is the Ice FX: `hh_human/texts/0042_text_fx.12.txt` is only
    // `human_sprite_props/[ink: 4, bgcolor: "#CCFFFF", forecolor: "#66CCFF"]`,
    // the blue twin of the x-ray (fx.11, ink 8). Ink 4 REPLACES the avatar body
    // sprite's `resetSpriteColors` ink 36 ("background transparent"), which is
    // what keys the opaque white block the Human composes its canvas over, so
    // the sprite has to keep a matte bake or a frozen avatar shows that white
    // rectangle as a box around the art.
    case 4:
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

/** Ink 35 (Subtract Pin) — GL reverse-subtract, which CLAMPS at zero. */
export const SUBTRACT_BLEND_MODE = 'subtract-gl';
/**
 * Ink 38 (Subtract) — `dst - src` WRAPPED mod 256, a shader pass
 * (stage/blendFilters.ts): Director adds 256 when the difference goes negative
 * (adobe_director_11.5.txt:3377), where GL's reverse-subtract clamps. The
 * corpus's only ink-6 item uses it, and its look depends on the wrap.
 */
export const SUBTRACT_WRAP_BLEND_MODE = 'subtractWrap-ink-gl';
/** Ink 39 (Darkest) — GL MIN with the destination ALPHA left alone. */
export const DARKEST_BLEND_MODE = 'darkest-gl';
/** Inks 37/40 (Lightest/Lighten) — GL MAX with the destination ALPHA left alone. */
export const LIGHTEST_BLEND_MODE = 'lightest-gl';
/**
 * Ink 2 (Reverse) — `dst XOR src`, a shader pass (stage/blendFilters.ts). No user
 * in the corpus; kept because it is the documented Director operator.
 */
export const REVERSE_BLEND_MODE = 'reverse-ink-gl';
/**
 * Ink 6 (Not Reverse) — served as a DESTINATION DUOTONE shader pass
 * (stage/blendFilters.ts).
 *
 * The engine's implementation is generic: whatever is behind the sprite is
 * ramped onto one green line, so it is named after the INK and not after any
 * item. Director's own definition of the ink is `dst XOR ~src`, which for the
 * corpus's one ink-6 item is arithmetically pinned to magenta (see
 * stage/blendFilters.ts), so the ink is implemented as what the real client
 * paints instead — and the values of that duotone (endpoints, curve, chroma)
 * are calibrated off the corpus's ONLY ink-6 user. A future movie that wants
 * the documented
 * XOR form should get its own mode rather than reusing this one.
 */
export const NOT_REVERSE_BLEND_MODE = 'notReverse-ink-gl';
/**
 * Inks 38/39 — PASS THROUGH. In their only corpus use the layers carrying these
 * inks sit fully under an ink-6 layer on top; leaving them arithmetic would feed
 * the ink-6 ramp a saturated destination instead of the backdrop (see
 * stage/blendFilters.ts).
 */
export const PASS_THROUGH_BLEND_MODE = 'passthrough-ink-gl';

/**
 * The ink-6 duotone's curve, calibrated off the corpus's only ink-6 user and a
 * frame captured from a real client (`scripts/probe-xray-shot.mjs` /
 * `probe-xray-band-colors.mjs` / `probe-xray-transfer.mjs` /
 * `probe-xray-window.mjs`). The names below stay generic on purpose: they
 * describe the ink's ramp, not that item.
 *
 * The band maps the brightness of the room BEHIND it onto the straight RGB line
 * from **#74fa4c** (the room's darkest tones — a lime) to **#225413** (its
 * lightest — a dark green). Every distinct colour the real band paints is on that
 * line, and both endpoints are exact palette-equivalent values from the shot.
 *
 * The transfer is `t = 1 - lum^STEEPNESS`: a plain linear `1 - lum` read a
 * little bright against the real thing (the mid tones sat closer to the lime
 * end than the shot does), while compressing the room's brightness first keeps
 * BOTH endpoints exactly where they are — the darkest room tones still paint
 * pure `#74fa4c` and the lightest pure `#225413` — and pulls everything in
 * between toward the dark green, which is the part that was too light.
 *
 * `STEEPNESS` is therefore the one knob: 1.0 is the linear ramp, anything below
 * it darkens the band, and the byte pair the calibration was read against stays
 * put. Do NOT reach for a threshold-style window here: saturating the ramp at
 * fixed luminance bytes ("lime below 66, dark green above 136") makes the band
 * BRIGHTER in a dark room, because every tone under the lower byte becomes pure
 * lime at once.
 */
export const DUOTONE_RAMP_STEEPNESS = 0.75;

/**
 * Chroma gain on the band's output, applied with the luminance held fixed. 1.0
 * is the measured palette line exactly; higher pushes every band colour away
 * from its own grey, so the greens get more vivid without the band getting
 * lighter (which is the knob that was already tuned by hand).
 *
 Had to leave the measured values behind here: the two endpoints are the exact
 * colours the real client paints, but the band still read as washed-out next to
 * it, and the pitch of a dark green is what carries that — `#225413` at 34/84/19
 * is an olive, and the same colour with its chroma pushed reads as green. The
 * luma is deliberately preserved, so this is a chroma knob ONLY: turning it up
 * must never re-light the band (that is `DUOTONE_RAMP_STEEPNESS`'s job).
 */
export const DUOTONE_RAMP_SATURATION = 1.35;

/** Luma weights, matching the shader twin below (Rec.601). */
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/** Saturate about the pixel's own luminance: `luma + (c - luma) * k`. */
export function boostSaturation(r: number, g: number, b: number, k = DUOTONE_RAMP_SATURATION): [number, number, number] {
  const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(luma + (r - luma) * k), clamp(luma + (g - luma) * k), clamp(luma + (b - luma) * k)];
}

/** The CPU twin of the band shader (stage/blendFilters.ts). */
export function duotoneRampRgb(r: number, g: number, b: number): [number, number, number] {
  const lum = (r + g + b) / 765;
  const t = Math.max(0, Math.min(1, 1 - Math.pow(lum, DUOTONE_RAMP_STEEPNESS)));
  return boostSaturation(34 + 82 * t, 84 + 166 * t, 19 + 57 * t);
}

/**
 * True for every blend mode that is a pixi `BlendModeFilter` shader pass
 * (stage/blendFilters.ts) rather than a fixed-function GL blend state.
 *
 * They all read the DESTINATION, which on WebGL only exists as a texture, so the
 * renderer must be rendering the frame into its back buffer while any of them is
 * on screen: `FilterSystem` checks `filter.blendRequired && !useBackBuffer`,
 * warns "Blend filter requires backBuffer on WebGL renderer to be enabled",
 * DISABLES the filter and draws the sprite as a normal composite — the ink then
 * looks like it does nothing at all (the ink-6 user's band art, flat
 * `#005500` with white corner triangles, painted verbatim). `PixiStage.
 * syncBackBuffer` flips `renderer.backBuffer.useBackBuffer` off this predicate.
 */
export function blendFilterMode(mode: string): boolean {
  return (
    mode === REVERSE_BLEND_MODE ||
    mode === SUBTRACT_WRAP_BLEND_MODE ||
    mode === NOT_REVERSE_BLEND_MODE ||
    mode === PASS_THROUGH_BLEND_MODE
  );
}

/**
 * The corpus's only ink-6/38/39 user is the whole story below.
 *
 * Its props are the ONLY use of inks 6 and 38 anywhere in the v31 corpus (one
 * furniture props file, plus the `s_` twin):
 *
 *   ["a": [:],       "b": [#zshift: [1],    "ink": 39], "c": [#zshift: [2],    "ink": 38],
 *    "d": [#zshift: [1000]],                       "e": [#zshift: [1001], "ink": 39],
 *    "f": [#zshift: [1002], "ink": 38],           "g": [#zshift: [3],    "ink": 6],
 *    "h": [#zshift: [1003], "ink": 6]]
 *
 * so each post stacks the SAME art three times at increasing zshift — and the
 * member aliases confirm the three copies share one bitmap
 * (`texts/0009_text_memberalias.index.txt`: c = b, and g = b, f = e, h = e). That
 * art is a DARK GREEN band: `#005500` for 1390 of the 1520 opaque pixels of the
 * base member (the other 130 are pure white corner triangles, which is also the
 * matte key).
 *
 * The live client does not run those three inks as three arithmetic passes over
 * the room. It shows the room through the band as a single green hue ramp —
 * `#74fa4c` lime where the room is darkest, `#225413` where it is lightest, and
 * `#54b936`/`#43962a`/`#33751f` in between — i.e. a DUOTONE of the destination.
 * Every arithmetic reading of 39/38/6 was tested against that and none of them
 * produces it (two are arithmetically pinned to magenta; an exhaustive search
 * over the per-channel operators finds no sequence at all — see
 * stage/blendFilters.ts). So the stack is modelled as what it looks like:
 * 38 and 39 pass through, and 6 is the measured duotone.
 *
 * Both operators therefore have to be right for the item to read as one thing:
 * the documented `dst XOR ~src` pins the band to magenta (`~#005500` has
 * R = B = 255, so those channels can only come out magenta), and keeping 38/39
 * arithmetic feeds the ramp a destination whose brightness runs the opposite
 * way to the room's.
 */

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
 * Inks 3 (Ghost), 5 (Not Transparent) and 7 (Not Ghost) are PIXEL operations
 * against the destination (average / inverted-copy) with no blend-function
 * equivalent and no user in the corpus; they are deliberately not mapped here.
 * Ink 4 (Not copy) is used, by the Ice FX (fx.12), which pairs it with the same
 * fg/bg ramp the x-ray uses — bare `normal` here plus the matte bake (see
 * `bakeModeForInk`) and the duotone (`Engine.duotoneForChannel`). Inks 2, 6, 38
 * and 39 all fold the destination in, which GL cannot express; they are served
 * by the shader blend modes registered in stage/blendFilters.ts (name strings
 * below). Ink 6 is the destination duotone and 38/39 are the covered
 * under-layers of its one corpus user (see the ink-6/38/39 note above).
 */
export function blendModeForInk(ink: number): 'normal' | 'add' | 'subtract-gl' | 'subtractWrap-ink-gl' | 'darkest-gl' | 'lightest-gl' | 'reverse-ink-gl' | 'notReverse-ink-gl' | 'passthrough-ink-gl' {
  switch (ink) {
    case 33:
    case 34:
      return 'add';
    // 35 Subtract Pin CLAMPS, which GL reverse-subtract does exactly.
    case 35:
      return SUBTRACT_BLEND_MODE;
    // 37/40 (Lightest/Lighten) are GL MAX with the destination alpha preserved.
    case 37:
    case 40:
      return LIGHTEST_BLEND_MODE;
    // 39 (Darkest) is normally per-channel MIN, but in its only use the ink-6
    // band is painted over it: see the note above.
    case 39:
      return PASS_THROUGH_BLEND_MODE;
    case 38:
      return PASS_THROUGH_BLEND_MODE;
    // 2 Reverse is `dst XOR src`; 6 (Not Reverse) is the destination duotone.
    case 2:
      return REVERSE_BLEND_MODE;
    case 6:
      return NOT_REVERSE_BLEND_MODE;
    case 41:
      return 'normal';
    default:
      return 'normal';
  }
}

/**
 * Bake + tint a decoded RGBA surface exactly like the image-member render path
 * (PixiStage.bakeImagePixels). Shared so the keying rules are unit-testable:
 *
 *  - `key` (inks 36/1) keys the sprite's background colour — `keyRgb` when the
 *    movie set one, otherwise WHITE (see the `key` branch of
 *    bakeEdgeBackground for the Director reference and the corpus evidence);
 *  - `matte`/`notGhost` key against the member's palette-0 (the sprite bg
 *    colour resolves against the source bitmap's palette);
 *  - `backgroundTransparent` keeps its no-palette heuristic (ink-0 painted
 *    images with near-white corners), which must NOT be handed a palette: the
 *    heuristic's member may be an 8-bit art whose palette-0 is white, and
 *    forwarding it would key the whole image instead of the mask ring.
 */
/**
 * The palette and index raster an IMAGE bake may use for a surface that stands in
 * for a member (`PixiStage.bakeImagePixels`).
 *
 * A palette may only name the background of art whose pixels it INDEXES, so the
 * two travel together and only while the raster still describes the surface
 * (`indicesStale` — see LImage). An image's own palette wins over the channel
 * member's, because the corpus hands a member the image of another one (the
 * Object Mover's preview, `renderPreviewImage`'s hand icons), and a
 * `paletteTarget` remap rewrites the RGB the pixels carry.
 *
 * A COMPOSED surface has neither: `LImage.copyPixels` adopts the source's palette
 * on a full-surface copy into an image that has none, so a window part the corpus
 * pastes piece by piece (a 32-bit buffer with no index raster) ends up carrying
 * whichever piece was pasted first. The friend list's search bar handed its three
 * entry greys to the buffer and the matte keyed palette entry 0 (#6b6b6b) — the
 * bar's top band vanished into the window behind it while its darker greys stayed.
 * Nothing is forwarded for such a surface, so the bake falls back to the colour
 * rules (pixel (0,0) / white edge), which is what the reference renderer does.
 */
export function bakeInputsForImage(
  img: { palette?: number[][] | undefined; indices?: Uint8Array | null; indicesStale?: boolean },
  memberPalette?: number[][],
): { palette: number[][] | undefined; indices: Uint8Array | null } {
  const indexed = !!img.indices && !img.indicesStale;
  return {
    palette: indexed ? img.palette ?? memberPalette : undefined,
    indices: indexed ? img.indices! : null,
  };
}

export function bakeSurface(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  bake: BakeMode | null,
  tint: number | null,
  keyRgb?: number | null,
  ink = 0,
  fgRgb = 0,
  palette?: number[][],
   /** Optional pre-allocated buffer to avoid per-bake allocation (see pixi.ts `bakeImagePixels`). */
   keyed?: Uint8Array | null,
   /**
    * fg→bg duotone (`mix(src, fg, bg)`, the ink-41 maths reused by the avatar
    * colour effects — see `Engine.duotoneForChannel`). When present it replaces
    * the legacy ink-41 `tint`/`fgRgb` pair and leaves the plain bg tint for the
    * other inks untouched.
    */
   duotone?: { fg: number; bg: number } | null,
   /**
    * Palette indices of `src`. Pass them whenever the surface came from indexed
    * art: the matte and key rules are INDEX rules (the member's palette entry 0
    * is its background), and the RGB of that entry stops identifying it as soon
    * as the surface has been remapped through a `paletteTarget`. Without them the
    * bake falls back to matching the palette-0 COLOUR, which the frame path only
    * gets away with while nothing has recoloured the art.
    */
   indices?: Uint8Array | null,
): { pixels: Uint8ClampedArray; changed: boolean } {
   const n = w * h * 4;
   const buf = new Uint8ClampedArray(n);
   buf.set(src.subarray(0, n));
   // The ink-39 identity rectangle is the one keyed region that stays OPAQUE, so
   // mark it: the tint pass below skips transparent pixels but must skip these too.
   const keyedBuf = bake === 'matteIdentity' ? (keyed ?? new Uint8Array(w * h)) : null;
   const changed = bake
     ? bakeEdgeBackground(
         buf,
         w,
         h,
         bake,
         bake === 'backgroundTransparent' ? undefined : palette,
         bake === 'backgroundTransparent' ? undefined : indices,
         keyRgb,
         keyedBuf,
       )
     : false;
  const tinted = duotone
    ? tintSpriteDarken(buf, w, h, duotone.bg, duotone.fg)
    : tint !== null
      ? (ink === 41 ? tintSpriteDarken(buf, w, h, tint, fgRgb) : tintSpriteBackground(buf, w, h, tint, keyedBuf))
      : false;
  return { pixels: buf, changed: changed || tinted };
}

/**
 * Is the sprite's rendered pixel at (px, py) part of its ACTIVE AREA, i.e. can a
 * click land on it? `false` means the click belongs to the sprite underneath.
 *
 * Director names ONE ink for this: "If the sprite is a bitmap cast member with
 * matte ink applied, the active area is the portion of the image that is
 * displayed; otherwise, the active area is the sprite's bounding rectangle"
 * (drmx2004_scripting_ref.txt:6979 for `on mouseEnter`, 7027 for `on
 * mouseLeave`; the `cursor` doc at 28823 says the same — the pointer only
 * "changes when the cursor is over the matte portion of the sprite").
 *
 * `pixels` is the RENDERED buffer (`ChannelNode.imgBuffer`) — the buffer the
 * stage actually uploads — so a single alpha test covers every way a MATTE
 * sprite can end up with invisible pixels:
 *
 *  - the ink's keying bake (matte 8, Not-copy 4, Not-ghost 7),
 *  - the ink-0 near-white-backdrop heuristic (`bakeForChannel`'s
 *    `backgroundTransparent`),
 *  - artwork that simply HAS an alpha channel (a 32-bit member, a PNG, a
 *    `image(w, h, 32)` the movie painted into).
 *
 * The alpha-channel case is what makes this load-bearing for the room. Furniture
 * sprites are ink 8 by default: the class that resolves ink returns 8 when
 * `*.props` does not name one (real chair props only carry `#zshift`), and the
 * `#zshift` of a chair's parts interleaves them WITH the sitter: a part that is
 * drawn in front of the sitting avatar has a bigger locZ than `pMatteSpr
 * .locZ = pSprite.locZ + 1`. A chair's rectangle is much larger than its art,
 * so a bounding-box hit test on that front part eats every click aimed at the
 * avatar sitting on it — the reported "clicking a sitting avatar selects the
 * chair". Testing the displayed pixels lets the click fall to the avatar.
 *
 * INK 36 IS *NOT* A MATTE CASE, and treating it as one breaks the corpus's
 * click overlays. `nav_roomlistBackLinks`, both minigame `game_area`s
 * (`habbo_ttt.window`, `habbo_battleships.window`, `habbo_chess.window`) and
 * every other window hotspot are declared as a STRETCHED 1x1 image element:
 *
 *   [#member: "shadow.pixel", #media: #bitmap, #ink: 36, #width: 248,
 *    #height: 229, #type: "image", #id: "game_area"]
 *
 * Their buffer is a `image(w, h, 32)` the movie feeds/draws into, and the
 * Layout Parser gives every element `#bgColor: rgb(255,255,255)`, so a blank one
 * (battleships clears it on every turn — `battleShipMyTurn` calls
 * `clearBuffer()` + `clearImage()`) is a white fill that ink 36 then keys to
 * nothing: the element displays NOTHING and is used purely as an invisible click
 * area. Under the rectangle rule the click reaches it and the game works; under
 * the pixel rule the click fell through to `game_bg` and the player could not
 * fire a single shot (measured live: BS/CH `game_area` buffer 100% transparent,
 * hit test returned `BS_game_bg` / `CH_chess_bg`).
 *
 * The corpus agrees that ink 36 is a rectangle case — it does the per-pixel
 * work itself, which is only reachable if Director already handed the sprite the
 * click. `Room_Interface_Class::validateEvent` (hh_room/0003:798) reads
 * `sprite(the rollover)`, and when that sprite is a bitmap with ink 36 it samples
 * `tSpr.member.image.getPixel(...)`: a `#FFFFFF` pixel makes it hide the sprite and
 * re-dispatch the event on the sprite BELOW, anything else keeps the click. Our
 * pixel rule pre-empted that branch entirely, so the movie's own matte logic
 * never ran.
 *
 * Matte ink (8) and its keying cousins (4 not-copy, 7 not-ghost) keep the
 * displayed-pixel test — that is the chair/sitter case above — and artwork with a
 * real alpha channel of its own is honoured for those inks too.
 *
 * Missing surface and out-of-bounds coordinates still fall back to the
 * rectangle, so a drifted pixel mapping can never make a sprite unclickable.
 */
const PIXEL_TEST_INKS = new Set([4, 7, 8]);

/**
 * Does this sprite's click area follow its DISPLAYED pixels (true) or its whole
 * rectangle (false)? See the note above: `alphaArt` is the artwork's own alpha
 * channel, honoured for the matte ink family. Ink 36 answers `false` whatever
 * the artwork's depth — it is Director's rectangle case. */
export function inkUsesPixelHitTest(ink: number, alphaArt = false): boolean {
  if (ink === 36) return false;
  return alphaArt || PIXEL_TEST_INKS.has(ink);
}

export function spritePixelHitTest(
  ink: number,
  pixels: Uint8Array | Uint8ClampedArray | null | undefined,
  w: number,
  h: number,
  px: number,
  py: number,
  alphaArt = false,
): boolean {
  if (!inkUsesPixelHitTest(ink, alphaArt)) return true;
  if (!pixels || w < 1 || h < 1) return true;
  if (px < 0 || py < 0 || px >= w || py >= h) return true;
  // A hole in the DISPLAYED pixels settles it: the click belongs to the sprite
  // underneath. Asking the sprite's own source image ("is the art opaque here?")
  // would instead keep pixels the ink keyed away — and those pixels are exactly
  // the ones the player can see through.
  //
  // Only the matte ink family (8, and the keying cousins 4/7, plus artwork with
  // its own alpha) reaches this line at all: ink 36 answers the rectangle rule in
  // `inkUsesPixelHitTest`, and MISSING pixels still fall back to the rectangle
  // above, so a surface that has not been baked yet can never make a sprite
  // unclickable.
  return pixels[(py * w + px) * 4 + 3] !== 0;
}
