import { useState, useEffect, useCallback, useRef } from "react";
import { buildProject, readFileBinary } from "./workspace";
import { SparkRuntime } from "@spark/runtime";

// Bridge Tauri's file reading to the runtime for file:// URL support
(window as any).__SPARK_READ_FILE__ = readFileBinary;

interface PlayerPanelProps {
  projects: string[];
  workspacePath: string;
  entryProject: string | null;
  onStop: () => void;
}

interface LogEntry {
  msg: string;
  time: number;
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function PlayerPanel({ projects, workspacePath, entryProject, onStop }: PlayerPanelProps) {
  const [completedCount, setCompletedCount] = useState(0);
  const [currentBuild, setCurrentBuild] = useState<string | null>(null);
  const [phase, setPhase] = useState<"building" | "running" | "error">("building");
  const [log, setLog] = useState<string>("");
  const [showDebug, setShowDebug] = useState(true);
  const [debugFps, setDebugFps] = useState(0);
  const [debugEntities, setDebugEntities] = useState(0);
  const [debugPackages, setDebugPackages] = useState<string[]>([]);
  const [debugLogs, setDebugLogs] = useState<LogEntry[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<SparkRuntime | null>(null);
  const debugLogRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<LogEntry[]>([]);
  const showDebugRef = useRef(showDebug);
  const pendingSprkRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  showDebugRef.current = showDebug;

  // Intercept console.log from mount time — captures everything, not just when panel is open.
  // Only triggers React re-render when the panel is visible (prevents 60fps re-renders from game logs).
  useEffect(() => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    const capture = (level: string, args: any[]) => {
      const msg = args.map((a: any) =>
        a instanceof Error ? (a.stack || a.message)
          : typeof a === "object" ? (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })()
            : String(a)
      ).join(" ");
      logsRef.current = [...logsRef.current.slice(-499), { msg: `[${level}] ${msg}`, time: Date.now() }];
      // Only trigger state update when panel is visible — prevents 60fps re-renders
      if (showDebugRef.current) {
        setDebugLogs(logsRef.current);
      }
    };

    console.log = (...args: any[]) => { origLog(...args); capture("log", args); };
    console.warn = (...args: any[]) => { origWarn(...args); capture("warn", args); };
    console.error = (...args: any[]) => { origError(...args); capture("error", args); };

    return () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    };
  }, []);

  // When the panel is opened, sync the ref into state so the panel shows all captured logs
  useEffect(() => {
    if (showDebug) {
      setDebugLogs(logsRef.current);
    }
  }, [showDebug]);

  // Poll debug stats when running (only when panel is open)
  useEffect(() => {
    if (phase !== "running" || !showDebug) return;
    let frameId: number;
    let lastTime = performance.now();
    let frames = 0;

    const poll = () => {
      const now = performance.now();
      frames++;
      if (now - lastTime >= 1000) {
        setDebugFps(frames);
        frames = 0;
        lastTime = now;
        const rt = runtimeRef.current;
        if (rt) {
          setDebugEntities(rt.getAllEntities().length);
          setDebugPackages(rt.loadedPackages);
        }
      }
      frameId = requestAnimationFrame(poll);
    };
    frameId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frameId);
  }, [phase, showDebug]);

  // Auto-scroll debug logs
  useEffect(() => {
    if (showDebug && debugLogRef.current) {
      debugLogRef.current.scrollTop = debugLogRef.current.scrollHeight;
    }
  }, [debugLogs, showDebug]);

  // Launch runtime when canvas is in the DOM (phase switches to "running")
  useEffect(() => {
    if (phase !== "running" || startedRef.current) return;
    startedRef.current = true; // prevent double-launch in strict mode

    (async () => {
      const sprkPath = pendingSprkRef.current;
      if (!sprkPath) return;

      try {
        setLog((prev) => prev + `\nReading ${sprkPath}...`);

        const runtime = new SparkRuntime({ view: canvasRef.current! });
        runtimeRef.current = runtime;
        await runtime.loadPackageUrl("file://" + sprkPath);
        await runtime.start();

        setLog((prev) => prev + `\n✓ Game running`);
      } catch (err) {
        setPhase("error");
        setLog((prev) => prev + `\n✗ Failed to load game: ${err}`);
      }
    })();
  }, [phase]);

  useEffect(() => {
    let cancelled = false;

    const runBuilds = async () => {
      interface BuildResult {
        projectName: string;
        success: boolean;
        stdout: string;
        stderr: string;
        duration: number;
      }
      const results: BuildResult[] = [];
      let sprkPath: string | null = null;
      const entryName = entryProject || projects[0] || "";

      for (let i = 0; i < projects.length; i++) {
        if (cancelled) return;

        const name = projects[i];
        const projectPath = `${workspacePath}/${name}`;
        setCurrentBuild(name);
        setLog((prev) => prev + `\n[${i + 1}/${projects.length}] Building ${name}...`);

        const startTime = performance.now();
        try {
          const result = await buildProject(projectPath);
          const duration = performance.now() - startTime;

          if (cancelled) return;

          if (result.success && result.output_path && name === entryName) {
            sprkPath = result.output_path;
          }

          results.push({
            projectName: name,
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            duration,
          });
          setCompletedCount((c) => c + 1);

          if (result.success) {
            setLog((prev) => prev + ` ✓ (${duration.toFixed(0)}ms)`);
          } else {
            setLog((prev) => prev + ` ✗ FAILED\n${result.stderr || result.stdout}`);
          }
        } catch (err) {
          if (cancelled) return;
          results.push({
            projectName: name,
            success: false,
            stdout: "",
            stderr: String(err),
            duration: performance.now() - startTime,
          });
          setCompletedCount((c) => c + 1);
          setLog((prev) => prev + ` ✗ ${String(err)}`);
        }
      }

      if (cancelled) return;

      const allOk = results.every((r) => r.success);
      if (allOk) {
        pendingSprkRef.current = sprkPath;
        setPhase("running");
        setLog((prev) => prev + `\n\nAll projects built. Launching ${entryProject || projects[0]}...`);

        if (!sprkPath) {
          setPhase("error");
          setLog((prev) => prev + `\n✗ No output path found for the entry project`);
        }
      } else {
        setPhase("error");
        setLog((prev) => prev + `\n\nSome builds failed. Check the log above.`);
      }
    };

    setLog("Building all projects...");
    runBuilds();

    return () => {
      cancelled = true;
      runtimeRef.current?.destroyAll();
      runtimeRef.current = null;
    };
  }, []);

  const handleStop = useCallback(() => {
    runtimeRef.current?.destroyAll();
    runtimeRef.current = null;
    onStop();
  }, [onStop]);

  return (
    <div style={{
      width: "100%", height: "100%",
      display: "flex", flexDirection: "column",
      background: "#08081a",
    }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "6px 16px",
        background: "#0d0d1a", borderBottom: "1px solid #1a1a30",
        flexShrink: 0, userSelect: "none",
      }}>
        <button onClick={handleStop} style={{
          background: "none", border: "1px solid #555577", color: "#ff6655",
          borderRadius: 6, padding: "3px 14px", cursor: "pointer", fontSize: 12,
          fontWeight: 600,
          display: "flex", alignItems: "center", gap: 4,
        }}>
          &#x25A0; Stop
        </button>
        <span style={{ color: "#8888aa", fontSize: 11 }}>
          {phase === "building" ? "Building..." : phase === "running" ? "Running" : "Build failed"}
        </span>
        {currentBuild && phase === "building" && (
          <span style={{ color: "#44aaff", fontSize: 11, fontStyle: "italic" }}>
            {currentBuild}
          </span>
        )}
        {phase === "running" && (
          <span style={{ color: "#558866", fontSize: 11, fontStyle: "italic" }}>
            {entryProject || projects[0]}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {phase === "running" && (
            <button
              onClick={() => setShowDebug((v) => !v)}
              style={{
                background: showDebug ? "#2a3a5a" : "none",
                border: "1px solid #3a4a6a",
                color: showDebug ? "#88bbff" : "#555577",
                borderRadius: 4, padding: "2px 10px",
                cursor: "pointer", fontSize: 11, fontWeight: 500,
              }}
            >
              {showDebug ? "Debug On" : "Debug"}
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          {phase === "running" ? (
            <>
              <canvas
                ref={canvasRef}
                style={{
                  width: "100%", height: "100%", display: "block",
                  background: "#000",
                }}
              />
              {/* Debug overlay panel */}
              {showDebug && (
                <div style={{
                  position: "absolute", right: 0, top: 0, bottom: 0,
                  width: 320,
                  background: "rgba(8, 8, 26, 0.88)",
                  borderLeft: "1px solid rgba(60, 60, 120, 0.4)",
                  backdropFilter: "blur(8px)",
                  display: "flex", flexDirection: "column",
                  fontFamily: "'SF Mono', 'Fira Code', monospace",
                  fontSize: 11,
                  color: "#aaaacc",
                  pointerEvents: "auto",
                }}>
                  {/* Stats section */}
                  <div style={{
                    padding: "10px 14px", borderBottom: "1px solid rgba(60, 60, 120, 0.3)",
                    display: "flex", gap: 16, flexWrap: "wrap",
                  }}>
                    <Stat label="FPS" value={String(debugFps)} color={debugFps >= 30 ? "#44cc88" : debugFps >= 15 ? "#ccaa44" : "#ff6644"} />
                    <Stat label="Entities" value={String(debugEntities)} color="#44aaff" />
                    <Stat label="Packages" value={String(debugPackages.length)} color="#aa88ff" />
                  </div>

                  {/* Packages list */}
                  {debugPackages.length > 0 && (
                    <div style={{
                      padding: "6px 14px", borderBottom: "1px solid rgba(60, 60, 120, 0.3)",
                      fontSize: 10, color: "#666688",
                    }}>
                      {debugPackages.map((p) => (
                        <div key={p} style={{ padding: "1px 0" }}>&#x1F4E6; {p}</div>
                      ))}
                    </div>
                  )}

                  {/* Console log */}
                  <div style={{
                    flex: 1, display: "flex", flexDirection: "column",
                    minHeight: 0,
                  }}>
                    <div style={{
                      padding: "4px 14px", fontSize: 10, color: "#555577",
                      textTransform: "uppercase", letterSpacing: 1,
                      borderBottom: "1px solid rgba(60, 60, 120, 0.3)",
                      display: "flex", justifyContent: "space-between",
                    }}>
                      <span>Console</span>
                      <button
                        onClick={() => setDebugLogs([])}
                        style={{
                          background: "none", border: "none",
                          color: "#555577", cursor: "pointer",
                          fontSize: 10, padding: 0,
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <div
                      ref={debugLogRef}
                      style={{
                        flex: 1, overflow: "auto", padding: "4px 14px",
                        lineHeight: 1.5,
                      }}
                    >
                      {debugLogs.length === 0 ? (
                        <span style={{ color: "#444466", fontStyle: "italic" }}>
                          Waiting for output...
                        </span>
                      ) : (
                        debugLogs.map((entry, i) => (
                          <div key={i} style={{
                            color: entry.msg.startsWith("[error]") ? "#ff6655"
                              : entry.msg.startsWith("[warn]") ? "#ccaa44"
                                : "#88aadd",
                            padding: "1px 0",
                            wordBreak: "break-word",
                          }}>
                            {entry.msg}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{
              height: "100%", display: "flex", flexDirection: "column", overflow: "hidden",
            }}>
              {phase === "building" && (
                <div style={{ height: 3, background: "#1a1a30", flexShrink: 0 }}>
                  <div style={{
                    height: "100%",
                    width: `${projects.length > 0 ? (completedCount / projects.length) * 100 : 0}%`,
                    background: "linear-gradient(90deg, #44aaff, #44cc88)",
                    transition: "width 0.3s",
                    minWidth: completedCount > 0 ? 4 : 0,
                  }} />
                </div>
              )}
              <div style={{
                flex: 1, overflow: "auto", padding: 16,
                fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 12,
                color: "#88aadd", lineHeight: 1.6, whiteSpace: "pre-wrap",
              }}>
                {log || "Preparing..."}
              </div>
              {phase === "error" && (
                <div style={{
                  padding: 12, borderTop: "1px solid #1a1a30", flexShrink: 0,
                  display: "flex", gap: 8, justifyContent: "center",
                }}>
                  <button onClick={handleStop} style={{
                    padding: "6px 16px", background: "#2a0a0a", color: "#ff8877",
                    border: "1px solid #663333", borderRadius: 6, cursor: "pointer", fontSize: 12,
                  }}>
                    Close & fix errors
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 9, color: "#555577", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </div>
  );
}
