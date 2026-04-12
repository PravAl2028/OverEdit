pub mod commands;
pub mod services;
pub mod utils;
pub mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        commands::media_commands::test_backend_connection,
        commands::media_commands::import_media_asset,
        commands::timeline_commands::generate_frame_strip,
        commands::timeline_commands::generate_waveform,
        commands::export_commands::export_timeline
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
