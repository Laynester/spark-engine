import type { SparkConfig, EntityConfig, TextConfig, ScriptClass, SparkAPI } from "./types";
import { EventBus } from "./EventBus";
import { loadPackage as loadSprkPackage } from "./PackageLoader";
import type { LoadedPackage, PackageManifest } from "./PackageLoader";
import { AssetManager } from "./AssetManager";
import { ScriptManager } from "./ScriptManager";
import type { ScriptInstance } from "./ScriptManager";
import { Entity } from "./Entity";
import { Sprite, Texture } from "pixi.js";
import { DisplayTree } from "./DisplayTree";
import { UpdateLoop } from "./UpdateLoop";
import { InputManager } from "./InputManager";
import type { InputHandler } from "./InputManager";
import { spark as globalSpark } from "./types";
import { SparkAPIObject } from "./SparkAPIObject";
import { KeyboardManager } from "./KeyboardManager";
import { AudioManager } from "./AudioManager";
import { SceneManager } from "./SceneManager";
import type { SceneDefinition } from "./SceneManager";
import { Camera } from "./Camera";
import { CollisionManager } from "./CollisionManager";
import { PrefabManager } from "./PrefabManager";

export class SparkRuntime implements InputHandler {
  readonly events: EventBus;
  readonly display: DisplayTree;
  readonly assets: AssetManager;
  readonly scripts: ScriptManager;
  readonly input: InputManager;
  readonly updateLoop: UpdateLoop;
  readonly keyboard: KeyboardManager;
  readonly audio: AudioManager;
  readonly scene: SceneManager;
  readonly camera: Camera;
  readonly collision: CollisionManager;
  readonly prefab: PrefabManager;

  private entities = new Map<string, Entity>();
  private packageRegistry = new Map<string, LoadedPackage>();
  private active = false;
  private initPromise: Promise<void>;
  private sparkAPI: SparkAPI;
  baseUrl: string = "";

  constructor(config: SparkConfig) {
    this.events = new EventBus();
    this.display = new DisplayTree();
    this.assets = new AssetManager();
    this.scripts = new ScriptManager();
    this.input = new InputManager();
    this.updateLoop = new UpdateLoop();
    this.keyboard = new KeyboardManager();
    this.audio = new AudioManager();
    // Build the scripts API surface (class-backed — no .bind() needed)
    this.sparkAPI = new SparkAPIObject(this);

    this.scene = new SceneManager({
      spawnEntity: (config, id) => this.spawn(config, id),
      destroyEntity: (entity) => this.destroy(entity),
      loadScriptFile: (path, ns) => this.scripts.loadScript(path, ns),
      createScriptInstance: (path, ns, api) => this.scripts.createInstance(path, ns, api),
      callOnCreate: (instances) => this.scripts.callOnCreate(instances),
      addUpdateCallback: (cb) => this.updateLoop.add(cb),
      removeUpdateCallback: (cb) => this.updateLoop.remove(cb),
      sparkAPI: this.sparkAPI,
    });
    this.camera = new Camera({
      worldLayer: this.display.worldLayer,
      backgroundLayer: this.display.backgroundLayer,
      loadTexture: (path) => this.assets.loadTexture(path),
      getViewportSize: () => ({
        width: this.display.app.renderer.width,
        height: this.display.app.renderer.height,
      }),
    });
    this.collision = new CollisionManager({
      getAllEntities: () => this.getAllEntities(),
    });
    this.prefab = new PrefabManager({
      spawnEntity: (config, id) => this.spawn(config, id),
      destroyEntity: (entity) => this.destroy(entity),
      loadTexture: (path) => this.assets.loadTexture(path),
    });

    this.input.setHandler(this);

    // Wire keyboard events through the runtime's EventBus
    this.keyboard.setEmitter((event, ...args) => {
      (this.events.emit as any)(event, ...args);
    });

    // Give AudioManager access to the asset loader
    this.audio.setAssetLoader((path) => this.assets.loadAsset(path));

    // Kick off async init, store the promise so start() can await it
    this.initPromise = this.init(config);
  }

  private async init(config: SparkConfig): Promise<void> {
    await this.display.init(config);
    this.input.setStage(this.display.stage);
    this.updateLoop.setTicker(this.display.app.ticker);
  }

  async loadPackage(file: File | ArrayBuffer): Promise<LoadedPackage> {
    await this.initPromise;

    try {
      const pkg = await loadSprkPackage(file);

      this.packageRegistry.set(pkg.manifest.name, pkg);
      this.assets.addPackage(pkg);
      this.scripts.addPackage(pkg);

      // Preload audio in background (non-blocking, fire-and-forget)
      this.audio.preloadPackage(pkg.manifest).catch((err) => {
        console.warn("[Spark] Audio preload failed:", err);
      });

      // Auto-register prefab definitions from the package
      if (pkg.manifest.prefabs) {
        for (const prefabDef of pkg.manifest.prefabs) {
          this.prefab.define(prefabDef.name, prefabDef, pkg.manifest.name);
        }
      }

      // Run entry scripts for newly loaded package if runtime is already active.
      // (start() only runs for packages loaded before the initial start.)
      if (this.active) {
        await this._startPackageEntryScripts(pkg.manifest.name);
      }

      this.events.emit("package:loaded", pkg.manifest as unknown as Record<string, unknown>);
      return pkg;
    } catch (error) {
      this.events.emit("package:error", error as Error);
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.initPromise;

    // Only initialize loop + input once
    if (this.active) return;
    this.active = true;

    // Always run entry scripts for any unstarted namespaces (idempotent for already-started ones)
    for (const ns of this.scripts.getLoadedNamespaces()) {
      await this._startPackageEntryScripts(ns);
    }

    // Wire global spark events
    this.updateLoop.add(this._forwardUpdate);

    // Drive prefab frame animations
    this.updateLoop.add(this._prefabUpdate);

    this.updateLoop.start();
    this.input.enable();
    this.keyboard.enable();

    // Clear one-shot key states (pressed/released) after each frame
    this.updateLoop.addPost(this._keyboardEndFrame);

    // Apply camera follow + bounds each frame
    this.updateLoop.addPost(this._cameraUpdate);

    this.events.emit("start");
    globalSpark.emit("ready");
  }

  private _forwardUpdate = (dt: number) => {
    globalSpark.emit("update", dt);
  };

  private _keyboardEndFrame = () => {
    this.keyboard.endFrame();
  };

  private _prefabUpdate = (dt: number) => {
    this.prefab.update(dt);
  };

  /**
   * Run entry scripts for a namespace package and return the number of
   * instances created. Idempotent — skips already-started packages.
   */
  private async _startPackageEntryScripts(namespace: string): Promise<number> {
    const instances = await this.scripts.createEntryInstances(namespace, this.sparkAPI);
    if (instances.length > 0) {
      for (const inst of instances) {
        if (inst.onUpdate) {
          this.updateLoop.add(inst.onUpdate);
        }
      }
      await this.scripts.callOnCreate(instances);
    }
    return instances.length;
  }

  private _cameraUpdate = () => {
    this.camera.update();
  };

  stop(): void {
    if (!this.active) return;
    this.active = false;

    this.updateLoop.remove(this._forwardUpdate);
    this.updateLoop.remove(this._prefabUpdate);
    this.updateLoop.removePost(this._keyboardEndFrame);
    this.updateLoop.removePost(this._cameraUpdate);
    this.updateLoop.stop();
    this.input.disable();
    this.keyboard.disable();
    this.scripts.callOnDestroy();

    this.events.emit("stop");
  }

  spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity {
    const entity = new Entity({ ...config }, id);

    if (config.texture) {
      // Load and set texture asynchronously
      this.assets.loadTexture(config.texture).then((texture) => {
        entity.setTexture(texture);
      }).catch((error) => {
        this.events.emit("asset:error", config.texture!, error as Error);
      });
    }

    this.entities.set(entity.id, entity);
    // Place entity in the correct layer
    const layer = entity.layer === "background" ? this.display.backgroundLayer
      : entity.layer === "ui" ? this.display.uiLayer
        : this.display.worldLayer;
    layer.addChild(entity.pixiObj);

    this.events.emit("entity:spawned", entity.id);
    return entity;
  }

  destroy(entity: Entity): void {
    // Collect all descendant IDs before destroying, so Entity.destroy()
    // handles the pixi hierarchy once without double-destroy.
    const ids = this._collectDescendantIds(entity);
    entity.destroy();
    for (const id of ids) {
      this.entities.delete(id);
      this.events.emit("entity:destroyed", id);
    }
  }

  /** Collect an entity's id and all descendant ids recursively. */
  private _collectDescendantIds(entity: Entity): string[] {
    const ids = [entity.id];
    for (const child of entity.children) {
      ids.push(...this._collectDescendantIds(child));
    }
    return ids;
  }

  setBackgroundColor(color: number): void {
    this.display.setBackgroundColor(color);
  }

  setAntialias(enabled: boolean): void {
    this.display.setAntialias(enabled);
  }

  getTextureSize(path: string): { width: number; height: number } | null {
    return this.assets.getTextureSize(path);
  }

  async loadAsset(path: string): Promise<Blob | undefined> {
    await this.initPromise;

    try {
      const asset = await this.assets.loadAsset(path);
      this.events.emit("asset:loaded", path);
      return asset;
    } catch (error) {
      this.events.emit("asset:error", path, error as Error);
      throw error;
    }
  }

  async loadScript(path: string): Promise<ScriptInstance> {
    await this.initPromise;

    // Determine namespace from path if qualified, otherwise use first loaded package
    const colonIdx = path.indexOf(":");
    let namespace: string;
    let scriptPath: string;
    if (colonIdx !== -1) {
      namespace = path.slice(0, colonIdx);
      scriptPath = path.slice(colonIdx + 1);
    } else {
      // Use the first loaded package as default
      const namespaces = this.scripts.getLoadedNamespaces();
      if (namespaces.length === 0) throw new Error("No packages loaded");
      namespace = namespaces[0];
      scriptPath = path;
    }

    try {
      await this.scripts.loadScript(scriptPath, namespace);
      const instance = this.scripts.createInstance(scriptPath, namespace, this.sparkAPI);
      await this.scripts.callOnCreate([instance]);
      if (instance.onUpdate) {
        this.updateLoop.add(instance.onUpdate);
      }
      this.events.emit("script:loaded", path);
      return instance;
    } catch (error) {
      this.events.emit("script:error", path, error as Error);
      throw error;
    }
  }

  /** Load a .sprk package from a URL or local file path. */
  async loadPackageUrl(url: string): Promise<LoadedPackage> {
    await this.initPromise;


    // Resolve relative URL against baseUrl (set after first package is loaded)
    if (!url.includes("://") && this.baseUrl) {
      url = this.baseUrl + url;
    }

    // Store base URL from the first loaded package for relative resolution
    if (!this.baseUrl) {
      const lastSlash = url.lastIndexOf("/");
      this.baseUrl = url.slice(0, lastSlash + 1);
    }

    console.log(url)

    // file:// URL — use Tauri's readFile if available (set by PlayerPanel)
    if (url.startsWith("file://")) {
      const readFile = (window as any).__SPARK_READ_FILE__;
      if (!readFile) {
        throw new Error(
          "file:// requires Tauri. Set window.__SPARK_READ_FILE__ to a function that " +
          "takes a path and returns a base64 string."
        );
      }
      const path = url.slice(7); // strip file://
      const b64: string = await readFile(path);
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const pkg = await this.loadPackage(bytes.buffer);

      return pkg;
    }

    // http/https URL — standard fetch
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch package: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const pkg = await this.loadPackage(buffer);

    // Store base URL from the first loaded package for relative resolution
    if (!this.baseUrl) {
      const lastSlash = url.lastIndexOf("/");
      this.baseUrl = url.slice(0, lastSlash + 1);
    }

    return pkg;
  }

  /** Cross-package import: spark.import("library:scripts/Manager.js") → ScriptClass singleton */
  async importModule(qualified: string): Promise<ScriptClass> {
    await this.initPromise;
    return this.scripts.importModule(qualified);
  }

  // Input handler implementation
  onClick(id: string, localX?: number, localY?: number): void {
    const entity = this.entities.get(id);

    // Pixel-perfect check: if enabled, verify click hit a non-transparent pixel
    if (entity && entity.pixelPerfect) {
      if (!this._isPixelHit(entity, localX, localY)) return;
    }

    entity?.onClick?.(entity);
    this.scripts.callOnClick();
    this.events.emit("click", id);
  }

  onPointerDown(id: string, localX?: number, localY?: number): void {
    const entity = this.entities.get(id);

    if (entity && entity.pixelPerfect) {
      if (!this._isPixelHit(entity, localX, localY)) return;
    }

    entity?.onPointerDown?.(entity);
    this.events.emit("pointerdown", id);
  }

  onPointerUp(id: string, localX?: number, localY?: number): void {
    const entity = this.entities.get(id);

    if (entity && entity.pixelPerfect) {
      if (!this._isPixelHit(entity, localX, localY)) return;
    }

    entity?.onPointerUp?.(entity);
    this.events.emit("pointerup", id);
  }

  /**
   * Check whether a click position falls on a non-transparent pixel of the entity's sprite texture.
   * Uses PixiJS's renderer.extract.pixels() for GPU readback.
   */
  private _isPixelHit(entity: Entity, localX?: number, localY?: number): boolean {
    if (localX === undefined || localY === undefined) return true;
    if (entity.type !== "sprite") return true;

    const sprite = entity.pixiObj as Sprite;
    const texture = sprite.texture;
    if (!texture || texture === Texture.WHITE) return true;

    try {
      const extracted = this.display.app.renderer.extract.pixels(texture);
      const pixelData = extracted.pixels;
      const texW = extracted.width;
      const texH = extracted.height;

      // Map from sprite local coords to texture pixel coords, accounting for anchor
      const texX = Math.round(localX + sprite.anchor.x * texW);
      const texY = Math.round(localY + sprite.anchor.y * texH);

      // Out of bounds = no hit
      if (texX < 0 || texX >= texW || texY < 0 || texY >= texH) return false;

      // Check alpha (byte 3 of RGBA pixel)
      const alpha = pixelData[(texY * texW + texX) * 4 + 3];
      return alpha > 128; // semi-transparent threshold
    } catch {
      // Fall back to bounding box on readback error
      return true;
    }
  }

  // Convenience methods
  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  get loadedPackages(): string[] {
    return Array.from(this.packageRegistry.keys());
  }

  getPackageManifest(namespace: string): PackageManifest | undefined {
    return this.packageRegistry.get(namespace)?.manifest;
  }

  destroyAll(): void {
    this.stop();
    this.scripts.cleanup();
    this.assets.cleanup();
    this.input.destroy();
    this.updateLoop.destroy();
    this.keyboard.destroy();
    this.audio.destroy();
    this.camera.destroy();
    this.scene.destroy();

    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();

    this.display.destroy();
    this.events.removeAllListeners();
    this.packageRegistry.clear();
  }
}
