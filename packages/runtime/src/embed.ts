import { BundleLoader, castHintDir, type BundleSource } from './bundle/loader.js';
import { fontBaseCandidates } from './bundle/fontPaths.js';
import { DirectorEngine } from './engine/engine.js';
import { WebAudioPlayer } from './engine/audio.js';
import { PixiStage } from './stage/pixi.js';
import { rasterizeTextMember } from './stage/text.js';
import { PersistWorker } from './worker/persist.js';

// `<spark-player movie="./movie.spark" sw1="..." ...>` — a drop-in web
// component that runs a Director movie bundle in the browser, Shockwave-style
// (the hyphen is required for custom element names).
//
// Attributes:
// - movie (required): URL of the movie's own cast bundle; linked casts are
//   fetched from the same directory as <castName>.spark
// - sw1..sw9 / src / swURL / ...: external params, exposed to Lingo via
//   externalParamValue("sw1") etc. The Multiuser connections (sw2
//   connection.info.*, sw4 connection.mus.*) are handled by the Xtra itself:
//   connectToNetServer builds each URL from the host/port the script passes,
//   using the page's scheme (wss on https, ws otherwise). No `ws` attribute —
//   the embed opens no sockets itself.
// - width/height: optional canvas size override (defaults to movie.txt)
// - log: CSS selector of a <pre> to stream the engine log into
//
// The running engine is exposed as `element.engine`.
// Node has no DOM (headless boots import dist/index.js), so fall back to a
// plain base class; the browser path always gets the real HTMLElement.
const SparkBase = (typeof HTMLElement !== 'undefined' ? HTMLElement : class {}) as typeof HTMLElement;

export class SparkElement extends SparkBase {
  private engine: DirectorEngine | null = null;
  private loader: BundleLoader | null = null;
  private stage: PixiStage | null = null;
  private booted = false;
  private _keyCleanup: (() => void) | null = null;
  // Font families already registered — loadFonts re-runs on every cast
  // registration, so this dedupes.
  private _fontSeen = new Set<string>();
  // Persistence worker (owns the Multiuser WebSocket + the 1 Hz hidden-clock).
  private _persistWorker: PersistWorker | null = null;
  // visibilitychange listener cleanup (forwards page state to setPageHidden).
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

      // The movie bundle itself.
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
      // Shockwave runs in "Plugin" mode — the corpus gates its sw-param parse
      // on `the runMode contains "Plugin"`.
      engine.runMode = 'Plugin';
      // Real audio for puppetSound / sound-channel plays.
      engine.audioHost = new WebAudioPlayer();
      // Rasterize text/field members with the canvas renderer (needs the cast
      // TTFs registered so the canvas uses the real Director fonts).
      engine.textRasterizer = rasterizeTextMember;
      // The Multiuser Xtra handles connections itself, like the original Xtra:
      // the corpus reads the sw2/sw4 host+port params into its variable store
      // and passes them to connectToNetServer; the engine builds each URL with
      // the page's protocol (wss on https, ws otherwise). The embed opens
      // NOTHING itself — sockets appear only when scripts call
      // connectToNetServer (login, bindata fetch).
      // Persistence worker: owns the Multiuser WebSocket and a 1 Hz background
      // clock so the client keeps ticking while the tab is hidden (rAF is
      // paused there). Headless/CSP-blocked environments fall back to the
      // engine's inline socket path.
      const pw = new PersistWorker();
      if (pw.available) {
        this._persistWorker = pw;
        engine.attachPersistence(pw);
        const onVis = () => engine.setPageHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVis);
        this._persistCleanup = () => document.removeEventListener('visibilitychange', onVis);
        onVis(); // current state at boot
      }
      // Every attribute except the control ones is an external param.
      const params: Record<string, string> = {};
      for (const attr of this.attributes) {
        const name = attr.name.toLowerCase();
        if (name === 'movie' || name === 'width' || name === 'height' || name === 'log' || name === 'id' || name === 'class' || name === 'style') continue;
        params[name] = attr.value;
      }
      engine.setExternalParams(params);
      // The movie's own directory becomes the moviePath (backs `the moviePath`).
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

      // The movie cast registers here; the rest load lazily during boot's net
      // preloads. loadFonts must run for every cast that carries TTFs, so hook
      // cast registration and also run once after boot.
      engine.onCastLoaded = () => {
        this.loadFonts(engine);
      };
      await engine.loadCast(loader, cast.name);
      // Explicit width/height attributes beat the movie.txt stage size
      // (movie.txt is applied during loadCast, so re-apply after).
      const wAttr = Number(this.getAttribute('width'));
      const hAttr = Number(this.getAttribute('height'));
      // > 0: an empty width="" attribute must not collapse the stage to 0.
      if (this.hasAttribute('width') && Number.isFinite(wAttr) && wAttr > 0) engine.stageWidth = wAttr;
      if (this.hasAttribute('height') && Number.isFinite(hAttr) && hAttr > 0) engine.stageHeight = hAttr;
      if (this.hasAttribute('width') || this.hasAttribute('height')) {
        stage.resize(engine.stageWidth, engine.stageHeight);
      }
      engine.boot();
      // Boot kicked off the cast preloads — give the synchronous subset a
      // chance to register, then load their fonts (the onCastLoaded hook picks
      // up any that register later, e.g. over the net).
      await this.loadFonts(engine);

      // Route real keystrokes to the engine (native field editing + behavior
      // keyDown/keyUp). Consume backspace/printables/scroll keys while a
      // field has focus so the browser doesn't navigate or scroll mid-login.
      const onKeyDown = (e: KeyboardEvent): void => {
        if (!this.engine) return;
        this.engine.dispatchKeyEvent('keyDown', e.key, e.keyCode, {
          shift: e.shiftKey,
          alt: e.altKey,
          ctrl: e.ctrlKey,
          meta: e.metaKey,
        });
        // While a field has focus the engine owns the keystroke: consume
        // backspace, printable chars, and the page-scroll keys (space/arrows)
        // so the browser doesn't scroll or navigate mid-login.
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

  // Fetch + register the cast-bundled TTF fonts (FontFace), one per
  // (family, weight). Paths in the manifest are rooted at the CASTS output
  // dir (they carry the version/group prefix, e.g. "31/hh_interface/fonts/…"
  // for the multiversion layout), while the movie lives one level down — so
  // resolve against the movie dir first (flat layout), then walk up toward
  // the casts root until the file actually exists.
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
      // Text rasterized before its font was ready is cached on member.image —
      // invalidate so it re-renders with the real Director font.
      for (const cast of engine.casts) {
        for (const member of cast.members.values()) {
          if (member.kind === 'text') member.image = undefined;
        }
      }
      // Rebuild live field/button channels so a Text created before the
      // FontFace registered swaps from the fallback font to the real one.
      engine.refreshTextChannels();
    }
  }

  private streamLog(selector: string): void {
    const el = document.querySelector(selector) as HTMLPreElement | null;
    if (!el || !this.engine) return;
    const engine = this.engine;
    // Plain scrolling tail: newest lines stay in view until the user scrolls
    // up, then the tail stops yanking them back down.
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

// Fetch cast bundles relative to the movie: <dir>/<name>.spark then .zip.
// The corpus preloads casts by CDN URL (casts/hof_furni/xx.cct?randp...), so
// when a urlHint is given the bundle is looked up next to that URL first
// (extension swapped, query dropped) — nested sub-cast containers like
// hof_furni live there — before falling back to the flat movie dir.
function makeSource(movieUrl: URL): BundleSource {
  const dir = movieUrl.href.slice(0, movieUrl.href.lastIndexOf('/') + 1);
  return {
    async fetchBundle(name: string, onProgress?: (soFar: number, total: number) => void, urlHint?: string): Promise<Uint8Array | null> {
      // http://x/casts/hof_furni/hh_x.cct?randp=1 -> http://x/casts/hof_furni/
      // (a relative hint like v31's "hof_furni/…" resolves against the movie
      // dir first; the query is stripped before the directory cut so a '/'
      // inside the query can't break the split).
      let hintDir = '';
      if (urlHint) hintDir = castHintDir(urlHint, dir);
      const dirs = [hintDir, dir].filter(Boolean);
      for (const d of dirs) {
        for (const ext of ['spark', 'zip']) {
          try {
            const url = new URL(`${encodeURIComponent(name)}.${ext}`, d);
            return await fetchBytes(url, onProgress);
          } catch {
            // try next candidate
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
    // Chunked read so the corpus's download progress (getStreamStatus) can
    // animate the Loading Bar as bytes arrive.
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

// TrueType/OpenType magic signatures (first 4 bytes): 0x00010000, 'OTTO',
// 'true', 'typ1'. Anything else — HTML from a dev-server SPA fallback, a
// directory listing, an error page — is not a font and must not be accepted.
function isFontBytes(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const d = new DataView(b.buffer, b.byteOffset, 4);
  const u32 = d.getUint32(0);
  return u32 === 0x00010000 || u32 === 0x4f54544f || u32 === 0x74727565 || u32 === 0x74797031;
}

// Resolve a manifest font path to a fetchable URL: try each fontBaseCandidate
// (movie dir first, then parents up to the casts root) and return the first
// that actually serves a FONT payload. Dev servers answer 200 with the SPA
// index.html for missing paths, so a plain res.ok is not enough — the body's
// magic bytes must be a TTF/OTF signature. On a network error (no server,
// blocked) or when nothing serves, fall back to the movie-dir URL so the
// caller's error/warn path reports the primary location.
async function resolveFontUrl(rel: string, movieDir: string): Promise<URL> {
  for (const base of fontBaseCandidates(movieDir)) {
    const url = new URL(rel, base);
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch {
      // Network error (no server, blocked) — walking up will not help.
      return new URL(rel, movieDir);
    }
    if (!res.ok) continue;
    if (isFontBytes(new Uint8Array(await res.arrayBuffer()))) return url;
  }
  return new URL(rel, movieDir);
}

// Derive CSS font family + weight from a bundled font filename
// (`0001_Volter_400_0.ttf` -> family "Volter", weight 400).
function fontFaceForFile(rel: string): { family: string; weight: string } {
  const base = rel.split('/').pop() ?? rel;
  const m = /^(\d+)_(.+?)_(\d+)_\d+\.ttf$/i.exec(base);
  if (m) return { family: m[2], weight: m[3] === '700' ? '700' : '400' };
  return { family: base.replace(/\.ttf$/i, ''), weight: '400' };
}

// Register the <spark-player> custom element (idempotent).
export function defineSpark(): void {
  if (typeof customElements !== 'undefined' && !customElements.get('spark-player')) {
    customElements.define('spark-player', SparkElement);
  }
}

// Auto-register on import so a plain <script src="spark.js"> just works.
defineSpark();
