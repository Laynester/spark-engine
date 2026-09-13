import { BundleLoader, castHintDir, type BundleSource } from './bundle/loader.js';
import { fontBaseCandidates } from './bundle/fontPaths.js';
import { DirectorEngine } from './engine/engine.js';
import { WebAudioPlayer } from './engine/audio.js';
import { PixiStage } from './stage/pixi.js';
import { DevOverlay } from './stage/devOverlay.js';
import { enablePerf, perfMilestone } from './perf.js';
import { rasterizeTextMember } from './stage/text.js';
import { reclaimIfLegacyPage } from './legacy/reclaim.js';
import { PersistWorker } from './worker/persist.js';

const SparkBase = (typeof HTMLElement !== 'undefined' ? HTMLElement : class {}) as typeof HTMLElement;

export class SparkElement extends SparkBase {
  private engine: DirectorEngine | null = null;
  private loader: BundleLoader | null = null;
  private stage: PixiStage | null = null;
  private booted = false;
  private _keyCleanup: (() => void) | null = null;
  private _fontSeen = new Set<string>();
  private _persistWorker: PersistWorker | null = null;
  private _persistCleanup: (() => void) | null = null;
  private _scaleCleanup: (() => void) | null = null;
  private _devCleanup: (() => void) | null = null;
  private _dev: DevOverlay | null = null;

  get directorEngine(): DirectorEngine | null {
    return this.engine;
  }

  get directorStage(): PixiStage | null {
    return this.stage;
  }

  /** The dev panel, when it has been created (`?dev=1`, a `dev` attribute, or `window.__sparkDev`). */
  get devOverlay(): DevOverlay | null {
    return this._dev;
  }

  disconnectedCallback(): void {
    this._devCleanup?.();
    this._devCleanup = null;
    this._dev = null;
    this._keyCleanup?.();
    this._keyCleanup = null;
    this._scaleCleanup?.();
    this._scaleCleanup = null;
    this._persistCleanup?.();
    this._persistCleanup = null;
    this._persistWorker?.terminate();
    this._persistWorker = null;
  }

  connectedCallback(): void {
    if (this.booted || this._initPromise) return;
    this._initPromise = this.init();
  }

  private _initPromise: Promise<void> | null = null;

  private async init(): Promise<void> {
    const movie = this.getAttribute('movie');
    if (!movie) {
      this.showError('missing "movie" attribute — e.g. <spark movie="./habbo.spark">');
      return;
    }
    // Decide the dev panel here rather than after the boot, so the counters are
    // already running while the movie loads and the boot phases below land in the
    // milestone list (they are the baseline a "loading got slow" report needs).
    const devRequested =
      this.hasAttribute('dev') || (typeof location !== 'undefined' && /(^|[?&])dev(=|&|$)/.test(location.search));
    if (devRequested) enablePerf();
    const bootStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const phase = (label: string): void => perfMilestone(label, performance.now() - bootStart);
    try {
      const baseUrl = new URL(movie, window.location.href);

      const movieBytes = await fetchBytes(baseUrl);
      phase('movie bundle fetched');
      const loader = new BundleLoader(makeSource(baseUrl));
      this.loader = loader;
      const cast = loader.register(movieBytes);
      if (!cast) {
        this.showError(`"${movie}" is not a valid bundle (no bundle-manifest.json)`);
        return;
      }

      const engine = new DirectorEngine(null);
      this.engine = engine;
      phase('engine object built');
      // Retry the realm repair here too: an IIFE bundle loaded from <head> runs it
      // before <body> exists, and the reference frame needs a host element.
      const reclaimed = reclaimIfLegacyPage();
      phase('realm reclaim checked');
      if (reclaimed && reclaimed.changed) {
        const sample = [...reclaimed.restored, ...reclaimed.unshadowed, ...reclaimed.dropped].slice(0, 5).join(', ');
        engine.log(
          `legacy page realm reclaimed: ${reclaimed.restored.length} standard members restored, ` +
          `${reclaimed.unshadowed.length} DOM shadows removed, ${reclaimed.dropped.length} toJSON hooks dropped, ` +
          `${reclaimed.hidden.length} legacy additions hidden from for..in (${sample}${reclaimed.changed > 5 ? ', …' : ''})`,
        );
      }
      engine.runMode = 'Plugin';
      engine.audioHost = new WebAudioPlayer();
      engine.textRasterizer = rasterizeTextMember;
      const pw = new PersistWorker();
      if (pw.available) {
        this._persistWorker = pw;
        engine.attachPersistence(pw);
        const onVis = () => engine.setPageHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVis);
        this._persistCleanup = () => document.removeEventListener('visibilitychange', onVis);
        onVis();
      }
      const params: Record<string, string> = {};
      for (const attr of this.attributes) {
        const name = attr.name.toLowerCase();
        if (name === 'movie' || name === 'width' || name === 'height' || name === 'log' || name === 'id' || name === 'class' || name === 'style') continue;
        params[name] = attr.value;
      }
      engine.setExternalParams(params);
      engine.moviePath = baseUrl.href.slice(0, baseUrl.href.lastIndexOf('/') + 1);

      const width = this.hasAttribute('width') ? Number(this.getAttribute('width')) : undefined;
      const height = this.hasAttribute('height') ? Number(this.getAttribute('height')) : undefined;
      if (width && Number.isFinite(width)) engine.stageWidth = width;
      if (height && Number.isFinite(height)) engine.stageHeight = height;

      this.textContent = '';
      const stage = new PixiStage(engine, this);
      this.stage = stage;
      await stage.init();
      phase('stage + renderer up');
      engine.adapter = stage;

      engine.onCastLoaded = () => {
        this.loadFonts(engine);
      };
      await engine.loadCast(loader, cast.name);
      phase(`${engine.casts.length} cast libraries loaded`);
      const wAttr = Number(this.getAttribute('width'));
      const hAttr = Number(this.getAttribute('height'));
      if (this.hasAttribute('width') && Number.isFinite(wAttr) && wAttr > 0) engine.stageWidth = wAttr;
      if (this.hasAttribute('height') && Number.isFinite(hAttr) && hAttr > 0) engine.stageHeight = hAttr;
      if (this.hasAttribute('width') || this.hasAttribute('height')) {
        stage.resize(engine.stageWidth, engine.stageHeight);
      }
      engine.boot();
      phase('movie booted');
      await this.loadFonts(engine);

      const onKeyDown = (e: KeyboardEvent): void => {
        if (!this.engine) return;
        this.engine.dispatchKeyEvent('keyDown', e.key, e.keyCode, {
          shift: e.shiftKey,
          alt: e.altKey,
          ctrl: e.ctrlKey,
          meta: e.metaKey,
        });
        if (this.engine.keyboardFocusSprite > 0 &&
            (e.keyCode === 8 || e.key.length === 1 || e.key === ' ' || e.key.startsWith('Arrow'))) {
          e.preventDefault();
        }
      };
      const onKeyUp = (e: KeyboardEvent): void => {
        this.engine?.dispatchKeyEvent('keyUp', e.key, e.keyCode, {
          shift: e.shiftKey,
          alt: e.altKey,
          ctrl: e.ctrlKey,
          meta: e.metaKey,
        });
      };
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      this._keyCleanup = () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
      };

      this.watchCanvasScale(engine);
      this.setupDevOverlay(stage, engine);
      this.dispatchEvent(new CustomEvent('spark-ready', { detail: { engine } }));
      const logSel = this.getAttribute('log');
      if (logSel) this.streamLog(logSel);
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Developer panel (`stage/devOverlay.ts`): renderer + WebGL context, fps and
   * worst frame gap, the per-frame engine/sync split (last and peak, with the
   * timestamp of the peak), bakes with their ms, scene/heap sizes, boot
   * milestones and the browser's own long-task entries (what a "rooms hang for a second now" report looks like from inside
   * the page).
   *
   * Opt-in only, and enabled from three places so it works on a real hotel page
   * without editing it: `?dev=1` (or `?dev`) in the URL, a `dev` attribute on
   * `<spark-player>`, or `window.__sparkDev.show()` from the console. F9 toggles.
   * The perf counters it reads are behind `enablePerf()` so an ordinary boot
   * never pays for `performance.now()` pairs it will not display.
   */
  private setupDevOverlay(stage: PixiStage, engine: DirectorEngine): void {
    const requested = this.hasAttribute('dev') || (typeof location !== 'undefined' && /(^|[?&])dev(=|&|$)/.test(location.search));
    const overlay = new DevOverlay(
      () => stage.debugInfo(),
      () => stage.perfMilestones(),
    );
    this._dev = overlay;
    const cleanup = overlay.install();
    this._devCleanup = cleanup;
    if (requested) overlay.show();
    const api = {
      show: () => { enablePerf(); overlay.show(); },
      hide: () => overlay.hide(),
      toggle: () => { enablePerf(); overlay.toggle(); },
      visible: () => overlay.visible,
      snapshot: () => stage.debugInfo(),
      milestones: () => stage.perfMilestones(),
      mark: (label: string, ms: number) => perfMilestone(label, ms),
    };
    (window as unknown as { __sparkDev?: typeof api }).__sparkDev = api;
    if (requested) engine.log('dev panel on — F9 toggles, window.__sparkDev.snapshot() dumps the numbers');
  }

  /**
   * The canvas is created at exactly the movie's stage size, and nothing in the
   * runtime ever touches its CSS box: if the embedding page's stylesheet makes
   * that box a different size (width:100%, a flex row, a hi-dpi "scale up" rule)
   * the browser post-scales the rendered frame instead. That reads as "the font
   * size is doubled and stretched" long before anyone notices the room art is
   * upscaled too, because 9px Volter is the smallest, sharpest thing on screen.
   * Report the mismatch (and the factor) so it is diagnosable from the log.
   */
  private watchCanvasScale(engine: DirectorEngine): void {
    if (typeof ResizeObserver === 'undefined') return;
    let warned = '';
    const check = (): void => {
      const canvas = this.querySelector('canvas');
      const sw = engine.stageWidth;
      const sh = engine.stageHeight;
      if (!canvas || sw < 1 || sh < 1) return;
      const box = canvas.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return;
      const sx = box.width / sw;
      const sy = box.height / sh;
      if (Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) return;
      const key = `${sx.toFixed(3)}x${sy.toFixed(3)}`;
      if (key === warned) return;
      warned = key;
      engine.warn(
        `stage ${sw}x${sh} is displayed at ${Math.round(box.width)}x${Math.round(box.height)} CSS px ` +
        `(scale ${sx.toFixed(2)}x${sy.toFixed(2)}, dpr ${window.devicePixelRatio || 1}) — page CSS is ` +
        'stretching the canvas, so the movie (and its 9px Volter text) is upscaled by the compositor. ' +
        `Size <spark-player> to ${sw}x${sh}, or scale it by whole numbers, to keep text crisp.`,
      );
    };
    const ro = new ResizeObserver(check);
    ro.observe(this);
    const onResize = (): void => check();
    window.addEventListener('resize', onResize);
    this._scaleCleanup = () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
    check();
  }

  private async loadFonts(engine: DirectorEngine): Promise<void> {
    const movieDir = engine.moviePath.endsWith('/') ? engine.moviePath : engine.moviePath + '/';
    const pending: Promise<void>[] = [];
    for (const cast of engine.casts) {
      for (const rel of cast.fontFiles ?? []) {
        const { family, weight } = fontFaceForFile(rel);
        const key = `${family}:${weight}`;
        if (this._fontSeen.has(key)) continue;
        this._fontSeen.add(key);
        pending.push((async () => {
          try {
            const url = await resolveFontUrl(rel, movieDir);
            const bytes = await fetchBytes(url);
            const ab = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(ab).set(bytes);
            const face = new FontFace(family, ab, { weight });
            await face.load();
            document.fonts.add(face);
            engine.log(`font loaded: ${family} ${weight} <- ${rel}`);
          } catch (err) {
            engine.warn(`font load failed ${rel}: ${err instanceof Error ? err.message : String(err)}`);
          }
        })());
      }
    }
    await Promise.all(pending);
    if (pending.length > 0) {
      for (const cast of engine.casts) {
        for (const member of cast.members.values()) {
          if (member.kind === 'text') member.image = undefined;
        }
      }
      engine.refreshTextChannels();
    }
  }

  private streamLog(selector: string): void {
    const el = document.querySelector(selector) as HTMLPreElement | null;
    if (!el || !this.engine) return;
    const engine = this.engine;
    const MAX_LINES = 300;
    let pinned = true;
    const nearBottom = (): boolean =>
      el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    el.addEventListener('scroll', () => {
      pinned = nearBottom();
    });
    setInterval(() => {
      const tail = engine.logs.slice(-MAX_LINES).join('\n');
      if (tail === el.textContent) return;
      el.textContent = tail;
      if (pinned) el.scrollTop = el.scrollHeight;
    }, 250);
  }

  private showError(msg: string): void {
    this.textContent = '';
    const div = document.createElement('div');
    div.textContent = `spark error: ${msg}`;
    div.style.cssText = 'color:#f66;font:12px monospace;padding:8px;background:#111;';
    this.appendChild(div);
    this.dispatchEvent(new CustomEvent('spark-error', { detail: { message: msg } }));
  }
}

function makeSource(movieUrl: URL): BundleSource {
  const dir = movieUrl.href.slice(0, movieUrl.href.lastIndexOf('/') + 1);
  return {
    async fetchBundle(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<Uint8Array | null> {
      let hintDir = '';
      if (urlHint) hintDir = castHintDir(urlHint, dir);
      const dirs = [hintDir, dir].filter(Boolean);
      for (const d of dirs) {
        for (const ext of ['spark', 'zip']) {
          try {
            const url = new URL(`${encodeURIComponent(name)}.${ext}`, d);
            return await fetchBytes(url, onProgress);
          } catch {
          }
        }
      }
      return null;
    },
  };
}

async function fetchBytes(url: URL, onProgress?: (soFar: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const body = res.body;
  if (onProgress && body && total > 0) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let soFar = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      soFar += value.length;
      onProgress(soFar, total);
    }
    const out = new Uint8Array(soFar);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  return new Uint8Array(await res.arrayBuffer());
}

function isFontBytes(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const d = new DataView(b.buffer, b.byteOffset, 4);
  const u32 = d.getUint32(0);
  return u32 === 0x00010000 || u32 === 0x4f54544f || u32 === 0x74727565 || u32 === 0x74797031;
}

async function resolveFontUrl(rel: string, movieDir: string): Promise<URL> {
  for (const base of fontBaseCandidates(movieDir)) {
    const url = new URL(rel, base);
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch {
      return new URL(rel, movieDir);
    }
    if (!res.ok) continue;
    if (isFontBytes(new Uint8Array(await res.arrayBuffer()))) return url;
  }
  return new URL(rel, movieDir);
}

function fontFaceForFile(rel: string): { family: string; weight: string } {
  const base = rel.split('/').pop() ?? rel;
  const m = /^(\d+)_(.+?)_(\d+)_\d+\.ttf$/i.exec(base);
  if (m) return { family: m[2], weight: m[3] === '700' ? '700' : '400' };
  return { family: base.replace(/\.ttf$/i, ''), weight: '400' };
}

export function defineSpark(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('spark-player')) {
    customElements.define('spark-player', SparkElement);
  }
}

defineSpark();
