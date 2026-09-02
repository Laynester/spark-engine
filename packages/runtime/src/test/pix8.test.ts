import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from '../engine/png.js';
import { decodeImage, decodePix8, isPix8 } from '../engine/pix8.js';

function buildIndexedPng(width: number, height: number, indices: number[], palette: number[][]): Uint8Array {
  const stride = width;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;
    for (let x = 0; x < width; x++) raw[y * (1 + stride) + 1 + x] = indices[y * width + x];
  }
  const len = raw.length;
  if (len > 65535) throw new Error('test png too big for a stored block');
  const idat = new Uint8Array(2 + 5 + len + 4);
  idat[0] = 0x78;
  idat[1] = 0x01;
  idat[2] = 0x01;
  idat[3] = len & 0xff;
  idat[4] = (len >> 8) & 0xff;
  idat[5] = (~len) & 0xff;
  idat[6] = ((~len) >> 8) & 0xff;
  idat.set(raw, 7);
  const mod = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % mod;
    b = (b + a) % mod;
  }
  const adler = ((b << 16) | a) >>> 0;
  idat.set([(adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff], 7 + len);
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
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

function pix8Of(width: number, height: number, indices: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + indices.length);
  out[0] = 0x50; out[1] = 0x49; out[2] = 0x58; out[3] = 0x38;
  out[4] = width & 0xff;
  out[5] = (width >> 8) & 0xff;
  out[6] = height & 0xff;
  out[7] = (height >> 8) & 0xff;
  out[8] = 0;
  out[9] = 0;
  out.set(indices, 10);
  return out;
}

test('decodePix8 expands raw indices via the palette identically to decodePng', () => {
  const w = 3;
  const h = 2;
  const palette: number[][] = [[255, 255, 255], [0, 0, 0], [200, 100, 50]];
  const indices = new Uint8Array([0, 0, 1, 2, 1, 0]);
  const png = buildIndexedPng(w, h, [...indices], palette);
  const ref = decodePng(png);
  assert.ok(ref.indices, 'reference png is indexed');
  const pix8 = pix8Of(w, h, indices);
  assert.ok(isPix8(pix8), 'magic detected');
  assert.ok(!isPix8(png), 'png is not pix8');
  const got = decodePix8(pix8, palette);
  assert.equal(got.width, w);
  assert.equal(got.height, h);
  assert.deepEqual([...got.rgba], [...ref.rgba], 'identical rgba');
  assert.deepEqual([...got.indices], [...indices], 'indices carried through');
});

test('decodeImage routes PIX8 vs PNG by magic; palette is required for PIX8', () => {
  const palette: number[][] = [[10, 20, 30], [40, 50, 60]];
  const pix8 = pix8Of(1, 2, new Uint8Array([0, 1]));
  const routed = decodeImage(pix8, palette);
  assert.equal(routed.width, 1);
  assert.equal(routed.height, 2);
  assert.deepEqual([...routed.rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
  assert.throws(() => decodeImage(pix8, undefined), /palette missing/);
  const png = buildIndexedPng(1, 2, [0, 1], palette);
  const p = decodeImage(png);
  assert.equal(p.width, 1);
  assert.deepEqual([...p.rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
});