// Imported before pixi.js on purpose: a legacy page bundle (Prototype 1.6) can have
// clobbered the built-ins Pixi needs by the time we get here, and Pixi reads
// Array.prototype.reduce while its module initializes (see legacy/reclaim.ts).
import '../legacy/reclaim.js';
import { Application, BufferImageSource, Container, Graphics, Rectangle, Sprite, Text, Texture, type BLEND_MODES } from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import { alignmentName, type ChannelVisual, type DirectorEngine, type StageAdapter } from '../engine/engine.js';
import type { Channel } from '../engine/sprites.js';
import { LImage, LList, LObject, LPoint, LPropList, LSpriteRef, LSymbol } from '../lingo/values.js';
import type { ShapeDef } from '../engine/members.js';
import { applyMaskAlpha, bakeEdgeBackground, bakeModeForInk, bakeSurface, blendFilterMode, blendModeForInk, cornersAreNearWhite, spritePixelHitTest, setMatteIdentityFill, tintSpriteBackground, tintSpriteDarken, DARKEST_BLEND_MODE, LIGHTEST_BLEND_MODE, REVERSE_BLEND_MODE, SUBTRACT_BLEND_MODE, SUBTRACT_WRAP_BLEND_MODE, type BakeMode } from './matte.js';
import { caretBlinkOn, caretBox, caretX } from './caret.js';
import { textMemberLineMetrics } from './text.js';
import { registerInkBlendFilters } from './blendFilters.js';
import { perf, perfEnabled, perfFrame, perfTimeBake, type PerfMilestone } from '../perf.js';
import type { DevSnapshot } from './devOverlay.js';
import { decodeImage } from '../engine/pix8.js';


interface ChannelNode {
  container: Container;
  visual: Sprite | Text | Graphics | Container | null;
  regX: number;
  regY: number;
  blobEntry?: BlobEntry;
  imgLImage?: LImage;
  imgTexture?: Texture;
  imgSource?: BufferImageSource;
  /**
   * The pixels the hit test samples — the SAME surface this node renders, so a
   * pixel the sprite displays nothing at belongs to the sprite below
   * (`spritePixelHitTest`). Set by every bitmap branch: the live-image path
   * (with `imgSource`) AND the raw-cast-bytes path, which is where the room's
   * own art comes from (walls, tiles, furniture pieces are `member.raw`).
   */
  imgBuffer?: Uint8Array | Uint8ClampedArray | null;
  /** The hit buffer's own size; the bytes path has no `imgSource` to ask. */
  hitBufW?: number;
  hitBufH?: number;
  bakeBuf?: Uint8ClampedArray;
  bakeMode?: BakeMode | null;
  baseW?: number;
  baseH?: number;
  shape?: ShapeDef;
  textObj?: Text;
  caret?: Graphics;
  caretColor?: number | string;
  caretX?: number;
  caretY?: number;
  caretH?: number;
  hitW?: number;
  hitH?: number;
  bgFill?: Graphics;
  bgFillScanBuf?: Uint8Array | null;
  bgFillScanDirty?: boolean;
  bgFillTransparent?: boolean;
  keyedBuf?: Uint8Array;
}

interface BlobEntry {
  bytes: Uint8Array;
  bake: BakeMode | null;
  key: string;
  refs: number;
  width: number;
  height: number;
  texture: Texture;
  /** The decoded (and baked) pixels the texture was built from — what the hit
   *  test samples. Kept because the texture's source is GPU-side. */
  rgba: Uint8Array | Uint8ClampedArray | null;
}

function fullyTransparent(buf: Uint8Array): boolean {
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

export function directorTransformFlip(rotationDeg: number, skewDeg: number, flipH: number): { flipX: number; mirrored: boolean } {
  const norm = (d: number) => ((d % 360) + 360) % 360;
  const mirrored =
    Math.abs(norm(rotationDeg) - 180) < 0.5 && Math.abs(norm(skewDeg) - 180) < 0.5;
  return { flipX: (flipH === 1 ? -1 : 1) * (mirrored ? -1 : 1), mirrored };
}

export function inverseDirectorTransformPoint(
  rotationDeg: number,
  skewDeg: number,
  flipH: number,
  flipV: number,
  locH: number,
  locV: number,
  x: number,
  y: number,
): { tx: number; ty: number } {
  const { mirrored } = directorTransformFlip(rotationDeg, skewDeg, flipH);
  const rot = mirrored ? 0 : rotationDeg || 0;
  let tx = x;
  let ty = y;
  if (rot) {
    const th = (-rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const dx = x - locH;
    const dy = y - locV;
    tx = locH + dx * c - dy * s;
    ty = locV + dx * s + dy * c;
  }
  if ((flipH === 1) !== mirrored) tx = 2 * locH - tx;
  if (flipV === 1) ty = 2 * locV - ty;
  return { tx, ty };
}

/**
 * The renderer backends pixi can select. `webgl` is WebGL2 where the browser has
 * it and WebGL1 otherwise — there is no separate "webgl2" option.
 */
export type RendererPreference = 'webgl' | 'webgpu' | 'canvas';

/**
 * Normalise the `renderer` setting — a `<spark-player renderer>` attribute or
 * `?renderer=`, same syntax for both — into pixi's `preference`.
 *
 *   (unset) | auto      -> undefined, pixi's own order: webgl -> webgpu -> canvas
 *   webgl | webgl2      -> 'webgl'  (tried first, the rest stay as fallbacks)
 *   webgpu              -> 'webgpu' (tried first, the rest stay as fallbacks)
 *   webgl,webgpu        -> ['webgl','webgpu','canvas'] (exact order, canvas last)
 *   canvas              -> ['canvas'] (forced alone — the unaccelerated path)
 *
 * A comma list is an explicit order; pixi excludes anything not listed, so
 * `canvas` is appended as the universal fallback (a page booting is better than
 * a page refusing to start because a GPU blocklist dropped WebGL). Unknown names
 * are dropped, and a setting with no recognisable backend falls back to `auto`
 * rather than throwing, so a typo cannot stop the client booting.
 */
export function parseRendererPreference(
  raw: string | null | undefined,
): RendererPreference | RendererPreference[] | undefined {
  const names = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: RendererPreference[] = [];
  for (const name of names) {
    const kind: RendererPreference | null =
      name === 'webgl' || name === 'webgl2' || name === 'gl' ? 'webgl'
        : name === 'webgpu' || name === 'gpu' ? 'webgpu'
          : name === 'canvas' || name === '2d' ? 'canvas'
            : null;
    if (kind && !out.includes(kind)) out.push(kind);
  }
  if (!out.length) return undefined;
  // One named backend means "prefer this", so hand pixi the string and let it
  // keep the ordinary fallback chain. `canvas` is the exception: it is only ever
  // chosen deliberately (to inspect the unaccelerated path), so force it alone.
  if (out.length === 1) return out[0] === 'canvas' ? ['canvas'] : out[0];
  if (!out.includes('canvas')) out.push('canvas');
  return out;
}

/**
 * How many NODES still owe a re-read of each dirty image, in stage order.
 *
 * `LImage.dirty` is a property of the IMAGE, but the update it signals is
 * consumed by a NODE: `syncChannelImages()` re-bakes and re-uploads one
 * channel's texture at a time. Two channels can legitimately share one member's
 * image — the Human avatar canvas is used by BOTH its body sprite and its matte
 * sprite (`pSprite.castNum` / `pMatteSpr.castNum = pMember.number` in
 * `Human_Class_EX::define`), and the same dynamic member can be placed on two
 * channels — so clearing the flag on the first node starves every later node:
 * it keeps a stale texture until some unrelated write re-dirties the member
 * (e.g. the ink-family shortcut in engine.ts `setSpriteProp` `case 'ink'`, which
 * relies on exactly this re-upload).
 *
 * The debt map makes the flag last exactly as long as there are nodes to serve.
 * A node the BAKE_BATCH cap did not reach keeps its debt, so the image stays
 * dirty and those nodes are served on the next frame.
 */
export function imageDirtyDebts(nodes: Iterable<{ imgLImage?: LImage | null }>): Map<LImage, number> {
  const debts = new Map<LImage, number>();
  for (const node of nodes) {
    const img = node.imgLImage;
    if (img && img.dirty) debts.set(img, (debts.get(img) ?? 0) + 1);
  }
  return debts;
}

/**
 * Mark one node's re-read of `img` as done, clearing the image's dirty flag only
 * once every node that shared it has been served (see `imageDirtyDebts`).
 */
export function releaseImageDirty(debts: Map<LImage, number>, img: LImage): void {
  const left = (debts.get(img) ?? 1) - 1;
  if (left > 0) {
    debts.set(img, left);
    return;
  }
  debts.delete(img);
  img.dirty = false;
}

/**
 * The per-click `click:` / `room:` diagnostics run several interpreted evals on
 * every press (the room probes walk `getThread(#room).getComponent()` and the
 * whole `#spriteList`), which is measurable on a click. They are therefore off
 * unless `window.SPARK_POINTER_LOG = 1` asks for them — the same opt-in shape
 * `engine.log`'s `net:` suppression uses for the net traffic.
 */
function pointerDebug(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { SPARK_POINTER_LOG?: unknown }).SPARK_POINTER_LOG === 1
  );
}

/** The `global` (stage-space) point a pixi federated pointer event carries. */
export interface PointerPoint {
  global: { x: number; y: number };
}

/** The slice of a pixi stage the pointer binding needs. */
export interface PointerEventStage {
  on(type: string, fn: (e: PointerPoint) => void): unknown;
  off(type: string, fn: (e: PointerPoint) => void): unknown;
}

/** The slice of a DOM event target the pointer binding needs. */
export interface PointerEventTarget {
  addEventListener(type: string, fn: () => void): unknown;
  removeEventListener(type: string, fn: () => void): unknown;
}

/**
 * What the movie does in response to each pointer event, so the wiring itself
 * can be exercised without a renderer.
 */
export interface PointerSink {
  /** press in the canvas */
  down(x: number, y: number): void;
  /** release, in or out of the canvas */
  up(x: number, y: number): void;
  move(x: number, y: number): void;
  /** the cursor left the canvas — the movie's rollover is over */
  leave(): void;
  /** the window lost focus (or the browser cancelled the pointer) mid-input */
  blur(): void;
}

/**
 * Bind the pointer events a Director movie expects, and return the unbind.
 *
 * The stage alone is not enough, and each extra binding covers a release or a
 * hover the movie would otherwise never hear about:
 * - `pointerupoutside`: pixi reports a release that lands OUTSIDE the canvas as
 *   this, not `pointerup` — the press target chain is walked up to the stage.
 *   Without it `the mouseButton` stayed down and the corpus's press-driven state
 *   (Button/DropDown/Scrollbar "pressed", Container Hand's held item, Object
 *   Mover's armed placement) never unwound.
 * - the canvas `pointerleave`: the DOM fires it when the cursor leaves the
 *   canvas, and the movie's hover has to end with it (Director has no rollover
 *   outside the stage).
 * - the window `blur` and `pointercancel`: alt-tab and a browser-cancelled
 *   pointer deliver NO event to the canvas at all, so a held modifier key and a
 *   held press would both stay set.
 */
export function bindPointerEvents(
  targets: { stage: PointerEventStage; canvas: PointerEventTarget; view: PointerEventTarget },
  sink: PointerSink,
): () => void {
  const { stage, canvas, view } = targets;
  const at = (e: PointerPoint): [number, number] => [Math.trunc(e.global.x), Math.trunc(e.global.y)];
  const down = (e: PointerPoint): void => sink.down(...at(e));
  const up = (e: PointerPoint): void => sink.up(...at(e));
  const move = (e: PointerPoint): void => sink.move(...at(e));
  const leave = (): void => sink.leave();
  const blur = (): void => sink.blur();

  stage.on('pointerdown', down);
  stage.on('pointerup', up);
  stage.on('pointerupoutside', up);
  stage.on('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
  view.addEventListener('blur', blur);
  view.addEventListener('pointercancel', blur);

  return () => {
    stage.off('pointerdown', down);
    stage.off('pointerup', up);
    stage.off('pointerupoutside', up);
    stage.off('pointermove', move);
    canvas.removeEventListener('pointerleave', leave);
    view.removeEventListener('blur', blur);
    view.removeEventListener('pointercancel', blur);
  };
}

export class PixiStage implements StageAdapter {
  app!: Application;
  private nodes = new Map<number, ChannelNode>();
  private blobCache = new Map<Uint8Array, Map<string, BlobEntry>>();
  private freeBlobs: BlobEntry[] = [];
  private static readonly BLOB_CACHE_CAP = 256;
  private layer!: Container;
  private background!: Graphics;
  private stageImg: LImage | null = null;
  private stageBuf: Uint8Array | null = null;
  private stageSprite: Sprite | null = null;
  private stageTexture: Texture | null = null;
  private frameAcc = 0;
  private lastFrameT = 0;
  /** Channels whose visual currently uses a blend-FILTER mode (any mode
   *  `blendFilterMode` knows: XOR (ink 2) / wrap subtract (38) / the Not Reverse
   *  duotone (6) / pass through (38, 39)). Maintained by
   *  `refreshChannel`/`setChannel`; `syncBackBuffer` just checks this. */
  private _blendFilterChannels = new Set<number>();
  /** Unbinds the pointer events wired in `init()` (see `bindPointerEvents`). */
  private pointerCleanup: (() => void) | null = null;

  constructor(
    private engine: DirectorEngine,
    private parent: HTMLElement,
  ) { }

  async init(preference?: RendererPreference | RendererPreference[]): Promise<void> {
    const { stageWidth: w, stageHeight: h, stageBackground: bg } = this.engine;
    this.app = new Application();
    // `preference` goes straight to pixi's auto detector: a string is tried
    // first with the remaining backends kept as fallbacks, an array is the
    // exact order (anything unlisted is excluded). Undefined keeps pixi's
    // default webgl -> webgpu -> canvas, which is what a shipped page gets.
    await this.app.init({ width: w, height: h, background: bg, antialias: false, resolution: 1, preference });
    registerInkBlendFilters();
    this.registerInkBlendModes();
    this.parent.appendChild(this.app.canvas);

    this.background = new Graphics().rect(0, 0, w, h).fill(bg);
    this.app.stage.addChild(this.background);

    this.layer = new Container();
    this.layer.sortableChildren = true;
    this.app.stage.addChild(this.layer);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.pointerCleanup = bindPointerEvents(
      { stage: this.app.stage, canvas: this.app.canvas, view: window },
      {
        down: (x, y) => this.pointer('mouseDown', x, y),
        up: (x, y) => this.pointer('mouseUp', x, y),
        move: (x, y) => this.pointer('mouseMove', x, y),
        leave: () => void this.engine.pointerLost(),
        blur: () => void this.engine.focusLost(),
      },
    );

    this.app.ticker.add(() => {
      // Dev counters are read by the overlay (`debugInfo`) and are guarded so the
      // disabled path is a single boolean test per frame.
      if (perfEnabled()) perf.frames++;
      this.syncStageImage();
      const now = performance.now();
      const dt = this.lastFrameT ? now - this.lastFrameT : 0;
      this.lastFrameT = now;
      const frameMs = 1000 / Math.max(1, this.engine.frameTempo);
      this.frameAcc += dt;
      if (this.frameAcc > frameMs * 2) this.frameAcc = frameMs * 2;
      if (this.frameAcc >= frameMs) {
        this.frameAcc -= frameMs;
        if (perfEnabled()) {
          const t0 = performance.now();
          this.engine.tick();
          perfFrame('tick', performance.now() - t0);
        } else {
          this.engine.tick();
        }
      }
      if (perfEnabled()) {
        const t0 = performance.now();
        this.syncChannelImages();
        perfFrame('sync', performance.now() - t0);
      } else {
        this.syncChannelImages();
      }
      this.syncBackBuffer();
      this.syncCaret();
    });
  }

  /**
   * Enable the renderer's back buffer while — and only while — a sprite uses an
   * ink whose blend mode is a pixi blend FILTER (2/6 XOR and 38 wrap subtract,
   * stage/blendFilters.ts).
   *
   * A blend filter samples the destination, which WebGL can only do from a
   * texture, so pixi renders the frame into an offscreen texture and blits it
   * out (`GlBackBufferSystem`, `useBackBuffer` defaults to false). Without it the
   * filter pipe just warns "Blend filter requires backBuffer on WebGL renderer to
   * be enabled" and the sprite falls back to a normal composite — the ink looks
   * like it does nothing. Toggling it per frame keeps that extra full-screen
   * pass off the frame budget for the (overwhelmingly common) case of a scene
   * with no XOR ink in it; the flag is read at the start of every render, so a
   * change takes effect on the next one.
   */
  private syncBackBuffer(): void {
    const backBuffer = (this.app.renderer as unknown as { backBuffer?: { useBackBuffer?: boolean } }).backBuffer;
    if (!backBuffer || typeof backBuffer.useBackBuffer !== 'boolean') return;
    const needs = this._blendFilterChannels.size > 0;
    if (backBuffer.useBackBuffer !== needs) backBuffer.useBackBuffer = needs;
  }

  /**
   * Register the ink blend modes pixi has no correct built-in for: a real GL
   * reverse-subtract (ink 35/38 — pixi's advanced 'subtract' is a back-texture
   * filter that lets the source through verbatim) and GL MIN/MAX for Darkest
   * (39) / Lightest (37, 40).
   *
   * All three preserve the destination ALPHA (srcAlpha factor 0, dstAlpha
   * factor 1). Pixi's own `min`/`max` map to `[ONE, ONE, ONE, ONE, MIN, MIN]`,
   * so they take the min/max of the alpha as well: a sprite's transparent
   * pixels — most of its quad for aliased furniture art — then drove the
   * destination alpha to 0 and cut a hole through the room. The colour maths is
   * unchanged (MIN/MAX/reverse-subtract ignore the RGB factors).
   */
  private registerInkBlendModes(): void {
    const state = (this.app.renderer as unknown as { state?: { blendModesMap?: Record<string, number[]> } }).state;
    const gl = (this.app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
    if (!state?.blendModesMap || !gl) {
      // WebGPU and the Canvas2D fallback have no GL blend state to hang a custom
      // mode on, and pixi's own min/max fold the ALPHA in too (they cut a hole
      // through the room, see above) while its 'subtract' lets the source
      // through. So the reverse-subtract and Darkest/Lightest inks cannot be
      // expressed on those backends and their sprites composite normally. Say so
      // once, so `?renderer=webgpu` is not a silent visual change.
      this.engine.log(
        `ink blend modes unavailable on the ${this.rendererName()} renderer: inks 35/38 (reverse subtract) and 37/39/40 (lightest/darkest) will composite normally`,
      );
      setMatteIdentityFill(false);
      return;
    }
    state.blendModesMap[SUBTRACT_BLEND_MODE] = [
      gl.ONE,
      gl.ONE,
      gl.ZERO,
      gl.ONE,
      gl.FUNC_REVERSE_SUBTRACT,
      gl.FUNC_ADD,
    ];
    // MIN/MAX need WebGL2 or EXT_blend_minmax; without them the map entry must
    // stay absent so pixi falls back to normal instead of using `undefined`.
    const gl2 = gl as WebGL2RenderingContext & { MIN?: number; MAX?: number };
    const minExt = gl.getExtension?.('EXT_blend_minmax') as { MIN_EXT?: number; MAX_EXT?: number } | null;
    const minOp = gl2.MIN ?? minExt?.MIN_EXT;
    const maxOp = gl2.MAX ?? minExt?.MAX_EXT;
    if (minOp !== undefined) state.blendModesMap[DARKEST_BLEND_MODE] = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE, minOp, gl.FUNC_ADD];
    if (maxOp !== undefined) state.blendModesMap[LIGHTEST_BLEND_MODE] = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE, maxOp, gl.FUNC_ADD];
    // Ink 39's keyed rectangle is only drawn as the opaque white MIN identity
    // while a MIN blend is really bound here (see matte.setMatteIdentityFill):
    // without it the sprite composites normally, where that opaque rectangle
    // would be a white box instead of a see-through one. The canvas fallback
    // never reaches this method, so it keeps the transparent matte.
    setMatteIdentityFill(minOp !== undefined);
  }

  /**
   * Snapshot for the dev overlay (`stage/devOverlay.ts`): what the renderer
   * actually is, what the runtime is spending its frame on, and the heap. Read
   * once a second at most, and deliberately read-only — nothing here changes what
   * a frame draws, so a reported regression cannot be caused by the reporting.
   */
  debugInfo(): DevSnapshot {
    const r = this.app.renderer as unknown as {
      type?: number;
      gl?: WebGLRenderingContext | WebGL2RenderingContext;
      state?: { blendModesMap?: Record<string, number[]> };
      backBuffer?: { useBackBuffer?: boolean };
      texture?: { managedTextures?: (unknown | null)[] };
    };
    const gl = r.gl;
    let gpu: string | null = null;
    const glVersion = gl ? ((gl as WebGL2RenderingContext).texStorage2D ? 2 : 1) : null;
    if (gl) {
      try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL?: number } | null;
        gpu = ext?.UNMASKED_RENDERER_WEBGL
          ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.VERSION));
      } catch {
        gpu = null;
      }
    }
    const renderer = this.rendererName();
    const box = (this.app.canvas as HTMLCanvasElement | undefined)?.getBoundingClientRect();
    // pixi's `managedTextures` getter is Object.values() over a hash whose
    // unloaded entries are set to null and only compacted after 10,000 holes
    // (GCSystem.runOnHash), so its `.length` only ever grows: a texture that WAS
    // disposed still counts. Count the non-null entries so the overlay reports
    // the textures that actually exist, not every source ever created.
    const texHash = (r.texture as unknown as { _managedTextures?: { items?: Record<string, unknown | null> } } | undefined)
      ?._managedTextures?.items;
    const liveTextures = texHash
      ? Object.values(texHash).reduce<number>((n, s) => (s ? n + 1 : n), 0)
      : (r.texture?.managedTextures ?? []).filter(Boolean).length;
    const map = r.state?.blendModesMap;
    const mem = (performance as unknown as {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    return {
      renderer,
      glVersion,
      gpu,
      backBuffer: r.backBuffer && typeof r.backBuffer.useBackBuffer === 'boolean' ? r.backBuffer.useBackBuffer : null,
      inkBlendModes: map ? Object.keys(map).filter((k) => k.endsWith('-gl')).sort() : [],
      screenW: this.app.screen.width,
      screenH: this.app.screen.height,
      canvasCssW: box?.width ?? 0,
      canvasCssH: box?.height ?? 0,
      dpr: window.devicePixelRatio || 1,
      nodes: this.nodes.size,
      textures: liveTextures,
      // Blob textures kept alive in the reuse cache (not on stage, so not part
      // of `textures`) — a climbing count here is a real disposal problem.
      idleTextures: this.freeBlobs.length,
      frames: perf.frames,
      ticks: perf.ticks,
      tickMs: perf.tickMs,
      tickMaxMs: perf.tickMaxMs,
      tickMaxAt: perf.tickMaxAt,
      tickTotalMs: perf.tickTotalMs,
      syncMs: perf.syncMs,
      syncMaxMs: perf.syncMaxMs,
      syncMaxAt: perf.syncMaxAt,
      syncTotalMs: perf.syncTotalMs,
      bakes: perf.bakes,
      bakeTotalMs: perf.bakeTotalMs,
      slowCalls: perf.slowCalls.slice(0, 6),
      castLibs: this.engine.casts.length,
      channels: this.engine.channels.length,
      frameTempo: this.engine.frameTempo,
      heapUsed: mem ? mem.usedJSHeapSize : null,
      heapTotal: mem ? mem.totalJSHeapSize : null,
      heapLimit: mem ? mem.jsHeapSizeLimit : null,
    };
  }

  perfMilestones(): PerfMilestone[] {
    return perf.milestones;
  }

  /** Which backend pixi actually created (its `RENDERER_TYPE`: 1 gl, 2 gpu, 4 canvas). */
  private rendererName(): string {
    const type = (this.app.renderer as unknown as { type?: number }).type;
    return type === 1 ? 'webgl' : type === 2 ? 'webgpu' : type === 4 ? 'canvas' : `type ${String(type)}`;
  }

  private syncCaret(): void {
    const focus = this.engine.keyboardFocusSprite;
    const ch = focus > 0 && focus < this.engine.channels.length ? this.engine.getChannel(focus) : undefined;
    const node = ch ? this.nodes.get(focus) : undefined;
    const member = ch?.member;
    const editable = member?.kind === 'text' && !!member.textProps?.get('editable');
    const group = node?.visual;
    if (!editable || !member || !node?.textObj || !(group instanceof Container) || ch?.visible !== 1) {
      if (node?.caret) node.caret.visible = false;
      return;
    }
    const w = Math.max(1, Math.round(ch.width || node.baseW || 1));
    const h = Math.max(1, Math.round(ch.height || node.baseH || 1));
    const x = caretX(alignmentName(member.alignment), w, node.textObj.width);
    // The insertion point is one line of the field's FONT, not the height of
    // the field box: taking `h` stretched the caret down a whole tall input
    // (gift greeting, console compose) and made it ignore fontSize.
    const metrics = textMemberLineMetrics(member);
    const { h: caretH, y: caretY } = caretBox(h, metrics.lineH, metrics.glyphH, node.textObj.height);
    if (!node.caret) {
      node.caret = new Graphics();
      group.addChild(node.caret);
    }
    if (node.caretX !== x || node.caretH !== caretH || node.caretY !== caretY) {
      node.caret.clear().rect(x, caretY, 1, caretH).fill(node.caretColor ?? 0xffffff);
      node.caretX = x;
      node.caretH = caretH;
      node.caretY = caretY;
    }
    node.caret.visible = caretBlinkOn(performance.now());
  }

  private static readonly BAKE_BATCH = 8;

  private syncChannelImages(): void {
    let processed = 0;
    const debts = imageDirtyDebts(this.nodes.values());
    for (const [channel, node] of this.nodes) {
      if (!node.imgLImage) continue;
      const img = node.imgLImage;
      if (!img.dirty) continue;
      // This node is being served now whatever happens next, so its share of
      // the image's dirty flag is settled here (see imageDirtyDebts).
      releaseImageDirty(debts, img);
      if (img.width < 1 || img.height < 1) continue;
      const w = Math.round(img.width);
      const h = Math.round(img.height);
      const ch = this.engine.getChannel(channel);
      const bake = this.bakeForChannel(ch, img, w, h);
      const tint = this.tintForChannel(ch);
      const duotone = this.duotoneForChannel(ch);
      const baked =
        bake || tint || duotone
          ? perfTimeBake(() => this.bakeImagePixels(node, img, w, h, bake, tint, this.inkKeyForChannel(ch), ch.ink ?? 0, ch.member?.palette, duotone))
          : null;
      const pixels = baked && baked.changed ? baked.pixels : img.ensure();
      const finalBake = baked && baked.changed ? bake : null;
      if (!node.visual || !(node.visual instanceof Sprite)) {
        // The node has no sprite of its own to own the texture, so free any
        // texture left over from a previous visual before replacing it (a
        // cleared image whose node was not reclaimed, e.g. a 0-sized image).
        node.imgTexture?.destroy(true);
        node.imgTexture = undefined;
        node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
        node.imgTexture = new Texture({ source: node.imgSource });
        const sprite = new Sprite(node.imgTexture);
        node.baseW = w;
        node.baseH = h;
        node.visual = sprite;
        node.container.addChild(sprite);
        node.bakeMode = finalBake;
        node.imgBuffer = pixels;
        node.hitBufW = w;
        node.hitBufH = h;
        this.refreshChannel(channel);
      } else if (!node.imgSource || node.imgSource.width !== w || node.imgSource.height !== h || node.bakeMode !== finalBake || node.imgBuffer !== pixels) {
        const oldTex = node.imgTexture;
        node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
        node.imgTexture = new Texture({ source: node.imgSource });
        node.visual.texture = node.imgTexture;
        node.bakeMode = finalBake;
        node.imgBuffer = pixels;
        node.hitBufW = w;
        node.hitBufH = h;
        node.baseW = w;
        node.baseH = h;
        // Pass true so the BufferImageSource is destroyed along with the
        // texture — destroy(false) only deregisters the source, it does not
        // free the GPU upload.
        oldTex?.destroy(true);
      } else {
        node.imgSource.update();
      }
      this.applyTransform(channel);
      if (++processed >= PixiStage.BAKE_BATCH) break;
    }
  }

  private bakeForChannel(ch: { ink: number; member?: { kind: string } } | undefined, img: LImage, w: number, h: number): BakeMode | null {
    if (!ch) return null;
    // Sprite-composed film loops arrive as alpha-bearing RGBA (the per-tile
    // matte is baked in during composition) — the ink flood would key the
    // surface color itself (waterloop tiles are edge-to-edge teal), so never
    // re-bake them.
    if (ch.member?.kind === 'filmloop') return null;
    if (ch.ink === 1 || ch.ink === 4 || ch.ink === 6 || ch.ink === 7 || ch.ink === 8 || ch.ink === 36 || ch.ink === 41) return bakeModeForInk(ch.ink);
    // Ink 33/34/35/37/38/39/40 (AddPin/Add/SubPin/Sub/Lightest/Darkest/Lighten)
    // composite the art additively/subtractively, so the opaque backing field
    // must be flood-filled out first or it blends in as a solid box. The
    // byte-fed blob path already bakes these via bakeModeForInk; this keeps the
    // image-member path identical. Ink 32 (Blend) keeps its normal blend and is
    // deliberately not baked.
    if (ch.ink === 33 || ch.ink === 34 || ch.ink === 35 || ch.ink === 37 || ch.ink === 38 || ch.ink === 39 || ch.ink === 40) {
      return bakeModeForInk(ch.ink);
    }
    if (ch.ink === 0 && w > 0 && h > 0 && cornersAreNearWhite(img.ensure(), w, h)) return 'backgroundTransparent';
    return null;
  }

  private bakeImagePixels(
    node: ChannelNode,
    img: LImage,
    w: number,
    h: number,
    bake: BakeMode | null,
    tint: number | null,
    inkKey?: number | null,
    ink = 0,
    palette?: number[][],
    duotone?: { fg: number; bg: number } | null,
  ): { pixels: Uint8ClampedArray; changed: boolean } {
    const n = w * h * 4;
    if (!node.bakeBuf || node.bakeBuf.length !== n) node.bakeBuf = new Uint8ClampedArray(n);
    const keyed = bake === 'matteIdentity' ? (node.keyedBuf && node.keyedBuf.length === w * h ? node.keyedBuf : (node.keyedBuf = new Uint8Array(w * h))) : null;
    const out = bakeSurface(img.ensure(), w, h, bake, tint, inkKey, ink, 0, palette, keyed, duotone);
    node.bakeBuf.set(out.pixels);
    return { pixels: node.bakeBuf, changed: out.changed };
  }

  private tintForChannel(ch: Channel | undefined): number | null {
    // Tint resolution (incl. indexed backColors) lives on the engine —
    // see bgTintForChannel.
    if (!ch) return null;
    return this.engine.bgTintForChannel(ch);
  }

  private duotoneForChannel(ch: Channel | undefined): { fg: number; bg: number } | null {
    // The ink-41 / avatar-colour-effect fg→bg ramp (see
    // Engine.duotoneForChannel). A duotone REPLACES the plain bg tint for the
    // inks that use it.
    if (!ch) return null;
    return this.engine.duotoneForChannel(ch);
  }

  private inkKeyForChannel(ch: { ink?: number; bgColorIsRgb?: boolean; bgColor?: number } | undefined): number | null | undefined {
    // The colour an ink that keys or preserves ONE colour should use, taken from
    // the sprite's own background colour — which the corpus really sets
    // (`tSpr.bgColor = rgb(pPartColors[j])` in Active_Object_Class::solveMembers,
    // and the avatar colour effects' `human_sprite_props/[ink: 8, bgcolor: ...]`).
    //
    //  - ink 7 (Not ghost) keeps the keyed colour and drops everything else;
    //  - ink 36 (Background transparent) keys the sprite's background colour,
    //    WHITE when the movie never set one (Director's Tools-window default —
    //    see the `key` branch of bakeEdgeBackground). Returning null ("no
    //    explicit colour") is what selects that white default.
    //
    // `undefined` means "this ink does not key a single colour" so the blob
    // cache keeps one entry per bake instead of one per channel.
    if (!ch || (ch.ink !== 7 && ch.ink !== 36)) return undefined;
    if (ch.bgColorIsRgb && ch.bgColor !== undefined && ch.bgColor !== 0xffffff) {
      return ch.bgColor;
    }
    return null;
  }

  private drawShape(g: Graphics, s: ShapeDef, fill: number): void {
    const w = Math.max(0, Math.round(s.width));
    const h = Math.max(0, Math.round(s.height));
    const type = s.shapeType.toLowerCase();
    if (type === 'oval' || type === 'ellipse' || type === 'circle') {
      g.ellipse(w / 2, h / 2, w / 2, h / 2);
    } else if (type === 'line') {
      g.moveTo(0, 0).lineTo(w, h);
    } else {
      g.rect(0, 0, w, h);
    }
    if (s.filled) g.fill(fill);
    if (!s.outlineInvisible && s.lineThickness > 0) g.stroke({ width: Math.max(1, s.lineThickness), color: fill });
  }

  private applyTransform(channel: number): void {
    const node = this.nodes.get(channel);
    const ch = this.engine.getChannel(channel);
    this.syncBgFill(channel);
    const v = node?.visual;
    if (!v || !ch) return;
    if (ch.member && (ch.member.regX !== node.regX || ch.member.regY !== node.regY)) {
      node.regX = ch.member.regX;
      node.regY = ch.member.regY;
    }
    v.pivot.set(node.regX, node.regY);
    v.x = ch.locH;
    v.y = ch.locV;
    const { flipX, mirrored } = directorTransformFlip(ch.rotation || 0, ch.skew || 0, ch.flipH);
    const rot = mirrored ? 0 : ch.rotation || 0;
    const skew = mirrored ? 0 : ch.skew || 0;
    v.rotation = rot * (Math.PI / 180);
    v.skew.set(skew * (Math.PI / 180), 0);
    const flipY = ch.flipV === 1 ? -1 : 1;
    const s = Math.max(0.0001, ch.scale || 1);
    const baseW = node.baseW && node.baseW > 0 ? node.baseW : 0;
    const baseH = node.baseH && node.baseH > 0 ? node.baseH : 0;
    const sx = (baseW && ch.width ? ch.width / baseW : 1) * flipX * s;
    const sy = (baseH && ch.height ? ch.height / baseH : 1) * flipY * s;
    v.scale.set(sx, sy);
    if (node.bgFill) {
      node.bgFill.pivot.set(node.regX, node.regY);
      node.bgFill.x = v.x;
      node.bgFill.y = v.y;
      node.bgFill.rotation = v.rotation;
      node.bgFill.scale.set(sx, sy);
      node.bgFill.visible = ch.visible === 1;
      node.bgFill.alpha = Math.max(0, Math.min(1, ch.blend / 100));
    }
  }

   private syncBgFill(channel: number): void {
     const node = this.nodes.get(channel);
     const ch = this.engine.getChannel(channel);
     const remove = (): void => {
       if (node?.bgFill) {
         node.bgFill.destroy({ context: true, texture: true, textureSource: true });
         node.bgFill = undefined;
       }
     };
     if (!node || !node.visual || !node.imgLImage || !ch || !ch.bgColorIsRgb || ch.bgColor == null) return remove();
    if (ch.bgColor === 0xffffff) return remove();
    const ink = ch.ink ?? 0;
    if (ink === 1 || ink === 8 || ink === 36) return remove();
    const img = node.imgLImage;
    const buf = img && img.data ? img.data : null;
    if (node.bgFillScanBuf !== buf || node.bgFillScanDirty !== !!img?.dirty) {
      node.bgFillScanBuf = buf;
      node.bgFillScanDirty = !!img?.dirty;
      node.bgFillTransparent = buf ? fullyTransparent(buf) : true;
    }
    if (!node.bgFillTransparent) return remove();
    const w = node.baseW && node.baseW > 0 ? Math.round(node.baseW) : 1;
    const h = node.baseH && node.baseH > 0 ? Math.round(node.baseH) : 1;
    if (!node.bgFill) node.bgFill = new Graphics();
    node.bgFill.clear().rect(0, 0, w, h).fill(ch.bgColor);
    if (node.bgFill.parent !== node.container) node.container.addChildAt(node.bgFill, 0);
  }

  private syncStageImage(): void {
    const img = this.engine.stageImage();
    const w = img.width;
    const h = img.height;
    if (!img.dirty) return;
    const buf = img.ensure();
    if (!this.stageTexture || this.stageImg !== img || this.stageSprite?.width !== w || this.stageSprite?.height !== h || this.stageBuf !== buf) {
      this.stageImg = img;
      this.stageBuf = buf;
      const source = new BufferImageSource({
        resource: buf,
        width: w,
        height: h,
        format: 'rgba8unorm',
        scaleMode: 'nearest',
      });
      // Destroy the old texture before replacing it; stageSprite.destroy() with
      // no options does not free the texture source.
      const oldStageTex = this.stageTexture;
      this.stageTexture = new Texture({ source });
      if (this.stageSprite) this.stageSprite.destroy();
      oldStageTex?.destroy(true);
      this.stageSprite = new Sprite(this.stageTexture);
      this.stageSprite.eventMode = 'none';
      this.app.stage.addChildAt(this.stageSprite, 1);
    } else {
      this.stageTexture.source.update();
    }
    img.dirty = false;
  }

  captureStage(): Uint8Array | null {
    if (!this.app?.renderer || !this.app.stage) return null;
    try {
      const screen = this.app.screen;
      const out = this.app.renderer.extract.pixels({
        target: this.app.stage,
        frame: new Rectangle(screen.x, screen.y, screen.width, screen.height),
      });
      const px = ArrayBuffer.isView(out) ? out : out && out.pixels;
      if (!px) return null;
      const buf = px as unknown as Uint8Array | Uint8ClampedArray;
      if (!buf.length) return null;
      return buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  setBackground(color: number): void {
    if (this.app?.renderer) this.app.renderer.background.color = color;
    this.background?.clear().rect(0, 0, this.engine.stageWidth, this.engine.stageHeight).fill(color);
  }

  resize(width: number, height: number): void {
    if (!this.app?.renderer) return;
    this.app.renderer.resize(width, height);
    this.app.stage.hitArea = this.app.screen;
    this.background?.clear().rect(0, 0, width, height).fill(this.engine.stageBackground);
    this.stageImg = null;
    this.stageBuf = null;
  }

  setChannel(channel: number, visual: ChannelVisual | null): void {
    let node = this.nodes.get(channel);
    if (!node && !visual) {
      // Nothing is drawn on this channel and nothing ever was: clearing it is
      // a no-op. Creating a node just to hide it kept it in the map forever, so
      // the dev overlay's node count only ever grew (spam-opening the navigator).
      this._blendFilterChannels.delete(channel);
      return;
    }
    if (!node) {
      node = { container: new Container(), visual: null, regX: 0, regY: 0 };
      this.layer.addChild(node.container);
      this.nodes.set(channel, node);
    }
    // Save the existing source/texture before cleanup so we can
    // reuse them when the same image is being re-set (e.g. static
    // landscape backgrounds that don't change between frames). The bake mode
    // and pixel buffer are captured too: the cleanup below clears them, and a
    // reuse test that read the cleared values could never be true.
    const oldImgSource = node.imgSource;
    const oldImgTexture = node.imgTexture;
    const oldImgLImage = node.imgLImage;
    const oldImgBuffer = node.imgBuffer;
    const oldBakeMode = node.bakeMode;
    if (node.visual) {
      node.visual.destroy({ children: true });
      node.visual = null;
    }
    this.releaseBlob(node.blobEntry);
    node.blobEntry = undefined;
    node.imgLImage = undefined;
    node.imgBuffer = undefined;
    node.hitBufW = undefined;
    node.hitBufH = undefined;
    // NOTE: node.imgTexture is NOT destroyed yet — kept alive as
    // oldImgTexture so the visual.image branch can reuse it when the
    // same LImage is re-set (avoids GPU churn for static landscapes).
    // It is destroyed in each branch below if reuse is not possible.
    node.bakeMode = undefined;
    node.bakeBuf = undefined;
    node.baseW = undefined;
    node.baseH = undefined;
    node.hitW = undefined;
    node.hitH = undefined;
    node.shape = undefined;
    node.textObj = undefined;
    node.caret = undefined;
    node.caretX = undefined;
    node.caretY = undefined;
    node.caretH = undefined;
     if (node.bgFill) {
       node.bgFill.destroy({ context: true, texture: true, textureSource: true });
       node.bgFill = undefined;
     }
    node.bgFillScanBuf = undefined;
    node.bgFillScanDirty = undefined;
    node.bgFillTransparent = undefined;
    node.regX = visual?.regX ?? 0;
    node.regY = visual?.regY ?? 0;
    node.container.visible = true;

    if (!visual) {
      node.container.visible = false;
      this._blendFilterChannels.delete(channel);
      oldImgTexture?.destroy(true);
      node.imgTexture = undefined;
      node.imgSource = undefined;
      // Reclaim the node: no visual is drawn on this channel any more, so its
      // Container and bookkeeping are freed and the dev overlay's node count
      // tracks the sprites actually on the stage instead of every channel ever
      // used. A later setChannel re-creates the node.
      this.nodes.delete(channel);
      node.container.destroy({ children: true });
      return;
    }
    if (visual.kind === 'text') {
      const w = Math.max(1, Math.round(visual.width ?? 1));
      const h = Math.max(1, Math.round(visual.height ?? 1));
      const size = Math.max(1, Math.round(visual.fontSize ?? 12));
      const group = new Container();
      const ink = visual.ink ?? 0;
      const bg = ink === 1 || ink === 3 || ink === 8 || ink === 36 ? null : visual.bgColor;
      if (bg) {
        group.addChild(new Graphics().rect(0, 0, w, h).fill(bg));
      }
      const align =
        visual.alignment === 'center' || visual.alignment === 'right' || visual.alignment === 'justify'
          ? visual.alignment
          : 'left';
      const weight = visual.fontWeight === '700' || visual.fontWeight === 'bold' ? '700' : '400';
      const text = new Text({
        text: visual.text ?? '',
        style: {
          fill: visual.color ?? 0xffffff,
          fontFamily: `${visual.fontFamily ?? 'Arial'}, Arial, sans-serif`,
          fontWeight: weight,
          fontStyle: visual.fontStyle === 'italic' ? 'italic' : 'normal',
          fontSize: size,
          align,
          wordWrap: visual.wordWrap === true,
          wordWrapWidth: w,
        },
      });
      group.addChild(text);
      if (visual.clipToBox) {
        const clip = new Graphics().rect(0, 0, w, h).fill(0xffffff);
        group.addChild(clip);
        group.mask = clip;
      }
      node.textObj = text;
      node.caretColor = visual.color ?? 0xffffff;
      node.visual = group;
      node.baseW = w;
      node.baseH = h;
      node.hitW = w;
      node.hitH = h;
      node.container.addChild(group);
      oldImgTexture?.destroy(true);
      node.imgTexture = undefined;
    } else if (visual.image) {
      const img = visual.image;
      const w = Math.round(img.width);
      const h = Math.round(img.height);
      const ch = this.engine.getChannel(channel);
      const bake = this.bakeForChannel(ch, img, w, h);
      const tint = this.tintForChannel(ch);
      const duotone = this.duotoneForChannel(ch);
      const baked = bake || tint || duotone ? this.bakeImagePixels(node, img, w, h, bake, tint, this.inkKeyForChannel(ch), ch.ink ?? 0, ch.member?.palette, duotone) : null;
      const pixels = baked && baked.changed ? baked.pixels : img.ensure();
      const finalBake = baked && baked.changed ? bake : null;
      // Reuse the existing texture when the same image, size, and
      // bake/tint/duotone parameters are in play — avoids allocating a new
      // Texture + BufferImageSource for a static landscape on every rebuild.
      const canReuse = oldImgLImage === img
        && oldImgSource !== undefined && oldImgSource.width === w && oldImgSource.height === h
        && oldBakeMode === finalBake
        && oldImgBuffer === pixels;
      node.imgLImage = img;
      img.dirty = false;
      if (w >= 1 && h >= 1) {
        if (canReuse && oldImgSource && oldImgTexture) {
          // The texture still holds the right source; the visual was destroyed
          // by the cleanup above, so a fresh Sprite reattaches it. Re-upload
          // the pixels because the image may have been repainted in place.
          node.imgSource = oldImgSource;
          node.imgTexture = oldImgTexture;
          node.visual = new Sprite(oldImgTexture);
          node.container.addChild(node.visual);
          oldImgSource.update();
         } else {
           oldImgTexture?.destroy(true);
           node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
           node.imgTexture = new Texture({ source: node.imgSource });
           const sprite = new Sprite(node.imgTexture);
           node.baseW = w;
           node.baseH = h;
           node.visual = sprite;
           node.container.addChild(sprite);
         }
        node.bakeMode = finalBake;
        node.imgBuffer = pixels;
        node.hitBufW = w;
        node.hitBufH = h;
      }
      this.applyTransform(channel);
     } else if (visual.shape) {
       node.shape = visual.shape;
       node.baseW = Math.max(1, Math.round(visual.shape.width));
       node.baseH = Math.max(1, Math.round(visual.shape.height));
       const g = new Graphics();
       node.visual = g;
       node.container.addChild(g);
       oldImgTexture?.destroy(true);
       node.imgTexture = undefined;
     } else if (visual.bytes) {
      const ch = this.engine.getChannel(channel);
      if (ch.ink === 9 && visual.maskBytes) {
        // This path (and the tint path below) creates a node-owned texture, so
        // the pre-existing one is freed here and node.imgTexture keeps the new
        // one. Nulling node.imgTexture at the end of the branch orphaned it —
        // the sprite still referenced it, but the next rebuild had an
        // undefined oldImgTexture and could never destroy it (textures climbed
        // and never fell).
        oldImgTexture?.destroy(true);
        const offX = (visual.maskRegX ?? 0) - (visual.regX ?? 0);
        const offY = (visual.maskRegY ?? 0) - (visual.regY ?? 0);
        let width = 0;
        let height = 0;
        let rgba: Uint8ClampedArray | null = null;
        let maskDec: { width: number; height: number; rgba: Uint8ClampedArray } | null = null;
        try {
          const dec = decodeImage(visual.bytes, ch.member?.palette);
          width = dec.width;
          height = dec.height;
          rgba = new Uint8ClampedArray(dec.rgba);
          const md = decodeImage(visual.maskBytes, ch.member?.palette);
          maskDec = { width: md.width, height: md.height, rgba: new Uint8ClampedArray(md.rgba) };
          applyMaskAlpha(rgba, width, height, maskDec.rgba, maskDec.width, maskDec.height, offX, offY);
        } catch (e) {
          this.engine.warn(`bitmap decode failed (ink9 mask): ${e instanceof Error ? e.message : String(e)}`);
          rgba = null;
        }
        if (!rgba || width < 1 || height < 1) {
          node.imgSource = new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1, format: 'rgba8unorm', scaleMode: 'nearest' });
          node.imgTexture = new Texture({ source: node.imgSource });
          const sprite = new Sprite(node.imgTexture);
          node.baseW = Math.max(1, width);
          node.baseH = Math.max(1, height);
          node.visual = sprite;
          node.container.addChild(sprite);
        } else {
          node.imgSource = new BufferImageSource({ resource: rgba, width, height, format: 'rgba8unorm', scaleMode: 'nearest' });
          node.imgTexture = new Texture({ source: node.imgSource });
          const sprite = new Sprite(node.imgTexture);
          node.baseW = width;
          node.baseH = height;
          node.visual = sprite;
          node.container.addChild(sprite);
          // Masked pixels (alpha 0) are click-through too.
          node.imgBuffer = rgba;
          node.hitBufW = width;
          node.hitBufH = height;
        }
      } else {
        // Film-loop frames are full-bleed opaque strips (water animation): no
        // single palette-0 background to matte-key, and the flood would eat the
        // frame's interior highlight bands (alternating rows touch the edges).
        const bake: BakeMode | null = ch.member?.kind === 'filmloop' ? null : bakeModeForInk(ch.ink);
        const inkKey = this.inkKeyForChannel(ch);
        const tint = this.tintForChannel(ch);
        // fg→bg duotone (ink 41's `sprite.color`+backColor, and the avatar
        // colour effects' ink 8 + RGB foreColor) — see Engine.duotoneForChannel.
        const duotone = this.duotoneForChannel(ch);
        if (tint !== null || duotone !== null) {
          oldImgTexture?.destroy(true);
          let width = 0;
          let height = 0;
          let rgba: Uint8ClampedArray | null = null;
          try {
            const dec = decodeImage(visual.bytes, ch.member?.palette);
            width = dec.width;
            height = dec.height;
            rgba = new Uint8ClampedArray(dec.rgba);
            if (visual.remapPalette) PixiStage.remapPixels(rgba, dec.indices, ch.member?.palette, visual.remapPalette);
            // Ink 39's identity rectangle stays OPAQUE white, so it is not filtered
            // out by the tint pass' alpha test and has to be masked off explicitly
            // (see matte.bakeEdgeBackground / tintSpriteBackground).
            const keyed = bake === 'matteIdentity' && width > 0 && height > 0 ? new Uint8Array(width * height) : null;
            if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, ch.member?.palette, dec.indices, inkKey, keyed);
            if (duotone) tintSpriteDarken(rgba, width, height, duotone.bg, duotone.fg);
            else if (tint !== null) {
              if (ch.ink === 41) tintSpriteDarken(rgba, width, height, tint, ch.colorSet ? ch.color : 0);
              else tintSpriteBackground(rgba, width, height, tint, keyed);
            }
          } catch (e) {
            this.engine.warn(`bitmap decode failed (tint): ${e instanceof Error ? e.message : String(e)}`);
            rgba = null;
          }
          if (!rgba || width < 1 || height < 1) {
            node.imgSource = new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1, format: 'rgba8unorm', scaleMode: 'nearest' });
            node.imgTexture = new Texture({ source: node.imgSource });
            const sprite = new Sprite(node.imgTexture);
            node.baseW = Math.max(1, width);
            node.baseH = Math.max(1, height);
            node.visual = sprite;
            node.container.addChild(sprite);
          } else {
            node.imgSource = new BufferImageSource({ resource: rgba, width, height, format: 'rgba8unorm', scaleMode: 'nearest' });
            node.imgTexture = new Texture({ source: node.imgSource });
            const sprite = new Sprite(node.imgTexture);
            node.baseW = width;
            node.baseH = height;
            node.visual = sprite;
            node.container.addChild(sprite);
            node.imgBuffer = rgba;
            node.hitBufW = width;
            node.hitBufH = height;
          }
        } else {
          // The blob cache owns this texture; the node owns none.
          oldImgTexture?.destroy(true);
          node.imgTexture = undefined;
          node.imgSource = undefined;
          const entry = this.acquireBlob(visual.bytes, bake, ch.member?.palette, visual.remapPalette, inkKey);
          node.blobEntry = entry;
          const sprite = new Sprite(entry.texture);
          node.baseW = entry.width;
          node.baseH = entry.height;
          node.visual = sprite;
          node.container.addChild(sprite);
          // Raw cast bytes (walls, tiles, furniture, film-loop frames): the
          // baked RGBA the texture came from is the sprite's displayed portion.
           node.imgBuffer = entry.rgba;
           node.hitBufW = entry.width;
           node.hitBufH = entry.height;
         }
       }
     }
     this.refreshChannel(channel);
   }

  private static paletteKey(palette: number[][] | undefined): string {
    if (!palette || palette.length === 0) return 'none';
    return 'pal:' + palette.length + ':' + palette.map((p) => p.join(',')).join(';');
  }

  private static remapPixels(
    rgba: Uint8Array | Uint8ClampedArray,
    indices: Uint8Array | undefined,
    source: number[][] | undefined,
    target: number[][],
  ): void {
    if (!target || target.length < 2) return;
    const n = Math.floor(rgba.length / 4);
    if (indices) {
      for (let i = 0; i < n; i++) {
        const idx = indices[i];
        if (idx < target.length) {
          const o = i * 4;
          rgba[o] = target[idx][0];
          rgba[o + 1] = target[idx][1];
          rgba[o + 2] = target[idx][2];
        }
      }
      return;
    }
    if (!source || source.length < 2) return;
    const lut = new Map<string, number>();
    for (let i = 0; i < source.length; i++) {
      const k = `${source[i][0]},${source[i][1]},${source[i][2]}`;
      if (!lut.has(k)) lut.set(k, i);
    }
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const idx = lut.get(`${rgba[o]},${rgba[o + 1]},${rgba[o + 2]}`);
      if (idx !== undefined && idx < target.length) {
        rgba[o] = target[idx][0];
        rgba[o + 1] = target[idx][1];
        rgba[o + 2] = target[idx][2];
      }
    }
  }

  private acquireBlob(bytes: Uint8Array, bake: BakeMode | null, palette?: number[][], remap?: number[][], inkKey?: number | null): BlobEntry {
    const keyColor = inkKey !== undefined ? 'k' + (inkKey ?? 'auto') : 'nk';
    const key = (bake ?? 'none') + '|' + PixiStage.paletteKey(palette) + '|' + PixiStage.paletteKey(remap) + '|' + keyColor;
    let byBake = this.blobCache.get(bytes);
    if (!byBake) {
      byBake = new Map();
      this.blobCache.set(bytes, byBake);
    }
    let entry = byBake.get(key);
    if (!entry) {
      while (this.freeBlobs.length >= PixiStage.BLOB_CACHE_CAP) {
        this.dropBlob(this.freeBlobs.shift()!);
      }
      let width = 0;
      let height = 0;
      let rgba: Uint8Array | null = null;
      try {
        const dec = decodeImage(bytes, palette);
        width = dec.width;
        height = dec.height;
        rgba = new Uint8Array(dec.rgba);
        if (remap) PixiStage.remapPixels(rgba, dec.indices, palette, remap);
        if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, palette, dec.indices, inkKey);
      } catch (e) {
        this.engine.warn(`bitmap decode failed: ${e instanceof Error ? e.message : String(e)}`);
        rgba = null;
      }
      let texture: Texture;
      if (!rgba || width < 1 || height < 1) {
        texture = new Texture({
          source: new BufferImageSource({ resource: new Uint8Array(4), width: 1, height: 1, format: 'rgba8unorm', scaleMode: 'nearest' }),
        });
        width = Math.max(1, width);
        height = Math.max(1, height);
      } else {
        texture = new Texture({
          source: new BufferImageSource({ resource: rgba, width, height, format: 'rgba8unorm', scaleMode: 'nearest' }),
        });
      }
      entry = { bytes, bake, key, refs: 0, width, height, texture, rgba };
      byBake.set(key, entry);
    } else {
      this.unfreeBlob(entry);
    }
    entry.refs++;
    return entry;
  }

  private releaseBlob(entry: BlobEntry | undefined): void {
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    if (!this.freeBlobs.includes(entry)) this.freeBlobs.push(entry);
  }

  private unfreeBlob(entry: BlobEntry): void {
    const i = this.freeBlobs.indexOf(entry);
    if (i >= 0) this.freeBlobs.splice(i, 1);
  }

  private dropBlob(entry: BlobEntry): void {
    try { entry.texture.destroy(true); } catch { }
    const byBake = this.blobCache.get(entry.bytes);
    if (byBake) { byBake.delete(entry.key); if (byBake.size === 0) this.blobCache.delete(entry.bytes); }
    entry.rgba = null;
    entry.bytes = new Uint8Array(0);
  }

  debugDump(): object[] {
    const out: object[] = [];
    for (const [channel, node] of this.nodes) {
      const ch = this.engine.getChannel(channel);
      const img = node.imgLImage;
      let imgTransparent: boolean | null = null;
      if (img?.data) {
        imgTransparent = true;
        const d = img.data;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] !== 0) { imgTransparent = false; break; }
        }
      }
      out.push({
        channel,
        visible: node.container.visible,
        locZ: ch.locZ,
        member: ch.member?.name ?? null,
        kind: ch.member?.kind ?? null,
        ink: ch.ink,
        blend: ch.blend,
        bgColor: '#' + (ch.bgColor >>> 0).toString(16).padStart(6, '0'),
        bgColorIsRgb: ch.bgColorIsRgb,
        visual: node.visual ? node.visual.constructor.name : null,
        vw: node.visual ? Math.round(node.visual.width) : null,
        vh: node.visual ? Math.round(node.visual.height) : null,
        alpha: node.visual ? node.visual.alpha : null,
        img: img ? img.width + 'x' + img.height : null,
        imgTransparent,
        bgFill: node.bgFill
          ? {
            w: Math.round(node.bgFill.width),
            h: Math.round(node.bgFill.height),
            scaleX: +node.bgFill.scale.x.toFixed(2),
            scaleY: +node.bgFill.scale.y.toFixed(2),
            visible: node.bgFill.visible,
          }
          : null,
      });
    }
    return out.sort((a, b) => (b as { locZ: number }).locZ - (a as { locZ: number }).locZ);
  }

  refreshChannel(channel: number): void {
    const node = this.nodes.get(channel);
    const ch = this.engine.getChannel(channel);
    if (!node) return;
    const visible = ch.visible === 1 && node.visual !== null;
    node.container.visible = visible;
    if (!node.visual) return;
    node.visual.visible = ch.visible === 1;
    node.visual.alpha = Math.max(0, Math.min(1, ch.blend / 100));
    const mode = blendModeForInk(ch.ink);
    node.visual.blendMode = mode as unknown as (typeof node.visual)['blendMode'];
    if (blendFilterMode(mode)) this._blendFilterChannels.add(channel); else this._blendFilterChannels.delete(channel);
    node.container.zIndex = ch.locZ;
    if (node.shape && node.visual instanceof Graphics) {
      node.visual.clear();
      this.drawShape(node.visual, node.shape, ch.colorSet ? ch.color : (node.shape.color ?? 0xffffff));
    }
    this.applyTransform(channel);
  }

  private pointer(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): void {
    x = Math.trunc(x);
    y = Math.trunc(y);
    const channel = type === 'mouseMove' ? this.hitTest(x, y) : this.hitTest(x, y, { onlyScripted: true });
    if (type !== 'mouseMove' && pointerDebug()) {
      const raw = this.hitTest(x, y);
      const desc = (c: number): string => {
        if (c <= 0) return '0';
        const ch = this.engine.getChannel(c);
        const list = ch.scriptInstanceList;
        const items = list && typeof (list as { items?: unknown[] }).items !== 'undefined'
          ? (list as { items: unknown[] }).items
          : [];
        const names = items
          .map((i) => ((i as { script?: { name?: string } } | undefined)?.script?.name ?? '?'))
          .join('+');
        return `${c} mem="${ch.member?.name ?? ch.member?.number ?? '-'}" behaviors=${items.length} scripts=${names || '-'}`;
      };
      this.engine.log(`click: ${type} (${x},${y}) scripted=${desc(channel)} raw=${desc(raw)}`);
      if (type === 'mouseDown') {
        try {
          const ui = this.engine.interp.evalExpressionString('getObject(#session).GET("user_index")');
          const own = this.engine.interp.evalExpressionString('getThread(#room).getComponent().getOwnUser()');
          const uc = this.engine.interp.evalExpressionString('getThread(#room).getComponent().pUserObjList.count');
          const act = this.engine.interp.evalExpressionString('getThread(#room).getComponent().pActiveFlag');
          const lc = this.engine.interp.evalExpressionString('getObject(#session).GET("client_lastclick")');
          this.engine.log(`room: user_index=${String(ui)} ownUser=${String(own)} userObjCount=${String(uc)} active=${String(act)} lastClick=${String(lc)}`);
        } catch (e) {
          this.engine.log(`room: gate probe error: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
          const ch2 = this.engine.getChannel(channel);
          const parts: string[] = [`chId=${String(ch2.id)}`];
          const sil = ch2.scriptInstanceList;
          const items = sil instanceof LList ? sil.items : [];
          for (const inst of items) {
            if (!(inst instanceof LObject)) continue;
            const id = inst.props.get('id');
            const sn = inst.props.get('spriteNum');
            const ppl = inst.props.get('pProcList');
            const keys = ppl instanceof LPropList ? Array.from(ppl.props.keys()).join(',') : 'none';
            const md =
              ppl instanceof LPropList
                ? (ppl.props.get('#mouseDown') ?? ppl.props.get('mouseDown'))
                : null;
            const mdDesc =
              md instanceof LList && md.items.length >= 2
                ? `${md.items[0] instanceof LSymbol ? '#' + md.items[0].name : String(md.items[0])} -> ${String(md.items[1])}`
                : 'none';
            parts.push(`instId=${id instanceof LSymbol ? '#' + id.name : String(id)} sprNum=${String(sn)} keys=[${keys}] proc=[${mdDesc}]`);
          }
          const sl = this.engine.interp.evalExpressionString('getObject("Room_visualizer").getProperty(#spriteList)');
          const slChans =
            sl instanceof LList ? sl.items.map((i) => (i instanceof LSpriteRef ? String(i.channel) : '?')).join(',') : String(sl);
          this.engine.log(`room: ${parts.join(' ')} sprList=[${slChans}]`);
        } catch (e) {
          this.engine.log(`room: inst probe error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.engine.dispatchPointerEvent(type, channel, x, y);
    if (type === 'mouseDown' && channel > 0 && pointerDebug()) {
      try {
        const lc2 = this.engine.interp.evalExpressionString('getObject(#session).GET("client_lastclick")');
        this.engine.log(`room: afterDispatch lastClick=${String(lc2)}`);
      } catch {
      }
    }
  }

  /** Unbind the pointer listeners and destroy all GPU resources. */
  dispose(): void {
    this.pointerCleanup?.();
    this.pointerCleanup = null;
    // Destroy every node's texture, sprite, and background fill.
    for (const [, node] of this.nodes) {
      if (node.blobEntry) {
        try { node.blobEntry.texture.destroy(true); } catch { }
        node.blobEntry = undefined;
      }
      node.imgTexture?.destroy(true);
      node.imgTexture = undefined;
      node.imgSource = undefined;
      node.imgBuffer = undefined;
      node.imgLImage = undefined;
      if (node.visual) {
        node.visual.destroy({ children: true });
        node.visual = null;
      }
      if (node.bgFill) {
        node.bgFill.destroy({ context: true, texture: true, textureSource: true });
        node.bgFill = undefined;
      }
      node.caret?.destroy({ context: true, texture: true, textureSource: true });
      node.caret = undefined;
      node.textObj = undefined;
      node.container.removeChildren();
    }
    // Drop all cached blob textures (GPU-side) and free the entries.
    for (const entry of this.freeBlobs) {
      try { entry.texture.destroy(true); } catch { }
      entry.rgba = null;
      entry.bytes = new Uint8Array(0);
    }
    this.freeBlobs.length = 0;
    this.blobCache.clear();
    // Destroy the stage texture.
    if (this.stageTexture) {
      this.stageTexture.destroy(true);
      this.stageTexture = null;
    }
    if (this.stageSprite) {
      this.stageSprite.destroy();
      this.stageSprite = null;
    }
    // Destroy the pixi application (and its renderer/WebGL context).
    try {
      this.app.destroy(false, { children: true, texture: true });
    } catch {
    }
  }

  /** `StageAdapter.pointerSpriteAt` — the engine's `the rollover` / `the clickOn`
   *  are this exact answer, so they can never disagree with the channel the
   *  pointer event was routed to. */
  pointerSpriteAt(x: number, y: number): number {
    return this.hitTest(Math.trunc(x), Math.trunc(y));
  }

  private hitTest(x: number, y: number, opts?: { onlyScripted?: boolean }): number {
    const hits: { channel: number; z: number; node: ChannelNode; w: number; h: number }[] = [];
    for (const [channel, node] of this.nodes) {
      const ch = this.engine.getChannel(channel);
      if (!node.container.visible || ch.visible !== 1 || !node.visual) continue;
      if (opts?.onlyScripted && !ch.isPointerTarget(true)) continue;
      const w = node.hitW ?? node.visual.width;
      const h = node.hitH ?? node.visual.height;
      const left = ch.locH - node.regX;
      const top = ch.locV - node.regY;
      const { tx, ty } = this.inverseTransformPoint(ch, x, y);
      if (tx < left || tx > left + w || ty < top || ty > top + h) continue;
      hits.push({ channel, z: ch.locZ, node, w, h });
    }
    let scriptedFallback = 0;
    hits.sort((a, b) => (b.z - a.z) || (b.channel - a.channel));
    for (const hit of hits) {
      const ch = this.engine.getChannel(hit.channel);
      if (scriptedFallback === 0 && ch.isPointerTarget(true)) scriptedFallback = hit.channel;
      const left = ch.locH - hit.node.regX;
      const top = ch.locV - hit.node.regY;
      const sw = hit.node.imgSource?.width ?? hit.node.hitBufW ?? hit.w;
      const sh = hit.node.imgSource?.height ?? hit.node.hitBufH ?? hit.h;
      const { tx, ty } = this.inverseTransformPoint(ch, x, y);
      const px = Math.round((tx - left) * (sw / Math.max(1, hit.w)));
      const py = Math.round((ty - top) * (sh / Math.max(1, hit.h)));
      // The sprite owns the click only where it renders something: the pixels
      // it displays are its active area (see spritePixelHitTest), so the pixels
      // an ink/alpha keyed away belong to the sprite underneath — the chair that
      // carries a sitter no longer eats the click aimed at the avatar.
      if (spritePixelHitTest(hit.node.imgBuffer, sw, sh, px, py)) return hit.channel;
    }
    // NOTHING renders at the point (every candidate's pixel there is transparent,
    // or the pixel could not be sampled). A scripted sprite still owns it by its
    // rectangle: the Object Mover's ghost follows the cursor and carries its
    // `#mouseDown` proc ON the sprite, so clicking a see-through part of the
    // furniture art (a lamp shade, the gap in a rug) has to reach it or placing
    // silently does nothing — and the room's ink-36 click cover expects to
    // receive the event so `validateEvent` can hide it and re-dispatch below.
    // A sprite with no script does NOT get this: a transparent hole in plain
    // scenery stays click-through to the stage (0).
    return scriptedFallback;
  }

  private inverseTransformPoint(ch: Channel, x: number, y: number): { tx: number; ty: number } {
    return inverseDirectorTransformPoint(ch.rotation || 0, ch.skew || 0, ch.flipH, ch.flipV, ch.locH, ch.locV, x, y);
  }
}

export { LPoint };
