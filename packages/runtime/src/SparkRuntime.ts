import type { SparkConfig, EntityConfig, TextConfig, ScriptClass } from "./types";
import { EventBus } from "./EventBus";
import { loadPackage as loadSprkPackage } from "./PackageLoader";
import type { LoadedPackage, PackageManifest } from "./PackageLoader";
import { AssetManager } from "./AssetManager";
import { ScriptManager } from "./ScriptManager";
import type { ScriptInstance } from "./ScriptManager";
import { Entity } from "./Entity";
import { DisplayTree } from "./DisplayTree";
import { UpdateLoop } from "./UpdateLoop";
import { InputManager } from "./InputManager";
import type { InputHandler } from "./InputManager";
import { spark as globalSpark } from "./global";

export class SparkRuntime implements InputHandler {
  readonly events: EventBus;
  readonly display: DisplayTree;
  readonly assets: AssetManager;
  readonly scripts: ScriptManager;
  readonly input: InputManager;
  readonly updateLoop: UpdateLoop;

  private entities = new Map<string, Entity>();
  private packageRegistry = new Map<string, LoadedPackage>();
  private active = false;
  private initPromise: Promise<void>;
  private sparkAPI: Record<string, unknown>;
  private baseUrl: string = "";

  constructor(config: SparkConfig) {
    this.events = new EventBus();
    this.display = new DisplayTree();
    this.assets = new AssetManager();
    this.scripts = new ScriptManager();
    this.input = new InputManager();
    this.updateLoop = new UpdateLoop();

    // Build the scripts API surface
    this.sparkAPI = {
      spawn: this.spawn.bind(this),
      destroy: this.destroy.bind(this),
      loadAsset: this.loadAsset.bind(this),
      loadPackage: this.loadPackageUrl.bind(this),
      import: this.importModule.bind(this),
      loadScript: this.loadScript.bind(this),
      on: this.events.on.bind(this.events),
      once: this.events.once.bind(this.events),
      emit: this.events.emit.bind(this.events),
      baseUrl: this.baseUrl,
    };

    this.input.setHandler(this);

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

      this.events.emit("package:loaded", pkg.manifest as unknown as Record<string, unknown>);
      return pkg;
    } catch (error) {
      this.events.emit("package:error", error as Error);
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.initPromise;

    // Always run entry scripts for any unstarted namespaces (idempotent for already-started ones)
    const allInstances: ScriptInstance[] = [];
    for (const ns of this.scripts.getLoadedNamespaces()) {
      const instances = await this.scripts.createEntryInstances(ns, this.sparkAPI);
      allInstances.push(...instances);
    }

    if (allInstances.length > 0) {
      // Register update callbacks for new instances
      for (const inst of allInstances) {
        if (inst.onUpdate) {
          this.updateLoop.add(inst.onUpdate);
        }
      }

      // Fire onCreate for new instances only
      await this.scripts.callOnCreate(allInstances);
    }

    // Only initialize loop + input once
    if (this.active) return;
    this.active = true;

    // Wire global spark events
    this.updateLoop.add(this._forwardUpdate);

    this.updateLoop.start();
    this.input.enable();

    this.events.emit("start");
    globalSpark.emit("ready");
  }

  private _forwardUpdate = (dt: number) => {
    globalSpark.emit("update", dt);
  };

  stop(): void {
    if (!this.active) return;
    this.active = false;

    this.updateLoop.remove(this._forwardUpdate);
    this.updateLoop.stop();
    this.input.disable();
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
    this.display.stage.addChild(entity.pixiObj);

    this.events.emit("entity:spawned", entity.id);
    return entity;
  }

  destroy(entity: Entity): void {
    entity.destroy();
    this.entities.delete(entity.id);
    this.events.emit("entity:destroyed", entity.id);
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
      instance.onCreate?.();
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
      (this.sparkAPI as any).baseUrl = this.baseUrl;
    }

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
      (this.sparkAPI as any).baseUrl = this.baseUrl;
    }

    return pkg;
  }

  /** Cross-package import: spark.import("library:scripts/Manager.js") → ScriptClass singleton */
  async importModule(qualified: string): Promise<ScriptClass> {
    await this.initPromise;
    return this.scripts.importModule(qualified);
  }

  // Input handler implementation
  onClick(id: string): void {
    this.scripts.callOnClick();
    this.events.emit("click", id);
  }

  onPointerDown(id: string): void {
    this.events.emit("pointerdown", id);
  }

  onPointerUp(id: string): void {
    this.events.emit("pointerup", id);
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

    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();

    this.display.destroy();
    this.events.removeAllListeners();
    this.packageRegistry.clear();
  }
}
