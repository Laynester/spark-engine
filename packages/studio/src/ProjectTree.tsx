import { useState, useEffect, useCallback, useMemo } from "react";
import { listDirectoryRecursive } from "./workspace";
import type { FileEntry } from "./workspace";

// Files and directories to hide from the tree
const HIDDEN_NAMES = new Set([
  ".built",
  ".DS_Store",
  ".git",
  ".gitkeep",
  ".spark-tmp",
  "node_modules",
  "spark-workspace.json",
  "spark.config.json",
]);

const HIDDEN_SUFFIXES = [".sprk"];

function shouldHide(entry: FileEntry): boolean {
  if (HIDDEN_NAMES.has(entry.name)) return true;
  for (const suffix of HIDDEN_SUFFIXES) {
    if (entry.name.endsWith(suffix)) return true;
  }
  return false;
}

interface ProjectTreeProps {
  workspacePath: string;
  onFileSelect: (path: string) => void;
  activeFile: string | null;
  /** Called when user requests a context menu action */
  onContextMenu: (e: React.MouseEvent, entry: FileEntry | null) => void;
  /** Trigger refresh */
  refreshKey: number;
}

function getFileIcon(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "TS";
  if (name.endsWith(".json")) return "\u007B";
  if (name.endsWith(".js")) return "\u0192";
  if (name.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) return "📸";
  if (name.startsWith(".")) return "\u2699";
  return "\u25CB";
}

function buildTreeFromFlat(entries: FileEntry[], rootPrefix: string): TreeNode[] {
  const prefix = rootPrefix.endsWith("/") ? rootPrefix : rootPrefix + "/";
  const childrenOf = new Map<string, FileEntry[]>();

  for (const entry of entries) {
    if (shouldHide(entry)) continue;
    if (entry.path === rootPrefix || entry.path === prefix.slice(0, -1)) continue;
    const parent = entry.path.substring(0, entry.path.lastIndexOf("/"));
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(entry);
  }

  function buildNodes(parentPath: string, depth: number): TreeNode[] {
    const children = childrenOf.get(parentPath);
    if (!children) return [];
    const sorted = [...children].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map((entry) => ({
      entry,
      depth,
      expanded: depth < 2,
      children: entry.is_dir ? buildNodes(entry.path, depth + 1) : [],
    }));
  }

  return buildNodes(prefix.slice(0, -1), 0);
}

interface TreeNode {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  children: TreeNode[];
}

function TreeItem({
  node,
  onToggle,
  onSelect,
  activeFile,
  onContextMenu,
}: {
  node: TreeNode;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  activeFile: string | null;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  const isActive = node.entry.path === activeFile;
  const paddingLeft = 12 + node.depth * 16;

  return (
    <>
      <div
        onClick={() => {
          if (node.entry.is_dir) onToggle(node.entry.path);
          else onSelect(node.entry.path);
        }}
        onContextMenu={(e) => onContextMenu(e, node.entry)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          paddingLeft,
          cursor: "pointer",
          fontSize: 13,
          color: isActive ? "#fff" : node.entry.is_dir ? "#8899bb" : "#99aabb",
          background: isActive ? "rgba(68, 170, 255, 0.12)" : "transparent",
          borderRadius: 4,
          margin: "1px 4px",
          transition: "background 0.1s",
          userSelect: "none",
        }}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <span style={{ width: 12, fontSize: 10, color: "#555577", flexShrink: 0, textAlign: "center" }}>
          {node.entry.is_dir ? (node.expanded ? "\u25BC" : "\u25B6") : getFileIcon(node.entry.name)}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.entry.name}
        </span>
      </div>
      {node.entry.is_dir && node.expanded && (
        <div>
          {node.children.length === 0 && (
            <div style={{ paddingLeft: paddingLeft + 28, fontSize: 11, color: "#444466", fontStyle: "italic", padding: "2px 8px 2px 28px" }}>
              empty
            </div>
          )}
          {node.children.map((child) => (
            <TreeItem
              key={child.entry.path}
              node={child}
              onToggle={onToggle}
              onSelect={onSelect}
              activeFile={activeFile}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function ProjectTree({ workspacePath, onFileSelect, activeFile, onContextMenu, refreshKey }: ProjectTreeProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listDirectoryRecursive(workspacePath)
      .then((entries) => {
        const tree = buildTreeFromFlat(entries, workspacePath);
        setRoots(tree);
        setExpanded(new Set(tree.filter((n) => n.entry.is_dir).map((n) => n.entry.path)));
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspacePath, refreshKey]);

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelect = useCallback((path: string) => {
    onFileSelect(path);
  }, [onFileSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, entry);
  }, [onContextMenu]);

  const visibleTree = useMemo(() => applyExpanded(roots, expanded), [roots, expanded]);

  if (loading) {
    return <div style={{ padding: 16, color: "#555577", fontSize: 12 }}>Loading...</div>;
  }

  if (roots.length === 0) {
    return <div style={{ padding: 16, color: "#555577", fontSize: 12 }}>No files found</div>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      {visibleTree.map((node) => (
        <TreeItem
          key={node.entry.path}
          node={node}
          onToggle={handleToggle}
          onSelect={handleSelect}
          activeFile={activeFile}
          onContextMenu={handleContextMenu}
        />
      ))}
    </div>
  );
}

function applyExpanded(nodes: TreeNode[], expanded: Set<string>): TreeNode[] {
  return nodes.map((n) => ({
    ...n,
    expanded: expanded.has(n.entry.path) || n.depth < 1,
    children: applyExpanded(n.children, expanded),
  }));
}
