use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const MAX_RECENT: usize = 10;
const RECENT_FILE: &str = "recent-workspaces.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub last_opened: String,
}

fn recent_file_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join(RECENT_FILE)
}

pub fn list_recent(app_dir: &PathBuf) -> Vec<RecentEntry> {
    let file_path = recent_file_path(app_dir);

    if !file_path.exists() {
        return Vec::new();
    }

    match fs::read_to_string(&file_path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

pub fn add_recent(app_dir: &PathBuf, path: &str, name: &str) -> Result<(), String> {
    let mut entries = list_recent(app_dir);

    // Remove existing entry with same path (deduplicate)
    entries.retain(|e| e.path != path);

    // Add to front
    let now = crate::workspace::chrono_now();
    entries.insert(
        0,
        RecentEntry {
            path: path.to_string(),
            name: name.to_string(),
            last_opened: now,
        },
    );

    // Cap at MAX_RECENT
    entries.truncate(MAX_RECENT);

    let content = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("Failed to serialize recent: {}", e))?;

    // Ensure app dir exists
    if let Some(parent) = recent_file_path(app_dir).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create app dir: {}", e))?;
    }

    fs::write(recent_file_path(app_dir), content)
        .map_err(|e| format!("Failed to write recent: {}", e))?;

    Ok(())
}

pub fn clear_recent(app_dir: &PathBuf) -> Result<(), String> {
    let file_path = recent_file_path(app_dir);
    if file_path.exists() {
        fs::remove_file(&file_path).map_err(|e| format!("Failed to clear recent: {}", e))?;
    }
    Ok(())
}
