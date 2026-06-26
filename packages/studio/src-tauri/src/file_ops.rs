use base64::Engine;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct DirectoryContents {
    pub entries: Vec<FileEntry>,
    pub path: String,
}

pub fn list_directory(path: &str) -> Result<DirectoryContents, String> {
    let dir = PathBuf::from(path);

    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries = Vec::new();

    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let meta = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
        });
    }

    // Sort: directories first, then files, alphabetically
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(DirectoryContents {
        entries,
        path: dir.to_string_lossy().to_string(),
    })
}

pub fn read_file(path: &str) -> Result<String, String> {
    let file_path = PathBuf::from(path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))
}

pub fn read_file_binary(path: &str) -> Result<String, String> {
    let file_path = PathBuf::from(path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let data = fs::read(&file_path).map_err(|e| format!("Failed to read binary file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    let file_path = PathBuf::from(path);

    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&file_path, content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn file_exists(path: &str) -> bool {
    PathBuf::from(path).exists()
}

pub fn create_file(path: &str) -> Result<(), String> {
    let file_path = PathBuf::from(path);

    if file_path.exists() {
        return Err(format!("File already exists: {}", path));
    }

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(())
}

pub fn create_directory(path: &str) -> Result<(), String> {
    let dir_path = PathBuf::from(path);

    if dir_path.exists() {
        return Err(format!("Directory already exists: {}", path));
    }

    fs::create_dir_all(&dir_path).map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(())
}

pub fn rename_entry(old_path: &str, new_name: &str) -> Result<String, String> {
    let src = PathBuf::from(old_path);

    if !src.exists() {
        return Err(format!("Not found: {}", old_path));
    }

    let parent = src.parent().ok_or_else(|| "Cannot rename root".to_string())?;
    let dst = parent.join(new_name);

    if dst.exists() {
        return Err(format!("A file or folder named \"{}\" already exists", new_name));
    }

    fs::rename(&src, &dst).map_err(|e| format!("Failed to rename: {}", e))?;

    Ok(dst.to_string_lossy().to_string())
}

pub fn delete_entry(path: &str) -> Result<(), String> {
    let entry_path = PathBuf::from(path);

    if !entry_path.exists() {
        return Err(format!("Not found: {}", path));
    }

    if entry_path.is_dir() {
        fs::remove_dir_all(&entry_path).map_err(|e| format!("Failed to remove directory: {}", e))?;
    } else {
        fs::remove_file(&entry_path).map_err(|e| format!("Failed to remove file: {}", e))?;
    }

    Ok(())
}

pub fn list_directory_recursive(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(path);

    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    let mut entries = Vec::new();
    walk_dir(&dir, &mut entries).map_err(|e| format!("Failed to walk directory: {}", e))?;

    // Sort: directories first, then files, alphabetically
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(entries)
}

fn walk_dir(dir: &PathBuf, entries: &mut Vec<FileEntry>) -> Result<(), std::io::Error> {
    let read_dir = fs::read_dir(dir)?;

    for entry in read_dir {
        let entry = entry?;
        let meta = entry.metadata()?;
        let file_path = entry.path();
        let relative_path = file_path.to_string_lossy().to_string();

        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: relative_path.clone(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
        });

        if meta.is_dir() {
            walk_dir(&file_path, entries)?;
        }
    }

    Ok(())
}
