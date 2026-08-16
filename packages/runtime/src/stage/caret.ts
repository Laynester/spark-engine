/**
 * Director player-level text-editing caret (the blinking insertion bar).
 *
 * The original Shockwave player rendered a blinking 1px caret natively inside
 * the editable field that holds `the keyboardFocusSprite`; the corpus never
 * draws one itself. Without this emulation an input field gives no sign it is
 * waiting for keystrokes. Pure functions so the geometry + blink run headless
 * in tests; PixiStage.syncCaret consumes them each frame.
 */

/** Square-wave blink: `nowMs` is ON for the first half of each `periodMs`,
 *  OFF for the second half. Director's caret toggles at ~1Hz (0.5s on,
 *  0.5s off), so the default period is 1060ms. */
export function caretBlinkOn(nowMs: number, periodMs = 1060): boolean {
  return Math.floor(nowMs / (periodMs / 2)) % 2 === 0;
}

/** Horizontal position of the caret inside a field of width `boxW` whose
 *  rendered text is `textW` wide. Director places the insertion point after
 *  the last character: left-aligned text hugs the box's left edge, center
 *  text sits centered, right-aligned text touches the right edge. An empty
 *  field shows the caret where the first character would land. */
export function caretX(alignment: string | undefined, boxW: number, textW: number): number {
  if (alignment === 'center') return boxW / 2 + textW / 2;
  if (alignment === 'right') return boxW;
  return textW;
}
