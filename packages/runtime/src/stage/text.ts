import { asNum, colorFrom, fontStyleFlags, LImage } from '../lingo/values.js';
import type { Member } from '../engine/members.js';
import { alignmentName, cssFontFor } from '../engine/engine.js';

// Rasterize a text/field member to an LImage via a 2D canvas (browser AA is
// the text smoothing). Called through engine.textRasterizer when a Lingo
// member.image read lands on a text member; Field Wrapper members render live
// through the pixi Text branch instead. Layout mirrors Director's field
// model: member.rect is the box, bgColor fills it (ink-8 then mattes it
// away), and font/fontSize/color/alignment style the text with wordWrap
// splitting on spaces. Headless (no document) returns null for probes/tests.
export function rasterizeTextMember(member: Member): LImage | null {
  if (typeof document === 'undefined') return null;
  const r = member.rect;
  const size = Math.max(1, Math.round(asNum(member.fontSize ?? 0) || 12));
  const fixed = Math.round(asNum(member.fixedLineSpace ?? 0) || 0);
  const topSpacing = Math.max(0, Math.round(asNum(member.textProps?.get('topspacing') ?? 0) || 0));
  // Director line step is fixedLineSpace + topSpacing, first line starting at
  // topSpacing. Habbo's Writer forces fixedLineSpace = fontSize and stashes
  // the row-height remainder in topSpacing (navigator: 18px rows at fontSize
  // 9 -> topSpacing 9). Centering each line collapsed the rows to 9px.
  const lineH = fixed > 0 ? fixed + topSpacing : Math.max(size, Math.round(size * 1.2));
  const text = member.text ?? '';
  const rw = r ? Math.round(r.width) : 0;
  const rh = r ? Math.round(r.height) : 0;
  // A zero-height box (runtime-created text members before the corpus sizes
  // them, e.g. Common Button's shared label member) would clip every glyph to
  // a 1px sliver — fall back to the line height when there is text to draw.
  let w = Math.max(1, rw);
  let h = rh > 1 || !text ? Math.max(1, rh) : lineH;
  // Honor the Writer's topSpacing verbatim; otherwise keep glyph tops off the
  // top edge — flush drawing puts white glyph tops ON the edge, and the ink-8
  // matte keys "any white edge pixel -> white background", eating white text.
  const topInset = text ? (topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2))) : 0;
  // boxType 0 (adjust) auto-sizes the box to its text; 1 = scroll, 2 = fixed.
  // The corpus sets these everywhere EXCEPT the Writer's scratch members,
  // which exist only as `the image of` sources for copyPixels — those must
  // render content-tight or the writer's centering math lands ~230px off.
  const autoSize = !member.textProps?.has('boxtype');
  // Fields always break on hard line breaks (CR); wordWrap only controls
  // SOFT wrapping at the box edge. Without this, the navigator's RETURN-joined
  // room names collapse onto one row.
  const hardLines = text.split(/\r\n|\r|\n/);
  const { family, weight } = cssFontFor(member.font);
  const style = fontStyleFlags(member.fontStyle);
  const effWeight = style.bold ? '700' : weight;
  const fontStr = `${style.italic ? 'italic ' : ''}${effWeight} ${size}px ${family}`;
  const wrap = asNum(member.wordWrap ?? 0) === 1;
  let lines: string[] = hardLines;
  if (text) {
    const mctx = document.createElement('canvas').getContext('2d');
    if (mctx) {
      mctx.font = fontStr;
      if (autoSize && !wrap) {
        // Auto-width: max(rectW, widest line + 2).
        const maxW = hardLines.reduce((m, l) => Math.max(m, Math.ceil(mctx.measureText(l).width)), 0);
        w = Math.max(w, maxW + 2);
      }
      // Soft-wrap whenever wordWrap is on — fixed/scroll boxes with
      // #wordWrap: 1 (hc_status fields) wrap to the box edge too. Extra lines
      // clip at the box edge like Director's scroll fields.
      if (wrap && w > 1) lines = hardLines.flatMap((l) => wrapLines(mctx, l, w));
    }
    if (autoSize) {
      // Content height: the laid-out lines, first at topInset, stepping lineH.
      h = topInset + lines.length * lineH;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // NO background fill: a text member's `the image of` is transparent +
  // glyphs — the corpus's Text Wrapper paints the bg itself via pimage.fill
  // then pastes with ink 8. Baking bgColor here put a brown box behind the
  // purse balance. Live display channels get their bg from the pixi text style.
  const colorVal = member.color;
  const hasCol = colorVal !== undefined && colorVal !== null;
  // Text defaults to BLACK — rendering it white let the white-background key
  // eat the label text itself (navigator tabs showed a white smudge).
  const col = hasCol ? colorFrom(colorVal) : null;
  const effCol = col ?? { red: 0, green: 0, blue: 0 };

  if (text) {
    // fontStyle is a style list — bold forces the 700 face, italic maps to
    // canvas oblique, underline draws a rule per line in the text color.
    ctx.font = fontStr;
    ctx.fillStyle = `rgb(${effCol.red},${effCol.green},${effCol.blue})`;
    const align = alignmentName(member.alignment);
    ctx.textAlign = align === 'right' || align === 'center' ? align : 'left';
    ctx.textBaseline = 'top';
    let y = topInset;
    for (const line of lines) {
      if (line) {
        const x = align === 'center' ? w / 2 : align === 'right' ? w - 1 : 0;
        ctx.fillText(line, x, y);
        if (style.underline && line) {
          // Underline sits just below the em box, drawn in the text color so
          // the ink key treats it as glyph pixels; clamped so tight 9px-in-
          // 10px boxes keep the rule.
          const tw = ctx.measureText(line).width;
          const tx = align === 'center' ? w / 2 - tw / 2 : align === 'right' ? w - 1 - tw : 0;
          const ty = Math.min(h - 1, Math.round(y + size * 0.9));
          ctx.fillRect(Math.round(tx), ty, Math.max(1, Math.ceil(tw)), 1);
        }
      }
      y += lineH;
    }
  }

  const px = ctx.getImageData(0, 0, w, h).data;
  if (text) {
    // Director renders 1-bit pixel fonts with NO antialiasing — canvas AA
    // leaves a partial-alpha fringe that blends with the art behind as a
    // light halo. Harden like Director: sub-half-alpha pixels go transparent,
    // the rest snap to the exact glyph color.
    hardenTextAlpha(px, (effCol.red << 16) | (effCol.green << 8) | effCol.blue);
  }
  const img = new LImage(w, h);
  img.data = new Uint8Array(px);
  img.dirty = true;
  return img;
}

// Snap the canvas AA fringe to transparent or the exact glyph color (1-bit
// Director fonts); the partial-alpha fringe would otherwise halo behind the
// text.
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

// Snap canvas AA fringes to the exact glyph/background colors (1-bit font
// cleanup). Downstream keys match the EXACT background, so a near-bg AA pixel
// (249,249,249) survives the key and reads as a light halo — pixels within
// Manhattan 6 of an endpoint snap to it, in-between pixels classify by
// distance (near glyph -> glyph color, near bg -> transparent). No-op when
// fg and bg are too similar to classify.
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
  // Bail when fg and bg sit within the snap radius (the band is
  // unclassifiable and invisible anyway). A wider guard skipped real cases:
  // #EEEEEE links on white differ by just 17 per channel.
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
    // Near-endpoint pixels snap to the EXACT endpoint color so the key/matte
    // removes every background pixel and the glyph keeps its authored color.
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
    // Truly equidistant pixels are ambiguous — leave them. Just-shy pixels
    // are AA blends, not strokes: snap to the nearer endpoint (a wider band
    // left a light rim around 9px fields).
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

// Split text into lines that fit the box width (breaks at spaces).
function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/(\s+)/)) {
    const probe = line + word;
    if (line && ctx.measureText(probe).width > width) {
      lines.push(line);
      line = word.trimStart();
    } else {
      line = probe;
    }
  }
  if (line.trim()) lines.push(line);
  if (lines.length === 0) lines.push(text);
  return lines;
}
