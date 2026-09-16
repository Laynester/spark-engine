import { asNum, colorFrom, fontStyleFlags, LImage } from '../lingo/values.js';
import type { Member } from '../engine/members.js';
import { alignmentName, cssFontFor } from '../engine/engine.js';

/** Measured glyph box (ascent + descent) per font signature; the caret asks
 *  once per frame while a field is focused, so measure once per font. */
const glyphHeightCache = new Map<string, number>();

/**
 * The font's own line box for a text member — the numbers BOTH the rasterizer
 * and the live caret need: `lineH`, the advance from one text line to the next
 * (fixedLineSpace when the member sets one, else the font's own leading), and
 * `glyphH`, the font's ascent + descent, i.e. how tall a Director insertion
 * point is for this font. The caret must scale with the FONT, not the field
 * box, so it reads these rather than the sprite height.
 */
export function textMemberLineMetrics(member: Member): { glyphH: number; lineH: number } {
  const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
  const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
  const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
  const lineH = fixed > 0 ? fixed + topSpacing : Math.max(size, Math.round(size * 1.2));
  const { family, weight } = cssFontFor(member.font);
  const style = fontStyleFlags(member.fontStyle);
  const effWeight = style.bold ? '700' : weight;
  const key = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
  const cached = glyphHeightCache.get(key);
  if (cached !== undefined) return { glyphH: cached, lineH };
  let glyphH = size + 1;
  if (typeof document !== 'undefined') {
    const mctx = document.createElement('canvas').getContext('2d');
    if (mctx) {
      mctx.font = key;
      const bbA = (mctx.measureText('M') as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
      const bbD = (mctx.measureText('M') as { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;
      if (typeof bbA === 'number' && isFinite(bbA) && bbA > 0) {
        glyphH = Math.round(bbA + (typeof bbD === 'number' && isFinite(bbD) ? bbD : 0));
      }
    }
  }
  glyphHeightCache.set(key, glyphH);
  return { glyphH, lineH };
}

/** One shared 2D context for font metrics — the live caret and the selection
 *  highlight ask it every frame while a field is focused. */
let metricsCtx: CanvasRenderingContext2D | null | undefined;

function fontMetricsCtx(): CanvasRenderingContext2D | null {
  if (metricsCtx === undefined) {
    metricsCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  return metricsCtx;
}

/**
 * The x offset of `index` inside a text member's own rendered text: the width of
 * everything before it, in the field's font. The live PIXI text lays glyphs out
 * with subpixel advances while the rasterizer snaps each character to an integer
 * column, so a caret or a selection highlight measured here can sit a pixel or
 * two off the glyphs — close enough to show which run is selected.
 */
export function textMemberPrefixWidth(member: Member, text: string, index: number): number {
  const i = Math.max(0, Math.min(index, text.length));
  if (i <= 0) return 0;
  const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
  const { family, weight } = cssFontFor(member.font);
  const style = fontStyleFlags(member.fontStyle);
  const effWeight = style.bold ? '700' : weight;
  const ctx = fontMetricsCtx();
  if (!ctx) return i * Math.max(1, Math.round(size / 2));
  ctx.font = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
  return ctx.measureText(text.slice(0, i)).width;
}

/**
 * The caret offset nearest a click inside the text block: `x` is measured from
 * the block's left edge (see textMemberPrefixWidth). A tie rounds toward the
 * earlier offset, and a click outside the run clamps to its end. Prefix widths
 * only ever grow, so the search bisects instead of measuring `text.length`
 * prefixes on every pointer move of a drag.
 */
export function textMemberCaretAt(member: Member, text: string, x: number): number {
  const n = text.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (textMemberPrefixWidth(member, text, mid) < x) lo = mid + 1;
    else hi = mid;
  }
  const after = Math.max(0, lo - 1);
  const a = textMemberPrefixWidth(member, text, after);
  const b = textMemberPrefixWidth(member, text, lo);
  return Math.abs(x - a) <= Math.abs(x - b) ? after : lo;
}

export function rasterizeTextMember(member: Member): LImage | null {
  if (typeof document === 'undefined') return null;
  const r = member.rect;
  const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
  const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
  const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
  const lineH = fixed > 0 ? fixed + topSpacing : Math.max(size, Math.round(size * 1.2));
  const text = member.text ?? '';
  const rw = r ? Math.round(r.width) : 0;
  const rh = r ? Math.round(r.height) : 0;
  let w = Math.max(1, rw);
  let h = rh > 1 || !text ? Math.max(1, rh) : lineH;
  let fontLH = size + 1;
  let glyphTop0 = text ? (topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2))) : 0;
  const autoSize = !member.textProps?.has('boxtype');
  const hardLines = text.split(/\r\n|\r|\n/);
  const { family, weight } = cssFontFor(member.font);
  const style = fontStyleFlags(member.fontStyle);
  const effWeight = style.bold ? '700' : weight;
  const fontStr = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
  const wrap = asNum(member.wordWrap ?? 0) === 1;
  let lines: TextLine[] = hardLines.map((l, i) => ({
    text: l,
    start: hardLines.slice(0, i).reduce((a, x) => a + x.length + 1, 0),
  }));
  if (text) {
    const mctx = document.createElement('canvas').getContext('2d');
    if (mctx) {
      mctx.font = fontStr;
      {
        fontLH = textMemberLineMetrics(member).glyphH;
        if (fixed > 0) {
          const leading = Math.max(0, fixed - fontLH);
          const vOverflow = Math.max(0, fontLH - fixed);
          const lineStart0 = topSpacing + (topSpacing > 1 ? 1 : 0);
          glyphTop0 = Math.max(0, lineStart0 + leading - vOverflow);
        }
      }
      if (autoSize && !wrap) {
        const maxW = hardLines.reduce((m, l) => Math.max(m, Math.ceil(mctx.measureText(l).width)), 0);
        w = Math.max(w, maxW + 2);
      }
      if (wrap && w > 1) lines = hardLines.flatMap((l) => wrapLines(mctx, l, w));
    }
    if (autoSize) {
      if (fixed > 0) {
        const lineStart0 = topSpacing + (topSpacing > 1 ? 1 : 0);
        h = Math.max(lineStart0 + lines.length * lineH, glyphTop0 + (lines.length - 1) * lineH + fontLH);
      } else {
        h = glyphTop0 + lines.length * lineH;
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const colorVal = member.color;
  const hasCol = colorVal !== undefined && colorVal !== null;
  const col = hasCol ? colorFrom(colorVal) : null;
  const effCol = col ?? { red: 0, green: 0, blue: 0 };

  if (text) {
    const align = alignmentName(member.alignment);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = fontStr;
    const styles = member.chunkStyles;
    const hasChunkStyles = !!styles && styles.length > 0;
    let y = glyphTop0;
    for (const ln of lines) {
      if (ln.text) {
        // Per-character fillText snaps every glyph to an integer column so a
        // whole-run blob's subpixel advance drift can't flip stroke thickness
        // with the box width parity (pixel fonts render fatter at even widths
        // otherwise). Center/right start from the measured line width, rounded.
        const tw = Math.max(0, ctx.measureText(ln.text).width);
        const x0 = align === 'center' ? Math.round((w - tw) / 2) : align === 'right' ? Math.max(0, Math.round(w - 1 - tw)) : 0;
        if (hasChunkStyles) {
          let cx = x0;
          let i = 0;
          while (i < ln.text.length) {
            const st = chunkStyleAt(styles!, ln.start + i);
            let j = i + 1;
            while (j < ln.text.length && styleKey(st) === styleKey(chunkStyleAt(styles!, ln.start + j))) j++;
            const run = ln.text.slice(i, j);
            const runFontVal = st?.font ?? member.font;
            const rstyle = fontStyleFlags(st?.fontStyle ?? member.fontStyle);
            const rcf = cssFontFor(runFontVal);
            const rw = rstyle.bold ? '700' : rcf.weight;
            ctx.font = `${rstyle.italic ? 'italic ' : ''}${rw} ${size}px ${rcf.family}`;
            const runColVal = st?.color ?? member.color;
            const rc = runColVal !== undefined && runColVal !== null ? colorFrom(runColVal) : null;
            const runCol = rc ?? effCol;
            ctx.fillStyle = `rgb(${runCol.red},${runCol.green},${runCol.blue})`;
            for (let k = 0; k < run.length; k++) {
              ctx.fillText(run[k], Math.round(cx), y);
              cx += ctx.measureText(run[k]).width;
            }
            i = j;
          }
        } else {
          ctx.fillStyle = `rgb(${effCol.red},${effCol.green},${effCol.blue})`;
          let cx = x0;
          for (let k = 0; k < ln.text.length; k++) {
            const ch = ln.text[k];
            ctx.fillText(ch, Math.round(cx), y);
            cx += ctx.measureText(ch).width;
          }
          if (style.underline && ln.text) {
            const ty = Math.min(h - 1, Math.round(y + size * 0.9));
            ctx.fillRect(Math.round(x0), ty, Math.max(1, Math.ceil(tw)), 1);
          }
        }
      }
      y += lineH;
    }
  }

  const px = ctx.getImageData(0, 0, w, h).data;
  if (text) {
    hardenTextAlpha(px, (effCol.red << 16) | (effCol.green << 8) | effCol.blue);
  }
  const img = new LImage(w, h);
  img.data = new Uint8Array(px);
  img.dirty = true;
  return img;
}

export function hardenTextAlpha(rgba: Uint8Array | Uint8ClampedArray, fgRgb: number): void {
  const fr = (fgRgb >> 16) & 0xff;
  const fg = (fgRgb >> 8) & 0xff;
  const fb = fgRgb & 0xff;
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = rgba[o + 3];
    if (a === 0) continue;
    if (a < 128) {
      rgba[o] = 0;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 0;
    } else {
      rgba[o] = fr;
      rgba[o + 1] = fg;
      rgba[o + 2] = fb;
      rgba[o + 3] = 255;
    }
  }
}

export function defringeTextPixels(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  fgRgb: number,
  bgRgb: number,
): void {
  const fr = (fgRgb >> 16) & 0xff;
  const fg = (fgRgb >> 8) & 0xff;
  const fb = fgRgb & 0xff;
  const br = (bgRgb >> 16) & 0xff;
  const bg = (bgRgb >> 8) & 0xff;
  const bb = bgRgb & 0xff;
  if (Math.max(Math.abs(fr - br), Math.abs(fg - bg), Math.abs(fb - bb)) <= 6) return;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] === 0) continue;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const dFg = Math.abs(r - fr) + Math.abs(g - fg) + Math.abs(b - fb);
    const dBg = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
    if (dBg <= 6) {
      rgba[o] = br;
      rgba[o + 1] = bg;
      rgba[o + 2] = bb;
      rgba[o + 3] = 255;
      continue;
    }
    if (dFg <= 6) {
      rgba[o] = fr;
      rgba[o + 1] = fg;
      rgba[o + 2] = fb;
      rgba[o + 3] = 255;
      continue;
    }
    if (Math.abs(dFg - dBg) <= 2) continue;
    if (dBg < dFg) {
      rgba[o] = 0;
      rgba[o + 1] = 0;
      rgba[o + 2] = 0;
      rgba[o + 3] = 0;
    } else {
      rgba[o] = fr;
      rgba[o + 1] = fg;
      rgba[o + 2] = fb;
      rgba[o + 3] = 255;
    }
  }
}

interface TextLine {
  text: string;
  start: number;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): TextLine[] {
  const lines: TextLine[] = [];
  let line = '';
  let lineStart = 0;
  let pos = 0;
  for (const word of text.split(/(\s+)/)) {
    const probe = line + word;
    if (line && ctx.measureText(probe).width > width) {
      lines.push({ text: line, start: lineStart });
      line = word.trimStart();
      lineStart = pos + (word.length - word.trimStart().length);
    } else {
      line = probe;
    }
    pos += word.length;
  }
  if (line.trim()) lines.push({ text: line, start: lineStart });
  if (lines.length === 0) lines.push({ text, start: 0 });
  return lines;
}

type ChunkStyle = NonNullable<Member['chunkStyles']>[number];

function chunkStyleAt(styles: ChunkStyle[], absIdx: number): Partial<ChunkStyle> | undefined {
  let merged: Partial<ChunkStyle> | undefined;
  for (const s of styles) {
    if (absIdx >= s.from - 1 && absIdx <= s.to - 1) {
      if (!merged) merged = {};
      if (s.font !== undefined) merged.font = s.font;
      if (s.fontStyle !== undefined) merged.fontStyle = s.fontStyle;
      if (s.color !== undefined) merged.color = s.color;
    }
  }
  return merged;
}

function styleKey(st: Partial<ChunkStyle> | undefined): string {
  if (!st) return '';
  const flags = fontStyleFlags(st.fontStyle);
  const c = st.color !== undefined && st.color !== null ? colorFrom(st.color) : null;
  return `${st.font ?? ''}|${flags.bold ? 'b' : ''}${flags.italic ? 'i' : ''}${flags.underline ? 'u' : ''}|${c ? `${c.red},${c.green},${c.blue}` : ''}`;
}
