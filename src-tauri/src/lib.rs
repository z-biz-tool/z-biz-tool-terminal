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
            commands::ssh_connect_via_jump,
            commands::ssh_disconnect,
            commands::ssh_execute,
            commands::ssh_start_pty,
            commands::ssh_pty_write,
            commands::ssh_pty_resize,
            commands::ssh_start_forward,
            commands::ssh_stop_forward,
            commands::sftp_list,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::ssh_generate_keypair,
            commands::ssh_diagnose_ping,
            commands::ssh_diagnose_port,
            commands::ssh_diagnose_traceroute,
            commands::ssh_get_server_info,
            commands::read_ssh_config,
            commands::get_temp_dir,
            commands::open_file_with_default_app,
            commands::get_file_modified_time,
            commands::read_file_content,
            commands::read_file_as_base64,
            config::get_config,
            config::save_servers,
            config::save_settings,
            config::save_snippets,
            config::save_custom_groups,
            config::save_tabs,
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
