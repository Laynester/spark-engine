
export type BakeMode = 'matte' | 'backgroundTransparent' | 'key' | 'notGhost';

export interface MatteSpec {
  rgb: number;
  tolerance: number;
}

const NEAR_WHITE_MIN = 232;
const NEAR_WHITE_DELTA = 16;
const CONTENT_MIN_PIXELS = 8;

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
  if (p0 !== null) return { rgb: p0, tolerance: 0 };
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
  return null;
}

function whiteEdgeExists(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): boolean {
  for (const i of edgeIndices(width, height)) {
    if (isOpaque(rgba, i) && rgbAt(rgba, i) === 0xffffff) return true;
  }
  return false;
}

function paletteIndex0Rgb(palette: number[][] | undefined): number | null {
  const p0 = palette && palette.length > 0 ? palette[0] : null;
  if (!p0 || p0.length < 3) return null;
  return (p0[0] << 16) | (p0[1] << 8) | p0[2];
}

export function bakeEdgeBackground(
  rgba: Uint8Array | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mode: BakeMode,
  palette?: number[][],
  indices?: Uint8Array | null,
  keyRgb?: number | null,
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

  let changed = false;
  for (let i = 0; i < n; i++) {
    if (!connected[i] || rgba[i * 4 + 3] === 0) continue;
    rgba[i * 4] = 0;
    rgba[i * 4 + 1] = 0;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 0;
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
): Uint8Array | null {
  const rl = Math.max(0, left);
  const rt = Math.max(0, top);
  const rw = Math.min(imgW, left + w) - rl;
  const rh = Math.min(imgH, top + h) - rt;
  if (rw <= 0 || rh <= 0 || imgW <= 0 || imgH <= 0) return null;

  const paletteRgb = paletteIndex0Rgb(palette);
  const indexKeyed = !!indices && indices.length >= imgW * imgH;
  const matte =
    indexKeyed ? { rgb: 0, tolerance: 0 } : paletteRgb !== null ? { rgb: paletteRgb, tolerance: 0 } : resolveMatteMode(rgba, imgW, imgH);
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

export const SUBTRACT_BLEND_MODE = 'subtract-gl';
export function blendModeForInk(ink: number): 'normal' | 'add' | typeof SUBTRACT_BLEND_MODE | 'min' | 'max' {
  switch (ink) {
    case 33:
    case 34:
      return 'add';
    case 35:
    case 38:
      return SUBTRACT_BLEND_MODE;
    case 37:
    case 40:
      return 'max';
    case 39:
      return 'min';
    case 41:
      return 'normal';
    default:
      return 'normal';
  }
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
