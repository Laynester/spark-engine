import { Assets, Texture } from "pixi.js";
import type { LoadedPackage } from "./PackageLoader";

export class AssetManager {
  private packages = new Map<string, LoadedPackage>();
  private textureCache = new Map<string, Texture>();
  private blobUrls = new Map<string, string>();

  addPackage(pkg: LoadedPackage): void {
    const ns = pkg.manifest.name;
    // Don't clean up — just add
    this.packages.set(ns, pkg);
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
    if (cached) return cached;

    if (this.packages.size === 0) {
      throw new Error("No packages loaded");
    }

    const resolved = this.resolveFile(path);
    if (!resolved) {
      throw new Error(`Asset not found: ${path}`);
    }

    const url = URL.createObjectURL(resolved.blob);
    this.blobUrls.set(path, url);

    try {
      const texture = await Assets.load<Texture>(url);
      this.textureCache.set(path, texture);
      return texture;
    } catch (error) {
      URL.revokeObjectURL(url);
      this.blobUrls.delete(path);
      throw error;
    }
  }

  getTexture(path: string): Texture | undefined {
    return this.textureCache.get(path);
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
    // Release all blob URLs
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();

    // Destroy all textures
    for (const texture of this.textureCache.values()) {
      texture.destroy(true);
    }
    this.textureCache.clear();

    this.packages.clear();
  }
}
