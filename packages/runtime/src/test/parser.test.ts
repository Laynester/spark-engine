import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExpr, parseLingo } from '../lingo/parser.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../');
const EXPORTED = join(ROOT, 'exported');
// The exported corpus is gitignored, so CI (fresh checkout) has no /exported.
// The corpus-scanning tests skip there instead of failing the suite.
const HAS_EXPORTED = existsSync(EXPORTED);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

test('parser handles every real .ls script in /exported', { skip: !HAS_EXPORTED }, () => {
  const files: string[] = [];
  walk(EXPORTED, files);
  const scripts = files.filter((f) => f.endsWith('.ls'));
  assert.ok(scripts.length > 500, `expected >500 scripts, found ${scripts.length}`);

  const failures: string[] = [];
  for (const f of scripts) {
    const src = readFileSync(f, 'utf8');
    try {
      parseLingo(src);
    } catch (e) {
      failures.push(`${f}: ${(e as Error).message}`);
    }
  }
  assert.equal(failures.length, 0, failures.slice(0, 25).join('\n'));
});

test('parser handles Lingo data literals used in .props/.window text members', () => {
  const samples = [
    '["a": [#zshift: [-950, -950, -950, -950, -950, -950, -950, -950]]]',
    '[59: #handle_flatcreated, 33: #handle_error]',
    '[#short: 3, #short: 2]',
    '[:]',
    '[#Msg: "Alert_unacceptableName", #id: "namenogood", #modal: 1]',
    'item 2 to 4 of "a,b,c,d"',
    'tName.char[1..length(tName) - 1]',
    'the number of castMembers of castLib tCastLib',
    'member(getmemnum(tName & ".props")).text',
  ];
  for (const s of samples) parseExpr(s);
});

test('a real .props.txt member parses as a Lingo expression', { skip: !HAS_EXPORTED }, () => {
  const files: string[] = [];
  walk(EXPORTED, files);
  const props = files.filter((f) => f.endsWith('.props.txt'));
  assert.ok(props.length > 0);
  let parsed = 0;
  for (const f of props.slice(0, 40)) {
    try {
      parseExpr(readFileSync(f, 'utf8'));
      parsed++;
    } catch (e) {
      // not every props file is a pure literal; only failures on the parse path matter
      void e;
    }
  }
  assert.ok(parsed >= 1, 'expected at least one props file to be a pure literal');
});
