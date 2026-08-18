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
  // Vertical glyph placement mirrors LibreShockwave's renderWithBitmapFont:
  // each line's glyph cell BOTTOM-SITS in its line box — the extra line
  // height (lineHeight minus the font's own line height) sits ABOVE the
  // glyphs, plus vertical overflow when the fixed line is shorter than the
  // font cell. The DropDown class sets fixedLineSpace to the window-def row
  // height with NO topSpacing, so em-box centering rode the text high in the
  // bar; bottom-sitting drops it in. When the Writer's topSpacing carries the
  // row remainder (topSpacing = row - fontSize) the +1/vOverflow terms cancel
  // and rows like the navigator's stay exactly where they were. For members
  // with no fixedLineSpace the old em-center inset stays — it keeps white
  // glyph tops off the member edge, which the ink-36 bake would key away.
  // fontLH: the font's own line box (canvas fontBoundingBox ascent + descent;
  // the Volter faces measure exactly size + 1, e.g. 9px -> 10).
  let fontLH = size + 1;
  let glyphTop0 = text ? (topSpacing > 0 ? topSpacing : Math.max(1, Math.round((lineH - size) / 2))) : 0;
  // boxType 0 (adjust) auto-sizes the box to its text; 1 = scroll, 2 = fixed.
  // The corpus sets these everywhere EXCEPT the Writer's scratch members,
  // which exist only as `the image of` sources for copyPixels — those must
  // render content-tight or the writer's centering math lands ~230px off.
  const autoSize = !member.textProps?.has('boxtype');
  // Fields always break on hard line breaks (CR); wordWrap only controls
  // SOFT wrapping at the box edge. Without this, the navigator's RETURN-joined
  // room names collapse onto one row. Each line carries its absolute char
  // offset so chunk styles (balloon name bold) can be applied per run.
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
        // Measure the real face's line box (LibreShockwave's
        // font->getLineHeight()); guards for engines without the
        // fontBoundingBox metrics.
        const bbA = (mctx.measureText('M') as { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
        const bbD = (mctx.measureText('M') as { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;
        if (typeof bbA === 'number' && isFinite(bbA) && bbA > 0) {
          fontLH = Math.round(bbA + (typeof bbD === 'number' && isFinite(bbD) ? bbD : 0));
        }
        if (fixed > 0) {
          // LSW: leading above the glyphs, overflow below, first line box at
          // topSpacing (+1 when topSpacing > 1 — cancels the overflow term
          // for the Writer's fixedLineSpace = fontSize members).
          const leading = Math.max(0, fixed - fontLH);
          const vOverflow = Math.max(0, fontLH - fixed);
          const lineStart0 = topSpacing + (topSpacing > 1 ? 1 : 0);
          glyphTop0 = Math.max(0, lineStart0 + leading - vOverflow);
        }
      }
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
      // Content height: the laid-out line boxes, first at lineStart0,
      // stepping lineH. When the fixed line is shorter than the font cell the
      // glyph overhang grows the box so the descenders don't clip.
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
          // Rich text: draw the line as consecutive styled runs. Each char
          // gets the merged style of every range covering it (the Balloon
          // Manager sets font/fontStyle/color on the same 1..n range, so the
          // name renders bold + colored while the message keeps the member
          // font/color). Underline is not drawn for chunk-styled text (no
          // corpus case combines them).
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
          // fontStyle is a style list — bold forces the 700 face, italic maps
          // to canvas oblique, underline draws a rule per line in the text
          // color.
          ctx.font = fontStr;
          ctx.fillStyle = `rgb(${effCol.red},${effCol.green},${effCol.blue})`;
          ctx.fillText(ln.text, x, y);
          if (style.underline && ln.text) {
            // Underline sits just below the em box, drawn in the text color
            // so the ink key treats it as glyph pixels; clamped so tight
            // 9px-in-10px boxes keep the rule.
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

// A laid-out line plus its absolute char offset in the member's text (needed
// to apply chunk styles: member.char[1..n].font = ...).
interface TextLine {
  text: string;
  start: number;
}

// Split text into lines that fit the box width (breaks at spaces). Each line
// carries the absolute char offset of its first character in `text`.
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
      // The new line's first char sits at the end of the moved whitespace.
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

// Member chunk styles (member.char[1..n].font = ...) applied to the text
// rasterizer. The effective style at a 0-based char index merges every range
// covering it; styleKey groups consecutive chars into draw runs.
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
