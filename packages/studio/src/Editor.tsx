import { useRef, useCallback, useEffect, act } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount, BeforeMount } from "@monaco-editor/react";
import { listDirectory, readFile } from "./workspace";
import {
  parseSparkImports,
  discoverLibraryScripts,
  resolveSparkImport,
  buildCompletionDetail,
  generateClassDeclarations,
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
  const runtimeLoadedRef = useRef(false);
  const libraryProjectsRef = useRef<LibraryProject[]>([]);
  const libraryTypesDisposableRef = useRef<any>(null);

  const activeFileData = files.find((f) => f.path === activeFile) ?? null;

  const PROJECT_ROOT = "file:///workspace";

  const toUri = useCallback((p: string) => {
    const normalized = p.startsWith("/") ? p : "/" + p;
    return monacoRef.current?.Uri.parse(`${PROJECT_ROOT}${normalized}`);
  }, []);

  // ============================
  // BEFORE MOUNT
  // ============================
  const handleBeforeMount: BeforeMount = useCallback((monaco) => {
    monacoRef.current = monaco;
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      module: monaco.languages.typescript.ModuleKind.ESNext,
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      baseUrl: PROJECT_ROOT,
      paths: {
        "@spark/runtime": ["node_modules/@spark/*"],
        "@spark/*": ["node_modules/@spark/*"],
      },
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      allowJs: true,
      checkJs: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      strict: false,
      skipLibCheck: true,
      resolveJsonModule: true,
    });

    // Spark import("") completion
    monaco.languages.registerCompletionItemProvider("typescript", {
      triggerCharacters: ['"', "'"],
      provideCompletionItems: (model: any, position: any) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const match = textUntilPosition.match(/spark\.import\(\s*["']([^"']*)$/);
        if (!match) return { suggestions: [] };

        const typed = match[1];
        return {
          suggestions: libraryProjectsRef.current.flatMap((proj) =>
            proj.scripts
              .filter((s) => s.qualified.toLowerCase().includes(typed.toLowerCase()))
              .map((script) => ({
                label: script.qualified,
                kind: monaco.languages.CompletionItemKind.Module,
                detail: buildCompletionDetail(script),
                documentation: `Library: ${proj.name}`,
                insertText: script.qualified,
                range: {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: position.column - typed.length,
                  endColumn: position.column,
                },
              }))
          ),
        };
      },
    });
    (async () => {
      loadRuntimeDts(monaco);
      let cancelled = false;
      // Load libraries
      if (workspacePath && projects.length > 0) {
        try {
          const libs = await discoverLibraryScripts(workspacePath, projects);
          if (cancelled) return;
          libraryProjectsRef.current = libs;
          await updateLibraryTypes(monaco);
        } catch (e) { }
      }

      // Background models (siblings + spark.import)
      try {
        const dir = activeFile.includes("/") ? activeFile.slice(0, activeFile.lastIndexOf("/")) : ".";
        const { entries } = await listDirectory(dir);

        for (const entry of entries) {
          if (cancelled || entry.is_dir || entry.path === activeFile) continue;
          if (!/\.(ts|d\.ts)$/.test(entry.name)) continue;

          const uri = toUri(entry.path);
          if (!monaco.editor.getModel(uri)) {
            const content = await readFile(entry.path);
            monaco.editor.createModel(content, "typescript", uri);
          }
        }

        const content = await readFile(activeFile);
        const imports = parseSparkImports(content);
        for (const imp of imports) {
          const resolved = resolveSparkImport(imp, libraryProjectsRef.current);
          if (!resolved) continue;
          const uri = toUri(resolved.diskPath);
          if (!monaco.editor.getModel(uri)) {
            const src = await readFile(resolved.diskPath);
            monaco.editor.createModel(src, "typescript", uri);
          }
        }
      } catch (e) { }
    })();

  }, [activeFile]);

  // ============================
  // PROPER RUNTIME LOADING
  // ============================
  async function loadRuntimeDts(monaco: any) {
    if (runtimeLoadedRef.current) return;
    runtimeLoadedRef.current = true;

    try {
      // Bootstrap file that imports the real index
      monaco.editor.createModel(
        `import "@spark/runtime";`,
        "typescript",
        monaco.Uri.parse("file:///__spark_bootstrap__.ts")
      );

      // Package.json for proper module resolution
      monaco.editor.createModel(
        JSON.stringify({
          name: "@spark/runtime",
          version: "1.0.0",
          types: "./index.d.ts",
          main: "./index.d.ts",
        }),
        "json",
        monaco.Uri.parse("file:///node_modules/@spark/runtime/package.json")
      );

      // Load all runtime definition files
      const fileList = ["index.d.ts", "SparkRuntime.d.ts", "Entity.d.ts", "EventBus.d.ts", "types.d.ts"];

      await Promise.all(
        fileList.map(async (name) => {
          if (!name.endsWith(".d.ts")) return;
          try {
            const content = await fetch(`/runtime/${name}`).then((r) => r.text());
            monaco.languages.typescript.typescriptDefaults.addExtraLib(
              content,
              `file:///node_modules/@spark/runtime/${name}`
            );
          } catch (err) {
            console.warn(`Failed to load ${name}`, err);
          }
        })
      );

      console.log("✅ Spark runtime types loaded");
    } catch (err) {
      console.error("Failed to load runtime types", err);
    }
  }

  async function updateLibraryTypes(monaco: any) {
    if (libraryTypesDisposableRef.current) {
      libraryTypesDisposableRef.current.dispose();
    }

    const declarations: string[] = [];
    for (const project of libraryProjectsRef.current) {
      for (const script of project.scripts) {
        try {
          const content = await readFile(script.diskPath);
          declarations.push(...generateClassDeclarations(content));
        } catch { }
      }
    }

    if (declarations.length > 0) {
      libraryTypesDisposableRef.current = monaco.languages.typescript.typescriptDefaults.addExtraLib(
        declarations.join("\n"),
        `file:///__spark_library_types_${Date.now()}.d.ts`
      );
    }
  }

  // ============================
  // BACKGROUND MODELS
  // ============================
  useEffect(() => {
    if (!activeFile || !monacoRef.current) return;

    const monaco = monacoRef.current;
    let cancelled = false;

    (async () => {
      // Load libraries
      if (workspacePath && projects.length > 0) {
        try {
          const libs = await discoverLibraryScripts(workspacePath, projects);
          if (cancelled) return;
          libraryProjectsRef.current = libs;
          await updateLibraryTypes(monaco);
        } catch (e) { }
      }

      // Background models (siblings + spark.import)
      try {
        const dir = activeFile.includes("/") ? activeFile.slice(0, activeFile.lastIndexOf("/")) : ".";
        const { entries } = await listDirectory(dir);

        for (const entry of entries) {
          if (cancelled || entry.is_dir || entry.path === activeFile) continue;
          if (!/\.(ts|d\.ts)$/.test(entry.name)) continue;

          const uri = toUri(entry.path);
          if (!monaco.editor.getModel(uri)) {
            const content = await readFile(entry.path);
            monaco.editor.createModel(content, "typescript", uri);
          }
        }

        const content = await readFile(activeFile);
        const imports = parseSparkImports(content);
        for (const imp of imports) {
          const resolved = resolveSparkImport(imp, libraryProjectsRef.current);
          if (!resolved) continue;
          const uri = toUri(resolved.diskPath);
          if (!monaco.editor.getModel(uri)) {
            const src = await readFile(resolved.diskPath);
            monaco.editor.createModel(src, "typescript", uri);
          }
        }
      } catch (e) { }
    })();

    return () => { cancelled = true; };
  }, [activeFile, workspacePath, projects, toUri]);

  const handleEditorDidMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleEditorChange = useCallback((value?: string) => {
    if (activeFile && value !== undefined) {
      onFileChange(activeFile, value);
    }
  }, [activeFile, onFileChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab Bar */}
      <div style={{ display: "flex", background: "#0d0d1a", borderBottom: "1px solid #1a1a30", overflowX: "auto", flexShrink: 0 }}>
        {files.map((file) => (
          <div
            key={file.path}
            onClick={() => onSetActive(file.path)}
            style={{
              padding: "8px 16px",
              cursor: "pointer",
              color: file.path === activeFile ? "#fff" : "#aaa",
              background: file.path === activeFile ? "#1e1e3a" : "transparent",
              borderBottom: file.path === activeFile ? "2px solid #44aaff" : "none",
            }}
          >
            {getDisplayName(file.path)}
            {file.dirty && <span style={{ color: "#ffcc00" }}> •</span>}
          </div>
        ))}
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeFileData ? (
          <Editor
            path={activeFileData.path}
            language="typescript"
            value={activeFileData.content}
            theme="vs-dark"
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            options={{
              automaticLayout: true,
              fontSize: 14,
              minimap: { enabled: true },
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              parameterHints: { enabled: true },
              wordWrap: "on",
            }}
          />
        ) : (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#666" }}>
            Open a file from the project tree
          </div>
        )}
      </div>
    </div>
  );
}