import { useState, useRef, useCallback } from "react";

export function useErrorToast(durationMs: number = 4000) {
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const showError = useCallback(
    (msg: string) => {
      setErrorMsg(msg);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setErrorMsg(null), durationMs);
    },
    [durationMs],
  );

  const clearError = useCallback(() => {
    setErrorMsg(null);
    clearTimeout(timer.current);
  }, []);

  return { errorMsg, showError, clearError };
}
