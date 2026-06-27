import type { Texture } from "pixi.js";
import type { Entity } from "./Entity";
import type {
  EntityConfig,
  PrefabDefinition,
  PrefabFrame,
  PrefabPart,
  PrefabVariant,
  TextConfig,
} from "./types";

export interface PrefabSpawnConfig {
  x?: number;
  y?: number;
  id?: string;
  /** Which variant to use. Defaults to the first variant if the prefab has variants. */
  variant?: string;
  /** Which state to use. Defaults to the first state or the definition's defaultState. */
  state?: string;
}

/** Maps user-friendly blend mode names to Pixi v8 blend mode strings. */
const BLEND_MODE_MAP: Record<string, string> = {
  normal: "normal",
  add: "add",
  additive: "add",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** Resolve a user-supplied blend mode string to a Pixi v8 blend mode. */
function resolveBlendMode(raw: string): string | undefined {
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "-");
  return BLEND_MODE_MAP[key];
}

interface InstanceMeta {
  name: string;
  variant: string;
  state: string;
}

/** Runtime tracking for an actively animating part. */
interface ActiveAnimation {
  entity: Entity;
  frames: PrefabFrame[];
  /** Preloaded textures for each frame (undefined while loading). */
  textures: (Texture | undefined)[];
  frameRate: number;
  loop: boolean;
  currentFrame: number;
  elapsed: number;
  prefabName: string;
  /** Whether all textures have been loaded. */
  ready: boolean;
}

/**
 * Manages prefab definitions and instantiation. A prefab is a reusable
 * template that spawns multiple child entities as a single group — like
 * a multi-layered furniture piece in Habbo Hotel.
 *
 * Supports:
 * - **Variants** — rotation states (north, east, south, west)
 * - **States** — logical conditions (off, on, flickering) nested under variants
 * - **Frame animation** — parts can have `frames` with per-frame texture/alpha/tint/blendMode overrides
 *
 * Variants and states can be switched at runtime via `setVariant()` and `setState()`.
 */
export class PrefabManager {
  private spawnEntity: (
    config: EntityConfig & { text?: TextConfig },
    id?: string,
  ) => Entity;
  private destroyEntity: (entity: Entity) => void;
  private loadTexture: (path: string) => Promise<Texture>;
  private definitions = new Map<string, PrefabDefinition>();
  /** Tracks which prefab + variant + state each entity instance was spawned from. */
  private instances = new WeakMap<Entity, InstanceMeta>();
  /** Actively animating parts (entities with frames). */
  private animations = new Map<Entity, ActiveAnimation>();

  constructor(deps: {
    spawnEntity: (
      config: EntityConfig & { text?: TextConfig },
      id?: string,
    ) => Entity;
    destroyEntity: (entity: Entity) => void;
    loadTexture: (path: string) => Promise<Texture>;
  }) {
    this.spawnEntity = deps.spawnEntity;
    this.destroyEntity = deps.destroyEntity;
    this.loadTexture = deps.loadTexture;
  }

  /** Register a prefab definition. Overwrites any existing definition with the same name. */
  define(name: string, definition: PrefabDefinition): void {
    if (!definition.name) {
      throw new Error(
        `Invalid prefab definition for "${name}": must have a "name"`,
      );
    }
    if (
      !Array.isArray(definition.parts) &&
      !definition.variants
    ) {
      throw new Error(
        `Invalid prefab definition for "${name}": must have "parts" or "variants"`,
      );
    }
    if (definition.variants) {
      for (const [variantName, variant] of Object.entries(
        definition.variants,
      )) {
        if (!Array.isArray(variant.parts) && !variant.states) {
          throw new Error(
            `Invalid variant "${variantName}" in prefab "${name}": must have "parts" or "states"`,
          );
        }
        if (variant.states) {
          for (const [stateName, state] of Object.entries(variant.states)) {
            if (!Array.isArray(state.parts)) {
              throw new Error(
                `Invalid state "${stateName}" in variant "${variantName}" of prefab "${name}": must have a "parts" array`,
              );
            }
          }
        }
      }
    }
    this.definitions.set(name, { ...definition });
  }

  /** Get a registered prefab definition, or undefined if not found. */
  getDefinition(name: string): PrefabDefinition | undefined {
    return this.definitions.get(name);
  }

  /** All registered prefab names. */
  get names(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * Spawn a prefab instance. Creates a Container entity as the parent,
   * spawns child sprite entities for each part, and applies per-part
   * overrides (alpha, tint, blendMode, zOffset, etc.).
   *
   * If the prefab has variants, pass `config.variant` to select one.
   * If the variant has states, pass `config.state` to select one.
   */
  spawn(name: string, config?: PrefabSpawnConfig): Entity {
    const def = this.definitions.get(name);
    if (!def) {
      throw new Error(
        `Prefab not defined: "${name}". Register it with spark.prefab.define() first.`,
      );
    }

    const variantName = config?.variant ?? this._firstVariant(def);
    const resolvedVariant = this._resolveVariant(def, variantName);
    const stateName =
      config?.state ?? this._resolveDefaultState(def, resolvedVariant);
    const parts = this._resolveParts(resolvedVariant, stateName, def.name);

    const hitbox = resolvedVariant.hitbox ?? def.hitbox;
    const tags =
      resolvedVariant.tags ?? (def.tags ? [...def.tags] : undefined);
    const layer = resolvedVariant.layer ?? def.layer ?? "world";

    const parent = this.spawnEntity(
      {
        x: config?.x ?? 0,
        y: config?.y ?? 0,
        hitbox,
        tags,
        layer,
      },
      config?.id,
    );

    this._spawnParts(parent, parts, def.name);

    this.instances.set(parent, {
      name,
      variant: variantName,
      state: stateName,
    });
    return parent;
  }

  /**
   * Switch a prefab instance to a different variant at runtime.
   * Destroys the current children and spawns the new variant's parts.
   * Preserves the current state if the new variant has the same state key.
   */
  setVariant(entity: Entity, variant: string): void {
    const meta = this.instances.get(entity);
    if (!meta) {
      console.warn(
        "[Prefab] setVariant called on an entity that is not a prefab instance",
      );
      return;
    }

    const def = this.definitions.get(meta.name);
    if (!def) return;

    const resolvedVariant = this._tryResolveVariant(def, variant);
    if (!resolvedVariant) {
      if (def.variants) {
        console.warn(
          `[Prefab] Variant "${variant}" not found in "${meta.name}". Available: ${Object.keys(def.variants).join(", ")}`,
        );
      }
      return;
    }

    // Try to keep the current state, fall back to default
    const stateName = this._resolveStateKey(
      resolvedVariant,
      meta.state,
      def.name,
      variant,
    );
    const parts = this._resolveParts(resolvedVariant, stateName, def.name);

    this._destroyChildren(entity);
    this._spawnParts(entity, parts, def.name);

    this.instances.set(entity, {
      name: meta.name,
      variant,
      state: stateName,
    });
  }

  /** Get the current variant name of a prefab instance. */
  getVariant(entity: Entity): string | undefined {
    return this.instances.get(entity)?.variant;
  }

  /**
   * Switch a prefab instance to a different state at runtime.
   * Destroys the current children and spawns the new state's parts.
   * Operates within the current variant.
   */
  setState(entity: Entity, state: string): void {
    const meta = this.instances.get(entity);
    if (!meta) {
      console.warn(
        "[Prefab] setState called on an entity that is not a prefab instance",
      );
      return;
    }

    const def = this.definitions.get(meta.name);
    if (!def) return;

    const resolvedVariant = this._resolveVariant(def, meta.variant);

    // Resolve the state key through the same fallback logic so tracking is consistent
    const stateName = this._resolveStateKey(
      resolvedVariant,
      state,
      def.name,
      meta.variant,
    );
    const parts = this._resolveParts(resolvedVariant, stateName, def.name);

    this._destroyChildren(entity);
    this._spawnParts(entity, parts, def.name);

    this.instances.set(entity, {
      name: meta.name,
      variant: meta.variant,
      state: stateName,
    });
  }

  /** Get the current state name of a prefab instance. */
  getState(entity: Entity): string | undefined {
    return this.instances.get(entity)?.state;
  }

  /**
   * Destroy a prefab instance. Delegates to the runtime's destroy, which
   * recursively removes the entity and all children from the entity map.
   * Also cleans up any active animations.
   */
  destroy(entity: Entity): void {
    for (const child of entity.children) {
      this.animations.delete(child);
    }
    this.animations.delete(entity);
    this.instances.delete(entity);
    this.destroyEntity(entity);
  }

  /**
   * Called every frame by the runtime's update loop.
   * Advances frame animations for all animated parts.
   *
   * `dt` is PixiJS ticker.deltaTime (frames relative to target FPS).
   * At 60fps target, dt=1 for one frame, dt=2 for two frames' worth of time.
   * We convert to seconds assuming 60fps target.
   */
  update(dt: number): void {
    const seconds = dt / 60;

    for (const [entity, anim] of this.animations) {
      if (entity.destroyed) {
        this.animations.delete(entity);
        continue;
      }

      // Skip if textures aren't loaded yet
      if (!anim.ready) {
        this._checkTexturesReady(anim);
        if (!anim.ready) continue;
      }

      anim.elapsed += seconds;
      const frameDuration = 1 / Math.max(anim.frameRate, 1);

      while (anim.elapsed >= frameDuration) {
        anim.elapsed -= frameDuration;
        anim.currentFrame++;

        if (anim.currentFrame >= anim.frames.length) {
          if (anim.loop) {
            anim.currentFrame = 0;
          } else {
            anim.currentFrame = anim.frames.length - 1;
            this.animations.delete(entity);
            break;
          }
        }
      }

      // Apply the current frame's overrides
      const texture = anim.textures[anim.currentFrame];
      const frame = anim.frames[anim.currentFrame];
      if (texture && frame) {
        this._applyFrameOverrides(entity, texture, frame, anim.prefabName);
      }
    }
  }

  // ── private helpers ──────────────────────────────────────────────

  /** Get the first variant name from a definition. */
  private _firstVariant(def: PrefabDefinition): string {
    if (def.variants) {
      const keys = Object.keys(def.variants);
      if (keys.length > 0) return keys[0];
    }
    return "default";
  }

  /** Get the default state for a variant, respecting the definition's defaultState. */
  private _resolveDefaultState(
    def: PrefabDefinition,
    variant: PrefabVariant,
  ): string {
    if (!variant.states) return "default";

    if (def.defaultState && variant.states[def.defaultState]) {
      return def.defaultState;
    }

    const keys = Object.keys(variant.states);
    if (keys.length > 0) return keys[0];
    return "default";
  }

  /** Resolve a variant name to its definition, with fallback. */
  private _resolveVariant(
    def: PrefabDefinition,
    variantName: string,
  ): PrefabVariant {
    const variant = this._tryResolveVariant(def, variantName);
    if (variant) return variant;

    if (def.parts) {
      return { parts: def.parts };
    }
    throw new Error(
      `Prefab "${def.name}" has no parts or variants to resolve`,
    );
  }

  /** Try to resolve a variant, returning null if not found (no fallback, no error). */
  private _tryResolveVariant(
    def: PrefabDefinition,
    variantName: string,
  ): PrefabVariant | null {
    if (def.variants) {
      const variant = def.variants[variantName];
      if (variant) return variant;
      const first = Object.keys(def.variants)[0];
      if (first) {
        console.warn(
          `[Prefab] Variant "${variantName}" not found in "${def.name}", using "${first}"`,
        );
        return def.variants[first];
      }
    }
    return null;
  }

  /** Resolve a state within a variant, with fallback. Returns the resolved state key. */
  private _resolveStateKey(
    variant: PrefabVariant,
    desiredState: string,
    prefabName: string,
    variantName: string,
  ): string {
    if (!variant.states) return "default";

    if (variant.states[desiredState]) return desiredState;

    const first = Object.keys(variant.states)[0];
    if (first) {
      console.warn(
        `[Prefab] State "${desiredState}" not found in variant "${variantName}" of "${prefabName}", using "${first}"`,
      );
      return first;
    }
    return "default";
  }

  /** Resolve the final parts array from a variant + state combo. */
  private _resolveParts(
    variant: PrefabVariant,
    stateName: string,
    prefabName: string,
  ): PrefabPart[] {
    if (variant.states) {
      const state = variant.states[stateName];
      if (state) return state.parts;

      const firstKey = Object.keys(variant.states)[0];
      if (firstKey) {
        console.warn(
          `[Prefab] State "${stateName}" not found in "${prefabName}", using "${firstKey}"`,
        );
        return variant.states[firstKey].parts;
      }
    }

    if (variant.parts) return variant.parts;

    throw new Error(
      `Prefab "${prefabName}" has no parts to resolve for state "${stateName}"`,
    );
  }

  /** Destroy all children of an entity (for variant/state switching). */
  private _destroyChildren(parent: Entity): void {
    const children = [...parent.children];
    for (const child of children) {
      this.animations.delete(child);
      parent.untrackChild(child);
      this.destroyEntity(child);
    }
  }

  /** Spawn all parts as children of a parent entity. */
  private _spawnParts(
    parent: Entity,
    parts: PrefabPart[],
    prefabName: string,
  ): void {
    for (const part of parts) {
      const texture = this._getInitialTexture(part);
      if (!texture) continue;

      const child = this._spawnChild(parent, texture, part);
      if (child) {
        this._applyPartOverrides(child, part, prefabName);

        // Set up frame animation if this part has frames
        if (part.frames && part.frames.length > 1 && part.autoPlay !== false) {
          const anim: ActiveAnimation = {
            entity: child,
            frames: part.frames,
            textures: new Array(part.frames.length),
            frameRate: part.frameRate ?? 8,
            loop: part.loop ?? true,
            currentFrame: 0,
            elapsed: 0,
            prefabName,
            ready: false,
          };
          this.animations.set(child, anim);

          // Preload all frame textures
          this._preloadAnimationTextures(anim);
        }
      }
    }
  }

  /** Get the initial texture path for a part (from texture or frames[0]). */
  private _getInitialTexture(part: PrefabPart): string | undefined {
    if (part.texture) return part.texture;
    if (part.frames && part.frames.length > 0) return part.frames[0].texture;
    return undefined;
  }

  /** Create a single child sprite entity, rendered independently in the world layer. */
  private _spawnChild(
    parent: Entity,
    texture: string,
    part: PrefabPart,
  ): Entity | null {
    const child = this.spawnEntity({
      texture,
      layer: parent.layer,
      x: parent.x + (part.x ?? 0),
      y: parent.y + (part.y ?? 0),
    });
    // Track for lifecycle without nesting in the parent's Pixi container.
    // Children render independently so each part gets its own global zIndex
    // (critical for isometric depth sorting).
    parent.trackChild(child);
    return child;
  }

  /** Apply per-part render overrides (alpha, tint, blendMode, zOffset, etc.). */
  private _applyPartOverrides(
    child: Entity,
    part: PrefabPart,
    prefabName: string,
  ): void {
    const pixi = (child as any).pixiObj;

    if (part.alpha !== undefined) pixi.alpha = part.alpha;
    if (part.tint !== undefined) pixi.tint = part.tint;
    if (part.blendMode) {
      const resolved = resolveBlendMode(part.blendMode);
      if (resolved) {
        pixi.blendMode = resolved;
      } else {
        console.warn(
          `[Prefab] Unknown blendMode "${part.blendMode}" in "${prefabName}", part "${part.texture ?? part.frames?.[0]?.texture}"`,
        );
      }
    }
    if (part.zOffset !== undefined) child.zOffset = part.zOffset;
    if (part.zIndex !== undefined) child.zIndex = part.zIndex;
    if (part.scale !== undefined) child.scale = part.scale;
    if (part.rotation !== undefined) child.rotation = part.rotation;
    if (part.visible !== undefined) child.visible = part.visible;
    if (part.x !== undefined) child.x = part.x;
    if (part.y !== undefined) child.y = part.y;
  }

  /** Apply per-frame overrides during animation. */
  private _applyFrameOverrides(
    child: Entity,
    texture: Texture,
    frame: PrefabFrame,
    prefabName: string,
  ): void {
    const pixi = (child as any).pixiObj;

    // Swap to current frame's texture
    pixi.texture = texture;
    pixi.visible = true;

    if (frame.alpha !== undefined) pixi.alpha = frame.alpha;
    if (frame.tint !== undefined) pixi.tint = frame.tint;
    if (frame.blendMode) {
      const resolved = resolveBlendMode(frame.blendMode);
      if (resolved) {
        pixi.blendMode = resolved;
      } else {
        console.warn(
          `[Prefab] Unknown blendMode "${frame.blendMode}" in "${prefabName}", frame "${frame.texture}"`,
        );
      }
    }
    if (frame.scale !== undefined) child.scale = frame.scale;
    if (frame.rotation !== undefined) child.rotation = frame.rotation;
    if (frame.visible !== undefined) child.visible = frame.visible;
  }

  /** Preload all textures for an animation in the background. */
  private _preloadAnimationTextures(anim: ActiveAnimation): void {
    for (let i = 0; i < anim.frames.length; i++) {
      const frame = anim.frames[i];
      this.loadTexture(frame.texture)
        .then((tex) => {
          anim.textures[i] = tex;
          this._checkTexturesReady(anim);
        })
        .catch((err) => {
          console.warn(
            `[Prefab] Failed to load frame texture "${frame.texture}" in "${anim.prefabName}":`,
            err,
          );
        });
    }
  }

  /** Check if all frame textures have been loaded and mark the animation as ready. */
  private _checkTexturesReady(anim: ActiveAnimation): void {
    if (anim.ready) return;
    for (let i = 0; i < anim.textures.length; i++) {
      if (!anim.textures[i]) return;
    }
    anim.ready = true;
  }
}
