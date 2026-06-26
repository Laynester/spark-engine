import { Container, Sprite, Text, Texture } from "pixi.js";
import type { EntityConfig, TextConfig } from "./types";

export type EntityType = "sprite" | "container" | "text";

export class Entity {
  readonly id: string;
  readonly type: EntityType;
  readonly pixiObj: Container | Sprite | Text;

  private _children: Entity[] = [];

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
    } else {
      // Container entity
      this.pixiObj = new Container();
      this.type = "container";
    }

    this.pixiObj.label = this.id;
    this.pixiObj.eventMode = "static";

    if (config.x !== undefined) this.pixiObj.x = config.x;
    if (config.y !== undefined) this.pixiObj.y = config.y;
    if (config.rotation !== undefined) this.pixiObj.rotation = config.rotation;
    if (config.scale !== undefined) {
      this.pixiObj.scale.set(config.scale);
    }
    if (config.visible !== undefined) {
      this.pixiObj.visible = config.visible;
    }
  }

  get x(): number {
    return this.pixiObj.x;
  }

  set x(value: number) {
    this.pixiObj.x = value;
  }

  get y(): number {
    return this.pixiObj.y;
  }

  set y(value: number) {
    this.pixiObj.y = value;
  }

  get rotation(): number {
    return this.pixiObj.rotation;
  }

  set rotation(value: number) {
    this.pixiObj.rotation = value;
  }

  get scale(): number {
    return this.pixiObj.scale.x;
  }

  set scale(value: number) {
    this.pixiObj.scale.set(value);
  }

  get visible(): boolean {
    return this.pixiObj.visible;
  }

  set visible(value: boolean) {
    this.pixiObj.visible = value;
  }

  get width(): number {
    return this.pixiObj.width;
  }

  get height(): number {
    return this.pixiObj.height;
  }

  setTexture(texture: Texture): void {
    if (this.type === "sprite" && this.pixiObj instanceof Sprite) {
      this.pixiObj.texture = texture;
      this.pixiObj.visible = true;
    }
  }

  addChild(child: Entity): void {
    if (this.pixiObj instanceof Container) {
      this.pixiObj.addChild(child.pixiObj);
      this._children.push(child);
    }
  }

  removeChild(child: Entity): void {
    if (this.pixiObj instanceof Container) {
      this.pixiObj.removeChild(child.pixiObj);
      const idx = this._children.indexOf(child);
      if (idx !== -1) this._children.splice(idx, 1);
    }
  }

  get children(): readonly Entity[] {
    return this._children;
  }

  destroy(): void {
    // Destroy all children first
    for (const child of this._children) {
      child.destroy();
    }
    this._children = [];

    this.pixiObj.destroy({ children: true });
  }
}
