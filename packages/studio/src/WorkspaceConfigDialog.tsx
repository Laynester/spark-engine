import { useState } from "react";
import type { WorkspaceManifest } from "./workspace";
import { saveWorkspace } from "./workspace";

interface WorkspaceConfigDialogProps {
  manifest: WorkspaceManifest;
  workspacePath: string;
  projects: string[];
  onSave: (manifest: WorkspaceManifest) => void;
  onClose: () => void;
}

export function WorkspaceConfigDialog({
  manifest,
  workspacePath,
  projects,
  onSave,
  onClose,
}: WorkspaceConfigDialogProps) {
  const [name, setName] = useState(manifest.name);
  const [entryProject, setEntryProject] = useState(manifest.entry_project ?? "");
  const [projectMap, setProjectMap] = useState<Record<string, { path: string; type: "app" | "lib" }>>(
    Object.fromEntries(
      Object.entries(manifest.projects).map(([key, val]) => [key, { path: val.path, type: val.type as "app" | "lib" }])
    )
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    setSaving(true);
    setError("");

    const updated: WorkspaceManifest = {
      ...manifest,
      name: name.trim(),
      entry_project: entryProject || null,
      projects: Object.fromEntries(
        Object.entries(projectMap).map(([key, val]) => [key, val])
      ),
    };

    try {
      await saveWorkspace(workspacePath, updated);
      onSave(updated);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // Backdrop click to close
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const dialogStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(4px)",
  };

  const panelStyle: React.CSSProperties = {
    background: "#16162a",
    border: "1px solid #333366",
    borderRadius: 12,
    padding: 24,
    width: 480,
    maxHeight: "80vh",
    overflow: "auto",
    boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    background: "#0d0d1a",
    color: "#d0d0e0",
    border: "1px solid #333355",
    borderRadius: 6,
    fontSize: 13,
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "#666688",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  };

  return (
    <div style={dialogStyle} onClick={handleBackdropClick}>
      <div style={panelStyle}>
        <h2 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 600, color: "#d0d0e0" }}>
          Workspace Settings
        </h2>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Name</div>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
          />
        </div>

        {/* Entry Project */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Entry Project</div>
          <p style={{ fontSize: 11, color: "#555577", margin: "0 0 8px" }}>
            The entry project is the main .sprk package loaded when the player runs.
            Library projects are imported by the entry project via spark.import().
          </p>
          <select
            style={{
              ...inputStyle,
              cursor: "pointer",
            }}
            value={entryProject}
            onChange={(e) => setEntryProject(e.target.value)}
          >
            <option value="">-- None --</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {Object.keys(projectMap).map((p) =>
              !projects.includes(p) ? (
                <option key={p} value={p}>
                  {p} (configured)
                </option>
              ) : null
            )}
          </select>
        </div>

        {/* Discovered Projects */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Projects</div>
          {projects.length === 0 ? (
            <p style={{ fontSize: 12, color: "#555577", fontStyle: "italic" }}>
              No Spark projects found in this workspace.
              Create a spark.config.json in a subdirectory to add a project.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {projects.map((projectName) => {
                const isEntry = entryProject === projectName;
                const config = projectMap[projectName];
                return (
                  <div
                    key={projectName}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 12px",
                      background: isEntry ? "rgba(68,170,255,0.08)" : "#0d0d1a",
                      border: `1px solid ${isEntry ? "#336699" : "#222244"}`,
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: isEntry ? 600 : 400, color: isEntry ? "#66bbff" : "#99aabb" }}>
                        {projectName}
                      </span>
                      {isEntry && (
                        <span style={{ fontSize: 10, color: "#44aaff", background: "rgba(68,170,255,0.15)", borderRadius: 4, padding: "1px 6px" }}>
                          entry
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        style={{
                          background: "#0d0d1a",
                          color: "#8888aa",
                          border: "1px solid #333355",
                          borderRadius: 4,
                          fontSize: 11,
                          padding: "2px 6px",
                        }}
                        value={config?.type ?? "app"}
                        onChange={(e) =>
                          setProjectMap((prev) => ({
                            ...prev,
                            [projectName]: {
                              path: projectName,
                              type: e.target.value as "app" | "lib",
                            },
                          }))
                        }
                      >
                        <option value="app">app</option>
                        <option value="lib">lib</option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <p style={{ color: "#ff6644", fontSize: 13, marginBottom: 12 }}>{error}</p>
        )}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 20px",
              background: "transparent",
              color: "#8888aa",
              border: "1px solid #333355",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "8px 20px",
              background: saving ? "#1a3355" : "#2a4a8a",
              color: saving ? "#555577" : "#e0e0e0",
              border: "1px solid #3a5aaa",
              borderRadius: 6,
              cursor: saving ? "default" : "pointer",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
