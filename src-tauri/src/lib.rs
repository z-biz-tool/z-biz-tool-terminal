mod ai;
mod audit;
mod commands;
mod config;
mod hostkeys;
mod paths;
mod redact;
mod secret;
mod ssh;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 深链队列：manage 给命令用、seed 给冷启动用，两处必须是同一份。
    let zbiz_pending = cap_hub::receiver::SharedPending::default();
    tauri::Builder::default()
        // 单实例（2026-10-26 分发底座）：第二次启动聚焦已有窗口，不再开新进程。
        // 必须作为第一个注册的插件（tauri-plugin-single-instance 官方要求）。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            cap_hub::receiver::handle_second_instance(app, &argv);
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // 自动更新：前端 UpdaterGate 延时 check()，endpoint/pubkey 见 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后的「立即重启」
        .plugin(tauri_plugin_process::init())
        .manage(zbiz_pending.clone())
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_connect_via_jump,
            commands::ssh_disconnect,
            commands::ssh_execute,
            commands::audit_event,
            audit::audit_records,
            audit::audit_export,
            commands::ssh_start_pty,
            commands::ssh_pty_write,
            commands::ssh_pty_resize,
            commands::ssh_start_forward,
            commands::ssh_stop_forward,
            commands::ssh_list_forwards,
            commands::sftp_list,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_cancel_transfer,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::ssh_generate_keypair,
            commands::ssh_resolve_host_key,
            hostkeys::known_hosts_list,
            hostkeys::known_hosts_remove,
            commands::tcp_probe,
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
            commands::save_key_file,
            config::get_config,
            config::save_servers,
            config::save_settings,
            config::save_snippets,
            config::save_custom_groups,
            config::save_tabs,
            config::list_config_backups,
            config::restore_config_from_backup,
            config::export_config,
            config::import_config,
            config::get_ai_config,
            config::save_ai_config,
            // AI 请求收口到 Rust（cap-llm）：key 不回传 webview，前端不再直连
            ai::ai_chat,
            ai::ai_chat_stream,
            ai::ai_stream_abort,
            // LLM 接入层：供应商预设 + 结构化测试（读已保存配置，因 key 不出 webview）
            ai::list_llm_presets,
            ai::list_llm_models,
            ai::test_ai_config,
            config::get_session_logs,
            config::read_session_log,
            config::delete_session_log,
            zbiz_take_pending,
        ])
        .setup(move |app| {
            // 冷启动时带进来的 zbiz:// 先入队，前端挂上监听后再取走。
            cap_hub::receiver::seed_cold_start(app.handle(), &zbiz_pending);
            // 启动加固: 收紧目录权限 + 把历史明文凭证升级为密文(§5.7 兼容读取一版 + 迁移)。
            // 失败不阻断启动: 明文仍可照常读取使用。
            if let Err(e) = config::harden_storage() {
                eprintln!("存储加固未完成, 本次按现状继续运行: {}", e);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 取走队列里的深链（家族统一命令名）。
#[tauri::command]
fn zbiz_take_pending(
    pending: tauri::State<'_, cap_hub::receiver::SharedPending>,
) -> Vec<cap_hub::Handoff> {
    cap_hub::receiver::take_pending_from(pending.inner())
}
