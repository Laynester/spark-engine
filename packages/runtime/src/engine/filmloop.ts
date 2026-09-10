import type { Member } from './members.js';
import { LImage } from '../lingo/values.js';
import { decodeImage } from './pix8.js';
import { bakeEdgeBackground, bakeModeForInk } from '../stage/matte.js';

/** A resolved film-loop sprite record: a cast member drawn on the loop's
 *  mini-stage at (x, y) with its own ink/blend. The record's w/h is the
 *  sprite's display size; the member bitmap may be larger (the runtime draws
 *  it at natural size when the loop is a full-content composition — see
 *  planFilmLoopComposition). */
export interface FilmTile {
  member: Member;
  x: number;
  y: number;
  w: number;
  h: number;
  ink: number;
  blend: number;
}

/** A tile with its resolved blit geometry inside the composed canvas. */
export interface PlacedTile {
  member: Member;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  ink: number;
  blend: number;
}

/** Composition canvas geometry + per-frame placed tiles. */
export interface FilmLoopPlan {
  width: number;
  height: number;
  frames: PlacedTile[][];
}

/** Natural bounding box of the sprite placements: each tile at its mini-stage
 *  position minus the member's real registration point, at NATURAL bitmap
 *  size. */
function naturalBounds(frames: FilmTile[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    for (const t of frame) {
      const bw = t.member.width;
      const bh = t.member.height;
      if (bw <= 0 || bh <= 0) continue;
      const left = t.x - t.member.regX;
      const top = t.y - t.member.regY;
      if (left < minX) minX = left;
      if (top < minY) minY = top;
      if (left + bw > maxX) maxX = left + bw;
      if (top + bh > maxY) maxY = top + bh;
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/** Plan the composition (DirPlayer render_score_to_bitmap_with_offset parity):
 *
 *  - The canvas is the loop's authored rect (the CASt initialRect): the
 *    mini-stage viewport the loop composes into, anchored at (loopX, loopY).
 *  - Tiles draw at NATURAL bitmap size when the authored rect matches the
 *    sprites' natural bounding box (within 10px, DirPlayer prefer_bitmap_dims)
 *    — hh_room_gold's waterloop: authored (162,391,475,483) = 313×92 equals
 *    the natural bounds of its eight 250×22 tiles, so the 250×12 display size
 *    in the score is NOT used and the alternating teal rows stay dense. When
 *    the loop is a viewport/crop, tiles draw at the record's display size with
 *    the regpoint scaled proportionally.
 *
 *  Falls back to the natural bounding box as canvas when no authored rect was
 *  exported.
 */
export function planFilmLoopComposition(
  frames: FilmTile[][],
  authored?: { x: number; y: number; w: number; h: number },
): FilmLoopPlan | null {
  const bounds = naturalBounds(frames);
  if (!bounds) return null;
  const naturalW = bounds.maxX - bounds.minX;
  const naturalH = bounds.maxY - bounds.minY;
  const canvasX = authored ? authored.x : bounds.minX;
  const canvasY = authored ? authored.y : bounds.minY;
  const canvasW = authored ? authored.w : naturalW;
  const canvasH = authored ? authored.h : naturalH;
  const preferNatural =
    Math.abs(naturalW - canvasW) <= 10 && Math.abs(naturalH - canvasH) <= 10;

  const placed: PlacedTile[][] = frames.map((frame) =>
    frame
      .map((t) => {
        const bw = t.member.width;
        const bh = t.member.height;
        if (bw <= 0 || bh <= 0) return null;
        const dw = preferNatural ? bw : t.w;
        const dh = preferNatural ? bh : t.h;
        const rx = preferNatural ? t.member.regX : (t.member.regX * t.w) / bw;
        const ry = preferNatural ? t.member.regY : (t.member.regY * t.h) / bh;
        return {
          member: t.member,
          dx: t.x - rx - canvasX,
          dy: t.y - ry - canvasY,
          dw,
          dh,
          ink: t.ink,
          blend: t.blend,
        };
      })
      .filter((t): t is PlacedTile => t !== null),
  );

  return { width: Math.round(canvasW), height: Math.round(canvasH), frames: placed };
}

export interface FilmTexture {
  rgba: Uint8Array;
  w: number;
  h: number;
}

/** Decode a frame member once and matte-bake it with the tile's ink (the
 *  waterloop tiles are all ink 8: palette-0 white keyed transparent). Cached
 *  by the engine keyed on the member — frames repeat across the score. */
export function prepareFilmTexture(member: Member, ink: number): FilmTexture | null {
  if (!member.raw) return null;
  try {
    const { width, height, rgba, indices } = decodeImage(member.raw, member.palette);
    const out = new Uint8Array(rgba);
    const bake = bakeModeForInk(ink);
    if (bake) bakeEdgeBackground(out, width, height, bake, member.palette, indices);
    return { rgba: out, w: width, h: height };
  } catch {
    return null;
  }
}

/** Composite one planned frame into a zero-initialized RGBA canvas: for each
 *  placed tile, nearest-neighbor scale the member's baked texture to the
 *  tile's display size and blit it at its position. Returns the canvas
 *  (width × height), fully transparent where no tile covers. */
export function composeFilmLoopFrame(
  plan: FilmLoopPlan,
  index: number,
  textures: Map<Member, FilmTexture>,
): Uint8Array {
  const w = plan.width;
  const h = plan.height;
  const canvas = new Uint8Array(w * h * 4);
  const frame = plan.frames[index];
  if (!frame) return canvas;
  for (const t of frame) {
    const tex = textures.get(t.member);
    if (!tex) continue;
    // Raw blend is inverted 0-255 (0 → opaque, 255 → fully transparent),
    // matching DirPlayer's filmloop blend handling.
    const pct = (255 - Math.min(255, Math.max(0, t.blend))) / 255;
    if (pct <= 0.01) continue;
    const alpha = pct >= 0.99 ? 255 : Math.round(pct * 255);
    const bw = tex.w;
    const bh = tex.h;
    const tw = Math.round(t.dw);
    const th = Math.round(t.dh);
    for (let y = 0; y < th; y++) {
      const dy = t.dy + y;
      if (dy < 0 || dy >= h) continue;
      const sy = th === bh ? y : Math.min(bh - 1, Math.floor((y * bh) / th));
      for (let x = 0; x < tw; x++) {
        const dx = t.dx + x;
        if (dx < 0 || dx >= w) continue;
        const sx = tw === bw ? x : Math.min(bw - 1, Math.floor((x * bw) / tw));
        const si = (sy * bw + sx) * 4;
        if (tex.rgba[si + 3] === 0) continue; // matte-keyed → transparent
        const di = (dy * w + dx) * 4;
        canvas[di] = tex.rgba[si];
        canvas[di + 1] = tex.rgba[si + 1];
        canvas[di + 2] = tex.rgba[si + 2];
        canvas[di + 3] = alpha;
      }
    }
  }
  return canvas;
}

/** Wrap a composed canvas in an LImage and mark it dirty for the renderer. */
export function filmLoopImage(
  pixels: Uint8Array,
  width: number,
  height: number,
  existing?: LImage,
): LImage {
  const img = existing ?? new LImage(width, height);
  img.width = width;
  img.height = height;
  img.data = pixels;
  img.dirty = true;
  return img;
}