import { useCallback } from "react";

interface DeleteConfirm {
  path: string;
  name: string;
  isDir: boolean;
}

interface DeleteConfirmDialogProps {
  item: DeleteConfirm;
  onConfirm: (item: DeleteConfirm) => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({
  item,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const handleDelete = useCallback(() => {
    onConfirm(item);
  }, [item, onConfirm]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "#16162a",
          border: "1px solid #663333",
          borderRadius: 12,
          padding: 24,
          width: 360,
          boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 14,
            fontWeight: 600,
            color: "#ff8877",
          }}
        >
          Delete {item.isDir ? "Folder" : "File"}
        </h3>
        <p
          style={{
            fontSize: 13,
            color: "#9999bb",
            margin: "0 0 16px",
            lineHeight: 1.5,
          }}
        >
          Delete{" "}
          <strong style={{ color: "#d0d0e0" }}>{item.name}</strong>?
          {item.isDir && " All contents will be removed."}
          This cannot be undone.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 16px",
              background: "transparent",
              color: "#8888aa",
              border: "1px solid #333355",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            style={{
              padding: "6px 16px",
              background: "#6a2020",
              color: "#ff8877",
              border: "1px solid #993333",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
