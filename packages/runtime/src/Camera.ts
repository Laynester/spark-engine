import { Container, TilingSprite, Texture } from "pixi.js";
import type { Entity } from "./Entity";

/**
 * Controls the viewport by manipulating the worldLayer container.
 * Supports following an entity, setting world bounds, zoom, and
 * parallax backgrounds backed by Pixi TilingSprites.
 */
export class Camera {
  private worldLayer: Container;
  private backgroundLayer: Container;
  private loadTexture: (path: string) => Promise<Texture>;
  private getViewportSize: () => { width: number; height: number };

  private target: Entity | null = null;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;
  private _zoom = 1;
  private _x = 0;
  private _y = 0;

  private bgSprites: TilingSprite[] = [];
  private bgParallax: Map<TilingSprite, { x: number; y: number }> = new Map();
  private _ySortEnabled = false;

  constructor(deps: {
    worldLayer: Container;
    backgroundLayer: Container;
    loadTexture: (path: string) => Promise<Texture>;
    getViewportSize: () => { width: number; height: number };
  }) {
    this.worldLayer = deps.worldLayer;
    this.backgroundLayer = deps.backgroundLayer;
    this.loadTexture = deps.loadTexture;
    this.getViewportSize = deps.getViewportSize;
  }

  get x(): number { return this._x; }
  set x(value: number) { this._x = value; this.applyTransform(); }
  get y(): number { return this._y; }
  set y(value: number) { this._y = value; this.applyTransform(); }
  get zoom(): number { return this._zoom; }
  set zoom(value: number) {
    this._zoom = Math.max(0.1, value);
    this.applyTransform();
  }

  /**
   * Smoothly follow an entity (centered on screen). Pass null to stop following.
   * Camera updates are applied automatically each frame via the update loop.
   */
  follow(entity: Entity | null): void {
    this.target = entity;
    if (entity && !entity.destroyed) {
      const vp = this.getViewportSize();
      this._x = entity.x - (vp.width / 2) / this._zoom;
      this._y = entity.y - (vp.height / 2) / this._zoom;
      this.applyTransform();
    }
  }

  /** Confine the camera viewport to a world region. */
  setBounds(x: number, y: number, width: number, height: number): void {
    this.bounds = { x, y, width, height };
  }

  /**
   * Set a parallax-scrolling background.
   * @param texturePath Asset path to the background texture
   * @param factorX Horizontal parallax factor (0 = fixed, 1 = scrolls with camera)
   * @param factorY Vertical parallax factor
   */
  async setBackground(
    texturePath: string,
    factorX = 0,
    factorY = 0,
  ): Promise<void> {
    // Remove existing backgrounds
    for (const sprite of this.bgSprites) {
      this.backgroundLayer.removeChild(sprite);
      sprite.destroy();
    }
    this.bgSprites = [];
    this.bgParallax.clear();

    const texture = await this.loadTexture(texturePath);
    if (!texture) return;

    const sprite = new TilingSprite({
      texture,
      width: texture.width,
      height: texture.height,
    });
    sprite.label = "camera-background";
    this.backgroundLayer.addChildAt(sprite, 0);
    this.bgSprites.push(sprite);
    this.bgParallax.set(sprite, { x: factorX, y: factorY });
  }

  /** Convert screen coordinates to world coordinates. */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: screenX / this._zoom + this._x,
      y: screenY / this._zoom + this._y,
    };
  }

  /**
   * Enable or disable automatic y-based depth sorting on the world layer.
   * When enabled, entities with a higher y position render on top (appear
   * closer to the camera in a top-down view). Set explicit `entity.zIndex`
   * to override per-entity. Disable to use manual zIndex exclusively.
   */
  setSortByY(enabled: boolean): void {
    this._ySortEnabled = enabled;
  }

  get ySortEnabled(): boolean {
    return this._ySortEnabled;
  }

  /**
   * Call each frame (from update loop) to apply smooth follow and bounds clamping.
   */
  update(lerpSpeed = 0.1): void {
    if (this.target) {
      if (this.target.destroyed) {
        this.target = null;
      } else {
        const vp = this.getViewportSize();
        const tx = this.target.x - (vp.width / 2) / this._zoom;
        const ty = this.target.y - (vp.height / 2) / this._zoom;
        this._x += (tx - this._x) * Math.min(1, lerpSpeed);
        this._y += (ty - this._y) * Math.min(1, lerpSpeed);
      }
    }
    // Apply y-based depth sorting (once per frame, post all entity updates)
    if (this._ySortEnabled) {
      for (const child of this.worldLayer.children) {
        const offset = (child as any)._sparkZOffset ?? 0;
        child.zIndex = child.y + offset;
      }
      this.worldLayer.sortChildren();
    }

    this.applyTransform();
  }

  private applyTransform(): void {
    let cx = this._x;
    let cy = this._y;

    // Clamp to bounds (_x/_y is the top-left of the viewport in world coords)
    if (this.bounds) {
      const vp = this.getViewportSize();
      const vw = vp.width / this._zoom;
      const vh = vp.height / this._zoom;
      cx = Math.max(this.bounds.x, Math.min(cx, this.bounds.x + this.bounds.width - vw));
      cy = Math.max(this.bounds.y, Math.min(cy, this.bounds.y + this.bounds.height - vh));
    }

    this.worldLayer.scale.set(this._zoom);
    this.worldLayer.pivot.set(cx, cy);

    // Update parallax backgrounds
    for (const sprite of this.bgSprites) {
      const p = this.bgParallax.get(sprite) || { x: 0, y: 0 };
      sprite.tilePosition.x = cx * p.x;
      sprite.tilePosition.y = cy * p.y;
    }

    // UI layer is always fixed — no transform applied
  }

  destroy(): void {
    for (const sprite of this.bgSprites) {
      sprite.destroy();
    }
    this.bgSprites = [];
    this.bgParallax.clear();
  }
}
