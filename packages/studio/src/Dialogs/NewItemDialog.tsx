import { useEffect, useRef } from "react";

interface NewItemPrompt {
  type: "file" | "folder" | "project";
  parentPath: string;
}

interface NewItemDialogProps {
  prompt: NewItemPrompt;
  name: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function NewItemDialog({
  prompt,
  name,
  onNameChange,
  onConfirm,
  onCancel,
}: NewItemDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const label =
    prompt.type === "project"
      ? "Project"
      : prompt.type === "folder"
        ? "Folder"
        : "File";

  const placeholder =
    prompt.type === "project" ? "Project name" : `${prompt.type} name`;

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
          border: "1px solid #333366",
          borderRadius: 12,
          padding: 24,
          width: 360,
          boxShadow: "0 16px 64px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          style={{
            margin: "0 0 16px",
            fontSize: 14,
            fontWeight: 600,
            color: "#d0d0e0",
          }}
        >
          New {label}
        </h3>
        <input
          ref={inputRef}
          placeholder={placeholder}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
            if (e.key === "Escape") onCancel();
          }}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "#0d0d1a",
            color: "#d0d0e0",
            border: "1px solid #333355",
            borderRadius: 6,
            fontSize: 13,
            outline: "none",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
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
            onClick={onConfirm}
            style={{
              padding: "6px 16px",
              background: "#2a4a8a",
              color: "#e0e0e0",
              border: "1px solid #3a5aaa",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
