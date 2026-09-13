import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enablePerf, perf, perfFrame, perfMilestone, perfSlowCall, perfTimeBake, SLOW_FRAME_MS } from '../perf.js';

/** The counters are module-global and never reset by design, so each test works
 *  off its own baseline deltas + the arrays it cares about. */
function clean(): void {
  perf.milestones = [];
  perf.slowCalls = [];
  enablePerf();
}

test('the disabled path runs the work but counts nothing', () => {
  perf.enabled = false;
  const before = perf.bakes;
  const value = perfTimeBake(() => 41);
  assert.equal(value, 41, 'the wrapped call still returns its value');
  assert.equal(perf.bakes, before, 'no counter moves while perf is off');
  perfFrame('tick', 5000);
  assert.equal(perf.tickMaxMs, 0, 'no frame sampling while perf is off');
  perfMilestone('room load', 1842);
  assert.equal(perf.milestones.length, 0, 'no milestones while perf is off');
  perfSlowCall('#a@Script A', 500);
  assert.equal(perf.slowCalls.length, 0, 'no slow-call list while perf is off');
});

test('perfTimeBake counts the bake and its ms', () => {
  clean();
  const count = perf.bakes;
  const ms = perf.bakeTotalMs;
  perfTimeBake(() => {});
  assert.equal(perf.bakes, count + 1);
  assert.ok(perf.bakeTotalMs >= ms, 'total ms is monotonic');
});

test('perfFrame keeps the tick/sync peaks and flags the slow ones', () => {
  clean();
  perfFrame('tick', 3);
  perfFrame('tick', SLOW_FRAME_MS + 1);
  perfFrame('sync', 7);
  assert.equal(perf.tickMs, SLOW_FRAME_MS + 1, 'last tick');
  assert.equal(perf.tickMaxMs, SLOW_FRAME_MS + 1, 'peak tick is the slow one');
  assert.ok(perf.tickMaxAt > 0, 'the peak carries a timestamp');
  assert.equal(perf.syncMaxMs, 7, 'sync peak tracked separately');
  assert.equal(perf.tickMaxMs === perf.syncMaxMs, false, 'peaks do not cross over');
  const slow = perf.milestones.filter((m) => m.kind === 'slow');
  assert.equal(slow.length, 1, 'only the over-threshold frame is flagged');
  assert.equal(slow[0].label, 'slow tick');
  // a faster frame must not lower the peak
  perfFrame('tick', 1);
  assert.equal(perf.tickMaxMs, SLOW_FRAME_MS + 1);
});

test('boot milestones survive the slow-frame window', () => {
  clean();
  perfMilestone('room load', 1842);
  perfFrame('tick', 400);
  perfFrame('tick', 180);
  const boot = perf.milestones.filter((m) => m.kind === 'boot');
  assert.deepEqual(boot.map((m) => m.label), ['room load'], 'boot phases are never trimmed');
  assert.equal(boot[0].ms, 1842);
});

test('perfSlowCall keeps the biggest outermost handlers, capped', () => {
  clean();
  perfSlowCall('fast', 10); // under the threshold: ignored
  assert.equal(perf.slowCalls.length, 0);
  perfSlowCall('#a@Script A', 60);
  perfSlowCall('#b@Script B', 900);
  perfSlowCall('#c@Script C', 120);
  assert.deepEqual(perf.slowCalls.map((c) => c.label), ['#b@Script B', '#c@Script C', '#a@Script A']);
  for (let i = 0; i < 20; i++) perfSlowCall(`#x${i}@S`, 100 + i);
  assert.equal(perf.slowCalls.length, 12, 'capped list');
  assert.equal(perf.slowCalls[0].label, '#b@Script B', 'the biggest call is still first');
});
