import type { EntityConfig, TextConfig, SparkAPI } from "./types";
import type { Entity } from "./Entity";
import type { LoadedPackage } from "./PackageLoader";
import type { ScriptInstance } from "./ScriptManager";
import type { SparkRuntime } from "./SparkRuntime";
import type { KeyboardManager } from "./KeyboardManager";
import type { AudioManager } from "./AudioManager";
import type { SceneManager } from "./SceneManager";
import type { Camera } from "./Camera";
import type { CollisionManager } from "./CollisionManager";
import type { PrefabManager } from "./PrefabManager";

/**
 * The public API surface passed to game scripts via their constructor.
 * Implements SparkAPI by delegating to a SparkRuntime instance.
 *
 * Using a class (rather than a hand-rolled object literal with .bind() calls)
 * means TypeScript enforces the contract, no manual binding is needed, and
 * name remapping (loadPackage → loadPackageUrl) is explicit.
 */
export class SparkAPIObject implements SparkAPI {
  private runtime: SparkRuntime;

  constructor(runtime: SparkRuntime) {
    this.runtime = runtime;
  }

  spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity {
    return this.runtime.spawn(config, id);
  }

  destroy(entity: Entity): void {
    this.runtime.destroy(entity);
  }

  setBackgroundColor(color: number): void {
    this.runtime.setBackgroundColor(color);
  }

  setAntialias(enabled: boolean): void {
    this.runtime.setAntialias(enabled);
  }

  getTextureSize(path: string): { width: number; height: number } | null {
    return this.runtime.getTextureSize(path);
  }

  async loadAsset(path: string): Promise<Blob | undefined> {
    return this.runtime.loadAsset(path);
  }

  /** Load a .sprk package from a URL or local file path. */
  async loadPackage(url: string): Promise<LoadedPackage> {
    return this.runtime.loadPackageUrl(url);
  }

  /** Cross-package import: spark.import("library:scripts/Manager.js") → ScriptClass */
  async import(qualified: string): Promise<unknown> {
    return this.runtime.importModule(qualified);
  }

  async loadScript(path: string): Promise<ScriptInstance> {
    return this.runtime.loadScript(path);
  }

  on(event: string, callback: (...args: any[]) => void): void {
    this.runtime.events.on(event as any, callback);
  }

  once(event: string, callback: (...args: any[]) => void): void {
    this.runtime.events.once(event as any, callback);
  }

  emit(event: string, ...args: any[]): void {
    this.runtime.events.emit(event as any, ...args);
  }

  /** Mirrors the runtime's base URL for relative package resolution. */
  get baseUrl(): string {
    return this.runtime.baseUrl;
  }

  set baseUrl(value: string) {
    this.runtime.baseUrl = value;
  }

  /** Direct access to the Pixi.js Application and stage for low-level control. */
  get pixi() {
    const display = this.runtime.display;
    return {
      get app() {
        return display.app;
      },
      get stage() {
        return display.stage;
      },
    };
  }

  /** Keyboard input — polling-based key state. */
  get keys(): KeyboardManager {
    return this.runtime.keyboard;
  }

  /** Audio — sfx and music via Web Audio API. */
  get audio(): AudioManager {
    return this.runtime.audio;
  }

  /** Scene management — define and switch between named scenes. */
  get scene(): SceneManager {
    return this.runtime.scene;
  }

  /** Camera — viewport control, follow, bounds, zoom, parallax. */
  get camera(): Camera {
    return this.runtime.camera;
  }

  /** Collision — AABB detection between entities. */
  get collision(): CollisionManager {
    return this.runtime.collision;
  }

  /** Prefab — define and spawn multi-part entity templates. */
  get prefab(): PrefabManager {
    return this.runtime.prefab;
  }
}
