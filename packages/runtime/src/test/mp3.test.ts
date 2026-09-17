import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mp3DurationMs } from '../engine/mp3.js';

function frame(header = [0xff, 0xfb, 0x50, 0], length = 208): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(header);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

test('MP3 initial sync skips false headers in prefixes without skipping audio frames', () => {
  const audio = join(frame(), frame([0xff, 0xfb, 0x52, 0], 209), frame());
  for (const length of [37, 198, 601]) {
    const prefix = new Uint8Array(length);
    prefix.set([0xff, 0xff, 0xbb, 0x40]);
    assert.equal(mp3DurationMs(join(prefix, audio)), 78, `prefix length ${length}`);
  }
});

test('MP3 initial sync requires matching version, layer and sample rate at the next boundary', () => {
  for (const candidate of [
    frame([0xff, 0xff, 0x50, 0], 172),
    frame([0xff, 0xfb, 0x54, 0], 192),
    frame([0xff, 0xf3, 0x80, 0], 208),
  ]) {
    assert.equal(mp3DurationMs(join(candidate, frame(), frame())), 52);
  }
});

test('MP3 initial sync allows bitrate, padding and channel mode changes', () => {
  const audio = join(frame(), frame([0xff, 0xfa, 0x92, 0xc0], 418), frame());
  assert.equal(mp3DurationMs(audio), 78);
});

test('MP3 duration preserves single frames and partial trailing frames', () => {
  assert.equal(mp3DurationMs(frame()), 26);
  for (const length of [4, 17, 207]) {
    assert.equal(mp3DurationMs(frame().subarray(0, length)), 26);
    assert.equal(mp3DurationMs(join(frame(), frame().subarray(0, length))), 52);
    assert.equal(mp3DurationMs(join(frame(), frame(), frame().subarray(0, length))), 78);
  }
  for (const length of [1, 2, 3]) {
    assert.equal(mp3DurationMs(join(frame(), frame().subarray(0, length))), 26);
  }
});

test('MP3 initial sync still skips ID3v2 and rejects invalid headers', () => {
  const tag = new Uint8Array(30);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20]);
  tag.set([0xff, 0xff, 0xbb, 0x40], 10);
  assert.equal(mp3DurationMs(join(tag, frame(), frame())), 52);
  for (const header of [[0xff, 0xeb, 0x50, 0], [0xff, 0xf9, 0x50, 0], [0xff, 0xfb, 0x5c, 0], [0xff, 0xfb, 0, 0], [0xff, 0xfb, 0xf0, 0]]) {
    assert.equal(mp3DurationMs(frame(header)), 0);
  }
  assert.equal(mp3DurationMs(new Uint8Array(3)), 0);
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
for (const [id, path, expected] of [
  [0, 'hh_soundmachine/sounds/0103_sound_sound_machine_sample_0.mp3', 2142],
  [461, 'hof_furni/sounds/sound_machine_sample_461/sounds/0001_sound_sound_machine_sample_461.mp3', 4153],
  [214, 'hof_furni/sounds/sound_machine_sample_214/sounds/0001_sound_sound_machine_sample_214.mp3', 4153],
] as const) {
  test(`MP3 sample ${id} duration matches audio frame samples`, () => {
    const bytes = readFileSync(resolve(ROOT, 'exported/31', path));
    assert.equal(mp3DurationMs(bytes), expected);
  });
}
