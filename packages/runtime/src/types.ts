import type { Application, Container } from "pixi.js";
import { Entity } from "./Entity";
import { EventBus } from "./EventBus";
import { LoadedPackage } from "./PackageLoader";
import { ScriptInstance } from "./ScriptManager";
import type { SceneDefinition } from "./SceneManager";

export const spark = new EventBus();

export interface SparkConfig {
  view: HTMLCanvasElement;
  width?: number;
  height?: number;
  backgroundColor?: number;
  /** Enable anti-aliasing (smooth edges). Disable for crisp pixel-art rendering. (default true) */
  antialias?: boolean;
}

export interface EntityConfig {
  texture?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  blendMode?: string;
  tint?: number;
  alpha?: number;
  tags?: string[];
  hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
  layer?: "background" | "world" | "ui";
  /** Render order within the layer. Higher values render on top. */
  zIndex?: number;
  /** Y-sort offset. When camera.setSortByY is enabled, effective zIndex = y + zOffset. */
  zOffset?: number;
  /** Enable pixel-perfect hit detection on this entity (only non-transparent pixels register clicks). */
  pixelPerfect?: boolean;
}

export interface TextConfig {
  text: string;
  fontSize?: number;
  fill?: number;
  fontFamily?: string;
}

export interface PrefabFrame {
  texture: string;
  alpha?: number;
  tint?: number;
  blendMode?: string;
  scale?: number;
  rotation?: number;
  visible?: boolean;
}

export interface PrefabPart {
  /** Static texture — use this OR frames for animation, not both. */
  texture?: string;
  /** Animated frames. When set, the part cycles through these textures at frameRate. */
  frames?: PrefabFrame[];
  /** Frames per second for animation (default 8). */
  frameRate?: number;
  /** Whether the animation loops (default true). */
  loop?: boolean;
  /** Whether to auto-play the animation (default true). */
  autoPlay?: boolean;
  zOffset?: number;
  alpha?: number;
  tint?: number;
  blendMode?: string;
  visible?: boolean;
  scale?: number;
  rotation?: number;
  zIndex?: number;
  x?: number;
  y?: number;
}

export interface PrefabState {
  parts: PrefabPart[];
  hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
  tags?: string[];
  layer?: "background" | "world" | "ui";
}

export interface PrefabVariant {
  /** Flat parts — for simple variants without states. */
  parts?: PrefabPart[];
  /** Named states (e.g. "0", "1", "2") for stateful prefabs. Each state has its own parts. */
  states?: Record<string, PrefabState>;
  hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
  tags?: string[];
  layer?: "background" | "world" | "ui";
}

export interface PrefabDefinition {
  name: string;
  /** Flat parts — for simple prefabs without variants. */
  parts?: PrefabPart[];
  /** Named variants for rotation/animation states. Each variant has its own parts. */
  variants?: Record<string, PrefabVariant>;
  /** Default state to use when spawning (e.g. "0"). Falls back to the first state. */
  defaultState?: string;
  hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
  tags?: string[];
  layer?: "background" | "world" | "ui";
}

export interface ScriptClass {
  new(spark: SparkAPI): Record<string, unknown>;
  onCreate?(): void;
  onUpdate?(dt: number): void;
  onDestroy?(): void;
  onClick?(): void;
}

export interface SparkAPI {
  spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity;
  destroy(entity: Entity): void;
  setBackgroundColor(color: number): void;
  /**
   * Toggle anti-aliasing at runtime.
   *
   * - `true`  → smooth edges (default browser CSS scaling)
   * - `false` → crisp pixel-art edges via CSS `image-rendering: pixelated`
   *
   * For full MSAA antialias control, set `antialias: false` in SparkConfig at init.
   */
  setAntialias(enabled: boolean): void;
  getTextureSize(path: string): { width: number; height: number } | null;
  loadAsset(path: string): Promise<Blob | undefined>;
  loadPackage(url: string): Promise<LoadedPackage>;
  import(qualified: string): Promise<any>;
  loadScript(path: string): Promise<ScriptInstance>;
  on(event: string, callback: (...args: any[]) => void): void;
  once(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  baseUrl: string;
  readonly pixi: {
    readonly app: Application;
    readonly stage: Container;
  };
  readonly keys: {
    isDown(key: string): boolean;
    isPressed(key: string): boolean;
    isReleased(key: string): boolean;
  };
  readonly audio: {
    play(path: string, options?: { volume?: number; loop?: boolean; speed?: number }): Promise<void>;
    stop(path: string): void;
    playMusic(path: string, options?: { volume?: number }): Promise<void>;
    stopMusic(): void;
    setMasterVolume(volume: number): void;
    getMasterVolume(): number;
  };
  readonly scene: {
    define(sceneId: string, def: SceneDefinition): void;
    switch(sceneId: string): Promise<void>;
    spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity;
    destroy(entity: Entity): void;
    getEntities(): Entity[];
    readonly current: string | null;
    readonly state: Record<string, any>;
  };
  readonly camera: {
    follow(entity: Entity | null): void;
    setBounds(x: number, y: number, width: number, height: number): void;
    setBackground(texturePath: string, factorX?: number, factorY?: number): Promise<void>;
    setSortByY(enabled: boolean): void;
    readonly ySortEnabled: boolean;
    x: number;
    y: number;
    zoom: number;
    screenToWorld(screenX: number, screenY: number): { x: number; y: number };
  };
  readonly collision: {
    check(a: Entity, b: Entity): boolean;
    getOverlaps(target: Entity, tag?: string): Entity[];
    checkBox(x: number, y: number, width: number, height: number, tag?: string): Entity[];
  };
  readonly prefab: {
    define(name: string, definition: PrefabDefinition): void;
    spawn(name: string, config?: {
      x?: number;
      y?: number;
      id?: string;
      variant?: string;
      state?: string;
      /** Base zIndex applied to all child parts. */
      zIndex?: number;
    }): Entity;
    destroy(entity: Entity): void;
    /** Move the entire prefab to an absolute position. */
    moveTo(entity: Entity, x: number, y: number): void;
    /** Move the entire prefab by a relative delta. */
    moveBy(entity: Entity, dx: number, dy: number): void;
    setVariant(entity: Entity, variant: string): void;
    getVariant(entity: Entity): string | undefined;
    setState(entity: Entity, state: string): void;
    getState(entity: Entity): string | undefined;
    getDefinition(name: string): PrefabDefinition | undefined;
    readonly names: string[];
  };
}