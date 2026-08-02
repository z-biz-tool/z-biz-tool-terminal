use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 服务器配置（持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub remark: Option<String>,
}

/// 全局配置（持久化到 ~/.z-terminal/config.json）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub servers: Vec<ServerConfig>,
    pub settings: TerminalSettings,
}

/// 终端设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSettings {
    pub font_size: u16,
    pub font_family: String,
    pub theme: String,
    pub scrollback: u32,
    pub cursor_blink: bool,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "SF Mono, Monaco, Menlo, Courier New, monospace".into(),
            theme: "dark".into(),
            scrollback: 10000,
            cursor_blink: true,
        }
    }
}

/// 获取 ~/.z-terminal 目录
pub fn get_config_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".z-terminal");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// 配置文件路径
pub fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

/// 加载配置
pub fn load_config() -> AppConfig {
    let path = get_config_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

/// 保存配置
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = get_config_path();
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))?;
    Ok(())
}

/// 导出配置到指定路径
#[tauri::command]
pub async fn export_config(path: String) -> Result<String, String> {
    let config = load_config();
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))?;
    Ok("导出成功".into())
}

/// 导入配置
#[tauri::command]
pub async fn import_config(path: String) -> Result<AppConfig, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let config: AppConfig = serde_json::from_str(&content).map_err(|e| format!("解析失败: {}", e))?;
    save_config(&config)?;
    Ok(config)
}

/// 获取配置
#[tauri::command]
pub async fn get_config() -> AppConfig {
    load_config()
}

/// 保存服务器列表
#[tauri::command]
pub async fn save_servers(servers: Vec<ServerConfig>) -> Result<(), String> {
    let mut config = load_config();
    config.servers = servers;
    save_config(&config)
}

/// 保存终端设置
#[tauri::command]
pub async fn save_settings(settings: TerminalSettings) -> Result<(), String> {
    let mut config = load_config();
    config.settings = settings;
    save_config(&config)
}
