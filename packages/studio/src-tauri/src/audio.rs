use base64::Engine;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, serde::Serialize)]
pub struct AudioOptimizeResult {
    pub data: String,
    pub original_size: u64,
    pub optimized_size: u64,
    pub ext: String,
}

/// Run ffmpeg on an audio file in a non-blocking worker thread.
/// The actual heavy-lifting (disk I/O + ffmpeg process) runs inside
/// `tokio::task::spawn_blocking` so it doesn't stall the Tauri async runtime.
pub async fn optimize_audio(path: String, bitrate: u32) -> Result<AudioOptimizeResult, String> {
    tokio::task::spawn_blocking(move || optimize_audio_blocking(&path, bitrate))
        .await
        .map_err(|e| format!("Blocking task panicked: {}", e))?
}

fn optimize_audio_blocking(path: &str, bitrate: u32) -> Result<AudioOptimizeResult, String> {
    let file_path = PathBuf::from(path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    let original = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let original_size = original.len() as u64;

    // Don't bother with tiny files
    if original_size < 2048 {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&original);
        return Ok(AudioOptimizeResult {
            data: b64,
            original_size,
            optimized_size: original_size,
            ext: file_path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default(),
        });
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let out_fmt = match ext.as_str() {
        "mp3" => "mp3",
        "ogg" => "ogg",
        "m4a" => "ipod",
        "aac" => "adts",
        "wma" => "asf",
        "wav" | "flac" => "mp3",
        _ => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&original);
            return Ok(AudioOptimizeResult {
                data: b64,
                original_size,
                optimized_size: original_size,
                ext: format!(".{}", ext),
            });
        }
    };

    let result = Command::new("ffmpeg")
        .args([
            "-i", "pipe:0",
            "-b:a", &format!("{}k", bitrate),
            "-map_metadata", "-1",
            "-f", out_fmt,
            "pipe:1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    let mut child = match result {
        Ok(c) => c,
        Err(_) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&original);
            return Ok(AudioOptimizeResult {
                data: b64,
                original_size,
                optimized_size: original_size,
                ext: format!(".{}", ext),
            });
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&original);
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&original);
            return Ok(AudioOptimizeResult {
                data: b64,
                original_size,
                optimized_size: original_size,
                ext: format!(".{}", ext),
            });
        }
    };

    if !output.status.success() || output.stdout.is_empty() || output.stdout.len() as u64 >= original_size {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&original);
        return Ok(AudioOptimizeResult {
            data: b64,
            original_size,
            optimized_size: original_size,
            ext: format!(".{}", ext),
        });
    }

    let optimized_size = output.stdout.len() as u64;
    let out_ext = if out_fmt != ext.as_str() {
        format!(".{}", out_fmt)
    } else {
        format!(".{}", ext)
    };

    Ok(AudioOptimizeResult {
        data: base64::engine::general_purpose::STANDARD.encode(&output.stdout),
        original_size,
        optimized_size,
        ext: out_ext,
    })
}
