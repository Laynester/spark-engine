import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { WebAudioPlayer } from '../engine/audio.js';

class FakeSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  starts: number[][] = [];
  stopped = false;
  connect() {}
  start(...args: number[]) { this.starts.push(args); }
  stop() { this.stopped = true; this.onended?.(); }
}

class FakeAudioContext {
  state = 'running';
  currentTime = 12;
  destination = {};
  sources: FakeSource[] = [];
  decodes: { success: (buffer: AudioBuffer) => void; failure: () => void }[] = [];
  createGain() { return { connect() {}, gain: { setValueAtTime() {} } }; }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  decodeAudioData(_raw: ArrayBuffer, success: (buffer: AudioBuffer) => void, failure: () => void) {
    this.decodes.push({ success, failure });
    return Promise.resolve({} as AudioBuffer);
  }
}

function audioFixture(t: TestContext) {
  const ctx = new FakeAudioContext();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class { constructor() { return ctx; } } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'AudioContext', original);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  });
  const player = new WebAudioPlayer();
  const raw = new Uint8Array([1, 2, 3]);
  const buffer = { duration: 2.142 } as AudioBuffer;
  return { ctx, player, raw, buffer };
}

test('WebAudioPlayer offsets: decoded and cached starts convert milliseconds to offset and duration seconds', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  const opts = { startTime: 500, endTime: 1500, volume: 128 };
  player.play(1, 'sample', raw, opts);
  ctx.decodes[0].success(buffer);
  assert.deepEqual(ctx.sources[0].starts, [[0, 0.5, 1]]);
  const cachedOpts = { ...opts, startTime: 750, endTime: 2000 };
  player.play(1, 'sample', raw, cachedOpts);
  assert.equal(ctx.decodes.length, 1);
  assert.deepEqual(ctx.sources[1].starts, [[0, 0.75, 1.25]]);
  assert.equal(ctx.sources[0].stopped, true);
});

test('WebAudioPlayer offsets: infinite loops use the selected loop region without a finite duration', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  const opts = { loop: true, startTime: 500, endTime: 1500 };
  player.play(1, 'sample', raw, opts);
  ctx.decodes[0].success(buffer);
  assert.equal(ctx.sources[0].loop, true);
  assert.equal(ctx.sources[0].loopStart, 0.5);
  assert.equal(ctx.sources[0].loopEnd, 1.5);
  assert.deepEqual(ctx.sources[0].starts, [[0, 0.5]]);
});

test('WebAudioPlayer offsets: bounds clamp to decoded duration, including empty ranges', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  const ranges = [[-100, 4000], [700, 200], [3000, 4000], [0, 0]];
  for (const [startTime, endTime] of ranges) {
    player.play(1, 'sample', raw, { volume: 255, ...{ startTime, endTime } });
    if (ctx.decodes.length && !ctx.sources.length) ctx.decodes[0].success(buffer);
  }
  assert.deepEqual(ctx.sources.map((src) => src.starts[0]), [[0, 0, 2.142], [0, 0.7, 0], [0, 2.142, 0], [0, 0, 0]]);
});

test('WebAudioPlayer offsets: empty loop regions end without looping the whole buffer', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  let ended = 0;
  player.play(1, 'sample', raw, { loop: true, startTime: 0, endTime: 0, onEnded: () => ended++ });
  ctx.decodes[0].success(buffer);
  assert.equal(ctx.sources[0].loop, false);
  assert.deepEqual(ctx.sources[0].starts, [[0, 0, 0]]);
  ctx.sources[0].onended!();
  assert.equal(ended, 1);
});

test('WebAudioPlayer offsets: omitted options and empty options retain full-buffer playback', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  player.play(1, 'sample', raw);
  ctx.decodes[0].success(buffer);
  player.play(2, 'sample', raw, {});
  assert.deepEqual(ctx.sources.map((src) => src.starts[0]), [[0, 0, 2.142], [0, 0, 2.142]]);
});

test('WebAudioPlayer cancellation: replaying the same payload cannot revive a stopped decode', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  let ended = 0;
  player.play(1, 'sample', raw, { onEnded: () => ended++ });
  player.stop(1);
  player.play(1, 'sample', raw, { onEnded: () => ended += 10 });
  ctx.decodes[0].success(buffer);
  assert.equal(ctx.sources.length, 0);
  assert.equal(ended, 0);
  ctx.decodes[1].success(buffer);
  assert.equal(ctx.sources.length, 1);
  ctx.sources[0].onended!();
  assert.equal(ended, 10);
});

for (const name of ['sample', 'other']) {
  test(`WebAudioPlayer cancellation: stale decode failure cannot cancel replacement ${name}`, (t) => {
    const { ctx, player, raw, buffer } = audioFixture(t);
    player.play(1, 'sample', raw, {});
    player.play(1, name, raw, {});
    ctx.decodes[0].failure();
    ctx.decodes[1].success(buffer);
    assert.equal(ctx.sources.length, 1);
    assert.equal(player.isBusy(1), true);
  });
}

test('WebAudioPlayer cancellation: stop suppresses even a previously captured ended callback', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  let ended = 0;
  player.play(1, 'sample', raw, { onEnded: () => ended++ });
  ctx.decodes[0].success(buffer);
  const callback = ctx.sources[0].onended!;
  player.stop(1);
  callback();
  assert.equal(ended, 0);
  assert.equal(player.isBusy(1), false);
  player.play(1, 'sample', raw, { onEnded: () => ended += 10 });
  callback();
  assert.equal(ended, 0);
  assert.equal(player.isBusy(1), true);
  const naturalEnd = ctx.sources[1].onended!;
  naturalEnd();
  naturalEnd();
  assert.equal(ended, 10);
  assert.equal(player.isBusy(1), false);
});

test('WebAudioPlayer cancellation: channel stop leaves other pending channels alone', (t) => {
  const { ctx, player, raw, buffer } = audioFixture(t);
  player.play(1, 'sample', raw, {});
  player.play(2, 'sample', raw, {});
  player.stop(1);
  ctx.decodes[0].success(buffer);
  ctx.decodes[1].success(buffer);
  assert.equal(ctx.sources.length, 1);
  assert.equal(player.isBusy(1), false);
  assert.equal(player.isBusy(2), true);
});
