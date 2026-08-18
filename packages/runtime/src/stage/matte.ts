// Director sprite-ink alpha baking — the "magic wand" background removal.
// Ported from LibreShockwave's bitmap pipeline: for MATTE (8) and
// BACKGROUND_TRANSPARENT (36) inks, the sprite's edge-connected background is
// inferred and flood-filled to alpha 0 — the white backdrop disappears while
// white detail inside the art (cloud puffs, highlights) survives.
// TRANSPARENT (1) is a plain exact-white key. Pure functions over RGBA bytes
// so they run headless in tests and in the browser via canvas ImageData.

// Director ink numbers -> alpha-bake behavior.
export type BakeMode = 'matte' | 'backgroundTransparent' | 'key';

export interface MatteSpec {
  rgb: number; // 0xRRGGBB background color
  tolerance: number; // per-channel match tolerance (0 exact)
}

const NEAR_WHITE_MIN = 232; // C++: corners/edges must be >= this on every channel
const NEAR_WHITE_DELTA = 16; // C++: channel-to-channel spread for "grayscale"
const CONTENT_MIN_PIXELS = 8; // C++: enough non-background pixels to matter

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

// The edge color that also fills every opaque corner and covers >= 75% of
// opaque edge pixels; null when the image is uniform or the edges disagree.
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
  // Every opaque pixel equal to the dominant color -> nothing to silhouette.
  let uniform = true;
  for (let i = 0; i < width * height; i++) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) !== dominant) {
      uniform = false;
      break;
    }
  }
  if (uniform) return null;
  // Every opaque corner must be the dominant edge color, covering >= 75% of
  // the opaque edge.
  let opaqueCornerCount = 0;
  for (const i of cornerIndices(width, height)) {
    if (!isOpaque(rgba, i)) continue;
    opaqueCornerCount++;
    if (rgbAt(rgba, i) !== dominant) return null;
  }
  if (opaqueCornerCount === 0 || dominantCount * 4 < opaqueEdgeCount * 3) return null;
  return dominant;
}

// True when every opaque corner is near-white — the signal that an ink-0
// copy image (a button's composed buffer with a white mask) needs the
// background-transparent bake so the white corners around the art don't show
// as a box. Opaque panels keep their non-white corners untouched.
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
  return opaqueCorners.every((rgb) => isNearWhiteGrayscale(rgb, NEAR_WHITE_MIN, NEAR_WHITE_DELTA));
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

// True when pure white genuinely FILLS the image edge: >= 75% of the opaque
// edge pixels are exact white AND every opaque corner is white. The "any
// white edge pixel wins" shortcut lets a few white glyph pixels on the edge
// hijack the matte and eat the whole glyph — requiring 75% + corners keeps
// the white-backdrop case while a handful of glyph specks can't.
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

// For a 32-bit source without alpha, the ink-8 matte background is EXACTLY
// the source's top-left pixel (0,0) — no edge-voting. The art is authored so
// (0,0) is the backdrop (white for window shadows, black for entry_bar field
// images). The strict white gate below belongs to the channel/texture bake
// only, where the source is a composed buffer.
function edgeMatteColor(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): number | null {
  if (width < 1 || height < 1 || rgba.length < 4) return null;
  if (!isOpaque(rgba, 0)) return null;
  return rgbAt(rgba, 0);
}

// copyPixels-time matte for 32-bit no-alpha sources: the background is pixel
// (0,0). Palette-driven mattes (index 0) take precedence and never get here.
function resolveMatteMode(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): MatteSpec | null {
  if (borderIsTransparent(rgba, width, height)) return null;
  const p00 = edgeMatteColor(rgba, width, height);
  if (p00 === null) return null;
  return { rgb: p00, tolerance: 0 };
}

// An image whose border is mostly TRANSPARENT is already alpha-keyed (text
// bitmaps are transparent + glyphs). On such a source the transparent border
// seeds the flood, which then roams through every transparent pixel and eats
// ANY pixel matching the matte color — white glyphs vanish. When the border
// is mostly transparent the alpha channel IS the mask: skip the color matte.
// Rounded-corner art keeps its opaque white border and is still matted.
function borderIsTransparent(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, threshold = 0.5): boolean {
  let total = 0;
  let transparent = 0;
  for (const i of edgeIndices(width, height)) {
    total++;
    if (rgba[i * 4 + 3] === 0) transparent++;
  }
  return total > 0 && transparent / total >= threshold;
}

// BACKGROUND_TRANSPARENT (36) matte. The strict near-white corners/75% gates
// reject real backdrops (art bleeds to a corner), leaving the white box
// visible. The flood is edge-connected and can't pass through art, so the
// safe gate is: some opaque edge pixel is near-white and real content exists.
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

// Channel/sprite-level matte (the texture-upload bake, NOT copyPixels). With
// a palette, the background is EXACTLY palette index 0 (a palette-driven
// matte keeps outlined puffs the old near-white heuristic ate). Without a
// palette, ONLY pure white wins — inferring a non-white edge color here ate
// opaque panels (a solid teal drag header was keyed to nothing but its title
// text). A composed panel with non-white edges has no white backdrop to
// remove — leave it untouched.
function resolveChannelMatte(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: BakeMode,
  palette?: number[][],
): MatteSpec | null {
  const p0 = paletteIndex0Rgb(palette);
  if (p0 !== null) return { rgb: p0, tolerance: 0 };
  if (mode === 'backgroundTransparent') return resolveBackgroundTransparent(rgba, width, height);
  if (borderIsTransparent(rgba, width, height)) return null;
  // Ink-8, opaque 32-bit source: the matte key is the bitmap's TOP-LEFT
  // pixel, flood-filled from every matching edge pixel — no dominance voting.
  // whiteEdgeDominates would reject a white corner-bevel on a gray button
  // and an arrow whose dark outline touches the art edge; the (0,0) white IS
  // the background. Restricted to a WHITE (0,0) so non-white-cornered panels
  // keep the old gates.
  const p00 = edgeMatteColor(rgba, width, height);
  if (p00 !== null && p00 === 0xffffff) return { rgb: p00, tolerance: 0 };
  if (whiteEdgeDominates(rgba, width, height)) return { rgb: 0xffffff, tolerance: 0 };
  // Runtime-composed group buffers: the image() builtin fills fresh 8-bit
  // surfaces with palette index 0 (white), and where the art doesn't cover
  // the buffer edge that white IS the fill and must go transparent under the
  // ink-8 matte. Any opaque EXACT-white edge pixel with real content is
  // enough — the flood is edge-connected, so enclosed white art survives.
  // Exact-white only (tolerance 0), so near-white bevels are never keyed.
  if (
    whiteEdgeExists(rgba, width, height) &&
    hasOpaqueNonNearWhiteContent(rgba, width, height, NEAR_WHITE_MIN, NEAR_WHITE_DELTA, CONTENT_MIN_PIXELS)
  ) {
    return { rgb: 0xffffff, tolerance: 0 };
  }
  return null;
}

// True when any opaque border pixel is EXACT white. A lone glyph/bevel speck
// can trigger the matte, but the flood only removes pixels connected to it,
// so isolated specks inside the border are never reached.
function whiteEdgeExists(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): boolean {
  for (const i of edgeIndices(width, height)) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) === 0xffffff) return true;
  }
  return false;
}

// Palette index 0's RGB as a 0xRRGGBB int, or null when the palette is
// empty. The indexed-bitmap background is exactly index 0 — every other
// index (even one whose RGB is white) is art and must survive a key.
function paletteIndex0Rgb(palette: number[][] | undefined): number | null {
  const p0 = palette && palette.length > 0 ? palette[0] : null;
  if (!p0 || p0.length < 3) return null;
  return (p0[0] << 16) | (p0[1] << 8) | p0[2];
}

// Zero the alpha of the edge-connected background region — the magic-wand
// flood fill. Returns true when any pixel changed. For 'key' inks, every
// pixel matching the background color goes transparent with no flood fill —
// a BLANKET key, so enclosed background dies too. The key color is the
// bitmap's palette index 0 when a palette is supplied, else exact white.
export function bakeEdgeBackground(
  rgba: Uint8Array | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: BakeMode,
  palette?: number[][],
  indices?: Uint8Array | null,
): boolean {
  const n = width * height;
  if (width <= 0 || height <= 0 || rgba.length < n * 4) return false;

  // Ink 36 is a BLANKET color-key against the sprite's bgColor (white
  // default), and it fires on 32-bit alpha bitmaps too — DirPlayer color-keys
  // use_alpha bitmaps as long as they're plain authored members, NOT Flash
  // captures (rendering_gpu/webgl2/mod.rs, use_embedded_alpha + ink 36 path).
  // The avatar canvas is exactly that: 32-bit, transparent border, but with
  // opaque white body-part backgrounds pasted inside that must be keyed away.
  // A transparent border is NOT a reason to skip — only Flash bitmaps skip.
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

  // With raw palette indices available, the matte flood keys palette INDEX 0
  // exactly — an RGB key of index 0's color also eats same-colored art at
  // other indices (the fuzzy floor tile's white dither squares), showing as
  // black grid lines between tiles. 'key' (ink 36) stays an RGB blanket key.
  const indexKeyed = !!indices && indices.length >= n;
  const matte = indexKeyed ? { rgb: 0, tolerance: 0 } : resolveChannelMatte(rgba, width, height, mode, palette);
  if (!matte) return false;

  // BFS from every edge seed where the pixel is already transparent or
  // matches the matte color, spreading 4-connected.
  const connected = new Uint8Array(n);
  const queue: number[] = [];
  const seed = (x: number, y: number): void => {
    const i = y * width + x;
    if (connected[i]) return;
    const opaque = isOpaque(rgba, i);
    if (!opaque || (indexKeyed ? indices![i] === 0 : matchesRgb(rgbAt(rgba, i), matte.rgb, matte.tolerance))) {
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

  let changed = false;
  for (let i = 0; i < n; i++) {
    if (!connected[i] || rgba[i * 4 + 3] === 0) continue;
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 0;
    changed = true;
  }
  return changed;
}

// Copy-time matte mask (ink 8 copyPixels): the edge-connected background of
// the WHOLE source image, returned as a mask over the requested region (1 =
// background pixel to skip). Mattes the entire source once, then samples the
// source rect — a region-local flood on a PARTIAL slice (the cloud turn()
// pastes left/right slices) would seed from the slice's artificial cut and
// eat the outlined puffs. Returns null when no background resolves.
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
): Uint8Array | null {
  const rl = Math.max(0, left);
  const rt = Math.max(0, top);
  const rw = Math.min(imgW, left + w) - rl;
  const rh = Math.min(imgH, top + h) - rt;
  if (rw <= 0 || rh <= 0 || imgW <= 0 || imgH <= 0) return null;

  // With a palette, the background is exactly palette index 0 (the cloud body
  // is a different index than the white bg, so every outlined puff survives);
  // with raw palette INDICES the flood keys by INDEX — an RGB-keyed flood
  // would eat same-colored art at other indices (the fuzzy floor tile's white
  // dither squares), punching gaps that show as a black grid.
  const paletteRgb = paletteIndex0Rgb(palette);
  const indexKeyed = !!indices && indices.length >= imgW * imgH;
  const matte =
    indexKeyed ? { rgb: 0, tolerance: 0 } : paletteRgb !== null ? { rgb: paletteRgb, tolerance: 0 } : resolveMatteMode(rgba, imgW, imgH);
  if (!matte) return null;

  // C++ computeEdgeConnectedMask over the WHOLE image: BFS from every edge
  // pixel where the pixel is already transparent or matches the matte color,
  // spreading 4-connected through transparent-or-matching pixels.
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

  // Sample the region out of the full-image mask.
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

// Which Director ink needs an alpha bake at texture-load time (0 copy, 1
// transparent, 8 matte, 32 blend, 33 add pin, 34 add, 35 subtract pin, 36 bg
// transparent, 37 lightest, 38 subtract, 39 darkest, 40 lighten, 41 darken).
// COMPOSITE inks rely on the bitmap's alpha — the exported PNGs carry no
// baked matte, so the white background must be removed BEFORE the ink
// composites or it shows as a white box. Copy (0) shows the bitmap as-is and
// mask (9) uses a mask member. Ink 36 is a BLANKET color-key, not a flood
// fill — the real player keys every pixel within tolerance of the bg color,
// enclosed background included.

// Sprite bg_color tint (the figure-creator swatch recolors a white box via
// sprite.bgColor = rgb(...)): NEAR-GRAYSCALE pixels (max-min <= 16) are lerped
// toward the bg color — white becomes exactly the bg color, black stays
// black, colorful pixels are untouched. A white bgColor is identity, so this
// only fires when the sprite bgColor is a real RGB color (ch.bgColorIsRgb).
export function tintSpriteBackground(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, bgRgb: number): boolean {
  const bgR = (bgRgb >> 16) & 0xff;
  const bgG = (bgRgb >> 8) & 0xff;
  const bgB = bgRgb & 0xff;
  let changed = false;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
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

// Ink 9 (Mask): bake the NEXT cast member's bitmap as a grayscale alpha mask
// onto the source (pool water: vesi1 is an opaque blue rect, vesimask1 its
// black/white cutout). Aligned by registration points; grayscale inverted —
// black(0) -> opaque, white(255) -> transparent, grays partial. Pixels the
// mask doesn't cover are transparent. In-place on the source RGBA buffer.
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
        // Outside the mask's coverage: transparent.
        if (a !== 0) changed = true;
        rgba[o + 3] = 0;
        continue;
      }
      const mi = (my * mw + mx) * 4;
      // Inverted grayscale: white(255) -> alpha 0, black(0) -> alpha 255.
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
    case 8:
    case 32:
    case 33:
    case 34:
    case 35:
    case 37:
    case 38:
    case 39:
    case 40:
    case 41:
      return 'matte';
    default: return null;
  }
}

// Director ink -> renderer blend mode: 33/34 add, 35/38 subtract, 37/40
// LIGHTEST, 39 DARKEST; everything else normal compositing.
//
// LIGHTEST/DARKEST map to the core 'max'/'min' blend modes (GL MAX/MIN
// blend equation). pixi's 'lighten'/'darken' live in the advanced-blend-modes
// package, which renders through a filter that captures the back texture —
// broken in pixi 8.19 (captures transparent black), so lighten/darken sprites
// composite their source unchanged. The core GL MAX/MIN equation composites
// per-channel against the actual framebuffer: a black/transparent source
// pixel maxes to exactly the destination, which is the LIGHTEST semantics
// the scrollbars rely on.
export function blendModeForInk(ink: number): 'normal' | 'add' | 'subtract' | 'min' | 'max' {
  switch (ink) {
    case 33:
    case 34:
      return 'add';
    case 35:
    case 38:
      return 'subtract';
    case 37:
    case 40:
      return 'max';
    case 39:
      return 'min';
    // 41 (Darken) is src * sprite-bgColor, baked into the texture at upload
    // (wall/floor wrappers tint via bgColor + ink 41) — NOT a GPU min, which
    // would blacken the pre-tinted pattern against the dark stage.
    case 41:
      return 'normal';
    default:
      return 'normal';
  }
}

// Only ink 8 (Matte) does pixel-level hit-testing — a click on a transparent
// pixel of a matte sprite falls through to the sprite below; all other inks
// are bounding-box. `pixels` is the sprite's stage RGBA buffer; null means no
// surface yet, so the bounding box stands. Without this, every click on a
// window's title bar hits the back panel (whose rect covers the strip) and
// windows can't be dragged.
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
