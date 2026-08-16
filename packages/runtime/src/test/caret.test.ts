import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretBlinkOn, caretX } from '../stage/caret.js';

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
