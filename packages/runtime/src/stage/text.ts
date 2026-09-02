import { asNum, colorFrom, fontStyleFlags, LImage } from '../lingo/values.js';
import type { Member } from '../engine/members.js';
import { alignmentName, cssFontFor } from '../engine/engine.js';

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
        const bbA = (mctx.measureText('M') as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
        const bbD = (mctx.measureText('M') as { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;
        if (typeof bbA === 'number' && isFinite(bbA) && bbA > 0) {
          fontLH = Math.round(bbA + (typeof bbD === 'number' && isFinite(bbD) ? bbD : 0));
        }
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
    ctx.textAlign = align === 'right' || align === 'center' ? align : 'left';
    ctx.textBaseline = 'top';
    const styles = member.chunkStyles;
    const hasChunkStyles = !!styles && styles.length > 0;
    let y = glyphTop0;
    for (const ln of lines) {
      if (ln.text) {
        const x = align === 'center' ? w / 2 : align === 'right' ? w - 1 : 0;
        if (hasChunkStyles) {
          let cx = x;
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
            ctx.fillText(run, cx, y);
            cx += ctx.measureText(run).width;
            i = j;
          }
        } else {
          ctx.font = fontStr;
          ctx.fillStyle = `rgb(${effCol.red},${effCol.green},${effCol.blue})`;
          ctx.fillText(ln.text, x, y);
          if (style.underline && ln.text) {
            const tw = ctx.measureText(ln.text).width;
            const tx = align === 'center' ? w / 2 - tw / 2 : align === 'right' ? w - 1 - tw : 0;
            const ty = Math.min(h - 1, Math.round(y + size * 0.9));
            ctx.fillRect(Math.round(tx), ty, Math.max(1, Math.ceil(tw)), 1);
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
