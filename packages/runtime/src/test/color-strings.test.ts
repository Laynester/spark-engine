import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectorEngine } from '../engine/engine.js';
import { LColor, asNum } from '../lingo/values.js';

// Director's colour <-> string conversions, as the v31 corpus relies on them.
//
// Two bugs, one class: the runtime treated a colour string as if it had to be
// exactly `RRGGBB`, and stringified a colour as `color(r, g, b)`. Both differ
// from Director (`rgb(r, g, b)`, and a colour string is read from its LEADING
// hex digits), and the corpus slices those strings apart by character offset.

/** string(rgb(...)) — Director prints `rgb(r, g, b)`. */
test('string(colour) is rgb(r, g, b), and paletteIndex(n) for indexed colours', () => {
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('string(rgb(255, 255, 51))'), 'rgb(255, 255, 51)');
  assert.equal(e.interp.evalExpressionString('string(rgb(0, 0, 0))'), 'rgb(0, 0, 0)');
  // `paletteIndex(n)` resolves through the movie palette at construction, so it
  // reports its RGB; a colour that still carries an index (an image pixel from a
  // palette member) prints as paletteIndex(n) like Director's `put palColorObj`.
  assert.equal(e.interp.evalExpressionString('string(paletteIndex(20))'), 'rgb(128, 128, 128)');
});

/** `rgb(string)` reads the leading hex digits; a bad string is still black. */
test('rgb()/color() read a colour string from its leading hex digits', () => {
  const chan = (e: DirectorEngine, expr: string): string => {
    const c = e.interp.evalExpressionString(expr);
    assert.ok(c instanceof LColor, `${expr} -> expected an LColor, got ${String(c)}`);
    const col = c as LColor;
    return `${col.red},${col.green},${col.blue}`;
  };
  const e = new DirectorEngine();
  assert.equal(chan(e, 'rgb("FFFF33")'), '255,255,51');
  assert.equal(chan(e, 'rgb("#FFFF33")'), '255,255,51');
  assert.equal(chan(e, 'rgb("FFFF33 hello world")'), '255,255,51', 'trailing note text is ignored');
  assert.equal(chan(e, 'color("FF0000 rest")'), '255,0,0');
  assert.equal(chan(e, 'rgb("not a colour")'), '0,0,0', 'unparseable stays black');
  assert.equal(chan(e, 'rgb("12")'), '0,0,0', 'too few digits stays black');
});

/**
 * The stickie note window's paper colour.
 *
 * Havana/R39's `IDATA` composer writes the post-it as
 *   `response.writeString(id); response.write(colour, ' '); response.writeString(text);`
 * so the client's second field is `"FFFF33 hello world"` — the colour, a space,
 * then the note text. `Room Handler Class::handle_idata` takes
 * `tdata.line[1].item[1]` and `PostIt Manager Class::setItemData` feeds that
 * straight into `rgb(ttype)`; with a strict six-character parse every note that
 * had text painted black (an empty note is the colour alone, so it looked fine).
 */
test('corpus post-it parse: rgb(ttype) keeps the colour when the data carries text', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Stickie',
    'movie',
    [
      'on note tdata',
      '  -- verbatim: hh_room/0005 Room Handler Class::handle_idata',
      '  tDelim = the itemDelimiter',
      '  the itemDelimiter = TAB',
      '  ttype = tdata.line[1].item[1]',
      '  tText = ttype & RETURN & tdata.line[2..tdata.line.count]',
      '  the itemDelimiter = tDelim',
      '  tMsg = [#id: 1234, #text: tText, #type: ttype]',
      '  -- verbatim: hh_furni_classes/0022 PostIt Manager Class::setItemData',
      '  tStickieText = tMsg[#text].word[2..tMsg[#text].word.count]',
      '  tColor = rgb(tMsg[#type])',
      '  return tColor.red & "," & tColor.green & "," & tColor.blue & "|" & tStickieText',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Stickie')!;
  const handler = script.handlers.find((h) => h.name.toLowerCase() === 'note')!;
  const note = (data: string): string => String(e.interp.callHandler(script, handler, [data], null, new Set()));

  assert.equal(note('FFFF33'), '255,255,51|', 'colour alone (note without text)');
  assert.equal(note('FFFF33 '), '255,255,51|');
  assert.equal(note('FFFF33 hello world'), '255,255,51|hello world');
  assert.equal(note('FFFF33 hello\rworld'), '255,255,51|hello world');
  assert.equal(note('9CCEFF blue note'), '156,206,255|blue note');
  // A colour that is not one of the post-it palette entries is still accepted
  // here; the server is what range-checks SETITEMDATA.
  assert.equal(note('#EEEEEE grey'), '238,238,238|grey');
});

/**
 * The pool's swimsuit colour.
 *
 * `Pellehyppy Interface Class::eventProcUimakoppi` sends
 *   tColor = string(pSwimSuitColor)
 *   tR = value(tColor.item[1].char[5..tColor.item[1].length])
 *   tG = value(tColor.item[2])
 *   tB = value(tColor.item[3].char[1..tColor.item[3].length - 1])
 *   send("SWIMSUIT", "ch=" & pSwimSuitModel & "/" & tR & "," & tG & "," & tB)
 * i.e. it assumes the `rgb(` prefix and the trailing `)`. Stringifying as
 * `color(...)` made `char[5..length]` = `"r(255"`, so the red channel went out
 * as 0 and the room rendered the wrong swimsuit colour.
 */
test('corpus pool swimsuit: the colour sent to the room survives string()', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Swimsuit',
    'movie',
    [
      'on goButtonH pSwimSuitColor, pSwimSuitModel',
      '  -- verbatim: hh_room_pool/0003 Pellehyppy Interface Class::eventProcUimakoppi',
      '  tTempDelim = the itemDelimiter',
      '  the itemDelimiter = ","',
      '  tColor = string(pSwimSuitColor)',
      '  tR = value(tColor.item[1].char[5..tColor.item[1].length])',
      '  tG = value(tColor.item[2])',
      '  tB = value(tColor.item[3].char[1..tColor.item[3].length - 1])',
      '  the itemDelimiter = tTempDelim',
      '  tColor = tR & "," & tG & "," & tB',
      '  return "ch=" & pSwimSuitModel & "/" & tColor',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Swimsuit')!;
  const handler = script.handlers.find((h) => h.name.toLowerCase() === 'gobuttonh')!;
  const send = (colour: LColor, model: string): string =>
    String(e.interp.callHandler(script, handler, [colour, model], null, new Set()));

  // hh_room_pool/texts color list: yellow, blue, pink, green (the room-bar swatches).
  assert.equal(send(new LColor(255, 255, 51), 's01'), 'ch=s01/255,255,51');
  assert.equal(send(new LColor(156, 206, 255), 's02'), 'ch=s02/156,206,255');
  assert.equal(send(new LColor(156, 255, 156), 's01'), 'ch=s01/156,255,156');
  // The default when nothing was picked (`pSwimSuitColor = rgb("#EEEEEE")`).
  assert.equal(send(e.interp.evalExpressionString('rgb("#EEEEEE")') as LColor, 's03'), 'ch=s03/238,238,238');
  assert.equal(asNum('1'), 1, 'sanity: value()/asNum agree on plain digits');
});
