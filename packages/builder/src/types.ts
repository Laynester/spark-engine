export interface SparkConfig {
  name: string;
  version: string;
  entryScripts: string[];
  scriptDirs?: string[];
  assetDirs: string[];
  /** Directory containing .prefab.json files (default "prefabs"). */
  prefabDir?: string;
  outputDir?: string;
  /** Audio bitrate in kbps for ffmpeg re-encoding (default 128). Set to 0 to skip. */
  audioBitrate?: number;
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

export interface PackageManifest {
  sparkVersion: string;
  name: string;
  version: string;
  entryScripts: string[];
  assets: string[];
  prefabs?: PrefabDefinition[];
  createdAt: string;
}

export interface BuildResult {
  outputPath: string;
  size: number;
  duration: number;
  entryCount: number;
  assetCount: number;
}

export function ensureArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") return [val];
  return [];
}
