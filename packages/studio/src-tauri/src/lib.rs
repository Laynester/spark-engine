mod file_ops;
mod recent;
mod workspace;

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;

fn get_app_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
fn create_workspace(path: String, name: String) -> Result<workspace::WorkspaceManifest, String> {
    workspace::create_workspace(&path, &name)
}

#[tauri::command]
fn open_workspace(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<workspace::WorkspaceManifest, String> {
    let manifest = workspace::open_workspace(&path)?;

    // Add to recent
    let app_dir = get_app_dir(&app_handle);
    let _ = recent::add_recent(&app_dir, &path, &manifest.name);

    Ok(manifest)
}

#[tauri::command]
fn save_workspace(path: String, manifest: workspace::WorkspaceManifest) -> Result<(), String> {
    workspace::save_workspace(&path, &manifest)
}

#[tauri::command]
fn find_projects(path: String) -> Result<Vec<String>, String> {
    workspace::find_projects(&path)
}

#[tauri::command]
fn list_recent_workspaces(app_handle: tauri::AppHandle) -> Vec<recent::RecentEntry> {
    let app_dir = get_app_dir(&app_handle);
    recent::list_recent(&app_dir)
}

#[tauri::command]
fn add_recent_workspace(
    app_handle: tauri::AppHandle,
    path: String,
    name: String,
) -> Result<(), String> {
    let app_dir = get_app_dir(&app_handle);
    recent::add_recent(&app_dir, &path, &name)
}

#[tauri::command]
fn clear_recent_workspaces(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_dir = get_app_dir(&app_handle);
    recent::clear_recent(&app_dir)
}

#[tauri::command]
fn list_directory(path: String) -> Result<file_ops::DirectoryContents, String> {
    file_ops::list_directory(&path)
}

#[tauri::command]
fn list_directory_recursive(path: String) -> Result<Vec<file_ops::FileEntry>, String> {
    file_ops::list_directory_recursive(&path)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    file_ops::read_file(&path)
}

#[tauri::command]
fn read_file_binary(path: String) -> Result<String, String> {
    file_ops::read_file_binary(&path)
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    file_ops::write_file(&path, &content)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    file_ops::file_exists(&path)
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    file_ops::create_file(&path)
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    file_ops::create_directory(&path)
}

#[tauri::command]
fn rename_entry(old_path: String, new_name: String) -> Result<String, String> {
    file_ops::rename_entry(&old_path, &new_name)
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    file_ops::delete_entry(&path)
}

/// Helper: get the home directory path.
fn home_dir() -> PathBuf {
    #[cfg(unix)]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile);
        }
    }
    PathBuf::from(".")
}

/// Try to locate `npx` on the system.
///
/// In a bundled Tauri app the process PATH is restricted, so we also check
/// common installation paths and try login shells that load user profiles.
fn find_npx() -> String {
    let home = home_dir();

    // ── 1. Try PATH via a login shell ──────────────────────
    // A login shell (`-l`) sources profile files (.zprofile, .bash_profile)
    // where version managers (Homebrew, Volta, nvm, fnm) typically add
    // themselves to PATH.
    #[cfg(unix)]
    {
        // macOS defaults to zsh; Linux often uses bash
        for shell in ["zsh", "bash", "sh"] {
            if let Ok(output) = Command::new(shell)
                .args(["-lc", "which npx"])
                .output()
            {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .to_string();
                    if !path.is_empty() && Path::new(&path).exists() {
                        return path;
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    {
        // `where npx.cmd` via cmd should resolve from PATH, but might not
        // in a bundled app. Still worth trying.
        if let Ok(output) = Command::new("cmd")
            .args(["/c", "where npx.cmd"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = stdout.lines().next() {
                    let path = line.trim().to_string();
                    if !path.is_empty() && Path::new(&path).exists() {
                        return path;
                    }
                }
            }
        }
    }

    // ── 2. Common per-platform installation paths ──────────
    // Build path list per platform — all items must be String for vec! uniformity
    let common_paths: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            "/opt/homebrew/bin/npx".into(),       // Apple Silicon Homebrew
            "/usr/local/bin/npx".into(),           // Intel Homebrew / manual
            "/opt/local/bin/npx".into(),            // MacPorts
            "/usr/local/share/npm/bin/npx".into(), // npm global
            format!("{}/.volta/bin/npx", home.display()),
            format!("{}/.nvm/versions/node/*/bin/npx", home.display()),
        ]
    } else if cfg!(windows) {
        let appdata = std::env::var("APPDATA")
            .map(|a| PathBuf::from(a).join("npm").join("npx.cmd").to_string_lossy().to_string())
            .unwrap_or_default();
        let mut p: Vec<String> = vec![
            r"C:\Program Files\nodejs\npx.cmd".into(),
            r"C:\Program Files (x86)\nodejs\npx.cmd".into(),
        ];
        if !appdata.is_empty() {
            p.push(appdata);
        }
        p
    } else {
        // Linux
        vec![
            "/usr/bin/npx".into(),
            "/usr/local/bin/npx".into(),
            "/usr/lib/node_modules/.bin/npx".into(),
        ]
    };

    for path in &common_paths {
        let p = Path::new(path);
        if p.is_file() && p.exists() {
            return path.clone();
        }
        // Handle glob-like patterns (e.g. {home}/.nvm/versions/node/*/bin/npx)
        if path.contains('*') {
            if let Some(prefix) = path.split('*').next() {
                // prefix is the directory containing the wildcard match
                let dir = Path::new(prefix);
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("bin").join("npx");
                        if candidate.is_file() {
                            return candidate.to_string_lossy().to_string();
                        }
                    }
                }
            }
        }
    }

    // ── 3. Last resort: let the OS try via its default PATH ─
    "npx".to_string()
}

#[derive(Debug, serde::Serialize)]
pub struct BuildOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub output_path: Option<String>,
}

#[tauri::command]
fn build_project(project_path: String) -> Result<BuildOutput, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "Could not find project root".to_string())?;
    let builder_cli = project_root.join("builder/src/cli.ts");

    if !builder_cli.exists() {
        return Err(format!("Builder CLI not found at {:?}", builder_cli));
    }

    // Derive workspace path (parent of the project directory)
    let project_buf = PathBuf::from(&project_path);
    let workspace_built = project_buf
        .parent()
        .map(|p| p.join(".built"))
        .unwrap_or_else(|| PathBuf::from(".built"));
    let workspace_built_str = workspace_built.to_string_lossy().to_string();

    let npx_path = find_npx();
    let output = Command::new(&npx_path)
        .args([
            "tsx",
            &builder_cli.to_string_lossy(),
            "build",
            "--output-dir",
            &workspace_built_str,
        ])
        .current_dir(&project_path)
        .output()
        .map_err(|e| {
            format!(
                "Could not run the Spark builder. Is Node.js installed?\n\
             Make sure `npx` is available on your PATH.\n\
             Tried: {}\n\
             Details: {}",
                npx_path,
                e
            )
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();

    // Construct the expected .sprk output path
    // The builder outputs to {workspace}/.built/{name}.sprk
    let output_path = if success {
        let config_path = project_buf.join("spark.config.json");
        std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .map(|config| {
                let name = config
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("project");
                let path = workspace_built.join(format!("{}.sprk", name));
                path.to_string_lossy().to_string()
            })
    } else {
        None
    };

    Ok(BuildOutput {
        success,
        stdout,
        stderr,
        output_path,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            create_workspace,
            open_workspace,
            save_workspace,
            find_projects,
            list_recent_workspaces,
            add_recent_workspace,
            clear_recent_workspaces,
            list_directory,
            list_directory_recursive,
            read_file,
            read_file_binary,
            write_file,
            file_exists,
            create_file,
            create_directory,
            delete_entry,
            rename_entry,
            build_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spark Studio");
}
