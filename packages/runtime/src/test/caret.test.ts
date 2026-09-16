import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretBlinkOn, caretBox, caretX } from '../stage/caret.js';
import { textMemberCaretAt, textMemberPrefixWidth } from '../stage/text.js';
import { Member } from '../engine/members.js';

test('caret blink toggles on a half-period square wave (0.53s on / 0.53s off)', () => {
  assert.equal(caretBlinkOn(0), true);
  assert.equal(caretBlinkOn(529), true);
  assert.equal(caretBlinkOn(530), false);
  assert.equal(caretBlinkOn(1059), false);
  assert.equal(caretBlinkOn(1060), true);
  assert.equal(caretBlinkOn(1600), false);
  // custom period: 250ms on / 250ms off
  assert.equal(caretBlinkOn(249, 500), true);
  assert.equal(caretBlinkOn(250, 500), false);
  assert.equal(caretBlinkOn(500, 500), true);
});

test('caret x follows alignment and rendered text width', () => {
  // left-aligned: caret after the last glyph
  assert.equal(caretX('left', 100, 40), 40);
  assert.equal(caretX('left', 100, 0), 0);
  // right-aligned: text hugs the right edge, caret at the box edge
  assert.equal(caretX('right', 100, 40), 100);
  assert.equal(caretX('right', 100, 0), 100);
  // centered: half the box + half the text
  assert.equal(caretX('center', 100, 40), 70);
  assert.equal(caretX('center', 100, 0), 50);
  // unknown/empty alignment behaves like left (Director default)
  assert.equal(caretX(undefined, 100, 40), 40);
  assert.equal(caretX('', 100, 40), 40);
  // text wider than the box: the caret tracks the overflow (you're still typing)
  assert.equal(caretX('left', 100, 140), 140);
});

test('textMemberPrefixWidth measures the run before a caret offset', () => {
  // The selection highlight and the moved caret both need "where does character
  // i start inside the field?" — the width of everything before it in the
  // member's own font. Measured with a canvas in the browser, and monotonically
  // growing (never NaN) when there is no DOM at all.
  const m = new Member(1, 1, 'int_speechtext_text', 'text');
  m.text = 'hello world';
  m.font = 'Volter';
  m.fontSize = 9;
  const ctxMock = {
    font: '',
    measureText: (str: string) => ({ width: str.length * 8 }),
  };
  const { document } = globalThis as { document?: unknown };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    assert.equal(textMemberPrefixWidth(m, m.text, 0), 0);
    assert.equal(textMemberPrefixWidth(m, m.text, 5), 40);
    assert.equal(textMemberPrefixWidth(m, m.text, m.text.length), 88);
    // clamped past the end / before the start
    assert.equal(textMemberPrefixWidth(m, m.text, 99), 88);
    assert.equal(textMemberPrefixWidth(m, m.text, -3), 0);
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('textMemberCaretAt picks the offset nearest a click inside the text block', () => {
  // The click-to-position half of Director's field editing: the stage measures
  // the glyph run, the engine only gets the offset. 8px per character here.
  const m = new Member(1, 1, 'int_speechtext_text', 'text');
  m.text = 'hello world';
  m.font = 'Volter';
  m.fontSize = 9;
  const ctxMock = { font: '', measureText: (str: string) => ({ width: str.length * 8 }) };
  const { document } = globalThis as { document?: unknown };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    assert.equal(textMemberCaretAt(m, m.text, 40), 5);
    assert.equal(textMemberCaretAt(m, m.text, 0), 0);
    assert.equal(textMemberCaretAt(m, m.text, 4), 0, 'ties round toward the earlier offset');
    assert.equal(textMemberCaretAt(m, m.text, 5), 1);
    assert.equal(textMemberCaretAt(m, m.text, -20), 0, 'left of the text clamps to the start');
    assert.equal(textMemberCaretAt(m, m.text, 999), 11, 'right of the text clamps to the end');
    assert.equal(textMemberCaretAt(m, '', 50), 0, 'an empty field has one position');
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('caret height follows the font, not the field box', () => {
  // A Director insertion point spans the font's glyph box. Taking the sprite
  // height instead stretched the caret down whole tall inputs (a 24px gift
  // greeting field, the console compose box) and made it ignore fontSize.
  // 9px Volter: ~10px glyph box, 11px line advance.
  const volter9 = { lineH: 11, glyphH: 10 };
  // The room bar's chat field: a 10px-tall box, so the box still clamps.
  assert.deepEqual(caretBox(10, volter9.lineH, volter9.glyphH, 0), { h: 10, y: 0 });
  // The gift greeting field is 24px tall but its text is still 9px Volter.
  assert.deepEqual(caretBox(24, volter9.lineH, volter9.glyphH, 0), { h: 10, y: 0 });
  // A 44px multi-line field: the caret rides the LAST rendered line.
  assert.deepEqual(caretBox(44, volter9.lineH, volter9.glyphH, 22), { h: 10, y: 11 });
  assert.deepEqual(caretBox(44, volter9.lineH, volter9.glyphH, 33), { h: 10, y: 22 });
  // 18px font in a 20px box: the caret scales with the font size.
  assert.deepEqual(caretBox(20, 22, 20, 0), { h: 20, y: 0 });
  // A glyph box taller than the field clamps to the field, never overflowing.
  assert.deepEqual(caretBox(12, 11, 20, 0), { h: 12, y: 0 });
  // Deep in a clipped box the caret stays inside it.
  assert.deepEqual(caretBox(20, 11, 10, 55), { h: 10, y: 10 });
  // A degenerate line height falls back to the glyph box instead of dividing by 0.
  assert.deepEqual(caretBox(20, 0, 10, 0), { h: 10, y: 0 });
});
