/**
 * Opt-in developer panel: what the renderer actually is, how fast the frame is,
 * what the runtime spends it on, and the JS heap.
 *
 * Enabled by any of:
 *   - `?dev=1` (or bare `?dev`) on the page URL — works on a real hotel page
 *     without editing it,
 *   - a `dev` attribute on `<spark-player>`,
 *   - `window.__sparkDev.show()` / `.toggle()` from the console.
 * F9 toggles once the element exists.
 *
 * The panel reads a snapshot callback (the stage supplies it) and its own rAF
 * loop, so it never makes the runtime do work it would not otherwise do. The
 * numbers it cannot get from a callback — frame pacing and long tasks — come from
 * rAF deltas and `PerformanceObserver('longtask')`, which is exactly what a
 * "room hangs for a second" report looks like from inside the page.
 */

export interface DevSnapshot {
  renderer: string;
  glVersion: number | null;
  gpu: string | null;
  backBuffer: boolean | null;
  inkBlendModes: string[];
  screenW: number;
  screenH: number;
  canvasCssW: number;
  canvasCssH: number;
  dpr: number;
  nodes: number;
  textures: number;
  /** Monotonic counters (see perf.ts). `*MaxMs`/`*MaxAt` are the peaks since boot. */
  frames: number;
  ticks: number;
  tickMs: number;
  tickMaxMs: number;
  tickMaxAt: number;
  tickTotalMs: number;
  syncMs: number;
  syncMaxMs: number;
  syncMaxAt: number;
  syncTotalMs: number;
  bakes: number;
  bakeTotalMs: number;
  /** Slowest outermost Lingo handler calls — what owns a slow tick. */
  slowCalls: { label: string; ms: number; at: number }[];
  /** Engine-side facts. */
  castLibs: number;
  channels: number;
  frameTempo: number;
  heapUsed: number | null;
  heapTotal: number | null;
  heapLimit: number | null;
}

interface LongTask {
  ms: number;
  at: number;
}

const MB = 1024 * 1024;

export class DevOverlay {
  private root: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private raf = 0;
  private frames = 0;
  private windowStart = 0;
  private fps = 0;
  private worstGap = 0;
  private lastFrame = 0;
  private prev: DevSnapshot | null = null;
  private prevAt = 0;
  private longTasks: LongTask[] = [];
  private observer: PerformanceObserver | null = null;
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private getSnapshot: () => DevSnapshot,
    private getMilestones: () => { label: string; ms: number; at: number; kind: 'boot' | 'slow' }[],
  ) {}

  get visible(): boolean {
    return !!this.root;
  }

  show(): void {
    if (this.root) return;
    const root = document.createElement('div');
    root.setAttribute('part', 'dev');
    root.style.cssText = [
      'position:fixed', 'top:8px', 'right:8px', 'z-index:2147483647',
      'min-width:330px', 'max-width:520px', 'padding:6px 8px',
      'background:rgba(8,10,14,0.86)', 'color:#cfe3ff',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre', 'border:1px solid #2b3b52', 'border-radius:6px',
      'pointer-events:none', 'user-select:text',
    ].join(';');
    const body = document.createElement('div');
    root.appendChild(body);
    const close = document.createElement('span');
    close.textContent = 'dev (F9) ✕';
    close.style.cssText = 'display:block;color:#6f8bb3;cursor:pointer;pointer-events:auto;margin-bottom:2px';
    close.addEventListener('click', () => this.hide());
    root.insertBefore(close, body);
    document.body.appendChild(root);
    this.root = root;
    this.body = body;
    this.start();
  }

  hide(): void {
    this.stop();
    this.root?.remove();
    this.root = null;
    this.body = null;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  /** Wire the F9 shortcut. Returns a cleanup fn. */
  install(): () => void {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F9') {
        e.preventDefault();
        this.toggle();
      }
    };
    this.onKey = onKey;
    document.addEventListener('keydown', onKey);
    return () => {
      if (this.onKey) document.removeEventListener('keydown', this.onKey);
      this.onKey = null;
      this.hide();
    };
  }

  private start(): void {
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            add(this.longTasks, { ms: e.duration, at: e.startTime });
          }
        });
        this.observer.observe({ entryTypes: ['longtask'] });
      } catch {
        this.observer = null;
      }
    }
    this.windowStart = performance.now();
    this.lastFrame = this.windowStart;
    const loop = (): void => {
      const now = performance.now();
      this.frames++;
      const gap = now - this.lastFrame;
      this.lastFrame = now;
      if (gap > this.worstGap) this.worstGap = gap;
      if (now - this.windowStart >= 1000) {
        this.fps = (this.frames * 1000) / (now - this.windowStart);
        this.frames = 0;
        this.windowStart = now;
        this.render(now);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.observer?.disconnect();
    this.observer = null;
  }

  private render(now: number): void {
    if (!this.body) return;
    let s: DevSnapshot;
    try {
      s = this.getSnapshot();
    } catch (e) {
      this.body.textContent = 'dev snapshot failed: ' + (e instanceof Error ? e.message : String(e));
      return;
    }
    const dt = this.prev && this.prevAt ? (now - this.prevAt) / 1000 : 0;
    const rate = (v: number, p: number): string => (dt > 0 ? ((v - p) / dt).toFixed(1) : '0.0');
    const lines: string[] = [];

    lines.push(`renderer  ${s.renderer}${s.glVersion ? ' (gl' + s.glVersion + ')' : ''}  ${s.gpu ?? 'gpu ?'}`);
    lines.push(`blend     backBuffer ${fmtBool(s.backBuffer)}  custom: ${s.inkBlendModes.join(' ') || 'none'}`);
    lines.push(`stage     ${s.screenW}x${s.screenH}  canvas ${round(s.canvasCssW)}x${round(s.canvasCssH)} (${(s.canvasCssW / Math.max(1, s.screenW)).toFixed(2)}x)  dpr ${s.dpr}`);
    lines.push(`fps       ${this.fps.toFixed(1)}  worst frame gap ${this.worstGap.toFixed(0)}ms  tempo ${s.frameTempo}`);
    lines.push(`frame     tick ${s.tickMs.toFixed(1)}ms  sync ${s.syncMs.toFixed(1)}ms (last)`);
    lines.push(`peak      tick ${s.tickMaxMs.toFixed(0)}ms ${secs(s.tickMaxAt)}  sync ${s.syncMaxMs.toFixed(0)}ms ${secs(s.syncMaxAt)}`);
    lines.push(`work      bakes ${s.bakes} (+${rate(s.bakes, this.prev?.bakes ?? s.bakes)}/s, ${rate(s.bakeTotalMs, this.prev?.bakeTotalMs ?? s.bakeTotalMs)}ms/s)`);
    lines.push(`calls     ${kilo(s.ticks)} ticks  ${kilo(s.frames)} frames  avg tick ${avg(s.tickTotalMs, s.ticks)}  avg sync ${avg(s.syncTotalMs, s.frames)}`);
    lines.push(`scene     nodes ${s.nodes}  textures ${s.textures}  channels ${s.channels}  casts ${s.castLibs}`);
    lines.push(`heap      ${s.heapUsed === null ? 'n/a (Chrome only)' : mb(s.heapUsed) + ' / ' + mb(s.heapTotal ?? 0) + ' of ' + mb(s.heapLimit ?? 0) + '  ' + hrate(s.heapUsed, this.prev?.heapUsed ?? null, dt)}`);
    // Boot phases are a fixed timeline (never trimmed), slow frames a rolling
    // window — show the phases first, then the worst recent frames.
    const all = this.getMilestones();
    const boot = all.filter((m) => m.kind === 'boot');
    if (boot.length) {
      lines.push('── boot ' + '─'.repeat(25));
      for (const m of boot.slice(-8)) lines.push(`  ${m.label} ${m.ms.toFixed(0)}ms @ ${(m.at / 1000).toFixed(1)}s`);
    }
    const slow = all.filter((m) => m.kind === 'slow');
    if (slow.length) {
      lines.push('── slow frames ' + '─'.repeat(16));
      for (const m of slow.slice(-4)) lines.push(`  ${m.label} ${m.ms.toFixed(0)}ms @ ${(m.at / 1000).toFixed(1)}s`);
    }
    if (s.slowCalls.length) {
      lines.push('── slow lingo (outermost) ' + '─'.repeat(5));
      for (const c of s.slowCalls.slice(0, 6)) lines.push(`  ${c.ms.toFixed(0)}ms  ${c.label}`);
    }
    if (this.longTasks.length) {
      lines.push('── long tasks ' + '─'.repeat(18));
      for (const t of this.longTasks.slice(-4)) lines.push(`  ${t.ms.toFixed(0)}ms @ ${(t.at / 1000).toFixed(1)}s`);
    }
    this.body.textContent = lines.join('\n');
    this.prev = s;
    this.prevAt = now;
  }
}

function add(list: LongTask[], t: LongTask): void {
  list.push(t);
  if (list.length > 20) list.shift();
}

function kilo(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function secs(at: number): string {
  return at > 0 ? '@' + (at / 1000).toFixed(1) + 's' : '-';
}

/** Heap growth rate: `rate()` is bytes/s, so scale it before labelling MB. */
function hrate(used: number, prev: number | null, dt: number): string {
  if (prev === null || dt <= 0) return 'heap d/s -';
  return ((used - prev) / dt / MB).toFixed(2) + 'MB/s';
}

function avg(total: number, n: number): string {
  return n > 0 ? (total / n).toFixed(2) + 'ms' : '-';
}

function mb(bytes: number): string {
  return (bytes / MB).toFixed(1) + 'MB';
}

function round(n: number): number {
  return Math.round(n);
}

function fmtBool(v: boolean | null): string {
  return v === null ? '?' : v ? 'on' : 'off';
}
