import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, readSpark } from '../dist/index.js';
import { unzipSync } from 'fflate';
import { parseLingo, inferScriptType, encodeScript, decodeScript, BundleLoader, DirectorEngine, LSymbol, LList } from '@habbo/runtime';

function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (val === undefined) continue;
      out[k] = norm(val);
    }
    return out;
  }
  return v;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ls')) out.push(p);
  }
  return out;
}

const corpusRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..', 'exported/31');

test('every real .ls script round-trips parse -> bytecode -> decode', { skip: existsSync(corpusRoot) ? false : 'exported/31 not present (gitignored corpus)' }, () => {
  const files = walk(corpusRoot);
  assert.ok(files.length > 500, `expected the v31 corpus, found ${files.length} scripts`);
  let raw = 0;
  let encoded = 0;
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    const parsed = parseLingo(source);
    raw += source.length;
    const bytes = encodeScript(parsed);
    encoded += bytes.length;
    const decoded = decodeScript(bytes);
    assert.deepStrictEqual(norm(decoded), norm(parsed), `round-trip mismatch in ${f}`);
  }
  console.log(`bytecode: ${files.length} scripts round-trip OK — raw ${(raw / 1024).toFixed(1)}KB -> ${(encoded / 1024).toFixed(1)}KB encoded (${(encoded / raw * 100).toFixed(1)}%)`);
});

test('bundle compiles scripts to bytecode and the runtime can decode them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bc-'));
  const cast = join(dir, 'hh_bc');
  mkdirSync(cast, { recursive: true });
  const lingo = `-- Cast member: BcTest
-- Type: Behavior
property pCounter
on beginSprite me
  pCounter = [1, 2, 3]
  repeat with i = 1 to 10
    pCounter[i] = pCounter[i] * 2
  end repeat
  if pCounter[1] <> 2 then
    return "broken"
  else
    return "ok"
  end if
end
`;
  writeFileSync(join(cast, '0001_script_BcTest.ls'), lingo);
  writeFileSync(join(cast, 'casts.txt'), '# Cast libraries\nid\tname\tpath\tmin_member\tmax_member\tmember_count\n1\tInternal\t\t1\t1\t1\n');
  writeFileSync(
    join(cast, 'movie.txt'),
    'stage_width\t720\nstage_height\t540\nstage_left\t89\nstage_top\t50\nstage_right\t809\nstage_bottom\t590\nbackground_color\t0x000020\nstage_color\t0x000100\nstage_color_rgb\t0x000000\ntempo\t24\n',
  );
  writeFileSync(join(cast, 'fonts.txt'), '32769\t2\tCourier\n');

  const { zip, manifest } = buildBundle(dir);
  const member = manifest.casts[0].members.find((m) => m.kind === 'script');
  assert.ok(member, 'script member in manifest');
  assert.equal(member.bytecode, true, 'member flagged as bytecode');

  const unzipped = unzipSync(zip);
  const bytes = unzipped[member.file];
  assert.ok(bytes, 'script bytes in bundle');
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'LBC1', 'bundle stores LBC1 bytes');

  const decoded = decodeScript(bytes);
  decoded.name = member.name;
  const parsed = parseLingo(lingo);
  parsed.name = 'BcTest';
  parsed.type = inferScriptType(lingo);
  assert.deepStrictEqual(norm(decoded), norm(parsed));
});

test('the engine executes a bytecode-loaded script identically to text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bc-engine-'));
  const castName = 'hh_bceng';
  const cast = join(dir, castName);
  mkdirSync(cast, { recursive: true });
  const lingo = `-- Cast member: Counter
-- Type: Parent
property pN
on bump me, x
  me.pN = me.pN + x
  return me.pN
end
`;
  writeFileSync(join(cast, '0001_script_Counter.ls'), lingo);
  writeFileSync(join(cast, 'casts.txt'), '# Cast libraries\nid\tname\tpath\tmin_member\tmax_member\tmember_count\n1\tInternal\t\t1\t1\t1\n');
  writeFileSync(
    join(cast, 'movie.txt'),
    'stage_width\t720\nstage_height\t540\nstage_left\t89\nstage_top\t50\nstage_right\t809\nstage_bottom\t590\nbackground_color\t0x000020\nstage_color\t0x000100\nstage_color_rgb\t0x000000\ntempo\t24\n',
  );
  writeFileSync(join(cast, 'fonts.txt'), '32769\t2\tCourier\n');

  const { zip, manifest } = buildBundle(dir);
  const member = manifest.casts[0].members.find((m) => m.kind === 'script');
  assert.equal(member.bytecode, true, 'script ships as bytecode');

  const loader = new BundleLoader();
  loader.register(zip);
  const e = new DirectorEngine();
  await e.loadCast(loader, castName);

  const script = e.resolveScript('Counter');
  assert.ok(script, 'Counter script resolves after bytecode load');
  assert.equal(script.handlers.length, 1);
  const a = e.interp.newInstance(script, []);
  const out = e.interp.callBuiltin([new LSymbol('bump'), new LList([a]), 4]);
  assert.equal(out, 4);
  e.interp.callBuiltin([new LSymbol('bump'), new LList([a]), 1]);
  assert.equal(a.props.get('pN'), 5, 'instance state persists across calls');
});

test('invalid lingo falls back to shipping text (no bytecode flag)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bc-bad-'));
  const cast = join(dir, 'hh_bad');
  mkdirSync(cast, { recursive: true });
  writeFileSync(join(cast, '0001_script_Broken.ls'), 'on broken me\n  this is not lingo ;;;\nend\n');
  writeFileSync(join(cast, 'casts.txt'), '# Cast libraries\nid\tname\tpath\tmin_member\tmax_member\tmember_count\n1\tInternal\t\t1\t1\t1\n');
  writeFileSync(
    join(cast, 'movie.txt'),
    'stage_width\t720\nstage_height\t540\nstage_left\t89\nstage_top\t50\nstage_right\t809\nstage_bottom\t590\nbackground_color\t0x000020\nstage_color\t0x000100\nstage_color_rgb\t0x000000\ntempo\t24\n',
  );
  writeFileSync(join(cast, 'fonts.txt'), '32769\t2\tCourier\n');

  const { zip, manifest } = buildBundle(dir);
  const member = manifest.casts[0].members.find((m) => m.kind === 'script');
  assert.equal(member.bytecode, undefined, 'broken script stays text');
  const unzipped = unzipSync(zip);
  const bytes = unzipped[member.file];
  assert.equal(Buffer.from(bytes).toString('utf8').trim().startsWith('on broken'), true, 'text shipped untouched');
});