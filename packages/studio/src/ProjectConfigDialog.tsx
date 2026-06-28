import { useState, useEffect } from "react";
import { readFile, writeFile } from "./workspace";

interface ProjectConfigDialogProps {
  projectPath: string;
  onSave: () => void;
  onClose: () => void;
}

export function ProjectConfigDialog({
  projectPath,
  onSave,
  onClose,
}: ProjectConfigDialogProps) {
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [entryScripts, setEntryScripts] = useState<string[]>([""]);
  const [scriptDirs, setScriptDirs] = useState<string[]>([""]);
  const [assetDirs, setAssetDirs] = useState<string[]>([""]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const configPath = `${projectPath}/spark.config.json`;
    readFile(configPath)
      .then((content) => {
        const config = JSON.parse(content);
        setName(config.name ?? "");
        setEntryScripts(config.entryScripts?.length ? config.entryScripts : [""]);
        setScriptDirs(config.scriptDirs?.length ? config.scriptDirs : [""]);
        setAssetDirs(config.assetDirs?.length ? config.assetDirs : [""]);
      })
      .catch(() => {
        // File doesn't exist yet — use defaults
        setName(projectPath.split("/").pop() ?? "Untitled");
      })
      .finally(() => setLoading(false));
  }, [projectPath]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    const filteredScripts = entryScripts.filter((s) => s.trim());
    const filteredDirs = scriptDirs.filter((d) => d.trim());
    const filteredAssetDirs = assetDirs.filter((d) => d.trim());

    if (filteredScripts.length === 0) {
      setError("At least one entry script is required");
      return;
    }
    if (filteredDirs.length === 0) {
      setError("At least one script directory is required");
      return;
    }

    setSaving(true);
    setError("");

    const config = {
      name: name.trim(),
      version: "1.0.0",
      entryScripts: filteredScripts,
      scriptDirs: filteredDirs,
      assetDirs: filteredAssetDirs,
      outputDir: "dist",
    };

    try {
      await writeFile(`${projectPath}/spark.config.json`, JSON.stringify(config, null, 2));
      onSave();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const addEntryScript = () => setEntryScripts((prev) => [...prev, ""]);
  const updateEntryScript = (i: number, val: string) =>
    setEntryScripts((prev) => prev.map((v, j) => (j === i ? val : v)));
  const removeEntryScript = (i: number) =>
    setEntryScripts((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const addScriptDir = () => setScriptDirs((prev) => [...prev, ""]);
  const updateScriptDir = (i: number, val: string) =>
    setScriptDirs((prev) => prev.map((v, j) => (j === i ? val : v)));
  const removeScriptDir = (i: number) =>
    setScriptDirs((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const addAssetDir = () => setAssetDirs((prev) => [...prev, ""]);
  const updateAssetDir = (i: number, val: string) =>
    setAssetDirs((prev) => prev.map((v, j) => (j === i ? val : v)));
  const removeAssetDir = (i: number) =>
    setAssetDirs((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev));

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "#666688",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
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

  const addButtonStyle: React.CSSProperties = {
    background: "none",
    border: "1px dashed #333355",
    color: "#555577",
    borderRadius: 6,
    padding: "6px 12px",
    cursor: "pointer",
    fontSize: 11,
    width: "100%",
    marginTop: 4,
  };

  const removeButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    color: "#664444",
    cursor: "pointer",
    fontSize: 16,
    padding: "4px 6px",
    lineHeight: 1,
  };

  if (loading) {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}>
        <div style={{
          background: "#16162a", border: "1px solid #333366", borderRadius: 12,
          padding: 24, boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
        }}>
          <p style={{ color: "#8888aa", fontSize: 13, margin: 0 }}>Loading project config...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
      }}
      onClick={handleBackdropClick}
    >
      <div style={{
        background: "#16162a", border: "1px solid #333366", borderRadius: 12,
        padding: 24, width: 480, maxHeight: "80vh", overflow: "auto",
        boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
      }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 600, color: "#d0d0e0" }}>
          Project Settings
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 11, color: "#555577" }}>
          {projectPath}
        </p>

        {/* Name */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Name</div>
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
          />
        </div>

        {/* Entry Scripts */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Entry Scripts</div>
          <p style={{ fontSize: 11, color: "#555577", margin: "0 0 8px" }}>
            Scripts to execute when the project starts. These are loaded into the player
            and can call spark.import() to include code from other scripts.
          </p>
          {entryScripts.map((script, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <input
                style={inputStyle}
                value={script}
                onChange={(e) => updateEntryScript(i, e.target.value)}
                placeholder="scripts/main.ts"
              />
              <button
                onClick={() => removeEntryScript(i)}
                style={removeButtonStyle}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
          <button onClick={addEntryScript} style={addButtonStyle}>
            + Add entry script
          </button>
        </div>

        {/* Script Directories */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Script Directories</div>
          <p style={{ fontSize: 11, color: "#555577", margin: "0 0 8px" }}>
            Directories to scan for importable scripts. Any .ts file in these directories
            can be imported by entry scripts via spark.import().
          </p>
          {scriptDirs.map((dir, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <input
                style={inputStyle}
                value={dir}
                onChange={(e) => updateScriptDir(i, e.target.value)}
                placeholder="scripts"
              />
              <button
                onClick={() => removeScriptDir(i)}
                style={removeButtonStyle}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
          <button onClick={addScriptDir} style={addButtonStyle}>
            + Add script directory
          </button>
        </div>

        {/* Asset Directories */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Asset Directories</div>
          <p style={{ fontSize: 11, color: "#555577", margin: "0 0 8px" }}>
            Directories containing images, audio, and other assets to bundle with the project.
            Subdirectories are included recursively.
          </p>
          {assetDirs.map((dir, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
              <input
                style={inputStyle}
                value={dir}
                onChange={(e) => updateAssetDir(i, e.target.value)}
                placeholder="assets"
              />
              <button
                onClick={() => removeAssetDir(i)}
                style={removeButtonStyle}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
          <button onClick={addAssetDir} style={addButtonStyle}>
            + Add asset directory
          </button>
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
