export interface SparkConfig {
  name: string;
  version: string;
  entryScripts: string[];
  scriptDirs?: string[];
  assetDirs: string[];
  outputDir?: string;
}

export interface PackageManifest {
  sparkVersion: string;
  name: string;
  version: string;
  entryScripts: string[];
  assets: string[];
  createdAt: string;
}

export interface BuildResult {
  outputPath: string;
  size: number;
  duration: number;
  entryCount: number;
  assetCount: number;
}
