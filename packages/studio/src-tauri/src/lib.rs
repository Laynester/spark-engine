mod file_ops;
mod recent;
mod workspace;

use std::path::PathBuf;
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
fn write_file_binary(path: String, content: String) -> Result<(), String> {
    file_ops::write_file_binary(&path, &content)
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
            write_file_binary,
            file_exists,
            create_file,
            create_directory,
            delete_entry,
            rename_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Spark Studio");
}
