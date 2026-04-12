use tauri::command;
use crate::services::ffmpeg_service::{import_media, MediaAsset};

#[command(rename_all = "snake_case")]
pub async fn test_backend_connection(message: String) -> Result<String, String> {
    Ok(format!("Rust backend received: {}. Connection successful!", message))
}

#[command(rename_all = "snake_case")]
pub async fn import_media_asset(file_path: String) -> Result<MediaAsset, String> {
    // Calling the service method asynchronously
    import_media(file_path).await
}
