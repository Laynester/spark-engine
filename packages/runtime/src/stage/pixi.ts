import { Application, BufferImageSource, Container, Graphics, Rectangle, Sprite, Text, Texture, type BLEND_MODES } from 'pixi.js';
// pixi v8 ships LIGHTEST/LIGHTEN/DARKEST/SUBTRACT etc. as *advanced* blend
// modes that only exist after this side-effect import registers them (the
// package's exports map this path to advanced-blend-modes/init.mjs, which
// extensions.add()s every mode). Without it, `blendMode = 'lighten'` silently
// falls back to normal compositing — the messenger console scrollbar's
// ink-37 (LIGHTEST) black track rendered opaque over the grey console bg
// instead of max-blending into it (i.e. looking transparent).
import 'pixi.js/advanced-blend-modes';
import { alignmentName, type ChannelVisual, type DirectorEngine, type StageAdapter } from '../engine/engine.js';
import type { Channel } from '../engine/sprites.js';
import { LImage, LList, LObject, LPoint, LPropList, LSpriteRef, LSymbol } from '../lingo/values.js';
import type { ShapeDef } from '../engine/members.js';
import { applyMaskAlpha, bakeEdgeBackground, bakeModeForInk, blendModeForInk, cornersAreNearWhite, matteSpriteHitTest, tintSpriteBackground, type BakeMode } from './matte.js';
import { caretBlinkOn, caretX } from './caret.js';
import { decodePng } from '../engine/png.js';

// Debug aid: per-channel record of which member's texture is uploaded, so a
// wrong-cast render is visible in the console. Gated so fast frame swaps
// (flag/cloud animations) don't flood it.

interface ChannelNode {
  container: Container;
  visual: Sprite | Text | Graphics | Container | null;
  regX: number;
  regY: number;
  // Shared decoded-texture entry for this channel's raw bitmap (reused across
  // rebuilds instead of minting a new blob each time).
  blobEntry?: BlobEntry;
  // Runtime-painted surface for `kind: 'image'` channel visuals.
  imgLImage?: LImage;
  imgTexture?: Texture;
  imgSource?: BufferImageSource;
  // The exact buffer the current imgSource was created with. A buffer IDENTITY
  // change forces a source recreate — resize() nulls data, so the next
  // ensure() returns a NEW array while the source still points at the old one
  // (a stale update showed pre-reset art after a cloud reset).
  imgBuffer?: Uint8Array | Uint8ClampedArray | null;
  // Reusable scratch for ink-baking a runtime surface before upload (per-node
  // so two baked channels can't clobber each other's texture source).
  bakeBuf?: Uint8ClampedArray;
  // Bake mode the current imgSource was created with (null = raw) — an ink
  // change must recreate the source or update() re-reads stale baked bytes.
  bakeMode?: BakeMode | null;
  // Natural (untransformed) content size, used for width/height stretch.
  baseW?: number;
  baseH?: number;
  // Shape definition for `kind: 'shape'` visuals (re-drawn on color changes).
  shape?: ShapeDef;
  // The pixi Text inside the text group — the caret anchors to its rendered
  // width.
  textObj?: Text;
  // Blinking text-editing caret (the corpus never draws one): visible while
  // this channel holds the keyboardFocusSprite and its member is editable.
  caret?: Graphics;
  // Caret fill + last drawn geometry — only re-rasterized when the insertion
  // point moves.
  caretColor?: number | string;
  caretX?: number;
  caretY?: number;
  caretH?: number;
  // Explicit hit box for text nodes (bounds collapse to glyphs when text is
  // empty and the bg fill is skipped).
  hitW?: number;
  hitH?: number;
  // Sprite bgColor fill behind an element-buffer sprite (colour swatches,
  // unfed Image Wrappers): Director composites bgColor through transparent
  // pixels, so a never-painted buffer shows the fill. A sibling behind the
  // sprite, transformed identically.
  bgFill?: Graphics;
  // Buffer identity + dirty state the bgFillTransparent scan ran against.
  bgFillScanBuf?: Uint8Array | null;
  bgFillScanDirty?: boolean;
  // Cached: the element buffer is FULLY transparent (nothing hides the fill) —
  // only such surfaces get a fill, so painted buffers never gain a backdrop.
  bgFillTransparent?: boolean;
}

// One decoded texture shared by every channel showing the same raw bytes with
// the same bake mode. Decoded with our pure-JS decoder (nothing in the
// network tab) and baked synchronously. Refcounted, but released entries stay
// cached (LRU-capped) so member-swap animations reuse frames; only capacity
// eviction destroys the texture.
interface BlobEntry {
  bytes: Uint8Array;
  bake: BakeMode | null;
  // Full cache key (bake + palette fingerprint) — dropBlob deletes by it.
  key: string;
  refs: number;
  width: number;
  height: number;
  texture: Texture;
}

// True when the RGBA buffer has no opaque pixel (alpha 0 everywhere) — a
// fully-transparent surface shows the sprite bgColor fill; any painted pixel
// hides it.
function fullyTransparent(buf: Uint8Array): boolean {
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

// Director sprite transform: rotation 180 + skew 180 is NOT a 180° rotation
// — it's a HORIZONTAL MIRROR (the furniture flip sets both on `*` memberalias
// variants). Pixi would render the pair as a point reflection, so we fold it
// into flipX and render the pair as identity. skew=180 WITHOUT rotation is
// intentionally NOT mirrored — the corpus never uses skew alone. Returns the
// effective horizontal scale (1 or −1) and whether the pair is only a mirror.
export function directorTransformFlip(rotationDeg: number, skewDeg: number, flipH: number): { flipX: number; mirrored: boolean } {
  const norm = (d: number) => ((d % 360) + 360) % 360;
  const mirrored =
    Math.abs(norm(rotationDeg) - 180) < 0.5 && Math.abs(norm(skewDeg) - 180) < 0.5;
  return { flipX: (flipH === 1 ? -1 : 1) * (mirrored ? -1 : 1), mirrored };
}

// Inverse-transform a stage point through a sprite's Director transforms so
// hit tests run in the sprite's UNtransformed space. Rotation pivots at loc
// (matching the render pivot); the mirror + explicit flips fold into axis
// mirrors — identical to the renderer's scale, so the hit region matches the
// drawn bounds exactly.
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
  // Explicit flipH XOR the skew-mirror = the renderer's effective flipX.
  if ((flipH === 1) !== mirrored) tx = 2 * locH - tx;
  if (flipV === 1) ty = 2 * locV - ty;
  return { tx, ty };
}

export class PixiStage implements StageAdapter {
  app!: Application;
  private nodes = new Map<number, ChannelNode>();
  /** Raw bytes (identity) -> bake-mode key -> shared entry. */
  private blobCache = new Map<Uint8Array, Map<string, BlobEntry>>();
  /** Released-but-cached entries, oldest first (LRU eviction order). */
  private freeBlobs: BlobEntry[] = [];
  /** Soft cap: only released (refs=0) entries are evictable, so the cache can
   *  exceed this while many channels hold distinct members — bounded by the
   *  total member count (~4k, a few KB each), which is acceptable. */
  private static readonly BLOB_CACHE_CAP = 256;
  private layer!: Container;
  private background!: Graphics;
  /** Texture backing `(the stage).image` — the Loading Bar (and any window
   *  element buffer) paints into this surface, so it must be uploaded to the
   *  canvas or the painted pixels stay invisible. */
  private stageImg: LImage | null = null;
  /** Buffer the stage texture source was created with (see imgBuffer). */
  private stageBuf: Uint8Array | null = null;
  private stageSprite: Sprite | null = null;
  private stageTexture: Texture | null = null;
  /** Elapsed-time accumulator driving engine.tick() at the movie's tempo. */
  private frameAcc = 0;
  private lastFrameT = 0;

  constructor(
    private engine: DirectorEngine,
    private parent: HTMLElement,
  ) {}

  async init(): Promise<void> {
    const { stageWidth: w, stageHeight: h, stageBackground: bg } = this.engine;
    this.app = new Application();
    // Pixel-art movie: no geometry AA, and bitmaps sample NEAREST so stretched
    // 9-slice pieces stay crisp instead of bilinear-blurry (Text keeps its own
    // smooth canvas textures).
    await this.app.init({ width: w, height: h, background: bg, antialias: false, resolution: 1 });
    this.parent.appendChild(this.app.canvas);

    this.background = new Graphics().rect(0, 0, w, h).fill(bg);
    this.app.stage.addChild(this.background);

    this.layer = new Container();
    this.layer.sortableChildren = true;
    this.app.stage.addChild(this.layer);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointerdown', (e) => this.pointer('mouseDown', e.global.x, e.global.y));
    this.app.stage.on('pointerup', (e) => this.pointer('mouseUp', e.global.x, e.global.y));
    this.app.stage.on('pointermove', (e) => this.pointer('mouseMove', e.global.x, e.global.y));

    this.app.ticker.add(() => {
      this.syncStageImage();
      // Director tempo drives the movie frame rate; the pixi ticker runs at
      // display refresh, so accumulate elapsed time and advance exactly
      // `tempo` frames per second (capped so a tab-away catch-up can't spiral).
      const now = performance.now();
      const dt = this.lastFrameT ? now - this.lastFrameT : 0;
      this.lastFrameT = now;
      const frameMs = 1000 / Math.max(1, this.engine.frameTempo);
      this.frameAcc += dt;
      let steps = 0;
      while (this.frameAcc >= frameMs && steps < 4) {
        this.frameAcc -= frameMs;
        this.engine.tick();
        steps++;
      }
      if (steps === 4) this.frameAcc = 0; // dropped catch-up frames
      this.syncChannelImages();
      this.syncCaret();
    });
  }

  // Blinking 1px text-editing caret for the focused editable field (the corpus
  // never draws one). Re-rasterizes only when the geometry moves.
  private syncCaret(): void {
    const focus = this.engine.keyboardFocusSprite;
    const ch = focus > 0 && focus < this.engine.channels.length ? this.engine.getChannel(focus) : undefined;
    const node = ch ? this.nodes.get(focus) : undefined;
    const member = ch?.member;
    const editable = member?.kind === 'text' && !!member.textProps?.get('editable');
    const group = node?.visual;
    // textObj is the REAL discriminator here: in pixi v8 Sprite extends
    // Container, so an instanceof check alone would pass for bitmap sprites.
    if (!editable || !node?.textObj || !(group instanceof Container) || ch?.visible !== 1) {
      if (node?.caret) node.caret.visible = false;
      return;
    }
    // `||` (not `??`): a width/height of 0 must fall back to the node's base,
    // and `??` only skips null/undefined.
    const w = Math.max(1, Math.round(ch.width || node.baseW || 1));
    const h = Math.max(1, Math.round(ch.height || node.baseH || 1));
    const x = caretX(member ? alignmentName(member.alignment) : undefined, w, node.textObj.width);
    const caretH = h;
    // Single-line fields: the caret spans the field height from the top (y=0).
    // Wrapping fields: anchor the caret's top to the LAST line's area — with
    // text taller than the box, `textHeight - caretH` slides it down.
    const caretY = Math.max(0, node.textObj.height - caretH);
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

  // Upload runtime-painted member surfaces (window element buffers, loading
  // bar) when Lingo painted into them. Runs after tick() so the same frame's
  // paints land; the sprite is scaled to the channel's w/h.
  private syncChannelImages(): void {
    for (const [channel, node] of this.nodes) {
      if (!node.imgLImage) continue;
      const img = node.imgLImage;
      if (!img.dirty) continue;
      // An unpainted 0x0 surface has no pixels yet — materialize the sprite
      // once Lingo paints into it (setChannel skipped it; uploading an empty
      // buffer as a texture throws texImage2D underflow).
      if (img.width < 1 || img.height < 1) continue;
      const w = Math.round(img.width);
      const h = Math.round(img.height);
      // Director transparency inks (1/8/36) apply to runtime surfaces too — the
      // Entry Cloud Class fills its member white mid-turn and relies on the
      // sprite's ink 8 to drop the backdrop. Bake a per-node scratch copy so the
      // Lingo surface itself stays untouched (the corpus reads it back).
      const ch = this.engine.getChannel(channel);
      const bake = this.bakeForChannel(ch, img, w, h);
      const tint = this.tintForChannel(ch);
      const baked = bake || tint ? this.bakeImagePixels(node, img, w, h, bake, tint) : null;
      // Only adopt the bake when it actually removed pixels — a near-white-cornered
      // surface with no edge-connected white region must stay raw (no texture churn).
      const pixels = baked && baked.changed ? baked.pixels : img.ensure();
      const finalBake = baked && baked.changed ? bake : null;
      if (!node.visual || !(node.visual instanceof Sprite)) {
        node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
        node.imgTexture = new Texture({ source: node.imgSource });
        const sprite = new Sprite(node.imgTexture);
        node.baseW = w;
        node.baseH = h;
        node.visual = sprite;
        node.container.addChild(sprite);
        node.bakeMode = finalBake;
        node.imgBuffer = pixels;
        this.refreshChannel(channel);
      } else if (!node.imgSource || node.imgSource.width !== w || node.imgSource.height !== h || node.bakeMode !== finalBake || node.imgBuffer !== pixels) {
        const oldTex = node.imgTexture;
        node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
        node.imgTexture = new Texture({ source: node.imgSource });
        node.visual.texture = node.imgTexture;
        node.bakeMode = finalBake;
        node.imgBuffer = pixels;
        // The texture's natural size changed — refresh the stretch base or a
        // runtime member resize (cloud reset to a different size) would skew.
        node.baseW = w;
        node.baseH = h;
        // Same-size buffer swaps (cloud resets) hit the imgBuffer check, so
        // release the replaced texture instead of letting sources accumulate.
        oldTex?.destroy();
      } else {
        node.imgSource.update();
      }
      img.dirty = false;
      this.applyTransform(channel);
    }
  }

  // Which bake applies to a runtime surface: transparency inks (1/8/36) always
  // bake; copy ink also bakes when the art's corners are near-white (else a
  // white rim shows on composited button buffers).
  private bakeForChannel(ch: { ink: number } | undefined, img: LImage, w: number, h: number): BakeMode | null {
    if (!ch) return null;
    if (ch.ink === 1 || ch.ink === 8 || ch.ink === 36) return bakeModeForInk(ch.ink);
    if (ch.ink === 0 && w > 0 && h > 0 && cornersAreNearWhite(img.ensure(), w, h)) return 'backgroundTransparent';
    return null;
  }

  // Bake a runtime surface's pixels into the node's scratch buffer (background
  // removal) without mutating the Lingo image. Returns whether anything changed.
  private bakeImagePixels(
    node: ChannelNode,
    img: LImage,
    w: number,
    h: number,
    bake: BakeMode | null,
    tint: number | null,
  ): { pixels: Uint8ClampedArray; changed: boolean } {
    const n = w * h * 4;
    if (!node.bakeBuf || node.bakeBuf.length !== n) node.bakeBuf = new Uint8ClampedArray(n);
    const src = img.ensure();
    node.bakeBuf.set(src.subarray(0, n));
    // Tint FIRST, then bake: the swatch's white box becomes the bg color, and
    // its own near-white gate re-evaluates on the tinted corners so the
    // ink-0 backgroundTransparent bake no-ops and the box survives.
    const tinted = tint !== null ? tintSpriteBackground(node.bakeBuf, w, h, tint) : false;
    // Key runtime-composed surfaces by EXACT WHITE (the Lingo fill color) —
    // never the surface's own palette[0]: copyPixels full-surface adoption can
    // hand the canvas a part's palette whose index 0 IS the eye-white gray, and
    // a blanket key on it would wipe the whole figure. Indexed art is already
    // export-keyed; this bake only drops the runtime white fill.
    const changed = bake ? bakeEdgeBackground(node.bakeBuf, w, h, bake, undefined) : false;
    return { pixels: node.bakeBuf, changed: changed || tinted };
  }

  // The sprite's explicit RGB bgColor, or null when there's nothing to tint
  // (unset / palette-index int / white — white is identity, skip).
  private tintForChannel(ch: { bgColorIsRgb?: boolean; bgColor?: number } | undefined): number | null {
    if (!ch?.bgColorIsRgb || !ch.bgColor) return null;
    if (ch.bgColor === 0xffffff) return null;
    return ch.bgColor;
  }

  // Draw a Director shape definition into a Pixi Graphics (fill + outline).
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

  // Apply the channel's transforms to its node: reg-point pivot, position,
  // rotation + skew, and the scale composing flips, sprite.scale, and w/h stretch.
  private applyTransform(channel: number): void {
    const node = this.nodes.get(channel);
    const ch = this.engine.getChannel(channel);
    // Keep the sprite bgColor fill (colour swatch backdrop) in sync with the
    // channel's bgColor/ink BEFORE the early return — a bgColor change alone
    // (updatePartColorPreview) must recolor the fill even on a cheap refresh.
    this.syncBgFill(channel);
    const v = node?.visual;
    if (!v || !ch) return;
    // The member's regPoint can move AFTER the node was built (the avatar
    // flips shift regX to keep feet anchored at locH) — re-read it each pass
    // so a flip doesn't pivot at a stale left-edge regX and jump the sprite.
    if (ch.member && (ch.member.regX !== node.regX || ch.member.regY !== node.regY)) {
      node.regX = ch.member.regX;
      node.regY = ch.member.regY;
    }
    v.pivot.set(node.regX, node.regY);
    v.x = ch.locH;
    v.y = ch.locV;
    // rotation 180 + skew 180 = horizontal mirror: render the pair as
    // identity and fold the mirror into flipX, else apply the real transforms.
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
    // Mirror the sprite's transform onto the bgColor fill so it covers the
    // same stretched rect (same pivot/loc/rotation/scale).
    if (node.bgFill) {
      node.bgFill.pivot.set(node.regX, node.regY);
      node.bgFill.x = v.x;
      node.bgFill.y = v.y;
      node.bgFill.rotation = v.rotation;
      node.bgFill.scale.set(sx, sy);
      node.bgFill.visible = ch.visible === 1;
      // Mirror the sprite's blend so a low-blend backdrop (modal dim, room
      // shadow) is translucent instead of an opaque slab.
      node.bgFill.alpha = Math.max(0, Math.min(1, ch.blend / 100));
    }
  }

  // Director bgColor shows through a bitmap's transparent pixels. Unpainted
  // element buffers (e.g. the figure-creator swatch) get a bgColor fill behind
  // the sprite so they're visible; live bgColor changes recolor it.
  // Transparency inks skip it (raw bitmaps tint instead).
  private syncBgFill(channel: number): void {
    const node = this.nodes.get(channel);
    const ch = this.engine.getChannel(channel);
    const remove = (): void => {
      if (node?.bgFill) {
        node.bgFill.destroy();
        node.bgFill = undefined;
      }
    };
    // Element-buffer channels only (setChannel's visual.image branch sets
    // imgLImage before applyTransform; syncChannelImages only processes nodes
    // with imgLImage). Raw cast bitmaps (visual.bytes) tint via U78, and text
    // nodes draw their own bg fill — neither should get a backdrop fill here.
    if (!node || !node.visual || !node.imgLImage || !ch || !ch.bgColorIsRgb || ch.bgColor == null) return remove();
    // White bgColor is IDENTITY: the room shadow wrapper carries ink 41 +
    // white meaning "no darken tint" — a white backdrop stretched to the
    // stage would cover the room with an opaque slab.
    if (ch.bgColor === 0xffffff) return remove();
    const ink = ch.ink ?? 0;
    if (ink === 1 || ink === 8 || ink === 36) return remove();
    // Only a FULLY-transparent buffer shows the fill — a partially-painted
    // piece (icon with transparent margins) must never gain a white box.
    // Scan once per buffer identity / dirty transition, cached on the node.
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

  // Upload the engine's stage drawing surface ((the stage).image) whenever
  // Lingo painted into it. Recreated when the buffer appears or the stage
  // resizes; re-uploaded only when dirty so loading-bar / window fills show.
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
      this.stageTexture = new Texture({ source });
      if (this.stageSprite) this.stageSprite.destroy();
      this.stageSprite = new Sprite(this.stageTexture);
      this.stageSprite.eventMode = 'none';
      // The stage surface sits behind the channel sprites (Director: sprites
      // composite over the stage); the background Graphics stays under it.
      this.app.stage.addChildAt(this.stageSprite, 1);
    } else {
      this.stageTexture.source.update();
    }
    img.dirty = false;
  }

  /** Render the composited scene (background + stage paint surface + channel
   *  sprites) and return its stage-sized RGBA pixels. This is what Director's
   *  `(the stage).image` READS return — the FUSE screen camera crops it per
   *  frame and the Photo Interface copies it for the camera shot. extract
   *  re-renders the container (one extra render per capture), which is the
   *  price of a real readback; a null return makes callers fall back. */
  captureStage(): Uint8Array | null {
    if (!this.app?.renderer || !this.app.stage) return null;
    try {
      // WITHOUT a frame, generateTexture sizes the readback from the stage's
      // LOCAL BOUNDS — a sprite parked at a huge coordinate (off-stage UI
      // members keep their movie coords) inflates that to a gigantic texture
      // and getPixels throws "Invalid typed array length" (seen: 66 GB for a
      // 720x540 stage). Clamp to the visible screen rect so the readback is
      // always stage-sized.
      const screen = this.app.screen;
      const out = this.app.renderer.extract.pixels({
        target: this.app.stage,
        frame: new Rectangle(screen.x, screen.y, screen.width, screen.height),
      });
      // pixi 8.19 returns { pixels: Uint8ClampedArray, width, height } — grab
      // the buffer and hand it back as a plain Uint8Array view.
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

  // Resize the canvas + background to the movie's stage dims (movie.txt).
  resize(width: number, height: number): void {
    if (!this.app?.renderer) return;
    this.app.renderer.resize(width, height);
    this.app.stage.hitArea = this.app.screen;
    this.background?.clear().rect(0, 0, width, height).fill(this.engine.stageBackground);
    // The stage surface may already exist with stale dims; the next dirty
    // upload recreates its texture (syncStageImage checks sprite size).
    this.stageImg = null;
    this.stageBuf = null;
  }

  setChannel(channel: number, visual: ChannelVisual | null): void {
    let node = this.nodes.get(channel);
    if (!node) {
      node = { container: new Container(), visual: null, regX: 0, regY: 0 };
      this.layer.addChild(node.container);
      this.nodes.set(channel, node);
    }
    if (node.visual) {
      node.visual.destroy();
      node.visual = null;
    }
    // Drop the previous channel's shared blob reference on every rebuild —
    // the entry is refcounted, so a leak here pins the decode forever.
    this.releaseBlob(node.blobEntry);
    node.blobEntry = undefined;
    // Drop stale runtime-image state so syncChannelImages can't re-upload an
    // old LImage (or clobber a fresh blob texture) after a kind change.
    node.imgLImage = undefined;
    node.imgSource = undefined;
    node.imgBuffer = undefined;
    node.imgTexture = undefined;
    node.bakeMode = undefined;
    node.bakeBuf = undefined;
    node.baseW = undefined;
    node.baseH = undefined;
    node.shape = undefined;
    // The text group (with the caret child) was destroyed with the visual
    // above — drop the stale references so syncCaret never touches them.
    node.textObj = undefined;
    node.caret = undefined;
    node.caretX = undefined;
    node.caretY = undefined;
    node.caretH = undefined;
    // Drop any sprite bgColor fill — it is rebuilt (or not) by syncBgFill
    // from the NEW channel's bgColor/ink, so a stale fill never survives a
    // kind/member change (bitmap -> text etc.).
    if (node.bgFill) {
      node.bgFill.destroy();
      node.bgFill = undefined;
    }
    // Drop the cached fill-transparency scan too — the new channel's buffer
    // (or lack of one) re-scans on the next syncBgFill.
    node.bgFillScanBuf = undefined;
    node.bgFillScanDirty = undefined;
    node.bgFillTransparent = undefined;
    node.regX = visual?.regX ?? 0;
    node.regY = visual?.regY ?? 0;
    node.container.visible = true;

    if (!visual) {
      node.container.visible = false;
      return;
    }
    if (visual.kind === 'text') {
      // Unique text/field elements render with the member's own font/size/
      // color/alignment (canvas text, antialiased). A group holds the field's
      // bg fill (txtBgColor) behind the text; empty text renders nothing.
      const w = Math.max(1, Math.round(visual.width ?? 1));
      const h = Math.max(1, Math.round(visual.height ?? 1));
      const size = Math.max(1, Math.round(visual.fontSize ?? 12));
      const group = new Container();
      // Transparency inks (1/8/36) make the member's white bgColor vanish —
      // the field's image background IS the box, so drawing a white rect here
      // would cover it with a flat slab.
      const ink = visual.ink ?? 0;
      const bg = ink === 1 || ink === 8 || ink === 36 ? null : visual.bgColor;
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
      node.textObj = text;
      node.caretColor = visual.color ?? 0xffffff;
      node.visual = group;
      node.baseW = w;
      node.baseH = h;
      node.hitW = w;
      node.hitH = h;
      node.container.addChild(group);
    } else if (visual.image) {
      // Runtime-painted member surface (window element buffer, Loading Bar):
      // upload the LImage as a raw RGBA texture, re-uploaded each tick while
      // dirty, stretched to the channel's w/h. An unpainted 0x0 surface has no
      // pixels — syncChannelImages materializes the sprite once painted.
      node.imgLImage = visual.image;
      if (visual.image.width >= 1 && visual.image.height >= 1) {
        const img = visual.image;
        const w = Math.round(img.width);
        const h = Math.round(img.height);
        const ch = this.engine.getChannel(channel);
        const bake = this.bakeForChannel(ch, img, w, h);
        const tint = this.tintForChannel(ch);
        const baked = bake || tint ? this.bakeImagePixels(node, img, w, h, bake, tint) : null;
        const pixels = baked && baked.changed ? baked.pixels : img.ensure();
        node.bakeMode = baked && baked.changed ? bake : null;
        node.imgBuffer = pixels;
        node.imgSource = new BufferImageSource({ resource: pixels, width: w, height: h, format: 'rgba8unorm', scaleMode: 'nearest' });
        node.imgTexture = new Texture({ source: node.imgSource });
        const sprite = new Sprite(node.imgTexture);
        node.baseW = w;
        node.baseH = h;
        node.visual = sprite;
        node.container.addChild(sprite);
      }
      this.applyTransform(channel);
    } else if (visual.shape) {
      // Director shape member (skyleft/skyright/box): a solid-fill rect/oval,
      // drawn in refreshChannel (fill depends on the sprite color, set after
      // castNum), scaled to the channel's w/h.
      node.shape = visual.shape;
      node.baseW = Math.max(1, Math.round(visual.shape.width));
      node.baseH = Math.max(1, Math.round(visual.shape.height));
      const g = new Graphics();
      node.visual = g;
      node.container.addChild(g);
    } else if (visual.bytes) {
      // Cast bitmaps: the visualizer sets sprite.ink right after castNum, so
      // the ink is final here. Inks 1/36 blanket-key the background (palette
      // index 0 when the bitmap ships a .pal, else exact white) and ink 8
      // flood-fills the edge-connected background. Decode is synchronous (pure-
      // JS PNG decoder — no blob URL, no <img> onload race).
      const ch = this.engine.getChannel(channel);
      // Ink 9 (Mask): render through the next cast member's bitmap as a
      // grayscale alpha mask (black=opaque, white=transparent), aligned by
      // their reg points — the pool water (vesi1 -> vesimask1) needs this.
      if (ch.ink === 9 && visual.maskBytes) {
        const offX = (visual.maskRegX ?? 0) - (visual.regX ?? 0);
        const offY = (visual.maskRegY ?? 0) - (visual.regY ?? 0);
        let width = 0;
        let height = 0;
        let rgba: Uint8ClampedArray | null = null;
        let maskDec: { width: number; height: number; rgba: Uint8ClampedArray } | null = null;
        try {
          const dec = decodePng(visual.bytes);
          width = dec.width;
          height = dec.height;
          rgba = new Uint8ClampedArray(dec.rgba);
          const md = decodePng(visual.maskBytes);
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
        }
      } else {
      const bake: BakeMode | null = bakeModeForInk(ch.ink);
      // Furniture colour tint: solveMembers sets sprite.bgColor per part
      // (coloured furniture like "pura_mdl1*1") and the part art is grayscale
      // where the colour goes, so tintSpriteBackground swaps near-grayscale
      // pixels for the bg colour. The blob cache can't serve these (the tint
      // depends on the channel's bgColor), so a tinted channel bakes its own.
      const tint = this.tintForChannel(ch);
      if (tint !== null) {
        let width = 0;
        let height = 0;
        let rgba: Uint8ClampedArray | null = null;
        try {
          const dec = decodePng(visual.bytes);
          width = dec.width;
          height = dec.height;
          rgba = new Uint8ClampedArray(dec.rgba);
          // Pattern remap FIRST (member.paletteRef — floor patterns recolor
          // the art by palette index through the pattern palette).
          if (visual.remapPalette) PixiStage.remapPixels(rgba, dec.indices, ch.member?.palette, visual.remapPalette);
          // Matte FIRST, then tint: the bake keys the edge-connected
          // background so the backdrop vanishes, then the tint recolors the
          // SURVIVING enclosed grayscale art. Tinting first recolored the
          // background too, leaving no white edges to flood from.
          if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, ch.member?.palette, dec.indices);
          tintSpriteBackground(rgba, width, height, tint);
        } catch (e) {
          this.engine.warn(`bitmap decode failed (tint): ${e instanceof Error ? e.message : String(e)}`);
          rgba = null;
        }
        if (!rgba || width < 1 || height < 1) {
          // 1x1 transparent fallback so a broken member never blanks the stage.
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
        }
      } else {
        const entry = this.acquireBlob(visual.bytes, bake, ch.member?.palette, visual.remapPalette);
        node.blobEntry = entry;
        const sprite = new Sprite(entry.texture);
        node.baseW = entry.width;
        node.baseH = entry.height;
        node.visual = sprite;
        node.container.addChild(sprite);
      }
      }
    }
    this.refreshChannel(channel);
  }

  // Fingerprint the palette for the blob-cache key: members sharing raw bytes
  // but with DIFFERENT palettes (regional variants) must not share a baked
  // texture. Only computed on cache misses.
  private static paletteKey(palette: number[][] | undefined): string {
    if (!palette || palette.length === 0) return 'none';
    return 'pal:' + palette.length + ':' + palette.map((p) => p.join(',')).join(';');
  }

  // Recolor a decoded bitmap's pixels through `target` by palette index — the
  // member.paletteRef pattern remap. Indexed exports carry the TRUE indices;
  // older RGBA exports recover them from the member's own palette (the RGB
  // reverse lookup is ambiguous when indices share a color).
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

  // Get (or create) the shared decoded-texture entry for these raw bytes +
  // bake + palette + pattern-remap. Same bytes + bake + palette on any channel
  // => one decode, one texture; released entries stay cached (LRU-capped) so
  // frame-cycling animations reuse them.
  private acquireBlob(bytes: Uint8Array, bake: BakeMode | null, palette?: number[][], remap?: number[][]): BlobEntry {
    const key = (bake ?? 'none') + '|' + PixiStage.paletteKey(palette) + '|' + PixiStage.paletteKey(remap);
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
        const dec = decodePng(bytes);
        width = dec.width;
        height = dec.height;
        rgba = new Uint8Array(dec.rgba);
        // Pattern remap (member.paletteRef) before the ink bake — wall/floor
        // pieces recolor through the pattern palette by pixel index.
        if (remap) PixiStage.remapPixels(rgba, dec.indices, palette, remap);
        // Indexed bitmaps ship unkeyed (every pixel opaque), so the decode-
        // time bake keys them per ink + palette (palette index 0 is the
        // background). Matte mode keys by palette INDEX; 'key' inks by the
        // palette[0] RGB — art that merely LOOKS white at other indices
        // survives the flood. Palette-less 32-bit art gets the edge-color
        // fallback.
        if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, palette, dec.indices);
      } catch (e) {
        this.engine.warn(`bitmap decode failed: ${e instanceof Error ? e.message : String(e)}`);
        rgba = null;
      }
      let texture: Texture;
      if (!rgba || width < 1 || height < 1) {
        // 1x1 transparent fallback so a broken member never blanks the stage.
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
      entry = { bytes, bake, key, refs: 0, width, height, texture };
      byBake.set(key, entry);
    } else {
      this.unfreeBlob(entry);
    }
    entry.refs++;
    return entry;
  }

  // Drop a channel's reference to a shared blob entry. The entry stays cached
  // for reuse; only LRU capacity evicts it.
  private releaseBlob(entry: BlobEntry | undefined): void {
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    if (!this.freeBlobs.includes(entry)) this.freeBlobs.push(entry);
  }

  // Pull an entry out of the free list (it is being re-acquired).
  private unfreeBlob(entry: BlobEntry): void {
    const i = this.freeBlobs.indexOf(entry);
    if (i >= 0) this.freeBlobs.splice(i, 1);
  }

  // Destroy an entry's texture and evict it (capacity eviction). Only
  // released (refs=0) entries are evicted, so no live sprite uses it.
  private dropBlob(entry: BlobEntry): void {
    try {
      entry.texture.destroy();
    } catch {
      // a texture with a destroyed source throws; ignore on eviction
    }
    const byBake = this.blobCache.get(entry.bytes);
    if (byBake) {
      byBake.delete(entry.key);
      if (byBake.size === 0) this.blobCache.delete(entry.bytes);
    }
  }

  // Debug aid (console): per-channel GPU-side state — bgColor fills, the
  // uploaded visual's size/alpha, and the channel's ink/blend/bgColor.
  // `document.querySelector('spark-player').directorStage.debugDump()`.
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
    // Director ink -> GPU blend mode (additive beams composite additively; the
    // transparency inks were pre-baked into the texture at load).
    node.visual.blendMode = blendModeForInk(ch.ink);
    node.container.zIndex = ch.locZ;
    // Re-fill shape visuals on color changes — buildVisual sets sprite.color
    // AFTER castNum/width/height, so the initial fill is only a fallback.
    if (node.shape && node.visual instanceof Graphics) {
      node.visual.clear();
      this.drawShape(node.visual, node.shape, ch.colorSet ? ch.color : (node.shape.color ?? 0xffffff));
    }
    this.applyTransform(channel);
  }

  private pointer(type: 'mouseDown' | 'mouseUp' | 'mouseMove', x: number, y: number): void {
    // Pointer coords are truncated to integers so the mouseH/mouseV are whole
    // pixels — subpixel floats made click-point math float-divide and resolve
    // the row BELOW the click (furniture clicks fell through).
    x = Math.trunc(x);
    y = Math.trunc(y);
    // Mouse events reach the topmost sprite that HAS A SCRIPT — the room
    // hiliter is never brokered, so it must not eat floor clicks. mouseMove
    // keeps the raw topmost sprite so `the rollover` still works.
    const raw = this.hitTest(x, y);
    const channel = type === 'mouseMove' ? raw : this.hitTest(x, y, { onlyScripted: true });
    // Click diagnostics (U112/U119): one line per click with where the raw +
    // scripted hit-tests landed, member + behavior names, room gate state, and
    // the broker's client_lastclick after dispatch — for debugging clicks that
    // stop working after room switches.
    if (type !== 'mouseMove') {
      const desc = (c: number): string => {
        if (c <= 0) return '0';
        const ch = this.engine.getChannel(c);
        const list = ch.scriptInstanceList;
        const items = list && typeof (list as { items?: unknown[] }).items !== 'undefined'
          ? (list as { items: unknown[] }).items
          : [];
        // Behavior script names on the sprite — if a recycled cast slot
        // re-resolves the sprite's script-list member to a different script,
        // clicks dead-end exactly like this (behavior present, nothing runs).
        const names = items
          .map((i) => ((i as { script?: { name?: string } } | undefined)?.script?.name ?? '?'))
          .join('+');
        return `${c} mem="${ch.member?.name ?? ch.member?.number ?? '-'}" behaviors=${items.length} scripts=${names || '-'}`;
      };
      this.engine.log(`click: ${type} (${x},${y}) scripted=${desc(channel)} raw=${desc(raw)}`);
      if (type === 'mouseDown') {
        // Room-walk gate state at click time: ownUser=0 on a scripted floor
        // click means eventProcRoom early-returned (getOwnUser()=0) and no
        // MOVE goes out. user_index vs userObjCount tells us whether the own
        // user's id is wrong or its object never landed in pUserObjList.
        try {
          const ui = this.engine.interp.evalExpressionString('getObject(#session).GET("user_index")');
          const own = this.engine.interp.evalExpressionString('getThread(#room).getComponent().getOwnUser()');
          const uc = this.engine.interp.evalExpressionString('getThread(#room).getComponent().pUserObjList.count');
          const act = this.engine.interp.evalExpressionString('getThread(#room).getComponent().pActiveFlag');
          // Event Broker mouseDown writes client_lastclick = "<sprId> ->
          // <pProcList[#mouseDown][2]>" (0003:56-59). `-> 0` or a stale id =
          // the broker's proc registration for this sprite is empty/old, so
          // redirectEvent returns 0 and eventProcRoom never runs.
          const lc = this.engine.interp.evalExpressionString('getObject(#session).GET("client_lastclick")');
          this.engine.log(`room: user_index=${String(ui)} ownUser=${String(own)} userObjCount=${String(uc)} active=${String(act)} lastClick=${String(lc)}`);
        } catch (e) {
          this.engine.log(`room: gate probe error: ${e instanceof Error ? e.message : String(e)}`);
        }
        // U119 DIAG v5 (foolproof state dump). The broken room's floor sprite
        // has a broker attached but: id empty + pProcList[#mouseDown][2]=0
        // (afterDispatch ' -> 0'). This dump answers which of the remaining
        // causes it is, in one line:
        //  - chId set but instId empty  -> setID went to a DIFFERENT broker
        //    instance than the one on the channel now (stale instance swap)
        //  - keys=[mouseDown,mouseUp,...] with proc=[#eventProcRoom -> id]
        //    -> registered fine (then the click gate is elsewhere)
        //  - keys=8 template events, proc=[#null -> 0] -> registerProcedure
        //    never reached THIS broker (template from a mouseEnter redirect)
        //  - clicked channel NOT in sprList=[...] -> the room wired different
        //    channels than the one under the cursor (two sprites at the spot)
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
            parts.push(
              `instId=${id instanceof LSymbol ? '#' + id.name : String(id)} sprNum=${String(sn)} keys=[${keys}] proc=[${mdDesc}]`,
            );
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
    // U119 DIAG (after dispatch): the broker's mouseDown (0003:56-59) writes
    // client_lastclick ONLY when pProcList is non-void. Reading it AFTER the
    // dispatch tells us whether the floor broker's mouseDown ran and wrote:
    //  - written "<spr> -> <client> / <time>" but no MOVE = redirectEvent's
    //    objectExists(staleClient) failed (dead room-client reference)
    //  - NOT written (still the navigator's value) = pProcList void = the
    //    registerProcedure(#eventProcRoom, roomID, #mouseDown) never landed on
    //    this sprite's broker (registration broken on re-entry)
    if (type === 'mouseDown' && channel > 0) {
      try {
        const lc2 = this.engine.interp.evalExpressionString('getObject(#session).GET("client_lastclick")');
        this.engine.log(`room: afterDispatch lastClick=${String(lc2)}`);
      } catch {
        // probe is diagnostic-only; never break the click
      }
    }
  }

  // Topmost (highest locZ) sprite whose rect contains the point, with the
  // matte rule: ink-8 sprites only accept clicks on an OPAQUE pixel, so a
  // click on a transparent region falls through (without this, window title
  // bars always hit the back panel and windows can't be dragged).
  private hitTest(x: number, y: number, opts?: { onlyScripted?: boolean }): number {
    const hits: { channel: number; z: number; node: ChannelNode; w: number; h: number }[] = [];
    for (const [channel, node] of this.nodes) {
      const ch = this.engine.getChannel(channel);
      if (!node.container.visible || ch.visible !== 1 || !node.visual) continue;
      // Scriptless sprites (room hiliter, catchEvents-0 decorations) don't
      // receive events or block the sprites below; editable text stays a
      // target for click-to-focus.
      if (opts?.onlyScripted && !ch.isPointerTarget(true)) continue;
      const w = node.hitW ?? node.visual.width;
      const h = node.hitH ?? node.visual.height;
      const left = ch.locH - node.regX;
      const top = ch.locV - node.regY;
      // Inverse-transform the mouse through the channel's rotation / skew-
      // mirror / flips first: the visible bounds mirror around the regPoint
      // while the hit rect stays in untransformed space.
      const { tx, ty } = this.inverseTransformPoint(ch, x, y);
      if (tx < left || tx > left + w || ty < top || ty > top + h) continue;
      hits.push({ channel, z: ch.locZ, node, w, h });
    }
    // Ties on locZ resolve to the highest channel (previous >= behavior).
    hits.sort((a, b) => (b.z - a.z) || (b.channel - a.channel));
    for (const hit of hits) {
      const ch = this.engine.getChannel(hit.channel);
      const left = ch.locH - hit.node.regX;
      const top = ch.locV - hit.node.regY;
      const sw = hit.node.imgSource?.width ?? hit.w;
      const sh = hit.node.imgSource?.height ?? hit.h;
      const { tx, ty } = this.inverseTransformPoint(ch, x, y);
      const px = Math.round((tx - left) * (sw / Math.max(1, hit.w)));
      const py = Math.round((ty - top) * (sh / Math.max(1, hit.h)));
      if (matteSpriteHitTest(ch.ink ?? 0, hit.node.imgBuffer, sw, sh, px, py)) return hit.channel;
    }
    return 0;
  }

  // Inverse-transform a stage point through a channel's Director transforms —
  // see inverseDirectorTransformPoint.
  private inverseTransformPoint(ch: Channel, x: number, y: number): { tx: number; ty: number } {
    return inverseDirectorTransformPoint(ch.rotation || 0, ch.skew || 0, ch.flipH, ch.flipV, ch.locH, ch.locV, x, y);
  }
}

export { LPoint };
