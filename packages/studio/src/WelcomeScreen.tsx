import { useState, useEffect } from "react";
import { listRecentWorkspaces, createWorkspace, openWorkspace, addRecentWorkspace } from "./workspace";
import type { RecentEntry, WorkspaceManifest } from "./workspace";

interface WelcomeScreenProps {
  onOpenWorkspace: (manifest: WorkspaceManifest, path: string) => void;
}

export function WelcomeScreen({ onOpenWorkspace }: WelcomeScreenProps) {
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    listRecentWorkspaces().then(setRecent).catch(console.error);
  }, []);

  const handleCreate = async () => {
    if (!newName.trim() || !newPath.trim()) return;
    setError("");

    try {
      const manifest = await createWorkspace(newPath, newName);
      await addRecentWorkspace(newPath, newName);
      onOpenWorkspace(manifest, newPath);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleOpen = async () => {
    // Use the Tauri file dialog (or prompt for path)
    const path = window.prompt("Enter the workspace directory path:");
    if (!path) return;

    try {
      const manifest = await openWorkspace(path);
      onOpenWorkspace(manifest, path);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRecentClick = async (entry: RecentEntry) => {
    try {
      const manifest = await openWorkspace(entry.path);
      onOpenWorkspace(manifest, entry.path);
    } catch (err) {
      setError(String(err));
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.content}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>&#9670;</span>
          <h1 style={styles.title}>Spark Studio</h1>
          <p style={styles.subtitle}>Create and manage Spark projects</p>
        </div>

        <div style={styles.actions}>
          <button style={styles.primaryBtn} onClick={() => setShowCreate(!showCreate)}>
            + New Workspace
          </button>
          <button style={styles.secondaryBtn} onClick={handleOpen}>
            Open Existing
          </button>
        </div>

        {showCreate && (
          <div style={styles.createForm}>
            <input
              style={styles.input}
              placeholder="Workspace name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <input
              style={styles.input}
              placeholder="Directory path (e.g. /Users/name/Projects/my-game)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <button style={styles.createBtn} onClick={handleCreate}>
              Create
            </button>
          </div>
        )}

        {error && <p style={styles.error}>{error}</p>}

        {recent.length > 0 && (
          <div style={styles.recentSection}>
            <h2 style={styles.sectionTitle}>Recent Workspaces</h2>
            <div style={styles.recentList}>
              {recent.map((entry) => (
                <div
                  key={entry.path}
                  style={styles.recentCard}
                  onClick={() => handleRecentClick(entry)}
                >
                  <div style={styles.recentInfo}>
                    <span style={styles.recentName}>{entry.name}</span>
                    <span style={styles.recentPath}>{entry.path}</span>
                  </div>
                  <span style={styles.recentDate}>{formatDate(entry.last_opened)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #0d0d1a 0%, #1a1a2e 50%, #0d0d1a 100%)",
  },
  content: {
    maxWidth: 520,
    width: "100%",
    padding: "40px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 24,
  },
  logo: {
    textAlign: "center" as const,
    marginBottom: 8,
  },
  logoIcon: {
    fontSize: 48,
    color: "#44aaff",
    display: "block",
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: 600,
    color: "#e0e0e0",
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "#666688",
    marginTop: 4,
  },
  actions: {
    display: "flex",
    gap: 12,
  },
  primaryBtn: {
    padding: "10px 24px",
    background: "#2a4a8a",
    color: "#e0e0e0",
    border: "1px solid #3a5aaa",
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
    fontWeight: 500,
  },
  secondaryBtn: {
    padding: "10px 24px",
    background: "transparent",
    color: "#8888aa",
    border: "1px solid #333355",
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
  },
  createForm: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
    maxWidth: 400,
  },
  input: {
    padding: "10px 12px",
    background: "#1a1a30",
    color: "#e0e0e0",
    border: "1px solid #333355",
    borderRadius: 6,
    fontSize: 13,
    outline: "none",
    width: "100%",
  },
  createBtn: {
    padding: "8px 20px",
    background: "#22aa66",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    fontWeight: 500,
    alignSelf: "flex-end",
  },
  error: {
    color: "#ff6644",
    fontSize: 13,
    textAlign: "center" as const,
  },
  recentSection: {
    width: "100%",
    marginTop: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#666688",
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    marginBottom: 12,
  },
  recentList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  recentCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid #222244",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.15s",
  },
  recentInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  recentName: {
    fontSize: 14,
    fontWeight: 500,
    color: "#d0d0e0",
  },
  recentPath: {
    fontSize: 11,
    color: "#555577",
  },
  recentDate: {
    fontSize: 11,
    color: "#555577",
  },
};
