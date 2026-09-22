use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::hostkeys::HostKeyPolicy;
use crate::ssh::{shell_escape, SshSession, SftpEntry};

/// SSH会话存储: session_id -> SshSession
///
/// 用 RwLock 保护映射表本身（增删查极快），会话以 `Arc<SshSession>` 存放。
/// 取会话时克隆 Arc 后立即释放全局锁，避免远程 IO 期间阻塞其它会话（P-3 会话隔离）。
static SESSIONS: tokio::sync::OnceCell<Arc<RwLock<HashMap<String, Arc<SshSession>>>>> =
    tokio::sync::OnceCell::const_new();

async fn sessions() -> &'static Arc<RwLock<HashMap<String, Arc<SshSession>>>> {
    SESSIONS
        .get_or_init(|| async { Arc::new(RwLock::new(HashMap::new())) })
        .await
}

/// 按 id 取会话句柄。只在读锁内做一次 `Arc` 克隆，不持锁跨 `await`。
async fn get_session(session_id: &str) -> Option<Arc<SshSession>> {
    sessions().await.read().await.get(session_id).cloned()
}

/// 会话不存在的统一错误文案
fn no_session(session_id: &str) -> String {
    format!("会话 {} 不存在", session_id)
}

/// 校验主机名 / IP 字面量，拒绝一切可能被 shell 解释的字符。
///
/// 允许 IPv6 的 `:` 与 IPv4-mapped 的 `[...]`，其余只接受字母、数字、`.`、`-`、`_`。
pub fn validate_host(host: &str) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("主机不能为空".into());
    }
    if host.len() > 253 {
        return Err("主机名过长".into());
    }
    let body = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if body.is_empty() {
        return Err("主机不能为空".into());
    }
    // IPv6 允许 :: 缩写，因此连续的 ':' 也要放行
    if body.contains("::") && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'.')
    {
        return Ok(());
    }
    for ch in body.chars() {
        let ok = ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_');
        if !ok {
            return Err(format!("主机包含非法字符: {:?}", ch));
        }
    }
    Ok(())
}

/// 构造诊断类失败结果
fn diag_error(message: impl Into<String>) -> ExecResult {
    ExecResult {
        success: false,
        output: String::new(),
        error: Some(message.into()),
    }
}

/// SSH连接参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证方式: password / key
    #[serde(alias = "auth_type")]
    pub auth_type: Option<String>,
    pub password: Option<String>,
    /// 私钥内容(PEM格式)
    #[serde(alias = "private_key")]
    pub private_key: Option<String>,
    /// SSH keepalive 间隔(秒), None 表示禁用
    #[serde(alias = "keepalive_interval")]
    pub keepalive_interval: Option<u64>,
    /// 连接超时(秒)
    #[serde(alias = "connection_timeout")]
    pub connection_timeout: Option<u64>,
}

/// 通过跳板机连接SSH的参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectViaJumpParams {
    /// 跳板机参数
    #[serde(alias = "jump_host")]
    pub jump_host: String,
    #[serde(alias = "jump_port")]
    pub jump_port: u16,
    #[serde(alias = "jump_username")]
    pub jump_username: String,
    #[serde(alias = "jump_auth_type")]
    pub jump_auth_type: Option<String>,
    #[serde(alias = "jump_password")]
    pub jump_password: Option<String>,
    #[serde(alias = "jump_private_key")]
    pub jump_private_key: Option<String>,
    /// 目标主机参数
    #[serde(alias = "target_host")]
    pub target_host: String,
    #[serde(alias = "target_port")]
    pub target_port: u16,
    #[serde(alias = "target_username")]
    pub target_username: String,
    #[serde(alias = "target_auth_type")]
    pub target_auth_type: Option<String>,
    #[serde(alias = "target_password")]
    pub target_password: Option<String>,
    #[serde(alias = "target_private_key")]
    pub target_private_key: Option<String>,
    /// SSH keepalive 间隔(秒), None 表示禁用
    #[serde(alias = "keepalive_interval")]
    pub keepalive_interval: Option<u64>,
    /// 连接超时(秒)
    #[serde(alias = "connection_timeout")]
    pub connection_timeout: Option<u64>,
}


/// SSH连接结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectResult {
    pub success: bool,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

/// 命令执行结果
#[derive(Debug, Serialize, Deserialize)]
pub struct ExecResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

/// SFTP文件列表结果
#[derive(Debug, Serialize, Deserialize)]
pub struct SftpListResult {
    pub success: bool,
    pub entries: Vec<SftpEntry>,
    pub error: Option<String>,
}

/// 按当前设置构造主机密钥校验策略。`strict_host_key` 关闭时回退为自动接受。
fn host_policy(app: &tauri::AppHandle, host: &str, port: u16) -> HostKeyPolicy {
    let strict = crate::config::load_config().settings.strict_host_key;
    HostKeyPolicy::new(host, port, strict, Some(app.clone()))
}

/// 回应用端的「首次连接是否信任该主机密钥」请求
#[tauri::command]
pub async fn ssh_resolve_host_key(request_id: String, trusted: bool) -> Result<bool, String> {
    if request_id.trim().is_empty() {
        return Err("request_id 不能为空".into());
    }
    Ok(crate::hostkeys::resolve_request(&request_id, trusted))
}

/// 连接SSH服务器
#[tauri::command]
pub async fn ssh_connect(app: tauri::AppHandle, params: ConnectParams) -> ConnectResult {
    let policy = host_policy(&app, &params.host, params.port);
    let timeout_secs = params.connection_timeout.unwrap_or(30).clamp(5, 300);
    let host = params.host.clone();
    let port = params.port;
    let session = match tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        SshSession::connect(
            &params.host,
            params.port,
            &params.username,
            params.auth_type.as_deref(),
            params.password.as_deref(),
            params.private_key.as_deref(),
            params.keepalive_interval,
            policy,
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err::<SshSession, Box<dyn std::error::Error + Send + Sync>>(
            format!("连接 {}:{} 超时（{}秒）", host, port, timeout_secs).into(),
        ),
    };

    match session {
        Ok(sess) => {
            let session_id = sess.id.clone();
            sessions()
                .await
                .write()
                .await
                .insert(session_id.clone(), Arc::new(sess));
            ConnectResult {
                success: true,
                session_id: Some(session_id),
                error: None,
            }
        }
        Err(e) => ConnectResult {
            success: false,
            session_id: None,
            error: Some(format!("连接 {}:{} 失败: {}", host, port, e)),
        },
    }
}

/// 通过跳板机连接SSH服务器
#[tauri::command]
pub async fn ssh_connect_via_jump(
    app: tauri::AppHandle,
    params: ConnectViaJumpParams,
) -> ConnectResult {
    let jump_policy = host_policy(&app, &params.jump_host, params.jump_port);
    let target_policy = host_policy(&app, &params.target_host, params.target_port);
    let timeout_secs = params.connection_timeout.unwrap_or(30).clamp(5, 300);
    let jump_host = params.jump_host.clone();
    let jump_port = params.jump_port;
    let target_host = params.target_host.clone();
    let target_port = params.target_port;
    let session = match tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        SshSession::connect_via_jump(
            &params.jump_host,
            params.jump_port,
            &params.jump_username,
            params.jump_auth_type.as_deref(),
            params.jump_password.as_deref(),
            params.jump_private_key.as_deref(),
            &params.target_host,
            params.target_port,
            &params.target_username,
            params.target_auth_type.as_deref(),
            params.target_password.as_deref(),
            params.target_private_key.as_deref(),
            params.keepalive_interval,
            jump_policy,
            target_policy,
        ),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err::<SshSession, Box<dyn std::error::Error + Send + Sync>>(format!(
            "跳板连接超时（{}秒）: {}:{} → {}:{}",
            timeout_secs, jump_host, jump_port, target_host, target_port
        )
        .into()),
    };

    match session {
        Ok(sess) => {
            let session_id = sess.id.clone();
            sessions()
                .await
                .write()
                .await
                .insert(session_id.clone(), Arc::new(sess));
            ConnectResult {
                success: true,
                session_id: Some(session_id),
                error: None,
            }
        }
        Err(e) => ConnectResult {
            success: false,
            session_id: None,
            error: Some(format!(
                "跳板连接失败 {}:{} → {}:{}: {}",
                jump_host, jump_port, target_host, target_port, e
            )),
        },
    }
}

/// 断开SSH连接
#[tauri::command]
pub async fn ssh_disconnect(session_id: String) -> ConnectResult {
    // 写锁内只做移除，disconnect 的 IO 在无锁状态下进行
    let removed = sessions().await.write().await.remove(&session_id);
    if let Some(sess) = removed {
        sess.disconnect().await;
        ConnectResult {
            success: true,
            session_id: Some(session_id),
            error: None,
        }
    } else {
        ConnectResult {
            success: false,
            session_id: None,
            error: Some(no_session(&session_id)),
        }
    }
}

/// 执行命令
#[tauri::command]
pub async fn ssh_execute(session_id: String, command: String) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.execute(&command).await {
            Ok(output) => ExecResult {
                success: true,
                output,
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// SSH密钥生成结果
#[derive(Debug, Serialize, Deserialize)]
pub struct KeyGenResult {
    pub success: bool,
    pub public_key: Option<String>,
    pub private_key: Option<String>,
    pub error: Option<String>,
}

/// 生成SSH密钥对
#[tauri::command]
pub async fn ssh_generate_keypair(
    key_type: String,
    key_size: Option<u32>,
    passphrase: Option<String>,
) -> KeyGenResult {
    use russh::keys;
    use russh::keys::key::SignatureHash;
    use russh::keys::PublicKeyBase64;

    let key_pair = match key_type.as_str() {
        "ed25519" => keys::key::KeyPair::generate_ed25519(),
        "rsa" => {
            let bits = key_size.unwrap_or(4096) as usize;
            keys::key::KeyPair::generate_rsa(bits, SignatureHash::SHA2_256)
        }
        _ => {
            return KeyGenResult {
                success: false,
                public_key: None,
                private_key: None,
                error: Some(format!("不支持的密钥类型: {}", key_type)),
            }
        }
    };

    let key_pair = match key_pair {
        Some(kp) => kp,
        None => {
            return KeyGenResult {
                success: false,
                public_key: None,
                private_key: None,
                error: Some("密钥生成失败".into()),
            }
        }
    };

    // Encode public key in OpenSSH format: "ssh-ed25519 AAAA..." or "ssh-rsa AAAA..."
    let public_key = format!("{} {}", key_pair.name(), key_pair.public_key_base64());

    // Encode private key in PKCS8 PEM format
    let private_key = if let Some(ref pass) = passphrase {
        let mut buf = Vec::new();
        match keys::encode_pkcs8_pem_encrypted(&key_pair, pass.as_bytes(), 100, &mut buf) {
            Ok(()) => String::from_utf8_lossy(&buf).to_string(),
            Err(e) => {
                return KeyGenResult {
                    success: false,
                    public_key: None,
                    private_key: None,
                    error: Some(format!("编码私钥失败: {}", e)),
                }
            }
        }
    } else {
        let mut buf = Vec::new();
        match keys::encode_pkcs8_pem(&key_pair, &mut buf) {
            Ok(()) => String::from_utf8_lossy(&buf).to_string(),
            Err(e) => {
                return KeyGenResult {
                    success: false,
                    public_key: None,
                    private_key: None,
                    error: Some(format!("编码私钥失败: {}", e)),
                }
            }
        }
    };

    KeyGenResult {
        success: true,
        public_key: Some(public_key),
        private_key: Some(private_key),
        error: None,
    }
}

/// 端口转发参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardParams {
    #[serde(alias = "session_id")]
    pub session_id: String,
    /// 转发类型: "local" | "remote" | "dynamic"
    #[serde(alias = "forward_type")]
    pub forward_type: String,
    #[serde(alias = "local_addr")]
    pub local_addr: Option<String>,
    #[serde(alias = "local_port")]
    pub local_port: Option<u16>,
    #[serde(alias = "remote_host")]
    pub remote_host: Option<String>,
    #[serde(alias = "remote_port")]
    pub remote_port: Option<u16>,
}

/// 端口转发结果
#[derive(Debug, Serialize, Deserialize)]
pub struct PortForwardResult {
    pub success: bool,
    pub forward_id: Option<String>,
    pub actual_port: Option<u16>,
    pub error: Option<String>,
}

/// 启动端口转发
#[tauri::command]
pub async fn ssh_start_forward(params: PortForwardParams) -> PortForwardResult {
    if let Some(sess) = get_session(&params.session_id).await {
        let result = match params.forward_type.as_str() {
            "local" => {
                let local_addr = params.local_addr.as_deref().unwrap_or("127.0.0.1");
                let local_port = params.local_port.unwrap_or(0);
                let remote_host = params.remote_host.as_deref().unwrap_or("127.0.0.1");
                let remote_port = params.remote_port.unwrap_or(0);
                match sess
                    .start_local_forward(local_addr, local_port, remote_host, remote_port)
                    .await
                {
                    Ok((forward_id, actual_port)) => PortForwardResult {
                        success: true,
                        forward_id: Some(forward_id),
                        actual_port: Some(actual_port),
                        error: None,
                    },
                    Err(e) => PortForwardResult {
                        success: false,
                        forward_id: None,
                        actual_port: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            "remote" => {
                let remote_addr = params.local_addr.as_deref().unwrap_or("127.0.0.1");
                let remote_port = params.remote_port.unwrap_or(0);
                let local_host = params.remote_host.as_deref().unwrap_or("127.0.0.1");
                let local_port = params.local_port.unwrap_or(0);
                match sess
                    .start_remote_forward(remote_addr, remote_port, local_host, local_port)
                    .await
                {
                    Ok((forward_id, actual_port)) => PortForwardResult {
                        success: true,
                        forward_id: Some(forward_id),
                        actual_port: Some(actual_port),
                        error: None,
                    },
                    Err(e) => PortForwardResult {
                        success: false,
                        forward_id: None,
                        actual_port: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            "dynamic" => {
                let local_addr = params.local_addr.as_deref().unwrap_or("127.0.0.1");
                let local_port = params.local_port.unwrap_or(0);
                match sess.start_dynamic_forward(local_addr, local_port).await {
                    Ok((forward_id, actual_port)) => PortForwardResult {
                        success: true,
                        forward_id: Some(forward_id),
                        actual_port: Some(actual_port),
                        error: None,
                    },
                    Err(e) => PortForwardResult {
                        success: false,
                        forward_id: None,
                        actual_port: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            _ => PortForwardResult {
                success: false,
                forward_id: None,
                actual_port: None,
                error: Some(format!("不支持的转发类型: {}", params.forward_type)),
            },
        };
        result
    } else {
        PortForwardResult {
            success: false,
            forward_id: None,
            actual_port: None,
            error: Some(format!("会话 {} 不存在", params.session_id)),
        }
    }
}

/// 停止端口转发
#[tauri::command]
pub async fn ssh_stop_forward(session_id: String, forward_id: String) -> PortForwardResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.stop_forward(&forward_id).await {
            Ok(()) => PortForwardResult {
                success: true,
                forward_id: Some(forward_id),
                actual_port: None,
                error: None,
            },
            Err(e) => PortForwardResult {
                success: false,
                forward_id: None,
                actual_port: None,
                error: Some(e.to_string()),
            },
        }
    } else {
        PortForwardResult {
            success: false,
            forward_id: None,
            actual_port: None,
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP文件列表
#[tauri::command]
pub async fn sftp_list(session_id: String, path: String) -> SftpListResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_list(&path).await {
            Ok(entries) => SftpListResult {
                success: true,
                entries,
                error: None,
            },
            Err(e) => SftpListResult {
                success: false,
                entries: vec![],
                error: Some(e.to_string()),
            },
        }
    } else {
        SftpListResult {
            success: false,
            entries: vec![],
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP 上传文件
#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_upload(&local_path, &remote_path).await {
            Ok(_) => ExecResult {
                success: true,
                output: "上传成功".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP 下载文件
#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_download(&remote_path, &local_path).await {
            Ok(_) => ExecResult {
                success: true,
                output: "下载成功".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP 创建目录
#[tauri::command]
pub async fn sftp_mkdir(session_id: String, path: String) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_mkdir(&path).await {
            Ok(_) => ExecResult {
                success: true,
                output: "创建目录成功".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP 删除文件
#[tauri::command]
pub async fn sftp_remove(session_id: String, path: String) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_remove(&path).await {
            Ok(_) => ExecResult {
                success: true,
                output: "删除成功".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// SFTP 重命名
#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.sftp_rename(&old_path, &new_path).await {
            Ok(_) => ExecResult {
                success: true,
                output: "重命名成功".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 启动PTY交互式Shell
#[tauri::command]
pub async fn ssh_start_pty(
    app: tauri::AppHandle,
    session_id: String,
    cols: u16,
    rows: u16,
) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.start_pty(app, cols, rows).await {
            Ok(_) => ExecResult {
                success: true,
                output: "PTY已启动".into(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 向PTY写入数据
#[tauri::command]
pub async fn ssh_pty_write(session_id: String, data: String) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.pty_write(&data).await {
            Ok(_) => ExecResult {
                success: true,
                output: String::new(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 调整PTY窗口大小
#[tauri::command]
pub async fn ssh_pty_resize(session_id: String, cols: u16, rows: u16) -> ExecResult {
    if let Some(sess) = get_session(&session_id).await {
        match sess.pty_resize(cols, rows).await {
            Ok(_) => ExecResult {
                success: true,
                output: String::new(),
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 读取 ~/.ssh/config 文件内容
#[tauri::command]
pub async fn read_ssh_config() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("无法获取HOME目录")?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path).map_err(|e| format!("读取失败: {}", e))
}

/// 获取系统临时目录
#[tauri::command]
pub async fn get_temp_dir() -> Result<String, String> {
    Ok(std::env::temp_dir().to_string_lossy().to_string())
}

/// 使用系统默认应用打开文件
#[tauri::command]
pub async fn open_file_with_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", &path])
        .spawn()
        .map_err(|e| format!("打开失败: {}", e))?;
    Ok(())
}

/// 获取文件的修改时间（Unix时间戳毫秒）
#[tauri::command]
pub async fn get_file_modified_time(path: String) -> Result<serde_json::Value, String> {
    let path = std::path::PathBuf::from(&path);
    let metadata = std::fs::metadata(&path).map_err(|e| format!("获取文件信息失败: {}", e))?;
    let modified = metadata.modified().map_err(|e| format!("获取修改时间失败: {}", e))?;
    let duration = modified.duration_since(std::time::UNIX_EPOCH).map_err(|e| format!("时间转换失败: {}", e))?;
    Ok(serde_json::json!({ "modified": duration.as_millis() as u64 }))
}

/// 读取文件内容为字符串
#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 读取文件内容为Base64编码字符串
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64_encode(&bytes))
}

/// 本地 TCP 连通性探测结果(无需 SSH 会话)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbeResult {
    pub reachable: bool,
    pub message: String,
    pub elapsed_ms: u128,
}

/// 本地 TCP 连通性探测: 仅建立 TCP 连接, 不进行 SSH 握手。
///
/// 用于在快速连接 / 排错场景下, 不消耗 SSH 凭据就能判断端口是否可达。
/// 常见失败原因会被翻译成人类可读的提示。
#[tauri::command]
pub async fn tcp_probe(host: String, port: u16, timeout_ms: Option<u64>) -> TcpProbeResult {
    use std::net::ToSocketAddrs;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).clamp(500, 30000));
    let trimmed_host = host.trim();
    let addr = match (trimmed_host, port).to_socket_addrs() {
        Ok(mut iter) => match iter.next() {
            Some(a) => a,
            None => {
                return TcpProbeResult {
                    reachable: false,
                    message: format!("无法解析主机 {}", trimmed_host),
                    elapsed_ms: 0,
                }
            }
        },
        Err(e) => {
            return TcpProbeResult {
                reachable: false,
                message: format!("域名解析失败: {}", e),
                elapsed_ms: 0,
            }
        }
    };

    let started = Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(mut stream)) => {
            let _ = stream.shutdown().await;
            TcpProbeResult {
                reachable: true,
                message: format!("TCP 连接到 {}:{} 成功", trimmed_host, port),
                elapsed_ms: started.elapsed().as_millis(),
            }
        }
        Ok(Err(e)) => {
            // 将常见错误翻译为更直观的提示
            let message = match e.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    format!("连接被拒绝: {}:{} 没有进程在监听(检查 sshd 是否启动 / 端口是否正确)", trimmed_host, port)
                }
                std::io::ErrorKind::TimedOut => {
                    format!("连接超时: 网络不通或防火墙拦截")
                }
                std::io::ErrorKind::NetworkUnreachable => {
                    format!("网络不可达: 请检查本机网络或路由")
                }
                std::io::ErrorKind::HostUnreachable => {
                    format!("主机不可达: 服务器关机 / 防火墙拦截 / 网关配置错误")
                }
                std::io::ErrorKind::PermissionDenied => {
                    format!("权限不足: 检查本机防火墙或 SELinux/AppArmor 策略")
                }
                _ => format!("连接失败: {}", e),
            };
            TcpProbeResult {
                reachable: false,
                message,
                elapsed_ms: started.elapsed().as_millis(),
            }
        }
        Err(_) => TcpProbeResult {
            reachable: false,
            message: format!("连接超时 ({}ms): 网络不通或防火墙拦截", timeout.as_millis()),
            elapsed_ms: started.elapsed().as_millis(),
        },
    }
}

/// 诊断: Ping
#[tauri::command]
pub async fn ssh_diagnose_ping(session_id: String, host: String, count: Option<u32>) -> ExecResult {
    if let Err(e) = validate_host(&host) {
        return diag_error(e);
    }
    if let Some(sess) = get_session(&session_id).await {
        let c = count.unwrap_or(4).clamp(1, 20);
        let command = format!("ping -c {} {} 2>&1", c, shell_escape(host.trim()));
        match sess.execute(&command).await {
            Ok(output) => ExecResult {
                success: true,
                output,
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 诊断: 端口检测
#[tauri::command]
pub async fn ssh_diagnose_port(session_id: String, host: String, port: u16) -> ExecResult {
    if let Err(e) = validate_host(&host) {
        return diag_error(e);
    }
    if let Some(sess) = get_session(&session_id).await {
        let h = host.trim();
        let bare = h.trim_start_matches('[').trim_end_matches(']');
        // Try nc first, fall back to bash /dev/tcp
        let command = format!(
            "(nc -z -w 5 {} {} 2>/dev/null && echo 'OPEN') || (timeout 5 bash -c '</dev/tcp/{}/{}' 2>/dev/null && echo 'OPEN') || echo 'CLOSED'",
            shell_escape(h), port, bare, port
        );
        match sess.execute(&command).await {
            Ok(output) => ExecResult {
                success: true,
                output,
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 诊断: Traceroute
#[tauri::command]
pub async fn ssh_diagnose_traceroute(session_id: String, host: String) -> ExecResult {
    if let Err(e) = validate_host(&host) {
        return diag_error(e);
    }
    if let Some(sess) = get_session(&session_id).await {
        let h = shell_escape(host.trim());
        let command = format!("traceroute {} 2>&1 || tracepath {} 2>&1", h, h);
        match sess.execute(&command).await {
            Ok(output) => ExecResult {
                success: true,
                output,
                error: None,
            },
            Err(e) => ExecResult {
                success: false,
                output: String::new(),
                error: Some(e.to_string()),
            },
        }
    } else {
        ExecResult {
            success: false,
            output: String::new(),
            error: Some(no_session(&session_id)),
        }
    }
}

/// 服务器系统信息
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ServerSystemInfo {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
    /// CPU 使用率(0-100)
    pub cpu_usage: f32,
    /// 1/5/15 分钟负载
    pub load_avg: String,
    /// 内存总大小(字节)
    pub mem_total: u64,
    /// 内存已用(字节)
    pub mem_used: u64,
    /// 根分区总大小(字节)
    pub disk_total: u64,
    /// 根分区已用(字节)
    pub disk_used: u64,
    pub uptime: String,
    /// 数据采集时间(秒, 自 UNIX 纪元)
    pub collected_at: u64,
    /// 错误信息(部分字段采集失败时填充)
    pub error: Option<String>,
}

/// 采集远程服务器系统信息
///
/// 通过 SSH 在远端执行一个组合 shell 脚本,使用 `===KEY===` 分隔的键值对输出,
/// 然后在本地解析成结构化数据。Linux/macOS 自动适配。
#[tauri::command]
pub async fn ssh_get_server_info(session_id: String) -> ServerSystemInfo {
    let mut info = ServerSystemInfo {
        collected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        ..Default::default()
    };

    let Some(sess) = get_session(&session_id).await else {
        info.error = Some(no_session(&session_id));
        return info;
    };

    // 组合脚本: 先检测 OS,然后用对应分支采集
    // 使用 echo + ===KEY=== 作为分隔符,便于解析
    let script = r#"
OS_TYPE=$(uname -s)
emit() { echo "===$1==="; echo "$2"; }

if [ "$OS_TYPE" = "Linux" ]; then
  emit HOSTNAME "$(hostname 2>/dev/null)"
  OS_DESC=$(grep PRETTY_NAME /etc/os-release 2>/dev/null | head -1 | sed 's/PRETTY_NAME=//;s/"//g')
  [ -z "$OS_DESC" ] && OS_DESC=$(grep ^NAME /etc/os-release 2>/dev/null | head -1 | sed 's/NAME=//;s/"//g')
  [ -z "$OS_DESC" ] && OS_DESC="Linux"
  emit OS "$OS_DESC"
  emit KERNEL "$(uname -srm)"
  emit ARCH "$(uname -m)"
  emit UPTIME "$(uptime -p 2>/dev/null || uptime | sed 's/.*up/up/')"
  emit LOADAVG "$(awk '{print $1, $2, $3}' /proc/loadavg 2>/dev/null)"
  CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ *//')
  [ -z "$CPU_MODEL" ] && CPU_MODEL=$(lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ */,"",$2); print $2; exit}')
  emit CPU_MODEL "$CPU_MODEL"
  emit CPU_CORES "$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null)"
  # CPU 使用率: top 取两次样本, 第二次的 idle 差值
  CPU_IDLE=$(top -bn2 -d1 2>/dev/null | grep '^%Cpu' | tail -1 | awk '{for(i=1;i<=NF;i++) if($i ~ /id/) {gsub(/[^0-9.]/,"",$i); print $i; exit}}')
  if [ -z "$CPU_IDLE" ]; then
    CPU_USAGE=0
  else
    CPU_USAGE=$(awk -v idle="$CPU_IDLE" 'BEGIN{printf "%.1f", 100-idle}')
  fi
  emit CPU_USAGE "$CPU_USAGE"
  emit MEM_TOTAL "$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null)"
  MEM_TOTAL_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null)
  MEM_AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)
  if [ -n "$MEM_TOTAL_KB" ] && [ -n "$MEM_AVAIL_KB" ]; then
    MEM_USED_KB=$((MEM_TOTAL_KB - MEM_AVAIL_KB))
    emit MEM_USED "$MEM_USED_KB"
  else
    emit MEM_USED "0"
  fi
  DF_OUT=$(df -B1K / 2>/dev/null | tail -1)
  if [ -n "$DF_OUT" ]; then
    emit DISK_TOTAL "$(echo "$DF_OUT" | awk '{print $2}')"
    emit DISK_USED "$(echo "$DF_OUT" | awk '{print $3}')"
  else
    emit DISK_TOTAL "0"
    emit DISK_USED "0"
  fi
elif [ "$OS_TYPE" = "Darwin" ]; then
  emit HOSTNAME "$(hostname)"
  emit OS "$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"
  emit KERNEL "$(uname -srm)"
  emit ARCH "$(uname -m)"
  emit UPTIME "$(uptime | sed 's/.*up/up/')"
  emit LOADAVG "$(sysctl -n vm.loadavg 2>/dev/null | awk -F'[{} ]' '{print $2, $3, $4}')"
  emit CPU_MODEL "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  emit CPU_CORES "$(sysctl -n hw.ncpu 2>/dev/null)"
  # macOS top: 取第二次的 user%
  CPU_USAGE=$(top -l 2 -n 0 -s 1 2>/dev/null | grep 'CPU usage' | tail -1 | awk '{print $3}' | sed 's/%//')
  [ -z "$CPU_USAGE" ] && CPU_USAGE=0
  emit CPU_USAGE "$CPU_USAGE"
  emit MEM_TOTAL "$(sysctl -n hw.memsize 2>/dev/null)"
  # 计算已用内存: active + wired + compressed(×pagesize)
  PAGE_SIZE=$(sysctl -n hw.pagesize 2>/dev/null)
  MEM_USED=$(vm_stat 2>/dev/null | awk -v ps="$PAGE_SIZE" '
    /^Pages active:/ {a=$3; gsub(/\./,"",a)}
    /^Pages wired down:/ {w=$4; gsub(/\./,"",w)}
    /^Pages occupied by compressor:/ {c=$5; gsub(/\./,"",c)}
    END {print (a+w+c)*ps}
  ')
  [ -z "$MEM_USED" ] && MEM_USED=0
  emit MEM_USED "$MEM_USED"
  DF_OUT=$(df -k / 2>/dev/null | tail -1)
  if [ -n "$DF_OUT" ]; then
    TKB=$(echo "$DF_OUT" | awk '{print $2}')
    UKB=$(echo "$DF_OUT" | awk '{print $3}')
    emit DISK_TOTAL "$((TKB*1024))"
    emit DISK_USED "$((UKB*1024))"
  else
    emit DISK_TOTAL "0"
    emit DISK_USED "0"
  fi
else
  emit HOSTNAME "$(hostname 2>/dev/null)"
  emit OS "$OS_TYPE"
  emit KERNEL "$(uname -srm 2>/dev/null)"
  emit ARCH "$(uname -m 2>/dev/null)"
fi
"#;

    let raw = match sess.execute(script).await {
        Ok(s) => s,
        Err(e) => {
            info.error = Some(format!("执行失败: {}", e));
            return info;
        }
    };

    // 解析 ===KEY=== 标记的输出
    let mut current_key: Option<String> = None;
    let mut values: HashMap<String, String> = HashMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("===") {
            if let Some(key) = rest.strip_suffix("===") {
                current_key = Some(key.to_string());
                values.entry(key.to_string()).or_default();
                continue;
            }
        }
        if let Some(ref key) = current_key {
            let entry = values.entry(key.clone()).or_default();
            if !entry.is_empty() {
                entry.push('\n');
            }
            entry.push_str(trimmed);
        }
    }

    let take = |k: &str| values.get(k).cloned().unwrap_or_default().trim().to_string();

    info.hostname = take("HOSTNAME");
    info.os = take("OS");
    info.kernel = take("KERNEL");
    info.arch = take("ARCH");
    info.uptime = take("UPTIME");
    info.load_avg = take("LOADAVG");
    info.cpu_model = take("CPU_MODEL");
    info.cpu_cores = take("CPU_CORES").parse().unwrap_or(0);
    info.cpu_usage = take("CPU_USAGE").parse().unwrap_or(0.0);
    info.mem_total = take("MEM_TOTAL").parse::<u64>().unwrap_or(0) * 1024; // KB → bytes
    info.mem_used = take("MEM_USED").parse().unwrap_or(0) * 1024;
    info.disk_total = take("DISK_TOTAL").parse().unwrap_or(0);
    info.disk_used = take("DISK_USED").parse().unwrap_or(0);

    info
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let chunks = data.chunks(3);
    for chunk in chunks {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn connect_params_accepts_frontend_camel_case() {
        let params: ConnectParams = serde_json::from_value(json!({
            "host": "127.0.0.1",
            "port": 22,
            "username": "tester",
            "authType": "password",
            "password": "test-password",
            "keepaliveInterval": 60,
            "connectionTimeout": 30
        }))
        .expect("camelCase 参数应能解析");

        assert_eq!(params.auth_type.as_deref(), Some("password"));
        assert_eq!(params.password.as_deref(), Some("test-password"));
        assert_eq!(params.keepalive_interval, Some(60));
        assert_eq!(params.connection_timeout, Some(30));
    }

    #[test]
    fn connect_params_accepts_legacy_snake_case() {
        let params: ConnectParams = serde_json::from_value(json!({
            "host": "127.0.0.1",
            "port": 22,
            "username": "tester",
            "auth_type": "key",
            "private_key": "key-content",
            "keepalive_interval": 60,
            "connection_timeout": 30
        }))
        .expect("snake_case 参数应能解析");

        assert_eq!(params.auth_type.as_deref(), Some("key"));
        assert_eq!(params.private_key.as_deref(), Some("key-content"));
        assert_eq!(params.keepalive_interval, Some(60));
        assert_eq!(params.connection_timeout, Some(30));
    }

    #[test]
    fn tcp_probe_result_serializes_camel_case() {
        let result = TcpProbeResult {
            reachable: true,
            message: "ok".into(),
            elapsed_ms: 42,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["reachable"], true);
        assert_eq!(value["elapsedMs"], 42);
        assert!(value.get("elapsed_ms").is_none());
    }

    #[tokio::test]
    async fn tcp_probe_returns_unreachable_for_local_closed_port() {
        // 找一个大概率未占用的本地端口 (绑定后立即释放)
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = tcp_probe("127.0.0.1".into(), port, Some(500)).await;
        assert!(!result.reachable, "刚释放的端口不应可达");
        assert!(
            result.message.contains("拒绝") || result.message.contains("失败"),
            "错误信息应包含中文提示, 实际: {}",
            result.message
        );
    }
}
