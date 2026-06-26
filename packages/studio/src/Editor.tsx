import { useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { discoverLibraryScripts, generateClassDeclarations, LibraryProject, parseSparkImports, resolveSparkImport } from "./sparkImportParser";
import { listDirectory, readFile } from "./workspace";

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
  onSetActive,
  onFileSave,
  workspacePath,
  projects
}: EditorPanelProps) {
  const activeFileData = files.find((f) => f.path === activeFile) ?? null;
  const editorRef = useRef<any>(null);
  const libraryProjectsRef = useRef<LibraryProject[]>([]);

  const handleEditorChange = useCallback(
    (value?: string) => {
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

  const handleBeforeMount = (editor: any, monaco: any) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeFile) {
        const value = editor.getValue();
        onFileSave(activeFile, value);
      }
    });
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.CommonJS,
      allowNonTsExtensions: true,
    });

    (async () => {
      monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
      try {
        // Assuming index.json returns an array like ["index.d.ts", "types.d.ts", ...]
        const fileNames: string[] = await fetch('/runtime/index.json').then((r) => r.json());

        // Use for...of to correctly iterate through the file names
        for (const fileName of fileNames) {
          // 1. Added parentheses to r.text() 
          // 2. Ensuring the fetch path has a leading slash if needed
          const fileContent = await fetch(`/runtime/${fileName}`).then((r) => r.text());

          // Registering with the correct virtual path
          monaco.languages.typescript.typescriptDefaults.addExtraLib(
            fileContent,
            `file:///node_modules/@spark/runtime/${fileName}`
          );
        }
      } catch (error) {
        console.error("Failed to load Spark runtime types:", error);
      }

      let cancelled = false;

      console.log(activeFile);
      if (!activeFile) return;

      const toUri = (p) => {
        const cleanPath = p.startsWith('/') ? p : `/${p}`;
        return monaco.Uri.file(cleanPath);
      };

      try {
        const dir = activeFile.includes("/") ? activeFile.slice(0, activeFile.lastIndexOf("/")) : ".";
        const { entries } = await listDirectory(dir);

        for (const entry of entries) {
          if (cancelled || entry.is_dir || entry.path === activeFile) continue;
          if (!/\.(ts|d\.ts)$/.test(entry.name)) continue;

          const uri = toUri(entry.path);

          // Check if Monaco already has this model using the Uri object
          if (!monaco.editor.getModel(uri)) {
            const content = await readFile(entry.path);
            console.log(`Loading sibling file: ${entry.path}`);
            // Pass the real uri object here instead of a string
            monaco.editor.createModel(content, "typescript", uri);
          }
        }

        if (workspacePath && projects.length > 0) {
          try {
            const libs = await discoverLibraryScripts(workspacePath, projects);
            if (cancelled) return;
            libraryProjectsRef.current = libs;
          } catch (e) {
            console.error(e);
          }
        }

        // 2. Parse active file for spark.import calls, but load them GLOBALLY
        const content = await readFile(activeFile);
        const imports = parseSparkImports(content);

        let globalDeclarations = "";

        for (const imp of imports) {
          const resolved = resolveSparkImport(imp, libraryProjectsRef.current);
          if (!resolved) continue;

          // Read the raw source code of the Manager.ts file
          const src = await readFile(resolved.diskPath);

          // Use your utility to parse "export class GameManager" into "declare class GameManager"
          const classDecls = generateClassDeclarations(src);

          // Append them to our active global injection block
          globalDeclarations += `\n/* Global types from ${imp.qualified} */\n` + classDecls.join("\n") + "\n";
        }

        // 3. Inject everything into Monaco as an Ambient Global Library
        if (globalDeclarations.trim().length > 0) {
          // We give it a unique virtual file name so it behaves globally
          monaco.languages.typescript.typescriptDefaults.addExtraLib(
            globalDeclarations,
            `file:///global-spark-libraries.d.ts`
          );
        }

        const activeModel = monaco.editor.getModel(toUri(activeFile));
        if (activeModel) {
          activeModel.setValue(activeModel.getValue());
        }
      } catch (e) {
        console.log('erroooor', e);
      }

    })();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab Bar */}
      <div
        style={{
          display: "flex",
          background: "#0d0d1a",
          borderBottom: "1px solid #1a1a30",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        {files.map((file) => (
          <div
            key={file.path}
            onClick={() => onSetActive(file.path)}
            style={{
              padding: "8px 16px",
              cursor: "pointer",
              color: file.path === activeFile ? "#fff" : "#aaa",
              background:
                file.path === activeFile ? "#1e1e3a" : "transparent",
              borderBottom:
                file.path === activeFile ? "2px solid #44aaff" : "none",
            }}
          >
            {getDisplayName(file.path)}
            {file.dirty && <span style={{ color: "#ffcc00" }}> •</span>}
          </div>
        ))}
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflow: "hidden" }} onKeyDown={handleKeyDown}>
        {activeFileData ? (
          <Editor
            path={activeFileData.path}
            language="typescript"
            defaultValue={activeFileData.content}
            theme="vs-dark"
            onChange={handleEditorChange}
            options={{
              automaticLayout: true,
              fontSize: 12,
              minimap: { enabled: false },
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              parameterHints: { enabled: true },
              wordWrap: "on",
            }}
            onMount={handleBeforeMount}
          />
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#666",
            }}
          >
            Open a file from the project tree
          </div>
        )}
      </div>
    </div>
  );
}

