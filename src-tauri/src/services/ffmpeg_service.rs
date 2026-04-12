use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;
use std::fs;
use base64::Engine as _;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub file_path: String,
    pub thumbnail_data: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub has_audio: bool,
}

/// Ensures the standard OverAI temporary directories exist.
pub fn initialize_temp_dirs() -> Result<PathBuf, String> {
    let mut temp_dir = std::env::temp_dir();
    temp_dir.push("overai");
    temp_dir.push("thumbnails");
    
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create temp directory: {}", e))?;
        
    Ok(temp_dir)
}

/// Real-world media import using FFmpeg/FFprobe.
pub async fn import_media(file_path: String) -> Result<MediaAsset, String> {
    println!("Importing media: {}", file_path);
    let id = Uuid::new_v4().to_string();
    let temp_thumb_dir = initialize_temp_dirs()?;
    let thumbnail_path = temp_thumb_dir.join(format!("{}.jpg", id)).to_string_lossy().to_string();
    
    // 1. Generate Thumbnail via FFmpeg (May fail for audio, which is fine)
    println!("Generating thumbnail at: {}", thumbnail_path);
    let thumb_status = tokio::process::Command::new("ffmpeg")
        .args([
            "-y", 
            "-i", &file_path, 
            "-ss", "0.5", 
            "-vframes", "1", 
            "-update", "1",
            "-f", "image2", 
            &thumbnail_path
        ])
        .status()
        .await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;
        
    let mut base64_str = String::new();
    if thumb_status.success() {
        if let Ok(thumb_bytes) = fs::read(&thumbnail_path) {
            base64_str = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&thumb_bytes));
            let _ = fs::remove_file(&thumbnail_path);
        }
    } else {
        println!("FFmpeg thumbnail generation failed/skipped (Likely audio file).");
    }

    // 2. Probe Metadata via FFprobe (Fallback for Audio/Video)
    // First, try video stream
    let probe_video = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "error", 
            "-select_streams", "v:0", 
            "-show_entries", "stream=width,height,duration", 
            "-of", "csv=p=0:nk=1", 
            &file_path
        ])
        .output()
        .await
        .map_err(|e| format!("FFprobe execution failed: {}", e))?;

    let mut width = 0;
    let mut height = 0;
    let mut duration = 0.0;

    if probe_video.status.success() {
        let output_str = String::from_utf8_lossy(&probe_video.stdout);
        let parts: Vec<&str> = output_str.trim().split(',').collect();
        if parts.len() >= 3 {
            width = parts[0].parse::<u32>().unwrap_or(0);
            height = parts[1].parse::<u32>().unwrap_or(0);
            duration = parts[2].parse::<f64>().unwrap_or(0.0);
        }
    }

    // If duration is still 0 (e.g. pure audio file), query format duration
    if duration == 0.0 {
        let probe_format = tokio::process::Command::new("ffprobe")
            .args([
                "-v", "error", 
                "-show_entries", "format=duration", 
                "-of", "default=noprint_wrappers=1:nokey=1", 
                &file_path
            ])
            .output()
            .await
            .map_err(|e| format!("FFprobe format execution failed: {}", e))?;
            
        if probe_format.status.success() {
            let output_str = String::from_utf8_lossy(&probe_format.stdout);
            duration = output_str.trim().parse::<f64>().unwrap_or(0.0);
        }
    }

    // 3. Probe Audio stream specifically
    let probe_audio = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "error", 
            "-select_streams", "a", 
            "-show_entries", "stream=codec_type", 
            "-of", "csv=p=0:nk=1", 
            &file_path
        ])
        .output()
        .await
        .map_err(|e| format!("FFprobe audio check failed: {}", e))?;

    let mut has_audio = false;
    if probe_audio.status.success() {
        let out = String::from_utf8_lossy(&probe_audio.stdout);
        has_audio = out.contains("audio");
    }

    // 4. Image file detection: images have no duration, default to 3 seconds
    let ext = file_path.split('.').last().unwrap_or("").to_lowercase();
    let image_exts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg"];
    let is_image = image_exts.contains(&ext.as_str());

    if is_image {
        duration = 3.0;
        has_audio = false;
        // Use the image itself as thumbnail if we don't have one
        if base64_str.is_empty() {
            if let Ok(img_bytes) = fs::read(&file_path) {
                let mime = match ext.as_str() {
                    "png" => "image/png",
                    "gif" => "image/gif",
                    "webp" => "image/webp",
                    "bmp" => "image/bmp",
                    _ => "image/jpeg",
                };
                base64_str = format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(&img_bytes));
            }
        }
        // For images, get dimensions from video stream probe (FFprobe treats images as single-frame video)
        if width == 0 {
            width = 1920;
            height = 1080;
        }
    }

    if duration == 0.0 {
        return Err("Failed to extract duration metadata".to_string());
    }

    println!("Media imported successfully: {}x{}, {}s{}", width, height, duration, if is_image { " [IMAGE]" } else { "" });

    Ok(MediaAsset {
        id,
        file_path,
        thumbnail_data: base64_str,
        duration,
        width,
        height,
        has_audio,
    })
}
