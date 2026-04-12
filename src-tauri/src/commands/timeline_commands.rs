use tauri::command;
use std::fs;

/// Generate a frame strip for a video asset.
/// Extracts thumbnails at the given interval and caches them on disk.
/// Returns an array of file paths to the generated frames.
#[command(rename_all = "snake_case")]
pub async fn generate_frame_strip(
    file_path: String,
    asset_id: String,
    interval_sec: f64,
    duration: f64,
) -> Result<Vec<String>, String> {
    let mut strip_dir = std::env::temp_dir();
    strip_dir.push("overai");
    strip_dir.push("frame_strips");
    strip_dir.push(&asset_id);

    // Check cache: if directory exists and has files, return cached paths
    if strip_dir.exists() {
        let existing: Vec<String> = fs::read_dir(&strip_dir)
            .map_err(|e| format!("Failed to read strip dir: {}", e))?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.extension().map(|e| e == "jpg").unwrap_or(false) {
                    Some(path.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();

        if !existing.is_empty() {
            println!("Frame strip cache hit for asset {}: {} frames", asset_id, existing.len());
            let mut sorted = existing;
            sorted.sort();
            return Ok(sorted);
        }
    }

    // Create directory
    fs::create_dir_all(&strip_dir)
        .map_err(|e| format!("Failed to create frame strip dir: {}", e))?;

    println!(
        "Generating frame strip for asset {} at {}s intervals...",
        asset_id, interval_sec
    );

    // Calculate expected frame count
    let _frame_count = (duration / interval_sec).ceil() as usize;
    let output_pattern = strip_dir.join("frame_%04d.jpg").to_string_lossy().to_string();

    // Use FFmpeg fps filter to extract frames at interval
    let fps_value = format!("1/{}", interval_sec);
    let status = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-i", &file_path,
            "-vf", &format!("fps={}", fps_value),
            "-q:v", "5",       // decent quality, small size
            "-f", "image2",
            &output_pattern,
        ])
        .status()
        .await
        .map_err(|e| format!("FFmpeg frame strip failed: {}", e))?;

    if !status.success() {
        return Err("FFmpeg failed to generate frame strip".to_string());
    }

    // Collect generated file paths
    let mut paths: Vec<String> = fs::read_dir(&strip_dir)
        .map_err(|e| format!("Failed to read strip dir: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().map(|e| e == "jpg").unwrap_or(false) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect();

    paths.sort();
    println!("Frame strip generated: {} frames", paths.len());

    Ok(paths)
}

/// Generate a audio waveform image for an asset.
/// Returns the file path to the generated PNG.
#[command(rename_all = "snake_case")]
pub async fn generate_waveform(
    file_path: String,
    asset_id: String,
) -> Result<String, String> {
    let mut wave_dir = std::env::temp_dir();
    wave_dir.push("overai");
    wave_dir.push("waveforms");
    
    if !wave_dir.exists() {
        fs::create_dir_all(&wave_dir).map_err(|e| format!("Failed to create waveform dir: {}", e))?;
    }

    let output_path = wave_dir.join(format!("{}.png", asset_id));
    
    // Cache hit
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().to_string());
    }

    println!("Generating waveform for asset {}...", asset_id);

    // Use FFmpeg showwavespic filter
    let status = tokio::process::Command::new("ffmpeg")
        .args([
            "-y",
            "-loglevel", "error",
            "-nostdin",
            "-i", &file_path,
            "-filter_complex", "aresample=8000,aformat=channel_layouts=mono,showwavespic=s=2400x120:colors=white",
            "-frames:v", "1",
            "-update", "1",
            &output_path.to_string_lossy().to_string(),
        ])
        .status()
        .await
        .map_err(|e| format!("FFmpeg waveform failed: {}", e))?;

    if !status.success() {
        return Err("FFmpeg failed to generate waveform (Invalid Filter or File)".to_string());
    }

    Ok(output_path.to_string_lossy().to_string())
}
