/**
 * Manages named scenes. Each scene is a self-contained set of entities.
 * Switching scenes destroys only the current scene's entities — global
 * entities (spawned via spark.spawn() directly) survive the switch.
 *
 * Shared state (spark.scene.state) persists across scene switches for
 * things like health, score, inventory.
 */
export class SceneManager {
  private spawnEntity: (config: any, id?: string) => any;
  private destroyEntity: (entity: any) => void;
  private loadScriptFile: (path: string, namespace: string) => Promise<any>;
  private createScriptInstance: (path: string, namespace: string, api: any) => any;
  private callOnCreate: (instances: any[]) => Promise<void>;
  private addUpdateCallback: (cb: (dt: number) => void) => void;
  private removeUpdateCallback: (cb: (dt: number) => void) => void;

  current: string | null = null;
  state: Record<string, any> = {};

  private _sparkAPI: any;
  private sceneDefs = new Map<string, SceneDefinition>();
  private activeInstances: any[] = [];
  private sceneEntities = new Set<any>();

  constructor(deps: {
    spawnEntity: (config: any, id?: string) => any;
    destroyEntity: (entity: any) => void;
    loadScriptFile: (path: string, namespace: string) => Promise<any>;
    createScriptInstance: (path: string, namespace: string, api: any) => any;
    callOnCreate: (instances: any[]) => Promise<void>;
    addUpdateCallback: (cb: (dt: number) => void) => void;
    removeUpdateCallback: (cb: (dt: number) => void) => void;
    /** The public SparkAPI — passed to scene script constructors. */
    sparkAPI: any;
  }) {
    this.spawnEntity = deps.spawnEntity;
    this.destroyEntity = deps.destroyEntity;
    this.loadScriptFile = deps.loadScriptFile;
    this.createScriptInstance = deps.createScriptInstance;
    this.callOnCreate = deps.callOnCreate;
    this.addUpdateCallback = deps.addUpdateCallback;
    this.removeUpdateCallback = deps.removeUpdateCallback;
    this._sparkAPI = deps.sparkAPI;
  }

  /** Register a scene definition. */
  define(sceneId: string, def: SceneDefinition): void {
    this.sceneDefs.set(sceneId, def);
  }

  /**
   * Spawn an entity owned by the current scene. It will be automatically
   * destroyed when the scene is switched. Use spark.spawn() for global entities.
   */
  spawn(config: any, id?: string): any {
    const entity = this.spawnEntity(config, id);
    this.sceneEntities.add(entity);
    return entity;
  }

  /** Get all entities owned by the current scene. */
  getEntities(): any[] {
    return Array.from(this.sceneEntities);
  }

  /** Switch to a scene. Destroys the current scene's entities and spawns the new one. */
  async switch(sceneId: string): Promise<void> {
    const def = this.sceneDefs.get(sceneId);
    if (!def) throw new Error(`Scene not defined: ${sceneId}`);

    // Teardown old scene
    this.teardown();

    // Spawn new scene entities (scene-owned)
    if (def.entities) {
      for (const entConfig of def.entities) {
        this.spawn(entConfig);
      }
    }

    // Run the scene's entry script if specified
    if (def.script) {
      const [namespace, ...pathParts] = def.script.split(":");
      const scriptPath = pathParts.length > 0 ? pathParts.join(":") : namespace;
      const ns = pathParts.length > 0 ? namespace : "";

      // Load and create instance
      const nsKey = ns || "default";
      const ScriptClass = await this.loadScriptFile(scriptPath, nsKey);
      if (ScriptClass) {
        const instance = this.createScriptInstance(scriptPath, nsKey, this._sparkAPI);
        this.activeInstances.push(instance);
        await this.callOnCreate([instance]);
        if (instance.onUpdate) {
          this.addUpdateCallback(instance.onUpdate);
        }
      }
    }

    this.current = sceneId;
  }

  private teardown(): void {
    for (const inst of this.activeInstances) {
      if (inst.onUpdate) {
        this.removeUpdateCallback(inst.onUpdate);
      }
      if (inst.onDestroy) {
        try { inst.onDestroy(); } catch { /* ignore */ }
      }
    }
    this.activeInstances = [];

    // Destroy only scene-owned entities — globals survive
    for (const entity of this.sceneEntities) {
      this.destroyEntity(entity);
    }
    this.sceneEntities.clear();
  }

  /**
   * Destroy a scene-owned entity, or destroy the entire scene manager.
   * - With an entity argument: destroys that entity if scene-owned. No-op otherwise.
   * - With no arguments: tears down the current scene and clears all definitions.
   */
  destroy(entity?: any): void {
    if (entity !== undefined) {
      if (!this.sceneEntities.has(entity)) return;
      this.sceneEntities.delete(entity);
      this.destroyEntity(entity);
    } else {
      this.teardown();
      this.sceneDefs.clear();
      this.state = {};
    }
  }
}

export interface SceneDefinition {
  /** Optional entry script (e.g. "mylib:scenes/town.js"). */
  script?: string;
  /** Entities to spawn when the scene loads. */
  entities?: Array<{
    texture?: string;
    text?: { text: string; fontSize?: number; fill?: number };
    x?: number;
    y?: number;
    tags?: string[];
    hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
    layer?: "background" | "world" | "ui";
  }>;
}
