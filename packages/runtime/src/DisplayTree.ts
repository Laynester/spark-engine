import { Application, Container } from "pixi.js";
import type { SparkConfig } from "./types";

export class DisplayTree {
  readonly app: Application;
  /** Root stage added to app.stage. */
  readonly stage: Container;
  /** Background layer — parallax backgrounds live here, behind everything. */
  readonly backgroundLayer: Container;
  /** World layer — game entities live here, camera pans this. */
  readonly worldLayer: Container;
  /** UI layer — HUD, menus, overlays; camera does NOT affect this. */
  readonly uiLayer: Container;

  private canvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    this.app = new Application();
    this.stage = new Container();
    this.backgroundLayer = new Container();
    this.worldLayer = new Container();
    this.uiLayer = new Container();

    // Enable z-index sorting on all layers
    this.backgroundLayer.sortableChildren = true;
    this.worldLayer.sortableChildren = true;
    this.uiLayer.sortableChildren = true;
    this.canvas = document.createElement("canvas");
  }

  async init(config: SparkConfig): Promise<void> {
    const canvas = config.view;
    const parent = canvas.parentElement;
    const width = config.width ?? (parent ? parent.clientWidth : 800);
    const height = config.height ?? (parent ? parent.clientHeight : 600);

    const antialias = config.antialias ?? true;

    // For pixel art, use 1:1 resolution (no device-pixel upscaling)
    const isPixelArt = !antialias;

    await this.app.init({
      canvas,
      width,
      height,
      background: config.backgroundColor ?? 0x1a1a2e,
      antialias,
      roundPixels: isPixelArt,
      resolution: isPixelArt ? 1 : (window.devicePixelRatio || 1),
      autoDensity: !isPixelArt,
    });

    // Apply pixel-art CSS rendering
    if (isPixelArt) {
      canvas.style.imageRendering = "pixelated";
    }

    this.canvas = canvas;

    // Layer hierarchy: stage → background → world → ui
    this.stage.label = "spark-stage";
    this.backgroundLayer.label = "spark-background";
    this.worldLayer.label = "spark-world";
    this.uiLayer.label = "spark-ui";

    this.stage.addChild(this.backgroundLayer);
    this.stage.addChild(this.worldLayer);
    this.stage.addChild(this.uiLayer);
    this.app.stage.addChild(this.stage);

    // Auto-resize to fill parent — only when no explicit dimensions are configured.
    // When width/height are set, the canvas stays at that fixed size.
    if (parent && config.width === undefined && config.height === undefined) {
      this.resizeObserver = new ResizeObserver(() => {
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        if (w > 0 && h > 0) {
          this.app.renderer.resize(w, h);
        }
      });
      this.resizeObserver.observe(parent);
    }
  }

  setBackgroundColor(color: number): void {
    this.app.renderer.background.color = color;
  }

  /**
   * Toggle anti-aliasing at runtime.
   *
   * Because antialias and roundPixels are WebGL/WebGPU context creation
   * parameters that cannot be changed after init, this only controls CSS
   * `image-rendering` on the canvas:
   *
   * - `true`  → `auto` (smooth scaling, default browser behavior)
   * - `false` → `pixelated` (nearest-neighbor, crisp pixel edges)
   *
   * For full pixel-art rendering (antialias off, roundPixels on, resolution 1),
   * set `antialias: false` in SparkConfig at init time.
   */
  setAntialias(enabled: boolean): void {
    this.canvas.style.imageRendering = enabled ? "auto" : "pixelated";
  }

  get view(): HTMLCanvasElement {
    return this.canvas;
  }

  resize(width: number, height: number): void {
    this.app.renderer.resize(width, height);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.app.destroy(true, { children: true, texture: true });
  }
}
