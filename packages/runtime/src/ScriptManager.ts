import type { LoadedPackage } from "./PackageLoader";
import type { ScriptClass, SparkAPI } from "./types";

export interface ScriptInstance {
  readonly name: string;
  readonly path: string;
  readonly namespace: string;
  readonly instance: unknown;
  onCreate?(): void;
  onUpdate?(dt: number): void;
  onDestroy?(): void;
  onClick?(): void;
}

export class ScriptManager {
  private packages = new Map<string, LoadedPackage>();
  /** namespace → path → blob URL */
  private blobUrls = new Map<string, Map<string, string>>();
  /** namespace → path → ScriptClass (shared — singleton per module) */
  private scriptClasses = new Map<string, Map<string, ScriptClass>>();
  /** Tracks paths that were loaded but have no default export — prevents re-importing */
  private loadedNoExport = new Set<string>();
  private instances: ScriptInstance[] = [];
  /** Packages whose entry scripts have already been started */
  private startedPackages = new Set<string>();

  addPackage(pkg: LoadedPackage): void {
    const ns = pkg.manifest.name;
    if (this.packages.has(ns)) {
      // Already loaded — skip (idempotent)
      return;
    }
    this.packages.set(ns, pkg);
    this.blobUrls.set(ns, new Map());
    this.scriptClasses.set(ns, new Map());
  }

  hasPackage(namespace: string): boolean {
    return this.packages.has(namespace);
  }

  /**
   * Load a script from a specific namespace.
   * If the script has a default export class, it's cached and returned.
   * If not (e.g. `import { spark } ... spark.on(...)` pattern), the module's
   * top-level code still executes, registering event handlers on the global spark.
   * Returns null in that case — no instance is needed.
   */
  async loadScript(path: string, namespace: string): Promise<ScriptClass | null> {
    const nsScripts = this.scriptClasses.get(namespace);
    if (!nsScripts) {
      throw new Error(`Package "${namespace}" is not loaded`);
    }

    // Check caches — ScriptClass for class exports, loadedNoExport for side-effect-only scripts
    const cached = nsScripts.get(path);
    if (cached) return cached;
    if (this.loadedNoExport.has(`${namespace}:${path}`)) return null;

    const pkg = this.packages.get(namespace)!;
    const source = await pkg.getText(path);
    if (!source) {
      throw new Error(`Script not found: ${namespace}:${path}`);
    }

    // Create a blob URL — reusing the same URL gives us browser-module-level singletons
    const blob = new Blob([source], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    this.blobUrls.get(namespace)!.set(path, url);

    try {
      const module = await import(url);
      const ScriptClass = module.default as ScriptClass | undefined;

      if (ScriptClass) {
        nsScripts.set(path, ScriptClass);
      } else {
        // No default export — script's side effects (spark.on, etc.) already ran
        // during import. Cache null to prevent re-importing.
        this.loadedNoExport.add(`${namespace}:${path}`);
      }
      return ScriptClass ?? null;
    } catch (error) {
      URL.revokeObjectURL(url);
      this.blobUrls.get(namespace)!.delete(path);
      throw error;
    }
  }

  /**
   * Resolve a qualified name like "library:scripts/Manager.js"
   * and return the cached ScriptClass.
   */
  async importModule(qualified: string): Promise<ScriptClass> {
    const colonIdx = qualified.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(
        `Invalid import format: "${qualified}". Use "namespace:path" (e.g. "library:scripts/Manager.js")`
      );
    }
    const namespace = qualified.slice(0, colonIdx);
    const path = qualified.slice(colonIdx + 1);

    if (!this.packages.has(namespace)) {
      throw new Error(`Package "${namespace}" is not loaded. Call loadPackage() first.`);
    }

    const ScriptClass = await this.loadScript(path, namespace);
    if (!ScriptClass) {
      throw new Error(
        `Script "${qualified}" has no default export. ` +
        `Use the class-based pattern: export default class MyScript { ... }`
      );
    }
    return ScriptClass;
  }

  createInstance(path: string, namespace: string, sparkAPI: SparkAPI): ScriptInstance {
    const nsScripts = this.scriptClasses.get(namespace);
    if (!nsScripts) {
      throw new Error(`Package "${namespace}" is not loaded`);
    }

    const ScriptClass = nsScripts.get(path);
    if (!ScriptClass) {
      throw new Error(`Script not loaded: ${namespace}:${path}`);
    }

    const instance = new ScriptClass(sparkAPI);

    const scriptInstance: ScriptInstance = {
      name: path.split("/").pop() ?? path,
      path,
      namespace,
      instance,
      onCreate: typeof instance.onCreate === "function" ? instance.onCreate.bind(instance) : undefined,
      onUpdate: typeof instance.onUpdate === "function" ? instance.onUpdate.bind(instance) : undefined,
      onDestroy: typeof instance.onDestroy === "function" ? instance.onDestroy.bind(instance) : undefined,
      onClick: typeof instance.onClick === "function" ? instance.onClick.bind(instance) : undefined,
    };

    this.instances.push(scriptInstance);
    return scriptInstance;
  }

  /**
   * Load and create instances for all entry scripts of a given namespace package.
   * Skips if that namespace's entries were already started.
   */
  async createEntryInstances(namespace: string, sparkAPI: SparkAPI): Promise<ScriptInstance[]> {
    if (this.startedPackages.has(namespace)) {
      return [];
    }

    const pkg = this.packages.get(namespace);
    if (!pkg) return [];

    const entries = pkg.manifest.entryScripts;
    if (entries.length === 0) return [];

    this.startedPackages.add(namespace);
    const instances: ScriptInstance[] = [];

    for (const entry of entries) {
      const ScriptClass = await this.loadScript(entry, namespace);

      // Scripts without a default export (e.g. `import { spark } ... spark.on(...)`)
      // already ran their top-level code during import — no instance to create.
      if (!ScriptClass) continue;

      const instance = new ScriptClass(sparkAPI) as Record<string, unknown>;

      const scriptInstance: ScriptInstance = {
        name: entry.split("/").pop() ?? entry,
        path: entry,
        namespace,
        instance,
        onCreate: typeof instance.onCreate === "function" ? instance.onCreate.bind(instance) : undefined,
        onUpdate: typeof instance.onUpdate === "function" ? instance.onUpdate.bind(instance) : undefined,
        onDestroy: typeof instance.onDestroy === "function" ? instance.onDestroy.bind(instance) : undefined,
        onClick: typeof instance.onClick === "function" ? instance.onClick.bind(instance) : undefined,
      };

      instances.push(scriptInstance);
      this.instances.push(scriptInstance);
    }

    return instances;
  }

  async callOnCreate(instances: ScriptInstance[] = this.instances): Promise<void> {
    const promises: Array<Promise<unknown>> = [];
    for (const inst of instances) {
      const result = inst.onCreate?.();
      if (typeof result === "object" && result !== null && "then" in result) {
        promises.push(result as Promise<unknown>);
      }
    }
    await Promise.all(promises);
  }

  callOnUpdate(dt: number): void {
    for (const inst of this.instances) {
      inst.onUpdate?.(dt);
    }
  }

  callOnClick(): void {
    for (const inst of this.instances) {
      inst.onClick?.();
    }
  }

  callOnDestroy(): void {
    for (const inst of this.instances) {
      inst.onDestroy?.();
    }
  }

  removeInstance(instance: ScriptInstance): void {
    instance.onDestroy?.();
    const idx = this.instances.indexOf(instance);
    if (idx !== -1) this.instances.splice(idx, 1);
  }

  getInstances(): readonly ScriptInstance[] {
    return this.instances;
  }

  getLoadedNamespaces(): string[] {
    return Array.from(this.packages.keys());
  }

  cleanup(): void {
    // Call destroy on all instances
    this.callOnDestroy();
    this.instances = [];

    // Revoke all blob URLs
    for (const urls of this.blobUrls.values()) {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
    }
    this.blobUrls.clear();

    this.scriptClasses.clear();
    this.loadedNoExport.clear();
    this.packages.clear();
    this.startedPackages.clear();
  }
}
