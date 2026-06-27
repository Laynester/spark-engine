import { useState, useCallback, useEffect, useRef } from "react";

export function useSidebarResize(
  initialWidth: number = 240,
  minWidth: number = 160,
  maxWidth: number = 500,
) {
  const [width, setWidth] = useState(initialWidth);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      setWidth(Math.max(minWidth, Math.min(maxWidth, e.clientX)));
    };
    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [minWidth, maxWidth]);

  return { width, handleMouseDown };
}
