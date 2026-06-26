import { Entity } from "./Entity";
import { LoadedPackage } from "./PackageLoader";
import { ScriptInstance } from "./ScriptManager";

export interface SparkConfig {
  view: HTMLCanvasElement;
  width?: number;
  height?: number;
  backgroundColor?: number;
}

export interface EntityConfig {
  texture?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
  visible?: boolean;
}

export interface TextConfig {
  text: string;
  fontSize?: number;
  fill?: number;
  fontFamily?: string;
}

export interface ScriptClass {
  new(spark: Record<string, unknown>): Record<string, unknown>;
  onCreate?(): void;
  onUpdate?(dt: number): void;
  onDestroy?(): void;
  onClick?(): void;
}

export interface SparkAPI {
  spawn(config: EntityConfig & { text?: TextConfig }, id?: string): Entity;
  destroy(entity: Entity): void;
  loadAsset(path: string): Promise<Blob | undefined>;
  loadPackage(url: string): Promise<LoadedPackage>;
  import(qualified: string): Promise<any>;
  loadScript(path: string): Promise<ScriptInstance>;
  on(event: string, callback: (...args: any[]) => void): void;
  once(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
  readonly baseUrl: string;
}