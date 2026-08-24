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
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub order: Option<u32>,
    /// 标签列表(逗号或空格分隔的字符串)
    #[serde(default)]
    pub tags: Option<String>,
    /// 颜色标签(hex 字符串, 如 #1677ff), 用于在侧边栏高亮该服务器
    #[serde(default)]
    pub color: Option<String>,
}

/// 快捷命令片段配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub group: Option<String>,
    pub description: Option<String>,
}

/// 持久化的分屏面板(只保存结构, sessionId 是运行时不保存)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneConfig {
    pub id: String,
    pub server_id: String,
}

/// 持久化的终端 Tab(只保存结构, sessionId/state 是运行时不保存)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabConfig {
    pub id: String,
    pub server_id: String,
    pub panes: Vec<PaneConfig>,
    #[serde(default)]
    pub split_direction: Option<String>,
}

/// 全局配置（持久化到 ~/.z-terminal/config.json）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub servers: Vec<ServerConfig>,
    pub settings: TerminalSettings,
    #[serde(default)]
    pub snippets: Vec<SnippetConfig>,
    /// 用户手动创建的分组(允许为空, 即尚未添加服务器)
    #[serde(default)]
    pub custom_groups: Vec<String>,
    /// 上次打开的 Tab/Pane 状态(用于重启后恢复)
    #[serde(default)]
    pub tabs: Vec<TabConfig>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub active_pane_id: Option<String>,
}

/// 终端设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSettings {
    pub font_size: u16,
    pub font_family: String,
    pub theme: String,
    pub scrollback: u32,
    pub cursor_blink: bool,
    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,
    #[serde(default)]
    pub font_ligatures: bool,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub bell: bool,
    #[serde(default = "default_copy_on_select")]
    pub copy_on_select: bool,
    #[serde(default = "default_right_click_paste")]
    pub right_click_paste: bool,
    /// 日志目录, None 表示默认 ~/.z-terminal/logs
    #[serde(default)]
    pub log_directory: Option<String>,
    /// SSH keepalive 间隔(秒), None 表示禁用
    #[serde(default)]
    pub keepalive_interval: Option<u64>,
    /// 自动重连
    #[serde(default = "default_auto_reconnect")]
    pub auto_reconnect: bool,
    /// 连接超时(秒)
    #[serde(default = "default_connection_timeout")]
    pub connection_timeout: u32,
    /// SSH Agent Forwarding
    #[serde(default)]
    pub ssh_agent_forward: bool,
    /// 背景图片 URL 或文件路径
    #[serde(default)]
    pub background_image: Option<String>,
    /// 自定义 CSS
    #[serde(default)]
    pub custom_css: Option<String>,
}

fn default_auto_reconnect() -> bool {
    true
}

fn default_cursor_style() -> String {
    "block".into()
}

fn default_opacity() -> f64 {
    1.0
}

fn default_copy_on_select() -> bool {
    true
}

fn default_right_click_paste() -> bool {
    true
}

fn default_connection_timeout() -> u32 {
    30
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "SF Mono, Monaco, Menlo, Courier New, monospace".into(),
            theme: "dark".into(),
            scrollback: 10000,
            cursor_blink: true,
            cursor_style: "block".into(),
            font_ligatures: false,
            opacity: 1.0,
            bell: false,
            copy_on_select: true,
            right_click_paste: true,
            log_directory: None,
            keepalive_interval: Some(60),
            auto_reconnect: true,
            connection_timeout: 30,
            ssh_agent_forward: false,
            background_image: None,
            custom_css: None,
        }
    }
}

/// 获取日志目录
pub fn get_log_dir() -> PathBuf {
    let config = load_config();
    let dir = match config.settings.log_directory {
        Some(ref d) if !d.is_empty() => PathBuf::from(d),
        _ => get_config_dir().join("logs"),
    };
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// 会话日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLogEntry {
    pub filename: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
}

/// 获取配置目录
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

/// 保存快捷命令片段
#[tauri::command]
pub async fn save_snippets(snippets: Vec<SnippetConfig>) -> Result<(), String> {
    let mut config = load_config();
    config.snippets = snippets;
    save_config(&config)
}

/// 保存自定义分组列表
#[tauri::command]
pub async fn save_custom_groups(groups: Vec<String>) -> Result<(), String> {
    let mut config = load_config();
    config.custom_groups = groups;
    save_config(&config)
}

/// 保存终端 Tab 状态(用于重启后恢复)
#[tauri::command]
pub async fn save_tabs(
    tabs: Vec<TabConfig>,
    active_tab_id: Option<String>,
    active_pane_id: Option<String>,
) -> Result<(), String> {
    let mut config = load_config();
    config.tabs = tabs;
    config.active_tab_id = active_tab_id;
    config.active_pane_id = active_pane_id;
    save_config(&config)
}

/// 获取会话日志列表
#[tauri::command]
pub async fn get_session_logs() -> Result<Vec<SessionLogEntry>, String> {
    let log_dir = get_log_dir();
    if !log_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&log_dir).map_err(|e| format!("读取日志目录失败: {}", e))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let metadata = entry.metadata().map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let modified = metadata.modified().map_err(|e| format!("读取修改时间失败: {}", e))?;
        let modified_str: String = {
            let dt: chrono::DateTime<chrono::Local> = modified.into();
            dt.format("%Y-%m-%d %H:%M:%S").to_string()
        };
        let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        entries.push(SessionLogEntry {
            filename,
            path: path.to_string_lossy().to_string(),
            size: metadata.len(),
            modified: modified_str,
        });
    }
    // 按修改时间倒序
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

/// 读取会话日志内容
#[tauri::command]
pub async fn read_session_log(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    // 安全检查: 确保路径在日志目录内
    let log_dir = get_log_dir();
    let canonical_path = path.canonicalize().map_err(|e| format!("路径无效: {}", e))?;
    let canonical_log_dir = log_dir.canonicalize().map_err(|e| format!("日志目录无效: {}", e))?;
    if !canonical_path.starts_with(&canonical_log_dir) {
        return Err("路径不在日志目录内".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("读取日志失败: {}", e))
}

/// 删除会话日志
#[tauri::command]
pub async fn delete_session_log(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    // 安全检查: 确保路径在日志目录内
    let log_dir = get_log_dir();
    let canonical_path = path.canonicalize().map_err(|e| format!("路径无效: {}", e))?;
    let canonical_log_dir = log_dir.canonicalize().map_err(|e| format!("日志目录无效: {}", e))?;
    if !canonical_path.starts_with(&canonical_log_dir) {
        return Err("路径不在日志目录内".into());
    }
    fs::remove_file(&path).map_err(|e| format!("删除日志失败: {}", e))
}
