/**
 * Dev-mode performance counters for the stage + overlay (`stage/devOverlay.ts`).
 *
 * Everything here is off unless `enablePerf()` has been called, and the guarded
 * call sites are written so the disabled path costs one boolean check: no
 * `performance.now()` pairs, no object allocation, no string building. The
 * counters are MONOTONIC totals plus a "last frame" value, so any reader can
 * diff two samples and never has to reset state it does not own.
 */
export interface PerfMilestone {
  label: string;
  ms: number;
  at: number;
  /** `boot` phases are a one-off timeline; `slow` keeps only notable frames. */
  kind: 'boot' | 'slow';
}

export const perf = {
  enabled: false,
  /** Frames the stage ticker has run (any frame, ticked or not). */
  frames: 0,
  /** Frames where the engine tick actually ran. */
  ticks: 0,
  /** Last frame's `engine.tick()` duration in ms. */
  tickMs: 0,
  /** Worst `engine.tick()` since boot, and when it happened — a one-off 1-2s
   *  room-load hitch is invisible in `tickTotalMs`/averages, so keep the peak. */
  tickMaxMs: 0,
  tickMaxAt: 0,
  /** Sum of every sampled `engine.tick()`. */
  tickTotalMs: 0,
  /** Last frame's `syncChannelImages()` (decode + ink bake + upload) in ms. */
  syncMs: 0,
  syncMaxMs: 0,
  syncMaxAt: 0,
  /** Sum of every sampled `syncChannelImages()`. */
  syncTotalMs: 0,
  /** Image members decoded/rebaked for a channel (bakeSurface / blob path). */
  bakes: 0,
  bakeTotalMs: 0,
  milestones: [] as PerfMilestone[],
  /** The slowest OUTERMOST Lingo handler calls, biggest first (see perfSlowCall). */
  slowCalls: [] as { label: string; ms: number; at: number }[],
};

/** A frame slice slow enough to be the hitch someone is reporting. */
export const SLOW_FRAME_MS = 100;

export interface SlowCall {
  label: string;
  ms: number;
  at: number;
}

/**
 * Record an outermost Lingo handler call (`#handler@script`) if it is slow.
 *
 * This is what turns "entering a room hangs for a second" into a name: the tick
 * peak says the time is engine-side, this says which handler spent it. Only the
 * OUTERMOST calls are timed (see the call site) — nested ones are attributed to
 * their parent on purpose, since timing every call would double-count and add a
 * clock read per call to a very hot path.
 */
export function perfSlowCall(label: string, ms: number, threshold = 50): void {
  if (!perf.enabled || ms < threshold) return;
  const at = typeof performance !== 'undefined' ? performance.now() : 0;
  perf.slowCalls.push({ label, ms, at });
  perf.slowCalls.sort((a, b) => b.ms - a.ms);
  if (perf.slowCalls.length > 12) perf.slowCalls.length = 12;
}

export function perfEnabled(): boolean {
  return perf.enabled;
}

export function enablePerf(): void {
  perf.enabled = true;
}

/** Record a named phase ("movie fetched", "room load", …) in the overlay. */
export function perfMilestone(label: string, ms: number, kind: PerfMilestone['kind'] = 'boot'): void {
  if (!perf.enabled) return;
  const at = typeof performance !== 'undefined' ? performance.now() : 0;
  // Boot phases are never dropped (they are the baseline); slow frames are a
  // rolling window, since a long session would otherwise forget the hitch.
  if (kind === 'slow') {
    perf.milestones = perf.milestones.filter((m) => m.kind !== 'slow' || m.at > at - 60000);
  }
  perf.milestones.push({ label, ms, at, kind });
  if (perf.milestones.length > 60) perf.milestones.shift();
}

/** Time one image bake, adding it to `perf.bakes`/`perf.bakeTotalMs` when on. */
export function perfTimeBake<T>(fn: () => T): T {
  if (!perf.enabled) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    perf.bakes++;
    perf.bakeTotalMs += performance.now() - t0;
  }
}

/**
 * Record a frame slice (engine tick or render sync) and flag the slow ones. A
 * single 1-2s stall lands in `milestones` as `slow tick 1842ms`, which is the
 * thing an average can never show.
 */
export function perfFrame(kind: 'tick' | 'sync', ms: number): void {
  if (!perf.enabled) return;
  const at = performance.now();
  if (kind === 'tick') {
    perf.tickMs = ms;
    perf.tickTotalMs += ms;
    perf.ticks++;
    if (ms > perf.tickMaxMs) {
      perf.tickMaxMs = ms;
      perf.tickMaxAt = at;
    }
  } else {
    perf.syncMs = ms;
    perf.syncTotalMs += ms;
    if (ms > perf.syncMaxMs) {
      perf.syncMaxMs = ms;
      perf.syncMaxAt = at;
    }
  }
  if (ms >= SLOW_FRAME_MS) perfMilestone(`slow ${kind}`, ms, 'slow');
}
