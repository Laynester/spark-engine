import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceProject {
  path: string;
  type: "app" | "lib";
}

export interface WorkspaceManifest {
  spark_version: string;
  name: string;
  entry_project: string | null;
  projects: Record<string, WorkspaceProject>;
  last_opened: string | null;
  /** Canvas width in pixels. When set, the player uses this instead of filling the window. */
  width?: number;
  /** Canvas height in pixels. When set, the player uses this instead of filling the window. */
  height?: number;
}

export interface RecentEntry {
  path: string;
  name: string;
  last_opened: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface DirectoryContents {
  entries: FileEntry[];
  path: string;
}

// Workspace commands
export async function createWorkspace(path: string, name: string): Promise<WorkspaceManifest> {
  return invoke("create_workspace", { path, name });
}

export async function openWorkspace(path: string): Promise<WorkspaceManifest> {
  return invoke("open_workspace", { path });
}

export async function saveWorkspace(path: string, manifest: WorkspaceManifest): Promise<void> {
  return invoke("save_workspace", { path, manifest });
}

export async function findProjects(path: string): Promise<string[]> {
  return invoke("find_projects", { path });
}

// Recent workspaces
export async function listRecentWorkspaces(): Promise<RecentEntry[]> {
  return invoke("list_recent_workspaces");
}

export async function addRecentWorkspace(path: string, name: string): Promise<void> {
  return invoke("add_recent_workspace", { path, name });
}

export async function clearRecentWorkspaces(): Promise<void> {
  return invoke("clear_recent_workspaces");
}

// File operations
export async function listDirectory(path: string): Promise<DirectoryContents> {
  return invoke("list_directory", { path });
}

export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export async function readFileBinary(path: string): Promise<string> {
  return invoke("read_file_binary", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function writeFileBinary(path: string, content: string): Promise<void> {
  return invoke("write_file_binary", { path, content });
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke("file_exists", { path });
}

export async function listDirectoryRecursive(path: string): Promise<FileEntry[]> {
  return invoke("list_directory_recursive", { path });
}

export async function createFile(path: string): Promise<void> {
  return invoke("create_file", { path });
}

export async function createDirectory(path: string): Promise<void> {
  return invoke("create_directory", { path });
}

export async function renameEntry(oldPath: string, newName: string): Promise<string> {
  return invoke("rename_entry", { oldPath, newName });
}

export async function deleteEntry(path: string): Promise<void> {
  return invoke("delete_entry", { path });
}

export interface AudioOptimizeResult {
  data: string;
  original_size: number;
  optimized_size: number;
  ext: string;
}

export async function optimizeAudio(path: string, bitrate: number): Promise<AudioOptimizeResult> {
  return invoke("optimize_audio", { path, bitrate });
}

export { buildInBrowser as buildProject, type BuildOutput } from "./buildInBrowser";

