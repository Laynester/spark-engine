import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorEngine } from '../engine/engine.js';
import { asNum, toLingoString, type LVal } from '../lingo/values.js';

// Director strings are BYTE strings in this engine: every byte<->string boundary is
// Latin-1 (bytesOf/latin1Of, MUS payloads, HTTP bodies). The corpus decides whether to
// run its own UTF-8 codec from the PLAYER version it is running under —
// fuse_client/0037 String Services Class:
//
//   if value(chars(_player.productVersion, 1, 2)) >= 11 then pUnicodeDirector = 1
//   ...
//   if pUnicodeDirector and not tForceDecode then return tStr      -- decodeUTF8
//   if not pUnicodeDirector then tPartOne = encodeUTF8(tPartOne)   -- Multiuser 0052
//
// A Director 11+ player holds Unicode text, so the corpus leaves decoding to it. This
// engine does NOT — so if it answers "11", the client never decodes the UTF-8 the
// server sends: the alt-code character "ª" (C2 AA) renders as the two characters "Âª"
// and is re-encoded as C3 82 C2 AA ("ÃÂª") when a reply goes back out.
//
// Repo root derived from this file's location (dist/test -> dist -> runtime -> packages -> root).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const STRING_SERVICES = readFileSync(
  resolve(ROOT, 'exported/31/fuse_client/scripts/0037_script_String_Services_Class.ls'),
  'utf8',
);

const codes = (v: LVal): number[] => [...toLingoString(v)].map((c) => c.charCodeAt(0));

/** The live String Services instance, constructed the way the corpus's manager does. */
function stringServices(flag: number): { e: DirectorEngine; inst: ReturnType<DirectorEngine['interp']['newInstance']> } {
  const e = new DirectorEngine();
  // The Variable Manager's `client.textdata.utf8`, dumped from the external
  // variables file; it is what arms the corpus's encode/decodeUTF8 at all.
  e.globalSet('client.textdata.utf8', flag);
  const member = e.addScriptMember('String Services Class', 'movie', STRING_SERVICES);
  const inst = e.interp.newInstance(member.script!, []);
  // `construct` is where the corpus reads the player version, so it has to run.
  e.interp.callObjectHandler(inst, 'construct', []);
  return { e, inst };
}

test('_player reports a byte-string (pre-Unicode) Director', () => {
  const e = new DirectorEngine();
  assert.equal(asNum(e.interp.evalExpressionString('stringp(_player.productVersion)')), 1);
  // The corpus's own switch: 10.x => 0 (byte strings), 11+ => 1 (Unicode text).
  assert.equal(
    asNum(e.interp.evalExpressionString('value(chars(_player.productVersion, 1, 2)) >= 11')),
    0,
    'Director 11+ would make the corpus skip its UTF-8 codec',
  );
});

test('String Services decodes and encodes UTF-8 under the byte-string player', () => {
  const { e, inst } = stringServices(1);
  assert.equal(asNum(e.interp.getPropValue(inst, 'pUnicodeDirector')), 0);

  // Server -> client: the chat arrives as UTF-8 bytes; each char is C2 + its code.
  for (const code of [0xaa, 0xb6, 0xba]) {
    const utf8 = e.interp.evalExpressionString(`numToChar(194) & numToChar(${code})`);
    assert.deepEqual(codes(e.interp.callObjectHandler(inst, 'decodeUTF8', [utf8])), [code], `decode 0x${code.toString(16)}`);
  }

  // Client -> server: the same characters go back out as UTF-8, once each.
  for (const code of [0xaa, 0xb6, 0xba]) {
    const enc = e.interp.callObjectHandler(inst, 'encodeUTF8', [e.interp.evalExpressionString(`numToChar(${code})`)]);
    assert.deepEqual(codes(enc), [0xc2, code], `encode 0x${code.toString(16)}`);
  }
});

test('the Windows client never loads the MacOS byte-translation table (ª ¶ º survive forwardMsg)', () => {
  // String Services::initConvList picks WHICH 8-bit translation table to apply to
  // every inbound message (0051 Connection Instance::forwardMsg -> convertSpecialChars):
  //
  //   if the platform contains "win" then tMachineType = ".win" else tMachineType = ".mac"
  //
  // Director's `the platform` on Windows is "Windows,32"
  // (lingo-docs/drmx2004_scripting_ref.txt:30256) while the corpus asks for the
  // lowercase "win" here — and for "windows" in hh_entry/0003, the JP/RU patches,
  // and "Plugin"/"Author" on the runMode — so `contains` has to fold case. When it
  // did not, this gate loaded the MacOS table (char.conversion.mac, the big map in
  // apps/demo/public/external_vars_31.txt:54) into a WINDOWS client and rewrote every
  // latin1 byte it received: ª (aa) -> », ¶ (b6) -> ¦ (a6), º (ba) -> ¼ (bc).
  const e = new DirectorEngine();
  assert.equal(asNum(e.interp.evalExpressionString('"Windows,32" contains "win"')), 1, 'platform gate folds case');
  // The two tables the corpus reads (System Props: `char.conversion.win = [128:164]`,
  // external variables: the mac map — the three entries that matter here are real).
  e.globalSet('char.conversion.win', e.interp.evalExpressionString('[128: 164]'));
  e.globalSet('char.conversion.mac', e.interp.evalExpressionString('[170: 187, 182: 166, 186: 188]'));
  const member = e.addScriptMember('String Services Class', 'movie', STRING_SERVICES);
  const inst = e.interp.newInstance(member.script!, []);
  e.interp.callObjectHandler(inst, 'initConvList', []);

  for (const code of [0xaa, 0xb6, 0xba]) {
    const one = e.interp.evalExpressionString(`numToChar(${code})`);
    assert.deepEqual(codes(e.interp.callObjectHandler(inst, 'convertSpecialChars', [one])), [code], `forwardMsg keeps 0x${code.toString(16)}`);
  }
});

test('the codec stays inert when the server never set client.textdata.utf8', () => {
  // The server's config decides: without the flag the client is a plain latin1
  // client and must hand the bytes through untouched, in both directions.
  const { e, inst } = stringServices(0);
  assert.deepEqual(codes(e.interp.callObjectHandler(inst, 'decodeUTF8', [e.interp.evalExpressionString('numToChar(194) & numToChar(170)')])), [0xc2, 0xaa]);
  assert.deepEqual(codes(e.interp.callObjectHandler(inst, 'encodeUTF8', [e.interp.evalExpressionString('"ª"')])), [0xaa]);
});
