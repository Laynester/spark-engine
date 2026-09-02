import { BundleLoader, castHintDir, type BundleSource } from './bundle/loader.js';
import { fontBaseCandidates } from './bundle/fontPaths.js';
import { DirectorEngine } from './engine/engine.js';
import { WebAudioPlayer } from './engine/audio.js';
import { PixiStage } from './stage/pixi.js';
import { rasterizeTextMember } from './stage/text.js';
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

  get directorEngine(): DirectorEngine | null {
    return this.engine;
  }

  get directorStage(): PixiStage | null {
    return this.stage;
  }

  disconnectedCallback(): void {
    this._keyCleanup?.();
    this._keyCleanup = null;
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
    try {
      const baseUrl = new URL(movie, window.location.href);

      const movieBytes = await fetchBytes(baseUrl);
      const loader = new BundleLoader(makeSource(baseUrl));
      this.loader = loader;
      const cast = loader.register(movieBytes);
      if (!cast) {
        this.showError(`"${movie}" is not a valid bundle (no bundle-manifest.json)`);
        return;
      }

      const engine = new DirectorEngine(null);
      this.engine = engine;
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
      engine.adapter = stage;

      engine.onCastLoaded = () => {
        this.loadFonts(engine);
      };
      await engine.loadCast(loader, cast.name);
      const wAttr = Number(this.getAttribute('width'));
      const hAttr = Number(this.getAttribute('height'));
      if (this.hasAttribute('width') && Number.isFinite(wAttr) && wAttr > 0) engine.stageWidth = wAttr;
      if (this.hasAttribute('height') && Number.isFinite(hAttr) && hAttr > 0) engine.stageHeight = hAttr;
      if (this.hasAttribute('width') || this.hasAttribute('height')) {
        stage.resize(engine.stageWidth, engine.stageHeight);
      }
      engine.boot();
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

      this.dispatchEvent(new CustomEvent('spark-ready', { detail: { engine } }));
      const logSel = this.getAttribute('log');
      if (logSel) this.streamLog(logSel);
    } catch (err) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
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
