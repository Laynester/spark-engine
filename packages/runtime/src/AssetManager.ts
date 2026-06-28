import { Texture } from "pixi.js";
import type { LoadedPackage } from "./PackageLoader";

const TEXTURE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

/**
 * Manages loaded packages and their assets.
 * Textures are preloaded eagerly when a package is added and cached
 * under "namespace:path" keys for instant script access.
 */
export class AssetManager {
  private packages = new Map<string, LoadedPackage>();
  private textureCache = new Map<string, Texture>();
  private blobUrls = new Map<string, string>();

  /** Add a loaded package and preload all its textures immediately. */
  addPackage(pkg: LoadedPackage): void {
    const ns = pkg.manifest.name;
    this.packages.set(ns, pkg);
    this.preloadPackage(pkg);
  }

  /**
   * Preload all textures listed in the package manifest.
   * Assets are cached under "namespace:path" keys (e.g. "clubpenguin:assets/player.png").
   * Non-texture assets are verified but not decoded (audio is preloaded separately).
   */
  private preloadPackage(pkg: LoadedPackage): void {
    const ns = pkg.manifest.name;
    for (const assetPath of pkg.manifest.assets) {
      const cacheKey = `${ns}:${assetPath}`;
      const ext = assetPath.split(".").pop()?.toLowerCase();
      if (ext && TEXTURE_EXTS.has(ext)) {
        console.log(`[Spark Assets] Preloading texture: ${cacheKey}`);
        // Fire-and-forget texture preload — cached once loaded
        this.loadTexture(cacheKey).catch((err) => {
          console.warn(`[Spark Assets] Failed to preload texture: ${cacheKey}`, err);
        });
      }
    }
  }

  /**
   * Find a file across all loaded packages (first match wins).
   * Supports a "namespace:path" format to target a specific package.
   */
  private resolveFile(path: string): { blob: Blob; namespace: string } | undefined {
    const colonIdx = path.indexOf(":");
    if (colonIdx !== -1) {
      // Targeted lookup: "namespace:path/to/file"
      const ns = path.slice(0, colonIdx);
      const filePath = path.slice(colonIdx + 1);
      const pkg = this.packages.get(ns);
      if (!pkg) return undefined;
      const blob = pkg.getFile(filePath);
      return blob ? { blob, namespace: ns } : undefined;
    }

    // Search all packages in order
    for (const [ns, pkg] of this.packages) {
      const blob = pkg.getFile(path);
      if (blob) return { blob, namespace: ns };
    }
    return undefined;
  }

  async loadTexture(path: string): Promise<Texture> {
    const cached = this.textureCache.get(path);
    if (cached) {
      console.log(`[Spark Assets] Texture cache hit: ${path}`);
      return cached;
    }

    if (this.packages.size === 0) {
      throw new Error("No packages loaded");
    }

    const resolved = this.resolveFile(path);
    if (!resolved) {
      throw new Error(`Asset not found: ${path}`);
    }

    const ext = path.split(".").pop()?.toLowerCase() ?? "unknown";
    console.log(`[Spark Assets] Creating texture from blob: ${path} (ext=${ext}, size=${resolved.blob.size} bytes)`);

    try {
      // Use createImageBitmap + Texture.from instead of Assets.load()
      // because blob URLs lack file extensions and Pixi can't pick a parser.
      const bitmap = await createImageBitmap(resolved.blob);
      const texture = Texture.from(bitmap);
      this.textureCache.set(path, texture);
      return texture;
    } catch (error) {
      console.error(`[Spark Assets] Failed to create texture: ${path}`, error);
      throw error;
    }
  }

  getTexture(path: string): Texture | undefined {
    return this.textureCache.get(path);
  }

  /** Get the dimensions of a loaded texture, or null if not yet cached. */
  getTextureSize(path: string): { width: number; height: number } | null {
    const texture = this.textureCache.get(path);
    if (!texture) return null;
    return { width: texture.width, height: texture.height };
  }

  async loadAsset(path: string): Promise<Blob | undefined> {
    if (this.packages.size === 0) {
      throw new Error("No packages loaded");
    }
    const resolved = this.resolveFile(path);
    return resolved?.blob;
  }

  hasAsset(path: string): boolean {
    return this.resolveFile(path) !== undefined;
  }

  cleanup(): void {
    // Destroy all textures
    for (const texture of this.textureCache.values()) {
      texture.destroy(true);
    }
    this.textureCache.clear();

    this.packages.clear();
  }
}
