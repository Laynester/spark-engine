/**
 * Type declarations for @spark/runtime.
 * Registered with Monaco's TypeScript language service to provide intellisense
 * when editing game scripts that import from "@spark/runtime".
 *
 * Keep in sync with packages/runtime/src/ when the API changes.
 */
export const RUNTIME_TYPES = `
  // ── EventBus ──
  declare interface RuntimeEventMap {
    "package:loaded": [manifest: Record<string, unknown>];
    "package:error": [error: Error];
    "script:loaded": [name: string];
    "script:error": [name: string, error: Error];
    "entity:spawned": [id: string];
    "entity:destroyed": [id: string];
    "asset:loaded": [path: string];
    "asset:error": [path: string, error: Error];
    "ready": [];
    "update": [dt: number];
    "start": [];
    "stop": [];
    "click": [id: string];
    "pointerdown": [id: string];
    "pointerup": [id: string];
    "pointermove": [id: string, x: number, y: number];
  }

  declare class EventBus {
    on<K extends keyof RuntimeEventMap>(event: K, callback: (...args: RuntimeEventMap[K]) => void): void;
    off<K extends keyof RuntimeEventMap>(event: K, callback: (...args: RuntimeEventMap[K]) => void): void;
    emit<K extends keyof RuntimeEventMap>(event: K, ...args: RuntimeEventMap[K]): void;
    once<K extends keyof RuntimeEventMap>(event: K, callback: (...args: RuntimeEventMap[K]) => void): void;
    removeAllListeners(): void;
  }

  // ── Global spark instance ──
  declare const spark: EventBus;

  // ── SparkRuntime ──
  declare interface SparkConfig {
    view: HTMLCanvasElement;
    width?: number;
    height?: number;
    backgroundColor?: number;
  }

  declare interface EntityConfig {
    texture?: string;
    x?: number;
    y?: number;
    rotation?: number;
    scale?: number;
    visible?: boolean;
  }

  declare interface TextConfig {
    text: string;
    fontSize?: number;
    fill?: number;
    fontFamily?: string;
  }

  // ── Spark API (the object passed to game class constructors) ──
  declare class SparkAPI {
    spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity;
    destroy(entity: Entity): void;
    loadAsset(path: string): Promise<Blob | undefined>;
    loadPackage(url: string): Promise<LoadedPackage>;
    import(qualified: string): Promise<ScriptClass>;
    loadScript(path: string): Promise<ScriptInstance>;
    on(event: string, callback: (...args: any[]) => void): void;
    once(event: string, callback: (...args: any[]) => void): void;
    emit(event: string, ...args: any[]): void;
    readonly baseUrl: string;
  }

  declare interface ScriptClass {
    new (spark: SparkAPI): Record<string, unknown>;
    onCreate?(): void;
    onUpdate?(dt: number): void;
    onDestroy?(): void;
    onClick?(): void;
  }

  declare interface ScriptInstance {
    readonly name: string;
    readonly path: string;
    readonly namespace: string;
    readonly instance: unknown;
    onCreate?(): void;
    onUpdate?(dt: number): void;
    onDestroy?(): void;
    onClick?(): void;
  }

  declare interface PackageManifest {
    sparkVersion: string;
    name: string;
    version: string;
    entryScripts: string[];
    assets: string[];
    createdAt: string;
  }

  declare interface LoadedPackage {
    manifest: PackageManifest;
    getFile(path: string): Blob | undefined;
    getText(path: string): Promise<string | undefined>;
  }

  declare interface InputHandler {
    onClick?(id: string): void;
    onPointerDown?(id: string): void;
    onPointerUp?(id: string): void;
  }

  declare class Entity {
    readonly id: string;
    readonly type: "sprite" | "container" | "text";
    x: number;
    y: number;
    rotation: number;
    scale: number;
    visible: boolean;
    readonly width: number;
    readonly height: number;
    setTexture(texture: unknown): void;
    addChild(child: Entity): void;
    removeChild(child: Entity): void;
    readonly children: readonly Entity[];
    destroy(): void;
  }

  declare class SparkRuntime implements InputHandler {
    readonly events: EventBus;
    readonly loadedPackages: string[];
    constructor(config: SparkConfig);
    loadPackage(file: File | ArrayBuffer): Promise<LoadedPackage>;
    start(): Promise<void>;
    stop(): void;
    spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity;
    destroy(entity: Entity): void;
    loadAsset(path: string): Promise<Blob | undefined>;
    loadScript(path: string): Promise<ScriptInstance>;
    importModule(qualified: string): Promise<ScriptClass>;
    getEntity(id: string): Entity | undefined;
    getAllEntities(): Entity[];
    getPackageManifest(namespace: string): PackageManifest | undefined;
    destroyAll(): void;
  }
`;
