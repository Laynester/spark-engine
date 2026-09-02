import { Application, BufferImageSource, Container, Graphics, Rectangle, Sprite, Text, Texture, type BLEND_MODES } from 'pixi.js';
import 'pixi.js/advanced-blend-modes';
import { alignmentName, type ChannelVisual, type DirectorEngine, type StageAdapter } from '../engine/engine.js';
import type { Channel } from '../engine/sprites.js';
import { LImage, LList, LObject, LPoint, LPropList, LSpriteRef, LSymbol } from '../lingo/values.js';
import type { ShapeDef } from '../engine/members.js';
import { applyMaskAlpha, bakeEdgeBackground, bakeModeForInk, blendModeForInk, cornersAreNearWhite, matteSpriteHitTest, tintSpriteBackground, tintSpriteDarken, SUBTRACT_BLEND_MODE, type BakeMode } from './matte.js';
import { caretBlinkOn, caretX } from './caret.js';
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
  imgBuffer?: Uint8Array | Uint8ClampedArray | null;
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
}

interface BlobEntry {
  bytes: Uint8Array;
  bake: BakeMode | null;
  key: string;
  refs: number;
  width: number;
  height: number;
  texture: Texture;
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

  constructor(
    private engine: DirectorEngine,
    private parent: HTMLElement,
  ) {}

  async init(): Promise<void> {
    const { stageWidth: w, stageHeight: h, stageBackground: bg } = this.engine;
    this.app = new Application();
    await this.app.init({ width: w, height: h, background: bg, antialias: false, resolution: 1 });
    this.registerSubtractBlend();
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
      if (steps === 4) this.frameAcc = 0;
      this.syncChannelImages();
      this.syncCaret();
    });
  }

  private registerSubtractBlend(): void {
    const state = (this.app.renderer as unknown as { state?: { blendModesMap?: Record<string, number[]> } }).state;
    const gl = (this.app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext }).gl;
    if (state?.blendModesMap && gl) {
      state.blendModesMap[SUBTRACT_BLEND_MODE] = [
        gl.ONE,
        gl.ONE,
        gl.ONE,
        gl.ZERO,
        gl.FUNC_REVERSE_SUBTRACT,
        gl.FUNC_ADD,
      ];
    }
  }

  private syncCaret(): void {
    const focus = this.engine.keyboardFocusSprite;
    const ch = focus > 0 && focus < this.engine.channels.length ? this.engine.getChannel(focus) : undefined;
    const node = ch ? this.nodes.get(focus) : undefined;
    const member = ch?.member;
    const editable = member?.kind === 'text' && !!member.textProps?.get('editable');
    const group = node?.visual;
    if (!editable || !node?.textObj || !(group instanceof Container) || ch?.visible !== 1) {
      if (node?.caret) node.caret.visible = false;
      return;
    }
    const w = Math.max(1, Math.round(ch.width || node.baseW || 1));
    const h = Math.max(1, Math.round(ch.height || node.baseH || 1));
    const x = caretX(member ? alignmentName(member.alignment) : undefined, w, node.textObj.width);
    const caretH = h;
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

  private syncChannelImages(): void {
    for (const [channel, node] of this.nodes) {
      if (!node.imgLImage) continue;
      const img = node.imgLImage;
      if (!img.dirty) continue;
      if (img.width < 1 || img.height < 1) continue;
      const w = Math.round(img.width);
      const h = Math.round(img.height);
      const ch = this.engine.getChannel(channel);
      const bake = this.bakeForChannel(ch, img, w, h);
      const tint = this.tintForChannel(ch);
      const baked = bake || tint ? this.bakeImagePixels(node, img, w, h, bake, tint, this.ink7KeyForChannel(ch), ch.ink ?? 0, ch.colorSet ? ch.color : 0) : null;
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
        node.baseW = w;
        node.baseH = h;
        oldTex?.destroy();
      } else {
        node.imgSource.update();
      }
      img.dirty = false;
      this.applyTransform(channel);
    }
  }

  private bakeForChannel(ch: { ink: number } | undefined, img: LImage, w: number, h: number): BakeMode | null {
    if (!ch) return null;
    if (ch.ink === 1 || ch.ink === 7 || ch.ink === 8 || ch.ink === 36 || ch.ink === 41) return bakeModeForInk(ch.ink);
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
    ink7Key?: number | null,
    ink = 0,
    fgRgb = 0,
  ): { pixels: Uint8ClampedArray; changed: boolean } {
    const n = w * h * 4;
    if (!node.bakeBuf || node.bakeBuf.length !== n) node.bakeBuf = new Uint8ClampedArray(n);
    const src = img.ensure();
    node.bakeBuf.set(src.subarray(0, n));
    const tinted =
      tint !== null ? (ink === 41 ? tintSpriteDarken(node.bakeBuf, w, h, tint, fgRgb) : tintSpriteBackground(node.bakeBuf, w, h, tint)) : false;
    const changed = bake ? bakeEdgeBackground(node.bakeBuf, w, h, bake, undefined, undefined, ink7Key) : false;
    return { pixels: node.bakeBuf, changed: changed || tinted };
  }

  private tintForChannel(ch: { ink?: number; bgColorIsRgb?: boolean; bgColor?: number } | undefined): number | null {
    if (!ch?.bgColorIsRgb || ch.bgColor === undefined || ch.bgColor === null) return null;
    if (ch.bgColor === 0xffffff) return null;
    if (ch.bgColor === 0 && ch.ink !== 41) return null;
    return ch.bgColor;
  }

  private ink7KeyForChannel(ch: { ink?: number; bgColorIsRgb?: boolean; bgColor?: number } | undefined): number | null | undefined {
    if (!ch || ch.ink !== 7) return undefined;
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
        node.bgFill.destroy();
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
      this.stageTexture = new Texture({ source });
      if (this.stageSprite) this.stageSprite.destroy();
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
    if (!node) {
      node = { container: new Container(), visual: null, regX: 0, regY: 0 };
      this.layer.addChild(node.container);
      this.nodes.set(channel, node);
    }
    if (node.visual) {
      node.visual.destroy();
      node.visual = null;
    }
    this.releaseBlob(node.blobEntry);
    node.blobEntry = undefined;
    node.imgLImage = undefined;
    node.imgSource = undefined;
    node.imgBuffer = undefined;
    node.imgTexture = undefined;
    node.bakeMode = undefined;
    node.bakeBuf = undefined;
    node.baseW = undefined;
    node.baseH = undefined;
    node.shape = undefined;
    node.textObj = undefined;
    node.caret = undefined;
    node.caretX = undefined;
    node.caretY = undefined;
    node.caretH = undefined;
    if (node.bgFill) {
      node.bgFill.destroy();
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
      node.textObj = text;
      node.caretColor = visual.color ?? 0xffffff;
      node.visual = group;
      node.baseW = w;
      node.baseH = h;
      node.hitW = w;
      node.hitH = h;
      node.container.addChild(group);
    } else if (visual.image) {
      node.imgLImage = visual.image;
      if (visual.image.width >= 1 && visual.image.height >= 1) {
        const img = visual.image;
        const w = Math.round(img.width);
        const h = Math.round(img.height);
        const ch = this.engine.getChannel(channel);
        const bake = this.bakeForChannel(ch, img, w, h);
        const tint = this.tintForChannel(ch);
        const baked = bake || tint ? this.bakeImagePixels(node, img, w, h, bake, tint, this.ink7KeyForChannel(ch), ch.ink ?? 0, ch.colorSet ? ch.color : 0) : null;
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
      node.shape = visual.shape;
      node.baseW = Math.max(1, Math.round(visual.shape.width));
      node.baseH = Math.max(1, Math.round(visual.shape.height));
      const g = new Graphics();
      node.visual = g;
      node.container.addChild(g);
    } else if (visual.bytes) {
      const ch = this.engine.getChannel(channel);
      if (ch.ink === 9 && visual.maskBytes) {
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
        }
      } else {
      const bake: BakeMode | null = bakeModeForInk(ch.ink);
      const ink7Key = this.ink7KeyForChannel(ch);
      const tint = this.tintForChannel(ch);
      if (tint !== null) {
        let width = 0;
        let height = 0;
        let rgba: Uint8ClampedArray | null = null;
        try {
          const dec = decodeImage(visual.bytes, ch.member?.palette);
          width = dec.width;
          height = dec.height;
          rgba = new Uint8ClampedArray(dec.rgba);
          if (visual.remapPalette) PixiStage.remapPixels(rgba, dec.indices, ch.member?.palette, visual.remapPalette);
          if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, ch.member?.palette, dec.indices, ink7Key);
          if (ch.ink === 41) tintSpriteDarken(rgba, width, height, tint, ch.colorSet ? ch.color : 0);
          else tintSpriteBackground(rgba, width, height, tint);
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
        }
      } else {
        const entry = this.acquireBlob(visual.bytes, bake, ch.member?.palette, visual.remapPalette, ink7Key);
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

  private acquireBlob(bytes: Uint8Array, bake: BakeMode | null, palette?: number[][], remap?: number[][], ink7Key?: number | null): BlobEntry {
    const keyColor = ink7Key !== undefined ? 'k' + (ink7Key ?? 'auto') : 'nk';
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
        if (bake && width > 0 && height > 0) bakeEdgeBackground(rgba, width, height, bake, palette, dec.indices, ink7Key);
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
      entry = { bytes, bake, key, refs: 0, width, height, texture };
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
    try {
      entry.texture.destroy();
    } catch {
    }
    const byBake = this.blobCache.get(entry.bytes);
    if (byBake) {
      byBake.delete(entry.key);
      if (byBake.size === 0) this.blobCache.delete(entry.bytes);
    }
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
    node.visual.blendMode = blendModeForInk(ch.ink) as unknown as (typeof node.visual)['blendMode'];
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
    const raw = this.hitTest(x, y);
    const channel = type === 'mouseMove' ? raw : this.hitTest(x, y, { onlyScripted: true });
    if (type !== 'mouseMove') {
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
    if (type === 'mouseDown' && channel > 0) {
      try {
        const lc2 = this.engine.interp.evalExpressionString('getObject(#session).GET("client_lastclick")');
        this.engine.log(`room: afterDispatch lastClick=${String(lc2)}`);
      } catch {
      }
    }
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

  private inverseTransformPoint(ch: Channel, x: number, y: number): { tx: number; ty: number } {
    return inverseDirectorTransformPoint(ch.rotation || 0, ch.skew || 0, ch.flipH, ch.flipV, ch.locH, ch.locV, x, y);
  }
}

export { LPoint };
