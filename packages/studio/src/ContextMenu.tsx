import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    // Delay listener to avoid the right-click that opened the menu
    setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleEsc);
    }, 0);

    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [onClose]);

  // Clamp to viewport
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 16),
    zIndex: 10000,
    background: "#16162a",
    border: "1px solid #333366",
    borderRadius: 8,
    padding: "4px 0",
    minWidth: 180,
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    userSelect: "none",
  };

  return (
    <div ref={menuRef} style={menuStyle}>
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && (
            <div style={{ height: 1, background: "#222244", margin: "4px 8px" }} />
          )}
          <div
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) (e.currentTarget as HTMLElement).style.background = "rgba(68,170,255,0.1)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
            style={{
              padding: "6px 16px",
              fontSize: 13,
              color: item.disabled ? "#444466" : "#c0c0d0",
              cursor: item.disabled ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
