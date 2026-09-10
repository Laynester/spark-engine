import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { DirectorEngine, type StageAdapter, type ChannelVisual } from '../engine/engine.js';
import { BundleLoader } from '../bundle/loader.js';

// Regression: room water is a film loop. The original Shockwave client built
// the "waterloop" member natively at room load; the bundler now emits it as a
// real `filmloop` cast member (kind filmloop + `frames` member numbers) from
// the room data. The engine must resolve the frames, render the CURRENT frame
// through the ordinary bitmap path (live-copied raw/palette/regpoint), and
// advance the loop each tick.

const frameA = new Uint8Array([1, 2, 3, 4]);
const frameB = new Uint8Array([5, 6, 7, 8]);
const bytes = (u: Uint8Array | undefined): number[] => (u ? Array.from(u) : []);

function makeCastZip(): Uint8Array {
  const members = [
    { number: 7, kind: 'bitmap' as const, name: 'gold_water2a', file: 'hh_room_gold/0007_bitmap_gold_water2a.png' },
    { number: 8, kind: 'bitmap' as const, name: 'gold_water2b', file: 'hh_room_gold/0008_bitmap_gold_water2b.png' },
    // bundler output for `[#member: "waterloop", #media: #filmLoop]`:
    { number: 49, kind: 'filmloop' as const, name: 'waterloop', file: '', frames: [7, 8] },
  ];
  const manifest = {
    version: 1 as const,
    casts: [{
      name: 'hh_room_gold',
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts: [] as { name: string; file: string }[],
    }],
    files: [
      'hh_room_gold/0007_bitmap_gold_water2a.png',
      'hh_room_gold/0008_bitmap_gold_water2b.png',
    ],
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  entries['hh_room_gold/0007_bitmap_gold_water2a.png'] = frameA;
  entries['hh_room_gold/0008_bitmap_gold_water2b.png'] = frameB;
  return zipSync(entries, { level: 6 });
}

interface CaptureAdapter extends StageAdapter {
  visual: { kind: string; bytes?: Uint8Array } | null;
}

function loadEngine(): { e: DirectorEngine; loader: BundleLoader; adapter: CaptureAdapter } {
  const loader = new BundleLoader();
  loader.register(makeCastZip());
  const mockAdapter: CaptureAdapter = {
    visual: null,
    setBackground: () => {},
    resize: () => {},
    setChannel: (_n: number, v: ChannelVisual | null) => {
      mockAdapter.visual = v && v.kind === 'bitmap' ? { kind: 'bitmap', bytes: v.bytes } : null;
    },
    refreshChannel: () => {},
  };
  return { e: new DirectorEngine(mockAdapter), loader, adapter: mockAdapter };
}

test('film loop members resolve frames, render the current frame, and advance per tick', async () => {
  const { e, loader, adapter } = loadEngine();
  const cast = await e.loadCast(loader, 'hh_room_gold');
  assert.ok(cast, 'cast loads');
  e.boot();
  assert.equal(cast.members.size, 3, 'two frames + the loop member');

  // The visualizer's lookup path: getmemnum() must resolve "waterloop".
  const num = e.getmemnum('waterloop');
  assert.ok(num > 0, 'waterloop member resolves');
  const loop = e.memberFor({
    castLibNumber: (num >> 16) & 0xffff,
    number: num & 0xffff,
    kind: 'filmloop',
    name: 'waterloop',
    castLibNumber2: 0,
  } as never);
  assert.ok(loop, 'memberFor resolves the loop');
  assert.equal(loop.kind, 'filmloop', 'member kind is filmloop');
  assert.ok(loop.film && loop.film.length === 2, 'both frames bound');
  assert.equal(loop.film[0], cast.members.get(7), 'frame 1 is member 7');
  assert.equal(loop.film[1], cast.members.get(8), 'frame 2 is member 8');
  assert.deepEqual(bytes(loop.raw), bytes(frameA), 'starts on frame A');
  assert.equal(loop.filmIndex, 0);

  // Sprite on the loop: the channel visual must carry the CURRENT frame.
  const spr = e.getSprite(5);
  e.setSpriteProp(spr, 'member', ((loop.castLibNumber << 16) | loop.number) as never);
  e.flushChannelVisuals();
  assert.ok(adapter.visual && adapter.visual.kind === 'bitmap', 'channel visual is a bitmap');
  assert.deepEqual(bytes(adapter.visual.bytes), bytes(frameA), 'visual carries frame A bytes');

  // Advance: the next tick shows frame B, then wraps to A.
  e.tick();
  await new Promise((r) => setTimeout(r, 0)); // let the microtask flush run
  e.flushChannelVisuals();
  assert.equal(loop.filmIndex, 1, 'tick advanced the loop');
  assert.deepEqual(bytes(loop.raw), bytes(frameB), 'raw tracks frame B');
  assert.deepEqual(bytes(adapter.visual?.bytes), bytes(frameB), 'visual carries frame B bytes');

  e.tick();
  assert.equal(loop.filmIndex, 0, 'wraps modulo frame count');
  assert.deepEqual(bytes(loop.raw), bytes(frameA), 'raw wrapped to frame A');
});

test('film loop member type reports #filmloop', async () => {
  const { e, loader } = loadEngine();
  await e.loadCast(loader, 'hh_room_gold');
  const num = e.getmemnum('waterloop');
  const type = e.interp.evalExpressionString(`member(${num}).type`) as { name: string };
  assert.equal(type.name, 'filmloop');
});

// ---------------------------------------------------------------------------
// Sprite-composed film loops (SCVW mini-score): each frame draws its cast
// members at mini-stage positions with per-tile ink. The engine must compose
// the frame (matte-baked, scaled, blitted) into a loop-sized RGBA image and
// swap it each tick. Regression: hh_room_gold's waterloop — 8 matte tiles of
// gold_water2a..l scrolling across the pool. DirPlayer renders the SCVW
// composition; the old engine showed a single stretched strip (black or white
// lines).
// ---------------------------------------------------------------------------

/** Minimal stored-block RGBA PNG (same builder as engine.test.ts). */
function buildPng(width: number, height: number, rgba: number[]): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    for (let x = 0; x < stride; x++) raw[y * (1 + stride) + 1 + x] = rgba[y * stride + x];
  }
  const len = raw.length;
  const idat = new Uint8Array(2 + 5 + len + 4);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat[2] = 0x01;
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
    let c = 0;
    for (let i = 0; i < data.length; i++) c = (c + data[i]) % 65521;
    out[8 + data.length] = (c >>> 8) & 0xff;
    out[9 + data.length] = c & 0xff;
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
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

/** 10×4 frame: white matte background with a teal block at [x0..x0+5]. */
function waterFrame(tealStart: number): Uint8Array {
  const rgba: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 10; x++) {
      if (x >= tealStart && x < tealStart + 6) rgba.push(0, 128, 128, 255);
      else rgba.push(255, 255, 255, 255);
    }
  }
  return buildPng(10, 4, rgba);
}

interface ImageCaptureAdapter extends StageAdapter {
  visual: { kind: string; image?: unknown } | null;
}

function makeComposedZip(): Uint8Array {
  const members = [
    { number: 7, kind: 'bitmap' as const, name: 'gold_water2a', file: 'hh_room_gold/0007_bitmap_gold_water2a.png' },
    { number: 8, kind: 'bitmap' as const, name: 'gold_water2b', file: 'hh_room_gold/0008_bitmap_gold_water2b.png' },
    // The decompiler's export: frame 0 = two copies of member 7, frame 1 =
    // one copy of member 8 (mini-stage positions, display size, ink 8 matte).
    {
      number: 49,
      kind: 'filmloop' as const,
      name: 'waterloop',
      file: '',
      frames: [7, 8],
      // Authored loop rect (CASt initialRect): equals the sprites' natural
      // bounding box (25×4 at (5,2)), so tiles render at NATURAL bitmap size.
      loopX: 5,
      loopY: 2,
      loopW: 25,
      loopH: 4,
      sprites: [
        [
          { member: 7, x: 5, y: 2, w: 10, h: 4, ink: 8, blend: 0 },
          { member: 7, x: 20, y: 2, w: 10, h: 4, ink: 8, blend: 0 },
        ],
        [{ member: 8, x: 6, y: 2, w: 10, h: 4, ink: 8, blend: 0 }],
      ],
    },
  ];
  const manifest = {
    version: 1 as const,
    casts: [{
      name: 'hh_room_gold',
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts: [] as { name: string; file: string }[],
    }],
    files: [
      'hh_room_gold/0007_bitmap_gold_water2a.png',
      'hh_room_gold/0008_bitmap_gold_water2b.png',
    ],
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  entries['hh_room_gold/0007_bitmap_gold_water2a.png'] = waterFrame(2);
  entries['hh_room_gold/0008_bitmap_gold_water2b.png'] = waterFrame(4);
  return zipSync(entries, { level: 6 });
}

function loadComposedEngine(): { e: DirectorEngine; loader: BundleLoader; adapter: ImageCaptureAdapter } {
  const loader = new BundleLoader();
  loader.register(makeComposedZip());
  const mockAdapter: ImageCaptureAdapter = {
    visual: null,
    setBackground: () => {},
    resize: () => {},
    setChannel: (_n: number, v: ChannelVisual | null) => {
      mockAdapter.visual = v && v.kind === 'image' ? { kind: 'image', image: v.image } : v && v.kind === 'bitmap' ? { kind: 'bitmap' } : null;
    },
    refreshChannel: () => {},
  };
  return { e: new DirectorEngine(mockAdapter), loader, adapter: mockAdapter };
}

const px = (img: { ensure(): Uint8Array }, w: number, x: number, y: number): number[] => {
  const d = img.ensure();
  const o = (y * w + x) * 4;
  return [d[o], d[o + 1], d[o + 2], d[o + 3]];
};

test('sprite-composed film loops: matte tiles composed into a loop-sized frame, advanced per tick', async () => {
  const { e, loader, adapter } = loadComposedEngine();
  const cast = await e.loadCast(loader, 'hh_room_gold');
  assert.ok(cast, 'cast loads');
  e.boot();

  const num = e.getmemnum('waterloop');
  assert.ok(num > 0, 'waterloop member resolves');
  const loop = e.memberFor({
    castLibNumber: (num >> 16) & 0xffff,
    number: num & 0xffff,
    kind: 'filmloop',
    name: 'waterloop',
    castLibNumber2: 0,
  } as never);
  assert.ok(loop, 'memberFor resolves the loop');
  assert.ok(loop.filmSprites && loop.filmSprites.length === 2, 'both composed frames resolved');
  assert.equal(loop.filmSprites[0].length, 2, 'frame 0 has two tiles');
  assert.equal(loop.filmSprites[0][0].member, cast.members.get(7), 'tile member resolved');

  // Composition canvas = bounding box of the placements: minX 5, minY 2,
  // maxX 30, maxY 6 → 25×4.
  assert.equal(loop.filmW, 25, 'loop canvas width is the placement bounding box');
  assert.equal(loop.filmH, 4, 'loop canvas height is the placement bounding box');
  // Film loops use center registration (DirPlayer get_concrete_sprite_rect:
  // reg = display size / 2) — the composed image's center sits on the sprite
  // loc, not its top-left. Regression: hh_room_gold's water rendered shifted
  // right/down because the composed channel anchored at regX=regY=0.
  assert.equal(loop.regX, 12, 'composed loop centers on the canvas width');
  assert.equal(loop.regY, 2, 'composed loop centers on the canvas height');
  assert.ok(loop.filmImage, 'frame 0 composed at load');

  // Matte keys the edge-connected white; the teal block of each tile survives.
  // Tile 1 blits at (0,0), tile 2 at (15,0) inside the 25×4 canvas.
  assert.deepEqual(px(loop.filmImage, 25, 3, 1), [0, 128, 128, 255], 'tile 1 teal is opaque');
  assert.deepEqual(px(loop.filmImage, 25, 0, 0), [0, 0, 0, 0], 'matte background is transparent');
  assert.deepEqual(px(loop.filmImage, 25, 17, 1), [0, 128, 128, 255], 'tile 2 teal is opaque');
  assert.deepEqual(px(loop.filmImage, 25, 8, 1), [0, 0, 0, 0], 'gap between tiles stays transparent');

  // The channel visual carries the composed image, not a raw frame.
  const spr = e.getSprite(5);
  e.setSpriteProp(spr, 'member', ((loop.castLibNumber << 16) | loop.number) as never);
  e.flushChannelVisuals();
  assert.ok(adapter.visual && adapter.visual.kind === 'image', 'channel visual is the composed image');

  // Advance: frame 1 uses member 8 (teal block shifted right by one column).
  e.tick();
  await new Promise((r) => setTimeout(r, 0));
  e.flushChannelVisuals();
  assert.equal(loop.filmIndex, 1, 'tick advanced the composed loop');
  assert.ok(loop.filmImage, 'frame 1 composed');
  assert.deepEqual(px(loop.filmImage, 25, 3, 1), [0, 0, 0, 0], 'old tile position is now transparent');
  assert.deepEqual(px(loop.filmImage, 25, 7, 1), [0, 128, 128, 255], 'new frame teal at shifted position');

  // Wraps modulo the composed frame count.
  e.tick();
  assert.equal(loop.filmIndex, 0, 'wraps modulo composed frames');
  assert.deepEqual(px(loop.filmImage, 25, 3, 1), [0, 128, 128, 255], 'wrapped back to frame 0');
});

test('full-content loops render tiles at NATURAL bitmap size (not the sprite display size)', async () => {
  // The sprite record's display size (5×2) differs from the member bitmap
  // (10×4), but the authored loop rect equals the natural bounding box — the
  // waterloop shape: the score's 250×12 display size is ignored in favor of
  // the 250×22 members. DirPlayer prefer_bitmap_dims.
  const loader = new BundleLoader();
  const members = [
    { number: 7, kind: 'bitmap' as const, name: 'gold_water2a', file: 'hh_room_gold/0007_bitmap_gold_water2a.png' },
    {
      number: 49,
      kind: 'filmloop' as const,
      name: 'waterloop',
      file: '',
      frames: [7],
      loopX: 5,
      loopY: 2,
      loopW: 10,
      loopH: 4,
      sprites: [[{ member: 7, x: 5, y: 2, w: 5, h: 2, ink: 8, blend: 0 }]],
    },
  ];
  const manifest = {
    version: 1 as const,
    casts: [{
      name: 'hh_room_gold',
      members,
      fonts: [] as never[],
      fontFiles: [] as string[],
      linkedCasts: [] as { name: string; file: string }[],
    }],
    files: ['hh_room_gold/0007_bitmap_gold_water2a.png'],
  };
  const entries: Record<string, Uint8Array> = { 'bundle-manifest.json': strToU8(JSON.stringify(manifest)) };
  entries['hh_room_gold/0007_bitmap_gold_water2a.png'] = waterFrame(2);
  loader.register(zipSync(entries, { level: 6 }));
  const e = new DirectorEngine();
  const cast = await e.loadCast(loader, 'hh_room_gold');
  assert.ok(cast, 'cast loads');
  e.boot();
  const num = e.getmemnum('waterloop');
  const loop = e.memberFor({
    castLibNumber: (num >> 16) & 0xffff,
    number: num & 0xffff,
    kind: 'filmloop',
    name: 'waterloop',
    castLibNumber2: 0,
  } as never);
  assert.ok(loop && loop.filmImage, 'loop composed');
  assert.equal(loop.filmImage.width, 10, 'canvas is the authored rect width');
  assert.equal(loop.filmImage.height, 4, 'canvas is the authored rect height');
  // Natural 10×4 tile covers the full canvas; the sprite's 5×2 display rect
  // would only cover y 0..1, so a pixel in the lower rows distinguishes.
  assert.deepEqual(px(loop.filmImage, 10, 5, 3), [0, 128, 128, 255], 'tile rendered at natural size');
  assert.deepEqual(px(loop.filmImage, 10, 1, 1), [0, 0, 0, 0], 'matte white still keyed');
});