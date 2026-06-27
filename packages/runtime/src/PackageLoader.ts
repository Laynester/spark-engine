import JSZip from "jszip";

export interface PackageManifest {
  sparkVersion: string;
  name: string;
  version: string;
  entryScripts: string[];
  assets: string[];
  prefabs?: Array<{
    name: string;
    parts: Array<{
      texture: string;
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
    }>;
    hitbox?: { width: number; height: number; offsetX?: number; offsetY?: number };
    tags?: string[];
    layer?: "background" | "world" | "ui";
  }>;
  createdAt: string;
}

export interface LoadedPackage {
  manifest: PackageManifest;
  files: Map<string, Blob>;
  getFile(path: string): Blob | undefined;
  getText(path: string): Promise<string | undefined>;
}

async function isZip(buffer: ArrayBuffer): Promise<boolean> {
  const view = new Uint8Array(buffer, 0, 4);
  return view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04;
}

export async function loadPackage(file: File | ArrayBuffer): Promise<LoadedPackage> {
  let buffer: ArrayBuffer;

  if (file instanceof File) {
    buffer = await file.arrayBuffer();
  } else {
    buffer = file;
  }

  if (!(await isZip(buffer))) {
    throw new Error("Invalid .sprk file: not a ZIP archive");
  }

  const zip = await JSZip.loadAsync(buffer);
  const files = new Map<string, Blob>();

  const loadPromises: Promise<void>[] = [];
  zip.forEach((relativePath, zipEntry) => {
    loadPromises.push(
      zipEntry.async("blob").then((blob) => {
        files.set(relativePath, blob);
      }),
    );
  });

  await Promise.all(loadPromises);

  const manifestBlob = files.get("manifest.json");
  if (!manifestBlob) {
    throw new Error("Invalid .sprk file: missing manifest.json");
  }

  const manifestText = await manifestBlob.text();
  const manifest: PackageManifest = JSON.parse(manifestText);

  return {
    manifest,
    files,
    getFile(path: string): Blob | undefined {
      return files.get(path);
    },
    async getText(path: string): Promise<string | undefined> {
      const blob = files.get(path);
      if (!blob) return undefined;
      return blob.text();
    },
  };
}
