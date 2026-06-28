import { useState, useCallback, useEffect } from "react";
import { ProjectTree } from "./ProjectTree";
import { EditorPanel } from "./Editor";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./ContextMenu";
import { WorkspaceConfigDialog } from "./WorkspaceConfigDialog";
import { ProjectConfigDialog } from "./ProjectConfigDialog";
import { PlayerPanel } from "./PlayerPanel";
import { DeleteConfirmDialog } from "./Dialogs/DeleteConfirmDialog";
import { RenameDialog } from "./Dialogs/RenameDialog";
import { NewItemDialog } from "./Dialogs/NewItemDialog";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { useErrorToast } from "./hooks/useErrorToast";
import { readFile, writeFile, findProjects, createFile, createDirectory, deleteEntry, renameEntry } from "./workspace";
import type { OpenFile } from "./Editor";
import type { WorkspaceManifest, FileEntry } from "./workspace";

interface StudioLayoutProps {
  manifest: WorkspaceManifest;
  workspacePath: string;
  onBack: () => void;
}

export function StudioLayout({ manifest, workspacePath, onBack }: StudioLayoutProps) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const { width: leftPanelWidth, handleMouseDown: handleResizeMouseDown } = useSidebarResize(240);
  const [projects, setProjects] = useState<string[]>([]);
  const [currentManifest, setCurrentManifest] = useState(manifest);
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false);
  const [showProjectConfig, setShowProjectConfig] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { errorMsg, showError, clearError } = useErrorToast(4000);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  // Prompt for creating new items
  const [newItemPrompt, setNewItemPrompt] = useState<{
    type: "file" | "folder" | "project";
    parentPath: string;
  } | null>(null);
  const [newItemName, setNewItemName] = useState("");

  // Prompt for renaming
  const [renamePrompt, setRenamePrompt] = useState<{
    oldPath: string;
    oldName: string;
  } | null>(null);
  const [renameName, setRenameName] = useState("");

  // Confirm delete
  const [deleteConfirm, setDeleteConfirm] = useState<{
    path: string;
    name: string;
    isDir: boolean;
  } | null>(null);

  // Detect projects
  useEffect(() => {
    findProjects(workspacePath)
      .then(setProjects)
      .catch(console.error);
  }, [workspacePath, refreshKey]);

  // File select
  const handleFileSelect = useCallback(async (path: string) => {
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      setActiveFilePath(path);
      return;
    }
    try {
      const content = await readFile(path);
      const name = path.split("/").pop() ?? path;
      const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
      const textExtensions = new Set(["ts", "tsx", "js", "jsx", "json", "html", "css", "md", "txt", "toml", "yaml", "yml", "cfg", "conf"]);
      if (!textExtensions.has(ext)) return;

      setOpenFiles((prev) => [...prev, {
        path, name, content, dirty: false,
        language: name.endsWith(".ts") ? "typescript" : name.endsWith(".js") ? "javascript" : name.endsWith(".json") ? "json" : "plaintext",
      }]);
      setActiveFilePath(path);
    } catch (err) {
      console.error("Failed to open file:", err);
    }
  }, [openFiles]);

  const handleFileChange = useCallback((path: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }, []);

  const handleFileSave = useCallback(async (path: string, content: string) => {
    try {
      await writeFile(path, content);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, dirty: false } : f)));
    } catch (err) {
      console.error("Failed to save file:", err);
    }
  }, []);

  const handleCloseTab = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const newFiles = prev.filter((f) => f.path !== path);
      if (activeFilePath === path) {
        const idx = prev.findIndex((f) => f.path === path);
        setActiveFilePath(newFiles[Math.min(idx, newFiles.length - 1)]?.path ?? null);
      }
      return newFiles;
    });
  }, [activeFilePath]);

  const handleSetActive = useCallback((path: string) => setActiveFilePath(path), []);

  // Right-click context menu
  const handleTreeContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;

    const items: ContextMenuItem[] = [];

    if (entry) {
      // Clicked on an existing entry
      items.push({
        label: entry.is_dir ? "New File" : "New File",
        action: () => setNewItemPrompt({
          type: "file",
          parentPath: entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf("/")),
        }),
      });
      items.push({
        label: entry.is_dir ? "New Folder" : "New Folder",
        action: () => setNewItemPrompt({
          type: "folder",
          parentPath: entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf("/")),
        }),
      });

      // Rename for all items
      items.push({ label: "", action: () => { }, separator: true });
      items.push({
        label: `Rename ${entry.is_dir ? "Folder" : "File"}`,
        action: () => {
          setRenameName(entry.name);
          setRenamePrompt({ oldPath: entry.path, oldName: entry.name });
        },
      });

      // "Project Settings" and "Delete Project" for project directories
      if (entry.is_dir && projects.includes(entry.name)) {
        items.push({
          label: "\u2699 Project Settings...",
          action: () => setShowProjectConfig(entry.path),
        });
        items.push({
          label: "Delete Project",
          action: async () => {
            try {
              await deleteEntry(entry.path);
              // Remove from workspace manifest if present
              const updated = { ...currentManifest };
              if (updated.projects[entry.name]) {
                const { [entry.name]: _, ...rest } = updated.projects;
                updated.projects = rest;
                await writeFile(`${workspacePath}/spark-workspace.json`, JSON.stringify(updated, null, 2));
                setCurrentManifest(updated);
              }
              setRefreshKey((k) => k + 1);
            } catch (err) {
              showError("Failed to delete project: " + String(err));
            }
          },
        });
      }

      if (!entry.is_dir && entry.name.endsWith(".ts")) {
        items.push({ label: "", action: () => { }, separator: true });
      }
    }

    // "New Project" option — only at workspace root or inside a project folder
    const isRoot = !entry || entry.path === workspacePath;
    if (!entry || entry.is_dir) {
      items.push({ label: "", action: () => { }, separator: true });
      items.push({
        label: "\u2795 New Project...",
        action: () => setNewItemPrompt({
          type: "project",
          parentPath: entry ? (entry.is_dir ? entry.path : entry.path.substring(0, entry.path.lastIndexOf("/"))) : workspacePath,
        }),
      });
    }

    // Delete for non-root items (skip for project directories — they get "Delete Project" above)
    if (entry && !(entry.is_dir && projects.includes(entry.name))) {
      items.push({ label: "", action: () => { }, separator: true });
      items.push({
        label: `Delete ${entry.is_dir ? "Folder" : "File"}`,
        action: () => setDeleteConfirm({ path: entry.path, name: entry.name, isDir: entry.is_dir }),
      });
    }

    setCtxMenu({ x, y, items });
  }, [workspacePath, projects, currentManifest]);

  // Right-click on empty area in sidebar
  const handleSidebarContextMenu = useCallback((e: React.MouseEvent) => {
    if (ctxMenu) return; // already showing
    handleTreeContextMenu(e, null);
  }, [ctxMenu, handleTreeContextMenu]);

  // Handle confirmed delete
  const handleDelete = useCallback(async (item: typeof deleteConfirm) => {
    if (!item) return;
    const { path, isDir } = item;
    try {
      await deleteEntry(path);
      // Close editor tabs for deleted files/folders
      setOpenFiles((prev) => prev.filter((f) => f.path !== path && !f.path.startsWith(path + "/")));
      if (activeFilePath && (activeFilePath === path || (isDir && activeFilePath.startsWith(path + "/")))) {
        setActiveFilePath(null);
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error("Failed to delete:", err);
    }
    setDeleteConfirm(null);
  }, [activeFilePath]);

  // Handle rename
  const handleRename = async () => {
    if (!renamePrompt || !renameName.trim()) return;

    const newName = renameName.trim();
    const { oldPath } = renamePrompt;

    try {
      const newPath = await renameEntry(oldPath, newName);

      // Update editor tabs if the renamed file was open
      const wasOpen = openFiles.some((f) => f.path === oldPath);
      if (wasOpen) {
        const content = await readFile(newPath);
        const language = newName.endsWith(".ts") ? "typescript" : newName.endsWith(".js") ? "javascript" : newName.endsWith(".json") ? "json" : "plaintext";

        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === oldPath
              ? { ...f, path: newPath, name: newName, content, dirty: false, language }
              : f
          )
        );
        if (activeFilePath === oldPath) setActiveFilePath(newPath);
      }

      setRefreshKey((k) => k + 1);
      setRenamePrompt(null);
      setRenameName("");
    } catch (err) {
      console.error("Failed to rename:", err);
    }
  };

  // Handle new item creation
  const handleCreateItem = async () => {
    if (!newItemPrompt || !newItemName.trim()) return;

    const { type, parentPath } = newItemPrompt;
    const name = newItemName.trim();

    try {
      if (type === "file") {
        await createFile(`${parentPath}/${name}`);
      } else if (type === "folder") {
        await createDirectory(`${parentPath}/${name}`);
      } else if (type === "project") {
        // Create a project folder with spark.config.json and scripts/main.ts
        const projectDir = `${parentPath}/${name}`;
        await createDirectory(`${projectDir}/scripts`);
        await createDirectory(`${projectDir}/assets`);
        const configContent = JSON.stringify({
          name,
          version: "1.0.0",
          entryScripts: ["scripts/main.ts"],
          scriptDirs: ["scripts"],
          assetDirs: ["assets"],
          outputDir: "../.built",
        }, null, 2);
        await writeFile(`${projectDir}/spark.config.json`, configContent);
        const mainTsContent = `\
import { SparkAPI, ScriptClass } from "@spark/runtime";

export default class Main implements ScriptClass {
  private spark: SparkAPI;

  constructor(spark: SparkAPI) {
    this.spark = spark;
    console.log("Hello from ${name}!");
  }

  onCreate() {
    // Called when the game starts
  }

  onUpdate(dt: number) {
    // Called every frame
  }
}
`;
        await writeFile(`${projectDir}/scripts/main.ts`, mainTsContent);
      }

      setRefreshKey((k) => k + 1);
      setNewItemPrompt(null);
      setNewItemName("");
    } catch (err) {
      console.error(`Failed to create ${type}:`, err);
    }
  };



  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Title bar */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 12, padding: "6px 16px",
          background: "#0d0d1a", borderBottom: "1px solid #1a1a30",
          userSelect: "none" as const, flexShrink: 0,
          WebkitAppRegion: "drag" as const,
        } as React.CSSProperties}
        data-tauri-drag-region
      >
        <button onClick={onBack} style={{
          background: "none", border: "1px solid #333355", color: "#8888aa",
          borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12,
          WebkitAppRegion: "no-drag" as const,
        } as React.CSSProperties}>
          &larr; Workspaces
        </button>
        <span style={{ color: "#44aaff", fontWeight: 600, fontSize: 13 }}>{currentManifest.name}</span>
        <span style={{ color: "#555577", fontSize: 11 }}>
          {workspacePath} &mdash; {projects.length} project{projects.length !== 1 ? "s" : ""}
        </span>
        <button onClick={() => setIsPlaying(true)} style={{
          background: "#1a4a2a", border: "1px solid #2a7744", color: "#44dd88",
          borderRadius: 6, padding: "3px 14px", cursor: "pointer", fontSize: 12,
          fontWeight: 600, WebkitAppRegion: "no-drag" as const,
          marginLeft: "auto", display: "flex", alignItems: "center", gap: 4,
        } as React.CSSProperties}>
          &#x25B6; Play
        </button>
        <button onClick={() => setShowWorkspaceConfig(true)} style={{
          background: "none", border: "1px solid #333355", color: "#8888aa",
          borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11,
          WebkitAppRegion: "no-drag" as const,
        } as React.CSSProperties}>
          Config
        </button>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left sidebar */}
        <div style={{
          width: leftPanelWidth, minWidth: 160, background: "#0d0d1a",
          borderRight: "1px solid #1a1a30", display: "flex", flexDirection: "column", overflow: "hidden",
        }}>
          <div style={{
            padding: "6px 12px", fontSize: 11, fontWeight: 600, color: "#555577",
            textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #1a1a30", flexShrink: 0,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>Explorer</span>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              style={{
                background: "none", border: "none", color: "#555577",
                cursor: "pointer", fontSize: 14, padding: 0,
              }}
              title="Refresh file tree"
            >
              &#x21bb;
            </button>
          </div>
          <div
            style={{ flex: 1, overflow: "auto" }}
            onContextMenu={handleSidebarContextMenu}
          >
            <ProjectTree
              workspacePath={workspacePath}
              onFileSelect={handleFileSelect}
              activeFile={activeFilePath}
              onContextMenu={handleTreeContextMenu}
              refreshKey={refreshKey}
            />
          </div>
        </div>

        {/* Resize handle */}
        <div onMouseDown={handleResizeMouseDown} style={{ width: 4, cursor: "col-resize", background: "transparent", flexShrink: 0 }} />

        {/* Center — Editor */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <EditorPanel
            files={openFiles}
            activeFile={activeFilePath}
            onFileChange={handleFileChange}
            onFileSave={handleFileSave}
            onCloseTab={handleCloseTab}
            onSetActive={handleSetActive}
            workspacePath={workspacePath}
            projects={projects}
          />
        </div>

        {/* Right panel — empty for now */}
        <div style={{ width: 0, minWidth: 0 }} />
      </div>

      {/* Full-screen player overlay */}
      {isPlaying && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9998,
          display: "flex", flexDirection: "column",
          background: "#08081a",
        }}>
          <PlayerPanel
            projects={projects}
            workspacePath={workspacePath}
            entryProject={currentManifest.entry_project}
            width={currentManifest.width}
            height={currentManifest.height}
            onStop={() => setIsPlaying(false)}
          />
        </div>
      )}

      {/* Error toast */}
      {errorMsg && (
        <div style={{
          position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)",
          background: "#2a0a0a", border: "1px solid #663333", borderRadius: 8,
          padding: "8px 16px", fontSize: 13, color: "#ff8877", zIndex: 10001,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          maxWidth: 500, textAlign: "center",
        }} onClick={clearError}>
          {errorMsg}
        </div>
      )}

      {/* Bottom bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", padding: "2px 12px",
        background: "#0d0d1a", borderTop: "1px solid #1a1a30", fontSize: 11,
        color: "#444466", flexShrink: 0,
      }}>
        <span>Spark Studio v0.1.0</span>
        <span>{openFiles.length} file{openFiles.length !== 1 ? "s" : ""} open</span>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <DeleteConfirmDialog
          item={deleteConfirm}
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {/* Rename Prompt */}
      {renamePrompt && (
        <RenameDialog
          prompt={renamePrompt}
          name={renameName}
          onNameChange={setRenameName}
          onConfirm={handleRename}
          onCancel={() => { setRenamePrompt(null); setRenameName(""); }}
        />
      )}

      {/* New Item Prompt */}
      {newItemPrompt && (
        <NewItemDialog
          prompt={newItemPrompt}
          name={newItemName}
          onNameChange={setNewItemName}
          onConfirm={handleCreateItem}
          onCancel={() => { setNewItemPrompt(null); setNewItemName(""); }}
        />
      )}

      {/* Workspace Config Dialog */}
      {showWorkspaceConfig && (
        <WorkspaceConfigDialog
          manifest={currentManifest}
          workspacePath={workspacePath}
          projects={projects}
          onSave={(m) => { setCurrentManifest(m); setShowWorkspaceConfig(false); }}
          onClose={() => setShowWorkspaceConfig(false)}
        />
      )}

      {/* Project Config Dialog */}
      {showProjectConfig && (
        <ProjectConfigDialog
          projectPath={showProjectConfig}
          onSave={() => { setShowProjectConfig(null); setRefreshKey((k) => k + 1); }}
          onClose={() => setShowProjectConfig(null)}
        />
      )}
    </div>
  );
}
