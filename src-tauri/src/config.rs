use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 服务器配置（持久化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default = "default_auth_type", alias = "auth_type")]
    pub auth_type: String,
    pub password: Option<String>,
    #[serde(alias = "private_key")]
    pub private_key: Option<String>,
    pub remark: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default, alias = "proxy_jump")]
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

fn default_auth_type() -> String {
    "password".into()
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
#[serde(rename_all = "camelCase")]
pub struct PaneConfig {
    pub id: String,
    #[serde(alias = "server_id")]
    pub server_id: String,
}

/// 持久化的终端 Tab(只保存结构, sessionId/state 是运行时不保存)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabConfig {
    pub id: String,
    #[serde(alias = "server_id")]
    pub server_id: String,
    pub panes: Vec<PaneConfig>,
    #[serde(default, alias = "split_direction")]
    pub split_direction: Option<String>,
}

/// AI 配置（持久化到 config.json 的 `ai` 段，`apiKey` 以密文落盘）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default = "default_ai_provider")]
    pub provider: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_ai_provider() -> String {
    "openai".into()
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
    /// AI 助手配置(此前只存在前端内存, 重启即丢, 见 T-2-1)
    #[serde(default)]
    pub ai: Option<AiConfig>,
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
    /// 严格主机密钥校验：首次连接需用户确认，密钥变更直接拒绝。
    /// 关闭可回退到旧的自动接受行为（不建议）。
    #[serde(default = "default_true")]
    pub strict_host_key: bool,
    /// 是否记录会话日志
    #[serde(default = "default_true")]
    pub session_logging: bool,
    /// 会话日志脱敏（P-4）。关闭会把原始输出落盘，仅在明确需要排障时开启。
    #[serde(default = "default_true")]
    pub log_redaction: bool,
    /// 危险命令二次确认网关（P-2/P-1）。关闭后命令将不再拦截，仅作回退用途。
    #[serde(default = "default_true")]
    pub dangerous_command_guard: bool,
    /// PTY 输出批处理窗口(毫秒)：窗口内的多个数据块合并成一次 IPC。
    /// 设 0 回退为逐块下发（§5.7 回退开关），代价是高频 IPC/渲染。
    #[serde(default = "default_pty_batch_window_ms")]
    pub pty_batch_window_ms: u64,
    /// 会话日志异步落盘（独立 task + 通道）。关闭后退化为"至多一次在途写"的近同步语义。
    #[serde(default = "default_true")]
    pub session_log_async: bool,
    /// xterm WebGL 渲染器（T-3-7）。关闭、或运行时装不上/丢上下文，都会回退 DOM 渲染。
    #[serde(default = "default_true")]
    pub webgl_renderer: bool,
}

fn default_pty_batch_window_ms() -> u64 {
    16
}

fn default_true() -> bool {
    true
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
            strict_host_key: true,
            session_logging: true,
            log_redaction: true,
            dangerous_command_guard: true,
            pty_batch_window_ms: 16,
            session_log_async: true,
            webgl_renderer: true,
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
    restrict_private_dir(&dir);
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
/// 配置目录, 可用 `Z_TERMINAL_CONFIG_DIR` 覆盖(便携模式与集成测试用)
pub fn get_config_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("Z_TERMINAL_CONFIG_DIR") {
        let dir = PathBuf::from(override_dir);
        if !dir.exists() {
            let _ = fs::create_dir_all(&dir);
        }
        return dir;
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".z-terminal");
    if !dir.exists() {
        if fs::create_dir_all(&dir).is_ok() {
            // 目录本身也要挡同机其他用户, 否则 config.json 的 0600 只是第二道门
            restrict_private_dir(&dir);
        }
    }
    dir
}

/// 把目录权限收紧为仅属主可进入/读写
#[cfg(unix)]
pub fn restrict_private_dir(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
pub fn restrict_private_dir(_path: &std::path::Path) {}

/// `Z_TERMINAL_CONFIG_DIR` 是进程级环境变量，改它的测试必须全仓库串行（不只同文件内）。
#[cfg(test)]
pub(crate) static CONFIG_DIR_TEST_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 取串行锁；某个测试 panic 时不把 panic 扩散成其它测试的 PoisonError。
#[cfg(test)]
pub(crate) fn lock_config_dir_env() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_DIR_TEST_GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 配置文件路径
pub fn get_config_path() -> PathBuf {
    get_config_dir().join("config.json")
}

/// 加载配置（内存态：凭证已解密，可直接用于连接）
pub fn load_config() -> AppConfig {
    let mut config = load_config_raw();
    open_secrets(&mut config);
    config
}

/// 加载配置但不解密（导出、迁移检测等不需要明文的场景用）
pub fn load_config_raw() -> AppConfig {
    let path = get_config_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            eprintln!(
                "config.json 解析失败, 使用默认配置(原文件已保留在 backups/): {}",
                e
            );
            AppConfig::default()
        }),
        Err(_) => AppConfig::default(),
    }
}

/// 落盘前加密所有凭证字段；已是本机可解密文的保持不变
fn seal_secrets(config: &AppConfig) -> Result<AppConfig, String> {
    let key = crate::secret::master_key()?;
    let mut sealed = config.clone();
    for server in sealed.servers.iter_mut() {
        server.password = crate::secret::seal_opt(&key, &server.password)?;
        server.private_key = crate::secret::seal_opt(&key, &server.private_key)?;
    }
    if let Some(ai) = sealed.ai.as_mut() {
        ai.api_key = crate::secret::seal_opt(&key, &ai.api_key)?;
    }
    Ok(sealed)
}

/// 读盘后解密；旧明文值原样透传（§5.7 保留一版兼容读取）
fn open_secrets(config: &mut AppConfig) {
    let key = match crate::secret::master_key() {
        Ok(key) => key,
        Err(e) => {
            // 主密钥拿不到时保留磁盘原值, 连接会以"认证失败"暴露问题, 比静默清空凭证更安全
            eprintln!("无法读取主密钥, 凭证将按原样使用: {}", e);
            return;
        }
    };
    for server in config.servers.iter_mut() {
        server.password = crate::secret::open_opt(&key, &server.password);
        server.private_key = crate::secret::open_opt(&key, &server.private_key);
    }
    if let Some(ai) = config.ai.as_mut() {
        ai.api_key = crate::secret::open_opt(&key, &ai.api_key);
    }
}

/// 是否存在明文凭证（用于启动时一次性迁移检测）
pub fn has_plaintext_secrets(config: &AppConfig) -> bool {
    let key = match crate::secret::master_key() {
        Ok(key) => key,
        Err(_) => return false,
    };
    let plain = |v: &Option<String>| match v {
        Some(s) if !s.is_empty() => crate::secret::needs_sealing_with(&key, s),
        _ => false,
    };
    config
        .servers
        .iter()
        .any(|s| plain(&s.password) || plain(&s.private_key))
        || config
            .ai
            .as_ref()
            .map(|ai| plain(&ai.api_key))
            .unwrap_or(false)
}

/// 启动时一次性加固: 收紧目录权限 + 把历史明文凭证升级为密文。
///
/// 目录 chmod 必须无条件执行 —— 老安装的 `~/.z-terminal` 已经是 0755,
/// 只在创建时设权限救不回来。
pub fn harden_storage() -> Result<bool, String> {
    restrict_private_dir(&get_config_dir());
    restrict_private_dir(&get_log_dir());
    let backup_dir = get_config_dir().join("backups");
    if backup_dir.exists() {
        restrict_private_dir(&backup_dir);
    }

    let raw = load_config_raw();
    if !has_plaintext_secrets(&raw) {
        return Ok(false);
    }
    let mut migrated = raw;
    // 磁盘原值先按明文语义还原, 再由 save_config 重新封存
    open_secrets(&mut migrated);
    save_config(&migrated)?;
    eprintln!("已将明文凭证升级为加密存储");
    Ok(true)
}

/// 保存配置（磁盘态：凭证为密文）
/// 关键改进:
/// 1. **凭证加密**: 密码/私钥/API Key 以 AES-256-GCM 密文落盘, 备份与导出同步受益
/// 2. **原子写入**: 先写 .tmp 再 rename, 写过程中崩溃不会损坏现有 config
/// 3. **自动备份**: 写之前先把当前 config 备份到 backups/, 保留最近 10 份
///    防止意外丢数据(误删、磁盘问题、外部程序覆盖等)
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = get_config_path();
    let sealed = seal_secrets(config)?;

    // 1. 写之前备份现有 config (如果存在)
    if path.exists() {
        backup_existing_config();
    }

    // 2. 原子写入: 先写临时文件, 再 rename 覆盖
    let content =
        serde_json::to_string_pretty(&sealed).map_err(|e| format!("序列化失败: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    // config.json 含 SSH 凭证，必须 0600，否则同机任意用户可读（P-4）
    restrict_private(&tmp);
    fs::rename(&tmp, &path).map_err(|e| format!("原子替换失败: {}", e))?;
    restrict_private(&path);
    Ok(())
}

/// 将文件权限收紧为仅属主可读写
#[cfg(unix)]
pub fn restrict_private(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub fn restrict_private(_path: &std::path::Path) {}

/// 把当前 config 备份到 backups/ 目录
fn backup_existing_config() {
    let path = get_config_path();
    let backup_dir = get_config_dir().join("backups");
    if let Err(e) = fs::create_dir_all(&backup_dir) {
        eprintln!("创建备份目录失败: {}", e);
        return;
    }
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
    let backup_path = backup_dir.join(format!("config_{}.json", ts));
    if let Err(e) = fs::copy(&path, &backup_path) {
        eprintln!("备份 config 失败: {}", e);
        return;
    }
    // 备份是 config 的完整副本，同样含凭证
    restrict_private(&backup_path);
    restrict_private_dir(&backup_dir);
    // 只保留最近 10 份, 防止无限增长
    if let Ok(entries) = fs::read_dir(&backup_dir) {
        let mut backups: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("config_"))
            .collect();
        backups.sort_by_key(|e| e.file_name());
        if backups.len() > 10 {
            for old in &backups[..backups.len() - 10] {
                let _ = fs::remove_file(old.path());
            }
        }
    }
}

/// 列出可用的配置备份
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigBackup {
    pub filename: String,
    pub path: String,
    pub modified: String,
    pub size: u64,
}

#[tauri::command]
pub async fn list_config_backups() -> Result<Vec<ConfigBackup>, String> {
    let backup_dir = get_config_dir().join("backups");
    if !backup_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<ConfigBackup> = Vec::new();
    let read_dir = fs::read_dir(&backup_dir).map_err(|e| format!("读取备份目录失败: {}", e))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if !filename.starts_with("config_") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                Some(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            })
            .unwrap_or_default();
        entries.push(ConfigBackup {
            filename,
            path: path.to_string_lossy().to_string(),
            modified,
            size: metadata.len(),
        });
    }
    // 按修改时间倒序
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(entries)
}

/// 从备份恢复配置
#[tauri::command]
pub async fn restore_config_from_backup(backup_path: String) -> Result<String, String> {
    let backup = PathBuf::from(&backup_path);
    if !backup.exists() {
        return Err("备份文件不存在".into());
    }
    // 验证备份文件可解析
    let content = fs::read_to_string(&backup).map_err(|e| format!("读取备份失败: {}", e))?;
    let _parsed: AppConfig =
        serde_json::from_str(&content).map_err(|e| format!("备份格式损坏, 无法恢复: {}", e))?;
    // 原子替换当前 config
    let target = get_config_path();
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("替换失败: {}", e))?;
    Ok("恢复成功, 请重启应用".into())
}

/// 导出配置到指定路径
///
/// 默认剔除所有密码与私钥（P-4）：导出的文件常被贴进工单或聊天窗口，
/// 带凭证导出等于把堡垒机钥匙一起发出去。需要凭证时显式传 `include_secrets`。
#[tauri::command]
pub async fn export_config(path: String, include_secrets: Option<bool>) -> Result<String, String> {
    let outcome: Result<String, String> = (|| {
        // 用 raw(不解密)读取: 即使勾选含凭证, 导出的也是密文,
        // 拿不到 master.key 就无法还原（P-4 / 4.5「含凭证须显式勾选 + 加密」）
        let mut config = load_config_raw();
        if !include_secrets.unwrap_or(false) {
            for server in config.servers.iter_mut() {
                server.password = None;
                server.private_key = None;
            }
            if let Some(ai) = config.ai.as_mut() {
                ai.api_key = None;
            }
        }
        let content =
            serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("写入失败: {}", e))?;
        restrict_private(&std::path::PathBuf::from(&path));
        Ok(if include_secrets.unwrap_or(false) {
            "导出成功（凭证以密文保留，离开本机需连同主密钥才能还原）".into()
        } else {
            "导出成功（已剔除密码、私钥与 API Key）".into()
        })
    })();
    // 导出是合规上最需要留痕的动作：导到了哪、是否带凭证，失败也要记
    crate::audit::record(
        "export_config",
        serde_json::json!({
            "path": path,
            "include_secrets": include_secrets.unwrap_or(false),
            "success": outcome.is_ok(),
            "error": outcome.as_ref().err(),
        }),
    );
    outcome
}

/// 读取 AI 配置（apiKey 为解密后的明文，只存在于进程内）
#[tauri::command]
pub async fn get_ai_config() -> Result<Option<AiConfig>, String> {
    Ok(load_config().ai)
}

/// 保存 AI 配置（apiKey 立即加密落盘）
#[tauri::command]
pub async fn save_ai_config(config: AiConfig) -> Result<(), String> {
    let mut app = load_config();
    app.ai = Some(config);
    save_config(&app)
}

/// 列出已信任的主机密钥
#[tauri::command]
pub async fn list_host_keys() -> Result<Vec<crate::hostkeys::HostKeyEntry>, String> {
    Ok(crate::hostkeys::load())
}

/// 删除某主机的信任记录（用于换钥匙 / 误信任后撤销）
#[tauri::command]
pub async fn remove_host_key(host_spec: String) -> Result<usize, String> {
    if host_spec.trim().is_empty() {
        return Err("host_spec 不能为空".into());
    }
    Ok(crate::hostkeys::remove(host_spec.trim()))
}

/// 导入配置
#[tauri::command]
pub async fn import_config(path: String) -> Result<AppConfig, String> {
    let content = fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;
    let config: AppConfig =
        serde_json::from_str(&content).map_err(|e| format!("解析失败: {}", e))?;
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
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let modified = metadata
            .modified()
            .map_err(|e| format!("读取修改时间失败: {}", e))?;
        let modified_str: String = {
            let dt: chrono::DateTime<chrono::Local> = modified.into();
            dt.format("%Y-%m-%d %H:%M:%S").to_string()
        };
        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
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
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("路径无效: {}", e))?;
    let canonical_log_dir = log_dir
        .canonicalize()
        .map_err(|e| format!("日志目录无效: {}", e))?;
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
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("路径无效: {}", e))?;
    let canonical_log_dir = log_dir
        .canonicalize()
        .map_err(|e| format!("日志目录无效: {}", e))?;
    if !canonical_path.starts_with(&canonical_log_dir) {
        return Err("路径不在日志目录内".into());
    }
    fs::remove_file(&path).map_err(|e| format!("删除日志失败: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_config_serializes_with_frontend_field_names() {
        let server = ServerConfig {
            id: "server-1".into(),
            name: "测试服务器".into(),
            group: String::new(),
            host: "127.0.0.1".into(),
            port: 22,
            username: "tester".into(),
            auth_type: "password".into(),
            password: Some("test-password".into()),
            private_key: None,
            remark: None,
            pinned: None,
            proxy_jump: None,
            order: None,
            tags: None,
            color: None,
        };

        let value = serde_json::to_value(server).expect("服务器配置应能序列化");
        assert_eq!(value["authType"], "password");
        assert!(value.get("auth_type").is_none());
    }

    #[test]
    fn server_config_reads_legacy_field_names() {
        let server: ServerConfig = serde_json::from_value(json!({
            "id": "server-1",
            "name": "测试服务器",
            "group": "",
            "host": "127.0.0.1",
            "port": 22,
            "username": "tester",
            "auth_type": "password",
            "password": "test-password",
            "private_key": null,
            "remark": null,
            "proxy_jump": null
        }))
        .expect("旧 snake_case 配置应能读取");

        assert_eq!(server.auth_type, "password");
        assert_eq!(server.password.as_deref(), Some("test-password"));
    }

    /// §5.7：新增的性能开关必须能读旧配置（缺字段走默认值），否则整份设置反序列化失败
    #[test]
    fn settings_fill_new_perf_fields_from_legacy_config() {
        let settings: TerminalSettings = serde_json::from_value(json!({
            "font_size": 12,
            "font_family": "Menlo",
            "theme": "dark",
            "scrollback": 1000,
            "cursor_blink": true,
            "cursor_style": "bar",
            "opacity": 0.9,
            "bell": false,
            "copy_on_select": true,
            "right_click_paste": true,
            "auto_reconnect": true,
            "connection_timeout": 30
        }))
        .expect("旧设置快照应能继续读取");

        assert_eq!(settings.pty_batch_window_ms, 16);
        assert!(settings.session_log_async);
        assert!(settings.webgl_renderer);
        assert!(settings.strict_host_key);
        assert!(settings.dangerous_command_guard);
    }

    #[test]
    fn settings_perf_fields_round_trip() {
        let settings: TerminalSettings = serde_json::from_value(json!({
            "font_size": 12,
            "font_family": "Menlo",
            "theme": "dark",
            "scrollback": 1000,
            "cursor_blink": true,
            "cursor_style": "bar",
            "opacity": 0.9,
            "bell": false,
            "copy_on_select": true,
            "right_click_paste": true,
            "auto_reconnect": true,
            "connection_timeout": 30,
            "pty_batch_window_ms": 0,
            "session_log_async": false,
            "webgl_renderer": false
        }))
        .expect("新字段应能读取");

        assert_eq!(settings.pty_batch_window_ms, 0);
        assert!(!settings.session_log_async);
        assert!(!settings.webgl_renderer);
    }

    /// 落盘加密相关测试会改环境变量和临时目录, 必须串行（锁定义在模块级，跨文件共用）

    fn test_server(password: Option<&str>, private_key: Option<&str>) -> ServerConfig {
        ServerConfig {
            id: "server-1".into(),
            name: "测试服务器".into(),
            group: String::new(),
            host: "127.0.0.1".into(),
            port: 22,
            username: "tester".into(),
            auth_type: "password".into(),
            password: password.map(Into::into),
            private_key: private_key.map(Into::into),
            remark: None,
            pinned: None,
            proxy_jump: None,
            order: None,
            tags: None,
            color: None,
        }
    }

    /// 把配置目录指向一次性临时目录; 返回 guard(持有期间禁止其他 fs 测试)
    fn isolated_config_dir(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "z-terminal-{}-{}-{}",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("临时目录应可创建");
        std::env::set_var("Z_TERMINAL_CONFIG_DIR", &dir);
        dir
    }

    fn config_with(password: Option<&str>) -> AppConfig {
        let mut config = AppConfig::default();
        config.servers = vec![test_server(
            password,
            Some("-----BEGIN PRIVATE KEY-----abc"),
        )];
        config.ai = Some(AiConfig {
            provider: "openai".into(),
            api_key: password.map(|_| "sk-secret-key".into()),
            base_url: Some("https://api.openai.com/v1".into()),
            model: Some("gpt-4o-mini".into()),
            temperature: Some(0.7),
            max_tokens: Some(2048),
        });
        config
    }

    #[test]
    fn credentials_are_sealed_at_rest_and_restored_on_load() {
        let _guard = lock_config_dir_env();
        let dir = isolated_config_dir("seal");

        save_config(&config_with(Some("hunter2"))).expect("保存应成功");

        let raw = fs::read_to_string(get_config_path()).expect("config.json 应存在");
        assert!(raw.contains("enc:v1:"), "凭证应以密文落盘");
        for secret in ["hunter2", "sk-secret-key", "BEGIN PRIVATE KEY"] {
            assert!(
                !raw.contains(secret),
                "明文凭证 {} 不得出现在 config.json 中",
                secret
            );
        }

        let loaded = load_config();
        assert_eq!(loaded.servers[0].password.as_deref(), Some("hunter2"));
        assert_eq!(
            loaded.ai.as_ref().unwrap().api_key.as_deref(),
            Some("sk-secret-key")
        );
        assert!(
            !has_plaintext_secrets(&load_config_raw()),
            "落盘后磁盘态应全部为密文, 无需再迁移"
        );
        assert!(
            has_plaintext_secrets(&loaded),
            "内存态是明文, has_plaintext_secrets 应据此判定需要封存"
        );

        fs::remove_dir_all(&dir).ok();
        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
    }

    #[test]
    fn legacy_plaintext_config_is_migrated_by_harden_storage() {
        let _guard = lock_config_dir_env();
        let dir = isolated_config_dir("migrate");

        // 绕过 save_config 直接序列化, 模拟旧版本写出的明文 config.json
        let legacy = config_with(Some("old-plain-pass"));
        fs::write(get_config_path(), serde_json::to_string(&legacy).unwrap()).unwrap();
        assert!(has_plaintext_secrets(&load_config_raw()));
        // 旧明文必须仍可读(§5.7 兼容一版)
        assert_eq!(
            load_config().servers[0].password.as_deref(),
            Some("old-plain-pass")
        );

        assert!(harden_storage().unwrap(), "harden 应报告执行了迁移");

        let raw = fs::read_to_string(get_config_path()).unwrap();
        assert!(!raw.contains("old-plain-pass"), "迁移后不应残留明文密码");
        assert!(!has_plaintext_secrets(&load_config_raw()));
        assert_eq!(
            load_config().servers[0].password.as_deref(),
            Some("old-plain-pass"),
            "迁移不应改变可用值"
        );
        assert!(!harden_storage().unwrap(), "二次运行应无操作");

        fs::remove_dir_all(&dir).ok();
        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
    }

    #[tokio::test]
    async fn export_never_writes_plaintext_credentials() {
        let _guard = lock_config_dir_env();
        let dir = isolated_config_dir("export");
        save_config(&config_with(Some("export-pass"))).unwrap();

        let stripped = dir.join("out-stripped.json");
        export_config(stripped.to_string_lossy().to_string(), None)
            .await
            .unwrap();
        let stripped_raw = fs::read_to_string(&stripped).unwrap();
        assert!(!stripped_raw.contains("export-pass"));
        assert!(!stripped_raw.contains("sk-secret-key"));
        assert_eq!(
            serde_json::from_str::<AppConfig>(&stripped_raw)
                .unwrap()
                .servers[0]
                .password,
            None
        );

        // 显式含凭证: 保留字段但仍是密文
        let with_secrets = dir.join("out-secrets.json");
        export_config(with_secrets.to_string_lossy().to_string(), Some(true))
            .await
            .unwrap();
        let raw = fs::read_to_string(&with_secrets).unwrap();
        assert!(raw.contains("enc:v1:"));
        assert!(
            !raw.contains("export-pass") && !raw.contains("sk-secret-key"),
            "含凭证导出也不得落明文"
        );
        assert!(serde_json::from_str::<AppConfig>(&raw).unwrap().servers[0]
            .password
            .is_some());

        fs::remove_dir_all(&dir).ok();
        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
    }
}
