import { Container, Sprite, Text, Texture } from "pixi.js";
import type { EntityConfig, TextConfig } from "./types";
import { resolveBlendMode } from "./blendModes";

export type EntityType = "sprite" | "container" | "text";

export interface Hitbox {
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
}

export class Entity {
  readonly id: string;
  readonly type: EntityType;
  readonly pixiObj: Container | Sprite | Text;

  /** Optional collision hitbox, defaults to entity width/height. */
  hitbox?: Hitbox;
  /** Optional tags for filtering (e.g. "enemy", "bullet", "pickup"). */
  tags: string[] = [];
  /** Which layer this entity belongs to. */
  layer: "background" | "world" | "ui" = "world";

  private _children: Entity[] = [];
  private _destroyed = false;
  private _zOffset = 0;

  constructor(config: EntityConfig & { text?: TextConfig }, id?: string) {
    this.id = id ?? `entity_${Math.random().toString(36).slice(2, 9)}`;

    if (config.text) {
      // Text entity
      const text = new Text({
        text: config.text.text,
        style: {
          fontSize: config.text.fontSize ?? 16,
          fill: config.text.fill ?? 0xffffff,
          fontFamily: config.text.fontFamily ?? "Arial",
        },
      });
      this.pixiObj = text;
      this.type = "text";
    } else if (config.texture) {
      // Sprite entity - texture is set later via setTexture()
      const sprite = new Sprite(Texture.WHITE);
      sprite.visible = false; // hidden until texture loads
      this.pixiObj = sprite;
      this.type = "sprite";
    } else if (config.tint !== undefined) {
      // Tinted rectangle — use Pixi's built-in white texture so tint produces visible color
      const sprite = new Sprite(Texture.WHITE);
      this.pixiObj = sprite;
      this.type = "sprite";
    } else {
      // Container entity
      this.pixiObj = new Container();
      this.type = "container";
    }

    this.pixiObj.label = this.id;
    this.pixiObj.eventMode = "static";

    // Apply hitbox and tags from config
    if (config.hitbox) this.hitbox = config.hitbox;
    if (config.tags) this.tags = [...config.tags];
    if (config.layer) this.layer = config.layer;
    if (config.zIndex !== undefined) this.pixiObj.zIndex = config.zIndex;
    if (config.zOffset !== undefined) this._zOffset = config.zOffset;
    (this.pixiObj as any)._sparkZOffset = this._zOffset;

    if (config.x !== undefined) this.pixiObj.x = config.x;
    if (config.y !== undefined) this.pixiObj.y = config.y;
    if (config.rotation !== undefined) this.pixiObj.rotation = config.rotation;
    if (config.width !== undefined) {
      this.pixiObj.width = config.width;
    }
    if (config.height !== undefined) {
      this.pixiObj.height = config.height;
    }
    if (config.scale !== undefined) {
      this.pixiObj.scale.set(config.scale);
    }
    if (config.visible !== undefined) {
      this.pixiObj.visible = config.visible;
    }
    if (config.blendMode) {
      const resolved = resolveBlendMode(config.blendMode);
      if (resolved) {
        (this.pixiObj as any).blendMode = resolved;
      } else {
        console.warn(`Unknown blendMode: "${config.blendMode}"`);
      }
    }
    if (config.tint !== undefined) {
      (this.pixiObj as any).tint = config.tint;
    }
    if (config.alpha !== undefined) {
      this.pixiObj.alpha = config.alpha;
    }
  }

  /** Whether this entity has been destroyed. Safe to check after scene switches. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  get x(): number {
    if (this._destroyed) return 0;
    return this.pixiObj.x;
  }

  set x(value: number) {
    if (this._destroyed) return;
    this.pixiObj.x = value;
  }

  get y(): number {
    if (this._destroyed) return 0;
    return this.pixiObj.y;
  }

  set y(value: number) {
    if (this._destroyed) return;
    this.pixiObj.y = value;
  }

  get rotation(): number {
    if (this._destroyed) return 0;
    return this.pixiObj.rotation;
  }

  set rotation(value: number) {
    if (this._destroyed) return;
    this.pixiObj.rotation = value;
  }

  get scale(): number {
    if (this._destroyed) return 1;
    return this.pixiObj.scale.x;
  }

  set scale(value: number) {
    if (this._destroyed) return;
    this.pixiObj.scale.set(value);
  }

  get visible(): boolean {
    if (this._destroyed) return false;
    return this.pixiObj.visible;
  }

  set visible(value: boolean) {
    if (this._destroyed) return;
    this.pixiObj.visible = value;
  }

  get width(): number {
    if (this._destroyed) return 0;
    return this.pixiObj.width;
  }

  set width(value: number) {
    if (this._destroyed) return;
    this.pixiObj.width = value;
  }

  get height(): number {
    if (this._destroyed) return 0;
    return this.pixiObj.height;
  }

  set height(value: number) {
    if (this._destroyed) return;
    this.pixiObj.height = value;
  }

  /** Render order within the layer. Higher values render on top. */
  get zIndex(): number {
    return this.pixiObj.zIndex ?? 0;
  }

  set zIndex(value: number) {
    this.pixiObj.zIndex = value;
  }

  /**
   * Y-sort depth offset. When `camera.setSortByY(true)` is enabled, the
   * effective zIndex is `entity.y + entity.zOffset`. Use this for multi-part
   * furniture (e.g. sofa arm always renders above the player regardless of y).
   */
  get zOffset(): number {
    return this._zOffset;
  }

  set zOffset(value: number) {
    if (this._destroyed) return;
    this._zOffset = value;
    (this.pixiObj as any)._sparkZOffset = value;
  }

  setTexture(texture: Texture): void {
    if (this._destroyed) return;
    if (this.type === "sprite" && this.pixiObj instanceof Sprite) {
      this.pixiObj.texture = texture;
      this.pixiObj.visible = true;
    }
  }

  addChild(child: Entity): void {
    if (this._destroyed) return;
    if (this.pixiObj instanceof Container) {
      this.pixiObj.addChild(child.pixiObj);
      this._children.push(child);
    }
  }

  removeChild(child: Entity): void {
    if (this._destroyed) return;
    if (this.pixiObj instanceof Container) {
      this.pixiObj.removeChild(child.pixiObj);
      const idx = this._children.indexOf(child);
      if (idx !== -1) this._children.splice(idx, 1);
    }
  }

  /**
   * Track a child entity for lifecycle management WITHOUT adding it to the
   * Pixi container. The child renders independently in the world layer so
   * it gets its own global zIndex (critical for isometric depth sorting
   * where e.g. a chair arm must render above an avatar on the same tile).
   */
  trackChild(child: Entity): void {
    if (this._destroyed) return;
    this._children.push(child);
  }

  /** Remove a tracked child from lifecycle management (no Pixi detach). */
  untrackChild(child: Entity): void {
    if (this._destroyed) return;
    const idx = this._children.indexOf(child);
    if (idx !== -1) this._children.splice(idx, 1);
  }

  get children(): readonly Entity[] {
    return this._children;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    // Destroy all children first
    for (const child of this._children) {
      child.destroy();
    }
    this._children = [];

    this.pixiObj.destroy({ children: true });
  }
}
