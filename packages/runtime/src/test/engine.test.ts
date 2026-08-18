import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync } from 'node:zlib';
import { DirectorEngine, cssFontFor } from '../engine/engine.js';
import { BundleLoader, createBundleFromZipBytes, type BundleSource } from '../bundle/loader.js';
import { strToU8, zipSync } from 'fflate';
import { LColor, LImage, LList, LMemberRef, LObject, LPoint, LPropList, LRect, LSymbol, VOID, duplicateValue, fontStyleFlags, PropPairs, type LVal } from '../lingo/values.js';
import { normalizeTextLines, parseShapeText, parsePaletteBytes, Member, CastLib } from '../engine/members.js';
import type { PersistWorkerLike, PersistWorkerMsg } from '../worker/persist.js';
import { decodePng } from '../engine/png.js';
import { decodeGif } from '../engine/gif.js';
import { bakeEdgeBackground, cornersAreNearWhite, tintSpriteBackground } from '../stage/matte.js';
import { directorTransformFlip, inverseDirectorTransformPoint } from '../stage/pixi.js';
import { defringeTextPixels, hardenTextAlpha, rasterizeTextMember } from '../stage/text.js';

/** Build a one-cast bundle zip in memory (mirrors the bundler's output). */
function makeCastZip(name: string, linkedCasts: { name: string; file: string }[], files: Record<string, string>): Uint8Array {
  const members = Object.entries(files).map(([f, content]) => {
    const m = /^(\d{3,4})_script_(.+)\.ls$/.exec(f);
    if (!m) throw new Error(`test fixture must be NNNN_script_Name.ls: ${f}`);
    void content;
    return { number: parseInt(m[1], 10), kind: 'script' as const, name: m[2], file: `${name}/${f}` };
  });
  const manifest = {
    version: 1 as const,
    casts: [{
      name,
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts,
    }],
    files: Object.keys(files).map((f) => `${name}/${f}`),
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const [f, content] of Object.entries(files)) entries[`${name}/${f}`] = strToU8(content);
  return zipSync(entries, { level: 6 });
}

/** Build a spark (single-stream) bundle — mirrors the bundler's buildSpark. */
function makeSparkBundle(name: string, linkedCasts: { name: string; file: string }[], files: Record<string, string>): Uint8Array {
  const members = Object.entries(files).map(([f, content]) => {
    const m = /^(\d{3,4})_script_(.+)\.ls$/.exec(f);
    if (!m) throw new Error(`test fixture must be NNNN_script_Name.ls: ${f}`);
    void content;
    return { number: parseInt(m[1], 10), kind: 'script' as const, name: m[2], file: `${name}/${f}` };
  });
  const manifest = {
    version: 1 as const,
    casts: [{
      name,
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts,
    }],
    files: Object.keys(files).map((f) => `${name}/${f}`),
  };
  const all: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const [f, content] of Object.entries(files)) all[`${name}/${f}`] = strToU8(content);
  const paths = Object.keys(all);
  const index: Record<string, [number, number]> = {};
  const body = new Uint8Array(paths.reduce((n, p) => n + all[p].length, 0));
  let off = 0;
  for (const p of paths) {
    index[p] = [off, all[p].length];
    body.set(all[p], off);
    off += all[p].length;
  }
  const head = strToU8(JSON.stringify(index) + '\n');
  const payload = new Uint8Array(head.length + body.length);
  payload.set(head, 0);
  payload.set(body, head.length);
  const deflated = deflateRawSync(payload, { level: 9 }); // raw deflate — fflate inflateSync reads the spark container
  const out = new Uint8Array(4 + deflated.length);
  out.set(strToU8('SPK1'), 0);
  out.set(deflated, 4);
  return out;
}

/** Build a cast zip with an explicit movie config (mirrors the bundler's
 *  per-cast movie.txt emission — linked casts ship an all-zero white
 *  placeholder, the movie itself the real stage). */
function makeCastZipWithMovie(
  name: string,
  linkedCasts: { name: string; file: string }[],
  files: Record<string, string>,
  movie: Record<string, unknown>,
): Uint8Array {
  const members = Object.entries(files).map(([f, content]) => {
    const m = /^(\d{3,4})_script_(.+)\.ls$/.exec(f);
    if (!m) throw new Error(`test fixture must be NNNN_script_Name.ls: ${f}`);
    void content;
    return { number: parseInt(m[1], 10), kind: 'script' as const, name: m[2], file: `${name}/${f}` };
  });
  const manifest = {
    version: 1 as const,
    casts: [{
      name,
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts,
      movie,
      castList: [
        { id: 66560, name: 'Internal', path: '', minMember: 1, maxMember: 1, memberCount: 1 },
      ],
    }],
    files: Object.keys(files).map((f) => `${name}/${f}`),
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const [f, content] of Object.entries(files)) entries[`${name}/${f}`] = strToU8(content);
  return zipSync(entries, { level: 6 });
}

/** Build a cast zip whose manifest carries movie.txt + casts.txt (mirrors bundler). */
function makeMovieCastZip(name: string, linkedCasts: { name: string; file: string }[], files: Record<string, string>): Uint8Array {
  const members = Object.entries(files).map(([f, content]) => {
    const m = /^(\d{3,4})_script_(.+)\.ls$/.exec(f);
    if (!m) throw new Error(`test fixture must be NNNN_script_Name.ls: ${f}`);
    void content;
    return { number: parseInt(m[1], 10), kind: 'script' as const, name: m[2], file: `${name}/${f}` };
  });
  const manifest = {
    version: 1 as const,
    casts: [{
      name,
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts,
      movie: {
        stageWidth: 720, stageHeight: 540, stageLeft: 89, stageTop: 50, stageRight: 809, stageBottom: 590,
        backgroundColor: 0x000020, stageColor: 0x000100, stageColorRgb: 0x000000, tempo: 24, channels: 1006,
        minMember: 1, maxMember: 4, defaultPalette: '-1:-101', directorVersion: 1858, movieVersion: 1858, platform: 2,
      },
      castList: [
        { id: 66560, name: 'Internal', path: '', minMember: 1, maxMember: 4, memberCount: 4 },
        { id: 1024, name: 'fuse_client', path: 'D:\\LINGO\\Builds\\fuse_client.cst', minMember: 1, maxMember: 82, memberCount: 82 },
        { id: 132096, name: 'bin', path: '', minMember: 1, maxMember: 0, memberCount: 0 },
        { id: 1024, name: 'empty 1', path: 'D:\\LINGO\\Builds\\empty.cst', minMember: 1, maxMember: 0, memberCount: 0 },
        { id: 1024, name: 'empty 2', path: 'D:\\LINGO\\Builds\\empty.cst', minMember: 1, maxMember: 0, memberCount: 0 },
      ],
    }],
    files: Object.keys(files).map((f) => `${name}/${f}`),
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const [f, content] of Object.entries(files)) entries[`${name}/${f}`] = strToU8(content);
  return zipSync(entries, { level: 6 });
}

test('movie.txt configures stage + casts.txt registers the full castLib registry', async () => {
  const habbo = makeMovieCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const fuse = makeCastZip('fuse_client', [], {
    '0001_script_Client.ls': '-- Cast member: Client\n-- Type: Movie Script\non startClient\n  return 1\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');

  // movie.txt applied.
  assert.equal(e.stageWidth, 720);
  assert.equal(e.stageHeight, 540);
  assert.equal(e.stageLeft, 89);
  assert.equal(e.stageRight, 809);
  // stage_color_rgb (0x000000 black) is the resolved RGB Shockwave renders.
  assert.equal(e.stageBackground, 0x000000);
  assert.equal(e.frameTempo, 24);
  assert.equal(e.getThe('stageleft', []), 89);
  assert.equal(e.getThe('stagebottom', []), 590);
  // Score chunk channel count backs `the lastChannel` (Sprite Manager pool
  // size — preIndexChannels does `repeat with i = 1 to the lastChannel`).
  // movie.txt `channels` overrides the v14 default of 1006.
  assert.equal(e.getThe('lastchannel', []), 1006);

  // casts.txt registered all 4 castLibs in Director order; loaded bundles
  // filled their shells (movie's own cast = Internal, fuse_client = 2).
  assert.equal(e.casts.length, 5); // Internal, fuse_client, bin, empty 1, empty 2
  assert.equal(e.getThe('number', [{ op: 'of', name: 'castLibs' }]), 5);
  assert.equal(e.getCastLib(1)?.name, 'Internal');
  assert.equal(e.getCastLib(2)?.name, 'fuse_client');
  assert.equal(e.getCastLib(3)?.name, 'bin');
  assert.equal(e.getCastLib(4)?.name, 'empty 1');
  assert.equal(e.getCastLib('bin')?.number, 3);
  // The Internal shell carries the movie's members; fuse_client shell its own.
  assert.equal(e.casts[0].members.size, 1);
  assert.equal(e.casts[1].members.size, 1);
  assert.equal(e.casts[2].members.size, 0, 'bin stays empty until dynamic members are created');
});

test('script(member(...)) resolves a script-type member — initializeAndRun vercode gate', async () => {
  // `new script(member(5, 1))` is the first line of fuse_client's
  // initializeAndRun: member 5 of castlib 1 (the movie's Internal cast) is a
  // Parent script. The corpus addresses script members by NUMBER REF, not
  // name, so script() must resolve an LMemberRef to its member's script.
  const habbo = makeMovieCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
    '0005_script_vercode.ls':
      '-- Cast member: vercode\n-- Type: Parent\non getV me, tSec\n' +
      '  if tSec <> "lkjsdlfjg23r098rsadfjj3490f3qf90jfasjdfoasidjoijjj" then\n' +
      '    return "sdkjglk3j0940q9jgasdfghjghj0945kg09erkg093k04g"\n' +
      '  end if\n' +
      '  return "dfsjbniou3n403q9fksadkjfash439h8f98hsadf98h938hfaskjhf34"\n' +
      'end\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');

  const inst = e.interp.evalExpressionString('new script(member(5, 1))');
  assert.ok(inst instanceof LObject, 'script(member(5,1)) must instantiate vercode, not VOID');
  assert.equal(inst.scriptName, 'vercode');
  const script = inst.script!;
  const getV = script.handlers.find((h) => h.name.toLowerCase() === 'getv');
  assert.ok(getV, 'vercode has getV');
  // callHandler binds `me` from the instance; args fill tSec.
  assert.equal(
    e.interp.callHandler(script, getV!, ['lkjsdlfjg23r098rsadfjj3490f3qf90jfasjdfoasidjoijjj'], inst, new Set()),
    'dfsjbniou3n403q9fksadkjfash439h8f98hsadf98h938hfaskjhf34',
  );
  // Wrong challenge returns the decoy string, not the expected one.
  assert.equal(e.interp.callHandler(script, getV!, ['nope'], inst, new Set()), 'sdkjglk3j0940q9jgasdfghjghj0945kg09erkg093k04g');
});

test('linked cast placeholder movie config does not clobber the movie stage color', async () => {
  // Every re-exported linked cast ships a placeholder movie.txt (all-zero
  // stage rect, stage_color_rgb 0xFFFFFF white) alongside its casts.txt.
  // Loading fuse_client mid-boot must NOT turn the movie's black stage
  // white — only the FIRST (boot) movie's config applies.
  const habbo = makeMovieCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const placeholderMovie = {
    stageWidth: 0, stageHeight: 0, stageLeft: 0, stageTop: 0, stageRight: 0, stageBottom: 0,
    backgroundColor: 0x000000, stageColor: 0x000000, stageColorRgb: 0xffffff, tempo: 0,
    minMember: 1, maxMember: 0, directorVersion: 1858,
  };
  const fuse = makeCastZipWithMovie('fuse_client', [], {
    '0001_script_Client.ls': '-- Cast member: Client\n-- Type: Movie Script\non startClient\n  return 1\nend\n',
  }, placeholderMovie);
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  // Boot movie applied its real stage (720x540 black).
  assert.equal(e.stageBackground, 0x000000);
  assert.equal(e.stageWidth, 720);
  // Linked cast with a placeholder config loads via the movie's linkedCasts;
  // its white stage color + zero rect must be ignored.
  await e.loadCast(loader, 'fuse_client');
  assert.equal(e.stageBackground, 0x000000, 'linked cast placeholder must not turn the stage white');
  assert.equal(e.stageWidth, 720, 'linked cast placeholder must not clobber stage size');
});

test('linked cast with an all-zero stage rect does not clobber the movie stage geometry', async () => {
  // fuse_client's movie.txt ships an all-zero stage rect (linked cast files
  // carry no real stage geometry). applyMovieConfig must not overwrite the
  // boot movie's rect with those zeros — FUSE's window `center()` computes
  // `(the stageRight - the stageLeft) / 2` and a 0/0/0/0 rect moves the
  // Loading Bar window to negative coordinates (top-left / off-screen).
  const habbo = makeMovieCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const fuse = makeCastZip('fuse_client', [], {
    '0002_script_Init.ls': '-- Cast member: Init\n-- Type: Score\non exitFrame me\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  // Boot movie applied its real rect (89/50/809/590).
  assert.equal(e.stageLeft, 89);
  assert.equal(e.stageTop, 50);
  assert.equal(e.stageRight, 809);
  assert.equal(e.stageBottom, 590);
  // Linked cast loads; its all-zero rect must be ignored.
  await e.loadCast(loader, 'fuse_client');
  assert.equal(e.stageLeft, 89, 'linked cast zero rect must not clobber stageLeft');
  assert.equal(e.stageTop, 50, 'linked cast zero rect must not clobber stageTop');
  assert.equal(e.stageRight, 809, 'linked cast zero rect must not clobber stageRight');
  assert.equal(e.stageBottom, 590, 'linked cast zero rect must not clobber stageBottom');
  // The FUSE center() inputs stay sane: centered within the 720x540 stage.
  const pwidth = 128;
  const right = Number(e.getThe('stageright', []));
  const left = Number(e.getThe('stageleft', []));
  assert.equal(right, 809);
  assert.equal(left, 89);
  const tX = (right - left) / 2 - pwidth / 2;
  assert.equal(tX, (809 - 89) / 2 - 64);
});

test('loadCast auto-loads linked casts in order (Director cast links)', async () => {
  const habbo = makeCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const fuse = makeCastZip('fuse_client', [], {
    '0002_script_Init.ls': '-- Cast member: Init\n-- Type: Score\non exitFrame me\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  const cast = await e.loadCast(loader, 'habbo');
  assert.ok(cast);
  assert.equal(e.casts.length, 2, 'linked cast must be loaded as castLib 2');
  assert.equal(e.casts[0].name, 'habbo');
  assert.equal(e.casts[1].name, 'fuse_client');
  assert.equal(cast.fileName, 'habbo.cst');
  // castLib(2) resolves to fuse_client (used by prepareMovie's castLib(2).preloadMode)
  const cl2 = e.getCastLib(2);
  assert.ok(cl2);
  assert.equal(cl2.name, 'fuse_client');
});

test('parsePaletteBytes decodes PALB binary and JASC text (bundler binary palettes)', () => {
  // binary form: 'PALB' + u16LE count + count*3 RGB
  const bin = new Uint8Array([0x50, 0x41, 0x4c, 0x42, 0x02, 0x00, 255, 255, 255, 0, 0, 0]);
  assert.deepEqual(parsePaletteBytes(bin), [[255, 255, 255], [0, 0, 0]], 'PALB decodes to the same triplets as the text');
  assert.deepEqual(
    parsePaletteBytes(new Uint8Array(strToU8('JASC-PAL\n0100\n256\n255 255 255\n0 0 0\n'))),
    [[255, 255, 255], [0, 0, 0]],
    'legacy JASC text still parses',
  );
  assert.deepEqual(parsePaletteBytes(new Uint8Array([])), [], 'empty payload -> empty palette');
  // truncated binary payload stops at the byte boundary without throwing
  assert.deepEqual(parsePaletteBytes(bin.subarray(0, 9)), [[255, 255, 255]], 'truncated PALB yields the complete triplets only');
  assert.deepEqual(parsePaletteBytes(bin.subarray(0, 8)), [], 'incomplete triplet is dropped');
});

test('engine palette reads accept PALB binary palettes from the bundle', async () => {
  const manifest = {
    version: 1 as const,
    casts: [{
      name: 'hh_palb',
      members: [
        { number: 1, kind: 'bitmap' as const, name: 'Logo', file: 'hh_palb/0001_bitmap_Logo.png', palRel: 'hh_palb/0001_bitmap_Logo.pal' },
        { number: 2, kind: 'palette' as const, name: 'citybg', file: 'hh_palb/0002_palette_citybg.pal' },
      ],
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts: [] as { name: string; file: string }[],
    }],
    files: ['hh_palb/0001_bitmap_Logo.png', 'hh_palb/0001_bitmap_Logo.pal', 'hh_palb/0002_palette_citybg.pal'],
  };
  const entries: Record<string, Uint8Array> = {
    'bundle-manifest.json': strToU8(JSON.stringify(manifest)),
    'hh_palb/0001_bitmap_Logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    // PALB: 2 triplets (white, black) — as the bundler's encodePalette emits.
    'hh_palb/0001_bitmap_Logo.pal': new Uint8Array([0x50, 0x41, 0x4c, 0x42, 0x02, 0x00, 255, 255, 255, 0, 0, 0]),
    // palette member: 1 triplet (grey) — the movie-level currentPalette source.
    'hh_palb/0002_palette_citybg.pal': new Uint8Array([0x50, 0x41, 0x4c, 0x42, 0x01, 0x00, 128, 128, 128]),
  };
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'hh_palb' ? zipSync(entries, { level: 6 }) : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_palb');
  const cast = e.casts.find((c) => c.name === 'hh_palb');
  assert.ok(cast);
  const bm = cast.members.get(1);
  assert.ok(bm);
  assert.deepEqual(bm.palette, [[255, 255, 255], [0, 0, 0]], 'bitmap palRel parsed from PALB bytes');
  const pal = cast.members.get(2);
  assert.ok(pal);
  assert.deepEqual(pal.palette, [[128, 128, 128]], 'palette member parsed from PALB bytes');
  assert.deepEqual(e.currentPalette, [[128, 128, 128]], 'palette member drives currentPalette');
});

test('loadCast reads single-stream spark bundles (bundler buildSpark format)', async () => {
  const habbo = makeSparkBundle('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
    '0002_script_Init.ls': '-- Cast member: Init\n-- Type: Score\non exitFrame me\n  if netDone() then startClient() else go(the frame)\nend\n',
  });
  const fuse = makeSparkBundle('fuse_client', [], {
    '0001_script_Client.ls': '-- Cast member: Client\n-- Type: Movie Script\non startClient\n  return 1\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  const cast = await e.loadCast(loader, 'habbo');
  assert.ok(cast, 'spark bundle parses, manifest resolves');
  assert.equal(cast.name, 'habbo');
  assert.equal(e.casts.length, 2, 'linked cast auto-loaded from its spark bundle');
  assert.equal(e.casts[1].name, 'fuse_client');
  // member payloads read out of the sliced spark body
  const loop = e.resolveScript('Loop');
  assert.ok(loop, 'script member registered from spark bundle');
  assert.ok(e.resolveScript('Client'), 'linked cast script registered');
  e.boot();
  for (let i = 0; i < 40; i++) e.tick();
  assert.equal(e.frameCount, 40, 'score frame loop runs on spark-sourced casts');
  // zip bundles still load through the same loader (legacy format kept)
  const zipCast = makeCastZip('hh_zip_legacy', [], {
    '0001_script_Old.ls': '-- Cast member: Old\n-- Type: Score\non exitFrame me\nend\n',
  });
  const source2: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'hh_zip_legacy' ? zipCast : null;
    },
  };
  const loader2 = new BundleLoader(source2);
  const e2 = new DirectorEngine();
  const legacy = await e2.loadCast(loader2, 'hh_zip_legacy');
  assert.ok(legacy, 'legacy zip bundle still loads');
  assert.ok(e2.resolveScript('Old'));
});

test('prepareMovie runs at boot, then startClient fires after netDone completes', async () => {
  const habbo = makeCastZip('habbo', [{ name: 'fuse_client', file: 'fuse_client.cst' }], {
    '0001_script_Movie.ls': '-- Cast member: Movie\n-- Type: Movie Script\non prepareMovie\n  preloadNetThing(castLib(2).fileName)\nend\n',
    '0002_script_Init.ls': '-- Cast member: Init\n-- Type: Score\non exitFrame me\n  if netDone() then\n    startClient()\n  else\n    go(the frame)\n  end if\nend\n',
  });
  const fuse = makeCastZip('fuse_client', [], {
    '0001_script_Client.ls': '-- Cast member: Client\n-- Type: Movie Script\nproperty pStarted\non startClient\n  pStarted = 1\n  return 1\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'fuse_client' ? fuse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  e.boot();
  // prepareMovie ran: the linked fuse_client cast is already local, so the
  // preload has nothing to download — it completes immediately. (The
  // artificial ramp is only for REAL downloads; ramping an already-registered
  // cast was the boot net_done stall — 24 frames at 15fps of fake download.)
  assert.equal(e.netDone(undefined), 1, 'already-registered preload completes immediately');
  // Loop: keep ticking; Init's `if netDone() then startClient()` fires.
  for (let i = 0; i < 40; i++) e.tick();
  assert.equal(e.netDone(undefined), 1, 'preload completed');
  // startClient is a global handler from fuse_client; find proof it ran.
  const g = e.globalGet('gStarted');
  void g;
  assert.ok(e.globals.has('pstarted') === false || e.logs.join('\n').length > 0);
  const ran = e.globalHandlers.has('startclient');
  assert.ok(ran, 'startClient registered from linked cast');
});

test('getmemnum resolves member names to global member numbers', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Loop', 'score', 'on exitFrame me\ngo(the frame)\nend\n');
  e.addScriptMember('Init', 'score', 'on exitFrame me\n  if netDone() then startClient() else go(the frame)\nend\n');
  assert.equal(e.getmemnum('Loop'), 65537); // cast 1 << 16 | 1 (Director slot number)
  assert.equal(e.getmemnum('Init'), 65538); // cast 1 << 16 | 2
  assert.equal(e.getmemnum('missing_member'), 0);
});

test('member numbers are Director slot numbers — no castLib*1000 collisions (hh_people_1 1002 vs hh_patch_uk 2)', async () => {
  // hh_people_1 carries 1700 members, so its local 1002 (h_ohd_hr_019_1_0)
  // under the old castLib*1000+local scheme produced global 2002 — the SAME
  // global as hh_patch_uk member 2 (mes_3_up). member(2002) then resolved to
  // whichever cast registered last, which is how the messenger buttons
  // dup'd hh_people_1 hair. Director 6+ slot numbers ((castLib<<16)|member)
  // never collide across casts.
  const people = makeCastZip('hh_people_1', [], {
    '1002_script_hair_1002.ls': '-- Cast member: hair_1002\n-- Type: Score\non exitFrame\nend\n',
  });
  const patch = makeCastZip('hh_patch_uk', [], {
    '0002_script_mes_3_up.ls': '-- Cast member: mes_3_up\n-- Type: Score\non exitFrame\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'hh_people_1' ? people : name === 'hh_patch_uk' ? patch : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_people_1');
  await e.loadCast(loader, 'hh_patch_uk');

  const hairNum = e.getmemnum('hair_1002');
  const mesNum = e.getmemnum('mes_3_up');
  assert.notEqual(hairNum, mesNum, 'globals must not collide across casts');
  assert.equal(e.getMember(hairNum)?.name, 'hair_1002');
  assert.equal(e.getMember(mesNum)?.name, 'mes_3_up');
  // Corpus invariant: member(getmemnum(name)).number == getmemnum(name),
  // and it resolves to the RIGHT cast (the whole point of slot numbers).
  assert.equal(e.getMemberProp(e.getMember(hairNum)!, 'number'), hairNum);
  assert.equal(e.getMemberProp(e.getMember(mesNum)!, 'number'), mesNum);
  assert.equal(e.getMemberProp(e.getMember(mesNum)!, 'castlibnum'), 2);
});

test('call() maps over object lists (Habbo convention)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Counter',
    'parent',
    [
      'on construct me',
      '  me.pN = 0',
      'end',
      'on bump me, x',
      '  me.pN = me.pN + x',
      '  return me.pN',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Counter')!;
  const a = e.interp.newInstance(script, []);
  const b = e.interp.newInstance(script, []);
  const out = e.interp.callBuiltin([new LSymbol('bump'), new LList([a, b]), 4]);
  assert.equal(a.props.get('pN'), 4);
  assert.equal(b.props.get('pN'), 4);
  assert.equal(out, 4);
  // second round proves instance state persists
  e.interp.callBuiltin([new LSymbol('bump'), new LList([a, b]), 1]);
  assert.equal(a.props.get('pN'), 5);
});

test('value() evaluates Lingo data literals', () => {
  const e = new DirectorEngine();
  const v = e.interp.evalExpressionString('["a": [#z: [1, 2]]]');
  assert.ok(v instanceof LPropList);
  const z = (v as LPropList).props.get('a');
  assert.ok(z instanceof LPropList);
  const arr = (z as LPropList).props.get('z');
  assert.deepEqual((arr as LList).items, [1, 2]);
});

test('string * int follows Director coercion (empty string -> 123456789, not 0)', () => {
  // DirPlayer multiply_datums (String, Int) parity: an EMPTY or non-numeric
  // string times a non-zero int gives Director's arbitrary 123456789 — NOT 0.
  // The corpus's Catalogue Handler gates deal detection with
  // `tdata.item.count >= 11 + tItemCount * 3`, where tItemCount is "" for a
  // plain item. With ""→0 the gate passed, an empty dealList was attached to
  // every product, and showPreviewImage rendered the Deal Preview ("bundle")
  // for ALL items instead of the furniture preview.
  const e = new DirectorEngine();
  // The deal gate: a plain 11-field item line (10 fields + trailing tab) must
  // NOT be treated as a deal.
  assert.equal(e.interp.evalExpressionString('11 >= 11 + "" * 3'), 0);
  // Empty string * non-zero int is the sentinel, not 0.
  assert.equal(e.interp.evalExpressionString('"" * 3'), 123456789);
  // Times zero still gives 0.
  assert.equal(e.interp.evalExpressionString('"" * 0'), 0);
  // Numeric strings still multiply normally.
  assert.equal(e.interp.evalExpressionString('"2" * 3'), 6);
  assert.equal(e.interp.evalExpressionString('3 * "4"'), 12);
  // Non-numeric strings behave like the empty case for the (String, Int) arm.
  assert.equal(e.interp.evalExpressionString('"abc" * 3'), 123456789);
});

test('layout margin keys resolve despite dropmenu casing (dropmenu #marginh vs script #marginH)', () => {
  // dropmenu1.element writes #marginh: 8 / #marginv: -2 (all lowercase)
  // while the corpus DropDown Class reads tFontDesc[#marginH] /
  // tFontDesc[#marginV] (capital H/V). Lingo symbols are case-insensitive,
  // so those reads must hit the layout keys — a case-sensitive miss returned
  // VOID and the dropdown text lost its left margin (pMarginLeft = 0). The
  // fallback is scoped to EXACTLY the margin keys (the only keys the corpus
  // mixes casing on); every other proplist lookup — the room-loading flow's
  // #passive/#users/#items/#heightmap/#type/#name/#casts/... — stays a
  // byte-identical case-sensitive read.
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('value("[#marginh: 8, #marginv: -2]")[#marginH]'), 8);
  assert.equal(e.interp.evalExpressionString('value("[#marginh: 8, #marginv: -2]")[#marginV]'), -2);
  // The real corpus read for the bottom margin is all-lowercase
  // `tFontDesc[#marginbottom]` — an exact match, no fallback involved.
  assert.equal(e.interp.evalExpressionString('value("[#marginh: 8, #marginbottom: 2]")[#marginbottom]'), 2);
  // Dot access (getPropValue) lowercases first, so .marginH hits #marginh.
  assert.equal(e.interp.evalExpressionString('value("[#marginh: 8]").marginH'), 8);
  // All-lowercase lookups are untouched: no fallback, stays VOID (the room
  // loading flow's reads are all lowercase and must keep exact-key semantics).
  assert.equal(e.interp.evalExpressionString('value("[#marginH: 11]")[#marginh]'), VOID);
});

test('string chunks: char ranges, items, line counts', () => {
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('"hello".char[2..4]'), 'ell');
  assert.equal(e.interp.evalExpressionString('"a,b,c".item[2]'), 'b');
  assert.equal(e.interp.evalExpressionString('"line1\nline2".line.count'), 2);
});

test('delete char <= -30000 deletes the LAST chunk (compiler sentinel — navigator breadcrumbs)', () => {
  // DirPlayer vm_range_to_host: the Director compiler encodes "the last
  // element" as chunk index -30000 (`delete the last char of t`), and the
  // corpus ships `delete char -30003 of tText` in the navigator's
  // createNaviHistory/renderRoomList to strip the trailing RETURN the build
  // loops leave behind. A no-op left the phantom line: the breadcrumb tabs
  // rendered N+1 rows (extra empty tab) and renderHistory's line-count
  // offset shifted the room list.
  const e = new DirectorEngine();
  e.addScriptMember(
    'ChunkProbe',
    'movie',
    [
      'on trimLast tStr',
      '  delete char -30003 of tStr',
      '  return tStr',
      'end',
      'on trimLastLine tStr',
      '  delete char -30000 of tStr',
      '  return tStr',
      'end',
    ].join('\n'),
  );
  const call = (name: string, arg: string) => {
    const h = e.globalHandlers.get(name.toLowerCase())!;
    return e.interp.callHandler(h.script, h.handler, [arg], null, new Set());
  };
  // The navigator's tText is RETURN-joined with a trailing RETURN.
  assert.equal(call('trimLast', 'hotelview\rPublic\rGames\r'), 'hotelview\rPublic\rGames');
  // Sentinel read: `char -30000 of t` = last char (DirPlayer parity).
  assert.equal(e.interp.evalExpressionString('"abc".char[-30000]'), 'c');
  // Ordinary negative indexes still count from the end.
  assert.equal(e.interp.evalExpressionString('"abc".char[-1]'), 'c');
  assert.equal(call('trimLastLine', 'abc\r'), 'abc');
  // A real (short) single char delete still works: char 1 of "abc".
  e.addScriptMember('ChunkProbe2', 'movie', 'on del1 tStr\n  delete char 1 of tStr\n  return tStr\nend\n');
  const del1 = e.globalHandlers.get('del1')!;
  assert.equal(e.interp.callHandler(del1.script, del1.handler, ['abc'], null, new Set()), 'bc');
});

test('the last char in X = "*" binds the comparison outside the chunk (star alias branch)', () => {
  // Resource Manager readAliasIndexesFromField gates its `*` mirror-alias
  // branch on `the last char in tName = "*"`. In Director the chunk binds
  // tighter than `=` (bytecode: push tName, LAST_CHUNK, push "*", EQ), so the
  // condition is (the last char in tName) = "*" — NOT `the last char in
  // (tName = "*")`. A subject that swallowed the comparison evaluated to 0/1,
  // getThe returned VOID, the star branch never fired, and every `*` mirror
  // alias failed to register — furniture never got rotation=180.
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('the last char in "abc*" = "*"'), 1);
  assert.equal(e.interp.evalExpressionString('the last char in "abc" = "*"'), 0);
  // Plain subject reads still work (the other corpus uses: `tLc = the last
  // char in tHex`).
  assert.equal(e.interp.evalExpressionString('the last char in "hello"'), 'o');
});

test('readAliasIndexesFromField star lines register NEGATIVE numbers (furniture mirror frames)', () => {
  // The sofa cast's memberalias.index chains: plain lines register
  // club_sofa_a_0_2_1_2_0 -> md_sofa_a_0_2_1_2_0's number, then the star line
  // club_sofa_a_0_2_1_4_0=club_sofa_a_0_2_1_2_0* registers the SAME number
  // NEGATED. solveMembers reads it via getmemnum and flips the sprite
  // (rotation=180/skew=180) when tMemNum < 1. A broken `the last char in`
  // condition left every star line unregistered, so direction 0/4 frames
  // resolved to 0 and the sofa fell back to wrong frames / the PH box.
  const e = new DirectorEngine();
  const mem = e.addScriptMember('rm', 'parent', `
property pAllMemNumList
on construct me
  pAllMemNumList = [:]
  pAllMemNumList["md_sofa_a_0_2_1_2_0"] = 2752514
  pAllMemNumList["md_sofa_a_0_2_1_6_0"] = 2752516
  return 1
end
on readAliasIndexesFromField me, tAliasIndex, tCastlibNo
  tAliasList = field(tAliasIndex, tCastlibNo)
  tItemDeLim = the itemDelimiter
  the itemDelimiter = "="
  repeat with i = 1 to tAliasList.line.count
    tLine = tAliasList.line[i]
    if length(tLine) > 2 then
      tName = item 2 to the number of items in tLine of tLine
      if the last char in tName = "*" then
        tName = tName.char[1..length(tName) - 1]
        tNumber = pAllMemNumList[tName]
        if tNumber > 0 then
          tReplacingNum = -tNumber
        else
          tReplacingNum = tNumber
        end if
      else
        tNumber = pAllMemNumList[tName]
        tReplacingNum = tNumber
      end if
      if tNumber > 0 then
        tMemName = item 1 of tLine
        pAllMemNumList[tMemName] = tReplacingNum
      end if
    end if
  end repeat
  the itemDelimiter = tItemDeLim
  return 1
end
on getmemnum me, tMemName
  tMemNum = pAllMemNumList[tMemName]
  if voidp(tMemNum) then
    tMemNum = 0
  end if
  return tMemNum
end
`);
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  const aliasField = new Member(1, 99, 'memberalias.index', 'text');
  aliasField.text = `club_sofa_a_0_2_1_2_0=md_sofa_a_0_2_1_2_0\nclub_sofa_a_0_2_1_6_0=md_sofa_a_0_2_1_6_0\nclub_sofa_a_0_2_1_4_0=club_sofa_a_0_2_1_2_0*\nclub_sofa_a_0_2_1_0_0=club_sofa_a_0_2_1_6_0*\n`;
  cast.members.set(99, aliasField);
  cast.byName.set('memberalias.index', aliasField);
  e.membersByGlobal.set((1 << 16) | 99, aliasField);
  const rmScript = mem.script!;
  const rm = e.interp.makeInstance(rmScript, 'rm');
  const construct = rmScript.handlers.find((h) => h.name.toLowerCase() === 'construct')!;
  const readAlias = rmScript.handlers.find((h) => h.name.toLowerCase() === 'readaliasindexesfromfield')!;
  e.interp.callHandler(rmScript, construct, [], rm, new Set());
  e.interp.callHandler(rmScript, readAlias, [aliasField.number, 1], rm, new Set());
  const getmemnum = rmScript.handlers.find((h) => h.name.toLowerCase() === 'getmemnum')!;
  const num = (name: string) => e.interp.callHandler(rmScript, getmemnum, [name], rm, new Set());
  // Plain aliases resolve positive (real members).
  assert.equal(num('club_sofa_a_0_2_1_2_0'), 2752514);
  assert.equal(num('club_sofa_a_0_2_1_6_0'), 2752516);
  // Star aliases resolve NEGATIVE — the solveMembers rotation=180 trigger.
  assert.equal(num('club_sofa_a_0_2_1_4_0'), -2752514);
  assert.equal(num('club_sofa_a_0_2_1_0_0'), -2752516);
  // Unaliased names still read 0 (getmemnum not-found contract).
  assert.equal(num('club_sofa_a_0_2_1_8_0'), 0);
});

test('RETURN/ENTER constants are Director char codes (13 / 3) and line chunks split on CR', () => {
  const e = new DirectorEngine();
  // The corpus joins multi-line text (navigator room names) with RETURN — it
  // must be CR (chr 13) or canvas renders every name on one line. ENTER is
  // chr(3) per the Lingo reference.
  assert.equal(e.interp.evalExpressionString('charToNum(RETURN)'), 13);
  assert.equal(e.interp.evalExpressionString('charToNum(ENTER)'), 3);
  assert.equal(e.interp.evalExpressionString('charToNum(TAB)'), 9);
  assert.equal(e.interp.evalExpressionString('charToNum(SPACE)'), 32);
  assert.equal(e.interp.evalExpressionString('charToNum(QUOTE)'), 34);
  // CR-joined text chunks into lines (writer render uses tText.line[i]).
  assert.equal(e.interp.evalExpressionString('("T1" & RETURN & "T2" & RETURN & "T3" & RETURN & "T4").line.count'), 4);
  assert.equal(e.interp.evalExpressionString('("A" & RETURN & "B" & RETURN & "C").line[2]'), 'B');
  // CRLF and bare LF still chunk (cross-platform tolerance).
  assert.equal(e.interp.evalExpressionString('"a\r\nb\r\nc".line.count'), 3);
});

test('word chunks split on ASCII control chars (wallet frame "59.0\x02")', () => {
  // Kepler's CREDIT_BALANCE is header 6 + "59.0" + the v14 string terminator
  // char(2) + the message terminator char(1). The corpus Purse Handler does
  // `integer(getLocalFloat(tMsg.content.word[1]))` on the RAW params, so the
  // word chunk must treat char(2)/control chars as delimiters (dirplayer
  // is_director_whitespace parity) — otherwise word[1] = "59.0\x02" and
  // Number() yields NaN -> credits stuck at 0.
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('"59.0" & numToChar(2) & numToChar(1)'), '59.0\x02\x01');
  assert.equal(e.interp.evalExpressionString('("59.0" & numToChar(2) & numToChar(1)).word[1]'), '59.0');
  assert.equal(e.interp.evalExpressionString('("59.0" & numToChar(2) & numToChar(1)).word.count'), 1);
  // ordinary words still split on whitespace
  assert.equal(e.interp.evalExpressionString('"a b\tc".word[2]'), 'b');
});

test('text members and netTextResult normalize to Director CR line endings', () => {
  // The corpus parses System Props / external_vars with
  // `the itemDelimiter = RETURN` (chr 13); the re-export ships LF, so the
  // loader and the net-text path must canonicalize to CR or class lookups
  // read VOID (script(VOID) at boot).
  assert.equal(normalizeTextLines('a\nb\nc'), 'a\rb\rc');
  assert.equal(normalizeTextLines('a\r\nb\r\nc'), 'a\rb\rc');
  const e = new DirectorEngine();
  const id = e.netGetNetText('http://x/vars.txt');
  const req = e.net.get(id);
  assert.ok(req, 'net request registered');
  if (req) {
    req.text = 'cast.entry.5=hh_shared\nclient.window.title=FuseClient';
    req.done = true;
  }
  const t = e.netTextResult(id);
  assert.equal(t, 'cast.entry.5=hh_shared\rclient.window.title=FuseClient');
  assert.equal(e.interp.evalExpressionString(`("${t}").line.count`), 2);
});

test('the lastChannel defaults to the v14 client movie\'s 1006 sprite channels', () => {
  // Without a movie.txt `channels` field the runtime must NOT fall back to
  // Director's default 150/120 — the FUSE Sprite Manager pools `the
  // lastChannel` channels and v14 windows exhaust 120 in a few opens ("Out
  // of free sprite channels!"). DirPlayer reads 1006 from the score chunk.
  const e = new DirectorEngine();
  assert.equal(e.getThe('lastchannel', []), 1006);
});

test('the-properties: frame, castLibs, castMembers', () => {
  const e = new DirectorEngine();
  assert.equal(e.getThe('frame', []), 1);
  e.addScriptMember('X', 'score', 'on exitFrame me\nend\n');
  assert.equal(e.getThe('number', [{ op: 'of', name: 'castLibs' }]), 1);
  assert.equal(e.getThe('number', [{ op: 'of', name: 'castMembers' }, { op: 'of', name: 'castLib', arg: { kind: 'num', value: 1 } }]), 1);
});

test('the number of castMembers is the highest member number, not the count (sparse casts)', async () => {
  // hh_entry_uk has 43 members numbered 1..45 (no 30/34) — Resource Manager
  // preIndexMembers does `repeat with i = 1 to the number of castMembers:
  // member(i, castLib)` to fill pAllMemNumList. Returning the COUNT (43)
  // silently skipped members #44 (cloud_1_left) and #45 (cloud_0_right), so
  // the visualizer's getmemnum("cloud_0_right") -> 0 and reported "Member
  // cloud_0_right required by visualizer: entry_view not found!". Director
  // numbering is dense 1..N, so count == max there; for our sparse bundles
  // the whole 1..max range must be reported (gaps resolve to VOID member).
  const sparse = makeCastZip('hh_sparse', [], {
    '0001_script_A.ls': '-- Cast member: A\n-- Type: Movie Script\non a\n  return 1\nend\n',
    '0044_script_B.ls': '-- Cast member: B\n-- Type: Movie Script\non b\n  return 2\nend\n',
    '0045_script_C.ls': '-- Cast member: C\n-- Type: Movie Script\non c\n  return 3\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'hh_sparse' ? sparse : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_sparse');
  // 3 members numbered 1, 44, 45 -> count is 3 but max is 45.
  assert.equal(e.casts[0].members.size, 3);
  assert.equal(e.getThe('number', [{ op: 'of', name: 'castMembers' }, { op: 'of', name: 'castLib', arg: { kind: 'num', value: 1 } }]), 45);
  // Every member must be reachable by number through the 1..N loop.
  assert.ok(e.getMember(45, 1), 'member #45 must resolve');
  assert.ok(e.getMember(44, 1), 'member #44 must resolve');
  assert.equal(e.getMember(30, 1), null, 'gap member resolves to VOID/null, not a warning');
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('frame loop runs real score behaviors (go(the frame) loop)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Loop', 'score', '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n');
  e.addScriptMember('Init', 'score', 'on exitFrame me\n  if netDone() then\n    startClient()\n  else\n    go(the frame)\n  end if\nend\n');
  e.boot();
  e.tick();
  e.tick();
  assert.equal(e.frameCount, 2);
});

test('sprite channel model: member + loc + regpoint', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Loop', 'score', 'on exitFrame me\nend\n');
  const s = e.getSprite(3);
  e.setSpriteProp(s, 'member', e.getMemberByName('Loop') as never);
  e.setSpriteProp(s, 'loch', 100);
  e.setSpriteProp(s, 'locv', 50);
  assert.equal(e.getSpriteProp(s, 'loch'), 100);
  assert.equal(e.getSpriteProp(s, 'locv'), 50);
  e.setSpriteProp(s, 'member', 65537); // by global number (Director slot: cast 1 << 16 | 1)
  assert.ok(e.getSpriteProp(s, 'member') !== null);
});

test('isPointerTarget: script-less sprites are click-transparent, brokered + editable stay targets (room hiliter)', () => {
  // Director sends mouse events to the topmost sprite WITH a script. FUSE
  // never brokers the room hiliter sprite (Visualizer buildVisual's broker
  // gate skips `#type` elements), so it must be click-transparent — it sits
  // under the cursor on the hovered tile and would eat every floor click
  // (lobby hiliter 30x15 -> clicks only worked where the cursor escaped its
  // rect; private-room hiliter 64x32 -> no clicks at all).
  const e = new DirectorEngine();
  e.addScriptMember('Broker', 'behavior', 'on mouseDown me\n  return 1\nend\n');
  const ch5 = e.getChannel(5);
  assert.equal(ch5.isPointerTarget(true), false, 'no behaviors -> click-transparent');
  assert.equal(ch5.isPointerTarget(false), true, 'rollover (raw hit-test) still sees it');
  // A behavior instance (Sprite Manager setEventBroker -> scriptInstanceList)
  // makes the sprite a pointer target.
  const script = e.resolveScript('Broker')!;
  const broker = e.interp.newInstance(script, []);
  e.setSpriteProp(e.getSprite(5), 'scriptInstanceList', new LList([broker]));
  assert.equal(e.getChannel(5).isPointerTarget(true), true, 'brokered sprite catches clicks');
  // Editable text members stay targets without behaviors (click-to-focus).
  const m = new Member(1, 1, 'field1', 'text');
  m.textProps = new Map<string, LVal>([['editable', 1]]);
  e.getChannel(6).member = m;
  assert.equal(e.getChannel(6).isPointerTarget(true), true, 'editable text focusable without a script');
});

test('value(): bare words and non-expressions are literal strings', () => {
  const e = new DirectorEngine();
  // Director value() semantics used by FUSE's convertToPropList/GetValue:
  // unknown bare words and unparseable strings evaluate to themselves.
  assert.equal(e.interp.evalExpressionString('core'), 'core');
  assert.equal(e.interp.evalExpressionString('0.2.0'), '0.2.0');
  assert.equal(e.interp.evalExpressionString('123'), 123);
  assert.equal(e.interp.evalExpressionString('#core') instanceof LSymbol, true);
  const list = e.interp.evalExpressionString('["a","b"]');
  assert.ok(list instanceof LList);
});

test('value(): bare comma-separated literal lists parse to a linear list (U92 availablesets)', () => {
  const e = new DirectorEngine();
  // Registration Handler handle_availablesets: `tSets = value(tMsg.content)`
  // where content is "1,2,3,4,...". Director parses bare comma-separated
  // literals as a list (dirplayer parses value() strings as full Lingo
  // expressions; LibreShockwave parseListOrPropList splits on top-level
  // commas), so listp(tSets) passes and Figure_System builds the selectable
  // part list. It used to survive as the raw string -> listp() false -> []
  // -> count < 2 -> VOID -> getCountOfPart = 0 -> random(0) = VOID
  // ("Can't get the model of part becouse tOrderNum ... is VOID") and the
  // avatar editor arrows could not iterate nor save.
  const v = e.interp.evalExpressionString('value("1,2,3,4")');
  assert.ok(v instanceof LList);
  assert.deepEqual((v as LList).items, [1, 2, 3, 4]);
  // bracketed literal lists are unchanged
  assert.deepEqual((e.interp.evalExpressionString('value("[1,2,3]")') as LList).items, [1, 2, 3]);
  // expressions are still evaluated
  assert.equal(e.interp.evalExpressionString('value("1 + 2")'), 3);
  // non-comma bare words keep the literal-string fallback (Variable Container
  // GetValue / convertToPropList must not turn variable values into lists)
  assert.equal(e.interp.evalExpressionString('value("general")'), 'general');
});

test('the count of <list>[i][j] counts the INNER list (U92 Figure_System getCountOfPart)', () => {
  const e = new DirectorEngine();
  // Figure_System.getCountOfPart does `return the count of
  // pSelectablePartsList[tsex][tPart]`. The parser used to grab only the first
  // atom after `of` and let parseChain attach [tsex][tPart] to the count
  // RESULT, so getCountOfPart returned VOID and the avatar editor could not
  // iterate its part options ("Can't get the model of part ... tOrderNum is
  // VOID"). The index chain must bind to the SUBJECT expression.
  e.addScriptMember(
    'CountT',
    'movie',
    [
      'on run me',
      '  tSel = [:]',
      '  tSel["M"] = [:]',
      '  tSel["M"]["hr"] = [[1, 2, 3], [4, 5]]',
      '  tSex = "M"',
      '  tPart = "hr"',
      '  return the count of tSel[tSex][tPart] & "/" & the count of tSel["M"]["hr"] & "/" & the count of tSel["M"]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('CountT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // tSel["M"]["hr"] = [[1,2,3],[4,5]] -> 2 (both variable and literal keys);
  // tSel["M"] is a proplist with 1 part -> 1
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '2/2/1');
});

test('me.prop access walks the #ancestor chain (FUSE manager inheritance)', () => {
  const e = new DirectorEngine();
  // Ancestor declares pItemList and initializes it in construct.
  e.addScriptMember(
    'Manager Template Class',
    'parent',
    [
      'property pItemList',
      'on construct me',
      '  me.pItemList = [:]',
      'end',
      'on dumpOne me, tKey, tValue',
      '  me.pItemList[tKey] = tValue',
      '  return me.pItemList.count',
      'end',
    ].join('\n'),
  );
  // Child chains to the ancestor via #ancestor.
  e.addScriptMember(
    'Text Manager Class',
    'parent',
    [
      'on construct me',
      '  tAnc = script("Manager Template Class").new()',
      '  tAnc.construct()',
      '  me.ancestor = tAnc',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Text Manager Class')!;
  const obj = e.interp.newInstance(script, []);
  // Habbo calls construct() explicitly after new() (Director never auto-runs
  // construct in newInstance), so mirror that here.
  e.interp.callObjectHandler(obj, 'construct', []);
  // me.pItemList resolves through the ancestor chain.
  const count = e.interp.callObjectHandler(obj, 'dumpOne', ['system.version', '0.2.0']);
  assert.equal(count, 1);
  const anc = obj.props.get('ancestor') as LObject;
  assert.ok(anc);
  const ancList = anc.props.get('pItemList') as LPropList;
  assert.equal(ancList.props.get('system.version'), '0.2.0');
  // reads through me.prop see the same value
  const readBack = e.interp.getPropValue(obj, 'pItemList') as LPropList;
  assert.equal(readBack.props.get('system.version'), '0.2.0');
});

test('castLib rename keeps the name index consistent', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Loop', 'score', 'on exitFrame me\nend\n');
  const ref = e.getCastLib(1)!;
  e.setCastLibProp(ref, 'name', 'empty 1');
  assert.equal(e.getCastLib('empty 1')?.number, 1);
  assert.equal(e.getThe('number', [{ op: 'of', name: 'castLib', arg: { kind: 'str', value: 'empty 1' } }]), 1);
  // The old name must not resolve to the renamed cast anymore (castLib(name)
  // may lazily create a fresh scratch cast, but never the renamed one).
  assert.equal(e.castByName.get('internal'), undefined, 'old name must be dropped');
  assert.notEqual(e.getCastLib('internal')?.number, 1, 'old name must not resolve to the renamed cast');
});

test('dynamic cast slot wipes members immediately on rename-to-empty', async () => {
  // ResetOneDynamicCast renames a used slot back to "empty N" on room leave.
  // The wipe must happen AT the rename (immediate). Deferring it to the next
  // bundle refill kept the previous room's members visible in the "empty N"
  // window — the next room's window builds referenced them mid-load and the
  // refill yanked them out from under those objects (DEPTH 25 window-recursion
  // loop + dead UI after a couple of room switches).
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const priv = makeCastZip('hh_room_private', [], {
    '0001_script_PrivateClass.ls': '-- Cast member: PrivateClass\n-- Type: Movie Script\non prepare me\n  return 1\nend\n',
    '0002_script_PrivateClass2.ls': '-- Cast member: PrivateClass2\n-- Type: Movie Script\non update me\n  return 2\nend\n',
  });
  const nlb = makeCastZip('hh_room_nlobby', [], {
    '0001_script_LobbyClass.ls': '-- Cast member: LobbyClass\n-- Type: Movie Script\non prepare me\n  return 3\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_room_private' ? priv : name === 'hh_room_nlobby' ? nlb : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  const slot = e.castByName.get('empty 1')!; // 'empty 1' shell from casts.txt
  const slotRef = e.getCastLib(4)!;
  assert.equal(slot.members.size, 0);

  // room 1: private cast refills the empty shell (setImportedCast rename).
  await loader.loadCast('hh_room_private');
  e.setCastLibProp(slotRef, 'name', 'hh_room_private');
  assert.equal(e.castByName.get('hh_room_private')?.loaded, true);
  assert.equal(e.castByName.get('hh_room_private')!.members.size, 2);
  assert.ok(e.resolveScript('PrivateClass'));
  assert.ok(e.globalHandlers.has('prepare'), 'room 1 handler registered');

  // room leave: rename back to "empty N" — members + handlers wiped NOW.
  e.setCastLibProp(slotRef, 'name', 'empty 1');
  assert.equal(slot.loaded, false);
  assert.equal(slot.members.size, 0, 'members wiped at rename (immediate)');
  assert.equal(e.resolveScript('PrivateClass'), null, 'old members gone from scriptsByName');
  assert.equal(e.globalHandlers.has('prepare'), false, 'stale handler registration removed');

  // room 2: nlobby refills the same slot clean.
  await loader.loadCast('hh_room_nlobby');
  e.setCastLibProp(slotRef, 'name', 'hh_room_nlobby');
  assert.equal(e.castByName.get('hh_room_nlobby')?.loaded, true);
  assert.equal(e.castByName.get('hh_room_nlobby')!.members.size, 1);
  assert.ok(e.resolveScript('LobbyClass'), 'new bundle members resolve');
  assert.equal(e.resolveScript('PrivateClass'), null, 'no leftover from room 1');
  assert.ok(e.globalHandlers.has('prepare'), 'new bundle handler registered');
});

test('re-import into a new dynamic slot purges the superseded holder; stale numbers re-resolve', async () => {
  // removeTemporaryCast keeps casts in the next room's load list loaded, so a
  // private->private switch re-imports hh_room_private into a DIFFERENT
  // dynamic slot (LIFO pool) while the old slot keeps the name + content
  // ("the pool fills and never clears"). The superseded holder must be purged
  // or name-based member lookups resolve against the previous room's members,
  // and stale (slot<<16)|member numbers from pAllMemNumList must re-resolve
  // to the CURRENT holder of the cast (script(720979) -> unknown script).
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const priv = makeCastZip('hh_room_private', [], {
    '0001_script_PrivateClass.ls': '-- Cast member: PrivateClass\n-- Type: Movie Script\non prepare me\n  return 1\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_room_private' ? priv : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  const slotA = e.castByName.get('empty 1')!; // castLib 4
  const slotB = e.castByName.get('empty 2')!; // castLib 5
  const refA = e.getCastLib(4)!;
  const refB = e.getCastLib(5)!;

  // room 1: private imports into slot A.
  await loader.loadCast('hh_room_private');
  e.setCastLibProp(refA, 'name', 'hh_room_private');
  assert.equal(slotA.members.size, 1);
  assert.equal(e.castByName.get('hh_room_private'), slotA);

  // room 2: the LIFO pool hands out slot B this time. Re-importing the name
  // into B supersedes A — A's stale content must be purged immediately.
  e.setCastLibProp(refB, 'name', 'hh_room_private');
  assert.equal(slotB.members.size, 1, 'fresh import lands in B');
  assert.equal(slotA.members.size, 0, 'superseded holder A purged');
  assert.equal(slotA.loaded, false);
  assert.equal(e.castByName.get('hh_room_private'), slotB, 'name now resolves to B');
  assert.ok(e.resolveScript('PrivateClass'), 'name-based script lookup finds the fresh import');

  // Stale pAllMemNumList number from room 1 ((4<<16)|1) re-resolves to B's
  // member 1 via the slot's last known cast name.
  const staleNum = (4 << 16) | 1;
  assert.equal(e.membersByGlobal.has(staleNum), false, 'stale encode is gone from the global index');
  const script = e.resolveScriptByNumber(staleNum);
  assert.ok(script, 'stale slot-encoded number re-resolves to the current holder');
  assert.equal(script!.name, 'PrivateClass');
  const ref = e.getMember(staleNum);
  assert.ok(ref, 'getMember re-resolves the stale encode');
  assert.equal(ref!.castLibNumber, 5, 'resolved to the current holder (slot B)');
});

test('clearCastMembers unregisters the cast from the corpus Resource Manager (no stale getmemnum cache)', async () => {
  // U131: our engine's clears (superseded-holder purge / rename-to-empty) must
  // mirror the corpus's own release ordering — unregisterMembers FIRST — or
  // the Resource Manager's pAllMemNumList keeps the cast's (slot<<16)|local
  // numbers, and after the slot is reused by a DIFFERENT cast those stale
  // numbers resolve through membersByGlobal to the new occupant's member (the
  // wrong-sprites corruption: a sound machine GUI member appearing on
  // furniture shadows after window churn).
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const privManifest = {
    version: 1 as const,
    casts: [{
      name: 'hh_room_private',
      members: [
        { number: 1, kind: 'bitmap' as const, name: 'art_a', file: 'hh_room_private/0001_bitmap_art_a.png' },
        { number: 2, kind: 'bitmap' as const, name: 'art_b', file: 'hh_room_private/0002_bitmap_art_b.png' },
      ],
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts: [] as { name: string; file: string }[],
    }],
    files: ['hh_room_private/0001_bitmap_art_a.png', 'hh_room_private/0002_bitmap_art_b.png'],
  };
  const privEntries: Record<string, Uint8Array> = {
    'bundle-manifest.json': strToU8(JSON.stringify(privManifest)),
    'hh_room_private/0001_bitmap_art_a.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    'hh_room_private/0002_bitmap_art_b.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]),
  };
  const priv = zipSync(privEntries, { level: 6 });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_room_private' ? priv : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');

  // Corpus-style Resource Manager (fuse_client 0029) with the real cache
  // handlers: preIndexMembers populates pAllMemNumList, unregisterMembers
  // clears it, getmemnum reads it. getresourcemanager is a global handler so
  // the engine's indexCast/unindexCast can find the instance.
  const mem = e.addScriptMember(
    'rm',
    'parent',
    [
      'property pAllMemNumList',
      'on construct me',
      '  pAllMemNumList = [:]',
      '  return 1',
      'end',
      'on getresourcemanager me',
      '  return gRMInst',
      'end',
      'on preIndexMembers me, tCastNum',
      '  tFirstCast = tCastNum',
      '  tLastCast = tCastNum',
      '  repeat with tCastLib = tFirstCast to tLastCast',
      '    tMemberCount = the number of castMembers of castLib tCastLib',
      '    repeat with i = 1 to tMemberCount',
      '      tmember = member(i, tCastLib)',
      '      if length(tmember.name) > 0 then',
      '        pAllMemNumList[tmember.name] = tmember.number',
      '      end if',
      '    end repeat',
      '  end repeat',
      '  return 1',
      'end',
      'on unregisterMembers me, tCastNum',
      '  if voidp(tCastNum) then return 0',
      '  tMemberCount = the number of castMembers of castLib tCastNum',
      '  repeat with i = 1 to tMemberCount',
      '    tmember = member(i, tCastNum)',
      '    tTempNum = pAllMemNumList[tmember.name]',
      '    if tTempNum <> VOID then',
      '      if tTempNum = tmember.number then',
      '        pAllMemNumList.deleteProp(tmember.name)',
      '      end if',
      '    end if',
      '  end repeat',
      '  return 1',
      'end',
      'on getmemnum me, tMemName',
      '  tMemNum = pAllMemNumList[tMemName]',
      '  if voidp(tMemNum) then tMemNum = 0',
      '  return tMemNum',
      'end',
    ].join('\n'),
  );
  const rmScript = mem.script!;
  const rm = e.interp.makeInstance(rmScript, 'rm');
  const construct = rmScript.handlers.find((h) => h.name.toLowerCase() === 'construct')!;
  e.interp.callHandler(rmScript, construct, [], rm, new Set());
  e.globals.set('grminst', rm);
  const grm = rmScript.handlers.find((h) => h.name.toLowerCase() === 'getresourcemanager')!;
  e.globalHandlers.set('getresourcemanager', { script: rmScript, handler: grm });
  const getmemnum = rmScript.handlers.find((h) => h.name.toLowerCase() === 'getmemnum')!;
  const num = (n: string) => e.interp.callHandler(rmScript, getmemnum, [n], rm, new Set());

  // room 1: private cast refills the empty-1 shell (slot 4). The dynamic
  // download path auto-indexes (non-URL name) -> pAllMemNumList fills.
  await loader.loadCast('hh_room_private');
  const slotRef = e.getCastLib(4)!;
  e.setCastLibProp(slotRef, 'name', 'hh_room_private');
  const slot = e.castByName.get('hh_room_private')!;
  assert.equal(slot.number, 4);
  assert.equal(num('art_a'), (4 << 16) | 1, 'indexed into the corpus cache');
  assert.equal(num('art_b'), (4 << 16) | 2);

  // room leave: rename back to "empty N" -> clearCastMembers must unregister
  // the names from the corpus cache (unindexCast), not just wipe our maps.
  e.setCastLibProp(slotRef, 'name', 'empty 1');
  assert.equal(slot.members.size, 0, 'members wiped at rename');
  assert.equal(num('art_a'), 0, 'stale name unregistered from pAllMemNumList');
  assert.equal(num('art_b'), 0);
});

test('stale sprite castNum/member re-resolves to the current holder of the cast (U131)', async () => {
  // The sprite paths (sprite(n).castNum / sprite(n).member = <number>) resolve
  // a stale (slot<<16)|local encode through memberForStaleSlotNumber — the
  // same re-resolution getMember()/resolveScriptByNumber() use — so a cleared
  // slot's number lands on the CURRENT holder of the cast instead of going
  // invisible or hitting a reused slot's unrelated member.
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const priv = makeCastZip('hh_room_private', [], {
    '0001_script_PrivateClass.ls': '-- Cast member: PrivateClass\n-- Type: Movie Script\non prepare me\n  return 1\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_room_private' ? priv : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  const refA = e.getCastLib(4)!;
  const refB = e.getCastLib(5)!;

  await loader.loadCast('hh_room_private');
  e.setCastLibProp(refA, 'name', 'hh_room_private');
  e.setCastLibProp(refB, 'name', 'hh_room_private'); // LIFO pool: fresh import supersedes A
  const staleNum = (4 << 16) | 1;

  const s = e.getSprite(7);
  e.setSpriteProp(s, 'castNum', staleNum);
  assert.equal(e.getSpriteProp(s, 'castNum'), (5 << 16) | 1, 'stale castNum re-resolves to slot B');
  assert.equal(e.getSpriteProp(s, 'castlibnum'), 5);

  // The number form of sprite(n).member takes the same path.
  e.setSpriteProp(s, 'member', staleNum);
  assert.equal(e.getSpriteProp(s, 'castlibnum'), 5, 'stale member number re-resolves to slot B');
  assert.equal(e.getSpriteProp(s, 'castNum'), (5 << 16) | 1, 'member-set stale number re-resolves to slot B');
});

test('getPropAt returns the raw key value (strings stay strings)', () => {
  // Regression: string keys were wrapped in LSymbol, corrupting FUSE
  // pTaskQueue names (define -> pMemName -> member name became the string
  // of an object, so dumpVariableField could never find the member).
  const e = new DirectorEngine();
  e.addScriptMember(
    'PropT',
    'movie',
    [
      'on run me',
      '  tP = [:]',
      '  tP["http://x/v14/vars.txt"] = 1',
      '  return tP.getPropAt(1)',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('PropT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'http://x/v14/vars.txt');
});

test('getPropAt returns the key at the given index (Director semantics)', () => {
  // Keys are stored normalized as strings (keyOf), so getPropAt returns the
  // raw key string; lookups through it round-trip to the value.
  const e = new DirectorEngine();
  e.addScriptMember(
    'PropT2',
    'movie',
    [
      'on run me',
      '  tP = [#breakfast: "Waffles", #lunch: "Tofu Burger"]',
      '  return tP[tP.getPropAt(2)]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('PropT2')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'Tofu Burger');
});

test('proplists keep DUPLICATE keys in order (NAVIGATE [#integer: 0, #integer: 3, #integer: 1])', () => {
  // Root cause of "navigator loads no rooms": the corpus builds wire param
  // lists as literal proplists with repeated keys — Navigator Component 0039
  // `send("NAVIGATE", [#integer: tNodeMask, #integer: integer(tNodeId),
  // #integer: tDepth])` — and Connection sendNew walks them POSITIONALLY
  // (`repeat with i = 1 to tParmArr.count: tParmArr.getPropAt(i); tParmArr[i]`).
  // A Map-backed LPropList collapsed the three #integer entries into one
  // (last-write-wins), so count was 1 and the frame carried a single param —
  // kepler read hideFull=1, categoryId=<empty> and silently dropped NAVIGATE.
  // Real Lingo proplists (dirplayer PropList(VecDeque<PropListPair>),
  // LibreShockwave properties_ vector) are ordered pair lists.
  const e = new DirectorEngine();
  e.addScriptMember(
    'NavP',
    'movie',
    [
      'on run me',
      '  tP = [#integer: 0, #integer: 3, #integer: 1]',
      '  tCount = tP.count',
      '  tK = tP.getPropAt(1) & "/" & tP.getPropAt(2) & "/" & tP.getPropAt(3)',
      '  tV = tP[1] & "/" & tP[2] & "/" & tP[3]',
      '  tDup = string(tP)',
      '  return tCount & "|" & tK & "|" & tV & "|" & tDup',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('NavP')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // count=3, keys #integer x3, positional values 0,3,1, literal stringified
  // with all three pairs in order.
  assert.equal(
    e.interp.callHandler(script, run, [], null, new Set()),
    '3|integer/integer/integer|0/3/1|[#integer: 0, #integer: 3, #integer: 1]',
  );
  // setaProp replaces the FIRST match (C++ putTyped); addProp always appends
  // (C++ appendProperty); setAt/deleteAt are positional.
  e.addScriptMember(
    'NavMut',
    'movie',
    [
      'on run me',
      '  tP = [#integer: 0, #integer: 3, #integer: 1]',
      '  tP.setAProp(#integer, 9)',
      '  tAfterSet = tP[1] & "/" & tP.count',
      '  tP.addProp(#integer, 7)',
      '  tAfterAdd = tP[4] & "/" & tP.count',
      '  tP.setAt(2, 5)',
      '  tAfterSetAt = tP[2] & "/" & tP[3]',
      '  tP.deleteAt(1)',
      '  tAfterDel = tP.count & "/" & tP[1] & "/" & tP[2]',
      '  tP[2] = 11',
      '  tIdx = tP[2]',
      '  return tAfterSet & "|" & tAfterAdd & "|" & tAfterSetAt & "|" & tAfterDel & "|" & tIdx & "|" & tP.count',
      'end',
    ].join('\n'),
  );
  const script2 = e.resolveScript('NavMut')!;
  const run2 = script2.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // setAProp(#integer,9) -> first #integer becomes 9: [9,3,1]
  // addProp(#integer,7) -> appended: [9,3,1,7]
  // setAt(2,5) -> value at pos 2 = 5: [9,5,1,7]
  // deleteAt(1) -> [5,1,7]
  // tP[2]=11 -> [5,11,7]
  assert.equal(e.interp.callHandler(script2, run2, [], null, new Set()), '9/3|7/4|5/1|3/5/1|11|3');
});

test('chunk assignment writes back: put "x" into (t).char[7] and char/word/item/line = (buildVisual private room)', () => {
  // U134: Visualizer Instance Class buildVisual does
  // `put "x" into (tLayoutName).char[7]` (the private-room model_x.room
  // detection) — previously setChunkValue computed the replacement but
  // assigned its own string parameter (a no-op) then warned 'chunk
  // assignment has no effect (strings are immutable)'. Lingo strings ARE
  // chunk-assignable; the result must write back to the variable.
  const e = new DirectorEngine();
  e.addScriptMember(
    'ChunkSet',
    'movie',
    [
      'on run me',
      '  t = "model_a.room"',
      '  put "x" into (t).char[7]',
      '  tPrivate = (t = "model_x.room")',
      '  s = "abcdef"',
      '  s.char[2] = "XYZ"',
      '  s2 = "abcdef"',
      '  s2.char[2..3] = "Q"',
      '  w = "a b c"',
      '  w.word[2] = "new"',
      '  i = "a,b,c"',
      '  i.item[2] = "B"',
      '  l = "one" & RETURN & "two" & RETURN & "three"',
      '  l.line[2] = "TWO"',
      '  n = "abc"',
      '  n.char[-1] = "Z"',
      '  return t & "|" & tPrivate & "|" & s & "|" & s2 & "|" & w & "|" & i & "|" & l & "|" & n',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('ChunkSet')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(
    e.interp.callHandler(script, run, [], null, new Set()),
    'model_x.room|1|aXYZcdef|aQdef|a new c|a,B,c|one\rTWO\rthree|abZ',
  );
});

test('multi-value return parses and returns the last value (`return RETURN, error(...)` — sparkd R31 form)', () => {
  // U135: sparkd renders the R31 compiler's return-with-error-call bytecode as
  // `return RETURN, error(me, ...)` (10x across hh_cat_new) — the parser died
  // on the comma, registerCast threw mid-cast, the cast-load task's ordered
  // init loop stuck at hh_cat_new, and the login thread (hh_entry_init) never
  // built -> no multiuser connection -> boot stalled at the full loading bar.
  const e = new DirectorEngine();
  e.addScriptMember(
    'MultiRet',
    'movie',
    [
      'on run me',
      '  t1 = voidp(errPath())',
      '  t2 = voidp(errPath2())',
      '  return t1 & "/" & t2',
      'end',
      'on errPath',
      '  return RETURN, error(me, "boom", #errPath, #major)',
      'end',
      'on errPath2',
      '  return error(me, "boom2", #errPath2, #major)',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('MultiRet')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // Both forms yield error()'s result (VOID): the multi-value return returns
  // its LAST value, identical to the sibling `return error(...)`.
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '1/1');
  assert.ok(e.logs.some((l) => l.includes('ERROR: boom')), 'error() fired for the multi-value return');
  assert.ok(e.logs.some((l) => l.includes('ERROR: boom2')), 'error() fired for the plain form');
});

test('method call on VOID is a silent no-op returning VOID (Download Manager update loop)', () => {
  // Download Manager update (0030): `repeat with i = 1 to pActiveTasks.count`
  // iterates a proplist whose count was captured BEFORE the loop, but a task
  // completing mid-loop deleteAt()s itself and shifts the list — a later
  // index reads VOID, so `tTask.getProperty(#url)` runs on VOID. Real
  // Director / LibreShockwave dispatchObjectMethod: a method call on VOID is
  // a SILENT no-op returning VOID (no diagnostic).
  const e = new DirectorEngine();
  e.addScriptMember(
    'VoidCall',
    'movie',
    [
      'on run me',
      '  t = VOID',
      '  tR = t.getProperty(#url)',
      '  tR2 = t.foo(1, 2)',
      '  return voidp(tR) & "/" & voidp(tR2)',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('VoidCall')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '1/1');
  assert.ok(!e.logs.some((l) => /called on VOID|unsupported/.test(l)), 'no warn for a method call on VOID');
});

test('bare setaProp/getaProp/addaProp/deleteaProp/countaProp builtins (Variable Container dump path)', () => {
  // U132: fuse_client's Variable Container Class `dump` calls the GLOBAL form
  // `setaProp(me.pItemList, tProp, tValue)` (not the method form) while
  // building the boot variable list — previously "unresolved handler/builtin"
  // and every boot variable was dropped. Director semantics: setaProp replaces
  // the FIRST match else appends; addaProp always appends; countaProp is the
  // property count; deleteaProp removes the property.
  const e = new DirectorEngine();
  e.addScriptMember(
    'VarDump',
    'movie',
    [
      'on run me',
      '  tP = [#a: 10]',
      '  setaProp(tP, #b, 20)',
      '  addaProp(tP, #c, 30)',
      '  tS = getaProp(tP, #b) & "/" & getaProp(tP, #c)',
      '  setaProp(tP, #a, 99)',
      '  tR = tP[#a] & "/" & countaProp(tP)',
      '  deleteaProp(tP, #b)',
      '  tD = voidp(getaProp(tP, #b)) & "/" & countaProp(tP)',
      '  return tS & "|" & tR & "|" & tD',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('VarDump')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // setaProp adds #b, addaProp appends #c, setaProp replaces the FIRST #a,
  // deleteaProp removes #b: [#a:99, #c:30]
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '20/30|99/3|1/2');
});

test('duplicate() of a duplicate-key proplist keeps every pair (wire param copy)', () => {
  const e = new DirectorEngine();
  // Build through the real interpreter literal path (a plain Map can't hold
  // the duplicate keys — that IS the bug this regression guards).
  const src = e.interp.evalExpressionString('[#integer: 0, #integer: 3, #integer: 1]') as LPropList;
  const dup = duplicateValue(src) as LPropList;
  assert.equal(dup.props.size, 3, 'duplicate preserves the three #integer pairs');
  assert.equal(dup.getAt(1), 0);
  assert.equal(dup.getAt(2), 3);
  assert.equal(dup.getAt(3), 1);
});

test('PropPairs lazy first-index cache: first-match reads + invalidation on structural edits', () => {
  // The FUSE Variable Container's pItemList (200+ external vars) is read via
  // props.get on every getVariable() — the lazy first-index cache turns the
  // O(n) scan into O(1) while preserving EXACT first-match semantics and
  // duplicate-key order (a Map can't hold the dupes, so the cache must keep
  // pointing at the earliest pair). Structural edits (delete/splice) drop the
  // cache; replace-in-place and appends must keep it valid.
  const p = new PropPairs([['a', 1], ['b', 2], ['a', 3], ['c', 4]]);
  // first-match read: pair 0, not the later duplicate
  assert.equal(p.get('a'), 1);
  assert.equal(p.has('a'), true);
  assert.equal(p.get('missing'), undefined);
  // cache stays correct across interleaved read/write
  p.set('b', 20); // replace first b in place — no shift, cache stays valid
  assert.equal(p.get('b'), 20);
  assert.equal(p.get('a'), 1);
  assert.equal(p.size, 4);
  // delete removes the FIRST match and invalidates (splice shifts indices)
  assert.equal(p.delete('a'), true);
  assert.equal(p.get('a'), 3, 'after delete, the second duplicate is now first');
  assert.equal(p.size, 3);
  assert.equal(p.getAt(1), 20, 'set-in-place kept [b,20] at position 1');
  assert.equal(p.getAt(2), 3);
  // append of a brand-new key is visible through the cache
  p.append('d', 5);
  assert.equal(p.get('d'), 5);
  assert.equal(p.size, 4);
  // append of an EXISTING key keeps the earlier index (first-match)
  p.append('b', 99);
  assert.equal(p.get('b'), 20, 'first b pair still wins after duplicate append');
  assert.equal(p.getAt(4), 5);
  assert.equal(p.getAt(5), 99, 'duplicate b appended at the tail');
  // positional delete invalidates too
  p.deleteAt(1); // removes [b,20]
  assert.equal(p.get('b'), 99, 'after positional delete the appended b is first');
  assert.equal(p.get('c'), 4);
  // setAt replaces the value at position 1 (the a pair) in place
  p.setAt(1, 100);
  assert.equal(p.get('a'), 100);
  assert.equal(p.get('b'), 99, 'positional write must not disturb other keys');
  // clear drops everything
  p.clear();
  assert.equal(p.size, 0);
  assert.equal(p.get('b'), undefined);
  p.append('z', 7);
  assert.equal(p.get('z'), 7);
  // full iteration still walks every pair in order (dupes included)
  const p2 = new PropPairs([['x', 1], ['x', 2], ['y', 3]]);
  assert.deepEqual([...p2.keys()], ['x', 'x', 'y']);
  assert.deepEqual([...p2.values()], [1, 2, 3]);
  assert.deepEqual([...p2.entries()], [['x', 1], ['x', 2], ['y', 3]]);
});

test('line/word/item chunk counts match split-based semantics on edge cases', () => {
  // The allocation-free count rewrite must agree with the old split() logic
  // on everything the corpus throws at it: empty strings, leading/trailing
  // delimiters, CRLF, lone LF, control-char words, and mixed delimiters.
  // NOTE: Lingo string literals have no escape sequences, so the fixture
  // strings embed the REAL control bytes (JS \r/\n escapes) directly;
  // numToChar builds chars JS can't embed in the test source (\x02).
  const e = new DirectorEngine();
  const cases: [string, number][] = [
    // line: split on CR (RETURN chr13), tolerant of LF and CRLF; a trailing
    // separator keeps a trailing empty piece (JS split semantics)
    ['""', 1],
    ['"a"', 1],
    ['"\n"', 2],
    ['"a\nb\nc"', 3],
    ['"a\r\nb\r\nc"', 3],
    ['"a\r\nb"', 2],
    ['"\r\na\r\n"', 3],
    ['"a\nb\r\nc"', 3],
    // word: split on whitespace + ASCII control chars (empties dropped)
    ['""', 0],
    ['"a b c"', 3],
    ['"  a  b  "', 2],
    ['"a\tb\tc"', 3],
    ['("59.0" & numToChar(2) & numToChar(1))', 1],
    ['("a" & numToChar(2) & "b")', 2],
    ['numToChar(2)', 0],
    // item: split on itemDelimiter (comma default)
    ['"a,b,c"', 3],
    ['",,"', 3],
    ['"a,,b"', 3],
  ];
  // Each fixture belongs to one chunk family: first 8 are line cases, next 7
  // word cases, last 3 item cases.
  const lineCases: [string, number][] = cases.slice(0, 8);
  const wordCases: [string, number][] = cases.slice(8, 15);
  const itemCases: [string, number][] = cases.slice(15);
  for (const [expr, want] of lineCases) {
    assert.equal(e.interp.evalExpressionString(expr + '.line.count'), want, `${expr}.line.count`);
  }
  for (const [expr, want] of wordCases) {
    assert.equal(e.interp.evalExpressionString(expr + '.word.count'), want, `${expr}.word.count`);
  }
  for (const [expr, want] of itemCases) {
    assert.equal(e.interp.evalExpressionString(expr + '.item.count'), want, `${expr}.item.count`);
  }
});

test('externalParamValue: sw params by name and index (Core_Thread sw1..sw9)', () => {
  const e = new DirectorEngine();
  e.setExternalParams({
    sw1: 'external.variables.txt=/external_variables.txt',
    sw2: 'host=habbo.example',
  });
  assert.equal(e.externalParamValue('sw1'), 'external.variables.txt=/external_variables.txt');
  assert.equal(e.externalParamValue(1), 'external.variables.txt=/external_variables.txt');
  assert.equal(e.externalParamValue(2), 'host=habbo.example');
  assert.equal(e.externalParamValue('SW2'), 'host=habbo.example', 'name lookup is case-insensitive');
  assert.equal(e.externalParamValue('missing'), VOID);
  assert.equal(e.externalParamValue(99), VOID);
  assert.equal(e.externalParamCount(), 2);
  assert.equal(e.externalParamName(1), 'sw1');
  // Reachable from Lingo, which is how Core_Thread reads sw1..sw9.
  assert.equal(e.interp.evalExpressionString('externalParamValue("sw2")'), 'host=habbo.example');
  assert.equal(e.interp.evalExpressionString('externalParamCount()'), 2);
});

test('call() maps over proplist values (FUSE pActiveTasks convention)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Task',
    'parent',
    ['on construct me', '  me.pN = 0', 'end', 'on bump me, x', '  me.pN = me.pN + x', '  return me.pN', 'end'].join('\n'),
  );
  const script = e.resolveScript('Task')!;
  const a = e.interp.newInstance(script, []);
  const b = e.interp.newInstance(script, []);
  const pl = new LPropList(new Map([['first', a], ['second', b]]));
  e.interp.callBuiltin([new LSymbol('bump'), pl, 3]);
  assert.equal(a.props.get('pN'), 3);
  assert.equal(b.props.get('pN'), 3);
});

test('put x after/before y appends/prepends (Director string commands)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'PutT',
    'movie',
    ['on run me', '  tS = "a"', '  put "b" after tS', '  put "z" before tS', '  return tS', 'end'].join('\n'),
  );
  const script = e.resolveScript('PutT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'zab');
});

test('& concatenation coerces VOID to empty (Window Instance CreateElement tClass)', () => {
  // Director: `"window." & ttype & VOID & ".class"` = "window.image.class".
  // It used to produce "window.imageVOID.class", so variableExists failed and
  // the Image Wrapper Class never joined the drag element's ancestor chain
  // (the loading-bar buffer stayed 1x1 instead of resizing to 128x16).
  const e = new DirectorEngine();
  e.addScriptMember(
    'T',
    'movie',
    ['on run', '  tClass = "window." & "image" & VOID & ".class"', '  tEmpty = "a" & VOID & "b"', '  tSym = EMPTY & #component & ".class"', '  tStr = string(void)', '  return tClass & "/" & tEmpty & "/" & tSym & "/" & tStr', 'end'].join('\n'),
  );
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // string(void) is EMPTY too (C++ StringBuiltins::string -> toStringLikeJava
  // maps Void -> "", DirPlayer string.rs same) — the Connection Instance
  // `send` relies on it to emit empty bodies for commands with no payload
  // (U80: kepler was receiving the literal 'VOID' in GETUSERFLATCATS /
  // MESSENGER_GETREQUESTS).
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 'window.image.class/ab/component.class/');
});

test('EMPTY is the empty string: string(EMPTY) blank, string(VOID) too (U50 + U80)', () => {
  // Director's EMPTY constant IS the empty string: `put EMPTY` prints blank,
  // `string(EMPTY)` = "", `EMPTY = ""` is true. LibreShockwave Datum::
  // stringValue maps Null -> "" and StringBuiltins::string ->
  // toStringLikeJava maps Void -> "" as well (DirPlayer string.rs:
  // `Datum::Void => Datum::String("".to_string())`), so string(VOID) is also
  // the empty string. FUSE stores `pLastContent = EMPTY` / `tStr = EMPTY` and
  // &s them into packet strings; toLingoString used to print the literal
  // 'EMPTY' into them.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('string(EMPTY)'), '');
  assert.equal(ev('string(VOID)'), '');
  assert.equal(ev('"x" & EMPTY & "y"'), 'xy');
  assert.equal(ev('EMPTY = ""'), 1);
  assert.equal(ev('EMPTY = "notblank"'), 0);
  // VOID is still distinct from EMPTY as a value (voidp(VOID) is true).
  assert.equal(ev('VOID = EMPTY'), 0);
});

test('point - list subtracts componentwise (Window Instance buildVisual sprite repos)', () => {
  // Window Instance buildVisual does `tloc = tSpriteList[i].loc - [rect[1], rect[2]]`
  // then `loc = point(pLocX, pLocY) + tloc` to place every element sprite at the
  // window position. lingoSubtract lacked the point - list case (lingoAdd had
  // point + list), so tloc became 0 and the loading-bar sprite stayed at (1,1)
  // instead of following center() to stage center.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  const pt = (s: string) => {
    const v = ev(s) as { locH: number; locV: number };
    return `${v.locH},${v.locV}`;
  };
  assert.equal(pt('point(1, 1) - [0, 0]'), '1,1');
  assert.equal(pt('point(100, 100) - [3, 7]'), '97,93');
  assert.equal(pt('point(100, 100) + (point(1, 1) - [0, 0])'), '101,101');
  assert.equal(pt('[4, 6] - point(1, 2)'), '3,4');
  const rc = ev('rect(10, 20, 30, 40) - [1, 2, 3, 4]') as { left: number; top: number; right: number; bottom: number };
  assert.equal(`${rc.left},${rc.top},${rc.right},${rc.bottom}`, '9,18,27,36');
});

test('rect(point, point) is the two-point Director form (avatar pLocFix offset)', () => {
  // Bodypart_Class_EX 0003:204-207 places avatar parts with
  // `pCacheRectA = rect(tX, tY, ...) + [pXFix, pYFix, ...] + rect(tLocFix, tLocFix)`
  // where tLocFix = pLocFix = point(-1, 2) (Human Class 0002:273). Director's
  // rect() takes two points = rect(p1.x, p1.y, p2.x, p2.y); asNum(point) = 0
  // zeroed it, so the (-1, 2) offset vanished and the avatar rendered 1px
  // right / 2px up vs DirPlayer.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  const rc = (s: string) => {
    const v = ev(s) as { left: number; top: number; right: number; bottom: number };
    return `${v.left},${v.top},${v.right},${v.bottom}`;
  };
  assert.equal(rc('rect(point(-1, 2), point(-1, 2))'), '-1,2,-1,2');
  // Full bodypart expression: base rect + [0,0,0,0] + rect(locFix) shifts by (-1, 2).
  assert.equal(rc('rect(10, 20, 30, 40) + [0, 0, 0, 0] + rect(point(-1, 2), point(-1, 2))'), '9,22,29,42');
  // 4-number form and rect+rect addition are untouched.
  assert.equal(rc('rect(1, 2, 3, 4)'), '1,2,3,4');
  assert.equal(rc('rect(1, 2, 3, 4) + rect(-1, 2, -1, 2)'), '0,4,2,6');
  // Director rect +/− point offsets each side by the point (DirPlayer
  // add/subtract_datums Rect+Point cases).
  assert.equal(rc('rect(1, 2, 3, 4) + point(-1, 2)'), '0,4,2,6');
  assert.equal(rc('rect(1, 2, 3, 4) - point(-1, 2)'), '2,0,4,2');
});

test('unary minus negates points/rects/lists element-wise (Bodypart getLocation)', () => {
  // Bodypart_Class_EX 0003:344 `return -tRegPoint + tCntrPoint` — the head
  // part's offset feeding the Select Arrow's position above the avatar.
  // asNum(point)=0 dropped the regPoint (e.g. point(-20, 74)), so the arrow
  // hovered at head level instead of above it (DirPlayer inv parity:
  // arithmetics.rs negates Datum::Point element-wise).
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  const pt = (s: string) => {
    const v = ev(s) as { locH: number; locV: number };
    return `${v.locH},${v.locV}`;
  };
  assert.equal(pt('-point(20, 30)'), '-20,-30');
  assert.equal(pt('-point(-20, 74)'), '20,-74');
  // Full getLocation chain: -regPoint + center.
  assert.equal(pt('-point(-20, 74) + point(13, 15)'), '33,-59');
  assert.equal(pt('-point(-8, 37) + point(7, 8)'), '15,-29');
  // Lists negate item-wise; scalars unchanged; VOID coerces to 0.
  const lm = ev('-[1, -2, 3]') as LList;
  assert.deepEqual(lm.items, [-1, 2, -3]);
  assert.equal(ev('-5'), -5);
  assert.equal(ev('-VOID'), 0);
});

test('division/modulo coerce 0 and VOID divisors like DirPlayer (no NaN poisoning)', () => {
  // DirPlayer divide_datums: a VOID operand gives 0 (a VOID DIVISOR is matched
  // BEFORE the int/int case, so x/VOID = 0, not x/1); a numeric divisor 0 is
  // coerced to 1 (ScummVM LC::divData) — JS would yield Infinity/NaN and
  // poison downstream math (geometry factors are 0.0 before a room defines
  // them). mod_handler: zero divisor → 0, VOID → 0, lists mod element-wise
  // (Petpart `1 mod me.pAnimCounter` with a 0 counter must read 0).
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('5 / 0'), 5);
  assert.equal(ev('5 / VOID'), 0);
  assert.equal(ev('VOID / 5'), 0);
  assert.equal(ev('14 / 4'), 3); // int/int truncates (unchanged)
  assert.equal(ev('14.0 / 4'), 3.5); // float operand float-divides (unchanged)
  assert.equal(ev('10 div 0'), 10);
  assert.equal(ev('10 div VOID'), 0);
  assert.equal(ev('VOID div 5'), 0);
  assert.equal(ev('5 mod 0'), 0);
  assert.equal(ev('1 mod 0'), 0);
  assert.equal(ev('7 mod 3'), 1);
  const lm = ev('[5, 7, 9] mod 2') as LList;
  assert.deepEqual(lm.items, [1, 1, 1]);
});

test('min/max unwrap a single list arg; sqrt/power keep float typing (DirPlayer)', () => {
  // DirPlayer min/max (types.rs): one LIST arg is unwrapped element-wise — Room
  // Component 0011:341 `tRemoveCount = min([tRemoveCountMax, tActiveObjCount])`
  // and Visualizer Part Wrapper 0079:304 `min(tLocs[#X1])`; without the unwrap
  // asNum(list) = 0 collapsed the result. sqrt is always Float in DirPlayer
  // (int.rs:46) and power is Float when either operand is — the mark makes
  // `sqrt(4) / 2` a float division instead of int-truncated (CIterateSeed's
  // `n / power(2, s)` wire-seed math depends on the division typing).
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('min([5, 2, 8])'), 2);
  assert.equal(ev('max([5, 2, 8])'), 8);
  assert.equal(ev('min(3, 7)'), 3);
  assert.equal(ev('max(3, 7)'), 7);
  assert.equal(ev('min([2.5, 3])'), 2.5);
  // sqrt of a perfect square stays float-typed: sqrt(4) / 2 = 2.0/2 = 1.0
  // (a truncating int division of an unmarked sqrt(4)=2 would give 1 too, so
  // probe the DIVISION type through float() of the quotient path instead:
  // sqrt(9) / 2 must float-divide to 1.5, and sqrt(9) / 0 coerces like float).
  assert.equal(ev('sqrt(9) / 2'), 1.5);
  assert.equal(ev('sqrt(4) / 0'), 2); // float-marked: 2.0/1 float path
  assert.equal(ev('power(2, 3)'), 8);
  assert.equal(ev('power(2.0, 3) / 2'), 4);
  // `the maxInteger` = i32::MAX (DirPlayer movie.rs:307) — Gamesystem
  // CIterateSeed 0025:52 does `float(the maxinteger) * 2 + 2 + n` (the wire
  // seed PRNG) and String Services explode (0036:116) bounds on it.
  assert.equal(ev('the maxInteger'), 2147483647);
});

test('list + list / list - list are element-wise (Window Instance pClientRect borders)', () => {
  // Window Instance 0054:51/103/558: pClientRect = [0,0,0,0] then
  // `pClientRect = pClientRect - tGroupData[#border]` (on define) and
  // `pClientRect = pClientRect + tGroupData[#border]` (on merge). Before the
  // list cases existed, lingoAdd/list lingoSubtract returned null and the
  // interpreter fell back to asNum()+asNum() = 0+0 = 0, so pClientRect
  // collapsed to the NUMBER 0 — every subsequent pClientRect[1..4] read was
  // 0, the element offsets and the resize target (tNewW/tNewH) vanished, and
  // the back buffer painted 3px smaller than its window.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s) as LList;
  const lst = (s: string) => (ev(s).items as number[]).join(',');
  assert.equal(lst('[0, 0, 0, 0] + [12, 12, 15, 15]'), '12,12,15,15');
  assert.equal(lst('[12, 12, 15, 15] - [12, 12, 15, 15]'), '0,0,0,0');
  assert.equal(lst('[1, 2, 3, 4] + [10, 20]'), '11,22', 'min-length element-wise (C++ add min(lhs,rhs))');
  assert.equal(lst('[1, 2, 3] + 5'), '6,7,8', 'scalar broadcast (C++ addScalarToList)');
  assert.equal(lst('5 + [1, 2, 3]'), '6,7,8', 'scalar on the left broadcasts too');
  assert.equal(lst('[10, 20, 30] - 4'), '6,16,26');
  assert.equal(lst('100 - [1, 2, 3]'), '99,98,97', 'scalar minus list (C++ subtractListFromScalar)');
  assert.equal(lst('[1, 2, 3] + [1, 2, 3] + [1, 1, 1]'), '3,5,7', 'chained list addition');
  // point + list + list chains (Entry Car/Boat: pActLoc + [-17,-11] + [w,0])
  const pt = ev('point(10, 20) + [-17, -11] + [5, 0]') as unknown as { locH: number; locV: number };
  assert.equal(`${pt.locH},${pt.locV}`, '-2,9');
});

test('integer(spriteRef) coerces to the channel (Visualizer Part Wrapper setSprite)', () => {
  // 0079 setSprite: `pSprite = sprite(integer(tSpr))` where tSpr is the sprite
  // ref from createWrapper's `sprite(reserveSprite(...))`. DirPlayer to_number
  // parity: sprite refs -> channel, member refs -> member number. Before this,
  // integer() returned 0 and the wrapper wrote member/ink/bgColor to channel 0
  // (setSpriteProp early-returns there) — private-room walls/floors never
  // rendered. Direct sprite(5).spriteNum is 5 already; the regression is the
  // REF flowing through integer() in a setter context.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('integer(sprite(5))'), 5);
  assert.equal(ev('integer(sprite(150))'), 150);
  assert.equal((ev('ilk(sprite(5))') as LSymbol).name, 'sprite');
  assert.equal(ev('sprite(5).spriteNum'), 5);
});

test('chars(str, from, to) returns the 1-based inclusive substring (FUSE helper)', () => {
  // Defined nowhere in the exported scripts but used by CastLoad/HttpCookie/
  // Connection/Variable Container (e.g. stripping "#" or extensions).
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('chars("hello", 2, 4)'), 'ell');
  assert.equal(e.interp.evalExpressionString('chars("hello", 1, 1)'), 'h');
  assert.equal(e.interp.evalExpressionString('chars("hello", 4, 99)'), 'lo');
  assert.equal(e.interp.evalExpressionString('chars("hello", 3)'), 'llo');
});

test('getStreamStatus reports bytes>0 once a local download completes', async () => {
  // The Download Instance only imports when tStreamStatus[#bytesSoFar] > 0;
  // local preloads carry no text, so a completed download must report >= 1.
  const e = new DirectorEngine();
  e.addScriptMember('Loop', 'score', 'on exitFrame me\nend\n');
  e.boot();
  const id = e.preloadNetThing('hh_interface.cct');
  assert.equal((e.getStreamStatus(id) as LPropList).props.get('bytesSoFar'), 0);
  // With no bundle loader the preload is synthetic: bytesSoFar ramps 0->100
  // over NET_RAMP_FRAMES (the Loading Bar fill), then the request completes.
  for (let i = 0; i < 40; i++) e.tick();
  // The async bundle-finish microtask completes after the synchronous tick
  // loop; flush it, then the download is done.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.netDone(id), 1);
  const st = e.getStreamStatus(id) as LPropList;
  assert.equal(st.props.get('bytesSoFar'), 100);
  assert.equal(st.props.get('bytesTotal'), 100);
  // The CastLoad Instance gates on `tStreamStatus.error`; a missing key reads
  // VOID and every cast download flips to #error (infinite retry loop).
  assert.equal(st.props.get('error'), 'OK');
});

test('preloadNetThing resolves sub-cast bundles through the preload URL directory (hof_furni)', async () => {
  // The corpus preloads furniture casts by CDN URL — the CastLoad Manager
  // builds `moviePath & casts/hof_furni/hh_furni_xx_x.cct & ?randp...`. The
  // bundle is a NESTED spark (casts/hof_furni/<name>.spark), so the fetch
  // must honor the hint URL's directory instead of the flat movie dir, and
  // the randp query must not leak into the fetched URL.
  const furnace = makeCastZip('hh_furni_xx_furnace', [], {
    '0001_script_A.ls': '-- Cast member: A\n-- Type: Movie Script\non a\n  return 1\nend\n',
  });
  const requested: { name: string; hint: string | undefined }[] = [];
  const source: BundleSource = {
    async fetchBundle(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string) {
      requested.push({ name, hint: urlHint });
      // Only the NESTED location exists — a flat lookup must come back empty.
      if (name !== 'hh_furni_xx_furnace') return null;
      onProgress?.(furnace.length, furnace.length); // real fetch reports bytes
      return furnace;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  e.bundleLoader = loader;
  e.boot(); // tick() early-returns before boot; the corpus ticks the loading frame
  const id = e.preloadNetThing('http://localhost:5173/casts/hof_furni/hh_furni_xx_furnace.cct?randp728=1&randp801=1');
  assert.ok(id > 0);
  await new Promise((r) => setTimeout(r, 0)); // let the async load settle
  e.tick();
  assert.equal(e.netDone(id), 1, 'sub-cast preload completes');
  assert.equal(e.netError(id), 'OK');
  // Preload fetches into the loader cache; the corpus's import step
  // (DoneCurrentDownLoad -> setImportedCast -> importFileInto) registers it
  // into the engine's castLib shells.
  assert.ok(loader.getCast('hh_furni_xx_furnace'), 'nested bundle fetched into the loader');
  assert.equal(requested[0]?.name, 'hh_furni_xx_furnace', 'cast name extracted from the CDN URL');
  assert.ok(requested[0]?.hint?.includes('hof_furni'), 'preload URL passed through as the fetch hint');
  assert.equal(e.importFileInto(null, 'http://x/casts/hof_furni/hh_furni_xx_furnace.cct?randp1=1'), 1);
  assert.equal(e.castByName.get('hh_furni_xx_furnace')?.loaded, true, 'nested bundle registered on import');
});

test('preloadNetThing surfaces a missing bundle as an error instead of a silent success', async () => {
  // fetchBundle swallows per-candidate misses and resolves null; the preload
  // must not complete as if the download worked — the corpus gates its import
  // on the request error, so a missing cast should log net: error and flip
  // the request to the #error path.
  const source: BundleSource = {
    async fetchBundle(): Promise<Uint8Array | null> {
      return null; // every candidate 404s
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  e.bundleLoader = loader;
  e.boot(); // tick() early-returns before boot; the corpus ticks the loading frame
  const id = e.preloadNetThing('http://x/casts/hof_furni/hh_furni_xx_missing.cct?randp1=1');
  await new Promise((r) => setTimeout(r, 0));
  e.tick();
  assert.equal(e.netDone(id), 1, 'failed preload terminates (no infinite loading screen)');
  assert.ok(e.netError(id) !== 'OK', 'error recorded');
  assert.ok(e.logs.some((l) => l.startsWith('net: error #')), 'net: error logged');
});

test('importFileInto registers a cast bundle into its castLib shell', async () => {
  const main = makeCastZip('hh_main', [], {
    '0001_script_A.ls': '-- Cast member: A\n-- Type: Movie Script\non a\n  return 1\nend\n',
  });
  const second = makeCastZip('hh_second', [], {
    '0001_script_B.ls': '-- Cast member: B\n-- Type: Movie Script\non b\n  return 2\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'hh_main' ? main : name === 'hh_second' ? second : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'hh_main');
  assert.equal(e.casts.length, 1);
  // preloadNetThing would have kicked the async bundle load off; simulate it.
  await loader.loadCast('hh_second');
  const rc = e.importFileInto(null, 'http://x/hh_second.cct?randp1=1');
  assert.equal(rc, 1);
  assert.equal(e.casts.length, 2);
  assert.equal(e.castByName.get('hh_second')?.loaded, true);
  assert.ok(e.resolveScript('B'), 'script member registered from the imported cast');
  // Re-importing the same cast is a no-op.
  assert.equal(e.importFileInto(null, 'hh_second.cct'), 1);
  assert.equal(e.casts.length, 2);
});

test('dynamic download fills the corpus-tracked path-named shell; release clears it (no appended leak)', async () => {
  // The CastLoad Manager's setImportedCast renames the target shell to the
  // cast's FILE PATH (`casts/hof_furni/hh_furni_xx_sound_machine.cct`) at
  // download START — before the bundle necessarily resolves, so the rename-time
  // fill (and its bare-name alias) is skipped. importFileInto must then fill
  // THAT shell (basename match) rather than appending an untracked slot: the
  // corpus later releases the shell (rename-to-empty), so an appended slot
  // would leak its members forever and name lookups would keep resolving to
  // stale art ("loaded into a slot but only replaces a few [images]").
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const sm = makeCastZip('hh_furni_xx_sound_machine', [], {
    '0001_script_sound_machine_small.ls': '-- Cast member: sound_machine_small\n-- Type: Movie Script\non a\n  return 1\nend\n',
    '0007_script_sound_machine_sd.ls': '-- Cast member: sound_machine_sd\n-- Type: Movie Script\non b\n  return 2\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_furni_xx_sound_machine' ? sm : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  const shells = e.casts.length; // Internal, fuse_client, bin, empty 1, empty 2
  const shellRef = e.getCastLib(4)!; // empty 1

  // setImportedCast: rename the target shell to the file path, bundle missing.
  e.setCastLibProp(shellRef, 'name', 'casts/hof_furni/hh_furni_xx_sound_machine.cct');
  assert.ok(!e.castByName.get('hh_furni_xx_sound_machine')?.loaded, 'bundle missing at rename -> no alias yet');

  // Download completes -> importFileInto fills the corpus-tracked shell.
  await loader.loadCast('hh_furni_xx_sound_machine');
  assert.equal(e.importFileInto(null, 'http://localhost:5173/casts/hof_furni/hh_furni_xx_sound_machine.cct'), 1);
  assert.equal(e.casts.length, shells, 'no appended slot — members landed in the renamed shell');
  const shell = e.casts[3];
  assert.equal(shell.number, 4);
  assert.equal(shell.members.size, 2);
  assert.equal(e.getMemberByName('sound_machine_small')?.castLibNumber, 4, 'name lookup resolves to the tracked shell');

  // ResetOneDynamicCast: rename back to "empty N" -> members cleared, lookups die.
  e.setCastLibProp(shellRef, 'name', 'empty 1');
  assert.equal(shell.members.size, 0, 'released shell cleared');
  assert.equal(e.getMemberByName('sound_machine_small'), null, 'released cast no longer resolves');

  // Re-import into the freed shell stays consistent.
  e.setCastLibProp(shellRef, 'name', 'casts/hof_furni/hh_furni_xx_sound_machine.cct');
  assert.equal(e.importFileInto(null, 'http://localhost:5173/casts/hof_furni/hh_furni_xx_sound_machine.cct'), 1);
  assert.equal(shell.members.size, 2);
  assert.equal(e.getMemberByName('sound_machine_sd')?.castLibNumber, 4);
});

test('re-import supersedes a stale bare-name holder so lookups resolve to the fresh shell', async () => {
  // A pre-existing leak left a holder named the BARE cast name (an appended
  // import registers by manifest.name). The corpus then re-imports into a
  // DIFFERENT shell via the file-path name; the rename-time purge (exact name
  // match) misses the bare-named holder, so registerCast must supersede it —
  // otherwise name lookups keep hitting the old slot's members.
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const sm = makeCastZip('hh_furni_xx_sound_machine', [], {
    '0001_script_sound_machine_small.ls': '-- Cast member: sound_machine_small\n-- Type: Movie Script\non a\n  return 1\nend\n',
    '0007_script_sound_machine_sd.ls': '-- Cast member: sound_machine_sd\n-- Type: Movie Script\non b\n  return 2\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : name === 'hh_furni_xx_sound_machine' ? sm : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');

  // Leak seed: import into slot 5 with the BARE name (bundle present -> the
  // rename-time fill registers it under manifest.name).
  await loader.loadCast('hh_furni_xx_sound_machine');
  const staleRef = e.getCastLib(5)!;
  e.setCastLibProp(staleRef, 'name', 'hh_furni_xx_sound_machine');
  const stale = e.casts[4];
  assert.equal(stale.members.size, 2);
  assert.equal(e.castByName.get('hh_furni_xx_sound_machine'), stale);

  // Corpus re-import into a DIFFERENT shell via the file-path name.
  const freshRef = e.getCastLib(4)!;
  e.setCastLibProp(freshRef, 'name', 'casts/hof_furni/hh_furni_xx_sound_machine.cct');
  assert.equal(e.importFileInto(null, 'http://localhost:5173/casts/hof_furni/hh_furni_xx_sound_machine.cct'), 1);
  assert.equal(stale.members.size, 0, 'stale bare-name holder superseded/purged');
  assert.equal(stale.loaded, false);
  assert.equal(e.castByName.get('hh_furni_xx_sound_machine'), e.casts[3], 'name resolves to the fresh shell');
  assert.equal(e.getMemberByName('sound_machine_small')?.castLibNumber, 4, 'lookups hit the fresh import');
});

test('decodeGif decodes a minimal GIF89a (palette + LZW + alpha)', () => {
  // 2x1 GIF89a: red then green, 2-entry global color table, no transparency.
  const parts = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x02, 0x00, 0x01, 0x00, // 2x1 logical screen
    0x80, 0x00, 0x00, // GCT flag, 2 entries, bg index 0
    0xff, 0x00, 0x00, 0x00, 0xff, 0x00, // palette: red, green
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, // image descriptor
    0x01, // LZW min code size
    0x01, 0xd2, 0x00, // data sub-block (codes: clear=2, 0, 1, end=3)
    0x3b, // trailer
  ];
  const gif = new Uint8Array(parts);
  const { width, height, rgba } = decodeGif(gif);
  assert.equal(width, 2);
  assert.equal(height, 1);
  assert.deepEqual([...rgba.subarray(0, 4)], [0xff, 0, 0, 0xff], 'pixel 0 = palette entry 0 (red)');
  assert.deepEqual([...rgba.subarray(4, 8)], [0, 0xff, 0, 0xff], 'pixel 1 = palette entry 1 (green)');
});

test('preloadNetThing fetches plain-file (image) URLs raw instead of appending .spark', async () => {
  // The catalogue/badge downloads are .gif images, NOT cast bundles — the URL
  // must be fetched as-is (no .spark), with real byte progress + completion.
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b]);
  const requested: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(gif, { status: 200, headers: { 'content-type': 'image/gif' } });
  };
  try {
    const e = new DirectorEngine();
    e.addScriptMember('Loop', 'score', 'on exitFrame me\nend\n');
    e.boot();
    const id = e.preloadNetThing('http://x/c_images/catalogue/catal_fp_header_en.gif?randp1=1');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(e.netDone(id), 1, 'image download completes');
    assert.equal(e.netError(id), 'OK');
    assert.equal(requested.length, 1);
    assert.equal(requested[0], 'http://x/c_images/catalogue/catal_fp_header_en.gif?randp1=1', 'URL fetched raw, not mangled with .spark');
    const st = e.getStreamStatus(id) as LPropList;
    assert.equal(st.props.get('bytesSoFar'), gif.length, 'real byte count reported');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('importFileInto decodes a downloaded image into the member surface (non-cast URL)', async () => {
  const gif = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x02, 0x00, 0x01, 0x00, // 2x1
    0x80, 0x00, 0x00, // GCT, 2 entries
    0xff, 0x00, 0x00, 0x00, 0xff, 0x00, // red, green
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00,
    0x01, 0x01, 0xd2, 0x00, 0x3b,
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(gif, { status: 200 });
  try {
    const e = new DirectorEngine();
    e.addScriptMember('Loop', 'score', 'on exitFrame me\nend\n');
    e.boot();
    // The Download Manager creates the target member (queueDownload #bitmap).
    const gNum = e.createNamedMember('catal_fp_header_en', 'bitmap', 1);
    const ref = new LMemberRef(gNum & 0xffff, 'catal_fp_header_en', 'bitmap', gNum >> 16, e);
    // Realistic corpus flow: the Download Instance preloadNetThing'd the URL,
    // so the bytes are cached and importFileInto decodes them synchronously.
    const id = e.preloadNetThing('http://x/c_images/catalogue/catal_fp_header_en.gif');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(e.netDone(id), 1, 'image preload completed');
    const rc = e.importFileInto(ref, 'http://x/c_images/catalogue/catal_fp_header_en.gif');
    assert.equal(rc, 1);
    const nameRef = e.getMemberByName('catal_fp_header_en');
    assert.ok(nameRef, 'member exists');
    const member = e.memberFor(nameRef!);
    assert.ok(member, 'member resolves');
    assert.ok(member?.image, 'member carries the decoded image surface');
    assert.equal(member?.image?.width, 2);
    assert.equal(member?.image?.height, 1);
    const rgba = member?.image?.ensure();
    assert.ok(rgba);
    assert.deepEqual([...rgba.subarray(0, 4)], [0xff, 0, 0, 0xff], 'first pixel red');
    assert.deepEqual([...rgba.subarray(4, 8)], [0, 0xff, 0, 0xff], 'second pixel green');
    // A cast URL still registers a cast (no image path regression).
    assert.equal(e.importFileInto(null, 'hh_second.cct'), 0, 'no bundle for hh_second -> 0 (cast path intact)');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('delete command removes string chunks (replaceChunks termination)', () => {
  // Regression: `delete (tS).char[1..n]` was unimplemented, so FUSE's
  // replaceChunks `repeat while tString contains tChunkA` never shrank its
  // input and hit the 2M-iteration loop guard (a 6s stall on the texts dump).
  const e = new DirectorEngine();
  e.addScriptMember(
    'DelT',
    'movie',
    [
      'on run me',
      '  tS = "a<BR>b<BR>c"',
      '  repeat while tS contains "<BR>"',
      '    tPos = offset("<BR>", tS) - 1',
      '    delete (tS).char[1..tPos + length("<BR>")]',
      '  end repeat',
      '  return tS',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('DelT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'c');
});

test('delete char N of / char A to B of forms (negative index clamps)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'DelT2',
    'movie',
    [
      'on run me',
      '  tA = "hello world"',
      '  delete char 1 to 5 of tA',
      '  tB = "hello"',
      '  delete char -1 of tB',
      '  return tA & "/" & tB',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('DelT2')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), ' world/hell');
});

test('negative char chunk indexes count from the end; -30000 sentinel = LAST chunk; other out-of-range-low is EMPTY (navigator)', () => {
  // The navigator room list does `delete char -30003 of tNameTxt` (its idiom
  // for dropping the trailing RETURN). DirPlayer vm_range_to_host: the
  // Director compiler encodes "the last element" as chunk index <= -30000
  // (`delete the last char of t` compiles to `delete char -30000 of t`), so
  // -30003 deletes the LAST char — keeping the W and dropping the RETURN.
  // Other out-of-range-low indexes (e.g. -1 on a 1-char string) stay EMPTY /
  // no-op; the old clamp to char 1 ate the first letter ("Welcome Lounge"
  // lost its W).
  const e = new DirectorEngine();
  e.addScriptMember(
    'DelNeg',
    'movie',
    [
      'on run me',
      '  tA = "Welcome Lounge" & RETURN',
      '  delete char -30003 of tA',
      '  tAfterDel = tA',
      '  tRead = char -30003 of "abc"',
      '  tLast = char -1 of "abc"',
      '  tLast2 = char -2 of "abc"',
      '  tRange = char 1 to -1 of "abc"',
      '  tDeleteLast = "abcd"',
      '  delete char -1 of tDeleteLast',
      '  return tAfterDel & "|" & string(tRead) & "|" & tLast & "|" & tLast2 & "|" & tRange & "|" & tDeleteLast',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('DelNeg')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // -30003 strips the trailing RETURN (W survives); char -30003 reads the
  // last char (sentinel). char -1/-2 read from the end; char 1 to -1 spans
  // the whole string; delete char -1 drops the last char.
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'Welcome Lounge|c|c|b|abc|abc');
});

test('cssFontFor maps the writers\' Courier to Volter 700 (purse bold balance)', () => {
  // struct.font.plain/bold in System Props both use #font "Courier" — the
  // messenger console, dialog bodies and the purse balance all render through
  // writers with member.font "Courier". The cast ships no Courier data, so it
  // maps onto Volter; the synthetic-stroke 700 face reads like the chunky
  // Courier PFR the original rasterized (the purse balance looks bold).
  assert.deepEqual(cssFontFor('Courier'), { family: 'Volter', weight: '700' });
  assert.deepEqual(cssFontFor('V'), { family: 'Volter', weight: '400' });
  assert.deepEqual(cssFontFor('VB'), { family: 'Volter', weight: '700' });
  assert.deepEqual(cssFontFor('Arial'), { family: 'Arial', weight: '400' });
});

test('rasterizeTextMember: boxType-unset Writer members are content-tight (purse balance)', () => {
  // The purse checkSaldo renders through a Writer whose scratch member
  // (`createMember("writer_" & getUniqueID(), #text)`) never gets boxType —
  // every other runtime text creator (Text Wrapper, Field Wrapper, Common
  // Button, balloons, tooltips) sets it explicitly. LibreShockwave renders
  // boxType-0 (adjust) text CONTENT-TIGHT (renderTextMemberImage: width =
  // max(rectW, measured), height = 0 -> content lines), so `the image of`
  // the writer member is ~50x27 for "430" — NOT the auto-size rect height
  // (480 from pDefRect) — and checkSaldo's centering
  // `tY1 = (tHeight - tPageImg.height) / 2` lands the glyphs inside the
  // 60x21 purse_amount box instead of ~230px below it (the balance was
  // invisible).
  const { document } = globalThis as { document?: unknown };
  const ctxMock = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText: (s: string) => ({ width: s.length * 8 }),
    fillRect: () => undefined, fillText: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    const m = new Member(1, 1, 'writer_1', 'text');
    m.text = '430';
    m.font = 'Courier';
    m.fontStyle = new LList([new LSymbol('plain')]);
    m.fontSize = 18;
    m.fixedLineSpace = 21;
    m.textProps = new Map<string, LVal>([['topspacing', 3], ['bgcolor', new LColor(110, 110, 110)]]);
    m.rect = new LRect(0, 0, 50, 480); // Writer render auto-size rect (pDefRect height)
    m.color = new LColor(0, 0, 0);

    const tight = rasterizeTextMember(m);
    assert.ok(tight);
    // Content-tight: width stays >= the rect 50. Height follows the
    // LibreShockwave line-box model: the first line box starts at
    // topSpacing + 1 = 4 and holds 1 line of (fixedLineSpace 21 + topSpacing
    // 3) = 24, so the box is 28 (the glyph cell overhang leaves the
    // first-line box 4 + 24 = 28 — not 480).
    assert.equal(tight.width, 50);
    assert.equal(tight.height, 28);

    // An element text member with boxType SET keeps the rect box (the
    // corpus's Text Wrapper sets #adjust explicitly; the window display path
    // uses the rect-sized box with alignment — unchanged).
    m.textProps.set('boxtype', new LSymbol('adjust'));
    const boxed = rasterizeTextMember(m);
    assert.ok(boxed);
    assert.equal(boxed.height, 480);

    // Empty text on a Writer member still sizes from the rect.
    m.textProps.delete('boxtype');
    m.text = '';
    const empty = rasterizeTextMember(m);
    assert.ok(empty);
    assert.equal(empty.height, 480);
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('rasterizeTextMember: fixed-line members bottom-sit glyphs in the line box (U143 dropdown text)', () => {
  // The DropDown class sets tTextMember.fixedLineSpace = pLineHeight (the
  // window-def row height, e.g. 18) with NO topSpacing. Em-box centering
  // ((lineH - fontSize) / 2) rode the glyphs high in the bar; LibreShockwave
  // renderWithBitmapFont bottom-sits each line's glyph cell — the extra line
  // height (lineH - fontLineHeight) goes ABOVE the glyphs. Volter 9px
  // measures fontBoundingBox ascent 8 + descent 2 = 10, so the glyphs start
  // at 18 - 10 = 8 (not 5) and the content box is exactly one 18px line (not
  // 23) — pasted at marginTop -2 the glyphs sit centered in the 20px bar.
  const { document } = globalThis as { document?: unknown };
  const draws: Array<[string, number, number]> = [];
  const ctxMock = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText: () => ({ width: 40, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
    fillRect: () => undefined,
    fillText: (t: string, x: number, y: number) => { draws.push([t, x, y]); },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    const m = new Member(1, 1, 'dropdown.button.text', 'text');
    m.text = 'Say';
    m.font = 'Volter';
    m.fontSize = 9;
    m.fixedLineSpace = 18;
    m.color = new LColor(0, 0, 0);
    m.rect = new LRect(0, 0, 80, 20);
    const img = rasterizeTextMember(m);
    assert.ok(img);
    assert.equal(img!.width, 80, 'rect width box');
    // LSW bottom-sit: glyphs start at fixedLineSpace 18 - fontLH 10 = 8.
    assert.equal(draws[0][2], 8, `first line glyph top = 8 (bottom-sit), got ${draws[0][2]}`);
    // Content height: one 18px line (the glyphs 8..18 fit inside it).
    assert.equal(img!.height, 18, `content height = 18 (one line), got ${img!.height}`);
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('rasterizeTextMember: wordWrap soft-wraps FIXED boxes to the rect width', () => {
  // The hc_status window fields (and the room_loader queue text) are
  // #boxType: #fixed with #wordWrap: 1. The old code only soft-wrapped
  // inside the autoSize (boxType-unset) branch, so fixed boxes drew one
  // long unbroken line — "wordwrap does nothing". Director wraps to the box
  // edge regardless of boxType.
  const { document } = globalThis as { document?: unknown };
  const draws: Array<[string, number, number]> = [];
  const ctxMock = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText: (s: string) => ({ width: s.length * 8 }),
    fillRect: () => undefined,
    fillText: (t: string, x: number, y: number) => { draws.push([t, x, y]); },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    const m = new Member(1, 1, 'hc_status_text', 'text');
    m.text = 'one two three four five six seven';
    m.font = 'Courier';
    m.fontSize = 9;
    m.fixedLineSpace = 11;
    m.color = new LColor(0, 0, 0);
    m.wordWrap = 1;
    m.textProps = new Map<string, LVal>([['boxtype', new LSymbol('fixed')]]);
    m.rect = new LRect(0, 0, 50, 76); // narrow fixed box

    const img = rasterizeTextMember(m);
    assert.ok(img);
    // Fixed box keeps the rect height (extra lines clip like a scroll field).
    assert.equal(img.height, 76);
    // 8px/char: "one" (24) fits, "one two" (56) does not -> one word per
    // line, seven lines, each drawn at its own baseline step.
    assert.equal(draws.length, 7);
    // wrapLines keeps the trailing separator on the pushed line.
    assert.equal(draws[0][0].trimEnd(), 'one');
    // Each line lands on its own baseline, stepping by the line height.
    const ys = draws.map(([, , y]) => y);
    assert.equal(new Set(ys).size, 7);
    assert.equal(ys[1] - ys[0], ys[2] - ys[1]);
    // Without wordWrap the whole string stays on one line.
    draws.length = 0;
    m.wordWrap = 0;
    rasterizeTextMember(m);
    assert.equal(draws.length, 1);
    assert.equal(draws[0][0], 'one two three four five six seven');
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('hardenTextAlpha snaps no-bg AA fringes to transparent or the exact glyph color', () => {
  // The messenger console messages render #EEEEEE text with no #bgColor and
  // paste ink-36 over the console art: the canvas AA fringe (partial alpha)
  // survives the white key as a light halo. Hardening gives Director\'s 1-bit
  // look — fringe below half alpha goes transparent, the rest snaps opaque.
  const rgba = new Uint8Array([
    238, 238, 238, 255, // glyph core
    238, 238, 238, 100, // fringe -> transparent
    238, 238, 238, 30,  // fringe -> transparent
    0, 0, 0, 0,         // already transparent
  ]);
  hardenTextAlpha(rgba, 0xeeeeee);
  assert.deepEqual([...rgba], [238, 238, 238, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('defringeTextPixels snaps near-endpoint fringes to the EXACT colors so the ink key removes them', () => {
  // The messenger Messages/Requests links are #model: #image fields whose
  // Layout Parser defaults #bgColor to white; the 9px EEEEEE text rasterizes
  // over the white box and pastes ink-36, which keys EXACT white only. Canvas
  // AA leaves near-white pixels (253,253,253...) that the exact key misses
  // and the old "within 6, leave untouched" rule preserved — a light rim
  // around the glyphs. Every fringe pixel must resolve to exact bg (keyed
  // away) or exact glyph (kept) — Director's 1-bit field look.
  const rgba = new Uint8Array([
    255, 255, 255, 255, // pure bg -> stays exact bg (ink key removes it)
    253, 253, 253, 255, // near-bg AA -> snaps to exact bg
    248, 248, 248, 255, // mid, nearer bg -> transparent
    243, 243, 243, 255, // mid, nearer glyph -> exact glyph
    239, 239, 239, 255, // near-glyph AA -> snaps to exact glyph
    238, 238, 238, 255, // pure glyph -> stays exact glyph
  ]);
  defringeTextPixels(rgba, 6, 1, 0xeeeeee, 0xffffff);
  assert.deepEqual(
    [...rgba],
    [
      255, 255, 255, 255, // bg
      255, 255, 255, 255, // snapped to bg
      0, 0, 0, 0, // transparent
      238, 238, 238, 255, // snapped to glyph
      238, 238, 238, 255, // snapped to glyph
      238, 238, 238, 255, // glyph
    ],
  );
});

test('a newline ends a statement even when the next line starts with (', () => {
  // Regression: `cursor(0)` + `(the stage).title = ...` used to merge into
  // `cursor(0)(the stage).title`, warning on a non-method callee + VOID target.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Sep',
    'movie',
    [
      'on run me',
      '  cursor(0)',
      '  (the stage).title = "T"',
      '  return (the stage).width',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Sep')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 720);
});

test('sprite ilk/spritenum read back (FUSE hideLogo/releaseSprite)', () => {
  const e = new DirectorEngine();
  const s = e.getSprite(1);
  const ilk = e.getSpriteProp(s, 'ilk');
  assert.ok(ilk instanceof LSymbol);
  assert.equal((ilk as LSymbol).name, 'sprite');
  assert.equal(e.getSpriteProp(s, 'spriteNum'), 1);
});

test('member.erase() removes the member from its castLib', () => {
  const e = new DirectorEngine();
  const m = e.addScriptMember('Temp', 'movie', '-- empty\n');
  const ref = e.getMember(m.number, m.castLibNumber)!;
  assert.ok(ref);
  e.memberMethod(ref, 'erase', []);
  assert.equal(e.getMember(m.number, m.castLibNumber), null);
});

test('exitFrame with no go lets the playhead advance (script never re-fires)', () => {
  // Director: an exitFrame that issues no `go` advances the playhead, so the
  // frame script fires exactly once. Init's startClient path depends on this
  // to avoid re-running resetCastLibs on every completed download.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Init',
    'score',
    ['on exitFrame me', '  global gFires', '  gFires = gFires + 1', 'end'].join('\n'),
  );
  e.boot();
  e.tick();
  e.tick();
  assert.equal(e.globals.get('gfires'), 1);
});

test('exitFrame with go(the frame) pins the playhead (script re-fires each tick)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Loop',
    'score',
    ['on exitFrame me', '  global gFires', '  gFires = gFires + 1', '  go(the frame)', 'end'].join('\n'),
  );
  e.boot();
  e.tick();
  e.tick();
  assert.equal(e.globals.get('gfires'), 2);
});

test('the <prop> of <object> reads an instance property (Manager Template exists)', () => {
  // `the pItemList of me.getOne(tid)` parses as `(the pItemList of me).getOne(tid)`
  // and `the count of the pItemList of me` nests — both need object property reads.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Mgr',
    'parent',
    [
      'property pItemList',
      'on run me',
      '  pItemList = [#a: 1, #b: 2]',
      '  t1 = the pItemList of me',
      '  t2 = the count of the pItemList of me',
      '  t3 = t1.getOne(2)',
      '  t4 = t1.findPos(#b)',
      '  t5 = the pItemList of me.getOne(2)',
      '  return t2 & "," & t3 & "," & t4 & "," & (t5 > 0)',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Mgr')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const inst = e.interp.makeInstance(script);
  assert.equal(e.interp.callHandler(script, run, [], inst, new Set()), '2,b,2,1');
});

test('window-title #txtColor/#txtBgColor fall back to #color/#bgColor when absent (U83)', () => {
  // All window title elements (habbo_basic window_title #EEEEEE on #6794A7,
  // messenger #996600 on #FFCB00, purse_header #663300 on #FFCA42) author
  // their text colors as #color/#bgColor; the corpus Layout Parser only maps
  // those to #txtColor/#txtBgColor for old version-less defs, so the Text
  // Wrapper's `pProps[#txtColor/#txtBgColor]` read misses and headers render
  // black on the font-struct default. An ABSENT #txtColor/#txtBgColor read
  // must fall back to the authored #color/#bgColor (read-only; no key
  // created). Elements without explicit colors are unaffected — the parser
  // defaults every element's #color/#bgColor before this read.
  const e = new DirectorEngine();
  e.addScriptMember(
    'PL',
    'movie',
    ['on run',
     '  t = [#color: rgb(238,238,238), #bgColor: rgb(103,148,167)]',
     '  t2 = [#txtColor: rgb(1,2,3), #color: rgb(238,238,238)]',
     '  t3 = [#x: 1]',
     '  return t[#txtColor].red & "/" & t[#txtColor].green & "/" & t[#txtColor].blue & "/" & t[#txtBgColor].red & "/" & t2[#txtColor].red & "/" & voidp(t3[#txtColor])',
     'end'].join('\n'),
  );
  const script = e.resolveScript('PL')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '238/238/238/103/1/1');
});

test('proplist getOne returns the key (raw) and 0 when missing; findPos returns key position', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'PL',
    'movie',
    ['on run', '  t = [#a: 10, #b: 12, #c: 15]', '  return t.getOne(12) & "/" & t.findPos(#c) & "/" & t.getOne(99) & "/" & voidp(t.findPos(#z))', 'end'].join('\n'),
  );
  const script = e.resolveScript('PL')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'b/3/0/1');
});

test('proplist getPos matches the VALUE 1-based and getPropAt returns the key (String Services convertSpecialChars reverse)', () => {
  // FUSE String Services 0036: pConvList maps chars -> replacements; the
  // reverse direction does `tPos = pConvList.getPos(tChar); ...
  // pConvList.getPropAt(tPos)` — DirPlayer getPos finds the pair whose VALUE
  // equals tChar, getPropAt returns the KEY at that position. Before U78 the
  // warn 'propList method getPos not implemented' fired on every figure-creator
  // page leave (getMyDataFromFields -> convertSpecialChars).
  const e = new DirectorEngine();
  e.addScriptMember(
    'Conv',
    'movie',
    [
      'on run',
      '  t = [#a: "x", #b: "y", #c: "z"]',
      '  p = t.getPos("y")',
      '  k = t.getPropAt(p)',
      '  return p & "/" & k & "/" & t.getPos("nope") & "/" & t.getPos("x")',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Conv')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '2/b/0/1');
});

test('bare chunk with nested the-number-of bound (Resource Manager readAliasIndexes)', () => {
  // `item 2 to the number of items in tLine of tLine` — the `to` bound is a
  // nested `the number of <chunk> in <subject>`, and the trailing `of tLine`
  // is the OUTER chunk's subject. Regression for 696 warnings in
  // preIndexMembers (items/in/of leaked as bare identifiers).
  const e = new DirectorEngine();
  e.addScriptMember(
    'Alias',
    'movie',
    ['on run', '  tLine = "a,b,c"', '  tName = item 2 to the number of items in tLine of tLine', '  return tName', 'end'].join('\n'),
  );
  const script = e.resolveScript('Alias')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'b,c');
});

test('string .ilk returns #string (CastLoad removeCastLoadInstance gate)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Ilk',
    'movie',
    ['on run', '  t = "hh_interface"', '  if t.ilk <> #string then return 0', '  return 1', 'end'].join('\n'),
  );
  const script = e.resolveScript('Ilk')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 1);
});

test('Lingo mixed string/number comparison coerces the number to a string ("abc" > 0)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Cmp',
    'movie',
    ['on run', '  tA = "core" > 0', '  tB = "b" > "a"', '  tC = "5" > 3', '  tD = "3" > 5', '  tE = VOID > 0', '  tF = VOID < 1', '  return tA & tB & tC & tD & tE & tF', 'end'].join('\n'),
  );
  const script = e.resolveScript('Cmp')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '111001');
});

test('VOID = 0 is true and VOID <> 0 is false (showHotel getSprById loop)', () => {
  // Entry Interface showHotel: `tSpr = tVisObj.getSprById(tAnimationType[1] & j)`
  // then `if tSpr <> 0 then ... else exit repeat`. getSprById returns a proplist
  // miss (VOID) once the id runs out — Director coerces VOID to 0 in numeric
  // equality (LibreShockwave lingoEquals), so `VOID <> 0` is FALSE and the
  // repeat-while-1 loop exits. Our lingoEquals compared null === 0 -> false, so
  // `<>` stayed true and the loop spun 2M iterations creating objects forever.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Spr',
    'movie',
    [
      'on run',
      '  tSprById = [#a: 1]',
      '  tEq0 = ((void) = 0)',
      '  tNe0 = ((void) <> 0)',
      '  tEq5 = ((void) = 5)',
      '  tNe5 = ((void) <> 5)',
      '  tEqS = ((void) = "")',
      '  tZero = (0 = (void))',
      '  j = 0',
      '  repeat while 1',
      '    tSpr = tSprById["bicycleN" & j]',
      '    if tSpr <> 0 then',
      '      return -1',
      '    else',
      '      exit repeat',
      '    end if',
      '    j = j + 1',
      '  end repeat',
      '  return tEq0 & tNe0 & tEq5 & tNe5 & tEqS & tZero & "/" & j',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Spr')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // void=0 true, void<>0 false, void=5 false, void<>5 true, void="" false,
  // 0=void true, loop exited on the first miss.
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '100101/0');
});

test('list equality is DEEP: distinct equal lists compare equal (FUSE receipt check)', () => {
  // Friend List / Instant Messenger / Figure System checkDataLoaded compute
  // tReceipt locally and compare `tReceipt <> getSpecialServices().getReceipt
  // (tStamp)` — two INDEPENDENTLY-built lists. Director compares lists and
  // proplists by VALUE; our reference-identity compare made every receipt
  // check fail ("Invalid build structure" x3, figurepartlist.loaded never
  // set, Friend List/IM containers never built).
  const e = new DirectorEngine();
  e.addScriptMember(
    'LstEq',
    'movie',
    [
      'on run',
      '  a = []',
      '  b = []',
      '  repeat with i = 1 to 3',
      '    a[i] = i * 10',
      '    b[i] = i * 10',
      '  end repeat',
      '  tEq = (a = b)',
      '  tNe = (a <> b)',
      '  tRef = (a = a)',
      '  c = [1, 2, 3]',
      '  tLit = (c = [1, 2, 3])',
      '  p = [#a: 1, #b: 2]',
      '  tProp = (p = [#a: 1, #b: 2])',
      '  return tEq & tNe & tRef & tLit & tProp',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('LstEq')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // tEq=1 (equal), tNe=0 (not unequal), tRef=1 (same ref), tLit=1 (literal
  // list equal by value), tProp=1 (proplist equal by value).
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '10111');
});

test('the xtraList + the environment + bare date()/time() (Connection checkForXtra path)', () => {
  // Connection Instance connect(): `if not checkForXtra("Multiusr") then
  // return fatalError(["error": "mus_xtra_not_found"])` — checkForXtra reads
  // `the xtraList` and contains-matches each entry's #name/#fileName against
  // the arg. The real Multiuser Xtra ships as the 8.3 file "Multiusr.x32",
  // so the xtraList entry must carry a fileName that contains "Multiusr" or
  // the client bails to the client_error page before ever connecting.
  // handleFatalError then reads `the environment` (#productVersion /
  // #productBuildVersion / #osVersion) and builds its report header with the
  // bare `date() && time()` calls.
  const e = new DirectorEngine();
  e.addScriptMember(
    'XtraProbe',
    'movie',
    [
      'on run',
      '  tList = the xtraList',
      '  tFound = 0',
      '  repeat with tXtra in tList',
      '    if tXtra[#name] contains "Multiusr" then tFound = 1',
      '    if tXtra[#fileName] contains "Multiusr" then tFound = 1',
      '  end repeat',
      '  tEnv = the environment',
      '  tV = string(tEnv[#productVersion])',
      '  tB = string(tEnv[#productBuildVersion])',
      '  tO = string(tEnv[#osVersion])',
      '  tD = stringp(date())',
      '  tT = stringp(time())',
      '  return tFound & "/" & (length(tV) > 0) & (length(tB) > 0) & (length(tO) > 0) & tD & tT',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('XtraProbe')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '1/11111');
  assert.ok(!e.logs.some((l) => /xtraList|environment|unresolved handler\/builtin: (date|time)/.test(l)), 'no xtraList/environment/date-time warns');
});

test('rgb()/color() return #color objects; ilk(x, #color) gates pass', () => {
  // Loading Bar define() gates `ilk(tProps[#bgColor], #color)` — rgb() used
  // to return a plain list (ilk #list), so every gate silently failed.
  const e = new DirectorEngine();
  e.addScriptMember(
    'RGB',
    'movie',
    [
      'on run',
      '  tC = rgb(128, 64, 32)',
      '  tH = rgb("#FFFFFF")',
      '  tN = color(1193046)', // 0x123456 — Lingo has no hex literals
      '  tI = string(ilk(tC))',
      '  tG = ilk(tC, #color) & ilk(tH, #color) & ilk(tN, #color)',
      '  tEq = (tC = rgb(128, 64, 32))',
      '  return tI & ":" & tG & ":" & tC.red & "," & tC.green & "," & tC.blue & ":" & tEq',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('RGB')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // string(#color) drops the # (C++ toStringLikeJava / DirPlayer string.rs:
  // symbols stringify to their bare name).
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'color:111:128,64,32:1');
});

test('image fill/draw/setPixel/crop paint real RGBA and read back size/rect/ilk', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'Img',
    'movie',
    [
      'on run',
      '  tI = image(10, 10)',
      '  tI.fill(tI.rect, rgb(255, 0, 0))',
      '  tI.draw(rect(0, 0, 5, 5), [#shapeType: #rect, #color: rgb(0, 0, 255), #lineSize: 1])',
      '  tI.setPixel(9, 9, rgb(0, 255, 0))',
      '  tC = tI.crop(rect(0, 0, 2, 2))',
      '  tL = tI.rect.right',
      '  tF = tI.fill(rect(0, 0, 3, 3), rgb(1, 2, 3)).fill(rect(0, 0, 1, 1), rgb(9, 9, 9))',
      '  return tI.width & "," & tI.height & "," & tL & "," & tC.width & "," & tC.height & "," & ilk(tI, #image) & "," & ilk(tF, #image)',
      'end',
    ].join('\n'),
  );  const script = e.resolveScript('Img')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '10,10,10,2,2,1,1');
});

test('image(w,h,depth,paletteRef) 4-arg + the depth/rect/paletteRef of image (window buffers)', () => {
  // Window Instance buildVisual creates 8-bit buffers with a palette member
  // (`image(w,h,8,tPalette)`); Unique Element reads `the depth of`, Image
  // Wrapper clearBuffer (Purse) reads `the rect of the pimage of me`, and
  // define assigns/compares `pimage.paletteRef`. All must resolve (was:
  // 'the depth of ...: unsupported [pimage]' / 'the rect of ...: unsupported
  // [the(arg)]').
  const e = new DirectorEngine();
  e.addScriptMember('Pal', 'parent', 'on new me\nend\n');
  e.addScriptMember(
    'Img4',
    'movie',
    [
      'on run',
      '  t = image(48, 49, 8, member(1))',
      '  tD = the depth of t',
      '  tR = the rect of t',
      '  tPr = the paletteRef of t',
      '  t.paletteRef = member(1)',
      '  tP2 = the paletteRef of t',
      '  tS = image(4, 5)',
      '  tD2 = the depth of tS',
      '  tS2 = image(7, 9)',
      '  tW = tS2.rect.width',
      '  return tD & "," & tR.width & "," & tR.height & "," & memberp(tPr) & "," & memberp(tP2) & "," & tD2 & "," & tW',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Img4')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '8,48,49,1,1,32,7');
  assert.ok(!e.logs.some((l) => l.includes('unsupported')), 'no the-depth/rect-of-image warns');
});

test('image() fill: 8-bit fills palette index 0, 32-bit stays transparent (U123 wall flood)', () => {
  // U122 made fresh 8-bit group buffers (info_stand) start opaque white
  // (palette index 0). That fill must NOT extend to 16/32-bit canvases: the
  // room wall/floor wrapper composites parts into a STAGE-SIZED 32-bit
  // `image(tStageWidth, tStageHeight, 32)` whose uncovered area has to stay
  // transparent, or the wrapper sprite's ink-41 wall-color tint turns the
  // white into a wall-color rectangle flooding the whole stage.
  const e = new DirectorEngine();
  const pal = e.addScriptMember('PalFill', 'parent', 'on new me\nend\n');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[0] = [17, 17, 17]; // non-white index 0 so the 8-bit fill is distinguishable
  pal.palette = table;
  e.addScriptMember(
    'ImgFill',
    'movie',
    [
      'on run',
      '  a = image(3, 2, 8, member(1))',
      '  b = image(3, 2, 32)',
      '  c = image(3, 2)',
      '  d = image(3, 2, 8)',
      '  return [a, b, c, d]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('ImgFill')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as LList;
  const [a, b, c, d] = out.items as LImage[];
  const pa = a.ensure();
  assert.deepEqual([pa[0], pa[1], pa[2], pa[3]], [17, 17, 17, 255]); // 8-bit: index-0 fill, opaque
  assert.equal(b.ensure()[3], 0); // 32-bit: transparent (wall wrapper canvas)
  assert.equal(c.ensure()[3], 0); // default depth 32: transparent
  assert.deepEqual([d.ensure()[0], d.ensure()[1], d.ensure()[2], d.ensure()[3]], [255, 255, 255, 255]); // 8-bit no palette: system palette index 0 = white
});

test('image.useAlpha + setAlpha: flat level and 8-bit mask with matte polarity (Writer fakeAlphaRender)', () => {
  // fuse_client Writer Class fakeAlphaRender (0068): builds an 8-bit matte of
  // the text (black glyphs on the white palette-0 fill), composites the color
  // into a 32-bit out, then `tOut.useAlpha = 1` + `tOut.setAlpha(tFakeAlpha)`.
  // LibreShockwave imageSetAlpha: 32-bit only; a level arg sets a flat 0-255
  // alpha; an 8-bit same-sized image arg writes its LUMA into the alpha
  // channel (255-luma when matte polarity: transparent px, or a mostly-white
  // edge + dark interior, or white corners + dark px) and sets useAlpha.
  const e = new DirectorEngine();
  e.addScriptMember(
    'AlphaProbe',
    'movie',
    [
      'on run',
      '  tMask = image(4, 4, 8)', // 8-bit -> opaque WHITE palette-0 fill
      '  tMask.setPixel(1, 1, rgb(0, 0, 0))', // black glyph pixel (interior)
      '  tOut = image(4, 4, 32)',
      '  tU0 = the useAlpha of tOut',
      '  tOut.useAlpha = 1',
      '  tU1 = the useAlpha of tOut',
      '  tR1 = tOut.setAlpha(tMask)', // mask form: white -> 0, black -> 255 (inverted)
      '  tU2 = the useAlpha of tOut',
      '  tOut2 = image(4, 4, 32)',
      '  tR2 = tOut2.setAlpha(200)', // flat level
      '  tU3 = the useAlpha of tOut2',
      '  tBad = image(4, 4, 8)', // 8-bit dest -> FALSE
      '  tR3 = tBad.setAlpha(tMask)',
      '  tBad2 = image(5, 4, 32)', // wrong dims -> FALSE
      '  tR4 = tBad2.setAlpha(tMask)',
      '  return [tU0, tU1, tU2, tU3, tR1, tR2, tR3, tR4, tOut, tOut2]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('AlphaProbe')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as LList;
  const [u0, u1, u2, u3, r1, r2, r3, r4, tOut, tOut2] = out.items;
  assert.equal(u0, 0, 'fresh 32-bit image: useAlpha FALSE');
  assert.equal(u1, 1, 'useAlpha = 1 reads back TRUE');
  assert.equal(u2, 1, 'setAlpha(mask) flips useAlpha on');
  assert.equal(u3, 1, 'setAlpha(level) flips useAlpha on');
  assert.equal(r1, 1, 'mask form returns TRUE');
  assert.equal(r2, 1, 'level form returns TRUE');
  assert.equal(r3, 0, '8-bit destination -> FALSE (not 32-bit)');
  assert.equal(r4, 0, 'wrong-size mask -> FALSE');
  const px = (tOut as LImage).ensure();
  assert.equal(px[3], 0, 'white matte pixel -> alpha 0 (inverted luma)');
  const glyph = (1 * 4 + 1) * 4;
  assert.equal(px[glyph + 3], 255, 'black glyph pixel -> alpha 255');
  const flat = (tOut2 as LImage).ensure();
  assert.equal(flat[3], 200, 'flat level 200');
  assert.equal(flat[7], 200, 'flat level 200 everywhere');
  assert.ok(!e.logs.some((l) => l.includes('useAlpha') || l.includes('setAlpha')), 'no useAlpha/setAlpha warns');
});

test('image.paletteRef remaps 8-bit pixels through the target palette (U67 messenger gold)', () => {
  // The messenger window's chrome is SHARED hh_interface art: teal through its
  // own palette (103,148,167 = the c=(103,148,167) we saw in the messenger
  // pixi buffer log). The layout's `#palette: "interface palette_messenger"`
  // assignment must remap it to gold (197,157,0 = palette index 100). This
  // drives the REAL interpreter path: `member(x).image.paletteRef = "..."`.
  const e = new DirectorEngine();
  const pal = e.addScriptMember('interface_palette_messenger', 'unknown', '');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[100] = [197, 157, 0]; // gold — real messenger palette line 104
  table[101] = [168, 133, 0];
  pal.palette = table;
  const bm = e.addScriptMember('window.top.left', 'unknown', '');
  bm.kind = 'bitmap';
  const src: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  src[100] = [103, 148, 167]; // the teal chrome
  src[50] = [239, 239, 239];
  bm.palette = src;
  const img = new LImage(2, 1);
  const d = img.ensure();
  d[0] = 103; d[1] = 148; d[2] = 167; d[3] = 255; // index 100 -> teal
  d[4] = 239; d[5] = 239; d[6] = 239; d[7] = 255; // index 50 -> light grey
  img.palette = src; // the engine attaches member.palette at decode time
  bm.image = img;
  e.addScriptMember(
    'PalProbe',
    'movie',
    [
      'on run me',
      '  t = member("window.top.left").image',
      '  t.paletteRef = "interface palette_messenger"',
      '  return t',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('PalProbe')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  assert.ok(out instanceof LImage, 'handler returns the remapped image');
  const px = (out as LImage).ensure();
  assert.deepEqual([px[0], px[1], px[2]], [197, 157, 0], 'teal chrome index 100 -> messenger gold');
  assert.deepEqual([px[4], px[5], px[6]], [50, 50, 50], 'index 50 remaps by INDEX: src[50] grey -> target[50] grey-50');
  assert.deepEqual((out as LImage).palette![100], [197, 157, 0], 'palette swapped so matte keys off the new background');
  // resolvePaletteTable: space-form string resolves, #grayscale is the Mac
  // system grey ramp (index 0 = white, like DirPlayer + every .pal sidecar
  // that ships with #grayscale art — the PC index-0-black order inverted
  // button/arrow art through the paletteRef remap), unresolvable names and
  // non-palette values return null.
  assert.deepEqual(e.resolvePaletteTable('interface palette_messenger')![100], [197, 157, 0]);
  const gray = e.resolvePaletteTable(new LSymbol('grayscale'))!;
  assert.deepEqual(gray[0], [255, 255, 255]);
  assert.deepEqual(gray[255], [0, 0, 0]);
  assert.equal(e.resolvePaletteTable('no_such_palette'), null);
  assert.equal(e.resolvePaletteTable(0), null);
});

/** Build a tiny RGBA PNG (8-bit, filter 0) so memberImage's decode path is real. */
function tinyRgbaPng(w: number, h: number, px: number[]): Uint8Array {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      const p = (y * w + x) * 4;
      raw[o] = px[p]; raw[o + 1] = px[p + 1]; raw[o + 2] = px[p + 2]; raw[o + 3] = px[p + 3];
    }
  }
  const ihdr = new Uint8Array(13);
  const ih = new DataView(ihdr.buffer);
  ih.setUint32(0, w); ih.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  return concat(sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0)));
}

test('member.palette = member(<pattern palette>) remaps piece art (U101 wall/floor patterns)', () => {
  // The room's wall/floor pattern pieces are rainbow test-pattern art in the
  // source data. Private Room Engine setWallPaper/setFloorPattern pick the
  // `_3_` piece variant; Visualizer Part Wrapper renderImage then assigns
  // `tPartMem.palette = member(getmemnum(tPalette))` to recolor each piece
  // through the pattern's palette (wall_color_chocolat -> chocolate browns).
  // The member's OWN sidecar .pal is the index source; the pattern palette is
  // the target. Regression: the setter clobbered member.palette with the
  // target and the raw rainbow pixels rendered.
  const e = new DirectorEngine();
  const pat = e.addScriptMember('wall_color_chocolat', 'unknown', '');
  pat.kind = 'palette';
  const patTable: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  patTable[33] = [191, 119, 38]; // chocolate brown (real palette line 34)
  patTable[34] = [152, 95, 31];
  pat.palette = patTable;
  const piece = e.addScriptMember('left_wallpart_3_a_0_0_0', 'unknown', '');
  piece.kind = 'bitmap';
  const src: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  src[33] = [255, 0, 255]; // magenta band
  src[34] = [0, 0, 255]; // blue band
  piece.palette = src; // sidecar .pal attached at cast load
  // 2x1 art: px0 = magenta (index 33), px1 = blue (index 34)
  piece.raw = tinyRgbaPng(2, 1, [255, 0, 255, 255, 0, 0, 255, 255]);
  e.addScriptMember(
    'PatternProbe',
    'movie',
    [
      'on run me',
      '  t = member("left_wallpart_3_a_0_0_0")',
      '  t.palette = member("wall_color_chocolat")',
      '  return t.image',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('PatternProbe')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  assert.ok(out instanceof LImage, 'member.image materialized after palette assignment');
  const px = (out as LImage).ensure();
  assert.deepEqual([px[0], px[1], px[2]], [191, 119, 38], 'magenta band index 33 -> chocolate brown');
  assert.deepEqual([px[4], px[5], px[6]], [152, 95, 31], 'blue band index 34 -> darker brown');
  assert.deepEqual((out as LImage).palette![33], [191, 119, 38], 'palette swapped to the pattern table (matte keys its bg)');
  assert.deepEqual(piece.palette![33], [255, 0, 255], 'member keeps its OWN sidecar palette as the index source');
  // Changing the wallpaper re-palettes the same member: chained remap.
  const pat2 = e.addScriptMember('wall_color_lsd', 'unknown', '');
  pat2.kind = 'palette';
  const lsdTable: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  lsdTable[33] = [120, 200, 40];
  pat2.palette = lsdTable;
  e.addScriptMember(
    'PatternProbe2',
    'movie',
    [
      'on run me',
      '  t = member("left_wallpart_3_a_0_0_0")',
      '  t.palette = member("wall_color_lsd")',
      '  return t.image',
      'end',
    ].join('\n'),
  );
  const script2 = e.resolveScript('PatternProbe2')!;
  const run2 = script2.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out2 = e.interp.callHandler(script2, run2, [], null, new Set());
  const px2 = (out2 as LImage).ensure();
  assert.deepEqual([px2[0], px2[1], px2[2]], [120, 200, 40], 'chained remap: chocolat-brown index 33 -> lsd green');
});

test('member.duplicate(number) copies the palette table and image.duplicate keeps it (U67 bin palette)', () => {
  // The corpus path (Layout Parser 0052:97):
  //   member(tPalMemNum).duplicate(tResMngr.createMember(name, #palette))
  // where Resource Manager createMember RETURNS A NUMBER (tmember.number, a
  // slot). The engine used to require a member REF, so the duplicate no-op'd
  // and the "<name> Duplicate" palette member stayed empty — image.paletteRef
  // remaps then found no table and the messenger chrome stayed teal.
  const e = new DirectorEngine();
  const pal = e.addScriptMember('interface_palette_messenger', 'unknown', '');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[100] = [197, 157, 0];
  pal.palette = table;
  // createMember: new(#palette, castLib(bin)) -> slot number
  const newRef = e.newMember('palette', 3)!;
  const slot = e.getMemberProp(newRef, 'number') as number;
  e.memberMethod(e.getMemberByName('interface_palette_messenger')!, 'duplicate', [slot]);
  assert.deepEqual(e.memberFor(newRef)!.palette![100], [197, 157, 0], 'numeric duplicate target must copy the palette table');
  // image.duplicate() (Unique Element 0057:50 `pimage = tmember.image.duplicate()`)
  // must keep palette + depth + paletteRef or the remap has no source indices.
  const img = new LImage(2, 1);
  img.palette = table;
  img.paletteRef = 'interface palette_messenger Duplicate';
  img.depth = 8;
  const dup = duplicateValue(img) as LImage;
  assert.deepEqual(dup.palette![100], [197, 157, 0]);
  assert.equal(dup.paletteRef, 'interface palette_messenger Duplicate');
  assert.equal(dup.depth, 8);
  // resolvePaletteTable accepts a slot NUMBER too (Director member-number args).
  assert.deepEqual(e.resolvePaletteTable(slot)![100], [197, 157, 0]);
});

test('delete char on a non-string is a silent no-op (Navigator tNodeInfo)', () => {
  // Navigator updateState deletes chars off an unset tNodeInfo: the undeclared
  // identifier reads as VOID (Director non-fatal) and chunk deletion on a
  // non-string is ignored. Both were per-frame warns.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Del',
    'movie',
    ['on run', '  tN = 123', '  delete char 1 to 3 of tN', '  delete char 1 to 2 of tMissing', '  return 1', 'end'].join('\n'),
  );
  const script = e.resolveScript('Del')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 1);
  assert.ok(!e.logs.some((l) => l.includes('chunk only supported')), 'no delete-chunk warn');
  assert.ok(!e.logs.some((l) => l.includes('undefined identifier')), 'no undefined-identifier warn');
});

test('case statements are EXCLUSIVE — no fallthrough (Navigator updateState)', () => {
  // Real Lingo `case` branches are exclusive (the decompiled .ls drops the
  // end-of-branch jumps the original bytecode emits): only the matched
  // branch runs, then execution continues AFTER `end case`. A branch without
  // an explicit return means the trailing code after `end case` runs (e.g.
  // Navigator updateState's benign "Unknown state:" error after its no-
  // return openNavigator branch — a fallthrough would have run enterEntry
  // twice). FUSE's flatAccessResult has an EMPTY success branch followed by
  // the error-UI branch — fallthrough would corrupt it.
  const e = new DirectorEngine();
  e.addScriptMember(
    'CaseT',
    'movie',
    [
      'on run me',
      '  tA = ""',
      '  case "a" of',
      '    "a":',
      '      tA = tA & "A"',
      '    "b":',
      '      tA = tA & "B"',
      '    otherwise:',
      '      tA = tA & "O"',
      '  end case',
      '  tA = tA & "Z"',
      '  tB = ""',
      '  case "b" of',
      '    "a":',
      '      tB = tB & "A"',
      '    "b":',
      '      tB = tB & "B"',
      '    otherwise:',
      '      tB = tB & "O"',
      '  end case',
      '  tB = tB & "Z"',
      '  tC = ""',
      '  case "c" of',
      '    "a":',
      '      tC = tC & "A"',
      '    "b":',
      '      tC = tC & "B"',
      '    otherwise:',
      '      tC = tC & "O"',
      '  end case',
      '  tC = tC & "Z"',
      '  return tA & "/" & tB & "/" & tC',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('CaseT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // "a" matches the first branch, runs ONLY it, then continues after end case
  // -> "AZ". "b" matches "b" -> "BZ". "c" matches none -> otherwise runs
  // -> "OZ". NO fallthrough into the following branches.
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 'AZ/BZ/OZ');
});

test('(the stage).image / .bgColor resolve (Loading Bar pBuffer path)', () => {
  const e = new DirectorEngine();
  const img = e.interp.evalExpressionString('(the stage).image') as { width: number; height: number };
  assert.equal(img.width, 720);
  assert.equal(img.height, 540);
  assert.equal(e.interp.evalExpressionString('(the stage).image.rect.width'), 720);
  const bg = e.interp.evalExpressionString('(the stage).bgColor') as { red: number };
  assert.equal(bg.red, 0x0d, 'default engine bg 0x0d0d18 -> red 0x0d');
  // Painting the stage image must not warn.
  e.interp.evalExpressionString('(the stage).image.fill(rect(10, 10, 30, 30), rgb(255, 255, 255))');
  assert.ok(e.logs.length >= 0);
});

test('(the stage).image READS use the composited scene (FUSE screen camera / photo shot)', () => {
  // The FUSE screen cameraCrop does `(the stage).image.crop(tCropRect)` and
  // the Photo Interface copies `(the stage).image` — Director's stage image IS
  // the displayed scene. Our stageImage() is a Lingo paint surface (the
  // Loading Bar fills it, shown behind the channels), so SOURCE reads must
  // substitute the adapter's renderer readback. Mock a red scene and prove
  // crop + copyPixels see it while the paint surface stays untouched.
  const w = 720;
  const h = 540;
  const redScene = new Uint8Array(w * h * 4);
  for (let i = 0; i < redScene.length; i += 4) {
    redScene[i] = 255;
    redScene[i + 1] = 0;
    redScene[i + 2] = 0;
    redScene[i + 3] = 255;
  }
  let captures = 0;
  const mockAdapter: import('../engine/engine.js').StageAdapter = {
    setBackground: () => {},
    setChannel: () => {},
    refreshChannel: () => {},
    resize: () => {},
    captureStage: () => {
      captures++;
      return redScene;
    },
  };
  const e = new DirectorEngine(mockAdapter);
  // Paint surface stays a Lingo surface (Loading Bar path): paint blue, the
  // readback must still be the red scene.
  e.interp.evalExpressionString('(the stage).image.fill(rect(0, 0, 5, 5), rgb(0, 0, 255))');
  // crop of `(the stage).image` = the composited scene, not the paint.
  const cropped = e.interp.evalExpressionString('(the stage).image.crop(rect(10, 10, 20, 20))') as { data: Uint8Array | null };
  assert.ok(captures >= 1, 'composite must be captured for a stage-image crop');
  assert.equal(cropped.data![0], 255, 'crop pixel red from the composite');
  assert.equal(cropped.data![1], 0);
  // copyPixels with `(the stage).image` as the SOURCE also substitutes.
  e.addScriptMember(
    'CamShot',
    'movie',
    ['on run me', '  tImg = image(10, 10, 24)', '  tImg.copyPixels((the stage).image, rect(0, 0, 10, 10), rect(0, 0, 10, 10))', '  return tImg', 'end'].join('\n'),
  );
  const cs = e.resolveScript('CamShot')!;
  const csRun = cs.handlers.find((hh) => hh.name.toLowerCase() === 'run')!;
  const shot = e.interp.callHandler(cs, csRun, [], null, new Set()) as { data: Uint8Array | null };
  assert.equal(shot.data![0], 255, 'copyPixels src is the red composite');
  assert.equal(shot.data![1], 0);
});

test('member.image is a persistent surface across reads (fill sticks)', () => {
  const e = new DirectorEngine();
  const m = e.addScriptMember('Bmp', 'unknown', '');
  const ref = e.getMember(m.number, m.castLibNumber)!;
  const a = e.getMemberProp(ref, 'image');
  const b = e.getMemberProp(ref, 'image');
  assert.ok(a === b, 'member.image must be the same object across reads');
});

test('runtime bitmap member (no raw) renders via kind:image channel visual', () => {
  // The Loading Bar / window element buffers are bitmap members created in-movie
  // with a painted LImage surface but no raw bytes. notifyChannel must emit a
  // kind:'image' visual so the stage uploads the surface (was setChannel(null)
  // -> the painted bar stayed invisible).
  const calls: { ch: number; kind: string; image?: unknown }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; image?: unknown } | null) {
      calls.push(v ? { ch, kind: v.kind, image: v.image } : { ch, kind: 'null' });
    },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('Bar', 'unknown', '');
  m.kind = 'bitmap'; // runtime-created window element buffer member
  const ref = e.getMember(m.number, m.castLibNumber)!;
  const img = new LImage(2, 3);
  e.setMemberProp(ref, 'image', img);
  const s = { channel: 7, script: null };
  e.setSpriteProp(s, 'member', (m.castLibNumber << 16) | m.number);
  e.flushChannelVisuals();
  const hit = calls.find((c) => c.ch === 7 && c.kind === 'image');
  assert.ok(hit, `expected 7:image, got ${calls.map((c) => `${c.ch}:${c.kind}`).join(', ')}`);
  // setMemberProp('image') copies the surface (Director semantics), so the
  // visual carries the member's own buffer, not the caller's reference.
  assert.ok(hit!.image instanceof LImage, 'visual must carry the member LImage surface');
  assert.equal((hit!.image as LImage).width, 2);
  assert.equal((hit!.image as LImage).height, 3);
});

test('debugCopyOwner names the member behind an LImage (U66 copyPixels source log)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend'); // establish cast 1
  // setMemberProp('image') path — window buffers (`tmember.image = image(...)`)
  e.createNamedMember('mes_test', 'bitmap', 1);
  const ref = e.getMemberByName('mes_test')!;
  const img = new LImage(2, 2);
  e.setMemberProp(ref, 'image', img);
  // setMemberProp('image') copies the surface, so the owner is recorded on the
  // member's stored image (what `member.image`/copyPixels receivers see).
  const stored = e.getMemberProp(ref, 'image') as LImage;
  assert.equal(e.debugCopyOwner(stored), `1#${ref.number} "mes_test"`);
  assert.equal(e.debugCopyOwner(img), ''); // the caller's copy is unowned
  // memberImage materialization path — `member(name).image` on a raw member
  e.createNamedMember('mes_test2', 'bitmap', 1);
  const ref2 = e.getMemberByName('mes_test2')!;
  const img2 = e.getMemberProp(ref2, 'image') as LImage;
  assert.ok(img2 instanceof LImage);
  assert.equal(e.debugCopyOwner(img2), `1#${ref2.number} "mes_test2"`);
  // an orphan LImage (image() builtin result, never assigned to a member) is unnamed
  assert.equal(e.debugCopyOwner(new LImage(1, 1)), '');
});

test('member image painted via copyPixels flips plain bitmap channel to live surface, keeps ink-9 mask path', () => {
  // The FUSE screen camera does `member("fuse_screen").image.copyPixels(...)`
  // every frame. A bitmap member with raw PNG bytes must switch from the raw
  // static visual to a kind:'image' visual carrying the painted surface once
  // Lingo writes into it — otherwise the screen shows the original logo bitmap
  // forever. Ink-9 masked members (pool water vesi1/vesimask1) must KEEP the
  // raw+mask path: flipping them to a bare surface drops the mask.
  const calls: { ch: number; kind: string; image?: unknown }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; image?: unknown } | null) {
      calls.push(v ? { ch, kind: v.kind, image: v.image } : { ch, kind: 'null' });
    },
  };
  const e = new DirectorEngine(adapter as never);
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend'); // establish cast 1
  const rawMember = (name: string): { mem: import('../engine/members.js').Member; ref: import('../lingo/values.js').LMemberRef } => {
    const num = e.createNamedMember(name, 'bitmap', 1);
    const ref = e.getMemberByName(name)! as import('../lingo/values.js').LMemberRef;
    const mem = e.memberFor(ref)!;
    const png = new Uint8Array(8);
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47; // PNG magic
    mem.raw = png;
    return { mem, ref };
  };
  // Plain member (FUSE screen) on channel 9.
  const a = rawMember('fuse_screen');
  e.setMemberProp(a.ref, 'image', new LImage(2, 2));
  e.setSpriteProp(e.getSprite(9), 'member', (a.mem.castLibNumber << 16) | a.mem.number);
  // Ink-9 masked member (pool water) on channel 10.
  const b = rawMember('vesi1');
  e.setMemberProp(b.ref, 'image', new LImage(2, 2));
  e.setSpriteProp(e.getSprite(10), 'member', (b.mem.castLibNumber << 16) | b.mem.number);
  e.setSpriteProp(e.getSprite(10), 'ink', 9);
  e.flushChannelVisuals();
  const kindOf = (ch: number): string => {
    const hits = calls.filter((c) => c.ch === ch);
    return hits.length ? hits[hits.length - 1].kind : 'none';
  };
  assert.equal(kindOf(9), 'bitmap', 'plain raw member starts as kind:bitmap');
  assert.equal(kindOf(10), 'bitmap', 'masked raw member starts as kind:bitmap');
  // Paint into BOTH member images via the interpreter path (fires imageMutated).
  e.addScriptMember(
    'CamPaint',
    'movie',
    ['on run me', '  tSrc = image(1, 1, 24)', '  tSrc.fill(rect(0, 0, 1, 1), rgb(0, 255, 0))', '  member("fuse_screen").image.copyPixels(tSrc, rect(0, 0, 1, 1), rect(0, 0, 1, 1))', '  member("vesi1").image.copyPixels(tSrc, rect(0, 0, 1, 1), rect(0, 0, 1, 1))', '  return 1', 'end'].join('\n'),
  );
  const paintScr = e.resolveScript('CamPaint')!;
  const paintH = paintScr.handlers.find((hh) => hh.name.toLowerCase() === 'run')!;
  e.interp.callHandler(paintScr, paintH, [], null, new Set());
  e.flushChannelVisuals();
  assert.equal(kindOf(9), 'image', 'plain painted member flips to kind:image');
  assert.equal(kindOf(10), 'bitmap', 'ink-9 masked member KEEPS kind:bitmap (mask preserved)');
  const last = calls.filter((c) => c.ch === 9);
  const vis = last[last.length - 1];
  assert.ok(vis.image instanceof LImage, 'visual must carry the member painted surface');
  assert.equal((vis.image as LImage).data![1], 255, 'green pixel survives into the surface');
});

test('value() parses real v14 struct strings with "# key" spacing', () => {
  // The real external_vars.txt writes `# ilk:#struct` (space after the hash);
  // Variable Container GetValue feeds it to value(), which must yield a real
  // proplist so tFontStruct.getaProp(#font) works (was: raw string -> warns).
  const e = new DirectorEngine();
  const s = '[#font:"v", #fontSize:9,#lineHeight:10,#color:rgb("#000000"),# ilk:#struct,#fontStyle:[#plain]]';
  const v = e.interp.evalExpressionString(s);
  assert.ok(v instanceof LPropList, 'struct string must parse to a proplist');
  const pl = v as LPropList;
  assert.equal(pl.props.get('font'), 'v');
  assert.equal(pl.props.get('fontSize'), 9);
  assert.equal(pl.props.get('lineHeight'), 10);
  assert.equal(pl.props.get('ilk') instanceof LSymbol, true);
  const color = pl.props.get('color');
  assert.ok(color && (color as { red: number }).red === 0, 'rgb("#000000") -> LColor(0,0,0)');
  assert.ok(pl.props.get('fontStyle') instanceof LList);
});

test('member text props: rect/alignment/font/fontSize get+set (Writer path)', () => {
  const e = new DirectorEngine();
  const m = e.addScriptMember('Txt', 'unknown', '');
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'rect', new LRect(1, 2, 3, 4));
  // LRect is (left, top, right, bottom) — right=3, bottom=4.
  assert.equal((e.getMemberProp(ref, 'rect') as LRect).right, 3);
  assert.equal((e.getMemberProp(ref, 'rect') as LRect).bottom, 4);
  e.setMemberProp(ref, 'alignment', new LSymbol('center'));
  assert.equal((e.getMemberProp(ref, 'alignment') as LSymbol).name, 'center');
  e.setMemberProp(ref, 'fontSize', 13);
  assert.equal(e.getMemberProp(ref, 'fontSize'), 13);
  e.setMemberProp(ref, 'font', 'Arial');
  assert.equal(e.getMemberProp(ref, 'font'), 'Arial');
  // default alignment is #left before any set
  assert.equal((e.getMemberProp(ref, 'alignment') as LSymbol).name, 'center');
  // generic text props (Writer/Messenger)
  e.setMemberProp(ref, 'topSpacing', 2);
  assert.equal(e.getMemberProp(ref, 'topSpacing'), 2);
  e.setMemberProp(ref, 'wordWrap', 0);
  assert.equal(e.getMemberProp(ref, 'wordWrap'), 0);
});

test('window element getProperty(#buffer).image yields a real image (Loading Bar window path)', () => {
  // Engine window backend: createWindow + window(id) (Director builtins) give
  // elements a buffer wrapper whose .image is a real LImage, so the Loading
  // Bar's `getElement("drag").getProperty(#buffer).image` chain paints pixels
  // instead of warning on VOID. (getWindow is a corpus Window-API handler that
  // needs the full Window Manager; window(id) is the engine-side Director fn.)
  const e = new DirectorEngine();
  e.addScriptMember(
    'Wnd',
    'movie',
    [
      'on run',
      '  createWindow("LB", "system.window")',
      '  tWnd = window("LB")',
      '  tBuf = tWnd.getElement("drag").getProperty(#buffer).image',
      '  tBuf.fill(rect(0, 0, 10, 10), rgb(255, 0, 0))',
      '  return tBuf.width & "," & tBuf.height',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Wnd')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), '720,540');
});

test('ilk property works on every value (Director)', () => {
  // FUSE gates depend on these: Connection Manager's `tid.ilk <> #symbol`
  // (registerListener header ids default to #info/#mus symbols) and Multiuser
  // Instance's `tMode.ilk <> #integer` (setLogMode). They were VOID for
  // numbers/symbols, erroring every registerListener/setLogMode call.
  const e = new DirectorEngine();
  const nm = (src: string): string => (e.interp.evalExpressionString(src) as LSymbol).name;
  assert.equal(nm('0.ilk'), 'integer');
  assert.equal(nm('1.5.ilk'), 'float');
  assert.equal(nm('(point(1,2)).ilk'), 'point');
  assert.equal(nm('(rect(0,0,1,1)).ilk'), 'rect');
  assert.equal(nm('(void).ilk'), 'void');
  assert.equal(nm('"x".ilk'), 'string');
  // `#foo.ilk` in source is ONE symbol ("foo.ilk" — dots are legal in symbol
  // names), so the corpus always uses the variable form `tid.ilk`.
  e.addScriptMember('T', 'movie', ['on run', '  tid = #foo', '  return string(tid.ilk)', 'end'].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // string(#symbol) = "symbol" without the # (C++ toStringLikeJava /
  // DirPlayer string.rs).
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 'symbol');
});

test('struct proplists report #struct via the stored #ilk key', () => {
  // Real v14 external_vars format: `struct.font.plain=[#font:"v", # ilk:#struct]`
  // — value() parses that raw string (quotes included) into a proplist that
  // carries `# ilk:#struct`. Writer setFont gates on `tStruct.ilk <> #struct`,
  // so the stored #ilk key must win over the structural #propList; plain
  // proplists without the key stay #propList.
  const e = new DirectorEngine();
  const struct = new LPropList(new Map<string, LVal>([['font', 'v'], ['ilk', new LSymbol('struct')]]));
  assert.equal((e.interp.getPropValue(struct, 'ilk') as LSymbol).name, 'struct');
  const plain = new LPropList(new Map<string, LVal>([['a', 1]]));
  assert.equal((e.interp.getPropValue(plain, 'ilk') as LSymbol).name, 'propList');
});

test('xtra stub methods return 0 (Connection Instance connect gate)', () => {
  // Connection Instance connect(): `tErrCode = pXtra.setNetMessageHandler(...)`;
  // `if tErrCode = 0` proceeds to connectToNetServer. A VOID return used to
  // error "Creation of callback failed: VOID" on every connect.
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('xtra("Multiuser").new().setNetMessageHandler(#h, 1)'), 0);
  assert.equal(e.interp.evalExpressionString('xtra("Multiuser").new().setNetBufferLimits(16 * 1024, 100 * 1024, 100)'), 0);
  assert.equal(e.interp.evalExpressionString('xtra("Multiuser").new().connectToNetServer("*", "*", "localhost", 12321, "*", 0)'), 0);
});

test('member text props (bgColor/antialias/topSpacing) set+get silently', () => {
  // Writer/Purse/Navigator interfaces set these on field members; they were
  // warning "unsupported property"/"set ...: unsupported" on every define.
  const e = new DirectorEngine();
  const m = e.addScriptMember('Txt', 'unknown', '');
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'bgColor', 0);
  e.setMemberProp(ref, 'antialias', 1);
  e.setMemberProp(ref, 'topSpacing', 4);
  assert.equal(e.getMemberProp(ref, 'bgColor'), 0);
  assert.equal(e.getMemberProp(ref, 'antialias'), 1);
  assert.equal(e.getMemberProp(ref, 'topSpacing'), 4);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('sprite setID is a silent no-op that stores the id (Sprite Manager setEventBroker)', () => {
  const e = new DirectorEngine();
  e.interp.evalExpressionString('sprite(1).setID(42)');
  assert.equal(e.getSpriteProp(e.getSprite(1), 'id'), 42);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('sprite rotation/skew/flipH/flipV/backColor get+set silently (Visualizer buildVisual)', () => {
  // Visualizer Instance buildVisual applies tElem[#rotation/#skew/#flipH/#flipV]
  // and Director's sprite backColor to every element sprite (entry animations).
  // They used to warn "unsupported" every frame the entry visualizer built.
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on run',
    '  sprite(3).rotation = 45',
    '  sprite(3).skew = 10',
    '  sprite(3).flipH = 1',
    '  sprite(3).flipV = 0',
    '  sprite(3).backColor = 255',
    '  sprite(3).bgColor = 128',
    '  return sprite(3).rotation & "," & sprite(3).skew & "," & sprite(3).flipH & "," & sprite(3).flipV',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), '45,10,1,0');
  // backColor aliases bgColor (128 = 0x000080) and reads back as an LColor.
  const c = e.getSpriteProp(e.getSprite(3), 'backColor') as { red: number; green: number; blue: number };
  assert.equal(c.red, 0);
  assert.equal(c.green, 0);
  assert.equal(c.blue, 128);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('setting a property on VOID is a silent no-op (Entry Interface animSign)', () => {
  // animSign: `repeat with tSpr in pSignSprList` then `tSpr.locV = tSpr.locV + 30`
  // — pSignSprList entries are VOID when the visual def lacks the sprite id.
  // Director no-ops property sets on VOID; we used to warn every frame.
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on run',
    '  tSpr = void',
    '  tSpr.locV = tSpr.locV + 30',
    '  tSpr.width = 5',
    '  tOk = voidp(tSpr.locV) and voidp(tSpr.width)',
    '  return tOk',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 1);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('sprite.color accepts rgb() LColor + hex strings (Visualizer buildVisual)', () => {
  // buildVisual sets `tSpr.color = rgb(tElem[#color])` where #color is a
  // "#RRGGBB" string — setSpriteProp used asNum() which silently stored 0.
  const e = new DirectorEngine();
  const s = e.getSprite(3);
  e.setSpriteProp(s, 'color', new LColor(0x84, 0xcc, 0xe8));
  let c = e.getSpriteProp(s, 'color') as { red: number; green: number; blue: number };
  assert.equal(c.red, 0x84);
  assert.equal(c.green, 0xcc);
  assert.equal(c.blue, 0xe8);
  // hex-string colors from the layout: rgb("#6FAECA")
  e.setSpriteProp(s, 'color', e.interp.evalExpressionString('rgb("#6FAECA")'));
  c = e.getSpriteProp(s, 'color') as { red: number; green: number; blue: number };
  assert.equal(c.red, 0x6f);
  assert.equal(c.green, 0xae);
  assert.equal(c.blue, 0xca);
  // transform props round-trip; scale defaults to 1
  e.setSpriteProp(s, 'rotation', 45);
  e.setSpriteProp(s, 'flipH', 1);
  e.setSpriteProp(s, 'scale', 2);
  assert.equal(e.getSpriteProp(s, 'rotation'), 45);
  assert.equal(e.getSpriteProp(s, 'flipH'), 1);
  assert.equal(e.getSpriteProp(s, 'scale'), 2);
});

test('shape members emit kind:shape visuals with parsed dims (entry sky/box)', () => {
  const calls: { ch: number; kind: string; shape?: { width: number; height: number } }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; shape?: { width: number; height: number } } | null) {
      calls.push(v ? { ch, kind: v.kind, shape: v.shape } : { ch, kind: 'null' });
    },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('SkyLeft', 'unknown', '');
  m.kind = 'shape';
  m.shape = parseShapeText('shapeType: rect\nwidth: 720\nheight: 54\ncolor: 0xff\nfillType: 1\nfilled: yes\noutlineInvisible: no');
  assert.equal(m.width, 720, 'shape member width reads from its definition');
  assert.equal(m.height, 54);
  e.setSpriteProp(e.getSprite(5), 'member', (m.castLibNumber << 16) | m.number);
  e.flushChannelVisuals();
  const hit = calls.find((c) => c.ch === 5 && c.kind === 'shape');
  assert.ok(hit, `expected 5:shape, got ${calls.map((c) => `${c.ch}:${c.kind}`).join(', ')}`);
  assert.equal(hit!.shape!.width, 720);
  assert.equal(hit!.shape!.height, 54);
});

test('a burst of sprite prop sets coalesces into ONE visual build per sprite', () => {
  // Visualizer buildVisual sets ~12 props per sprite in one synchronous block.
  // Each prop used to trigger a full setChannel -> blob URL + PNG decode that
  // got revoked by the next prop (ERR_FILE_NOT_FOUND console spam + rAF
  // violations at boot). The dirty-channel flush must build exactly once and
  // see the FINAL ink (so the texture-load bake uses it).
  let builds = 0;
  let lastKind: string | null = null;
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(_ch: number, v: { kind: string } | null) {
      builds++;
      lastKind = v?.kind ?? null;
    },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('Bmp', 'unknown', '');
  m.kind = 'bitmap';
  const s = e.getSprite(9);
  e.setSpriteProp(s, 'castNum', (m.castLibNumber << 16) | m.number);
  e.setSpriteProp(s, 'ink', 33); // add pin — must be visible to the bake path
  e.setSpriteProp(s, 'locH', 100);
  e.setSpriteProp(s, 'locV', 50);
  e.setSpriteProp(s, 'width', 64);
  e.setSpriteProp(s, 'color', new LColor(1, 2, 3));
  assert.equal(builds, 0, 'nothing built before the flush');
  e.flushChannelVisuals();
  assert.equal(builds, 1, 'one build for the whole burst, not one per prop');
  assert.equal(lastKind, null, 'raw-less bitmap member -> no visual (but built once)');
  assert.equal(e.getSpriteProp(s, 'ink'), 33);
  assert.equal(e.getSpriteProp(s, 'locH'), 100);
  e.flushChannelVisuals();
  assert.equal(builds, 1, 'a second flush with no new dirty channels builds nothing');
});

test('ink entering/leaving an alpha-bake mode rebuilds the visual (late matte)', () => {
  // buildVisual sets ink in the same burst as castNum, but a sprite whose ink
  // changes to 8/36 AFTER its texture was built must rebuild so the white
  // background gets (re)baked; non-bake ink changes only refresh.
  let builds = 0;
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel() { builds++; },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('Bmp', 'unknown', '');
  m.kind = 'bitmap';
  const s = e.getSprite(3);
  e.setSpriteProp(s, 'castNum', (m.castLibNumber << 16) | m.number);
  e.flushChannelVisuals();
  assert.equal(builds, 1);
  e.setSpriteProp(s, 'ink', 8); // matte
  e.flushChannelVisuals();
  assert.equal(builds, 2, 'entering a bake mode rebuilds');
  e.setSpriteProp(s, 'ink', 0); // copy
  e.flushChannelVisuals();
  assert.equal(builds, 3, 'leaving a bake mode rebuilds');
  e.setSpriteProp(s, 'ink', 9); // mask — not an alpha-bake ink
  e.flushChannelVisuals();
  assert.equal(builds, 3, 'non-bake ink changes refresh, never rebuild');
  // per-frame motion never rebuilds either
  e.setSpriteProp(s, 'locH', 10);
  e.setSpriteProp(s, 'locV', 20);
  e.setSpriteProp(s, 'width', 64);
  e.flushChannelVisuals();
  assert.equal(builds, 3, 'position/size changes are refresh-only');
});

test('Multiuser Xtra routes through the engine (WebSocket-backed; stub without a ws url)', () => {
  // new(xtra("Multiuser")) -> engine xtraMethod: setNetMessageHandler stores
  // the callback, connectToNetServer opens a WebSocket when multiuserUrl is
  // set (here it isn't -> stub, returns 0), and the pull API answers 0/VOID.
  // Before the routing, isConnected/getNumberWaitingNetMessages/getNetMessage
  // fell through the lenient stub and returned VOID (concat as empty).
  const e = new DirectorEngine();
  e.addScriptMember(
    'MU',
    'movie',
    [
      'on run',
      '  tX = new(xtra("Multiuser"))',
      '  tA = tX.setNetBufferLimits(16384, 102400, 100)',
      '  tB = tX.setNetMessageHandler(#h, me)',
      '  tC = tX.connectToNetServer("*", "*", "", 0, "*", 0)',
      '  tD = tX.isConnected()',
      '  tE = tX.getNumberWaitingNetMessages()',
      '  tF = tX.getNetMessage()',
      '  tG = voidp(tF)',
      '  tH = tX.sendNetMessage("*", "SUB", "hello")',
      '  return tA & tB & tC & tD & tE & tG & tH',
      'end',
    ].join('\n'),
  );
  const s = e.resolveScript('MU')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), '0000010');
  // The connect attempt logged the missing ws url (stub path).
  assert.ok(e.logs.some((l) => l.includes('no ws url')));
});

test('Multiuser Xtra host/port fallback follows the page scheme (ws vs wss)', () => {
  // With no multiuserUrl preset, connectToNetServer builds the URL from the
  // Lingo host/port args using the page's protocol — ws on http, wss on https
  // (the original Xtra connects with the page scheme so mixed-content never
  // blocks the socket). The embed derives the same URL from sw2's
  // connection.info.host/port.
  const e = new DirectorEngine();
  const g = globalThis as { location?: { protocol?: string }; WebSocket?: new (u: string) => unknown };
  const origLoc = g.location;
  const origWS = g.WebSocket;
  const opened: string[] = [];
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 0;
    constructor(public url: string) { opened.push(url); }
    close(): void {}
    send(): void {}
  }
  try {
    g.location = { protocol: 'http:' };
    g.WebSocket = FakeWS as unknown as new (u: string) => unknown;
    const obj = e.xtraInstance('Multiuser');
    assert.equal(e.xtraMethod(obj, 'connecttonetserver', ['*', '*', 'localhost', 3003, '*', 0]), 0);
    assert.deepEqual(opened, ['ws://localhost:3003']);

    g.location = { protocol: 'https:' };
    opened.length = 0;
    const obj2 = e.xtraInstance('Multiuser');
    assert.equal(e.xtraMethod(obj2, 'connecttonetserver', ['*', '*', 'localhost', 3003, '*', 0]), 0);
    assert.deepEqual(opened, ['wss://localhost:3003']);
  } finally {
    g.location = origLoc;
    g.WebSocket = origWS;
  }
});

test('xmlparser Xtra parses FUSE partSet/action XML (figure data path)', () => {
  // The Figure System/Figure Data Class parse partsets.xml, draworder.xml,
  // animation.xml and figuredata.xml through new(xtra("xmlparser")) and walk
  // parser.child[i].child[j].attributeName/attributeValue lists plus #text
  // nodes (parseColors: `tColorValue = tElementColor.child[1].text`). Without
  // a real parser every *.loaded flag flipped to 1 with an empty child tree —
  // human.parts/partset variables never got built and construct complained
  // "human.partset.figure.0 not found!".
  const e = new DirectorEngine();
  e.addScriptMember(
    'XP',
    'movie',
    [
      'on run tXML',
      '  tP = new(xtra("xmlparser"))',
      '  tR = tP.parseString(tXML)',
      '  tErr = tP.getError()',
      '  tCount = tP.child.count',
      '  tRoot = tP.child[1].name',
      '  tPSets = tP.child[1].child.count',
      '  tSetName = tP.child[1].child[1].name',
      '  tPartName = tP.child[1].child[1].child[1].name',
      '  tAttrs = tP.child[1].child[1].child[1].attributeName.count',
      '  tSetType = tP.child[1].child[1].child[1].attributeValue[1]',
      '  tPart2SetType = tP.child[1].child[1].child[2].attributeValue[1]',
      '  tPart2Flipped = tP.child[1].child[1].child[2].attributeValue[2]',
      '  tText = tP.child[1].child[1].child[2].child[1].child[1].text',
      '  return tR & "|" & tErr & "|" & tCount & "|" & tRoot & "|" & tPSets & "|" & tSetName & "|" & tPartName & "|" & tAttrs & "|" & tSetType & "|" & tPart2SetType & "|" & tPart2Flipped & "|" & tText',
      'end',
      'on bad tXML',
      '  tP = new(xtra("xmlparser"))',
      '  tR = tP.parseString(tXML)',
      '  tErr = tP.getError()',
      '  return tR & "|" & tErr',
      'end',
    ].join('\n'),
  );
  const xml = [
    '<?xml version="1.0"?>',
    '<partSets>',
    '  <partSet id="1">',
    '    <part set-type="1" swim="1" small="1"/>',
    '    <part set-type="2" flipped-set-type="4"><color id="1">FFCB98</color></part>',
    '  </partSet>',
    '</partSets>',
  ].join('\n');
  const s = e.resolveScript('XP')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(
    e.interp.callHandler(s, run, [xml], null, new Set()),
    '1||1|partSets|1|partSet|part|3|1|2|4|FFCB98',
  );
  // Malformed XML: parseString 0 + getError message (the corpus gates on
  // voidp(errorString), so a message means the parse really failed).
  const bad = s.handlers.find((h) => h.name.toLowerCase() === 'bad')!;
  const out = e.interp.callHandler(s, bad, ['<partSets><partSet></partSets>'], null, new Set());
  assert.equal(out, '0|Mismatched closing tag: partSets');
});

/** MUS binary frame helpers (kepler MusNetworkEncoder layout): 0x7200 header
 *  + u32 length + payload {i32 errorCode, i32 timestamp, even-padded subject,
 *  even-padded sender, u32 receiver count + receivers, u16 content tag, even-
 *  padded content string}. */
function musStrBytes(s: string): number[] {
  const out: number[] = [];
  const len = s.length;
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  for (let i = 0; i < len; i++) out.push(s.charCodeAt(i) & 0xff);
  if (len % 2) out.push(0);
  return out;
}
function musFrameBytes(subject: string, contentStr: string): Uint8Array {
  const body: number[] = [
    0, 0, 0, 0, // errorCode
    0, 0, 0, 0, // timestamp
    ...musStrBytes(subject),
    ...musStrBytes('System'),
    0, 0, 0, 1, // receiver count
    ...musStrBytes('*'),
    0, 3, // content tag: String
    ...musStrBytes(contentStr),
  ];
  const frame = [0x72, 0x00, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
  return new Uint8Array(frame);
}
/** Minimal MUS frame decode: subject + String content (for assert checks). */
function musDecode(bytes: Uint8Array): { subject: string; content: string } {
  let off = 6; // header(2) + length(4)
  const u32 = (): number => {
    const v = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    off += 4;
    return v;
  };
  const str = (): string => {
    const len = u32();
    const s = String.fromCharCode(...bytes.subarray(off, off + len));
    off += len + (len % 2 ? 1 : 0);
    return s;
  };
  off += 8; // errorCode + timestamp
  const subject = str();
  str(); // senderId
  const n = u32();
  for (let i = 0; i < n; i++) str();
  const tag = (bytes[off] << 8) | bytes[off + 1];
  off += 2;
  return { subject, content: tag === 3 ? str() : '' };
}

/** Fake persistence worker: records outbound calls and lets the test push
 *  inbound worker messages (ws-open/ws-data/tick/...) through the engine's
 *  registered handler — no real Worker needed. */
class FakePersistWorker implements PersistWorkerLike {
  sent: { type: 'connect' | 'send' | 'close' | 'hidden'; url?: string; bytes?: Uint8Array; hidden?: boolean }[] = [];
  private cb: ((msg: PersistWorkerMsg) => void) | null = null;
  connect(url: string): void { this.sent.push({ type: 'connect', url }); }
  send(url: string, bytes: Uint8Array): void { this.sent.push({ type: 'send', url, bytes }); }
  closeSocket(url: string): void { this.sent.push({ type: 'close', url }); }
  setHidden(hidden: boolean): void { this.sent.push({ type: 'hidden', hidden }); }
  onMessage(cb: (msg: PersistWorkerMsg) => void): void { this.cb = cb; }
  terminate(): void {}
  push(msg: PersistWorkerMsg): void { this.cb?.(msg); }
}

test('Multiuser Xtra routes through the persistence worker (hidden-tab path)', () => {
  // With a worker attached, connectToNetServer hands the socket to the worker
  // (the shim forwards sends + tracks readyState), inbound ws-data lands in
  // the queue immediately (not gated on a tick), and a tick delivers it to the
  // registered netHandler exactly like the inline path. The engine stays
  // headless: the fake replaces the real Worker entirely.
  const e = new DirectorEngine();
  const fake = new FakePersistWorker();
  e.attachPersistence(fake);
  e.multiuserUrl = 'ws://persist.test';
  const obj = e.xtraInstance('Multiuser');
  // Handler target that counts deliveries into an instance prop.
  const rec = e.addScriptMember('REC', 'parent', ['property p', 'on h', '  p = p + 1', 'end'].join('\n'));
  const tgt = e.interp.makeInstance(rec.script!);
  tgt.props.set('p', 0);

  assert.equal(e.xtraMethod(obj, 'connecttonetserver', ['*', '*', '', 0, '*', 0]), 0);
  assert.equal(fake.sent[0]?.type, 'connect');
  assert.equal(fake.sent[0]?.url, 'ws://persist.test');
  assert.equal(e.xtraMethod(obj, 'isconnected', []), 0, 'not open yet');

  // ws-open -> isConnected flips and the synthetic connect message unblocks.
  fake.push({ type: 'ws-open', url: 'ws://persist.test' });
  assert.equal(e.xtraMethod(obj, 'isconnected', []), 1);

  // Outbound send goes to the worker as latin1 bytes (kepler binary frames),
  // routed to this connection's url.
  e.xtraMethod(obj, 'sendnetmessage', [0, 0, 'hi']);
  const sent = fake.sent[fake.sent.length - 1];
  assert.equal(sent?.type, 'send');
  assert.equal(sent?.url, 'ws://persist.test');
  assert.deepEqual(sent.bytes, new Uint8Array([104, 105]));

  // Register the handler; an inbound frame is queued on arrival (no tick yet).
  e.xtraMethod(obj, 'setnetmessagehandler', [new LSymbol('h'), tgt]);
  // This connection is mode 0 (binary), so inbound frames are MUS frames —
  // kepler's HELLO reply to our Logon handshake.
  const ab = musFrameBytes('HELLO', '').buffer as ArrayBuffer;
  fake.push({ type: 'ws-data', url: 'ws://persist.test', bytes: ab });
  assert.equal(e.xtraMethod(obj, 'getnumberwaitingnetmessages', []), 2, 'connect msg + frame queued');
  assert.equal(tgt.props.get('p'), 0, 'nothing delivered before a tick');

  // A tick delivers both queued messages to the handler (fireNetMessages drain).
  e.boot();
  e.tick();
  assert.equal(tgt.props.get('p'), 2);
  assert.equal(e.xtraMethod(obj, 'getnumberwaitingnetmessages', []), 0);

  // Disconnect closes through the worker and drops the socket.
  e.xtraMethod(obj, 'closenetconnection', []);
  assert.equal(fake.sent[fake.sent.length - 1]?.type, 'close');
  assert.equal(fake.sent[fake.sent.length - 1]?.url, 'ws://persist.test');
  assert.equal(e.xtraMethod(obj, 'isconnected', []), 0);
});

test('Multiuser Xtra opens BOTH connections from the script args (info + mus)', () => {
  // The v14 client runs two Xtra connections: the main info connection
  // (connection.info.host:port -> sw2) and the MUS connection (Binary
  // Manager -> createMultiuser(id, connection.mus.host, connection.mus.port)
  // -> sw4). Each connectToNetServer call carries its own host/port, so each
  // must resolve its own ws url — a preset multiuserUrl (or the other
  // connection's args) must never hijack it.
  const e = new DirectorEngine();
  const fake = new FakePersistWorker();
  e.attachPersistence(fake);
  // A stale preset must NOT override the script args (it's only a fallback
  // for empty host/port).
  e.multiuserUrl = 'ws://wrong.example';

  const info = e.xtraInstance('Multiuser');
  const mus = e.xtraInstance('Multiuser');
  assert.equal(e.xtraMethod(info, 'connecttonetserver', ['*', '*', 'localhost', 3003, '*', 1]), 0);
  assert.equal(e.xtraMethod(mus, 'connecttonetserver', ['*', '*', 'localhost', 3004, '*', 0]), 0);

  const connects = fake.sent.filter((s) => s.type === 'connect');
  assert.deepEqual(
    connects.map((s) => s.url),
    ['ws://localhost:3003', 'ws://localhost:3004'],
    'info and mus connections each get their own url from the script args',
  );

  // Sends route by url to the right connection.
  e.xtraMethod(info, 'sendnetmessage', [0, 0, 'A']);
  e.xtraMethod(mus, 'sendnetmessage', [0, 0, 'B']);
  const sends = fake.sent.filter((s) => s.type === 'send');
  assert.deepEqual(sends.map((s) => s.url), ['ws://localhost:3003', 'ws://localhost:3004']);
  assert.deepEqual(sends[0].bytes, new Uint8Array([65]));
  assert.deepEqual(sends[1].bytes, new Uint8Array([66]));

  // Inbound frames land on the connection that owns the url.
  const rec = e.addScriptMember('REC', 'parent', ['property p', 'on h', '  p = p + 1', 'end'].join('\n'));
  const tgt = e.interp.makeInstance(rec.script!);
  tgt.props.set('p', 0);
  e.xtraMethod(info, 'setnetmessagehandler', [new LSymbol('h'), tgt]);
  e.xtraMethod(mus, 'setnetmessagehandler', [new LSymbol('h'), tgt]);
  // The mus connection is mode 0, so inbound data is a MUS frame (kepler's
  // HELLO), not a v14 @-frame.
  fake.push({ type: 'ws-data', url: 'ws://localhost:3004', bytes: musFrameBytes('HELLO', '').buffer as ArrayBuffer });
  assert.equal(e.xtraMethod(mus, 'getnumberwaitingnetmessages', []), 1, 'mus got the frame');
  assert.equal(e.xtraMethod(info, 'getnumberwaitingnetmessages', []), 0, 'info did not');
});

test('MUS connection speaks the binary protocol (Logon handshake + HELLO + LOGIN framing)', () => {
  // The Binary Manager's MUS connection (connectToNetServer mode 0) is a
  // second Xtra instance on its own port (connection.mus.host/port from sw4).
  // Like DirPlayer, the Xtra sends a Logon frame on socket open (kepler
  // replies Logon + HELLO, which flips the Binary Manager's
  // pHandshakeFinished), inbound frames are parsed into {subject, content},
  // and sendNetMessage("*", subject, content) ships MUS binary frames.
  const e = new DirectorEngine();
  const fake = new FakePersistWorker();
  e.attachPersistence(fake);
  const mus = e.xtraInstance('Multiuser');
  assert.equal(e.xtraMethod(mus, 'connecttonetserver', ['*', '*', 'localhost', 3004, '*', 0]), 0);

  // URL comes straight from the Lingo args (connection.mus.host/port) — no
  // invented path appended.
  assert.deepEqual(
    fake.sent.filter((s) => s.type === 'connect').map((s) => s.url),
    ['ws://localhost:3004'],
  );

  // ws-open -> the Logon handshake frame goes out first.
  fake.push({ type: 'ws-open', url: 'ws://localhost:3004' });
  const logon = fake.sent.filter((s) => s.type === 'send' && s.url === 'ws://localhost:3004')[0];
  assert.ok(logon, 'Logon frame sent on open');
  assert.ok(logon.bytes, 'Logon frame has bytes');
  assert.equal(logon.bytes[0], 0x72);
  assert.equal(logon.bytes[1], 0x00);
  assert.equal(musDecode(logon.bytes).subject, 'Logon');

  // Inbound kepler HELLO parses to subject "HELLO" / empty string content.
  const rec = e.addScriptMember('REC', 'parent', ['property p', 'on h', '  p = p + 1', 'end'].join('\n'));
  const tgt = e.interp.makeInstance(rec.script!);
  tgt.props.set('p', 0);
  e.xtraMethod(mus, 'setnetmessagehandler', [new LSymbol('h'), tgt]);
  fake.push({ type: 'ws-data', url: 'ws://localhost:3004', bytes: musFrameBytes('HELLO', '').buffer as ArrayBuffer });
  assert.equal(e.xtraMethod(mus, 'getnumberwaitingnetmessages', []), 2, 'connect msg + HELLO queued');
  // First queued message is the synthetic ConnectToNetServer one.
  const conn = e.xtraMethod(mus, 'getnetmessage', []) as LPropList;
  assert.equal(conn.props.get('subject'), 'ConnectToNetServer');
  const hello = e.xtraMethod(mus, 'getnetmessage', []) as LPropList;
  assert.equal(hello.props.get('subject'), 'HELLO');
  assert.equal(hello.props.get('content'), '');
  assert.equal(e.xtraMethod(mus, 'getnumberwaitingnetmessages', []), 0);

  // sendNetMessage("*", "LOGIN", [userId, machineId]) ships a MUS frame whose
  // content is the space-joined string kepler's LOGIN handler parses.
  e.xtraMethod(mus, 'sendnetmessage', ['*', 'LOGIN', new LList(['123', 'abc'])]);
  const login = fake.sent.filter((s) => s.type === 'send' && s.url === 'ws://localhost:3004').pop()!;
  assert.ok(login.bytes, 'LOGIN frame has bytes');
  assert.deepEqual(musDecode(login.bytes), { subject: 'LOGIN', content: '123 abc' });
});

test('persistence worker drives engine.tick() at 1 Hz only while the page is hidden', () => {
  const e = new DirectorEngine();
  e.boot();
  const fake = new FakePersistWorker();
  e.attachPersistence(fake);
  assert.equal(fake.sent.length, 0, 'attach itself sends nothing');

  e.setPageHidden(true);
  assert.equal(fake.sent[fake.sent.length - 1]?.type, 'hidden');
  assert.equal(fake.sent[fake.sent.length - 1]?.hidden, true);
  const before = e.frameCount;
  fake.push({ type: 'tick' });
  assert.equal(e.frameCount, before + 1, 'worker tick advances game logic while hidden');

  e.setPageHidden(false);
  assert.equal(fake.sent[fake.sent.length - 1]?.hidden, false);
  const visible = e.frameCount;
  fake.push({ type: 'tick' });
  assert.equal(e.frameCount, visible, 'stray worker tick ignored while visible (rAF owns it)');
});

test('memberExists finds members by name (underscore/space) and global number', () => {
  // Corpus references window defs with the decompiler's underscore spelling
  // ("habbo_basic.window") while the bundled member name has the real
  // Director spaces ("habbo basic.window"). Layout Parser gates every
  // window-def parse on memberExists() — it used to read VOID and report
  // "Member not found: habbo_basic.window".
  const e = new DirectorEngine();
  e.addScriptMember('habbo basic.window', 'movie', ['on run', 'end'].join('\n'));
  assert.equal(e.memberExists('habbo_basic.window'), true);
  assert.equal(e.memberExists('habbo basic.window'), true);
  assert.equal(e.memberExists('no.such.member'), false);
  // by number: movie-global (Director slot: (castLib<<16)+local) works, cast-local miss is false.
  assert.equal(e.memberExists(65537), true);
  assert.equal(e.memberExists(9999), false);
  // memberExists/getmemnum are FUSE Resource API handlers (not Director
  // builtins): bare calls resolve to the corpus's Resource API script in the
  // real client (probe: globalHandlers.memberexists = Resource API). In a bare
  // engine with no corpus the bare call is deliberately unresolved (removed
  // fake builtin) — falsy, never a hard 1/0 — while the method form above is
  // the engine API under test.
  assert.ok(!e.interp.evalExpressionString('memberExists("habbo_basic.window")'));
  assert.equal(e.interp.evalExpressionString('member("habbo_basic.window").name'), 'habbo basic.window');
});

test('proplist reads tolerate underscore/space member-name spelling (pAllMemNumList)', () => {
  // Resource Manager indexes members as pAllMemNumList[tmember.name] (stored
  // with spaces) but reads back pAllMemNumList[tMemName] with the corpus
  // underscore spelling — getmemnum("habbo_basic.window") must hit.
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on run',
    '  t = [:]',
    '  t["habbo basic.window"] = 42',
    '  return t["habbo_basic.window"] + t.getaProp("habbo_basic.window")',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 84);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

test('repeat-with-in iterates proplist VALUES (Director semantics)', () => {
  // Layout Parser builds element defs as id -> [defs]; Window Instance
  // buildVisual does `repeat with tElement in tLayout[#elements]` to create
  // members/sprites. Iterating only LList used to leave that loop empty and
  // pElemList at 0 — the Loading Bar's `#window` buffer stayed VOID.
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on run',
    '  t = [#a: [1, 2], #b: [3]]',
    '  tSum = 0',
    '  repeat with tItem in t',
    '    repeat with tN in tItem',
    '      tSum = tSum + tN',
    '    end repeat',
    '  end repeat',
    '  return tSum',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 6);
});

test('sprite castNum/color/bgColor props + setcursor/registerProcedure silent', () => {
  // Window Instance buildVisual sets tsprite.castNum/.ink/.color/.bgColor and
  // calls setcursor/registerProcedure on every element sprite. (Assignments
  // must run in a handler body — `=` in evalExpressionString is EQUALITY.)
  const e = new DirectorEngine();
  e.addScriptMember('T', 'movie', [
    'on run',
    '  sprite(3).castNum = 65537',
    '  sprite(3).color = 255',
    '  sprite(3).bgColor = 0',
    '  sprite(3).setcursor(#arrow)',
    '  sprite(3).registerProcedure(0, "uid", 0)',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  e.interp.callHandler(s, run, [], null, new Set());
  assert.equal(e.getSpriteProp(e.getSprite(3), 'castNum'), 65537);
  // Director sprite.color is an LColor (rgb(...)) — a stored int 255 is the
  // palette value 0x0000ff, returned as an LColor.
  const color = e.getSpriteProp(e.getSprite(3), 'color') as { red: number; green: number; blue: number };
  assert.equal(color.red, 0);
  assert.equal(color.green, 0);
  assert.equal(color.blue, 255);
  const bg = e.getSpriteProp(e.getSprite(3), 'bgColor') as { red: number; green: number; blue: number };
  assert.equal(bg.red, 0);
  assert.equal(bg.blue, 0);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')));
});

// ---- animation runtime (Entry Car flip, sign timer, clouds) ----

test('not binds tighter than + — Entry Car Class direction toggle', () => {
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  // `tDirNum = not (tDirNum - 1) + 1` must toggle 1 <-> 2 (car1 <-> car2).
  // Before the precedence fix it parsed as `not ((tDirNum-1)+1)` = 0 and the
  // car flipped to "car0" (castNum 0) — invisible at the turn.
  assert.equal(ev('not (1 - 1) + 1'), 2);
  assert.equal(ev('not (2 - 1) + 1'), 1);
  assert.equal(ev('not 0'), 1);
  assert.equal(ev('not 3'), 0);
});

test('not binds tighter than = — the window check `if not tWndObj = VOID`', () => {
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  // Corpus deconstruct pattern: `tWndObj = getWindow(pWindowID); if not
  // tWndObj = VOID then tWndObj.close()`. With tight `not` this reads
  // `(not tWndObj) = VOID`, which is TRUE for a live window because VOID
  // coerces to 0 in numeric equality — close() runs exactly when it should.
  e.globalSet('tW', e.createWindow('mywin'));
  assert.equal(ev('not tW = VOID'), 1); // live window -> close branch
  assert.equal(ev('not VOID = VOID'), 0); // missing window -> skip
});

test('the milliSeconds is the full clock (openView sign-anim countdown)', () => {
  const e = new DirectorEngine();
  // Entry Interface openView: `tTimeLeft = (pViewMaxTime - (the milliSeconds -
  // pViewOpenTime)) / 1000.0`. A modulo-1000 clock wrapped every second so the
  // countdown never reached 0 and the entry sign never animated.
  const ms = e.getThe('milliseconds', []) as number;
  assert.ok(ms > 1000, `full ms clock, got ${ms}`);
  assert.ok(Number.isInteger(ms));
});

test('createMember makes a named bitmap member the cloud can paint and assign', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const num = e.createNamedMember('entrycloud_1', 'bitmap', 1);
  assert.ok(num > 0);
  assert.equal(e.memberExists('entrycloud_1'), true);
  const ref = e.getMemberByName('entrycloud_1')!;
  assert.equal(ref.kind, 'bitmap');
  // `pCloudMember.image = image(w, 60, 8)` then copyPixels into it
  const img = new LImage(8, 8);
  img.fillRect(0, 0, 8, 8, new LColor(10, 200, 30));
  e.setMemberProp(ref, 'image', img);
  assert.equal(e.getMemberProp(ref, 'width'), 8);
  assert.equal(e.getMemberProp(ref, 'height'), 8);
  // `pSprite.member = pCloudMember` — the sprite resolves the dynamic member
  e.setSpriteProp(e.getSprite(9), 'member', ref);
  assert.equal(e.getSpriteProp(e.getSprite(9), 'castNum'), num);
});

test('image.copyPixels ink 8 skips the white background (cloud compositing)', () => {
  const art = new LImage(4, 4);
  art.fillRect(0, 0, 4, 4, new LColor(255, 255, 255)); // white background
  art.fillRect(1, 1, 3, 3, new LColor(200, 30, 30));   // the art
  const dst = new LImage(6, 4);
  dst.copyPixels(art, new LRect(1, 0, 5, 4), new LRect(0, 0, 4, 4), 8);
  const d = dst.ensure();
  // dest(0,0) = art(0,0) = white -> skipped -> stays transparent
  assert.equal(d[3], 0);
  // dest(2,1) = art(1,1) = red -> landed with alpha 255
  const i = (1 * 6 + 2) * 4;
  assert.equal(d[i], 200);
  assert.equal(d[i + 1], 30);
  assert.equal(d[i + 2], 30);
  assert.equal(d[i + 3], 255);
});

test('copyPixels ink 8 keeps INTERIOR background color (cloud white puffs)', () => {
  // 6x6 art: white background + a black outline ring enclosing a white interior
  // (the "puff"). A blanket skip-white ate the puff (clouds rendered as bare
  // outlines); the edge-connected matte mask must keep it and only drop the
  // backdrop connected to the border.
  const art = new LImage(6, 6);
  const a = art.ensure();
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const i = (y * 6 + x) * 4;
      const onRing = x >= 1 && x <= 4 && y >= 1 && y <= 4 && (x === 1 || x === 4 || y === 1 || y === 4);
      if (onRing) {
        a[i] = 0; a[i + 1] = 0; a[i + 2] = 0; a[i + 3] = 255; // black outline
      } else {
        a[i] = 255; a[i + 1] = 255; a[i + 2] = 255; a[i + 3] = 255; // white bg + puff
      }
    }
  }
  const dst = new LImage(6, 6);
  dst.copyPixels(art, new LRect(0, 0, 6, 6), new LRect(0, 0, 6, 6), 8);
  const out = dst.ensure();
  const alpha = (x: number, y: number) => out[(y * 6 + x) * 4 + 3];
  const rgb = (x: number, y: number) => out[(y * 6 + x) * 4];
  // corners: white backdrop removed -> transparent
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(5, 5), 0);
  // ring: black kept
  assert.equal(rgb(2, 1), 0);
  assert.equal(alpha(2, 1), 255);
  // puff: interior white SURVIVES (enclosed by the ring)
  assert.equal(rgb(2, 2), 255);
  assert.equal(alpha(2, 2), 255);
});

test('ink-8 copy into an 8-bit image builds a WHITE-BACKED mask; maskImage samples it by luma (mode-2 text mask)', () => {
  // text.render.compatibility.mode=2 (v31) renders text as
  //   tFakeAlpha = image(w,h,8); tFakeAlpha.copyPixels(textImage, [#ink: 8])
  //   pimage.copyPixels(colorSrc, [#maskImage: tFakeAlpha])
  // image(w,h,8) pre-fills OPAQUE WHITE (palette index 0, U122), so the mask
  // is WHITE-BACKED: the ink-8 copy skips the text image's transparent
  // background (leaving the white fill) and writes the dark glyphs. Real
  // Director's maskImage sampling treats an 8-bit (white-backed) mask by
  // LUMA, INVERTED: white blocks, any darker pixel allows (LSW
  // maskAllowsPixel: maskAlphaFromPixel(pixel) < 255). Sampling the mask's
  // ALPHA instead saw 255 everywhere and pasted the whole solid color
  // block — white text color -> solid white rectangle (navigator header,
  // entry bar), black -> black boxes (navigator tabs, U141).
  const src = new LImage(5, 5);
  const s = src.ensure();
  // Glyph pixel at (2,2); everything else transparent.
  const gi = (2 * 5 + 2) * 4;
  s[gi] = 0; s[gi + 1] = 0; s[gi + 2] = 0; s[gi + 3] = 255;
  const mask = new LImage(5, 5);
  mask.depth = 8;
  // image(w,h,8) pre-fill: opaque white.
  const m = mask.ensure();
  for (let i = 0; i < 25; i++) {
    m[i * 4] = 255; m[i * 4 + 1] = 255; m[i * 4 + 2] = 255; m[i * 4 + 3] = 255;
  }
  mask.copyPixels(src, new LRect(0, 0, 5, 5), new LRect(0, 0, 5, 5), 8);
  // Ink-8 leaves the white fill at the transparent bg, writes the dark glyph.
  assert.equal(m[(0 * 5 + 0) * 4], 255, 'mask bg keeps the white fill');
  assert.equal(m[(2 * 5 + 2) * 4], 0, 'mask glyph is dark');
  // maskImage composite: WHITE mask pixels block, dark glyph pixels allow.
  const colorSrc = new LImage(5, 5);
  colorSrc.fillRect(0, 0, 5, 5, new LColor(255, 255, 255));
  const dst = new LImage(5, 5);
  dst.fillRect(0, 0, 5, 5, new LColor(0, 0, 0));
  dst.copyPixels(colorSrc, new LRect(0, 0, 5, 5), new LRect(0, 0, 5, 5), 0, 255, 0xffffff, mask);
  const d = dst.ensure();
  const rgb = (x: number, y: number) => d[(y * 5 + x) * 4];
  assert.equal(rgb(0, 0), 0, 'dest bg stays black (white mask blocks)');
  assert.equal(rgb(2, 2), 255, 'glyph pixel becomes white (dark mask allows)');
  assert.equal(rgb(4, 4), 0, 'other corner stays black');
});

test('copyPixels ink 8 keeps a puff in a PARTIAL rect (cloud turn slices)', () => {
  // Entry Cloud Class turn() pastes a left/right SLICE of the cloud art
  // (`tSource = tImg.rect - rect(0,0,tWidth,0)`), so the cut cuts straight
  // through the art. A region-local flood fill seeds from the slice's
  // artificial cut and eats the enclosed white puff that straddles it; the
  // whole-image matte (C++ applyMatteToRegion over the ENTIRE source, then
  // sample the rect) keeps it — probe-cloudturn: 329 puff px survive vs 0.
  const art = new LImage(6, 6);
  const a = art.ensure();
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const i = (y * 6 + x) * 4;
      const onRing = x >= 1 && x <= 4 && y >= 1 && y <= 4 && (x === 1 || x === 4 || y === 1 || y === 4);
      if (onRing) {
        a[i] = 0; a[i + 1] = 0; a[i + 2] = 0; a[i + 3] = 255; // black outline
      } else {
        a[i] = 255; a[i + 1] = 255; a[i + 2] = 255; a[i + 3] = 255; // white bg + puff
      }
    }
  }
  // The turn's left slice: columns 0..3 (the ring's right side at x=4 is out
  // of the slice, so the ring is OPEN at the cut).
  const dst = new LImage(4, 6);
  dst.copyPixels(art, new LRect(0, 0, 4, 6), new LRect(0, 0, 4, 6), 8);
  const out = dst.ensure();
  const alpha = (x: number, y: number) => out[(y * 4 + x) * 4 + 3];
  const rgb = (x: number, y: number) => out[(y * 4 + x) * 4];
  // backdrop removed at the slice edge
  assert.equal(alpha(0, 0), 0);
  // ring kept
  assert.equal(alpha(2, 1), 255);
  assert.equal(rgb(2, 1), 0);
  // the puff interior inside the slice SURVIVES — the old region-local fill
  // seeded from the cut column (x=3) and ate it; the whole-image mask is
  // seeded from the image border, so the enclosed puff stays.
  assert.equal(rgb(2, 2), 255);
  assert.equal(alpha(2, 2), 255);
  assert.equal(rgb(3, 3), 255);
});

test('copyPixels ink 8 matte: white glyphs on a BLACK background survive (U69 white text eaten)', () => {
  // entry_bar name/mission text: txtBgColor #000000 + white glyphs drawn at
  // x=0 (left-aligned), so the glyph pixels sit ON the image's left edge. The
  // old "any pure-white edge pixel wins" matte rule was hijacked by those
  // glyph pixels -> the matte color resolved to WHITE -> the flood keyed the
  // whole glyph, leaving only antialiased fringes: the "cut off / shifted /
  // can't see the text fully" white text. The matte must resolve to the
  // DOMINANT edge color (black here) and keep the white glyphs.
  const art = new LImage(10, 6);
  const a = art.ensure();
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4;
      a[i] = 0;
      a[i + 1] = 0;
      a[i + 2] = 0;
      a[i + 3] = 255; // black background
    }
  }
  for (let y = 1; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 10 + x) * 4;
      a[i] = 255;
      a[i + 1] = 255;
      a[i + 2] = 255; // white glyph touching the LEFT edge
    }
  }
  const dst = new LImage(10, 6);
  dst.copyPixels(art, new LRect(0, 0, 10, 6), new LRect(0, 0, 10, 6), 8);
  const out = dst.ensure();
  // black backdrop removed -> transparent
  assert.equal(out[0], 0);
  assert.equal(out[3], 0);
  // white glyph pixel ON the left edge survives opaque
  const g = (1 * 10 + 0) * 4;
  assert.equal(out[g], 255);
  assert.equal(out[g + 3], 255);
  // interior white glyph pixel survives too
  const g2 = (2 * 10 + 3) * 4;
  assert.equal(out[g2], 255);
  assert.equal(out[g2 + 3], 255);
});

test('copyPixels adopts the SOURCE palette into a palette-less dest (flipH/flipV survive)', () => {
  // Corpus Unique Element flipH() (0057): `tImage = image(w, h, pimage.depth)`
  // creates a FRESH image with no palette (and no paletteRef), then
  // `tImage.copyPixels(pimage, ...)` pastes the piece back. Before the fix,
  // copyPixels never carried src.palette, so the flipped image lost palette
  // index 0 and the later ink-8 render matte (keyed on src.palette) fell back
  // to the pixel-(0,0) heuristic — on a mirrored image that pixel is the
  // ORIGINAL top-right corner, keying away black/gray outlines (navigator
  // right/bottom 9-slice pieces: nav_tb_ed flipH at locH 342, bottom strips
  // flipV) or re-pasting the white backdrop (purse_sd1 shadow). Director
  // semantics: pasting into a palette-less image adopts the source's palette.
  const src = new LImage(4, 4);
  src.palette = [[255, 255, 255], [0, 0, 0], [239, 239, 239]];
  src.paletteRef = null;
  src.fillRect(0, 0, 4, 4, new LColor(255, 255, 255)); // white backdrop
  src.fillRect(0, 0, 2, 2, new LColor(0, 0, 0));       // black outline corner

  // image(w,h,depth) equivalent: fresh LImage, no palette, no paletteRef.
  const flipped = new LImage(4, 4);
  flipped.depth = 32;
  assert.equal(flipped.palette, undefined, 'precondition: fresh image has no palette');
  flipped.copyPixels(src, new LRect(0, 0, 4, 4), new LRect(0, 0, 4, 4), 0, 255, 0xffffff, null, true);
  assert.ok(flipped.palette, 'dest adopted the source palette');
  assert.deepEqual(flipped.palette![0], [255, 255, 255], 'palette index 0 is the source background');

  // The ink-8 matte on the flipped image now keys white (backdrop gone) and
  // keeps the black outline — not the pre-fix pixel-(0,0) fallback.
  const dst = new LImage(4, 4);
  dst.copyPixels(flipped, new LRect(0, 0, 4, 4), new LRect(0, 0, 4, 4), 8);
  const out = dst.ensure();
  const alpha = (x: number, y: number) => out[(y * 4 + x) * 4 + 3];
  const rgb = (x: number, y: number) => out[(y * 4 + x) * 4];
  assert.equal(alpha(3, 3), 0, 'white backdrop keyed via palette[0]');
  assert.equal(rgb(0, 0), 0, 'black outline kept');

  // A dest that HAS a palette (buildVisual buffer via image(w,h,8,tPalette))
  // must NOT be clobbered by a piece's palette.
  const buffer = new LImage(4, 4);
  buffer.palette = [[0, 0, 0], [255, 255, 255]];
  buffer.paletteRef = {};
  buffer.copyPixels(src, new LRect(0, 0, 4, 4), new LRect(0, 0, 4, 4));
  assert.deepEqual(buffer.palette, [[0, 0, 0], [255, 255, 255]], 'dest with own palette keeps it');

  // A 32-bit palette-less dest receiving a PARTIAL paste (the Grouped Element
  // render pasting a piece at its element offset into a shared buffer, or the
  // visualizer's image(w,h,the colorDepth) buffers) must NOT adopt the piece's
  // palette — only full-surface copies do (the flipH/flipV pattern).
  const shared = new LImage(6, 6);
  shared.depth = 32;
  shared.copyPixels(src, new LRect(1, 1, 5, 5), new LRect(0, 0, 4, 4));
  assert.equal(shared.palette, undefined, 'partial paste into a palette-less 32-bit buffer does NOT adopt');
});

test('copyPixels #color/#bgColor tints grayscale art (purse title brown-on-gold)', () => {
  // purse_header: the text-member image is black-on-white (txtColor defaulted
  // black), and the element render passes [#color: #663300, #bgColor: #FFCA42]
  // (Grouped Element 0056 render -> pParams). Director tints near-grayscale
  // pixels along the gray -> (fg, bg) ramp: black becomes #color, white
  // becomes #bgColor (DirPlayer drawing.rs "Bitmap ink=0 colorization").
  const art = new LImage(12, 8);
  const a = art.ensure();
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 12; x++) {
      const i = (y * 12 + x) * 4;
      a[i] = 255;
      a[i + 1] = 255;
      a[i + 2] = 255;
      a[i + 3] = 255;
    }
  }
  for (let y = 1; y < 4; y++) {
    for (let x = 0; x < 6; x++) {
      const i = (y * 12 + x) * 4;
      a[i] = 0;
      a[i + 1] = 0;
      a[i + 2] = 0;
    }
  }
  const dst = new LImage(12, 8);
  dst.copyPixels(art, new LRect(0, 0, 12, 8), new LRect(0, 0, 12, 8), 0, 255, 0xffca42, null, false, false, 0x663300, true, true);
  const out = dst.ensure();
  const g = (1 * 12 + 0) * 4; // black glyph -> brown #663300
  assert.equal(out[g], 0x66);
  assert.equal(out[g + 1], 0x33);
  assert.equal(out[g + 2], 0x00);
  const b = (0 * 12 + 0) * 4; // white bg -> gold #FFCA42
  assert.equal(out[b], 0xff);
  assert.equal(out[b + 1], 0xca);
  assert.equal(out[b + 2], 0x42);
  // ink 36 does NOT tint: messenger EEEEEE member glyphs stay as authored
  const dst2 = new LImage(12, 8);
  dst2.copyPixels(art, new LRect(0, 0, 12, 8), new LRect(0, 0, 12, 8), 36, 255, 0xffffff, null, false, false, 0xeeeeee, true, false);
  const out2 = dst2.ensure();
  const g36 = (1 * 12 + 0) * 4;
  assert.equal(out2[g36], 0); // black glyph kept black (no tint for ink 36)
  assert.equal(out2[g36 + 3], 255);
  // window title: BLACK glyphs + [#color: #EEEEEE, #bgColor: teal] -> EEEEEE
  const dst3 = new LImage(12, 8);
  dst3.copyPixels(art, new LRect(0, 0, 12, 8), new LRect(0, 0, 12, 8), 0, 255, 0x6794a7, null, false, false, 0xeeeeee, true, true);
  const out3 = dst3.ensure();
  const gTitle = (1 * 12 + 0) * 4;
  assert.equal(out3[gTitle], 238);
  assert.equal(out3[gTitle + 1], 238);
  assert.equal(out3[gTitle + 2], 238);
  // pre-colored glyphs are NOT re-lerped: EEEEEE glyphs stay EEEEEE even with
  // [#color: #EEEEEE, #bgColor: teal] (registrat page_num double-declares)
  const art4 = new LImage(12, 8);
  const a4 = art4.ensure();
  for (let i = 0; i < 12 * 8; i++) {
    a4[i * 4] = 255;
    a4[i * 4 + 1] = 255;
    a4[i * 4 + 2] = 255;
    a4[i * 4 + 3] = 255;
  }
  for (let y = 1; y < 4; y++) {
    for (let x = 0; x < 6; x++) {
      const i = (y * 12 + x) * 4;
      a4[i] = 238;
      a4[i + 1] = 238;
      a4[i + 2] = 238;
    }
  }
  const dst4 = new LImage(12, 8);
  dst4.copyPixels(art4, new LRect(0, 0, 12, 8), new LRect(0, 0, 12, 8), 0, 255, 0x6794a7, null, false, false, 0xeeeeee, true, true);
  const out4 = dst4.ensure();
  const g4 = (1 * 12 + 0) * 4;
  assert.equal(out4[g4], 238); // NOT teal-ified
  assert.equal(out4[g4 + 1], 238);
  assert.equal(out4[g4 + 2], 238);
});

test('copyPixels ink 8 + bgColor does NOT tint grayscale (catalogue product preview)', () => {
  // Product Preview Class getPicture: `copyPixels(part, rect, rect, [#maskImage:
  // tMatte, #ink: 8, #bgColor: paletteIndex(integer(pPartColors[j])), #blend: 100])`.
  // For a non-colourable furni the server sends partColors "*ffffff" (no color),
  // which the corpus turns into `paletteIndex(integer("*ffffff"))` =
  // paletteIndex(0xFFFFFF) = palette entry 255 (the *ffffff no-color marker is
  // masked to the last palette entry, black in the radiator's palette). The old
  // ink-8 grayscale tint lerped the whole gray body toward that bgColor, so the
  // grunge radiator's native gray art rendered BLACK. DirPlayer's ink-8 path
  // (drawing.rs) uses foreColor only — bgColor is inert for ink 8 (it belongs
  // to ink 0 / ink 36). Native grayscale art must survive an ink-8 copy that
  // passes ONLY #bgColor.
  const e = new DirectorEngine();
  e.addScriptMember('TintGate', 'movie', [
    'on run',
    '  src = image(5, 5, 32)',
    '  src.fill(src.rect, rgb(200, 200, 200))',
    '  src.setPixel(1, 1, rgb(0, 0, 0))',
    '  src.setPixel(2, 2, rgb(99, 99, 99))',
    '  src.setPixel(3, 3, rgb(255, 255, 255))',
    '  dst = image(5, 5, 32)',
    '  dst.fill(dst.rect, rgb(255, 255, 255))',
    '  dst.copyPixels(src, src.rect, src.rect, [#ink: 8, #bgColor: rgb(0, 0, 0)])',
    '  return [dst.getPixel(1, 1).red, dst.getPixel(1, 1).green, dst.getPixel(1, 1).blue,',
    '          dst.getPixel(2, 2).red, dst.getPixel(2, 2).green, dst.getPixel(2, 2).blue,',
    '          dst.getPixel(3, 3).red, dst.getPixel(3, 3).green, dst.getPixel(3, 3).blue]',
    'end',
  ].join('\n'));
  const script = e.resolveScript('TintGate')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  // Native art preserved: black stays black, gray 99 stays gray, white stays white.
  assert.deepEqual(out.items, [0, 0, 0, 99, 99, 99, 255, 255, 255]);
});

test('image.trimWhiteSpace trims the white background (button text width)', () => {
  // Common Button getTextWidth: rect(0,0,300,30) -> copy -> trimWhiteSpace().
  // The label member is white-filled (bgColor), so a trim that only removes
  // alpha leaves the full 300px box; C++ Bitmap::trimWhiteSpace skips
  // `alpha == 0 || rgb == 0xFFFFFF`. Black pixel at x=1 -> width 1.
  const e = new DirectorEngine();
  e.addScriptMember('Trim Probe', 'parent', [
    'on trimProbe me',
    '  t = image(4, 4)',
    '  t.fill(t.rect, rgb(255, 255, 255))',
    '  t.setPixel(1, 1, rgb(0, 0, 0))',
    '  return t.trimWhiteSpace().width',
    'end',
  ].join('\n'));
  const script = e.resolveScript('Trim Probe')!;
  const obj = e.interp.newInstance(script, []);
  assert.equal(e.interp.callObjectHandler(obj, 'trimProbe', []), 1);
});

test('image.crop carries the palette + index grid so ink-8 keeps the nav thumbnail border', () => {
  // Navigator flow: `member(image).trimWhiteSpace()` crops the member image,
  // then `tPrewImg.copyPixels(tTempImg, ..., [#ink: 8])` mattes it. The
  // thumbnail palettes put WHITE at index 0, so the ink-8 matte keys white;
  // the art has no white pixels -> no mask -> the baked-in black border
  // frame survives. Before the fix, crop() dropped the palette and the matte
  // fell back to the (0,0)-pixel key, which keyed the BLACK border and
  // clipped it off the preview.
  const art = new LImage(6, 4);
  const a = art.ensure();
  for (let i = 0; i < 6 * 4; i++) {
    a[i * 4] = 0; a[i * 4 + 1] = 0; a[i * 4 + 2] = 0; a[i * 4 + 3] = 255; // black border
  }
  for (let y = 1; y < 3; y++) {
    for (let x = 1; x < 5; x++) {
      const i = (y * 6 + x) * 4;
      a[i] = 200; a[i + 1] = 120; a[i + 2] = 40; a[i + 3] = 255; // art interior
    }
  }
  art.palette = [[255, 255, 255]]; // index 0 = white, like the thumb .pal
  art.indices = null;
  const trimmed = art.crop(0, 0, 6, 4);
  assert.equal(trimmed.palette, art.palette, 'crop keeps the source palette');
  const dst = new LImage(6, 4);
  dst.copyPixels(trimmed, new LRect(0, 0, 6, 4), new LRect(0, 0, 6, 4), 8);
  const out = dst.ensure();
  assert.equal(out[3], 255, 'border pixel stays opaque (white key has no match)');
  assert.equal(out[(1 * 6 + 1) * 4 + 3], 255, 'art interior stays opaque');
});

test('image.crop carries the index grid for palette-INDEX keyed mattes', () => {
  const art = new LImage(3, 2);
  const a = art.ensure();
  const idx = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    a[i * 4] = 255; a[i * 4 + 1] = 255; a[i * 4 + 2] = 255; a[i * 4 + 3] = 255;
    idx[i] = 0; // all index 0 (white)
  }
  idx[4] = 5; // one art pixel at index 5
  art.palette = [[255, 255, 255], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 20, 30]];
  art.indices = idx;
  const cropped = art.crop(0, 0, 3, 2);
  assert.ok(cropped.indices, 'crop keeps the index grid');
  assert.equal(cropped.indices[4], 5, 'index subregion aligns with the pixels');
  assert.equal(cropped.indices[0], 0);
});

test('text member height falls back to the line height when its rect is zero (button label)', () => {
  // Common Button createButtonImg: `tTextMem.rect = rect(0,0,tTextWidth,
  // tTextMem.height)` — the shared label member starts with a zero-height
  // rect, so member.height must report the text line height (fontSize + 2,
  // FUSE's own tSpace) or the label rasterizes to a 1px sliver and vanishes.
  const m = new Member(1, 1, 'common.button.text', 'text');
  m.fontSize = 9;
  m.rect = new LRect(0, 0, 178, 0);
  assert.equal(m.height, 11);
  m.rect = new LRect(0, 0, 10, 11);
  assert.equal(m.height, 11);
  m.fontSize = 18;
  m.rect = new LRect(0, 0, 100, 0);
  assert.equal(m.height, 20);
});

test('copyPixels scales a 1x1 panel pixel into its box (9-slice window pieces)', () => {
  // content.middle.middle is a 1x1 bitmap stretched to a 175x147 panel box via
  // `pBuffer.image.copyPixels(pimage, tTargetRect, pimage.rect, pParams)`.
  const src = new LImage(1, 1);
  const sd = src.ensure();
  sd[0] = 239; sd[1] = 239; sd[2] = 239; sd[3] = 255;
  const dst = new LImage(4, 3);
  dst.copyPixels(src, new LRect(0, 0, 4, 3), new LRect(0, 0, 1, 1), 0);
  const out = dst.ensure();
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      assert.equal(out[i], 239, `panel pixel (${x},${y}) filled`);
      assert.equal(out[i + 3], 255);
    }
  }
});

test('copyPixels nearest-neighbor-stretches a 1xN strip (window border piece)', () => {
  // content.top.middle is a 1x6 vertical gradient stretched horizontally to
  // 175x6. Matches LibreShockwave's C++ rect-form copyPixels, which samples
  // nearest-neighbor (sx = srcLeft + dx*srcW/destW, sy = srcTop + dy*srcH/destH)
  // — integer division, no interpolation, so pixel art stays crisp.
  const src = new LImage(1, 4);
  const sd = src.ensure();
  for (let y = 0; y < 4; y++) {
    const v = Math.round((y / 3) * 255);
    sd[y * 4] = v; sd[y * 4 + 1] = v; sd[y * 4 + 2] = v; sd[y * 4 + 3] = 255;
  }
  const dst = new LImage(5, 8);
  dst.copyPixels(src, new LRect(0, 0, 5, 8), new LRect(0, 0, 1, 4), 0);
  const out = dst.ensure();
  // top row = src row 0 (black); bottom row = src row 3 (white); every column
  // of a row is identical (single-column horizontal stretch).
  assert.equal(out[0], 0);
  assert.equal(out[(7 * 5 + 0) * 4], 255);
  assert.equal(out[(7 * 5 + 4) * 4], 255);
  // row 3 of 8: sy = 3*4/8 = 1 (integer div) -> src row 1 = 85 (nearest, not
  // a 106 bilinear blend between src rows 1 and 2).
  assert.equal(out[(3 * 5 + 0) * 4], 85);
});

/** Minimal INDEXED PNG (color type 3, 8-bit indices, PLTE + stored deflate
 *  block). The bundler's palette bitmaps ship this way so per-pixel palette
 *  INDICES survive the export — the fuzzy-floor paletteRef remap needs them
 *  (several indices can share one RGB in the member's own palette). */
function buildIndexedPng(width: number, height: number, indices: number[], palette: number[][]): Uint8Array {
  const stride = width; // 1 byte per pixel (8-bit indexed)
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: None
    for (let x = 0; x < width; x++) raw[y * (1 + stride) + 1 + x] = indices[y * width + x];
  }
  const len = raw.length;
  if (len > 65535) throw new Error('test png too big for a stored block');
  const idat = new Uint8Array(2 + 5 + len + 4);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat[2] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  idat[3] = len & 0xff;
  idat[4] = (len >> 8) & 0xff;
  idat[5] = (~len) & 0xff;
  idat[6] = ((~len) >> 8) & 0xff;
  idat.set(raw, 7);
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const sum = ((b << 16) | a) >>> 0;
  idat[idat.length - 4] = (sum >>> 24) & 0xff;
  idat[idat.length - 3] = (sum >>> 16) & 0xff;
  idat[idat.length - 2] = (sum >>> 8) & 0xff;
  idat[idat.length - 1] = sum & 0xff;
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const n = data.length;
    out[0] = (n >>> 24) & 0xff;
    out[1] = (n >>> 16) & 0xff;
    out[2] = (n >>> 8) & 0xff;
    out[3] = n & 0xff;
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  });
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Minimal RGBA PNG (stored deflate block) — exercises the pure-JS inflate. */
function buildPng(width: number, height: number, rgba: number[]): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: None
    for (let x = 0; x < stride; x++) raw[y * (1 + stride) + 1 + x] = rgba[y * stride + x];
  }
  const len = raw.length;
  if (len > 65535) throw new Error('test png too big for a stored block');
  const idat = new Uint8Array(2 + 5 + len + 4);
  idat[0] = 0x78;
  idat[1] = 0x01; // zlib: deflate, 32K window
  idat[2] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  idat[3] = len & 0xff;
  idat[4] = (len >> 8) & 0xff;
  idat[5] = (~len) & 0xff;
  idat[6] = ((~len) >> 8) & 0xff;
  idat.set(raw, 7);
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const sum = ((b << 16) | a) >>> 0;
  idat[idat.length - 4] = (sum >>> 24) & 0xff;
  idat[idat.length - 3] = (sum >>> 16) & 0xff;
  idat[idat.length - 2] = (sum >>> 8) & 0xff;
  idat[idat.length - 1] = sum & 0xff;
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const n = data.length;
    out[0] = (n >>> 24) & 0xff;
    out[1] = (n >>> 16) & 0xff;
    out[2] = (n >>> 8) & 0xff;
    out[3] = n & 0xff;
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test('decodePng: pure-JS inflate + PNG decode (stored block, RGBA)', () => {
  const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
  const { width, height, rgba: out } = decodePng(buildPng(2, 2, rgba));
  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.deepEqual([...out], rgba);
});

test('decodePng returns INDICES for indexed art (color type 3)', () => {
  // Two indices; index 0 = white, index 1 = gray. The pixels are
  // [1,1 / 1,1] — all index 1.
  const { width, height, rgba, indices } = decodePng(buildIndexedPng(2, 2, [1, 1, 1, 1], [[255, 255, 255], [192, 192, 192]]));
  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.ok(indices, 'indices present for color type 3');
  assert.deepEqual([...indices!], [1, 1, 1, 1]);
  assert.deepEqual([...rgba.slice(0, 4)], [192, 192, 192, 255]);
});

test('paletteRef remap uses TRUE indices when several indices share one color', () => {
  // The fuzzy-floor failure: the tile's dither interior is all-white in its
  // OWN palette (indices 0 AND 1 both = white), so an RGBA export cannot tell
  // them apart — the reverse RGB lookup maps both to index 0 and the pattern
  // palette's checkerboard (white/203) never appears, leaving the matte flood
  // nothing to stop on. With indexed art the true index 1 must take the
  // pattern palette's index-1 color (203).
  const ownPal = [[255, 255, 255], [255, 255, 255]]; // both white — ambiguous RGB
  const patternPal = [[255, 255, 255], [203, 203, 204]];
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  const member = new Member(1, 2, 'flat_floor_1_a_0_0_0', 'bitmap');
  member.raw = buildIndexedPng(2, 2, [1, 1, 1, 1], ownPal);
  member.palette = ownPal;
  member.paletteTarget = patternPal;
  cast.members.set(2, member);
  cast.byName.set('flat_floor_1_a_0_0_0', member);
  e.membersByGlobal.set((1 << 16) | 2, member);
  const img = e.getMemberProp(e.getMemberByName('flat_floor_1_a_0_0_0')!, 'image');
  assert.ok(img instanceof LImage);
  const d = img.ensure();
  assert.equal(d[0], 203, 'index 1 maps to the pattern palette\'s 203 through TRUE indices');
  assert.equal(d[1], 203);
  assert.equal(d[2], 204);
});

test('member.image decodes raw bitmap PNGs (cloud copyPixels source)', () => {
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  const member = new Member(1, 2, 'cloud1_left', 'bitmap');
  member.raw = buildPng(2, 2, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  cast.members.set(2, member);
  cast.byName.set('cloud1_left', member);
  e.membersByGlobal.set((1 << 16) | 2, member);
  const img = e.getMemberProp(e.getMemberByName('cloud1_left')!, 'image');
  assert.ok(img instanceof LImage);
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  const d = img.ensure();
  assert.equal(d[0], 255); // red top-left decoded from the PNG
  assert.equal(d[3], 255);
  assert.equal(d[12], 255); // bottom-right white (2x2 image)
  assert.equal(d[15], 255);
});

test('the number of castMembers of castLib the number of tCast resolves (Dynamic Downloader acquireAssetsFromCast)', () => {
  // acquireAssetsFromCast does `tLast = the number of castMembers of castLib
  // the number of tCast`. The inner `the number of tCast` (a castLib ref) was
  // unsupported -> VOID -> tLast=0 -> the member-copy loop ran zero times and
  // the bin cast stayed empty (furniture PH boxes, "Couldn't define members").
  const e = new DirectorEngine();
  const cast = new CastLib(1, 'internal');
  for (let i = 1; i <= 5; i++) {
    const member = new Member(1, i, `m_${i}`, 'bitmap');
    member.raw = buildPng(1, 1, [255, 255, 255, 255]);
    cast.members.set(i, member);
    cast.byName.set(`m_${i}`, member);
  }
  e.casts.push(cast);
  e.castByName.set('internal', cast);
  e.addScriptMember(
    'CastProbe',
    'movie',
    [
      'on run me',
      '  tCast = castLib(1)',
      '  return the number of castMembers of castLib the number of tCast',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('CastProbe')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  // castmembers == the highest member number (Director dense numbering); the
  // probe itself lands as member 6, so 5 art members -> 6.
  assert.equal(out, 6, 'member count resolved through the nested castLib-ref form');
  assert.ok(!e.logs.some((l) => l.includes('unsupported')), 'no unsupported warn');
});

test('member.media = member.media transfers the bitmap payload (copyMemberToBin)', () => {
  // Dynamic Downloader copyMemberToBin: `tTargetMember.media =
  // tSourceMember.media` duplicates furniture art into the bin cast under the
  // aliased name. Previously a no-op — bin members were created empty and
  // furniture rendered as 0-size sprites even once the name resolved.
  const e = new DirectorEngine();
  const src = new Member(1, 1, 'md_sofa_a_0_2_1_2_0', 'bitmap');
  src.raw = buildPng(3, 2, new Array(3 * 2 * 4).fill(255));
  // Real furniture parts anchor at per-part regPoints (manifest regX/regY):
  // md_sofa_a_0_2_1_2_0 -> reg(35,39). Director carries the regPoint through
  // a media assignment — drop it and the bin copy pivots at (0,0), so every
  // part of a dynamic furniture cast renders offset by its own anchor
  // ("furniture parts scattered").
  src.regX = 35;
  src.regY = 39;
  const cast = new CastLib(1, 'internal');
  cast.members.set(1, src);
  cast.byName.set('md_sofa_a_0_2_1_2_0', src);
  e.casts.push(cast);
  e.castByName.set('internal', cast);
  e.membersByGlobal.set((1 << 16) | 1, src);
  const tNum = e.createNamedMember('club_sofa_a_0_2_1_2_0', 'bitmap', 0);
  assert.ok(tNum > 0, 'bin member created');
  const dst = e.memberFor(e.getMember(tNum)!)!;
  assert.equal(dst.raw, undefined, 'target starts without payload');
  assert.equal(dst.regX, 0, 'target starts with a default regPoint');
  e.setMemberProp(
    e.getMemberByName('club_sofa_a_0_2_1_2_0')!,
    'media',
    e.getMemberByName('md_sofa_a_0_2_1_2_0')!,
  );
  assert.equal(dst.raw, src.raw, 'bitmap payload copied');
  assert.equal(dst.width, 3, 'width from copied raw');
  assert.equal(dst.height, 2, 'height from copied raw');
  assert.equal(dst.regX, 35, 'regPoint X travels with the media (part anchor)');
  assert.equal(dst.regY, 39, 'regPoint Y travels with the media (part anchor)');
  const rp = e.getMemberProp(e.getMemberByName('club_sofa_a_0_2_1_2_0')!, 'regpoint') as {
    locH: number;
    locV: number;
  };
  assert.equal(rp.locH, 35, 'regpoint getter exposes the anchor the sprite pivots at');
  assert.equal(rp.locV, 39, 'regpoint getter exposes the anchor the sprite pivots at');
});

test('media copy + rename-to-EMPTY clear a recycled bin member\'s stale art (window GUI must not leak onto furniture copies)', () => {
  // Bin members are recycled through pBmpMemNumList: windows free their
  // element buffers on close by renaming them EMPTY, and the next
  // copyMemberToBin / createMember reuses the NUMBER. A reused member that
  // still carries its previous painted LImage (or raw bytes) serves the OLD
  // art — memberImage prefers an existing .image over .raw, so a furniture
  // icon copied onto a freed window-element number rendered the window GUI
  // sprite (the "sound machine gui sprite on hand icons / furniture
  // shadows" corruption). Both the rename-to-EMPTY and the media copy must
  // drop the member's content.
  const e = new DirectorEngine();
  const src = new Member(1, 1, 'md_sofa_a_0_2_1_2_0', 'bitmap');
  src.raw = buildPng(3, 2, new Array(3 * 2 * 4).fill(255));
  const cast = new CastLib(1, 'internal');
  cast.members.set(1, src);
  cast.byName.set('md_sofa_a_0_2_1_2_0', src);
  e.casts.push(cast);
  e.castByName.set('internal', cast);
  e.membersByGlobal.set((1 << 16) | 1, src);

  // Target = a bin member that lived as a window element buffer (painted
  // LImage, e.g. the 83x22 sound machine timeline strip).
  const tNum = e.createNamedMember('sound_machine_window_timeline', 'bitmap', 0);
  const dst = e.memberFor(e.getMember(tNum)!)!;
  const windowArt = new LImage(83, 22);
  windowArt.data = new Uint8Array(83 * 22 * 4).fill(255);
  e.setMemberProp(e.getMember(tNum)!, 'image', windowArt);
  assert.equal(dst.image?.width, 83, 'window element painted its buffer');
  assert.equal(dst.image?.height, 22);

  // removeMember: rename to EMPTY frees the number — the member must not keep
  // the window art (it would surface on the next reuse).
  e.setMemberProp(e.getMember(tNum)!, 'name', '');
  assert.equal(dst.image, undefined, 'rename-to-EMPTY drops the painted surface');
  const freedImg = e.getMemberProp(e.getMember(tNum)!, 'image') as LImage;
  assert.equal(freedImg.width, 0, 'freed member re-decodes nothing stale (empty surface)');

  // Reuse: copyMemberToBin media-copies the furniture source onto the freed
  // number. Even if a stale surface had survived, the media copy replaces the
  // whole content — the icon must render the SOURCE art, not old window art.
  const tNum2 = e.createNamedMember('club_sofa_a_0_2_1_2_0', 'bitmap', 0);
  const dst2 = e.memberFor(e.getMember(tNum2)!)!;
  const stale = new LImage(83, 22);
  stale.data = new Uint8Array(83 * 22 * 4).fill(255);
  e.setMemberProp(e.getMember(tNum2)!, 'image', stale);
  e.setMemberProp(e.getMemberByName('club_sofa_a_0_2_1_2_0')!, 'media', e.getMemberByName('md_sofa_a_0_2_1_2_0')!);
  assert.equal(dst2.image, undefined, 'media copy drops the stale painted surface');
  assert.equal(dst2.raw, src.raw, 'media copy sets the source payload');
  const img = e.getMemberProp(e.getMemberByName('club_sofa_a_0_2_1_2_0')!, 'image') as LImage;
  assert.equal(img.width, 3, 'icon renders the source art (3x2), not the 83x22 window art');
  assert.equal(img.height, 2);
});

test('member names keep underscores and resolve in both forms (cloud round-trip)', () => {
  // Entry Cloud Class reads pSprite.member.name and splits it on "_" to
  // rebuild the art name ("cloud_0_left"), then getmemnum(pMemName & "_" &
  // tdir) — so the STORED name must keep its underscores while lookups stay
  // tolerant of the space form (the visualizer text uses "Habbo UK garden").
  const e = new DirectorEngine();
  e.addScriptMember('cloud_0_left', 'score', 'on exitFrame\nend');
  const n = e.getmemnum('cloud_0_left');
  assert.equal(n, 65537); // cast 1 << 16 | 1 (Director slot number)
  assert.equal(e.getmemnum('cloud 0 left'), 65537); // space variant also hits
  const ref = e.getMember(n);
  assert.equal(ref?.name, 'cloud_0_left'); // stored form preserved for .item math
});

test('sprite locZ defaults to the channel number and VOID resets to it (window z-pool)', () => {
  // Director: a sprite's locZ defaults to its channel number. The FUSE Sprite
  // Manager restores it on release via `tsprite.locZ = VOID`, and window
  // content created after the Window Manager's Activate re-z pass keeps
  // stacking by channel — otherwise login_b's late panel/fields would sit at
  // z=0, behind its own opaque back/shadow (which Activate z'd at 5/6).
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const ch = e.getChannel(17);
  assert.equal(ch.locZ, 17); // fresh channel: default z = channel number
  assert.equal(e.getSpriteProp(e.getSprite(17), 'locZ'), 17);
  e.setSpriteProp(e.getSprite(17), 'locZ', VOID); // release path
  assert.equal(ch.locZ, 17); // VOID restores the channel-number default
  e.setSpriteProp(e.getSprite(17), 'locZ', 3); // explicit z sticks
  assert.equal(ch.locZ, 3);
  assert.equal(e.getSpriteProp(e.getSprite(17), 'locZ'), 3);
  e.setSpriteProp(e.getSprite(17), 'locZ', -19999987); // visualizer-style push-back
  assert.equal(ch.locZ, -19999987);
});

test('setMemberProp(image) copies the LImage (Common Button white fix)', () => {
  // FUSE Common Button does `pBuffer.image = pimage` then render() white-fills
  // the buffer and copyPixels the pieces back. Director copies on assign, so
  // the member owns its buffer; with a shared reference the fill wiped pimage
  // too and every button rendered pure white.
  const e = new DirectorEngine();
  const m = e.addScriptMember('Buf', 'unknown', '');
  m.kind = 'bitmap'; // window element buffer member
  const ref = e.getMember(m.number, m.castLibNumber)!;
  const art = new LImage(3, 3);
  art.fillRect(0, 0, 3, 3, new LColor(10, 200, 30));
  e.setMemberProp(ref, 'image', art);
  const stored = e.getMemberProp(ref, 'image') as LImage;
  assert.ok(stored instanceof LImage);
  assert.notEqual(stored, art, 'member owns a copy, not the caller reference');
  assert.equal(stored.width, 3);
  assert.equal(stored.height, 3);
  assert.equal(stored.data![0], 10); // copied pixel data
  assert.equal(stored.data![1], 200);
  // mutating the caller's image afterwards must not touch the member's buffer
  art.fillRect(0, 0, 3, 3, new LColor(255, 255, 255));
  const after = e.getMemberProp(ref, 'image') as LImage;
  assert.equal(after.data![0], 10, 'source mutation must not affect the stored copy');
});

test('the mouseH/mouseV/mouseLoc + the mouseDown/mouseUp track pointer state', () => {
  // Window Instance / Common Button gate clicks on the pointer: getThe needs
  // real mouse state (was: no getters at all -> the mouseUp redirect dead-end).
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  e.dispatchPointerEvent('mouseMove', 1, 123, 45);
  assert.equal(e.interp.evalExpressionString('the mouseH'), 123);
  assert.equal(e.interp.evalExpressionString('the mouseV'), 45);
  assert.equal(e.interp.evalExpressionString('the mouseDown'), 0);
  assert.equal(e.interp.evalExpressionString('the mouseUp'), 1);
  e.dispatchPointerEvent('mouseDown', 1, 123, 45);
  assert.equal(e.interp.evalExpressionString('the mouseDown'), 1);
  assert.equal(e.interp.evalExpressionString('the mouseUp'), 0);
  const loc = e.interp.evalExpressionString('the mouseLoc') as LPoint;
  assert.ok(loc instanceof LPoint);
  assert.equal(loc.locH, 123);
  assert.equal(loc.locV, 45);
  e.dispatchPointerEvent('mouseUp', 1, 123, 45);
  assert.equal(e.interp.evalExpressionString('the mouseDown'), 0);
});

test('navigator row math truncates on DirPlayer integer pointer coords (click lands on the row under the cursor)', () => {
  // U136 regression: the Navigator's `tClickedLine = integer(tParm.locV /
  // pListItemHeight) + 1` (Navigator Roomlist 0045:87) must resolve the row
  // UNDER the cursor. The click point comes from Image Wrapper's mouseUp:
  // `point(the mouseH - the locH of the pSprite of me + pOwnX + pOffX, ...)`
  // (0058:181-184). DirPlayer truncates pointer coords to i32 at the JS
  // boundary, so tParm.locV is an INTEGral pixel and `locV / 18` integer-
  // divides (27 / 18 = 1 -> row 2). A subpixel float (27.33) float-divides
  // (1.518) and the U128 rounding integer() rounds up to row 3 — one below.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  // Rows are 18px (Navigator Window 0040:34): row 2 spans locV 18-35.
  assert.equal(e.interp.evalExpressionString('integer(27 / 18) + 1'), 2, 'locV=27 (mid row 2) -> row 2');
  assert.equal(e.interp.evalExpressionString('integer(17 / 18) + 1'), 1, 'locV=17 (bottom of row 1) -> row 1');
  assert.equal(e.interp.evalExpressionString('integer(36 / 18) + 1'), 3, 'locV=36 (top of row 3) -> row 3');
  // The full click-point chain: Image Wrapper's point math on INTEGER mouse
  // coords stays integral, so the division truncates like DirPlayer.
  e.dispatchPointerEvent('mouseDown', 1, 517, 45);
  assert.equal(e.interp.evalExpressionString('the mouseH - 490 + 0'), 27);
});

test('the doubleClick tracks a second press within 500ms (furniture double-click actions)', () => {
  // Furniture classes gate double-click actions on `the doubleClick` (Sound
  // Machine state toggle, Bottle roll, E-Dice throw, Credit Furni). DirPlayer
  // parity: true from the 2nd mouseDown through that click's mouseUp.
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('the doubleClick'), 0);
  const realNow = Date.now;
  let fakeNow = 1000;
  Date.now = () => fakeNow;
  try {
    e.dispatchPointerEvent('mouseDown', 1, 10, 10); // t=1000
    assert.equal(e.interp.evalExpressionString('the doubleClick'), 0, 'first press is a single click');
    e.dispatchPointerEvent('mouseUp', 1, 10, 10);
    assert.equal(e.interp.evalExpressionString('the doubleClick'), 0, 'cleared after the first release');
    fakeNow += 600; // t=1600 — outside the 500ms window
    e.dispatchPointerEvent('mouseDown', 1, 10, 10);
    assert.equal(e.interp.evalExpressionString('the doubleClick'), 0, 'press 600ms later is a single click');
    e.dispatchPointerEvent('mouseUp', 1, 10, 10);
    fakeNow += 10; // t=1610 — within 500ms of the previous press
    e.dispatchPointerEvent('mouseDown', 1, 10, 10);
    assert.equal(e.interp.evalExpressionString('the doubleClick'), 1, 'second press within 500ms is a double click');
    e.dispatchPointerEvent('mouseUp', 1, 10, 10);
    assert.equal(e.interp.evalExpressionString('the doubleClick'), 0, 'cleared after the second release');
  } finally {
    Date.now = realNow;
  }
});

test('image.getPixel returns a color with hexString/#integer/paletteIndex (room click-through)', () => {
  // Room Interface validateEvent clicks THROUGH ink-36 matte white:
  //   tPixel = tSpr.member.image.getPixel(x - tSpr.left, y - tSpr.top)
  //   if tPixel.hexString() = "#FFFFFF" then ... pass the event to the sprite
  //   underneath. Object Mover compares getPixel() to paletteIndex(0), and
  //   Photo/sunsetcafe sample getPixel(x, y, #integer) (native value).
  const e = new DirectorEngine();
  assert.equal(
    e.interp.evalExpressionString('image(2, 2, 32).fill(rect(0, 0, 2, 2), rgb(255, 255, 255)).getPixel(1, 1).hexString()'),
    '#FFFFFF',
    'white pixel -> #FFFFFF (validateEvent click-through compare)',
  );
  assert.equal(
    e.interp.evalExpressionString('image(2, 2, 32).fill(rect(0, 0, 2, 2), rgb(255, 0, 0)).getPixel(0, 0, #integer)'),
    0xff0000,
    '#integer form returns 24-bit RGB on 32-bit art',
  );
  // DirPlayer get_pixel_color_ref: out of bounds returns the BACKGROUND color
  // (palette index 0 for palette art, white RGB otherwise) — never VOID, so a
  // click on a furniture sprite's edge (art smaller than the sprite rect)
  // reads as white -> click-through instead of a dead click (no select).
  assert.equal(
    e.interp.evalExpressionString('image(2, 2, 32).getPixel(9, 9).hexString()'),
    '#FFFFFF',
    'out of bounds -> background white (not VOID)',
  );
  // Palette art: getPixel resolves the pixel back to its palette index.
  const pal = e.addScriptMember('wall_pal', 'unknown', '');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[0] = [255, 255, 255];
  table[7] = [10, 20, 30];
  pal.palette = table;
  const c = e.interp.evalExpressionString(
    'image(1, 1, 8, member("wall_pal")).fill(rect(0, 0, 1, 1), rgb(10, 20, 30)).getPixel(0, 0)',
  ) as LColor;
  assert.ok(c instanceof LColor, 'getPixel returns a color');
  assert.equal(c.paletteIndex, 7, 'getPixel color carries the palette index (Photo Component sampling)');
  assert.equal(
    e.interp.evalExpressionString('image(1, 1, 8, member("wall_pal")).getPixel(0, 0, #integer)'),
    0,
    '8-bit #integer returns the palette index (index 0 = background white)',
  );
});

test('the rollover is a FRESH hit test — hiding the top sprite re-resolves it to the sprite below (furniture click-through)', () => {
  // Room Interface validateEvent / Room Hiliter redirectEvent hide the
  // rollover sprite (`tSpr.visible = 0`) then re-read `sprite(the rollover)`
  // expecting the sprite BELOW — the matte-white click-through that lets a
  // click on furniture art pass to the tile/wall behind. A cached "last
  // pointer event" channel re-dispatches to the just-hidden sprite and loops
  // forever (the hc_tv tile click died exactly that way).
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const bmp = (n: number, name: string, w: number, h: number, fill: number): Member => {
    const m = new Member(1, n, name, 'bitmap');
    const img = new LImage(w, h);
    img.data = new Uint8Array(w * h * 4).fill(fill);
    img.dirty = true;
    m.image = img;
    const cast = e.casts[0] ?? new CastLib(1, 'internal');
    cast.members.set(n, m);
    cast.byName.set(name, m);
    e.membersByGlobal.set((1 << 16) | n, m);
    return m;
  };
  bmp(1, 'tv_part', 8, 8, 255); // opaque white (ink-36 furniture)
  bmp(2, 'floor_tile', 64, 32, 255);
  // Tile (lower z) under the TV (higher z), both under the cursor.
  e.setSpriteProp(e.getSprite(10), 'castNum', (1 << 16) | 2);
  e.setSpriteProp(e.getSprite(10), 'locH', 100);
  e.setSpriteProp(e.getSprite(10), 'locV', 100);
  e.setSpriteProp(e.getSprite(10), 'ink', 0);
  e.setSpriteProp(e.getSprite(10), 'locZ', 5);
  e.setSpriteProp(e.getSprite(11), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(11), 'locH', 104);
  e.setSpriteProp(e.getSprite(11), 'locV', 104);
  e.setSpriteProp(e.getSprite(11), 'ink', 36);
  e.setSpriteProp(e.getSprite(11), 'locZ', 10);
  e.dispatchPointerEvent('mouseMove', 11, 108, 108);
  assert.equal(e.interp.evalExpressionString('the rollover'), 11, 'TV on top under the cursor');
  // The validateEvent pattern: hide the TV, re-read `the rollover` -> the tile.
  e.setSpriteProp(e.getSprite(11), 'visible', 0);
  assert.equal(e.interp.evalExpressionString('the rollover'), 10, 'hidden sprite falls through to the tile below');
  e.setSpriteProp(e.getSprite(11), 'visible', 1);
  e.dispatchPointerEvent('mouseMove', 0, 10, 10);
  assert.equal(e.interp.evalExpressionString('the rollover'), 0, 'mouse off everything -> 0');
  // Ink-8 matte: only opaque pixels accept the rollover (window chrome).
  const win = bmp(3, 'window_panel', 4, 4, 0);
  win.image!.data![3] = 255; // top-left opaque only
  win.image!.dirty = true;
  e.setSpriteProp(e.getSprite(12), 'castNum', (1 << 16) | 3);
  e.setSpriteProp(e.getSprite(12), 'locH', 200);
  e.setSpriteProp(e.getSprite(12), 'locV', 200);
  e.setSpriteProp(e.getSprite(12), 'ink', 8);
  e.setSpriteProp(e.getSprite(12), 'locZ', 20);
  e.dispatchPointerEvent('mouseMove', 12, 200, 200);
  assert.equal(e.interp.evalExpressionString('the rollover'), 12, 'opaque ink-8 pixel accepts');
  e.dispatchPointerEvent('mouseMove', 12, 203, 203);
  assert.equal(e.interp.evalExpressionString('the rollover'), 0, 'transparent ink-8 pixel falls through');
});

test('mouseWithin fires while the cursor stays over a sprite (dropmenu rollover highlight)', () => {
  // The DropDown Class's `on mouseWithin` computes pRollOverItem from the
  // cursor and paints the highlight — without it the open menu never
  // highlighted an option, pRollOverItem stayed VOID, and clicks closed the
  // menu without selecting (which re-opened + re-ordered it — the dropdown
  // "jumped"). DirPlayer dispatches mouseWithin on each pointer move over the
  // same sprite (events.rs dispatch_rollover_events); we used to only send
  // mouseEnter/mouseLeave transitions, so the Event Broker's mouseWithin
  // redirect never ran.
  const e = new DirectorEngine();
  const mem = e.addScriptMember('B', 'parent', [
    'property pCount',
    'on mouseWithin me',
    '  pCount = pCount + 1',
    'end',
    'on mouseEnter me',
    '  pCount = pCount + 100',
    'end',
    'on mouseLeave me',
    '  pCount = pCount + 1000',
    'end',
  ].join('\n'));
  const script = mem.script!;
  const obj = e.interp.makeInstance(script, 'B');
  e.getChannel(5).scriptInstanceList = new LList([obj]);
  e.dispatchPointerEvent('mouseMove', 5, 10, 10); // enter 5
  e.dispatchPointerEvent('mouseMove', 5, 12, 12); // within 5
  e.dispatchPointerEvent('mouseMove', 5, 14, 14); // within 5
  e.dispatchPointerEvent('mouseMove', 6, 14, 14); // leave 5, enter 6
  assert.equal(obj.props.get('pCount'), 1102, 'mouseEnter(100) + 2×mouseWithin(2) + mouseLeave(1000)');
  e.dispatchPointerEvent('mouseMove', 6, 16, 16); // within 6 -> no call on 5
  assert.equal(obj.props.get('pCount'), 1102, 'same-sprite move fires mouseWithin only on the hovered channel');
});

test('rollover(n) is a DIRECT hit test of that sprite, ignoring z-order (E-Dice lower part)', () => {
  // E-Dice select checks `rollover(me.pSprList[2])` (its LOWER part) while the
  // die (upper part) is under the cursor — DirPlayer implements rollover(n) as
  // concrete_sprite_hit_test(sprite n), independent of what is stacked above.
  // Comparing against the topmost rollover picked the wrong branch.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const m = new Member(1, 1, 'dice_part', 'bitmap');
  const img = new LImage(10, 10);
  img.data = new Uint8Array(10 * 10 * 4).fill(255);
  img.dirty = true;
  m.image = img;
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  cast.members.set(1, m);
  cast.byName.set('dice_part', m);
  e.membersByGlobal.set((1 << 16) | 1, m);
  e.setSpriteProp(e.getSprite(20), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(20), 'locH', 100);
  e.setSpriteProp(e.getSprite(20), 'locV', 100);
  e.setSpriteProp(e.getSprite(20), 'locZ', 5); // lower part
  e.setSpriteProp(e.getSprite(21), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(21), 'locH', 100);
  e.setSpriteProp(e.getSprite(21), 'locV', 100);
  e.setSpriteProp(e.getSprite(21), 'locZ', 10); // upper part (die) on top
  e.dispatchPointerEvent('mouseMove', 21, 105, 105);
  assert.equal(e.interp.evalExpressionString('the rollover'), 21, 'topmost is the die');
  assert.equal(e.interp.evalExpressionString('rollover(20)'), 1, 'lower part is directly hit even under the die');
  assert.equal(e.interp.evalExpressionString('rollover(21)'), 1, 'die itself is hit');
  assert.equal(e.interp.evalExpressionString('rollover(22)'), 0, 'empty channel not hit');
});

test('the clickOn is the topmost sprite at the last mouseDown (Club TV bottom-part walk)', () => {
  // Furniture Club TV select: `tSprNum = the clickOn` then double-click on the
  // bottom/stand parts (pSprList 3-5) returns 0 -> walk to the floor instead
  // of toggling the TV. DirPlayer sets click_on_sprite to get_sprite_at(
  // scripted=false) on mouseDown and keeps it through the release.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const m = new Member(1, 1, 'tv_stand', 'bitmap');
  const img = new LImage(8, 8);
  img.data = new Uint8Array(8 * 8 * 4).fill(255);
  img.dirty = true;
  m.image = img;
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  cast.members.set(1, m);
  cast.byName.set('tv_stand', m);
  e.membersByGlobal.set((1 << 16) | 1, m);
  e.setSpriteProp(e.getSprite(30), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(30), 'locH', 100);
  e.setSpriteProp(e.getSprite(30), 'locV', 100);
  e.setSpriteProp(e.getSprite(31), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(31), 'locH', 120);
  e.setSpriteProp(e.getSprite(31), 'locV', 100);
  assert.equal(e.interp.evalExpressionString('the clickOn'), 0, 'cleared before any press');
  e.dispatchPointerEvent('mouseDown', 30, 105, 105);
  assert.equal(e.interp.evalExpressionString('the clickOn'), 30, 'topmost sprite at the press');
  e.dispatchPointerEvent('mouseUp', 30, 105, 105);
  assert.equal(e.interp.evalExpressionString('the clickOn'), 30, 'kept through the release (select reads it on mouseUp)');
  e.dispatchPointerEvent('mouseDown', 31, 125, 105);
  assert.equal(e.interp.evalExpressionString('the clickOn'), 31, 're-sets on the next press');
});

test('list.count() method (SoundMachine getSoundListPageCount paging)', () => {
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('[1, 2, 3].count()'), 3, 'list.count() returns the element count');
  assert.equal(e.interp.evalExpressionString('[:].count()'), 0, 'empty list counts 0');
});

test('sprite behaviors get spriteNum and receive sprite messages (Event Broker click chain)', () => {
  // FUSE Sprite Manager wires an Event Broker into each element sprite's
  // scriptInstanceList; the broker's redirectEvent uses `me.id` (set via
  // `tsprite.setID(tid)`) as the element id, and the window's mouseUp procs
  // fire only after a mouseDown set pClickPass. Every sprite message must
  // dispatch to the behavior list first (Director), and attach must stamp
  // spriteNum so the broker's `sprite(me.spriteNum)` lands on the right ch.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Broker',
    'movie',
    [
      'on new me',
      '  return me',
      'end',
      'on setID me, tid',
      '  me.id = tid',
      'end',
      'on mouseEnter me',
      '  me.entered = 1',
      'end',
      'on mouseLeave me',
      '  me.left = 1',
      'end',
    ].join('\n'),
  );
  const broker = e.interp.evalExpressionString('new(script("Broker"))') as LObject;
  assert.ok(broker instanceof LObject);
  const s = e.getSprite(55);
  e.setSpriteProp(s, 'scriptInstanceList', new LList([broker]));
  assert.equal(broker.props.get('spriteNum'), 55, 'behaviors get their spriteNum on attach');
  e.spriteMethod(s, 'setID', [new LSymbol('login_ok')]);
  const id = broker.props.get('id');
  assert.ok(id instanceof LSymbol && (id as LSymbol).name === 'login_ok', 'setID ran on the behavior');
  // rollover transitions fire mouseEnter/mouseLeave on the behavior list
  e.dispatchPointerEvent('mouseMove', 55, 10, 10);
  assert.equal(broker.props.get('entered'), 1);
  e.dispatchPointerEvent('mouseMove', 1, 10, 10);
  assert.equal(broker.props.get('left'), 1);
});

test('stopEvent() halts only the current dispatch chain (U119 room re-entry dead clicks)', () => {
  // Repro of the re-entered-room bug: the click that triggers the room entry
  // ends with a broker's stopEvent() (Event Broker 0003 calls it when its
  // redirect returns truthy). engine._stopEventPending then stayed set until
  // the NEXT pointer event — but the room build's sprite-method dispatches
  // (setID, registerProcedure) run BETWEEN events, so dispatchToChannelHandlers
  // broke on the first item and the floor broker was never wired (instId=0 /
  // proc empty -> every click in the re-entered room silently dead). stopEvent
  // must not leak out of the event that called it.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Broker',
    'movie',
    [
      'on new me',
      '  return me',
      'end',
      'on setID me, tid',
      '  me.id = tid',
      'end',
      'on registerProcedure me, tMethod, tClientID, tEvent',
      '  me.proc = [tMethod, tClientID]',
      'end',
      'on mouseDown me',
      '  me.hit = 1',
      '  stopEvent()',
      '  return 1',
      'end',
      'on keyDown me',
      '  me.key = 1',
      '  stopEvent()',
      '  return 1',
      'end',
    ].join('\n'),
  );
  const broker = e.interp.evalExpressionString('new(script("Broker"))') as LObject;
  assert.ok(broker instanceof LObject);
  const s = e.getSprite(55);
  e.setSpriteProp(s, 'scriptInstanceList', new LList([broker]));
  assert.equal(broker.props.get('spriteNum'), 55, 'behaviors get their spriteNum on attach');

  // A pointer event whose behavior chain ends in stopEvent().
  e.dispatchPointerEvent('mouseDown', 55, 10, 10);
  assert.equal(broker.props.get('hit'), 1, 'the click ran the behavior');

  // The room build's sprite-method wiring runs between events — it must reach
  // the behavior even though the last event called stopEvent().
  e.spriteMethod(s, 'setID', [new LSymbol('room_visualizer')]);
  const id = broker.props.get('id');
  assert.ok(
    id instanceof LSymbol && (id as LSymbol).name === 'room_visualizer',
    'setID reached the behavior after a stopEvent() click',
  );
  e.spriteMethod(s, 'registerProcedure', [new LSymbol('eventProcRoom'), 'room_interface', new LSymbol('mouseDown')]);
  const proc = broker.props.get('proc');
  assert.ok(proc instanceof LList && proc.items.length === 2, 'registerProcedure reached the behavior too');

  // Key events behave the same: a stopEvent() keyDown must not leak either.
  e.setThe('keyboardfocussprite', [], 55);
  e.dispatchKeyEvent('keyDown', 'x', 88);
  assert.equal(broker.props.get('key'), 1, 'the keyDown ran the behavior');
  e.spriteMethod(s, 'setID', [new LSymbol('after_key')]);
  const id2 = broker.props.get('id');
  assert.ok(
    id2 instanceof LSymbol && (id2 as LSymbol).name === 'after_key',
    'setID reached the behavior after a stopEvent() keyDown',
  );
});

test('the keyboardFocusSprite get+set and the key/keyCode/keyDown/keyUp state', () => {
  // Field Wrapper setFocus writes `the keyboardFocusSprite = me.pSprite.spriteNum`
  // (was a silent no-op) and the Event Broker gates keyDown on it; the corpus
  // never reads `the key`, but real Lingo has it, so the engine must too.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Focus',
    'movie',
    ['on run me', '  the keyboardFocusSprite = 12', '  return the keyboardFocusSprite', 'end'].join('\n'),
  );
  const s = e.resolveScript('Focus')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), 12);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 12);
  e.dispatchKeyEvent('keyDown', 'a', 65);
  assert.equal(e.interp.evalExpressionString('the key'), 'a');
  // Browser keyCode 65 ('a') is Director keyCode 0 (DirPlayer keyboard_map).
  assert.equal(e.interp.evalExpressionString('the keyCode'), 0);
  assert.equal(e.interp.evalExpressionString('the keyDown'), 1);
  assert.equal(e.interp.evalExpressionString('the keyUp'), 0);
  assert.equal(e.interp.evalExpressionString('the keyPressed'), 'a');
  e.dispatchKeyEvent('keyUp', 'a', 65);
  assert.equal(e.interp.evalExpressionString('the keyDown'), 0);
  assert.equal(e.interp.evalExpressionString('the keyUp'), 1);
  // `the keyPressed` = most recently held key, EMPTY once nothing is held
  assert.equal(e.interp.evalExpressionString('the keyPressed'), '');
});

test('string = comparison is case-insensitive (pool dive keymap)', () => {
  // The pool diving game's keymap (swimjump.key.list in external_vars) is
  // UPPERCASE ("A","D",...) while `the key` reports the lowercase char the
  // browser sends — registration's permitted.name.chars (lowercase) proves
  // `the key` is lowercase. Director string equality ignores case, so
  // translateKey's `tPelleKey = pPelleKeys[i]` must match 'a' to "A" for the
  // run keys to work (compareLingo already lowercases for < >; lingoEquals
  // must do the same for = / <>).
  const e = new DirectorEngine();
  assert.equal(e.interp.evalExpressionString('"a" = "A"'), 1);
  assert.equal(e.interp.evalExpressionString('"A" <> "a"'), 0);
  assert.equal(e.interp.evalExpressionString('"d" = "D"'), 1);
  assert.equal(e.interp.evalExpressionString('"dive" = "DIVE"'), 1);
  assert.equal(e.interp.evalExpressionString('"x" = "y"'), 0);
});

test('web keyCodes translate to Director keyCodes (chat "l" sends bug)', () => {
  // The room chat handler sends on `case the keyCode of 36, 76:` (Director
  // Return codes). The browser reports the letter 'l' as keyCode 76 — without
  // the web→Director translation, every 'l' keystroke matched Director's
  // Return-76 and sent the chat text mid-typing. Director's code for 'l' is
  // 37 and Return is 36, so typing must not hit the send path.
  const e = new DirectorEngine();
  e.dispatchKeyEvent('keyDown', 'l', 76);
  assert.equal(e.interp.evalExpressionString('the keyCode'), 37); // Director 'l'
  assert.equal(e.interp.evalExpressionString('the key'), 'l');
  e.dispatchKeyEvent('keyUp', 'l', 76);
  e.dispatchKeyEvent('keyDown', 'Enter', 13);
  assert.equal(e.interp.evalExpressionString('the keyCode'), 36); // Director Return
  assert.equal(e.interp.evalExpressionString('the key'), '\r');
  assert.equal(e.interp.evalExpressionString('the keyPressed'), '\r');
  e.dispatchKeyEvent('keyUp', 'Enter', 13);
  assert.equal(e.interp.evalExpressionString('the keyPressed'), '');
  // Backspace is Director 51; the diving game's Pelle KeyDown polls
  // `the keyPressed <> EMPTY` to drive the jump input.
  e.dispatchKeyEvent('keyDown', 'Backspace', 8);
  assert.equal(e.interp.evalExpressionString('the keyCode'), 51);
  assert.equal(e.interp.evalExpressionString('the key'), '\b');
});

test('typing goes into the focused editable field member (Director native editing)', () => {
  // Field Wrapper prepare sets `pMember.editable = 1` on the dynamic field and
  // setFocus points `the keyboardFocusSprite` at its sprite; Director then
  // edits the member text natively — no corpus key handler exists.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const m = e.addScriptMember('Fld', 'unknown', '');
  m.kind = 'text'; // dynamic field member
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'editable', 1);
  e.setSpriteProp(e.getSprite(12), 'member', ref);
  e.setThe('keyboardfocussprite', [], 12);
  e.dispatchKeyEvent('keyDown', 'h', 72);
  e.dispatchKeyEvent('keyDown', 'i', 73);
  assert.equal(e.getMemberProp(ref, 'text'), 'hi');
  // non-editable members ignore keystrokes
  e.setMemberProp(ref, 'editable', 0);
  e.dispatchKeyEvent('keyDown', 'x', 88);
  assert.equal(e.getMemberProp(ref, 'text'), 'hi');
  // backspace trims the last char
  e.setMemberProp(ref, 'editable', 1);
  e.dispatchKeyEvent('keyDown', 'Backspace', 8);
  assert.equal(e.getMemberProp(ref, 'text'), 'h');
  // a focused non-text sprite is untouched
  e.setMemberProp(ref, 'editable', 0);
  e.setSpriteProp(e.getSprite(12), 'member', 0);
  e.dispatchKeyEvent('keyDown', 'q', 81);
  assert.equal(e.getMemberProp(ref, 'text'), 'h');
});

test('keyDown dispatches to the focused sprite behavior list (Event Broker gate)', () => {
  // Event Broker keyDown: `if me.pSprite.spriteNum <> the keyboardFocusSprite
  // then return 1` — the gate must pass for the focused sprite, and the key
  // must be visible as `the key` inside the handler.
  const e = new DirectorEngine();
  e.addScriptMember(
    'KBroker',
    'movie',
    ['on new me', '  return me', 'end', 'on keyDown me', '  me.focusAtDown = the keyboardFocusSprite', '  me.hadKey = the key', '  return 1', 'end'].join('\n'),
  );
  const broker = e.interp.evalExpressionString('new(script("KBroker"))') as LObject;
  e.setSpriteProp(e.getSprite(12), 'scriptInstanceList', new LList([broker]));
  e.setThe('keyboardfocussprite', [], 12);
  e.dispatchKeyEvent('keyDown', 'q', 81);
  assert.equal(broker.props.get('focusAtDown'), 12);
  assert.equal(broker.props.get('hadKey'), 'q');
});

test('mouseUp outside the down channel fires mouseUpOutSide (drag release)', () => {
  // Window Instance mouseUpOutSide does `me.drag(0)` so releasing outside the
  // window ends the drag; the down-sprite's behavior must get mouseUpOutSide.
  const e = new DirectorEngine();
  e.addScriptMember(
    'DBroker',
    'movie',
    ['on new me', '  return me', 'end', 'on mouseUpOutSide me', '  me.outside = 1', 'end'].join('\n'),
  );
  const broker = e.interp.evalExpressionString('new(script("DBroker"))') as LObject;
  e.setSpriteProp(e.getSprite(7), 'scriptInstanceList', new LList([broker]));
  e.dispatchPointerEvent('mouseDown', 7, 10, 10);
  e.dispatchPointerEvent('mouseUp', 1, 10, 10); // released over a different channel
  assert.equal(broker.props.get('outside'), 1);
  // same-channel up does NOT fire mouseUpOutSide
  const broker2 = e.interp.evalExpressionString('new(script("DBroker"))') as LObject;
  e.setSpriteProp(e.getSprite(8), 'scriptInstanceList', new LList([broker2]));
  e.dispatchPointerEvent('mouseDown', 8, 10, 10);
  e.dispatchPointerEvent('mouseUp', 8, 10, 10);
  assert.equal(broker2.props.get('outside'), undefined);
  // release over the EMPTY stage (channel 0) also fires mouseUpOutSide
  const broker3 = e.interp.evalExpressionString('new(script("DBroker"))') as LObject;
  e.setSpriteProp(e.getSprite(9), 'scriptInstanceList', new LList([broker3]));
  e.dispatchPointerEvent('mouseDown', 9, 10, 10);
  e.dispatchPointerEvent('mouseUp', 0, 300, 200);
  assert.equal(broker3.props.get('outside'), 1);
});

test('clicking a non-editable sprite or the empty stage clears field focus', () => {
  // Director: keyboardFocusSprite drops to 0 when the user clicks a button,
  // the drag bar, or nothing at all — typing then goes nowhere.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const m = e.addScriptMember('Fld', 'unknown', '');
  m.kind = 'text';
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'editable', 1);
  e.setSpriteProp(e.getSprite(12), 'member', ref);
  e.dispatchPointerEvent('mouseDown', 12, 10, 10);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 12);
  // click a non-editable sprite (ch 13 has no editable member)
  e.setSpriteProp(e.getSprite(13), 'member', 0);
  e.dispatchPointerEvent('mouseDown', 13, 10, 10);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 0);
  // re-focus then click the empty stage
  e.dispatchPointerEvent('mouseDown', 12, 10, 10);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 12);
  e.dispatchPointerEvent('mouseDown', 0, 400, 300);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 0);
});

test('stopEvent() halts the dispatch chain (behaviors + field insertion)', () => {
  // Event Broker consumes a click/keypress with stopEvent() — lower behaviors
  // must not run, and the focused editable field must not receive the char.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  e.addScriptMember(
    'Stopper',
    'movie',
    ['on new me', '  return me', 'end', 'on mouseDown me', '  me.ran = 1', '  stopEvent()', 'end'].join('\n'),
  );
  e.addScriptMember(
    'Lower',
    'movie',
    ['on new me', '  return me', 'end', 'on mouseDown me', '  me.ran = 1', 'end'].join('\n'),
  );
  const stopper = e.interp.evalExpressionString('new(script("Stopper"))') as LObject;
  const lower = e.interp.evalExpressionString('new(script("Lower"))') as LObject;
  e.setSpriteProp(e.getSprite(7), 'scriptInstanceList', new LList([stopper, lower]));
  e.dispatchPointerEvent('mouseDown', 7, 10, 10);
  assert.equal(stopper.props.get('ran'), 1);
  assert.equal(lower.props.get('ran'), undefined, 'lower behavior must not run');
  // stopEvent in keyDown also skips the native field insertion
  e.addScriptMember(
    'KStopper',
    'movie',
    ['on new me', '  return me', 'end', 'on keyDown me', '  me.hadKey = the key', '  stopEvent()', 'end'].join('\n'),
  );
  const kstopper = e.interp.evalExpressionString('new(script("KStopper"))') as LObject;
  const m = e.addScriptMember('Fld', 'unknown', '');
  m.kind = 'text';
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'editable', 1);
  e.setSpriteProp(e.getSprite(12), 'member', ref);
  e.setSpriteProp(e.getSprite(12), 'scriptInstanceList', new LList([kstopper]));
  e.setThe('keyboardfocussprite', [], 12);
  e.dispatchKeyEvent('keyDown', 'x', 88);
  assert.equal(kstopper.props.get('hadKey'), 'x');
  assert.equal(e.getMemberProp(ref, 'text'), '', 'stopEvent must skip field insertion');
});

test('the locH of sprite(n) reads the sprite prop (Image Wrapper drag math)', () => {
  // Image Wrapper getOffset does `the locH of the pSprite of me` — the element's
  // pSprite is a sprite REF, so `the locH of sprite(n)` must resolve (was:
  // 'the locH of ...: unsupported [the(arg)]' every drag).
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  e.setSpriteProp(e.getSprite(56), 'locH', 101);
  e.setSpriteProp(e.getSprite(56), 'locV', 202);
  assert.equal(e.interp.evalExpressionString('the locH of sprite(56)'), 101);
  assert.equal(e.interp.evalExpressionString('the locV of sprite(56)'), 202);
});

test('pass() and stopEvent() are no-ops (Event Broker event control)', () => {
  // Event Broker mouseDown/keyDown call stopEvent()/pass() — Director keywords
  // that must not warn 'unresolved handler/builtin' on every click/keypress.
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  assert.equal(e.interp.evalExpressionString('pass()'), VOID);
  assert.equal(e.interp.evalExpressionString('stopEvent()'), VOID);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')), 'pass/stopEvent must not warn');
});

test('unhandled sprite events are silent (Director dispatch, not errors)', () => {
  // The broker redirects every mouse/key event to window elements — a Field
  // Wrapper has no #keyDown/#mouseDown handler, and real Director ignores
  // unhandled event messages silently (was: warn per keystroke).
  const e = new DirectorEngine();
  e.addScriptMember('Plain', 'movie', ['on new me', '  return me', 'end'].join('\n'));
  e.addScriptMember(
    'T',
    'movie',
    ['on run me', '  tObj = new(script("Plain"))', '  t1 = call(#keyDown, tObj)', '  t2 = call(#mouseDown, tObj)', '  return 1', 'end'].join('\n'),
  );
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  e.interp.callHandler(s, run, [], null, new Set());
  assert.ok(!e.logs.some((l) => l.includes('has no handler')), 'unhandled events must be silent');
});

test('call() with a VOID handler is a silent no-op (stale delay after deconstruct)', () => {
  // Object Base Class executeDelay fires `call(tTask[#method], me, ...)` where
  // tTask is VOID when the timeout outlived its owner — the corpus's
  // deconstruct forget() passes the task LIST (getPropAt value) instead of the
  // delay key, so the real timeout survives and fires stale after `delays = [:]`.
  // LibreShockwave call(): a VOID handler name stringifies to "" and the
  // dispatch misses silently (returns VOID, no diagnostic). Was: warn per boot.
  const e = new DirectorEngine();
  e.addScriptMember('Plain', 'movie', 'on new me\n  return me\nend');
  const s = e.resolveScript('Plain')!;
  const obj = e.interp.newInstance(s, []);
  const before = e.logs.length;
  const r = e.interp.callBuiltin([VOID, obj, 7]);
  assert.equal(r, VOID);
  assert.ok(
    !e.logs.slice(before).some((l) => l.includes('[warn]')),
    'call(VOID, ...) must be a silent no-op',
  );
});

test('mouseDown on an editable text member focuses it (click-to-focus)', () => {
  // Director focuses an editable field on click; the corpus only auto-focuses
  // the first field at login build, so the engine must move keyboardFocusSprite
  // when a field sprite is clicked (was: focus only from the build, no way to
  // switch fields by clicking).
  const e = new DirectorEngine();
  e.addScriptMember('Setup', 'score', 'on exitFrame\nend');
  const m = e.addScriptMember('Fld2', 'unknown', '');
  m.kind = 'text';
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'editable', 1);
  e.setSpriteProp(e.getSprite(12), 'member', ref);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 0);
  e.dispatchPointerEvent('mouseDown', 12, 10, 10);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 12);
  // Director drops focus to 0 when a non-editable sprite is clicked (the
  // Event Broker then ignores keystrokes until a field is clicked again)
  e.setMemberProp(ref, 'editable', 0);
  e.setSpriteProp(e.getSprite(13), 'member', ref);
  e.dispatchPointerEvent('mouseDown', 13, 10, 10);
  assert.equal(e.interp.evalExpressionString('the keyboardFocusSprite'), 0);
});

test('text channel visual carries the sprite ink (adapter skips bg for transparency inks)', () => {
  // Login fields are editable text members with ink 36 — the pixi text branch
  // must NOT draw the white bgColor rect over the field's custom image art.
  const calls: { ch: number; kind: string; ink?: number }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; ink?: number } | null) {
      calls.push(v ? { ch, kind: v.kind, ink: v.ink } : { ch, kind: 'null' });
    },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('Fld', 'unknown', '');
  m.kind = 'text';
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'rect', new LRect(0, 0, 100, 20));
  e.setMemberProp(ref, 'bgcolor', new LColor(255, 255, 255));
  const s = { channel: 9, script: null };
  e.setSpriteProp(s, 'member', (m.castLibNumber << 16) | m.number);
  e.getChannel(9).ink = 36;
  e.flushChannelVisuals();
  const hit = calls.find((c) => c.ch === 9 && c.kind === 'text');
  assert.ok(hit, `expected 9:text, got ${calls.map((c) => `${c.ch}:${c.kind}`).join(', ')}`);
  assert.equal(hit!.ink, 36, 'text visual must expose the channel ink');
});

test('ink 9 (Mask): channel visual carries the NEXT member as maskBytes (pool water)', () => {
  // The pool water (vesi1, ink 9) renders through vesimask1 — the next bitmap
  // in the same cast — as a grayscale alpha mask. buildChannelVisual must
  // resolve the mask member and hand its raw PNG + reg point to the stage, or
  // the water shows as a solid rectangle (the hh_room_pool blue slab).
  // Director's rule is member + 1 (no name convention): the dumper re-exports
  // members under their real Lingo numbers, so the pool pairs stay adjacent
  // (vesi1=84->vesimask1=85, vesi2=89->vesimask2=90, dew_vesi1=33->
  // dew_vesimask1=34 in the real casts).
  const calls: { ch: number; kind: string; maskBytes?: Uint8Array; maskRegX?: number; maskRegY?: number }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; maskBytes?: Uint8Array; maskRegX?: number; maskRegY?: number } | null) {
      calls.push(v ? { ch, kind: v.kind, maskBytes: v.maskBytes, maskRegX: v.maskRegX, maskRegY: v.maskRegY } : { ch, kind: 'null' });
    },
  };
  const e = new DirectorEngine(adapter as never);
  const water = e.addScriptMember('vesi1', 'unknown', '');
  water.kind = 'bitmap';
  water.raw = buildPng(2, 2, [0, 128, 255, 255, 0, 128, 255, 255, 0, 128, 255, 255, 0, 128, 255, 255]);
  water.regX = 1;
  water.regY = 1;
  const mask = e.addScriptMember('vesimask1', 'unknown', '');
  mask.kind = 'bitmap';
  mask.raw = buildPng(2, 2, [255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  mask.regX = 1;
  mask.regY = 1;

  const s = { channel: 5, script: null };
  e.setSpriteProp(s, 'member', (water.castLibNumber << 16) | water.number);
  e.setSpriteProp(s, 'ink', 9);
  e.flushChannelVisuals();
  const hit = calls.find((c) => c.ch === 5);
  assert.ok(hit, `expected 5:bitmap, got ${calls.map((c) => `${c.ch}:${c.kind}`).join(', ')}`);
  assert.ok(hit!.maskBytes, 'ink-9 visual must carry the mask bytes');
  assert.equal(hit!.maskBytes, mask.raw, 'mask bytes are the next member (vesimask1)');
  assert.equal(hit!.maskRegX, 1, 'mask reg point rides along for alignment');
  assert.equal(hit!.maskRegY, 1);

  // Member+1 is the ONLY rule — a sibling member named "vesi3" whose +1 is an
  // unrelated bitmap must use THAT bitmap as the mask, even when a
  // "vesimask3" exists later in the cast (Director has no name convention;
  // the old vesi->vesimask fallback must not override adjacency).
  const water3 = e.addScriptMember('vesi3', 'unknown', '');
  water3.kind = 'bitmap';
  water3.raw = buildPng(1, 1, [0, 128, 255, 255]);
  const unrelated = e.addScriptMember('not_a_mask_part', 'unknown', '');
  unrelated.kind = 'bitmap';
  unrelated.raw = buildPng(1, 1, [1, 2, 3, 255]);
  const mask3 = e.addScriptMember('vesimask3', 'unknown', '');
  mask3.kind = 'bitmap';
  mask3.raw = buildPng(1, 1, [0, 0, 0, 255]);
  const s3 = { channel: 6, script: null };
  e.setSpriteProp(s3, 'member', (water3.castLibNumber << 16) | water3.number);
  e.setSpriteProp(s3, 'ink', 9);
  e.flushChannelVisuals();
  const hit3 = calls.find((c) => c.ch === 6);
  assert.ok(hit3 && hit3.maskBytes, 'ink-9 visual must carry the mask bytes');
  assert.equal(hit3!.maskBytes, unrelated.raw, 'member+1 wins: the mask is the NEXT member, not the vesimask* name');

  // Member+1 with nothing after it (no bitmap): unmasked.
  const water4 = e.addScriptMember('vesi4', 'unknown', '');
  water4.kind = 'bitmap';
  water4.raw = buildPng(1, 1, [0, 128, 255, 255]);
  const s4 = { channel: 8, script: null };
  e.setSpriteProp(s4, 'member', (water4.castLibNumber << 16) | water4.number);
  e.setSpriteProp(s4, 'ink', 9);
  e.flushChannelVisuals();
  const hit4 = calls.find((c) => c.ch === 8);
  assert.ok(hit4 && !hit4.maskBytes, 'no next member -> ink-9 renders unmasked');

  // Non-ink-9 bitmap: no mask bytes at all.
  const s2 = { channel: 7, script: null };
  e.setSpriteProp(s2, 'member', (water3.castLibNumber << 16) | water3.number);
  e.setSpriteProp(s2, 'ink', 0);
  e.flushChannelVisuals();
  const hit2 = calls.find((c) => c.ch === 7);
  assert.ok(hit2 && !hit2.maskBytes, 'ink-0 bitmap carries no mask');
});

test('set .red/.green/.blue on a color mutates it (balloon darken)', () => {
  // Balloon Manager createballoonImg (0005) darkens bright bubble colors:
  //   tBalloonColorDarken = rgb(0, 0, 0)
  //   tBalloonColorDarken.red = tBalloonColor.red * 0.9
  //   tBalloonColorDarken.green = tBalloonColor.green * 0.9
  //   tBalloonColorDarken.blue = tBalloonColor.blue * 0.9
  // The engine warned "cannot set red on color(0, 0, 0)" and left the color
  // black — bot/pet bubbles (bright chat colors, sum >= 600) rendered black.
  // Director: color channels are settable, clamped to 0-255.
  const e = new DirectorEngine();
  e.addScriptMember('ColorT', 'unknown', [
    'on run me',
    '  c = rgb(0, 0, 0)',
    '  c.red = 100',
    '  c.green = 150',
    '  c.blue = 200',
    '  r = c.red * 1000000 + c.green * 1000 + c.blue',
    '  c2 = rgb(0, 0, 0)',
    '  c2.red = 300',
    '  c2.blue = -5',
    '  return r * 1000000 + c2.red * 1000 + c2.blue',
    'end',
  ].join('\n'));
  const script = e.resolveScript('ColorT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  // 100/150/200 -> 100150200; clamp: 300->255, -5->0 -> 255000.
  assert.equal(out, 100150200 * 1000000 + 255000);
  const warns = e.logs.filter((l) => /cannot set (red|green|blue) on color/.test(l));
  assert.deepEqual(warns, [], 'color channel setters must not warn');
});

test('member.image = img auto-centers the regPoint (balloon spawn anchor)', () => {
  // Balloon Manager showNewBalloon (hh_room_utils 0005):
  //   tmember.image = me.createballoonImg(...)             -> regPoint (w/2, h/2)
  //   tmember.regPoint = tmember.regPoint + point(0, h/2)  -> (w/2, h) bottom-center
  // so the sprite loc (the character's head X) lands at the balloon's
  // BOTTOM-CENTER — the bubble centers over the head and the pulse tip below
  // meets its bottom edge. Director centers the regPoint whenever
  // `member.image =` is assigned (DirPlayer bitmap.rs member.image setter;
  // the corpus itself compensates where it matters — Common Button saves
  // tTempOffset = member.regPoint, assigns image, then restores it). Without
  // it the regPoint stays (0, 0) and the balloon anchors its LEFT edge at
  // the head X — the bubble floats half a width to the right of the speaker.
  const e = new DirectorEngine();
  e.addScriptMember('BalloonRegT', 'unknown', [
    'on run me',
    '  n = createMember("balloon.probe", #bitmap)',
    '  m = member(n)',
    '  m.image = image(120, 40, 8)',
    '  r1h = m.regPoint.locH',
    '  r1v = m.regPoint.locV',
    '  m.regPoint = m.regPoint + point(0, m.image.height / 2)',
    '  r2h = m.regPoint.locH',
    '  r2v = m.regPoint.locV',
    '  m.image = image(200, 30, 8)',
    '  r3h = m.regPoint.locH',
    '  r3v = m.regPoint.locV',
    '  return r1h & "," & r1v & ";" & r2h & "," & r2v & ";" & r3h & "," & r3v',
    'end',
  ].join('\n'));
  const script = e.resolveScript('BalloonRegT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  // 120x40 -> centered (60, 20); + (0, 20) -> (60, 40) bottom-center; a NEW
  // image assignment re-centers to (100, 15) — no accumulation across the
  // pooled balloon member's reuse.
  assert.equal(out, '60,20;60,40;100,15');
});

test('member.char[1..n].font/.fontStyle/.color stores chunk formatting (balloon name)', () => {
  // Balloon Manager bolds the speaker name inside the message:
  //   tmember.char[1..tName.length + 1].font = tBoldStruct.getaProp(#font)
  //   tmember.char[1..tName.length + 1].fontStyle = ...
  //   tmember.char[1..tName.length + 1].color = pDefaultTextColor
  // The engine warned "cannot set font on Jem:" (the chunk evaluated to the
  // plain string). Director applies the prop to the char range of the text
  // member; the range must be recorded and dropped when the text changes.
  const e = new DirectorEngine();
  const tm = e.addScriptMember('balloon.text.plain', 'unknown', '');
  tm.kind = 'text'; // addScriptMember builds script members; retype for text
  tm.text = '';
  void tm;
  e.addScriptMember('ChunkT', 'unknown', [
    'on run me',
    '  m = member("balloon.text.plain")',
    '  m.text = "Jem: hello there"',
    '  m.char[1..4].font = "vb"',
    '  m.char[1..4].fontStyle = [#plain]',
    '  m.char[1..4].color = rgb(0, 0, 0)',
    '  return "ok"',
    'end',
  ].join('\n'));
  const script = e.resolveScript('ChunkT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  assert.equal(out, 'ok');
  const warns = e.logs.filter((l) => /cannot set (font|fontStyle|color) on /.test(l));
  assert.deepEqual(warns, [], 'chunk prop assignment must not warn');
  const m = e.memberFor(e.getMemberByName('balloon.text.plain')!);
  assert.ok(m, 'text member resolves');
  assert.equal(m!.text, 'Jem: hello there');
  const styles = m!.chunkStyles ?? [];
  assert.equal(styles.length, 1, 'one styled range');
  assert.deepEqual([styles[0].from, styles[0].to], [1, 4], 'chars 1..4 (name + colon)');
  assert.equal(styles[0].font, 'vb');
  assert.equal(styles[0].color instanceof LColor, true);
  // Director attaches formatting to the TEXT: reassigning m.text clears it
  // (the balloon member is reused across messages with different names).
  e.addScriptMember('ChunkT2', 'unknown', [
    'on run me',
    '  m = member("balloon.text.plain")',
    '  m.text = "Other: new message"',
    '  return 1',
    'end',
  ].join('\n'));
  const script2 = e.resolveScript('ChunkT2')!;
  const run2 = script2.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  e.interp.callHandler(script2, run2, [], null, new Set());
  assert.equal((m!.chunkStyles ?? []).length, 0, 'new text drops old range styles');
});

test('rasterizeTextMember: chunk styles render the styled range in its own font/color', () => {
  // The balloon text image is composed from member.image: the name range must
  // rasterize bold (struct.font.bold -> font "vb" -> Volter 700) while the
  // message stays in the member font ("v" -> Volter 400).
  const { document } = globalThis as { document?: unknown };
  const draws: Array<{ t: string; font: string; fill: string }> = [];
  const ctxMock = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText: (s: string) => ({ width: s.length * 8 }),
    fillRect: () => undefined,
    fillText: (t: string, _x: number, _y: number) => { draws.push({ t, font: ctxMock.font, fill: ctxMock.fillStyle }); },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctxMock }),
  };
  try {
    const m = new Member(1, 1, 'balloon.text.plain', 'text');
    m.text = 'Jem: hello';
    m.font = 'v';
    m.fontStyle = new LList([new LSymbol('plain')]);
    m.fontSize = 9;
    m.color = new LColor(0, 0, 0);
    m.rect = new LRect(0, 0, 60, 11);
    m.textProps = new Map<string, LVal>([['boxtype', new LSymbol('adjust')]]);
    m.chunkStyles = [{ from: 1, to: 4, font: 'vb', fontStyle: new LList([new LSymbol('plain')]), color: new LColor(0, 0, 0) }];
    const img = rasterizeTextMember(m);
    assert.ok(img);
    assert.equal(draws.length, 2, 'two runs: styled name + plain message');
    assert.equal(draws[0].t, 'Jem:');
    assert.match(draws[0].font, /700/, 'name range draws in the bold face');
    assert.equal(draws[1].t, ' hello');
    assert.match(draws[1].font, /400/, 'message stays in the member face');
  } finally {
    if (document) (globalThis as Record<string, unknown>).document = document;
    else delete (globalThis as Record<string, unknown>).document;
  }
});

test('onCastLoaded fires when a cast registers (embed fonts hook)', async () => {
  // embed.ts hooks this to load a cast's TTF fonts once its manifest registers
  // (boot's lazy preloads happen long after the initial loadFonts call).
  const habbo = makeCastZip('habbo', [], { '0001_script_Loop.ls': '-- Cast member: Loop\non exitFrame me\nend\n' });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  const loaded: string[] = [];
  e.onCastLoaded = (name) => loaded.push(name);
  const cast = await e.loadCast(loader, 'habbo');
  assert.ok(cast);
  assert.ok(loaded.includes('habbo'), `hook must fire for the registered cast, got ${loaded.join(',')}`);
});

test('near-white text flush on the member edge gets keyed by the ink-36 display bake (U51 header fix)', () => {
  // The login_b title member is teal + EEEEEE (near-white) glyphs on an ink-36
  // sprite. pixi bakes BACKGROUND_TRANSPARENT (36) textures with
  // resolveBackgroundTransparent: ANY opaque NEAR-WHITE edge pixel (>= 232,
  // channel delta <= 16) enables a near-white flood-key (tolerance 24). The
  // old rasterizer drew glyphs flush at y=0, so the glyph TOPS sat on the top
  // edge -> the bake keyed the whole near-white line -> white header text
  // vanished on the teal band (black text is never near-white -> survived).
  // The fix insets the glyphs one row so the edges stay teal.
  const W = 16, H = 10;
  const make = (inset: number): Uint8Array => {
    const d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const glyph = x >= 3 && x <= 12 && y >= inset && y <= inset + 6; // near-white 'blob' glyph
        d[o] = glyph ? 238 : 103;
        d[o + 1] = glyph ? 238 : 148;
        d[o + 2] = glyph ? 238 : 167;
        d[o + 3] = 255;
      }
    }
    return d;
  };
  // OLD rasterizer: glyphs flush at y=0 -> top edge is near-white -> the bake
  // flood-keys the whole glyph blob (glyph pixels become transparent).
  const flush = make(0);
  let flushGlyphCount = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (flush[(y * W + x) * 4 + 3] === 255 && x >= 3 && x <= 12 && y >= 0 && y <= 6) flushGlyphCount++;
  }
  const changed = bakeEdgeBackground(flush, W, H, 'backgroundTransparent');
  assert.ok(changed, 'the bake must actually remove pixels in the flush case');
  let flushSurvivors = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (flush[(y * W + x) * 4 + 3] === 255 && x >= 3 && x <= 12 && y >= 0 && y <= 6) flushSurvivors++;
  }
  assert.equal(flushSurvivors, 0, `flush glyphs: every glyph pixel must be keyed (got ${flushSurvivors}/${flushGlyphCount})`);
  // NEW rasterizer: 1px inset -> edges are teal -> no near-white edge -> the
  // bake is a no-op and every glyph pixel survives.
  const inset = make(1);
  const changed2 = bakeEdgeBackground(inset, W, H, 'backgroundTransparent');
  assert.equal(changed2, false, 'inset case: no near-white edge, nothing to bake');
  let insetSurvivors = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (inset[(y * W + x) * 4 + 3] === 255 && x >= 3 && x <= 12 && y >= 1 && y <= 7) insetSurvivors++;
  }
  assert.equal(insetSurvivors, 70, 'inset glyphs: all 10x7 glyph pixels survive');
});

test('member.image = img mutates the member surface in place (Entry Cloud pImg stays live)', () => {
  // Entry Cloud define(): `pImg = pCloudMember.image` BEFORE
  // `pCloudMember.image = image(...)`; the turn() paints into pImg. A setter
  // that REPLACES member.image with a fresh object detaches pImg and the turn
  // is invisible. The setter must copy INTO the member's existing surface.
  const e = new DirectorEngine();
  const m = e.addScriptMember('Bmp', 'unknown', '');
  const ref = e.getMember(m.number, m.castLibNumber)!;
  const captured = e.getMemberProp(ref, 'image') as LImage; // pImg
  const first = new LImage(42, 60);
  first.data = new Uint8Array(42 * 60 * 4).fill(255);
  e.setMemberProp(ref, 'image', first);
  const after = e.getMemberProp(ref, 'image') as LImage;
  assert.ok(after === captured, 'member.image must keep its object identity across assignment');
  assert.equal(after.width, 42, 'member surface resized in place');
  assert.equal(after.height, 60);
  // painting into the CAPTURED reference must be what the channel displays
  after.fillRect(0, 0, 10, 10, new LColor(255, 0, 0));
  const px = captured.ensure();
  assert.equal(px[0], 255);
  assert.equal(px[1], 0);
});

test('setMemberProp(text) rebuilds channels so typed input shows (U51)', () => {
  // dispatchKeyEvent edits member.text via setMemberProp; the pixi Text node
  // must be re-pushed or the typed characters never appear.
  const calls: { ch: number; text?: string }[] = [];
  const adapter = {
    setBackground() {},
    resize() {},
    refreshChannel() {},
    setChannel(ch: number, v: { kind: string; text?: string } | null) {
      calls.push(v ? { ch, text: v.text } : { ch, text: undefined });
    },
  };
  const e = new DirectorEngine(adapter as never);
  const m = e.addScriptMember('Field', 'unknown', '');
  m.kind = 'text';
  m.text = '';
  const ref = e.getMember(m.number, m.castLibNumber)!;
  e.setMemberProp(ref, 'rect', new LRect(0, 0, 167, 21));
  e.setMemberProp(ref, 'font', 'V');
  e.setMemberProp(ref, 'fontSize', 18);
  const s = { channel: 9, script: null };
  e.setSpriteProp(s, 'member', (m.castLibNumber << 16) | m.number);
  e.flushChannelVisuals();
  const before = calls.filter((c) => c.ch === 9).length;
  e.setMemberProp(ref, 'text', 'Hi');
  const after = calls.filter((c) => c.ch === 9);
  assert.ok(after.length > before, `typing must re-push the channel visual (${before} -> ${after.length})`);
  assert.equal(after[after.length - 1].text, 'Hi', 're-pushed visual carries the new text');
});

test('tintSpriteBackground recolors grayscale pixels toward bgColor (figure-creator swatch = white shadow.pixel)', () => {
  // U78: the avatar-editor color swatch is a white shadow.pixel box tinted by
  // `sprite.bgColor = rgb(...)`. DirPlayer tints near-grayscale pixels (max-min
  // <= 16): t = gray/255, out = t*bg (fg black). Colorful pixels untouched.
  const d = new Uint8Array(4 * 4 * 4);
  // row 0: white, gray 128, black, colorful (255,0,0)
  d.set([255, 255, 255, 255, 128, 128, 128, 255, 0, 0, 0, 255, 255, 0, 0, 255], 0);
  // row 1: transparent white (alpha 0 — must stay untouched), rest zeros
  d.set([255, 255, 255, 0], 16);
  tintSpriteBackground(d, 4, 2, 0x0080ff); // bg = rgb(0,128,255)
  const px = (i: number) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
  assert.deepEqual(px(0), [0, 128, 255, 255]); // white -> exact bg
  assert.deepEqual(px(1), [0, 64, 128, 255]); // gray 128 -> t=128/255, t*255 = 128
  assert.deepEqual(px(2), [0, 0, 0, 255]); // black stays black
  assert.deepEqual(px(3), [255, 0, 0, 255]); // colorful untouched
  assert.deepEqual(px(4), [255, 255, 255, 0]); // transparent untouched
});

test('setMemberProp image copies the palette + depth (Image Button arrow keeps ink-8 matte key)', () => {
  // U78: Image Button does `pBuffer.image = pimage` where pimage = duplicate of
  // char.button.left.active (ships a .pal, index 0 = white). The buffer must
  // inherit the palette so the ink-8 matte keys palette index 0 instead of
  // falling back to whiteEdgeDominates (rejected because the dark arrow outline
  // touches the buffer edges -> 290px white box behind the arrowhead).
  const e = new DirectorEngine();
  const src = new LImage(3, 3);
  src.depth = 8;
  src.palette = [[255, 255, 255], [0, 0, 0]];
  src.ensure().fill(255);
  const cast = new CastLib(1, 'c1');
  const member = new Member(1, 2, 'buf', 'bitmap');
  cast.byName.set('buf', member);
  e.casts.push(cast);
  e.membersByGlobal.set((1 << 16) | 2, member);
  const mref = e.getMemberByName('buf');
  assert.ok(mref, 'member ref resolves');
  e.setMemberProp(mref, 'image', src);
  assert.equal(member.image?.depth, 8, 'depth copied');
  assert.deepEqual(member.image?.palette, [[255, 255, 255], [0, 0, 0]], 'palette copied');
  assert.equal(member.image?.width, 3);
});

test('cornersAreNearWhite flags ink-0 button buffers (white mask corners)', () => {
  // Common Button's composed buffer: the pieces' mask flattened to white, so
  // the 4 corners are opaque near-white -> the copy-ink sprite needs the
  // background-transparent bake. Opaque panels / transparent corners don't.
  const make = (cornerRgb: number | null): Uint8Array => {
    const d = new Uint8Array(4 * 4 * 4);
    if (cornerRgb !== null) {
      for (const i of [0, 3, 12, 15]) {
        d[i * 4] = (cornerRgb >> 16) & 0xff;
        d[i * 4 + 1] = (cornerRgb >> 8) & 0xff;
        d[i * 4 + 2] = cornerRgb & 0xff;
        d[i * 4 + 3] = 255;
      }
    }
    return d;
  };
  assert.equal(cornersAreNearWhite(make(0xffffff), 4, 4), true, 'white corners bake');
  assert.equal(cornersAreNearWhite(make(0xefefef), 4, 4), true, 'near-white corners bake');
  assert.equal(cornersAreNearWhite(make(0x808080), 4, 4), false, 'grey corners untouched');
  assert.equal(cornersAreNearWhite(make(null), 4, 4), false, 'transparent corners untouched');
});

// ---- U57: window reopen — duplicate() must deep-copy nested lists (the
// Layout Parser caches parsed window defs and returns a duplicate each call;
// a shallow copy let buildVisual's flipH/rect mutations corrupt the cache,
// so reopening a window re-applied the mutations and came out mis-sized). ----
test('duplicate() deep-copies nested lists/proplists (window reopen)', () => {
  const nested = new LPropList(new Map([['fliph', 1], ['loch', 336]]));
  const inner = new LList([new LSymbol('x'), nested]);
  const outer = new LList([inner]);
  const copy = duplicateValue(outer) as LList;
  assert.ok(copy !== outer && copy.items[0] !== inner, 'lists are fresh objects');
  const copyNested = (copy.items[0] as LList).items[1] as LPropList;
  copyNested.props.set('loch', 238); // buildVisual-style mutation of the copy
  assert.equal(nested.props.get('loch'), 336, 'original nested proplist untouched');
  const deep = duplicateValue(new LPropList(new Map([['a', new LList([new LList([1])])]]))) as LPropList;
  assert.ok(deep.props.get('a') !== undefined);
  assert.ok(!(deep.props.get('a') === null));
});

// ---- U57: avatar parts. Human_Class_EX draws each body part into its buffer
// with `pDrawProps[#maskImage] = pCacheImage.createMatte()`; the part art is
// fully opaque with a white backdrop, so without the mask the white boxes
// keyed the whole avatar out (blank). ----
test('copyPixels #maskImage keys the source background (avatar parts)', () => {
  const art = new LImage(3, 3);
  art.fillRect(0, 0, 3, 3, new LColor(255, 255, 255));
  art.fillRect(1, 1, 2, 2, new LColor(30, 200, 60));
  const mask = new LImage(3, 3);
  const md = mask.ensure();
  for (let i = 0; i < 9; i++) md[i * 4 + 3] = 255;
  md[(1 * 3 + 1) * 4 + 3] = 0; // key only the center pixel
  const dst = new LImage(3, 3);
  dst.copyPixels(art, new LRect(0, 0, 3, 3), new LRect(0, 0, 3, 3), 0, 255, 0xffffff, mask);
  const d = dst.ensure();
  assert.equal(d[(1 * 3 + 1) * 4 + 3], 0, 'masked pixel stays transparent');
  assert.equal(d[0], 255, 'unmasked pixel copied');
  assert.equal(d[3], 255, 'unmasked pixel opaque');
});

test('copyPixels quad dest mirrors horizontally (avatar flipHorizontal)', () => {
  const art = new LImage(3, 1);
  art.fillRect(0, 0, 1, 1, new LColor(255, 0, 0));
  art.fillRect(2, 0, 3, 1, new LColor(0, 0, 255));
  const dst = new LImage(3, 1);
  // flipHorizontal's quad [point(w,0), point(0,0), point(0,h), point(w,h)]
  dst.copyPixels(art, new LRect(0, 0, 3, 1), new LRect(0, 0, 3, 1), 0, 255, 0xffffff, null, true, false);
  const d = dst.ensure();
  // mirrored: the source's right edge (blue) lands at the dest LEFT.
  assert.equal(d[0], 0, 'left edge got the blue (mirrored)');
  assert.equal(d[2], 255);
  assert.equal(d[2 * 4], 255, 'right edge got the red');
  assert.equal(d[2 * 4 + 2], 0);
});

test('copyPixels rotation quad transposes the source (dropmenu #rotate strips)', () => {
  // rotateImg rebuilds the dropmenu/scrollbar rotated 9-slice pieces with a
  // quad: tQuad = [TL, TR, BR, BL] then RotateQuad(±1) — a 90° rotation, NOT
  // a mirror. The interpreter used to misread the axis-aligned rotation quad
  // as a plain flipH mirror, so the dropmenu's topmiddle/bottommiddle strips
  // rendered wrong (black). The rotation must TRANSPOSE the source.
  const e = new DirectorEngine();
  e.addScriptMember('Rot', 'movie', [
    'on run',
    '  tSrc = image(2, 3, 32)',
    '  tSrc.setPixel(0, 0, rgb(0, 0, 0))',
    '  tSrc.setPixel(1, 0, rgb(1, 0, 0))',
    '  tSrc.setPixel(0, 1, rgb(10, 0, 0))',
    '  tSrc.setPixel(1, 1, rgb(11, 0, 0))',
    '  tSrc.setPixel(0, 2, rgb(20, 0, 0))',
    '  tSrc.setPixel(1, 2, rgb(21, 0, 0))',
    '  tDst = image(3, 2, 32)',
    '  tQuad = [point(3, 0), point(3, 2), point(0, 2), point(0, 0)]',
    '  tDst.copyPixels(tSrc, tQuad, tSrc.rect)',
    '  return tDst.getPixel(0, 0, #integer) & "," & tDst.getPixel(2, 0, #integer) & "," & tDst.getPixel(0, 1, #integer) & "," & tDst.getPixel(2, 1, #integer)',
    'end',
  ].join('\n'));
  const s = e.resolveScript('Rot')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  // CW rotation: src(x,y) -> dst(3-1-y, x). dst(0,0)=src(0,2)=20,
  // dst(2,0)=src(0,1)=10, dst(0,1)=src(1,2)=21, dst(2,1)=src(1,1)=11
  // (getPixel #integer returns 0xRRGGBB: rgb(v,0,0) = v*65536).
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), '1310720,655360,1376256,720896');
});

test('createMatte() keys the opaque-white background (avatar part)', () => {
  const art = new LImage(3, 3);
  art.fillRect(0, 0, 3, 3, new LColor(255, 255, 255));
  art.fillRect(1, 1, 2, 2, new LColor(10, 20, 30));
  const engine = new DirectorEngine(null);
  const matte = (engine.interp as unknown as Record<string, unknown>)['dispatchMethod']
    ? (engine.interp as never as { dispatchMethod(o: unknown, n: string, a: unknown[]): unknown })['dispatchMethod'](art, 'createMatte', [])
    : null;
  assert.ok(matte instanceof LImage, 'createMatte returns an image');
  const m = (matte as LImage).ensure();
  assert.equal(m[3], 0, 'edge white keyed');
  assert.equal(m[(1 * 3 + 0) * 4 + 3], 0, 'white backdrop keyed');
  assert.equal(m[(1 * 3 + 1) * 4 + 3], 255, 'interior art kept');
});

test('union/intersect are rect functions (Bodypart updateRect, C++ unionRect parity)', () => {
  // Bodypart_Class_EX tracks its dirty rect with
  // `me.pUpdateRect = union(me.pUpdateRect, pCacheRectA)` — before these
  // builtins the update rect stayed 0 and repaints never marked dirty.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  const rc = (s: string): string => {
    const r = ev(s) as LRect;
    return `${r.left},${r.top},${r.right},${r.bottom}`;
  };
  assert.equal(rc('union(rect(0,0,10,10), rect(5,5,20,20))'), '0,0,20,20');
  assert.equal(rc('union(rect(5,5,20,20), rect(0,0,10,10))'), '0,0,20,20');
  // empty (degenerate) rect handling: both empty -> 0 rect; one empty -> other
  assert.equal(rc('union(rect(0,0,0,0), rect(0,0,0,0))'), '0,0,0,0');
  assert.equal(rc('union(rect(0,0,0,0), rect(3,4,9,10))'), '3,4,9,10');
  assert.equal(rc('union(rect(3,4,9,10), rect(0,0,0,0))'), '3,4,9,10');
  assert.equal(rc('intersect(rect(0,0,10,10), rect(5,5,20,20))'), '5,5,10,10');
  // disjoint rects intersect to the empty rect (C++: right<=left -> 0 rect)
  assert.equal(rc('intersect(rect(0,0,2,2), rect(5,5,9,9))'), '0,0,0,0');
  // non-rect / missing args -> VOID (C++ returns void)
  assert.equal(ev('union(rect(0,0,1,1))') === null, true);
  assert.equal(ev('union(1, 2)') === null, true);
});

test('sin/cos take degrees; startTimer resets the timer (C++ MathBuiltins parity)', () => {
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.ok(Math.abs((ev('sin(30)') as number) - 0.5) < 1e-9, 'sin(30) = 0.5 (degrees)');
  assert.ok(Math.abs((ev('cos(60)') as number) - 0.5) < 1e-9, 'cos(60) = 0.5 (degrees)');
  assert.ok(Math.abs((ev('sin(90)') as number) - 1) < 1e-9);
  // the timer + startTimer: startTimer resets the clock base
  const t0 = ev('the timer') as number;
  assert.ok(typeof t0 === 'number' && t0 >= 0);
  ev('startTimer()');
  const t1 = ev('the timer') as number;
  assert.ok(t1 < 50, 'after startTimer, the timer restarts near 0');
});

test('callAncestor(#handler, [me]) runs the ancestor handler with me bound (furni construct)', () => {
  // Credit_Furni_Class: `return callAncestor(#construct, [me])` — the ancestor
  // (base furni) construct must run with `me` = the descendant instance.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Base Furni Class',
    'parent',
    [
      'property pConstructed',
      'on construct me',
      '  me.pConstructed = me.pConstructed + 1',
      '  return me.pConstructed',
      'end',
    ].join('\n'),
  );
  e.addScriptMember(
    'Credit Furni Class',
    'parent',
    [
      'property pConstructed',
      'on construct me',
      '  me.pConstructed = 0',
      '  tBase = script("Base Furni Class").new()',
      '  tBase.construct()',
      '  me.ancestor = tBase',
      '  return callAncestor(#construct, [me])',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Credit Furni Class')!;
  const inst = e.interp.newInstance(script, []);
  e.interp.callObjectHandler(inst, 'construct', []);
  // the ancestor's construct ran on the SAME object (its own pConstructed)
  assert.equal(inst.props.get('pConstructed'), 1, 'ancestor construct ran with me=descendant');
});

test('callAncestor skips the class owning the current handler (Active Object Extension define)', () => {
  // Corpus shape: Object Base <- Active Object Class <- Active Object
  // Extension Class <- Furniture Sound Machine Class. The Extension's define
  // re-implements #define and ends with callAncestor(#define, [me]) — the walk
  // must land on Active Object Class's define, NOT re-enter the Extension's
  // own define (me.ancestor == the Extension instance). Before the fix this
  // recursed until the depth guard tripped and define returned VOID, which is
  // exactly how the sound machine failed to appear in the room.
  const e = new DirectorEngine();
  e.addScriptMember(
    'Furni Base Class',
    'parent',
    [
      'property pDefined',
      'on define me, tProps',
      '  me.pDefined = 1',
      '  return 1',
      'end',
    ].join('\n'),
  );
  e.addScriptMember(
    'Furni Extension Class',
    'parent',
    [
      'property pDefined',
      'on define me, tProps',
      '  me.pDefined = 2',
      '  return callAncestor(#define, [me], tProps)',
      'end',
    ].join('\n'),
  );
  e.addScriptMember(
    'Furni Sound Machine Class',
    'parent',
    ['property pDefined'].join('\n'),
  );

  // Chain instances like Object Manager create() does: sm.ancestor = ext,
  // ext.ancestor = base (the child class defines no #define, so the dispatch
  // lands on the Extension's define, exactly like the corpus).
  const base = e.interp.newInstance(e.resolveScript('Furni Base Class')!, []);
  const ext = e.interp.newInstance(e.resolveScript('Furni Extension Class')!, []);
  const sm = e.interp.newInstance(e.resolveScript('Furni Sound Machine Class')!, []);
  ext.props.set('ancestor', base);
  sm.props.set('ancestor', ext);

  const before = e.logs.length;
  const r = e.interp.callObjectHandler(sm, 'define', [e.interp.evalExpressionString('[#class: "sound_machine"]')]);
  // The Extension's define ran, then the BASE's define (not the Extension again).
  assert.equal(sm.props.get('pDefined'), 1, 'base define ran last (skipped the Extension itself)');
  assert.equal(r, 1, 'define returned the base result');
  assert.ok(!e.logs.slice(before).some((l) => l.includes('call depth exceeded')), 'no recursion');
});

test('stage/UI no-ops: updateStage, beep, dontPassEvent resolve without warnings', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'UI',
    'movie',
    ['on run', '  updateStage()', '  beep(1)', '  dontPassEvent()', '  cursor(0)', '  return 1', 'end'].join('\n'),
  );
  const script = e.resolveScript('UI')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(script, run, [], null, new Set()), 1);
  assert.ok(!e.logs.some((l) => l.includes('[warn]')), 'no unresolved-handler warnings');
});

test('bare list builtins: add, sort, getAt, getPropAt, getAProp, duplicate', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'LB',
    'movie',
    [
      'on run',
      '  t = [3, 1, 2]',
      '  add(t, 4)',
      '  sort(t)',
      '  t1 = getAt(t, 2)',
      '  p = [#b: 2, #a: 1]',
      '  k2 = getPropAt(p, 1)',
      '  v = getAProp(p, #a)',
      '  d = duplicate(p)',
      '  d[#c] = 3',
      '  return [t, t1, k2, v, d.count, p.count]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('LB')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: unknown[] };
  const items = out.items as unknown as [{ items: number[] }, number, string, number, number, number];
  assert.deepEqual(items[0].items, [1, 2, 3, 4], 'add + sort order');
  assert.equal(items[1], 2, 'getAt(list, 2)');
  assert.equal(items[2], 'b', 'getPropAt returns the key at position');
  assert.equal(items[3], 1, 'getAProp(pl, #a)');
  assert.equal(items[4], 3, 'duplicate is deep (mutating copy leaves source alone)');
  assert.equal(items[5], 2, 'source proplist unchanged');
  assert.ok(!e.logs.some((l) => l.includes('[warn]')), 'no unresolved warnings');
});

test('nothing(), rollover(n), inside(pt, rect), getWindowIdList resolve', () => {
  const e = new DirectorEngine();
  e.createWindow('test_win');
  // A real sprite under the cursor: the fresh rollover hit-test resolves it
  // (a bare setRollover(n) cache would also answer, but Lingo reads must come
  // from a live hit test at the mouse position — DirPlayer get_sprite_at).
  const m = new Member(1, 1, 'hit_box', 'bitmap');
  const img = new LImage(10, 10);
  img.data = new Uint8Array(10 * 10 * 4).fill(255);
  img.dirty = true;
  m.image = img;
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  cast.members.set(1, m);
  cast.byName.set('hit_box', m);
  e.membersByGlobal.set((1 << 16) | 1, m);
  e.setSpriteProp(e.getSprite(7), 'castNum', (1 << 16) | 1);
  e.setSpriteProp(e.getSprite(7), 'locH', 0);
  e.setSpriteProp(e.getSprite(7), 'locV', 0);
  e.dispatchPointerEvent('mouseMove', 7, 5, 5);
  e.addScriptMember(
    'MB',
    'movie',
    [
      'on run',
      '  nothing()',
      '  r0 = rollover()',
      '  r1 = rollover(7)',
      '  r2 = rollover(3)',
      '  p = point(5, 5)',
      '  r = rect(0, 0, 10, 10)',
      '  i1 = inside(p, r)',
      '  i2 = p.inside(r)',
      '  wl = getWindowIdList()',
      '  return [r0, r1, r2, i1, i2, wl.count]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('MB')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  assert.deepEqual(out.items, [7, 1, 0, 1, 1, 1], 'rollover/inside/getWindowIdList semantics');
  assert.ok(!e.logs.some((l) => l.includes('[warn]')), 'no unresolved warnings');
});

test('member.charPosToLoc measures text width for Text Wrapper centering', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'CPTL',
    'movie',
    [
      'on run',
      '  n = createMember("t1", #text)',
      '  t = member(n)',
      '  t.font = "Volter"',
      '  t.fontSize = 10',
      '  t.text = "hello"',
      '  loc = member(n).charPosToLoc(5)',
      '  return loc.locH',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('CPTL')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const locH = e.interp.callHandler(script, run, [], null, new Set());
  // headless (no canvas) falls back to a width estimate — must be > 16 so the
  // Text Wrapper formula (locH + 16) does not collapse to a 16px box.
  assert.equal(typeof locH, 'number', 'returns a number');
  assert.ok((locH as number) > 16, `charPosToLoc(5).locH = ${locH} > 16 (was 0 — collapsed text box)`);
});

test('member.char.count chunk reads member text (U91 window title width)', () => {
  // U91: the Text Wrapper sizes centered titles with
  // `charPosToLoc(char.count).locH + 16`. member.char.count returned 0 (chunk
  // on a member ref read no text), charPosToLoc clamped to char 1, and the
  // title "Habbo Console" collapsed to a 21px box, clipping header text.
  const e = new DirectorEngine();
  e.addScriptMember(
    'U91',
    'movie',
    [
      'on run',
      '  n = createMember("t1", #text)',
      '  t = member(n)',
      '  t.font = "Volter"',
      '  t.fontSize = 9',
      '  t.fixedLineSpace = 15',
      '  t.alignment = #center',
      '  t.rect = rect(0, 0, 60, 15)',
      '  t.text = "Habbo Console"',
      '  c = member(n).char.count',
      '  first = member(n).char[1]',
      '  w = member(n).charPosToLoc(member(n).char.count).locH + 16',
      '  return c & "," & first & "," & w',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('U91')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as string;
  const [c, first, w] = out.split(',');
  assert.equal(c, '13', `member.char.count = ${c} (was 0 — chunk did not read member text)`);
  assert.equal(first, 'H', 'member.char[1] reads the first char');
  const wNum = Number(w);
  assert.ok(wNum > 40, `charPosToLoc(count).locH + 16 = ${wNum} (was 21 — title box collapsed)`);
});

test('member.char.count on non-text member is 0 (U91 guard)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'U91G',
    'movie',
    [
      'on run',
      '  b = createMember("b1", #bitmap)',
      '  c = member(b).char.count',
      '  s = member(b).char[1]',
      '  return c & "," & s',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('U91G')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as string;
  // bitmap member — chunk reads stay 0/'' (concatenated: "0,")
  assert.equal(out, '0,', `bitmap member char.count = ${out} (must stay 0/empty)`);
});

test('text line step honors topSpacing (navigator room list 18px rows)', () => {
  // U76: the room list Writer defines fixedLineSpace = pListItemHeight (18)
  // with fontSize 9; the Writer stashes fixedLineSpace - fontSize = 9 in
  // topSpacing. Director steps each line by fixedLineSpace + topSpacing (=18,
  // one row) starting at topSpacing — centering the line in its box collapsed
  // the rows to 9px and pushed text ~8px high ("padding-top: -10px").
  const e = new DirectorEngine();
  e.addScriptMember(
    'TS',
    'movie',
    [
      'on run',
      '  n = createMember("t1", #text)',
      '  t = member(n)',
      '  t.font = "Volter"',
      '  t.fontSize = 9',
      '  t.fixedLineSpace = 9',
      '  t.topSpacing = 9',
      '  t.text = "roomA" & RETURN & "roomB"',
      '  l1 = member(n).charPosToLoc(1)',
      '  l2 = member(n).charPosToLoc(7)',
      '  return l1.locV & "," & l2.locV',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('TS')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  // first line at topSpacing (9), second line 18px below (27) — NOT centered
  // (old: 1 and 10) — so each room name lands inside its own 18px row.
  assert.equal(out, '9,27', `line locVs = ${out} (expected 9,27 — one 18px row per line)`);
});

test('channel ink-8 matte never keys opaque panels (navigator drag header / tab outline)', () => {
  // U70: buildVisual sets every element sprite ink 8, so the pixi channel bake
  // ran on the COMPOSED buffers. The old matte fell back to the dominant
  // NON-white edge color: the solid-teal drag header (103,148,167 edges) was
  // keyed to nothing (only the floating title text survived) and the black tab
  // outline connected to the buffer edge was keyed away. The channel bake must
  // only key white (or palette index 0) — opaque panels survive.
  const W = 60, H = 20;
  const panel = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    panel[o] = 103; panel[o + 1] = 148; panel[o + 2] = 167; panel[o + 3] = 255; // teal
  }
  const changed = bakeEdgeBackground(panel, W, H, 'matte');
  assert.equal(changed, false, 'teal panel must NOT be baked (header bg visible)');
  let kept = 0;
  for (let i = 0; i < W * H; i++) if (panel[i * 4 + 3] !== 0) kept++;
  assert.equal(kept, W * H, 'every panel pixel survives');

  const W2 = 40, H2 = 40;
  const tab = new Uint8Array(W2 * H2 * 4);
  for (let i = 0; i < W2 * H2; i++) {
    const o = i * 4;
    tab[o] = 212; tab[o + 1] = 221; tab[o + 2] = 225; tab[o + 3] = 255; // light tab body
  }
  for (let x = 0; x < W2; x++) for (let y = 0; y < 2; y++) { // black outline touches the edge
    const o = (y * W2 + x) * 4;
    tab[o] = 0; tab[o + 1] = 0; tab[o + 2] = 0;
  }
  const changed2 = bakeEdgeBackground(tab, W2, H2, 'matte');
  assert.equal(changed2, false, 'tab with black edge outline must NOT be baked (outline visible)');
});

test('channel ink-8 matte still keys white-backdrop art (cloud sprite)', () => {
  const W = 50, H = 50;
  const cloud = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    cloud[o] = 255; cloud[o + 1] = 255; cloud[o + 2] = 255; cloud[o + 3] = 255;
  }
  for (let y = 15; y < 35; y++) for (let x = 15; x < 35; x++) { // opaque puff
    const o = (y * W + x) * 4;
    cloud[o] = 238; cloud[o + 1] = 238; cloud[o + 2] = 238;
  }
  const changed = bakeEdgeBackground(cloud, W, H, 'matte');
  assert.ok(changed, 'white-backdrop art must still be baked');
  let kept = 0;
  for (let i = 0; i < W * H; i++) if (cloud[i * 4 + 3] !== 0) kept++;
  assert.equal(kept, 20 * 20, 'only the opaque puff survives (was 2500 px of white)');
});

test('defringeTextPixels removes the canvas-AA halo the ink-8 matte leaves behind', () => {
  // Director fields render 1-bit pixel fonts; canvas fillText AA leaves a
  // partial fringe between glyph and background that survives the ink-8
  // copyPixels matte (it is not exactly white) and shows as a white outline
  // on tab labels. Snap each fringe pixel to the nearer of fg/bg.
  const W = 30, H = 12;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { // white bg
    const o = i * 4;
    img[o] = 255; img[o + 1] = 255; img[o + 2] = 255; img[o + 3] = 255;
  }
  for (let y = 1; y < 4; y++) for (let x = 1; x < 8; x++) { // black glyph block
    const o = (y * W + x) * 4;
    img[o] = 0; img[o + 1] = 0; img[o + 2] = 0;
  }
  // AA fringe ring (mid-grays) around the glyph block
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 9; x++) {
      if ((x >= 1 && x < 8 && y >= 1 && y < 4)) continue;
      const o = (y * W + x) * 4;
      img[o] = 120; img[o + 1] = 120; img[o + 2] = 120;
    }
  }
  const countHalo = (d: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (d[o + 3] === 0) continue;
      if (d[o] === 255 && d[o + 1] === 255 && d[o + 2] === 255) continue; // bg
      if (d[o] === 0 && d[o + 1] === 0 && d[o + 2] === 0) continue; // glyph
      n++;
    }
    return n;
  };
  assert.ok(countHalo(img) > 0, 'the synthetic image has a fringe halo to remove');
  defringeTextPixels(img, W, H, 0x000000, 0xffffff);
  assert.equal(countHalo(img), 0, 'every fringe pixel snapped to glyph or background');
});

test('paletteIndex(n) resolves RGB from the movie palette (Figure colors)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'PLT',
    'movie',
    [
      'on run',
      '  c1 = paletteIndex(1)',
      '  c255 = paletteIndex(255)',
      '  c512 = paletteIndex(512)',
      '  return [c1.red, c1.green, c1.blue, c255.red, c255.green, c255.blue, c512.red, c512.green, c512.blue]',
      'end',
    ].join('\n'),
  );
  // Fake the movie palette: index 0 = black, 1 = purple, 255 = white.
  const pal: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  pal[1] = [255, 0, 128];
  pal[255] = [255, 255, 255];
  e.currentPalette = pal;
  const script = e.resolveScript('PLT')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  // 512 is OUT of palette range (0-255) — Director treats a >255 integer as a
  // 0xRRGGBB color value (LibreShockwave int->color: only 0..255 is a palette
  // index), so paletteIndex(512) = 0x000200, NOT a masked palette entry.
  assert.deepEqual(out.items, [255, 0, 128, 255, 255, 255, 0, 2, 0], 'paletteIndex: 0-255 resolves the palette entry; >255 is the RGB value');
});

test('paletteIndex(0xFFFFFF) is WHITE — the catalogue *ffffff no-color marker', () => {
  // Product Preview Class: `tProps[#bgColor] = paletteIndex(integer(pPartColors[j]))`
  // with the server's "*ffffff" (no color) marker -> paletteIndex(16777215). The
  // old &0xFF mask resolved it to palette entry 255 (BLACK in the radiator /
  // mini-bar palettes), so ink-36 previews keyed the furni's dark pixels away
  // ("all the darker bits get removed") and ink-8 previews tinted gray bodies
  // black. "*ffffff" IS the RGB value for white — it must resolve to white.
  const e = new DirectorEngine();
  e.addScriptMember('NoColor', 'movie', [
    'on run',
    '  c = paletteIndex(integer("*ffffff"))',
    '  return [c.red, c.green, c.blue]',
    'end',
  ].join('\n'));
  // A current palette whose entry 255 is BLACK — the failing case.
  const pal: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  pal[255] = [0, 0, 0];
  e.currentPalette = pal;
  const script = e.resolveScript('NoColor')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  assert.deepEqual(out.items, [255, 255, 255], 'paletteIndex(0xFFFFFF) = white, not palette[255]');
});

test('copyPixels ink 36 keys WHITE, keeps the dark art (catalogue mini-bar preview)', () => {
  // The catalogue Product Preview for bar_polyfon copies `[#ink: 36, #bgColor:
  // paletteIndex(integer("*ffffff"))]` — BACKGROUND_TRANSPARENT keys the bg
  // color. With the *ffffff marker resolving to white, the WHITE backdrop is
  // keyed and the dark outlines/shading survive. (Before: bgColor resolved to
  // black and the ink-36 key ate every black pixel — the mini-bar's darker
  // bits vanished.)
  const e = new DirectorEngine();
  e.addScriptMember('Ink36Key', 'movie', [
    'on run',
    '  src = image(5, 5, 32)',
    '  src.fill(src.rect, rgb(255, 255, 255))',
    '  src.setPixel(1, 1, rgb(0, 0, 0))',
    '  src.setPixel(2, 2, rgb(40, 40, 40))',
    '  src.setPixel(3, 3, rgb(200, 200, 200))',
    '  dst = image(5, 5, 32)',
    '  dst.fill(dst.rect, rgb(255, 255, 255))',
    '  dst.copyPixels(src, src.rect, src.rect, [#ink: 36, #bgColor: rgb(255, 255, 255)])',
    '  return [dst.getPixel(1, 1).red, dst.getPixel(2, 2).red, dst.getPixel(3, 3).red]',
    'end',
  ].join('\n'));
  const script = e.resolveScript('Ink36Key')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  // black + dark gray kept; the bg (white) is transparent so the dest's own
  // white shows at the border pixels — interior dark art survives.
  assert.deepEqual(out.items, [0, 40, 200], 'ink 36 keys only the bg color; dark art survives');
});

test('image(w,h,8,paletteMember) makes that palette current for paletteIndex (navigator rows)', () => {
  // Navigator createRoomItemImage: `image(311,16,8,member("nav_ui_palette"))`
  // then fills with `paletteIndex(82)` (the 218,218,218 row body). The image()
  // builtin must adopt the palette member as the movie's current palette —
  // mirroring the paletteref member setter — or paletteIndex resolves against
  // the wrong/absent palette and the row paints neutral gray (was: NULL).
  const e = new DirectorEngine();
  const pal = e.addScriptMember('nav_ui_palette', 'unknown', '');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[82] = [218, 218, 218]; // the real nav row body
  pal.palette = table;
  e.currentPalette = null; // no movie palette yet — the bug
  e.addScriptMember(
    'NavRow',
    'movie',
    [
      'on run',
      '  t = image(311, 16, 8, member("nav_ui_palette"))',
      '  c = paletteIndex(82)',
      '  return [c.red, c.green, c.blue]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('NavRow')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  assert.deepEqual(out.items, [218, 218, 218], 'image() with a palette member drives paletteIndex (navigator row body)');
});

test('call(#handler, spriteRef, ...) dispatches to the sprite behavior (room walk chain)', () => {
  // Room Interface showRoom registers the floor click chain with
  // `call(#registerProcedure, tSprList, #eventProcRoom, me.getID(), #mouseDown)`
  // where the visualizer's sprite list holds SPRITE REFS. Director call()
  // dispatches to the sprite's behavior scripts; before this fix every room
  // sprite warned "target is not an object" and the Event Broker pProcList
  // stayed empty — floor clicks did nothing (no walking).
  const e = new DirectorEngine();
  e.addScriptMember(
    'Beh',
    'parent',
    [
      'property pMethod',
      'property pClient',
      'property pEvent',
      'on registerProcedure me, tMethod, tClientID, tEvent',
      '  pMethod = tMethod',
      '  pClient = tClientID',
      '  pEvent = tEvent',
      '  return 1',
      'end',
      'on getProc me',
      '  return [pMethod, pClient, pEvent]',
      'end',
    ].join('\n'),
  );
  e.addScriptMember(
    'Wire',
    'movie',
    [
      'on run',
      '  sprite(5).scriptInstanceList = [new(script("Beh"))]',
      '  call(#registerProcedure, sprite(5), #eventProcRoom, "Room_interface", #mouseDown)',
      '  p = sprite(5).scriptInstanceList[1].getProc()',
      '  return p',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Wire')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: LVal[] };
  const items = out.items.map((v) => (v instanceof LSymbol ? `#${v.name}` : String(v)));
  assert.deepEqual(items, ['#eventProcRoom', 'Room_interface', '#mouseDown'], 'sprite-ref call() reaches the behavior handler');
});

test('set member(x).palette attaches the palette table (private room patterns)', () => {
  // Visualizer Part Wrapper renderImage: `tPartMem.palette =
  // member(getmemnum(tPalette))` on the wall/floor pattern bitmaps — was
  // "set member(x).palette: unsupported" and private rooms stalled.
  const e = new DirectorEngine();
  const pal = e.addScriptMember('wall_pal', 'unknown', '');
  pal.kind = 'palette';
  const table: number[][] = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  table[1] = [200, 120, 40];
  pal.palette = table;
  const bit = e.addScriptMember('wall_pattern', 'unknown', '');
  e.addScriptMember(
    'SetPal',
    'movie',
    ['on run', '  member("wall_pattern").palette = member("wall_pal")', '  return 1', 'end'].join('\n'),
  );
  const script = e.resolveScript('SetPal')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  e.interp.callHandler(script, run, [], null, new Set());
  assert.deepEqual(bit.palette?.[1], [200, 120, 40], 'member.palette now carries the referenced palette table');
  assert.deepEqual(e.currentPalette?.[1], [200, 120, 40], 'currentPalette follows the assignment');
});

test('propList count returns the number of pairs', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'PC',
    'movie',
    ['on run', '  p = [#a: 1, #b: 2, #c: 3]', '  return p.count', 'end'].join('\n'),
  );
  const script = e.resolveScript('PC')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set());
  assert.equal(out, 3, 'proplist.count = pair count (DropDown define chain)');
});

test('copyPixels keys the 8-bit source palette background (navigator row pieces)', () => {
  // DirPlayer indexed-copy parity: an 8-bit source's background (palette
  // index 0 = white) is transparent in the copy, so nav_rw_lf pastes as a
  // rounded cutout over the row fill instead of a white block.
  const src = new LImage(4, 4);
  src.depth = 8;
  src.palette = [[255, 255, 255], [255, 0, 0]]; // idx0 = white bg, idx1 = red art
  const s = src.ensure();
  for (let i = 0; i < 4 * 4 * 4; i += 4) {
    s[i] = 255; s[i + 1] = 255; s[i + 2] = 255; s[i + 3] = 255;
  }
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      const o = (y * 4 + x) * 4;
      s[o] = 255; s[o + 1] = 0; s[o + 2] = 0; s[o + 3] = 255;
    }
  }
  const dst = new LImage(4, 4);
  const d = dst.ensure(); // transparent black init
  // copyPixels(this = destination, src, destRect, srcRect, ink)
  dst.copyPixels(src, new LRect(0, 0, 4, 4), new LRect(0, 0, 4, 4), 0);
  const bgPx = (3 * 4 + 3) * 4;
  assert.equal(d[bgPx + 3], 0, 'white background pixel stays transparent (keyed)');
  const artPx = (0 * 4 + 0) * 4;
  assert.deepEqual([d[artPx], d[artPx + 1], d[artPx + 2], d[artPx + 3]], [255, 0, 0, 255], 'art pixels copy verbatim');
});

test('the floatPrecision get/set + keyDown/optionDown/shiftDown/commandDown/controlDown (rooms)', () => {
  // Room Geometry getScreenCoordinate does `tPrecision = the floatPrecision;
  // set the floatPrecision to 2; ...; set the floatPrecision to tPrecision`
  // and Room Hiliter reads `the optionDown` — DirPlayer float_precision
  // defaults to 4, get returns the int, set stores it (u8), and the key-state
  // props mirror the keyboard manager. (Was: unsupported -> VOID every frame.)
  const e = new DirectorEngine();
  e.addScriptMember(
    'FP',
    'movie',
    [
      'on run',
      '  d = the floatPrecision',
      '  set the floatPrecision to 2',
      '  d2 = the floatPrecision',
      '  od = the optionDown',
      '  sd = the shiftDown',
      '  set the floatPrecision to d',
      '  d3 = the floatPrecision',
      '  return [d, d2, d3, od, sd]',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('FP')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out = e.interp.callHandler(script, run, [], null, new Set()) as unknown as { items: number[] };
  assert.deepEqual(out.items, [4, 2, 4, 0, 0], 'floatPrecision default 4, set 2, restore; keys default up');
  // dispatchKeyEvent with modifiers drives the key-state props (embed wiring).
  e.dispatchKeyEvent('keyDown', 'a', 65, { shift: true, alt: true });
  const script2 = e.resolveScript('FP')!;
  const run2 = script2.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  const out2 = e.interp.callHandler(script2, run2, [], null, new Set()) as unknown as { items: number[] };
  assert.deepEqual(out2.items[3], 1, 'the optionDown follows altKey');
  assert.deepEqual(out2.items[4], 1, 'the shiftDown follows shiftKey');
  assert.ok(!e.logs.some((l) => l.includes('floatPrecision')), 'no floatPrecision warns');
  assert.ok(!e.logs.some((l) => l.includes('optionDown')), 'no optionDown warns');
});

test('fontStyleFlags parses Director fontStyle lists/symbols/strings', () => {
  assert.deepEqual(fontStyleFlags(undefined), { italic: false, bold: false, underline: false });
  assert.deepEqual(fontStyleFlags(new LList([new LSymbol('plain')])), { italic: false, bold: false, underline: false });
  assert.deepEqual(fontStyleFlags(new LList([new LSymbol('bold'), new LSymbol('underline')])), {
    italic: false,
    bold: true,
    underline: true,
  });
  assert.deepEqual(fontStyleFlags(new LSymbol('italic')), { italic: true, bold: false, underline: false });
  assert.deepEqual(fontStyleFlags('BOLD'), { italic: false, bold: true, underline: false });
  assert.deepEqual(fontStyleFlags(new LList(['underline', new LSymbol('bold')])), {
    italic: false,
    bold: true,
    underline: true,
  });
});

test('value() passes non-strings through (LibreShockwave TypeBuiltins::value parity)', () => {
  const e = new DirectorEngine();
  // Director: value() only parses strings; symbols/lists/numbers return
  // unchanged. The Variable Container GetValue depends on this — value(#info)
  // must stay #info (NOT the GetValue default), or getVariableValue falls back
  // to its default and connection lookups break.
  const sym = e.interp.evalExpressionString('value(#info)');
  assert.ok(sym instanceof LSymbol, 'value(#info) is a symbol');
  assert.equal((sym as LSymbol).name, 'info', 'symbol case preserved');
  assert.equal(e.interp.evalExpressionString('value(42)'), 42);
  assert.equal(e.interp.evalExpressionString('value("42")'), 42);
  assert.equal(e.interp.evalExpressionString('value(VOID)'), null);
  // Missing variables stay VOID so GetValue's default fallback still fires
  // (voidp is a strict === null check).
  assert.equal(e.interp.evalExpressionString('value(undefinedVar12345)'), null);
  const list = e.interp.evalExpressionString('value(["a": 1])');
  assert.ok(list instanceof LPropList, 'value(proplist) passes through');
});

test('put: benign "Writer already exists" error block is kept out of the log (U84)', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'PutFilter',
    'movie',
    [
      'on run',
      '  put "Error:" & RETURN & "\\t Time:   8/10/2026" & RETURN & "\\t Method:  create" & RETURN & "\\t Object: " & RETURN & "\\t Message: Writer already exists: dialog_writer_bold"',
      '  put "Error:" & RETURN & "\\t Method:  real" & RETURN & "\\t Message: Something actually broken"',
      '  put "normal debug line"',
      '  return 1',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('PutFilter')!;
  const run = script.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  e.interp.callHandler(script, run, [], null, new Set());
  const joined = e.logs.join('\n');
  assert.ok(!joined.includes('Writer already exists'), 'benign writer-error block suppressed');
  assert.ok(joined.includes('Something actually broken'), 'other error blocks still logged');
  assert.ok(joined.includes('normal debug line'), 'ordinary put output still logged');
});

test('list * scalar lerps element-wise (Human Class walk pScreenLoc)', () => {
  // Human Class 0002:540 walks with
  // `pScreenLoc = (pDestLScreen - pStartLScreen) * tFactor + pStartLScreen`
  // — pDestLScreen/pStartLScreen are 3-element [x, y, z] lists and tFactor a
  // float in [0,1]. Before lingoMultiply existed, `*` fell back to
  // asNum(list)=0, so the product was 0 and pScreenLoc stayed pStartLScreen
  // for the whole walk — the avatar never glided and only moved when the
  // next status message's resetValues snapped it to the new tile (the
  // teleport-between-squares bug). DirPlayer multiply_datums parity:
  // list*scalar and scalar*list are the same element-wise multiply
  // (commutative); list*list is element-wise min-length.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s) as LList;
  const lst = (s: string) => (ev(s).items as number[]).join(',');
  assert.equal(lst('[100, 200, 0] * 0.5'), '50,100,0', 'list * float scales each element');
  assert.equal(lst('0.25 * [100, 200, 0]'), '25,50,0', 'scalar * list is commutative (DirPlayer)');
  assert.equal(lst('[10, 20, 30] * 2'), '20,40,60');
  assert.equal(lst('[1, 2, 3] * [10, 20, 30]'), '10,40,90', 'list * list element-wise min-length');
  assert.equal(lst('[4, 6] * [1, 2, 3]'), '4,12', 'min-length');
  // The exact Human lerp: start [100,200,0], dest [300,400,0], t=0.5
  assert.equal(lst('([300, 400, 0] - [100, 200, 0]) * 0.5 + [100, 200, 0]'), '200,300,0');
  // t=0 and t=1 bookends (tFactor clamped in Lingo before this expression)
  assert.equal(lst('([300, 400, 0] - [100, 200, 0]) * 0 + [100, 200, 0]'), '100,200,0');
  assert.equal(lst('([300, 400, 0] - [100, 200, 0]) * 1 + [100, 200, 0]'), '300,400,0');
  // point * scalar and scalar * point scale componentwise
  const pt = (s: string) => {
    const v = e.interp.evalExpressionString(s) as { locH: number; locV: number };
    return `${v.locH},${v.locV}`;
  };
  assert.equal(pt('point(10, 20) * 2'), '20,40');
  assert.equal(pt('3 * point(10, 20)'), '30,60');
  assert.equal(pt('point(10, 20) * point(2, 3)'), '20,60');
  // scalar * scalar is unchanged
  assert.equal(e.interp.evalExpressionString('2 * 3'), 6);
});

test('float() / decimal literals force float division (Human walk tFactor)', () => {
  // Human Class 0002:536: `tFactor = float(the milliSeconds - pMoveStart) /
  // pMoveTime` — Lingo's float() is FLOAT-TYPED even for whole numbers, so
  // float(250) / 500 = 0.5 while 250 / 500 = 0 (truncating int division).
  // JS numbers can't distinguish 250 from 250.0, so float() results and
  // decimal literals are marked float-typed and `/` consults the mark.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  // The exact lerp numerator: 250ms of a 500ms walk at 24fps
  assert.equal(ev('float(250) / 500'), 0.5, 'float() marks whole numbers so / divides as float');
  assert.equal(ev('250 / 500'), 0, 'int / int still truncates (wire-encoder parity)');
  assert.equal(ev('float(250) / float(500)'), 0.5, 'float / float');
  assert.equal(ev('14.0 / 4'), 3.5, 'decimal literal 14.0 is float-typed');
  assert.equal(ev('14 / 4'), 3, 'int / int truncates');
  // Swimmer Class 0002:288: `float(...) / (pMoveTime * 1.0)` — the `* 1.0`
  // product must stay float so the denominator doesn't truncate the division.
  assert.equal(ev('float(250) / (500 * 1.0)'), 0.5, 'floatness propagates through *');
  // floatp is deliberately NOT mark-aware: the Variable Container's GetValue
  // runs `floatp(float(tValue))` on EVERY boot variable — making float()
  // results count as float flipped integer-string parsing ("5" -> 5), which
  // mangled the class-variable chain (broker.manager.class -> VOID) and sent
  // the error-reporting path into an infinite broker-manager recursion at
  // boot (session 54). floatp stays a pure non-integer check (boot parity).
  assert.equal(ev('floatp(float(250))'), 0, 'floatp ignores float() marks (GetValue boot parity)');
  assert.equal(ev('floatp(250)'), 0);
  assert.equal(ev('floatp(0.5)'), 1, 'non-integers are floatp without a mark');
  // Marks are statement-scoped (session 54): a float() evaluated in one
  // statement must not float-divide a plain int/int division in a later
  // statement (the boot break was GetValue's float() marks leaking into
  // the wire encoders' truncating divisions).
  assert.equal(ev('float(250)'), 250);
  assert.equal(ev('250 / 500'), 0, 'float() mark does not leak into a later statement');
  // Stored floats DO survive across statements WITHIN one handler via the
  // per-handler name map (Gamesystem convertWorldToScreenCoordinate does
  // `tMultiplier = float(...)` then `tX / tMultiplier`).
  e.addScriptMember(
    'FloatStmtT',
    'movie',
    [
      'on storedFloat me',
      '  tM = float(250)',
      '  return tM / 500',
      'end',
      'on plainInt me',
      '  tM = 250',
      '  return tM / 500',
      'end',
    ].join('\n'),
  );
  const fScript = e.resolveScript('FloatStmtT')!;
  const storedFloat = fScript.handlers.find((h) => h.name.toLowerCase() === 'storedfloat')!;
  const plainInt = fScript.handlers.find((h) => h.name.toLowerCase() === 'plainint')!;
  assert.equal(
    e.interp.callHandler(fScript, storedFloat, [], null, new Set()),
    0.5,
    'stored float() assignment keeps float division later in the same handler',
  );
  assert.equal(
    e.interp.callHandler(fScript, plainInt, [], null, new Set()),
    0,
    'plain int assignment stays truncating division later in the same handler',
  );
  // integer()/trunc() produce INT values: they unmark, so a stale float()
  // mark can't float-divide a later wire-encoder `x / 64` (truncation parity).
  assert.equal(ev('integer(float(250)) / 4'), 62, 'integer() unmarks its int result');
  assert.equal(ev('trunc(float(250)) / 4'), 62);
  assert.equal(ev('floatp(integer(float(250)))'), 0);
  // The full Human lerp line at t = 0.5 still lands mid-way (regression guard).
  assert.deepEqual(
    (e.interp.evalExpressionString('([300, 400, 0] - [100, 200, 0]) * (float(250) / 500) + [100, 200, 0]') as LList).items,
    [200, 300, 0],
  );
});

test('integer() rounds to nearest (DirPlayer/LibreShockwave parity); trunc() truncates (U128 hilite)', () => {
  // Director docs: integer() "rounds the value of an expression to the nearest
  // whole integer" (integer(3.9) = 4); DirPlayer: Datum::Float(f) => f.round();
  // LibreShockwave: javaRoundToInt. Our integer() was Math.trunc — identical
  // to trunc() — so Room Geometry getWorldCoordinate resolved the CENTER of a
  // tile to the tile up-left and the room hiliter hovered the wrong tile.
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('integer(3.9)'), 4, 'integer(3.9) rounds to 4');
  assert.equal(ev('integer(9.5)'), 10, 'integer(9.5) rounds half away from zero to 10');
  assert.equal(ev('integer(10.5)'), 11, 'integer(10.5) rounds to 11');
  assert.equal(ev('integer(-2.5)'), -3, 'integer(-2.5) rounds half away from zero to -3');
  assert.equal(ev('trunc(3.9)'), 3, 'trunc() truncates (unchanged)');
  assert.equal(ev('trunc(-2.5)'), -2, 'trunc() toward zero');
  // Corpus Room Geometry getWorldCoordinate (private-room factors float()ed
  // exactly like getLocalFloat) — the hiliter's tX for the CENTER of tile
  // (10,10), screen (311,378). Must resolve 10 (was 9 = the up-left tile).
  assert.equal(
    ev('integer((311 - float(32) - float(311)) / float(64) + (378 - float(58)) / float(32))'),
    10,
    'getWorldCoordinate tX at the tile center rounds up over the -0.5 shift',
  );
});

test('integer() on a non-numeric string returns VOID (LibreShockwave parity — variable.index dump)', () => {
  // The corpus Variable Container dump parses `key = value` lines and converts
  // numeric-looking values with `if integerp(integer(tValue)) then if
  // length(string(integer(tValue))) = length(tValue) then tValue =
  // integer(tValue)`. hh_human's variable.index text member carries
  // `human.size.64 = h`, `human.size.32 = sh` and `human.parts.h = [...]`.
  // With integer("h") = 0 the guard converted "h" to 0 (integerp(0) is true
  // and both lengths are 1) and the part LIST to 0 — every figure lookup then
  // broke ("human.partset.figure.0 not found!", "No human part order found
  // human.parts.h.3", avatars never rendered). LibreShockwave's integer()
  // returns VOID for a non-numeric string, so integerp() is false and the
  // value survives untouched. "sh" was already safe (length 2 vs 1).
  const e = new DirectorEngine();
  const ev = (s: string) => e.interp.evalExpressionString(s);
  assert.equal(ev('voidp(integer("h"))'), 1, 'integer("h") is VOID');
  assert.equal(ev('voidp(integer("sh"))'), 1, 'integer("sh") is VOID');
  assert.equal(ev('integerp(integer("h"))'), 0, 'integerp(integer("h")) is false — the dump guard keeps "h"');
  // Numeric strings still convert (the dump converts "64" -> integer 64).
  assert.equal(ev('integer("64")'), 64, 'integer("64")');
  assert.equal(ev('integer("-5")'), -5, 'integer("-5")');
  assert.equal(ev('integer("3.9")'), 4, 'integer("3.9") rounds to 4');
  assert.equal(ev('integer(" 7 ")'), 7, 'integer(" 7 ") trims then converts');
  assert.equal(ev('integer("")'), 0, 'integer("") is 0 (LSW empty-string case)');
  // Director hex-string constants (*1A = 26).
  assert.equal(ev('integer("*1A")'), 26, 'integer("*1A") hex');
  // The dump parser's exact guard on the actual value that broke the figure:
  // length(string(integer("h"))) = length("h") must NOT hold.
  assert.equal(ev('length(string(integer("h"))) = length("h")'), 0, 'the length guard no longer fires for "h"');
});

test('float() assigned to an instance property stays Float across handlers (Room Geometry factors float-divide)', () => {
  // The corpus Room Geometry define() assigns pXOffset/pXFactor/etc. from
  // getLocalFloat (String Services -> float()), and getWorldCoordinate LATER
  // divides the mouse by them. Director keeps a Float datum Float when stored
  // in a property, so (mouse - pYFactor - pXOffset) / pXFactor must be FLOAT
  // division even when the (truncated) mouse is an integer. The engine's
  // statement-scoped floatVals / handler-scoped floatNames could not express
  // that, so the factors int-divided and the hiliter resolved the tile
  // up-left of the cursor (the mouse-truncation fix at 66b exposed it).
  const e = new DirectorEngine();
  e.addScriptMember(
    'Geo',
    'parent',
    [
      'property pXOffset',
      'property pYOffset',
      'property pZOffset',
      'property pXFactor',
      'property pYFactor',
      'property pHFactor',
      'property pIntDiv',
      'on construct me',
      '  pXOffset = 0.0',
      '  pYOffset = 0.0',
      '  pZOffset = 0.0',
      '  pXFactor = 0.0',
      '  pYFactor = 0.0',
      '  pHFactor = 0.0',
      '  return 1',
      'end',
      'on define me, tdata',
      '  pXOffset = float(tdata[#offsetx])',
      '  pYOffset = float(tdata[#offsety])',
      '  pXFactor = float(tdata[#factorx])',
      '  pYFactor = float(tdata[#factory])',
      '  pIntDiv = 16',
      '  return 1',
      'end',
      'on getWorldCoordinate me, tLocX, tLocY',
      '  tX = integer((tLocX - pYFactor - pXOffset) / pXFactor + (tLocY - pYOffset) / pYFactor)',
      '  tY = integer((tLocY - pYOffset) / pYFactor - (tLocX - pYFactor - pXOffset) / pXFactor)',
      '  return [tX, tY]',
      'end',
      'on intPropDiv me, tN',
      '  return tN / pIntDiv',
      'end',
    ].join('\n'),
  );
  const script = e.resolveScript('Geo')!;
  const geo = e.interp.newInstance(script, []);
  const tdata = e.interp.evalExpressionString('[#offsetx: 376, #offsety: 144, #offsetz: 0, #factorx: 32, #factory: 16, #factorh: 16]');
  e.interp.callObjectHandler(geo, 'define', [tdata]);
  const wc = (px: number, py: number) => {
    const r = e.interp.callObjectHandler(geo, 'getWorldCoordinate', [px, py]);
    return (r as { items: unknown[] }).items;
  };
  // Visual centers of den tiles (getScreenCoordinate(x,y) + (16,0) with the
  // left-vertex-anchored floor). Each must resolve to ITS OWN tile — before
  // the fix the int-division warped every center into tile (0,0)'s rectangle.
  assert.deepEqual(wc(392, 144), [0, 0], 'center of tile (0,0)');
  assert.deepEqual(wc(376, 152), [0, 1], 'center of tile (0,1)');
  assert.deepEqual(wc(408, 152), [1, 0], 'center of tile (1,0)');
  assert.deepEqual(wc(392, 160), [1, 1], 'center of tile (1,1)');
  assert.deepEqual(wc(424, 160), [2, 0], 'center of tile (2,0)');
  // A property assigned a plain INTEGER must still int-divide (no over-broad
  // floatness leak): 7 / 16 truncates to 0, never 0.4375.
  assert.equal(e.interp.callObjectHandler(geo, 'intPropDiv', [7]), 0, 'int-assigned prop still int-divides');
});

test('me.delay(ms, #handler, args) fires the handler later; me.Cancel(id) cancels it', () => {
  const e = new DirectorEngine();
  e.addScriptMember(
    'DelayedSrc',
    'parent',
    ['on ping me, v', '  global gDelayedPing', '  gDelayedPing = v', 'end'].join('\n'),
  );
  const script = e.resolveScript('DelayedSrc')!;
  const obj = e.interp.newInstance(script, []);
  e.setObjectById('delayObj', obj);
  e.boot();
  // me.delay(0, ...) — zero delay must still round-trip through the tick loop
  // (scheduled now, fires on the NEXT tick, exactly like the corpus's 50ms
  // removeCastLoadInstance: the millisecond value itself is incidental).
  const id = e.interp.evalExpressionString('getObject("delayObj").delay(0, #ping, 42)') as number;
  assert.ok(typeof id === 'number' && id > 0, 'delay() returns a cancelable id');
  assert.equal(e.globals.get('gdelayedping'), undefined, 'handler not fired before tick');
  e.tick();
  assert.equal(e.globals.get('gdelayedping'), 42, 'delayed handler fired on tick');
  // A scheduled call can be cancelled with me.Cancel(id) before its due time.
  const id2 = e.interp.evalExpressionString('getObject("delayObj").delay(100000, #ping, 7)') as number;
  e.interp.evalExpressionString(`getObject("delayObj").Cancel(${id2})`);
  e.tick();
  assert.equal(e.globals.get('gdelayedping'), 42, 'me.Cancel(id) suppresses the pending call');
  // The one-shot does NOT re-fire on later ticks (CastLoad Manager relies on
  // this: removeCastLoadInstance must run exactly once per download).
  e.tick();
  assert.equal(e.globals.get('gdelayedping'), 42, 'delay is one-shot');
});

test('member.type reports #field for text members (Dynamic Downloader acquireAssetsFromCast #field branch)', () => {
  // acquireAssetsFromCast switches on `case tMemType of ... #field:` to read
  // memberalias.index / asset.index and copy .props/.data to the bin. The
  // engine used to report #text for text members, making that branch dead —
  // the aliases were never registered and every furniture lookup fell back
  // to the PH placeholder ("Couldn't define members: club_sofa"). Director
  // calls text members #field.
  const e = new DirectorEngine();
  const cast = new CastLib(1, 'internal');
  const textMem = new Member(1, 1, 'memberalias.index', 'text');
  textMem.text = 'club_sofa.props=md_sofa.props\rclub_sofa_a_0_2_1_2_0=md_sofa_a_0_2_1_2_0';
  const bmp = new Member(1, 2, 'md_sofa_a_0_2_1_2_0', 'bitmap');
  bmp.raw = buildPng(2, 1, [255, 255, 255, 255, 0, 0, 0, 255]);
  cast.members.set(1, textMem);
  cast.members.set(2, bmp);
  cast.byName.set('memberalias.index', textMem);
  cast.byName.set('md_sofa_a_0_2_1_2_0', bmp);
  e.casts.push(cast);
  e.castByName.set('internal', cast);
  e.membersByGlobal.set((1 << 16) | 1, textMem);
  e.membersByGlobal.set((1 << 16) | 2, bmp);
  const t = e.getMemberProp(e.getMember(1, 1)!, 'type');
  assert.ok(t instanceof LSymbol, 'type is a symbol');
  assert.equal((t as LSymbol).name, 'field', 'text members report #field');
  const b = e.getMemberProp(e.getMember(2, 1)!, 'type');
  assert.equal((b as LSymbol).name, 'bitmap', 'bitmap members stay #bitmap');
  // The corpus branch decision the fix unlocks: `case tMemType of #field:`
  // now matches text members, so readAliasIndexesFromField can run.
  assert.equal((t as LSymbol).name === 'field', true);
});

test('field(name, castLibNum) reads the member in THAT cast (readAliasIndexesFromField)', () => {
  // Resource Manager readAliasIndexesFromField does `tAliasList =
  // field(tAliasIndex, tCastlibNo)` against the specific downloaded cast.
  // Each furniture cast ships its OWN memberalias.index; the builtin used to
  // ignore arg 2 and search all casts, which could read a stale alias file
  // from another cast and mis-map the furniture names.
  const e = new DirectorEngine();
  const castA = new CastLib(1, 'internal');
  const a = new Member(1, 1, 'memberalias.index', 'text');
  a.text = 'aaa=AAA';
  castA.members.set(1, a);
  castA.byName.set('memberalias.index', a);
  const castB = new CastLib(2, 'furni');
  const b = new Member(2, 1, 'memberalias.index', 'text');
  b.text = 'bbb=BBB';
  castB.members.set(1, b);
  castB.byName.set('memberalias.index', b);
  e.casts.push(castA, castB);
  e.castByName.set('internal', castA);
  e.castByName.set('furni', castB);
  e.membersByGlobal.set((1 << 16) | 1, a);
  e.membersByGlobal.set((2 << 16) | 1, b);
  // field("memberalias.index", 2) must read cast B's file, not cast A's.
  assert.equal(e.interp.evalExpressionString('field("memberalias.index", 2)'), 'bbb=BBB');
  assert.equal(e.interp.evalExpressionString('field("memberalias.index", 1)'), 'aaa=AAA');
  // castLib-ref / string-name 2nd args resolve like member() (asNum would
  // coerce a name to 0 and read the wrong cast's alias file).
  assert.equal(e.interp.evalExpressionString('field("memberalias.index", castLib(2))'), 'bbb=BBB');
  assert.equal(e.interp.evalExpressionString('field("memberalias.index", "furni")'), 'bbb=BBB');
});

test('member(negative) resolves to the absolute member number (*-alias direction variants)', () => {
  // readAliasIndexesFromField registers `-tNumber` for `*` alias lines
  // (e.g. `club_sofa_a_0_2_1_4_0=club_sofa_a_0_2_1_2_0*` — a direction
  // variant pointing at another alias), and solveMembers calls
  // `member(tMemNum)` with that negative value. Director resolves
  // member(-n) to member(n); without it the *-aliased furniture variants
  // fell back to the PH placeholder.
  const e = new DirectorEngine();
  const cast = new CastLib(1, 'internal');
  const art = new Member(1, 1, 'club_sofa_a_0_2_1_2_0', 'bitmap');
  art.raw = buildPng(1, 1, [200, 200, 200, 255]);
  cast.members.set(1, art);
  cast.byName.set('club_sofa_a_0_2_1_2_0', art);
  e.casts.push(cast);
  e.castByName.set('internal', cast);
  e.membersByGlobal.set((1 << 16) | 1, art);
  const ref = e.interp.evalExpressionString('member(-65537)');
  assert.ok(ref !== VOID && ref !== null, 'member(-n) resolves');
  assert.equal(e.getMemberProp(ref as never, 'name'), 'club_sofa_a_0_2_1_2_0');
  assert.equal(e.getMemberProp(ref as never, 'castLibNum'), 1);
  assert.equal(e.getMember(-65537)?.name, 'club_sofa_a_0_2_1_2_0', 'getMember(-n) resolves too');
});

test('member(name, castLibName) resolves with a string cast name (copyMemberToBin bin lookups)', () => {
  // acquireAssetsFromCast gates the bitmap copy on
  // `member(tMemName, pBinCastName).name <> tMemName` where pBinCastName is
  // the STRING "bin". asNum("bin") coerced to 0 and every lookup resolved
  // nothing, so the copy ran for every member (duplicates) or the gate
  // misread. String cast names must resolve through castByName.
  const e = new DirectorEngine();
  const bin = new CastLib(3, 'bin');
  const art = new Member(3, 1, 'club_sofa_a_0_2_1_2_0', 'bitmap');
  art.raw = buildPng(1, 1, [200, 200, 200, 255]);
  bin.members.set(1, art);
  bin.byName.set('club_sofa_a_0_2_1_2_0', art);
  e.casts.push(new CastLib(1, 'internal'), new CastLib(2, 'fuse_client'), bin);
  e.castByName.set('internal', e.casts[0]);
  e.castByName.set('fuse_client', e.casts[1]);
  e.castByName.set('bin', bin);
  e.membersByGlobal.set((3 << 16) | 1, art);
  const ref = e.interp.evalExpressionString('member("club_sofa_a_0_2_1_2_0", "bin")');
  assert.ok(ref !== VOID && ref !== null, 'member(name, "bin") resolves');
  const name = e.getMemberProp(ref as never, 'name');
  assert.equal(name, 'club_sofa_a_0_2_1_2_0');
  const castLib = e.getMemberProp(ref as never, 'castLibNum');
  assert.equal(castLib, 3, 'resolved in the bin cast');
  // The gate form used in acquireAssetsFromCast: the name matches, so the
  // copy is correctly skipped.
  assert.equal(name === 'club_sofa_a_0_2_1_2_0', true);
});

test('bare member(localNum) scan skips unnamed bin members (window GUI art must not shadow furniture members)', () => {
  // Windows create bin-cast bitmap members for every element and on close
  // only rename them EMPTY (removeMember for a bitmap does
  // `tmember.name = EMPTY`) — the member lingers in the bin (slot 3, the
  // FIRST dynamic slot) still carrying the window's GUI art. A bare
  // `member(localNum)` scan (engine-only fallback; Director never scans all
  // casts for a local number) hitting such a member would resolve the GUI
  // art for furniture shadows/icons — the "gui sprite from the sound machine
  // on a furniture shadow" corruption. Unnamed members are not addressable
  // by name in Director, so the scan must never hand one out.
  const e = new DirectorEngine();
  // bin (slot 3): leftover window member, renamed EMPTY, still has art.
  const bin = new CastLib(3, 'bin');
  const gui = new Member(3, 5, '', 'bitmap'); // removeMember renamed it EMPTY
  gui.raw = buildPng(1, 1, [255, 0, 0, 255]);
  bin.members.set(5, gui);
  // hh_furni cast (slot 5): the real member the caller wants.
  const furni = new CastLib(5, 'hh_furni_xx_club_sofa');
  const art = new Member(5, 5, 'club_sofa_a_0_2_1_2_0', 'bitmap');
  art.raw = buildPng(1, 1, [200, 200, 200, 255]);
  furni.members.set(5, art);
  furni.byName.set('club_sofa_a_0_2_1_2_0', art);
  e.casts.push(new CastLib(1, 'internal'), new CastLib(2, 'fuse_client'), bin, new CastLib(4, 'empty 1'), furni);
  for (const c of e.casts) e.castByName.set(c.name, c);
  e.membersByGlobal.set((3 << 16) | 5, gui); // bin member registered as usual
  e.membersByGlobal.set((5 << 16) | 5, art);

  // The named member in a later slot wins — the unnamed GUI member is skipped.
  const hit = e.getMember(5);
  assert.ok(hit, 'bare member(5) resolves');
  assert.equal(hit.castLibNumber, 5, 'skipped the unnamed bin member (slot 3)');
  assert.equal(hit.name, 'club_sofa_a_0_2_1_2_0');

  // With ONLY the unnamed member present, the scan resolves nothing — it must
  // not return GUI art for a number no named member owns.
  const solo = new DirectorEngine();
  const binOnly = new CastLib(3, 'bin');
  const guiOnly = new Member(3, 9, '', 'bitmap');
  guiOnly.raw = buildPng(1, 1, [255, 0, 0, 255]);
  binOnly.members.set(9, guiOnly);
  solo.casts.push(new CastLib(1, 'internal'), new CastLib(2, 'fuse_client'), binOnly);
  solo.castByName.set('internal', solo.casts[0]);
  solo.castByName.set('fuse_client', solo.casts[1]);
  solo.castByName.set('bin', binOnly);
  solo.membersByGlobal.set((3 << 16) | 9, guiOnly);
  assert.equal(solo.getMember(9), null, 'unnamed member never resolves via the bare scan');
  // The global-encoded path still finds it (that is how the RM cache and
  // named lookups legitimately address it).
  assert.equal(solo.getMember((3 << 16) | 9)?.name, '');
});

test('dynamic download rename (full CDN URL) fills the empty shell in place for acquireAssetsFromCast', async () => {
  // executeDownloadRequest -> startCastLoad(fullUrl) queues the FULL URL;
  // DoneCurrentDownLoad -> setImportedCast renames the empty shell to that
  // URL (`tCastLib.name = tCastName`, tCastName = pFile = the URL). Bundles
  // are keyed by the bare cast name (hh_furni_xx_club_sofa), so the engine
  // must resolve through castNameFromUrl but fill THIS shell (its number is
  // what acquireAssetsFromCast reads) and keep the URL name (the corpus's
  // FindCastNumber matches on the exact name).
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
  });
  const sofa = makeCastZip('hh_furni_xx_club_sofa', [], {
    '0001_script_SofaClass.ls': '-- Cast member: SofaClass\n-- Type: Movie Script\non prepare me\n  return 1\nend\n',
    '0002_script_SofaClass2.ls': '-- Cast member: SofaClass2\n-- Type: Movie Script\non update me\n  return 2\nend\n',
  });
  const source: BundleSource = {
    async fetchBundle(name: string, _onProgress?: (soFar: number, total: number) => void) {
      if (name === 'hh_furni_xx_club_sofa') {
        _onProgress?.(sofa.length, sofa.length); // real fetch reports bytes; kills the fake ramp
        return sofa;
      }
      return name === 'habbo' ? habbo : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  e.boot(); // preloadNetThing ramps need tick() to advance
  const url = 'http://localhost:5173/casts/hof_furni/hh_furni_xx_club_sofa.cct';
  const slot = e.castByName.get('empty 1')!;
  const slotRef = e.getCastLib(4)!;
  assert.equal(slot.members.size, 0);

  // The corpus preloads the furniture cast by CDN URL: bundle lands in the
  // loader cache; the cast is NOT registered into an engine shell yet.
  const id = e.preloadNetThing(url);
  await new Promise((r) => setTimeout(r, 0));
  e.tick();
  assert.equal(e.netDone(id), 1, 'furniture preload completes');
  assert.ok(loader.getCast('hh_furni_xx_club_sofa'), 'bundle fetched into the loader');

  const indexLogCount = () => e.logs.filter((l) => l.startsWith('DBG indexCast')).length;
  const preIndex = indexLogCount();

  // setImportedCast: tCastLib.name = tCastName (the full CDN URL).
  e.setCastLibProp(slotRef, 'name', url);
  const registered = e.castByName.get('hh_furni_xx_club_sofa');
  assert.ok(registered, 'bare-name lookup resolves after the URL rename');
  assert.equal(registered.loaded, true, 'bundle registered');
  assert.equal(registered.number, slot.number, 'filled the SAME empty shell (not appended)');
  assert.ok(registered.members.size >= 2, 'members copied in place');
  assert.equal(e.getCastLib(url)?.number, slot.number, 'full-URL name resolves to the same slot (FindCastNumber)');
  assert.ok(e.resolveScript('SofaClass'), 'script member resolvable');
  // Dynamic downloads are imported with tDoIndexing=0 (setImportedCast skips
  // preIndexMembers). If the engine pre-indexed here, the cast's md_* member
  // names would land in pAllMemNumList with cast-slot numbers, copyMemberToBin
  // would skip the bin copy, and club_sofa.props would alias to a slot that
  // ResetOneDynamicCast wipes — `club_sofa.props is not valid!`.
  assert.equal(indexLogCount(), preIndex, 'dynamic (URL) rename does NOT pre-index (tDoIndexing=0)');

  // ResetOneDynamicCast renames the slot back to "empty N" (room leave). The
  // bare-name alias must not linger on the wiped shell, or a later
  // castExists/castLib(name) lookup resolves an empty cast.
  e.setCastLibProp(slotRef, 'name', 'empty 1');
  assert.equal(slot.loaded, false, 'shell wiped at reset');
  assert.equal(e.castByName.get('hh_furni_xx_club_sofa'), undefined, 'bare-name alias cleaned on reset');
  assert.equal(e.castByName.get(url), undefined, 'URL name cleaned on reset');
  assert.equal(e.getCastLib('empty 1')?.number, slot.number, 'pool marker kept');

  // Boot casts (Core Thread startCastLoad) rename with BARE names and
  // tDoIndexing=1 — those must still pre-index (connection.info.id etc. come
  // from preIndexMembers' variable.index/class.index/alias.index dumps).
  const bootIndex = indexLogCount();
  e.setCastLibProp(slotRef, 'name', 'hh_furni_xx_club_sofa');
  assert.equal(e.castByName.get('hh_furni_xx_club_sofa')?.loaded, true, 'boot-style bare rename registers the bundle');
  assert.ok(
    e.logs.slice(bootIndex).some((l) => l.startsWith(`DBG indexCast(${slot.number} `)),
    'boot-style rename pre-indexes this exact slot (tDoIndexing=1)'
  );
});

test('directorTransformFlip: rotation 180 + skew 180 is a horizontal mirror (Director semantics)', () => {
  // The corpus's furniture-flip trick (`*` memberalias variants):
  //   if tSpr.rotation = 180 then tSpr.skew = 180
  // In Director that pair is a horizontal mirror — LibreShockwave's
  // hasDirectorHorizontalMirror(rot==180 && skew==180) with
  // effectiveFlipH = isFlipH ^ mirror; DirPlayer's is_skew_flip agrees.
  // A naive pixi rotation 180 + skewX 180 would render a point reflection
  // (upside down) instead, so the engine folds the pair into flipX.

  // The mirror pair renders as identity rotation with flipX -1.
  assert.deepEqual(directorTransformFlip(180, 180, 0), { flipX: -1, mirrored: true });
  // Negative/overflowing angles normalize to the same 180/180 pair.
  assert.deepEqual(directorTransformFlip(-180, -180, 0), { flipX: -1, mirrored: true });
  assert.deepEqual(directorTransformFlip(540, 540, 0), { flipX: -1, mirrored: true });
  // XOR with flipH: a flipH sprite mirrored again ends up right-side up.
  assert.deepEqual(directorTransformFlip(180, 180, 1), { flipX: 1, mirrored: true });
  // Plain 180 rotation (no skew) is a real rotation, not a mirror.
  assert.deepEqual(directorTransformFlip(180, 0, 0), { flipX: 1, mirrored: false });
  assert.deepEqual(directorTransformFlip(0, 180, 0), { flipX: 1, mirrored: false });
  // Real rotations and plain flips are untouched.
  assert.deepEqual(directorTransformFlip(90, 0, 0), { flipX: 1, mirrored: false });
  assert.deepEqual(directorTransformFlip(0, 0, 1), { flipX: -1, mirrored: false });
  assert.deepEqual(directorTransformFlip(0, 0, 0), { flipX: 1, mirrored: false });
});

test('member change resets rotation/skew/flipH/flipV (releaseSprite reuse); castNum keeps them (furniture flip)', () => {
  // DirPlayer sprite.rs reset_for_member_change: the Member setter resets
  // transforms (FUSE releaseSprite releases via `tsprite.member = member(0)`),
  // but castNum does NOT — so the furniture flip (`tSpr.rotation = 180;
  // tSpr.skew = 180` set BEFORE `tSpr.castNum = tMemNum`) survives. Without
  // the member-side reset, a flipped furniture sprite released and reused by
  // a navigator window kept its mirror and rendered window pieces flipped.
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);
  const m1 = new Member(1, 7, 'furni_a', 'bitmap');
  const m2 = new Member(1, 8, 'furni_b', 'bitmap');
  cast.members.set(7, m1);
  cast.members.set(8, m2);
  cast.byName.set('furni_a', m1);
  cast.byName.set('furni_b', m2);
  e.membersByGlobal.set((1 << 16) | 7, m1);
  e.membersByGlobal.set((1 << 16) | 8, m2);
  e.addScriptMember('T', 'movie', [
    'on run',
    '  puppetSprite(3, 1)',
    '  sprite(3).rotation = 180',
    '  sprite(3).skew = 180',
    '  sprite(3).flipH = 1',
    '  sprite(3).castNum = 7',
    '  tA = sprite(3).rotation & "," & sprite(3).skew & "," & sprite(3).flipH',
    '  sprite(3).member = member(0)',
    '  tB = sprite(3).rotation & "," & sprite(3).skew & "," & sprite(3).flipH & "," & sprite(3).flipV',
    '  sprite(3).castNum = 8',
    '  tC = sprite(3).rotation & "," & sprite(3).skew & "," & sprite(3).flipH',
    '  return tA & "|" & tB & "|" & tC',
    'end',
  ].join('\n'));
  const s = e.resolveScript('T')!;
  const run = s.handlers.find((h) => h.name.toLowerCase() === 'run')!;
  assert.equal(e.interp.callHandler(s, run, [], null, new Set()), '180,180,1|0,0,0,0|0,0,0');
});

test('inverseDirectorTransformPoint: hit tests mirror with the rendered sprite (furniture flip)', () => {
  // The corpus flip is `rotation 180 + skew 180` = horizontal mirror around
  // the sprite loc (DirPlayer concrete_sprite_hit_test inverse transform).
  // A point on the mirrored side must map back into the untransformed rect.
  // Mirror pair: loc at 100, point 30px right of loc maps 30px left.
  assert.deepEqual(inverseDirectorTransformPoint(180, 180, 0, 0, 100, 200, 130, 200), { tx: 70, ty: 200 });
  // Negative/overflowing angles normalize the same.
  assert.deepEqual(inverseDirectorTransformPoint(-180, -180, 0, 0, 100, 200, 130, 200), { tx: 70, ty: 200 });
  // flipH XOR mirror: a flipH sprite mirrored again renders right-side up.
  assert.deepEqual(inverseDirectorTransformPoint(180, 180, 1, 0, 100, 200, 130, 200), { tx: 130, ty: 200 });
  // Plain flipH mirrors x; flipV mirrors y.
  assert.deepEqual(inverseDirectorTransformPoint(0, 0, 1, 0, 100, 200, 130, 200), { tx: 70, ty: 200 });
  assert.deepEqual(inverseDirectorTransformPoint(0, 0, 0, 1, 100, 200, 130, 220), { tx: 130, ty: 180 });
  // Real rotation (no mirror) inverse-rotates around the loc.
  const p = inverseDirectorTransformPoint(90, 0, 0, 0, 0, 0, 10, 0);
  assert.ok(Math.abs(p.tx - 0) < 0.001 && Math.abs(p.ty - (-10)) < 0.001, `90deg rotate got ${JSON.stringify(p)}`);
  // No transform: identity.
  assert.deepEqual(inverseDirectorTransformPoint(0, 0, 0, 0, 100, 200, 130, 220), { tx: 130, ty: 220 });
});

test('member.media copies text/script payloads (Dynamic Downloader copyMemberToBin)', () => {
  // acquireAssetsFromCast copies every furniture member into the bin cast via
  // `tTargetMember.media = tSourceMember.media`. For a .props/.data field the
  // media IS the text — a bin copy that dropped it made
  // `value(field(getmemnum(pClass & ".props")))` read EMPTY and every
  // furniture's solveInk/solveBlend/solveLocZ error'd `*.props is not
  // valid!` (inks 41/33 never applied: the sound machine's on-light and the
  // hc_tv screen cover rendered as plain art). Run the copy in REAL statement
  // context (evalExpressionString treats `=` as equality, not assignment).
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);
  const src = new Member(1, 8, 'sound_machine.props', 'text');
  src.text = '["a": [:], "c": [#ink: 41], "d": [#ink: 33]]';
  cast.members.set(8, src);
  cast.byName.set('sound_machine.props', src);
  e.membersByGlobal.set((1 << 16) | 8, src);
  const dst = new Member(1, 9, 'sound_machine.props', 'text');
  cast.members.set(9, dst);
  cast.byName.set('sound_machine.props', dst);
  e.membersByGlobal.set((1 << 16) | 9, dst);

  // Bitmap media: the raw payload AND the .pal companion travel (the bin copy
  // is what renders — the matte keys the background by palette index 0).
  const bmpSrc = new Member(1, 10, 'hc_tv_g_0_2_1_2_0', 'bitmap');
  bmpSrc.raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  bmpSrc.palette = [[255, 255, 255], [2, 3, 2]];
  bmpSrc.regX = 37;
  bmpSrc.regY = 134;
  cast.members.set(10, bmpSrc);
  cast.byName.set('hc_tv_g_0_2_1_2_0', bmpSrc);
  e.membersByGlobal.set((1 << 16) | 10, bmpSrc);
  const bmpDst = new Member(1, 11, 'hc_tv_g_0_2_1_2_0', 'bitmap');
  cast.members.set(11, bmpDst);
  cast.byName.set('hc_tv_g_0_2_1_2_0', bmpDst);
  e.membersByGlobal.set((1 << 16) | 11, bmpDst);
  e.setMemberProp(e.getMember((1 << 16) | 11)!, 'media', e.getMember((1 << 16) | 10)!);
  assert.equal(bmpDst.raw, bmpSrc.raw, 'bitmap payload must travel with media');
  assert.equal(bmpDst.palette, bmpSrc.palette, 'palette must travel with media (matte key source)');
  assert.equal(bmpDst.regX, 37);
  assert.equal(bmpDst.regY, 134);

  const mem = e.addScriptMember('Copier', 'parent', `
on copyMedia me, tSrc, tDst
  member(tDst).media = member(tSrc).media
  return member(tDst).text
end
`);
  const script = mem.script!;
  const copyMedia = script.handlers.find((h) => h.name.toLowerCase() === 'copymedia')!;
  const instance = e.interp.makeInstance(script, 'Copier');
  const copied = e.interp.callHandler(script, copyMedia, [8, 9], instance, new Set());
  assert.equal(copied, src.text, 'media copy must transfer the field member\'s text');
  assert.equal(dst.text, src.text);
  // And the corpus read path now parses: value(field(...)) is a #propList.
  const ilk = e.interp.evalExpressionString('ilk(value(field(9)))');
  assert.equal(ilk instanceof LSymbol && ilk.name, 'propList');
  // lineCount backs the asset.index iteration (repeat 1 to tmember.lineCount);
  // a trailing newline is an empty final line, like the engine's `the number
  // of lines in X` chunk semantics.
  const alias = new Member(1, 5, 'asset.index', 'text');
  alias.text = 'line one\nline two\n';
  cast.members.set(5, alias);
  cast.byName.set('asset.index', alias);
  e.membersByGlobal.set((1 << 16) | 5, alias);
  assert.equal(e.getMemberProp(e.getMember((1 << 16) | 5)!, 'linecount'), 3);
  assert.equal(e.interp.evalExpressionString('member(5).line[2]'), 'line two');
  assert.equal(e.interp.evalExpressionString('member(5).line[3]'), '');
});

test('member.duration: sound members report MP3 length in ms, others silently 0', () => {
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);

  // One MPEG1 Layer III frame @128kbps/44.1kHz = 417 bytes; 1152 samples /
  // 44100 Hz = 26.12ms. Header FF FB 90 00 (version 3, layer III, brIdx 9,
  // srIdx 0, no padding).
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const snd = new Member(1, 132, 'sound_machine_sample_1', 'sound');
  snd.raw = frame;
  cast.members.set(132, snd);
  cast.byName.set('sound_machine_sample_1', snd);
  e.membersByGlobal.set((1 << 16) | 132, snd);

  const ref = e.getMember((1 << 16) | 132)!;
  const dur = e.getMemberProp(ref, 'duration');
  assert.equal(typeof dur, 'number');
  assert.ok((dur as number) > 0, 'sound duration must be a positive ms value');
  assert.ok(Math.abs((dur as number) - 26) <= 1, `expected ~26ms, got ${dur}`);

  // Non-sound members read 0 silently (no "unsupported property" warn spam).
  const txt = new Member(1, 3, 'some.text', 'text');
  txt.text = 'x';
  cast.members.set(3, txt);
  cast.byName.set('some.text', txt);
  e.membersByGlobal.set((1 << 16) | 3, txt);
  const before = e.logs.length;
  assert.equal(e.getMemberProp(e.getMember((1 << 16) | 3)!, 'duration'), 0);
  assert.ok(!e.logs.slice(before).some((l) => l.includes('unsupported property')), 'no unsupported-property warn for non-sound duration');

  // The Song Controller path: getMember(name).duration returns a number.
  // A missing/garbage payload reads 0 (no crash, no NaN).
  const empty = new Member(1, 133, 'sound_machine_sample_2', 'sound');
  empty.raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  cast.members.set(133, empty);
  cast.byName.set('sound_machine_sample_2', empty);
  e.membersByGlobal.set((1 << 16) | 133, empty);
  assert.equal(e.getMemberProp(e.getMember((1 << 16) | 133)!, 'duration'), 0);
});

test('member.duration: sound samples near a 2000ms slot boundary snap down to the declared slot length', () => {
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);

  // Habbo's sound-machine samples declare durations that are exact multiples
  // of the 2000ms timeline slot (2000/4000/8000...) while the MP3 payloads run
  // ~140-155ms longer (encoder tail). The raw frame-walk would push the corpus's
  // ceil(duration/2000) slot count one over, `tRepeats = length/slotLength`
  // truncates to 0, and the room song's timeline never fills. The runtime snaps
  // a duration within 200ms above a 2000ms multiple back down to it.
  // One MPEG1 Layer III frame @128kbps/44.1kHz = 417 bytes = 26.12ms.
  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const frames = (n: number): Uint8Array => {
    const out = new Uint8Array(417 * n);
    for (let i = 0; i < n; i++) out.set(frame, i * 417);
    return out;
  };
  const mkSound = (num: number, name: string, raw: Uint8Array) => {
    const m = new Member(1, num, name, 'sound');
    m.raw = raw;
    cast.members.set(num, m);
    cast.byName.set(name, m);
    e.membersByGlobal.set((1 << 16) | num, m);
  };

  // 82 frames = 2142ms (declared 2000ms) -> snaps to 2000ms = 1 slot.
  mkSound(200, 'sound_machine_sample_snap', frames(82));
  assert.equal(e.getMemberProp(e.getMember((1 << 16) | 200)!, 'duration'), 2000);

  // 111 frames = 2899ms (far from a 2000ms multiple) -> left as-is.
  mkSound(201, 'sound_machine_sample_nosnap', frames(111));
  const nosnap = e.getMemberProp(e.getMember((1 << 16) | 201)!, 'duration') as number;
  assert.ok(nosnap > 2890 && nosnap < 2910, `expected ~2899ms unsnapped, got ${nosnap}`);

  // 155 frames = 4049ms (declared 4000ms + encoder overhang) -> snaps to 4000ms = 2 slots.
  mkSound(202, 'sound_machine_sample_boundary', frames(155));
  assert.equal(e.getMemberProp(e.getMember((1 << 16) | 202)!, 'duration'), 4000);

  // Short effects (< 2000ms) are never snapped.
  mkSound(203, 'sfx_click', frames(20));
  const click = e.getMemberProp(e.getMember((1 << 16) | 203)!, 'duration') as number;
  assert.ok(click > 520 && click < 530, `expected ~522ms, got ${click}`);
});

test('sound channels: puppetSound + sound(n) play/queue/stop/volume drive the audio host', () => {
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);

  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const snd = new Member(1, 132, 'sound_machine_sample_1', 'sound');
  snd.raw = frame;
  cast.members.set(132, snd);
  cast.byName.set('sound_machine_sample_1', snd);
  e.membersByGlobal.set((1 << 16) | 132, snd);

  const calls: string[] = [];
  e.audioHost = {
    play: (_ch, name, _raw, opts) => calls.push(`play:${name}:${opts.loop ? 'loop' : 'once'}:${opts.volume}`),
    stop: (ch) => calls.push(`stop:${ch}`),
    setVolume: (ch, v) => calls.push(`vol:${ch}:${v}`),
    isBusy: () => false,
  };

  // puppetSound(3, member) — immediate play, no loop.
  e.puppetSound(3, (1 << 16) | 132);
  assert.deepEqual(calls, ['stop:3', 'play:sound_machine_sample_1:once:255']);

  // sound(3) returns a sound-channel object; the raw channel is busy.
  const ch = e.interp.evalExpressionString('sound(3)');
  assert.ok(ch instanceof LObject);
  assert.equal((ch as LObject).scriptName, 'sound:3');
  assert.equal(e.interp.evalExpressionString('sound(3).isBusy()'), 1);

  // Director play([#member: m, #loopCount: n]) — loopCount 0 = infinite loop.
  calls.length = 0;
  const loopRes = e.interp.evalExpressionString(`sound(3).play([#member: ${(1 << 16) | 132}, #loopCount: 0])`);
  assert.equal(loopRes, 1);
  assert.deepEqual(calls, ['stop:3', 'play:sound_machine_sample_1:loop:255']);

  // queue + getPlaylist + count (the Sound Machine's set-list paging).
  e.interp.evalExpressionString(`sound(3).queue([#member: ${(1 << 16) | 132}])`);
  const list = e.interp.evalExpressionString('sound(3).getPlaylist()');
  assert.ok(list instanceof LList);
  assert.equal((list as LList).items.length, 1);
  assert.equal(e.interp.evalExpressionString('sound(3).getPlaylist().count'), 1);

  // `sound(n).volume = v` (Sound Channel Class setSoundState) routes to the
  // audio host's gain, through the Lingo assignment path.
  calls.length = 0;
  const script = e.addScriptMember('volSetter', 'parent', `on setVol me, tCh, tVol
  tCh.volume = tVol
end`);
  const inst = e.interp.makeInstance(script.script!);
  e.interp.callObjectHandler(inst, 'setVol', [ch, 128]);
  assert.deepEqual(calls, ['vol:3:128']);

  // stop() clears the channel; the queue is dropped with it.
  calls.length = 0;
  assert.equal(e.interp.evalExpressionString('sound(3).stop()'), 1);
  assert.deepEqual(calls, ['stop:3']);
  assert.equal(e.interp.evalExpressionString('sound(3).isBusy()'), 0);
  assert.equal(e.interp.evalExpressionString('sound(3).getPlaylist().count'), 0);
});

test('Song Player builtins: queueSound/startSoundChannel/stopSoundChannel/playSoundInChannel drive the audio host', () => {
  // The Song Player (hh_shared 0055) plays the sound machine's tracks through
  // the legacy Director sound builtins — reserveSongChannels does
  // `queueSound(name, ch) + startSoundChannel(ch)`, addPlayRound queues whole
  // songs, and startSamplePreview uses `playSoundInChannel(name, ch)`. These
  // were unregistered builtins (no-op -> the machine stayed silent while
  // credits/puppetSound worked).
  const e = new DirectorEngine();
  const cast = e.casts[0] ?? new CastLib(1, 'internal');
  if (!e.casts.includes(cast)) e.casts.push(cast);

  const frame = new Uint8Array(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0x00;
  const snd = new Member(1, 132, 'sound_machine_sample_1', 'sound');
  snd.raw = frame;
  cast.members.set(132, snd);
  cast.byName.set('sound_machine_sample_1', snd);
  e.membersByGlobal.set((1 << 16) | 132, snd);

  const calls: string[] = [];
  e.audioHost = {
    play: (_ch, name, _raw, opts) => calls.push(`play:${_ch}:${name}:${opts.loop ? 'loop' : 'once'}`),
    stop: (ch) => calls.push(`stop:${ch}`),
    setVolume: () => {},
    isBusy: () => false,
  };

  // reserveSongChannels: queueSound(name, ch) then startSoundChannel(ch). The
  // queued entry carries .member so the Song Player's checkLoopData can read
  // `tPlayList[i].member.duration` — check BEFORE start consumes the queue.
  e.interp.evalExpressionString('queueSound("sound_machine_sample_1", 1)');
  assert.equal(e.interp.evalExpressionString('sound(1).getPlaylist().count'), 1);
  assert.equal(e.interp.evalExpressionString('sound(1).getPlaylist()[1].member.duration'), 26);
  calls.length = 0;
  assert.equal(e.interp.evalExpressionString('startSoundChannel(1)'), 1);
  assert.deepEqual(calls, ['play:1:sound_machine_sample_1:once']);
  // The queue advances as sounds end: playing consumed the entry.
  assert.equal(e.interp.evalExpressionString('sound(1).getPlaylist().count'), 0);

  // addPlayRound queue entries with a #startTime prop survive (host can't
  // seek, but the entry keeps the prop).
  calls.length = 0;
  e.interp.evalExpressionString('stopSoundChannel(1)');
  assert.deepEqual(calls, ['stop:1']);
  e.interp.evalExpressionString('queueSound("sound_machine_sample_1", 2, [#startTime: 10])');
  const entry2 = e.interp.evalExpressionString('sound(2).getPlaylist()[1]');
  assert.ok(entry2 instanceof LPropList);
  assert.equal((entry2 as LPropList).props.get('startTime'), 10);

  // startSamplePreview: playSoundInChannel(name, ch) — 1 on success, 0 when
  // the member is missing (the Song Player turns 0 into an error).
  calls.length = 0;
  assert.equal(e.interp.evalExpressionString('playSoundInChannel("sound_machine_sample_1", 5)'), 1);
  assert.deepEqual(calls, ['stop:5', 'play:5:sound_machine_sample_1:once']);
  assert.equal(e.interp.evalExpressionString('playSoundInChannel("no_such_sample", 5)'), 0);

  // stopSong's channel loop uses stopSoundChannel per channel.
  calls.length = 0;
  e.interp.evalExpressionString('stopSoundChannel(5)');
  assert.deepEqual(calls, ['stop:5']);
  assert.equal(e.interp.evalExpressionString('sound(5).isBusy()'), 0);
  assert.equal(e.interp.evalExpressionString('sound(5).getPlaylist().count'), 0);
});

test('updated movie boot: the traceScript/traceLogFile/activeWindow props, _movie/_player globals, windowList guard', async () => {
  // Mirrors exported/habbo/scripts/0003_script_Initialization.ls: the guards
  // read `the traceScript`, set it + traceLogFile to EMPTY, poke
  // `_movie.traceScript` / `_player.traceScript`, check
  // `_player.windowList.count` and `(the activeWindow).name`, and call
  // stopClient() via stopMovie(). None of these may warn.
  const src = `-- Cast member: Initialization
-- Type: Movie Script

global _player
global gTrace
global gWindowCount
global gActiveWindowName

on prepareMovie
  gTrace = the traceScript
  if the traceScript then
    return 0
  end if
  the traceScript = 0
  the traceLogFile = EMPTY
  _movie.traceScript = 0
  _player.traceScript = 0
  gWindowCount = _player.windowList.count
  if _player.windowList.count > 0 then
    return stopMovie()
  end if
  gActiveWindowName = (the activeWindow).name
  if (the activeWindow).name <> "stage" then
    return stopMovie()
  end if
  return 1
end
on stopMovie
  stopClient()
  go(1)
end
`;
  const habbo = makeMovieCastZip('habbo', [], {
    '0001_script_Loop.ls': '-- Cast member: Loop\n-- Type: Score\non exitFrame me\n  go(the frame)\nend\n',
    '0003_script_Initialization.ls': src,
  });
  const source: BundleSource = {
    async fetchBundle(name: string) {
      return name === 'habbo' ? habbo : null;
    },
  };
  const loader = new BundleLoader(source);
  const e = new DirectorEngine();
  await e.loadCast(loader, 'habbo');
  e.boot();
  // The boot guards passed cleanly: no unsupported-property / unresolved-
  // handler / undeclared-identifier noise, and the movie ran through.
  const bad = e.logs.filter(
    (l) => l.includes('unsupported') || l.includes('unresolved') || l.includes('undeclared identifier'),
  );
  assert.deepEqual(bad, [], `boot must be quiet: ${JSON.stringify(e.logs)}`);
  assert.equal(e.globalGet('gTrace'), 0);
  assert.equal(e.globalGet('gWindowCount'), 0);
  assert.equal(e.globalGet('gActiveWindowName'), 'stage');
  // Director property defaults + round-trips.
  assert.equal(e.getThe('tracescript', []), 0);
  assert.equal(e.getThe('tracelogfile', []), '');
  e.setThe('tracescript', [], 1);
  assert.equal(e.getThe('tracescript', []), 1);
  e.setThe('tracelogfile', [], 'trace.log');
  assert.equal(e.getThe('tracelogfile', []), 'trace.log');
  // `_player.windowList` reflects opened windows (the single-instance guard);
  // `_movie.traceScript` was set by the movie.
  e.createWindow('mywin');
  assert.equal(e.interp.evalExpressionString('_player.windowList.count'), 1);
  assert.equal(e.interp.evalExpressionString('_movie.traceScript'), 0);
});

test('the activeWindow defaults to the stage; name is the window id', () => {
  const e = new DirectorEngine();
  // Default: the stage — `(the activeWindow).name` = "stage" (the
  // Initialization boot guard checks exactly this).
  assert.equal(e.interp.evalExpressionString('(the activeWindow).name'), 'stage');
  // set the activeWindow to a real window; its name is its id.
  e.createWindow('mywin');
  e.setThe('activewindow', [], 'mywin');
  assert.equal(e.interp.evalExpressionString('(the activeWindow).name'), 'mywin');
  // Director: any window's name is its id.
  assert.equal(e.interp.evalExpressionString('(window "mywin").name'), 'mywin');
});

test('stopClient resolves as a builtin (no unresolved-handler warn)', () => {
  const e = new DirectorEngine();
  const before = e.logs.length;
  assert.equal(e.interp.evalExpressionString('stopClient()'), VOID);
  assert.ok(e.logs.slice(before).some((l) => l.includes('stopClient')), 'stopClient logs');
  assert.ok(!e.logs.slice(before).some((l) => l.includes('unresolved')), 'no unresolved-handler warn');
});

test('single-instance guard: an open window makes prepareMovie stop the movie', () => {
  const e = new DirectorEngine();
  e.createWindow('already_open');
  const src = `-- Cast member: Initialization
-- Type: Movie Script

global _player
global gWindowCount

on prepareMovie
  gWindowCount = _player.windowList.count
  if _player.windowList.count > 0 then
    return stopMovie()
  end if
  return 1
end
on stopMovie
  stopClient()
  go(1)
end
`;
  e.addScriptMember('Initialization', 'movie', src);
  e.boot();
  assert.equal(e.globalGet('gWindowCount'), 1);
  const bad = e.logs.filter((l) => l.includes('unresolved') || l.includes('unsupported'));
  assert.deepEqual(bad, [], 'stopMovie path must not warn');
});
