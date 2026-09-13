import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorEngine } from '../engine/engine.js';
import { LColor, LList, VOID } from '../lingo/values.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../');
const EXPORTED = join(ROOT, 'exported');
// The exported corpus is gitignored, so CI (fresh checkout) has no /exported.
// The corpus-driven test skips there instead of failing the suite.
const COLOR_CONVERTER = join(EXPORTED, '31/hh_roomdimmer/scripts/0009_script_Color_Converter_Class.ls');
const HAS_CORPUS = existsSync(COLOR_CONVERTER);

function items(v: unknown): unknown[] {
  assert.ok(v instanceof LList, `expected a list, got ${JSON.stringify(v)}`);
  return (v as LList).items;
}

// --- list arithmetic: `/` must work element-wise like + - * -------------------
//
// Director applies an arithmetic operator to every element when one side is a
// list. lingoAdd/lingoSubtract/lingoMultiply did this; `/` had no list branch and
// fell through to asNum(list) = 0, so the whole expression evaluated to 0.
// hh_roomdimmer's Color Converter opens both converters with a list divide
// (RGBtoHSL: `tRGB = tRGB / 255.0`, HSLtoRGB: `tHSL = tHSL / 255.0`).

test('list / scalar divides element-wise (Director), not to 0', () => {
  const e = new DirectorEngine();
  const rgb = e.interp.evalExpressionString('[255, 128, 0] / 255.0');
  const parts = items(rgb);
  assert.equal(parts.length, 3);
  assert.ok(Math.abs((parts[0] as number) - 1) < 1e-9, 'red 255/255 = 1');
  assert.ok(Math.abs((parts[1] as number) - 128 / 255) < 1e-9, 'green 128/255');
  assert.equal(parts[2], 0);

  const ints = items(e.interp.evalExpressionString('[255, 128, 0] / 5'));
  assert.ok(Math.abs((ints[0] as number) - 51) < 1e-9);
  assert.ok(Math.abs((ints[1] as number) - 25.6) < 1e-9);
  assert.equal(ints[2], 0);

  // Control: the neighbours in the same operator family already did this.
  assert.deepEqual(items(e.interp.evalExpressionString('[255, 128, 0] * 2')), [510, 256, 0]);
  assert.deepEqual(items(e.interp.evalExpressionString('[255, 128, 0] + 1')), [256, 129, 1]);
});

test('list / list and scalar / list divide element-wise; scalar / scalar is untouched', () => {
  const e = new DirectorEngine();
  assert.deepEqual(items(e.interp.evalExpressionString('[10, 20, 30] / [2, 5, 3]')), [5, 4, 10]);
  assert.deepEqual(items(e.interp.evalExpressionString('[12, 8] / 4')), [3, 2]);
  assert.deepEqual(items(e.interp.evalExpressionString('[8, 4] / 2.0')), [4, 2]);
  assert.deepEqual(items(e.interp.evalExpressionString('100 / [4, 5]')), [25, 20]);
  // Scalar path keeps Director's integer division (docs: "4/3 is 1"; float()
  // forces reals) and the existing void / divide-by-zero guards.
  assert.equal(e.interp.evalExpressionString('7 / 2'), 3, 'integer/integer truncates (Director)');
  assert.equal(e.interp.evalExpressionString('7 / 2.0'), 3.5, 'a float operand forces real division');
  assert.equal(e.interp.evalExpressionString('7 / 0'), 7, 'divide-by-zero guard (divisor -> 1) unchanged');
  assert.equal(e.interp.evalExpressionString('VOID / 2'), 0, 'void guard unchanged');
});

// --- float-ness follows the VALUE, not just the written expression -----------
//
// Director: a value computed with any float operand stays a float, so the next
// statement's `/` is a real divide. The runtime tracks this with an
// epoch-scoped value mark plus a per-name flag; the name flag was only set from
// a STATIC read of the RHS expression, so a float that only appeared through a
// variable (`tDiff = 0.5` then `tH = 60 * tDiff / tDiff + 120`) was recorded as
// an integer and `tH / 360` truncated to 0. That is precisely
// `RGBtoHSL`'s `tH = integer(tH / 360 * 255)` — every hue came out 0.

test('a float reaching a variable through an expression propagates to the next statement', () => {
  const e = new DirectorEngine();
  e.addScriptMember('FloatProp', 'movie', [
    'on FloatThroughVar',
    '  tDiff = 0.5',
    '  tH = 60 * tDiff / tDiff + 120',
    '  return [tH, tH / 360, tH / 360 * 255, integer(tH / 360 * 255)]',
    'end',
    'on FloatCopy',
    '  tDiff = 0.5',
    '  tH = tDiff * 2.0',
    '  return [tH, tH / 4]',
    'end',
    'on IntegerStaysInteger',
    '  tH = 180',
    '  return [tH, tH / 360, integer(tH / 360 * 255)]',
    'end',
  ].join('\n'));

  assert.deepEqual(items(e.interp.evalExpressionString('FloatThroughVar()')), [180, 0.5, 127.5, 128]);
  assert.deepEqual(items(e.interp.evalExpressionString('FloatCopy()')), [1, 0.25]);
  // An integer literal assignment must stay an integer (Director truncates).
  assert.deepEqual(items(e.interp.evalExpressionString('IntegerStaysInteger()')), [180, 0, 0]);
});

// --- list max()/min(): Director documents `list.max()` ------------------------
//
// hh_roomdimmer's Color Converter calls `tRGB.max()` / `tRGB.min()` and the
// dimmer interface calls `tHueDiff.min()`. listMethod had no case for either, so
// they warned "list method max not implemented" and returned VOID, which made the
// hue/L of every colour 0.

test('list.max()/list.min() return the highest/lowest value (Director list method)', () => {
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('[3, 9, 4].max()'), 9);
  assert.equal(e.interp.evalExpressionString('[3, 9, 4].min()'), 3);
  assert.equal(e.interp.evalExpressionString('max([3, 9, 4])'), 9, 'function form still works');
  assert.equal(e.interp.evalExpressionString('min([3, 9, 4])'), 3, 'function form still works');
  assert.equal(e.interp.evalExpressionString('[].max()'), 0, 'empty list -> 0 (builtin parity)');
});

// --- the dimmer's own colour converter, verbatim from the corpus --------------

test('real v31 Color Converter Class: RGBtoHSL/HSLtoRGB round-trip the dimmer palette', { skip: !HAS_CORPUS }, () => {
  const e = new DirectorEngine();
  e.addScriptMember('Color Converter Class', 'movie', readFileSync(COLOR_CONVERTER, 'utf8'));

  // dimmer.color.1 = #74f5f5 (hh_roomdimmer/texts/0002_text_variable.index.txt)
  // H is on Director's 0-255 scale: 180deg -> 128, S -> 221, L -> 181.
  const hsl = items(e.interp.evalExpressionString('RGBtoHSL(rgb(116, 245, 245))')).map((v) => v as number);
  assert.deepEqual(hsl, [128, 221, 181], 'RGBtoHSL(#74f5f5) = [H 128, S 221, L 181]');

  const back = e.interp.evalExpressionString('HSLtoRGB([128, 221, 181])');
  assert.ok(back instanceof LColor, `HSLtoRGB returns a colour, got ${JSON.stringify(back)}`);
  const c = back as LColor;
  // #74f5f5 -> [128, 221, 181] -> within a couple of units of the original.
  assert.ok(Math.abs(c.red - 116) <= 2, `red ~116, got ${c.red}`);
  assert.ok(Math.abs(c.green - 245) <= 2, `green ~245, got ${c.green}`);
  assert.ok(Math.abs(c.blue - 245) <= 2, `blue ~245, got ${c.blue}`);

  // The dimmer computes a target colour from a preset + the slider lightness and
  // applies it via colourizeRoom; with the list divide broken this was always 0
  // (black), so assert the lightness override actually moves the colour.
  const applied = e.interp.evalExpressionString('HSLtoRGB([128, 221, 128])');
  assert.ok(applied instanceof LColor, 'composed dimmer colour resolves to a colour');
  const a = applied as LColor;
  assert.notEqual(`${a.red},${a.green},${a.blue}`, '0,0,0', 'dimmer colour is not black');
  assert.ok(a.green > a.red && a.blue > a.red, 'hue survives the lightness override (cyan, low red)');

  // Regression guard for the primitives the converter is built from.
  assert.equal(e.interp.evalExpressionString('[1, 2, 3].max()'), 3);
  assert.notEqual(e.interp.evalExpressionString('[255, 128, 0] / 255.0'), VOID);
});
