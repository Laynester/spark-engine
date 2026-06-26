import { Application, Container } from "pixi.js";
import type { SparkConfig } from "./types";

export class DisplayTree {
  readonly app: Application;
  readonly stage: Container;
  private canvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    this.app = new Application();
    this.stage = new Container();
    this.canvas = document.createElement("canvas");
  }

  async init(config: SparkConfig): Promise<void> {
    const canvas = config.view;
    const parent = canvas.parentElement;
    const width = config.width ?? (parent ? parent.clientWidth : 800);
    const height = config.height ?? (parent ? parent.clientHeight : 600);

    await this.app.init({
      canvas,
      width,
      height,
      background: config.backgroundColor ?? 0x1a1a2e,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    this.canvas = canvas;
    this.stage.label = "spark-stage";
    this.app.stage.addChild(this.stage);

    // Auto-resize to fill parent
    if (parent) {
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
