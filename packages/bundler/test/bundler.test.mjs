import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBundle, buildSparkBundle, readSpark, isSparkBytes, encodePalette, isPaletteBytes } from '../dist/index.js';
import { unzipSync, zlibSync } from 'fflate';
import { decodePng, decodePix8, isPix8, BundleLoader, DirectorEngine } from '@habbo/runtime';

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bundle-'));
  const cast = join(dir, 'hh_demo');
  mkdirSync(cast, { recursive: true });
  writeFileSync(join(cast, '0001_script_Loop.ls'), '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n');
  writeFileSync(join(cast, '0002_bitmap_Logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(cast, '0002_bitmap_Logo.regpoint'), 'regX=29\nregY=23\n');
  writeFileSync(join(cast, '0002_bitmap_Logo.pal'), 'JASC-PAL\n0100\n256\n255 255 255\n0 0 0\n');
  writeFileSync(join(cast, '0004_palette_citybg.pal'), 'JASC-PAL\n0100\n256\n255 255 255\n31 31 31\n');
  writeFileSync(join(cast, '0003_text_greeting.window.txt'), 'hello');
  writeFileSync(join(cast, 'fonts.txt'), '32769\t2\tCourier\n32770\t2\tArial\n');
  writeFileSync(
    join(cast, 'movie.txt'),
    'stage_width\t720\nstage_height\t540\nstage_left\t89\nstage_top\t50\nstage_right\t809\nstage_bottom\t590\nbackground_color\t0x000020\nstage_color\t0x000100\nstage_color_rgb\t0x000000\ntempo\t24\n',
  );
  writeFileSync(
    join(cast, 'casts.txt'),
    '# Cast libraries\nid\tname\tpath\tmin_member\tmax_member\tmember_count\n66560\tInternal\t\t1\t4\t4\n1024\tfuse_client\tD:\\LINGO\\Builds\\fuse_client.cst\t1\t82\t82\n132096\tbin\t\t1\t0\t0\n1024\tempty 1\tD:\\LINGO\\Builds\\empty.cst\t1\t0\t0\n',
  );
  return dir;
}

test('bundler builds a zip with a correct manifest', () => {
  const dir = makeFixture();
  const { zip, manifest } = buildBundle(dir);

  assert.equal(manifest.casts.length, 1);
  const cast = manifest.casts[0];
  assert.equal(cast.name, 'hh_demo');
  assert.equal(cast.members.length, 4); // script + bitmap + text + palette

  const loop = cast.members.find((m) => m.name === 'Loop');
  assert.ok(loop);
  assert.equal(loop.kind, 'script');
  assert.equal(loop.number, 1);

  const logo = cast.members.find((m) => m.name === 'Logo');
  assert.equal(logo.regX, 29);
  assert.equal(logo.regY, 23);

  const greeting = cast.members.find((m) => m.name === 'greeting.window');
  assert.equal(greeting.kind, 'text');
  assert.equal(greeting.inlineText, 'hello');

  assert.equal(cast.fonts.length, 2);
  assert.equal(cast.fonts[0].fontName, 'Courier');

  // movie.txt + casts.txt are parsed into the manifest.
  assert.equal(cast.movie.stageWidth, 720);
  assert.equal(cast.movie.stageHeight, 540);
  assert.equal(cast.movie.stageLeft, 89);
  assert.equal(cast.movie.backgroundColor, 0x000020);
  assert.equal(cast.movie.stageColorRgb, 0x000000, 'resolved RGB parsed (black)');
  assert.equal(cast.movie.tempo, 24);
  assert.equal(cast.castList.length, 4);
  assert.equal(cast.castList[0].name, 'Internal');
  assert.equal(cast.castList[0].path, '');
  assert.equal(cast.castList[1].name, 'fuse_client');
  assert.equal(cast.castList[1].memberCount, 82);
  assert.equal(cast.castList[2].name, 'bin');

  // Zip round-trip: manifest entry + all files present.
  const unzipped = unzipSync(zip);
  assert.ok(unzipped['bundle-manifest.json']);
  assert.ok(unzipped['hh_demo/0001_script_Loop.ls']);
  assert.ok(unzipped['hh_demo/0002_bitmap_Logo.png']);
  assert.equal(new TextDecoder().decode(unzipped['bundle-manifest.json']).includes('hh_demo'), true);
});

test('spark container: single-stream, round-trips every file, smaller than the zip', () => {
  const dir = makeFixture();
  // Real casts carry hundreds of near-identical palette files; repeat one here
  // so the single-stream dedup win is deterministic (zip compresses each file
  // independently and cannot share the history).
  mkdirSync(join(dir, 'hh_demo', 'bitmaps'), { recursive: true });
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(dir, 'hh_demo', 'bitmaps', `dup_${String(i).padStart(2, '0')}.pal`), 'JASC-PAL\n0100\n256\n255 255 255\n249 249 249\n31 31 31\n0 0 0\n');
  }
  const { spark, manifest } = buildSparkBundle(dir);
  const { zip } = buildBundle(dir);

  assert.ok(isSparkBytes(spark), 'spark magic present');
  // The single deflate stream dedupes shared content across files; the zip's
  // per-file streams cannot. Real casts measure ~40% smaller.
  assert.ok(spark.length < zip.length, `spark ${spark.length}B should beat zip ${zip.length}B`);

  // Round-trip: index offsets slice the body back to the exact original files.
  const { index, body } = readSpark(spark);
  assert.equal(manifest.files.length + 2, Object.keys(index).length, 'manifest + every file + the shared palette indexed');
  const slice = (p) => {
    const [off, len] = index[p];
    return body.subarray(off, off + len);
  };
  const script = slice('hh_demo/0001_script_Loop.ls');
  assert.equal(String.fromCharCode(script[0], script[1], script[2], script[3]), 'LBC1', 'script payload is compiled bytecode');
  const png = slice('hh_demo/0002_bitmap_Logo.png');
  assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3], 'binary payload byte-exact');
  const man = JSON.parse(new TextDecoder().decode(slice('bundle-manifest.json')));
  assert.equal(man.casts[0].name, 'hh_demo', 'manifest entry readable');
  const loop = man.casts[0].members.find((m) => m.kind === 'script');
  assert.equal(loop.bytecode, true, 'script member flagged as bytecode');
});

test('palettes ship as compact PALB binary; unparseable ones stay text', () => {
  const dir = makeFixture();
  const { zip, manifest } = buildBundle(dir);
  const unzipped = unzipSync(zip);

  // The bitmap's companion .pal (2 real triplets) encodes to PALB binary and
  // rewires to a SINGLE shared palette entry (the CCT stores the cast palette
  // once; the corpus repeats palettes across hundreds of companions).
  const bitmap = manifest.casts[0].members.find((m) => m.kind === 'bitmap');
  assert.match(bitmap.palRel, /^pals\/pal_\d+_[0-9a-f]+\.pal$/, 'companion rewired to a content-addressed shared entry');
  assert.ok(!manifest.files.includes('hh_demo/0002_bitmap_Logo.pal'), 'pruned duplicate not shipped');
  const pal = unzipped[bitmap.palRel];
  assert.ok(isPaletteBytes(pal), 'JASC companion .pal encoded to PALB');
  const count = pal[4] | (pal[5] << 8);
  assert.equal(count, 2, 'triplet count preserved');
  assert.deepEqual([...pal.subarray(6, 12)], [255, 255, 255, 0, 0, 0], 'RGB bytes match the JASC text');

  // decode via encodePalette's inverse contract (same triplets as parsePalette)
  const enc = encodePalette(new Uint8Array(Buffer.from('JASC-PAL\n0100\n256\n255 255 255\n0 0 0\n')));
  assert.deepEqual([...enc.subarray(6)], [255, 255, 255, 0, 0, 0], 'encodePalette round-trips the fixture palette');

  // A .pal that is not JASC triplets stays as raw text (no PALB magic) and
  // also lands on a shared entry.
  writeFileSync(join(dir, 'hh_demo', '0006_bitmap_odd.pal'), 'not a palette\n');
  writeFileSync(join(dir, 'hh_demo', '0006_bitmap_odd.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const { zip: z2, manifest: man2 } = buildBundle(dir);
  const unz2 = unzipSync(z2);
  const odd = man2.casts[0].members.find((m) => m.file === 'hh_demo/0006_bitmap_odd.png');
  const oddPal = unz2[odd.palRel];
  assert.ok(!isPaletteBytes(oddPal), 'unparseable .pal ships as text');
  assert.equal(new TextDecoder().decode(oddPal), 'not a palette\n');

  // The single-stream spark carries the same binary palettes.
  const { spark, manifest: sm } = buildSparkBundle(dir);
  const { index, body } = readSpark(spark);
  const reBmp = sm.casts[0].members.find((m) => m.kind === 'bitmap');
  const [off, len] = index[reBmp.palRel];
  assert.ok(isPaletteBytes(body.subarray(off, off + len)), 'spark container ships PALB palettes');
  void manifest;
});

function buildIndexedPng(width, height, indices, palette) {
  const stride = width;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    for (let x = 0; x < width; x++) raw[y * (1 + stride) + 1 + x] = indices[y * width + x];
  }
  const idat = zlibSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of [...new TextEncoder().encode(type), ...data]) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    out.set([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 8 + data.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  });
  const out = new Uint8Array(8 + chunk('IHDR', ihdr).length + chunk('PLTE', plte).length + chunk('IDAT', idat).length + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const c of [chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat)]) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

test('indexed PNGs with matching PLTE convert to PIX8 frames; pixels survive', async () => {
  const dir = makeFixture();
  // Replace the fixture's garbage PNG with a REAL indexed 3x2 badge art whose
  // PLTE equals its .pal companion (the conversion gate).
  const palette = [[255, 255, 255], [0, 0, 0]];
  const indices = [0, 0, 1, 1, 0, 1];
  const png = buildIndexedPng(3, 2, indices, palette);
  writeFileSync(join(dir, 'hh_demo', '0002_bitmap_Logo.png'), png);

  const { spark, manifest } = buildSparkBundle(dir);
  const { index, body } = readSpark(spark);
  const bmp = manifest.casts[0].members.find((m) => m.kind === 'bitmap');
  const slice = (p) => {
    const [off, len] = index[p];
    return body.subarray(off, off + len);
  };
  const raw = slice(bmp.file);
  assert.ok(isPix8(raw), 'bitmap shipped as a PIX8 frame');

  // The palette the runtime attaches is the PALB companion: decode with it and
  // compare against the reference PNG decode.
  const palBytes = slice(bmp.palRel);
  const tripletCount = palBytes[4] | (palBytes[5] << 8);
  const triplets = [];
  for (let i = 0; i < tripletCount; i++) triplets.push([palBytes[6 + i * 3], palBytes[6 + i * 3 + 1], palBytes[6 + i * 3 + 2]]);
  const got = decodePix8(raw, triplets);
  const ref = decodePng(png);
  assert.deepEqual([...got.rgba], [...ref.rgba], 'PIX8 rgba identical to the PNG decode');
  assert.deepEqual([...got.indices], indices);

  // End-to-end through the engine: memberImage produces the same pixels.
  const loader = new BundleLoader();
  loader.register(spark);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_demo');
  const member = e.casts[0].members.get(2);
  const img = e.memberImage(member);
  assert.deepEqual([...img.data], [...ref.rgba], 'engine member image pixel-identical');
});

function buildTruecolorPng(width, height, rgba) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1);
  }
  const idat = zlibSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of [...new TextEncoder().encode(type), ...data]) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    out.set([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 8 + data.length);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const out = new Uint8Array(8 + chunk('IHDR', ihdr).length + chunk('IDAT', idat).length + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let o = 8;
  for (const c of [chunk('IHDR', ihdr), chunk('IDAT', idat)]) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

test('truecolor PNGs with a palette companion re-index to NATURAL palette slots', async () => {
  const dir = makeFixture();
  // A corner-style shadow: white on the matte key slot (0), black on the
  // shadow slot (255). Director convention — the runtime matte keys index 0
  // transparent, and palette-ref remaps go through indices. Re-indexing must
  // preserve those slots, or the shadow remaps/keyes to the wrong colors.
  const rgba = new Uint8Array([
    255, 255, 255, 255, 0, 0, 0, 255,
    0, 0, 0, 255, 255, 255, 255, 255,
  ]);
  const png = buildTruecolorPng(2, 2, rgba);
  writeFileSync(join(dir, 'hh_demo', '0005_bitmap_shadow.png'), png);
  let palText = 'JASC-PAL\n0100\n256\n';
  for (let i = 0; i < 256; i++) {
    const c = i === 0 ? [255, 255, 255] : i === 255 ? [0, 0, 0] : [i, 0, 255 - i];
    palText += `${c[0]} ${c[1]} ${c[2]}\n`;
  }
  writeFileSync(join(dir, 'hh_demo', '0005_bitmap_shadow.pal'), palText);

  const { spark, manifest } = buildSparkBundle(dir);
  const { index, body } = readSpark(spark);
  const bmp = manifest.casts[0].members.find((m) => m.name === 'shadow');
  const slice = (p) => {
    const [off, len] = index[p];
    return body.subarray(off, off + len);
  };
  const raw = slice(bmp.file);
  assert.ok(isPix8(raw), 'truecolor shadow converted to a PIX8 frame');

  const palBytes = slice(bmp.palRel);
  const tripletCount = palBytes[4] | (palBytes[5] << 8);
  assert.equal(tripletCount, 256, 'full 256-entry palette table, not first-seen order');
  const triplets = [];
  for (let i = 0; i < tripletCount; i++) triplets.push([palBytes[6 + i * 3], palBytes[6 + i * 3 + 1], palBytes[6 + i * 3 + 2]]);
  const got = decodePix8(raw, triplets);
  assert.deepEqual([...got.indices], [0, 255, 255, 0], 'white stays on matte key slot 0, black on slot 255');
  assert.deepEqual([...got.rgba], [...rgba], 'PIX8 rgba pixel-identical to the truecolor source');
});

test('.pal companions attach to bitmap members; palette members stay separate', () => {
  const dir = makeFixture();
  const { manifest } = buildBundle(dir);
  const cast = manifest.casts[0];

  // The bitmap's own .pal is a companion (palRel), NOT a second bitmap member
  // with the same number — the old scan would have created a duplicate.
  const logos = cast.members.filter((m) => m.number === 2);
  assert.equal(logos.length, 1, 'one member 2 (the .pal is a companion, not a member)');
  assert.equal(logos[0].kind, 'bitmap');
  assert.match(logos[0].palRel, /^pals\/pal_\d+_[0-9a-f]+\.pal$/, 'companion rewired to a content-addressed shared palette entry');

  // The palettes/ dir .pal (palette token) is a real palette member.
  const paletteMember = cast.members.find((m) => m.kind === 'palette');
  assert.ok(paletteMember, 'palette member emitted');
  assert.equal(paletteMember.number, 4);
  assert.equal(paletteMember.file, 'hh_demo/0004_palette_citybg.pal');
  assert.equal(paletteMember.palRel, undefined, 'a palette member has no companion');

  // The palette MEMBER still ships under its own path; the bitmap companion
  // ships once as a shared entry.
  const { zip } = buildBundle(dir);
  const unzipped = unzipSync(zip);
  assert.ok(unzipped[logos[0].palRel], 'companion shipped as the shared entry');
  assert.ok(unzipped['hh_demo/0004_palette_citybg.pal'], 'palette member ships under its own path');
});

test('shared palette names are content-addressed: no cross-bundle bleed in one loader', async () => {
  // Regression: palettes ship as pals/pal_<len>_<hash>.pal, unique per content.
  // A BundleLoader resolves a path against EVERY registered bundle (the live
  // movie registers dozens); a flat shared name would hand members the first
  // bundle's palette — the greyscale-drape bug. Two sparks with DIFFERENT
  // palettes must keep their own colors when registered together.
  const mk = (name, color) => {
    const dir = mkdtempSync(join(tmpdir(), 'habbo-collide-'));
    const cast = join(dir, name);
    mkdirSync(cast, { recursive: true });
    const palette = [[255, 255, 255], color];
    writeFileSync(join(cast, '0001_bitmap_dot.png'), buildIndexedPng(1, 1, [1], palette));
    writeFileSync(join(cast, '0001_bitmap_dot.pal'), `JASC-PAL\n0100\n2\n255 255 255\n${color[0]} ${color[1]} ${color[2]}\n`);
    const { spark } = buildSparkBundle(dir);
    return spark;
  };
  const sparkA = mk('hh_cast_a', [255, 0, 0]);
  const sparkB = mk('hh_cast_b', [0, 0, 255]);
  const loader = new BundleLoader();
  loader.register(sparkA);
  loader.register(sparkB);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_cast_a');
  await e.loadCast(loader, 'hh_cast_b');
  const a = e.casts.find((c) => c.name === 'hh_cast_a').members.get(1);
  const b = e.casts.find((c) => c.name === 'hh_cast_b').members.get(1);
  assert.deepEqual(a.palette[1], [255, 0, 0], 'cast A keeps its own palette (red)');
  assert.deepEqual(b.palette[1], [0, 0, 255], 'cast B keeps its own palette (blue)');
  // Under the old flat dedup_N names both members shared one path and the
  // loader returned the first bundle's palette for both.
  assert.notEqual(a.palette, b.palette, 'no shared table object across bundles');
});

test('container directories expand into sub-cast bundles under the group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bundle-'));

  // A normal top-level cast.
  const cast = join(dir, 'hh_demo');
  mkdirSync(cast, { recursive: true });
  writeFileSync(join(cast, '0001_script_Loop.ls'), '-- Cast member: Loop\n-- Type: Score\non exitFrame me\nend\n');

  // A container (like hof_furni) with two nested casts inside.
  const group = join(dir, 'hof_demo');
  mkdirSync(join(group, 'furni_a'), { recursive: true });
  writeFileSync(join(group, 'furni_a', '0001_script_Loop.ls'), '-- Cast member: Loop\n-- Type: Score\non exitFrame me\nend\n');
  writeFileSync(join(group, 'furni_a', 'movie.txt'), 'tempo\t24\n');
  mkdirSync(join(group, 'furni_b'), { recursive: true });
  writeFileSync(join(group, 'furni_b', '0002_bitmap_Logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

  // Every nested cast is its own manifest cast, named after the cast dir.
  const { manifest } = buildBundle(dir);
  assert.deepEqual(
    manifest.casts.map((c) => c.name).sort(),
    ['furni_a', 'furni_b', 'hh_demo'],
  );
  const a = manifest.casts.find((c) => c.name === 'furni_a');
  assert.ok(a);
  assert.equal(a.members.length, 1);
  assert.equal(a.members[0].file, 'hof_demo/furni_a/0001_script_Loop.ls');
  const b = manifest.casts.find((c) => c.name === 'furni_b');
  assert.ok(b);
  assert.equal(b.members[0].file, 'hof_demo/furni_b/0002_bitmap_Logo.png');

  // The container is NOT bundled as one lumped cast.
  assert.ok(!manifest.casts.some((c) => c.name === 'hof_demo'));

  // Zip paths carry the group prefix so nested casts never collide with
  // same-named top-level casts.
  const { zip } = buildBundle(dir);
  const unzipped = unzipSync(zip);
  assert.ok(unzipped['hof_demo/furni_a/0001_script_Loop.ls']);
  assert.ok(unzipped['hof_demo/furni_b/0002_bitmap_Logo.png']);

  // A filter may select a single nested cast by group/name.
  const filtered = buildBundle(dir, ['hof_demo/furni_b']);
  assert.equal(filtered.manifest.casts.length, 1);
  assert.equal(filtered.manifest.casts[0].name, 'furni_b');

  // A filter naming the container selects every nested cast.
  const byGroup = buildBundle(dir, ['hof_demo']);
  assert.deepEqual(
    byGroup.manifest.casts.map((c) => c.name).sort(),
    ['furni_a', 'furni_b'],
  );
});

test('a member-named dir holding casts is a grouping, not a cast member', () => {
  const dir = mkdtempSync(join(tmpdir(), 'habbo-bundle-'));

  // A container (like the v31 hof_furni) whose top level has a `sounds`
  // subdirectory that itself CONTAINS casts (the v31 sound-set grouping).
  // `sounds` is a CAST_MEMBER_DIRS name, so the classifier must not treat
  // the whole container as one lumped cast because of it.
  const group = join(dir, 'hof_demo');
  mkdirSync(join(group, 'furni_a'), { recursive: true });
  writeFileSync(join(group, 'furni_a', '0001_script_Loop.ls'), '-- Cast member: Loop\n-- Type: Score\non exitFrame me\nend\n');
  mkdirSync(join(group, 'sounds', 'sound_set_1'), { recursive: true });
  writeFileSync(join(group, 'sounds', 'sound_set_1', '0002_bitmap_sound_set_1_small.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

  const { manifest } = buildBundle(dir);
  // Each nested cast is its own manifest cast; the container and the `sounds`
  // grouping are never lumped.
  assert.deepEqual(
    manifest.casts.map((c) => c.name).sort(),
    ['furni_a', 'sound_set_1'],
  );
  assert.equal(manifest.casts.find((c) => c.name === 'sound_set_1').members[0].file, 'hof_demo/sounds/sound_set_1/0002_bitmap_sound_set_1_small.png');

  // A filter naming the container still selects every nested cast, including
  // those under the member-named grouping.
  const byGroup = buildBundle(dir, ['hof_demo']);
  assert.deepEqual(
    byGroup.manifest.casts.map((c) => c.name).sort(),
    ['furni_a', 'sound_set_1'],
  );
});

test('member names keep real underscores (non-script) and spaces (scripts)', () => {
  const dir = makeFixture();
  // Bitmap whose real cast name is "cloud_0_left" (Entry Cloud Class splits
  // pSprite.member.name on "_" to rebuild the art names — spaces would break
  // the round trip and produce a 0-width cloud image).
  writeFileSync(join(dir, 'hh_demo', '0004_bitmap_cloud_0_left.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  // Script referenced as script("Object Base Class") in the corpus.
  writeFileSync(join(dir, 'hh_demo', '0005_script_Object_Base_Class.ls'), '-- Cast member: Object Base Class\n-- Type: Parent\non construct me\nend\n');
  const { manifest } = buildBundle(dir);
  const cast = manifest.casts[0];
  const cloud = cast.members.find((m) => m.number === 4);
  assert.equal(cloud?.name, 'cloud_0_left');
  assert.equal(cloud?.kind, 'bitmap');
  const base = cast.members.find((m) => m.number === 5);
  assert.equal(base?.name, 'Object Base Class');
  assert.equal(base?.kind, 'script');
});
