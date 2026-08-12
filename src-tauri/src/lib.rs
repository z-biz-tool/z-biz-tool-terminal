mod commands;
mod config;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_disconnect,
            commands::ssh_execute,
            commands::ssh_start_pty,
            commands::ssh_pty_write,
            commands::ssh_pty_resize,
            commands::sftp_list,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            config::get_config,
            config::save_servers,
            config::save_settings,
            config::save_snippets,
            config::export_config,
            config::import_config,
            config::get_session_logs,
            config::read_session_log,
            config::delete_session_log,
        ])
        .setup(|_app| {
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
