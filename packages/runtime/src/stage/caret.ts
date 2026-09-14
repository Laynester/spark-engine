
export function caretBlinkOn(nowMs: number, periodMs = 1060): boolean {
  return Math.floor(nowMs / (periodMs / 2)) % 2 === 0;
}

export function caretX(alignment: string | undefined, boxW: number, textW: number): number {
  if (alignment === 'center') return boxW / 2 + textW / 2;
  if (alignment === 'right') return boxW;
  return textW;
}

/**
 * The insertion point's own box inside a text field. A Director caret is one
 * line of the field's FONT — its glyph box (ascent + descent) — not the height
 * of the field: a 9px Volter field in a 24px box gets a ~10px caret sitting at
 * the top of the text, not a 1px bar stretched down the whole box. `boxH` only
 * clamps it.
 *
 * `lineH` is the font's line advance and `textBlockH` the height the live text
 * block renders to, so the caret rides the LAST line the way typed text is
 * appended, and scrolls/clamps nowhere past the box.
 */
export function caretBox(
  boxH: number,
  lineH: number,
  glyphH: number,
  textBlockH: number,
): { h: number; y: number } {
  const box = Math.max(1, boxH);
  const h = Math.min(box, Math.max(1, glyphH));
  const advance = lineH > 0 ? lineH : h;
  const lines = textBlockH > advance ? Math.max(1, Math.round(textBlockH / advance)) : 1;
  const y = Math.max(0, Math.min(box - h, (lines - 1) * advance));
  return { h, y };
}
