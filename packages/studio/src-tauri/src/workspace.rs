use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceProject {
    pub path: String,
    #[serde(rename = "type")]
    pub project_type: String, // "app" or "lib"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceManifest {
    #[serde(default = "default_spark_version")]
    pub spark_version: String,
    pub name: String,
    pub entry_project: Option<String>,
    pub projects: HashMap<String, WorkspaceProject>,
    pub last_opened: Option<String>,
    /// Canvas width in pixels. When set, the player uses this instead of filling the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Canvas height in pixels. When set, the player uses this instead of filling the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

fn default_spark_version() -> String {
    "0.1.0".to_string()
}

const MANIFEST_FILE: &str = "spark-workspace.json";

pub fn create_workspace(path: &str, name: &str) -> Result<WorkspaceManifest, String> {
    let dir = PathBuf::from(path);

    if dir.exists() {
        return Err(format!("Directory already exists: {}", path));
    }

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;

    let manifest = WorkspaceManifest {
        spark_version: default_spark_version(),
        name: name.to_string(),
        entry_project: None,
        projects: HashMap::new(),
        last_opened: Some(chrono_now()),
        width: None,
        height: None,
    };

    save_manifest(&dir, &manifest)?;

    Ok(manifest)
}

pub fn open_workspace(path: &str) -> Result<WorkspaceManifest, String> {
    let dir = PathBuf::from(path);

    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    let manifest_path = dir.join(MANIFEST_FILE);
    if !manifest_path.exists() {
        return Err(format!(
            "Not a Spark workspace: {} not found in {}",
            MANIFEST_FILE, path
        ));
    }

    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;

    let mut manifest: WorkspaceManifest = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid workspace manifest: {}", e))?;

    // Update last opened timestamp
    manifest.last_opened = Some(chrono_now());
    save_manifest(&dir, &manifest)?;

    Ok(manifest)
}

pub fn save_workspace(path: &str, manifest: &WorkspaceManifest) -> Result<(), String> {
    let dir = PathBuf::from(path);
    save_manifest(&dir, manifest)
}

pub fn find_projects(path: &str) -> Result<Vec<String>, String> {
    let dir = PathBuf::from(path);

    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    let mut projects = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let entry_path = entry.path();

        if entry_path.is_dir() {
            let config_path = entry_path.join("spark.config.json");
            if config_path.exists() {
                if let Some(name) = entry_path.file_name() {
                    projects.push(name.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(projects)
}

fn save_manifest(dir: &PathBuf, manifest: &WorkspaceManifest) -> Result<(), String> {
    let content = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;

    fs::write(dir.join(MANIFEST_FILE), content)
        .map_err(|e| format!("Failed to write manifest: {}", e))?;

    Ok(())
}

pub fn chrono_now() -> String {
    // Simple ISO-like timestamp without chrono dependency
    // Format: 2026-06-25T18:00:00Z
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();

    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let mins = (time_secs % 3600) / 60;
    let secs_remainder = time_secs % 60;

    // January 1, 2026 = UNIX epoch 1767225600
    // Approximate from there
    let year = 2026;
    let day_of_year = (secs - 1767225600) / 86400;
    let month = (day_of_year / 28 + 1).min(12);
    let day = (day_of_year % 28 + 1).min(28);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, mins, secs_remainder
    )
}
