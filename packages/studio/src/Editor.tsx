import { useRef, useCallback, useEffect } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount, BeforeMount } from "@monaco-editor/react";
import { listDirectory, readFile } from "./workspace";
import {
  parseSparkImports,
  discoverLibraryScripts,
  resolveSparkImport,
  buildCompletionDetail,
} from "./sparkImportParser";
import type { LibraryProject } from "./sparkImportParser";

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
}

interface EditorPanelProps {
  files: OpenFile[];
  activeFile: string | null;
  onFileChange: (path: string, content: string) => void;
  onFileSave: (path: string, content: string) => void;
  onCloseTab: (path: string) => void;
  onSetActive: (path: string) => void;
  workspacePath: string;
  projects: string[];
}

function getDisplayName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function EditorPanel({
  files,
  activeFile,
  onFileChange,
  onFileSave,
  onSetActive,
  workspacePath,
  projects,
}: EditorPanelProps) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const bgModelsRef = useRef<Set<string>>(new Set());
  const runtimeLoadedRef = useRef(false);
  const libraryProjectsRef = useRef<LibraryProject[]>([]);

  const activeFileData = files.find((f) => f.path === activeFile) ?? null;

  const PROJECT_ROOT = "file:///workspace";

  const toUri = useCallback((p: string) => {
    // Normalize path: make sure it starts with /
    let normalized = p.startsWith("/") ? p : "/" + p;
    return monacoRef.current.Uri.parse(`${PROJECT_ROOT}${normalized}`);
  }, []);

  // ============================
  // BEFORE MOUNT - Compiler + Runtime Types
  // ============================
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monacoRef.current = monaco;

    // Compiler options
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      module: monaco.languages.typescript.ModuleKind.ESNext,
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      baseUrl: "/",
      paths: {
        "@spark/runtime": ["node_modules/@spark/*"],
      },
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      allowJs: true,
      checkJs: false,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      strict: true,
    });

    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);

    // Register completion provider for spark.import("...") paths
    monaco.languages.registerCompletionItemProvider("typescript", {
      triggerCharacters: ['"', "'"],
      provideCompletionItems: (model: any, position: any) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        // Only activate inside spark.import("...") or spark.import('...')
        const match = textUntilPosition.match(/spark\.import\(\s*["'"]([^"']*)$/);
        if (!match) return { suggestions: [] };

        const typed = match[1];
        const libs = libraryProjectsRef.current;

        const suggestions = libs.flatMap((proj) =>
          proj.scripts
            .filter((s) => s.qualified.toLowerCase().includes(typed.toLowerCase()))
            .map((script) => ({
              label: script.qualified,
              kind: monaco.languages.CompletionItemKind.Module,
              detail: buildCompletionDetail(script),
              insertText: script.qualified,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column - typed.length,
                endColumn: position.column,
              },
            }))
        );

        return { suggestions };
      },
    });

    // Load runtime types (only once)
    loadRuntimeDts(monaco);
    setTimeout(() => loadSiblingFiles(), 100);
  }, []);

  // ============================
  // LOAD SDK / RUNTIME TYPES
  // ============================
  async function loadRuntimeDts(monaco: any) {
    if (runtimeLoadedRef.current) return;
    runtimeLoadedRef.current = true;

    try {
      // Bootstrap to trigger module resolution
      const bootstrapUri = monaco.Uri.parse("file:///__spark_bootstrap__.ts");
      if (!monaco.editor.getModel(bootstrapUri)) {
        monaco.editor.createModel(
          `import "@spark/runtime";`,
          "typescript",
          bootstrapUri
        );
      }

      // Fake package.json
      const pkgUri = monaco.Uri.parse("file:///node_modules/@spark/runtime/package.json");
      monaco.editor.createModel(
        JSON.stringify({
          name: "@spark/runtime",
          version: "1.0.0",
          types: "index.d.ts",
          main: "index.d.ts",
        }),
        "json",
        pkgUri
      );

      // Load manifest + .d.ts files
      let fileList: string[] = ["index.d.ts", "SparkRuntime.d.ts", "Entity.d.ts", "EventBus.d.ts", "types.d.ts"];

      try {
        const res = await fetch("/runtime/index.json");
        if (res.ok) {
          fileList = await res.json();
        }
      } catch (e) {
        console.warn("No runtime/index.json found, using fallback list");
      }

      await Promise.all(
        fileList.map(async (fileName) => {
          if (!fileName.endsWith(".d.ts")) return;

          try {
            const content = await fetch(`/runtime/${fileName}`).then((r) => r.text());
            const uri = `file:///node_modules/@spark/runtime/${fileName}`;

            monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri);
            console.log(`✅ Loaded SDK types: ${fileName}`);
          } catch (err) {
            console.warn(`Failed to load ${fileName}`, err);
          }
        })
      );

      console.log("✅ Spark SDK types fully loaded");
    } catch (err) {
      console.error("Failed to load runtime .d.ts files", err);
    }
  }

  // ============================
  // WORKSPACE SIBLING + spark.import() BACKGROUND MODELS
  // ============================
  // useEffect(() => {
  //   const monaco = monacoRef.current;
  //   if (!monaco || !activeFile) return;

  //   let cancelled = false;

  //   const toUri = (p: string) =>
  //     monaco.Uri.parse("file://" + (p.startsWith("/") ? p : "/" + p));

  //   // Snapshot models from the PREVIOUS effect run and dispose them
  //   const prevModels = bgModelsRef.current;
  //   for (const path of prevModels) {
  //     const model = monaco.editor.getModel(toUri(path));
  //     if (model) model.dispose();
  //   }

  //   // Fresh set for models created by THIS run
  //   const currentModels = new Set<string>();
  //   bgModelsRef.current = currentModels;

  //   (async () => {
  //     // Step 1: Discover library projects
  //     if (workspacePath && projects.length > 0) {
  //       try {
  //         const libs = await discoverLibraryScripts(workspacePath, projects);
  //         if (cancelled) return;
  //         libraryProjectsRef.current = libs;
  //       } catch (err) {
  //         console.error("Failed to discover library scripts:", err);
  //       }
  //     }

  //     // Step 2: Scan sibling .ts/.d.ts files in the active file's directory
  //     try {
  //       const dir = activeFile.includes("/")
  //         ? activeFile.slice(0, activeFile.lastIndexOf("/"))
  //         : ".";
  //       if (cancelled) return;

  //       const result = await listDirectory(dir);
  //       if (cancelled) return;

  //       for (const entry of result.entries) {
  //         if (cancelled) return;
  //         if (entry.is_dir) continue;
  //         if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) continue;
  //         if (entry.path === activeFile) continue;

  //         try {
  //           const content = await readFile(entry.path);
  //           if (cancelled) return;
  //           const uri = toUri(entry.path);

  //           if (!monaco.editor.getModel(uri)) {
  //             monaco.editor.createModel(content, "typescript", uri);
  //             currentModels.add(entry.path);
  //             console.log(entry.path)
  //           }
  //         } catch (err) {
  //           // ignore
  //         }
  //       }
  //     } catch (err) {
  //       console.error("Failed to scan sibling files:", err);
  //     }

  //     if (cancelled) return;

  //     // Step 3: Parse spark.import() calls and load referenced library scripts
  //     try {
  //       const content = await readFile(activeFile);
  //       if (cancelled) return;
  //       const imports = parseSparkImports(content);

  //       for (const imp of imports) {
  //         if (cancelled) return;
  //         const resolved = resolveSparkImport(imp, libraryProjectsRef.current);
  //         if (!resolved) continue;

  //         const uri = toUri(resolved.diskPath);
  //         if (monaco.editor.getModel(uri)) continue;

  //         try {
  //           const sourceContent = await readFile(resolved.diskPath);
  //           if (cancelled) return;
  //           monaco.editor.createModel(sourceContent, "typescript", uri);
  //           currentModels.add(resolved.diskPath);
  //         } catch (err) {
  //           // ignore
  //         }
  //       }
  //     } catch (err) {
  //       // ignore
  //     }
  //   })();

  //   return () => {
  //     cancelled = true;
  //     // Dispose models created by this run on unmount or re-run
  //     for (const path of currentModels) {
  //       const model = monaco.editor.getModel(toUri(path));
  //       if (model) model.dispose();
  //     }
  //     if (bgModelsRef.current === currentModels) {
  //       bgModelsRef.current = new Set();
  //     }
  //   };
  // }, [activeFile, workspacePath, projects, monacoRef.current]);

  const loadSiblingFiles = useCallback(async () => {
    const monaco = monacoRef.current;
    if (!monaco || !activeFile) return;

    const toUri = (p: string) => {
      const normalized = p.startsWith("/") ? p : "/" + p;
      return monaco.Uri.parse(`file://${normalized}`);
    };

    // Aggressive cleanup
    bgModelsRef.current.forEach((path) => {
      const model = monaco.editor.getModel(toUri(path));
      if (model && !model.isDisposed()) model.dispose();
    });
    bgModelsRef.current.clear();

    try {
      const dir = activeFile.includes("/")
        ? activeFile.slice(0, activeFile.lastIndexOf("/"))
        : ".";

      const result = await listDirectory(dir);

      for (const entry of result.entries) {
        if (entry.is_dir) continue;
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) continue;
        if (entry.path === activeFile) continue;

        try {
          const content = await readFile(entry.path);
          const uri = toUri(entry.path);

          // Only create if it doesn't exist
          if (!monaco.editor.getModel(uri)) {
            monaco.editor.createModel(content, "typescript", uri);
            bgModelsRef.current.add(entry.path);
            console.log(`📄 Sibling model created: ${entry.name}`);
          }
        } catch (err) {
          console.warn(`Failed to load sibling ${entry.path}`, err);
        }
      }
    } catch (err) {
      console.error("Sibling scan failed:", err);
    }
  }, [activeFile, monacoRef]);

  useEffect(() => {
    const timeout = setTimeout(loadSiblingFiles, 120);
    return () => clearTimeout(timeout);
  }, [loadSiblingFiles]);

  // ============================
  // EDITOR CALLBACKS
  // ============================
  const handleEditorDidMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeFile && value !== undefined) {
        onFileChange(activeFile, value);
      }
    },
    [activeFile, onFileChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (editorRef.current && activeFile) {
          const value = editorRef.current.getValue();
          onFileSave(activeFile, value);
        }
      }
    },
    [activeFile, onFileSave]
  );

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* TAB BAR */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "#0d0d1a",
          borderBottom: "1px solid #1a1a30",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        {files.length === 0 && (
          <div style={{ padding: "8px 16px", color: "#444466", fontSize: 12 }}>
            Select a file to open
          </div>
        )}

        {files.map((file) => {
          const isActive = file.path === activeFile;
          return (
            <div
              key={file.path}
              onClick={() => onSetActive(file.path)}
              style={{
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: 12,
                color: isActive ? "#d0d0e0" : "#555577",
                background: isActive ? "#12122a" : "transparent",
                borderBottom: isActive ? "2px solid #44aaff" : "2px solid transparent",
              }}
            >
              {getDisplayName(file.path)}
            </div>
          );
        })}
      </div>

      {/* EDITOR AREA */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeFileData ? (
          <Editor
            key={activeFileData.path}
            path={activeFileData.path}
            language={activeFileData.language}
            value={activeFileData.content}
            theme="vs-dark"
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "#444466",
              fontSize: 13,
            }}
          >
            Open a file from the project tree
          </div>
        )}
      </div>
    </div>
  );
}