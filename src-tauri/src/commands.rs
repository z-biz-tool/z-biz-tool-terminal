use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::ssh::{SshSession, SftpEntry};

/// SSH会话存储: session_id -> SshSession
static SESSIONS: tokio::sync::OnceCell<Arc<Mutex<HashMap<String, SshSession>>>> =
    tokio::sync::OnceCell::const_new();

async fn sessions() -> &'static Arc<Mutex<HashMap<String, SshSession>>> {
    SESSIONS
        .get_or_init(|| async { Arc::new(Mutex::new(HashMap::new())) })
        .await
}

/// SSH连接参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证方式: password / key
    pub auth_type: Option<String>,
    pub password: Option<String>,
    /// 私钥内容(PEM格式)
    pub private_key: Option<String>,
    /// SSH keepalive 间隔(秒), None 表示禁用
    pub keepalive_interval: Option<u64>,
}

/// 通过跳板机连接SSH的参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectViaJumpParams {
    /// 跳板机参数
    pub jump_host: String,
    pub jump_port: u16,
    pub jump_username: String,
    pub jump_auth_type: Option<String>,
    pub jump_password: Option<String>,
    pub jump_private_key: Option<String>,
    /// 目标主机参数
    pub target_host: String,
    pub target_port: u16,
    pub target_username: String,
    pub target_auth_type: Option<String>,
    pub target_password: Option<String>,
    pub target_private_key: Option<String>,
    /// SSH keepalive 间隔(秒), None 表示禁用
    pub keepalive_interval: Option<u64>,
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

/// 连接SSH服务器
#[tauri::command]
pub async fn ssh_connect(params: ConnectParams) -> ConnectResult {
    let session = SshSession::connect(
        &params.host,
        params.port,
        &params.username,
        params.auth_type.as_deref(),
        params.password.as_deref(),
        params.private_key.as_deref(),
        params.keepalive_interval,
    )
    .await;

    match session {
        Ok(sess) => {
            let session_id = sess.id.clone();
            let mut map = sessions().await.lock().await;
            map.insert(session_id.clone(), sess);
            ConnectResult {
                success: true,
                session_id: Some(session_id),
                error: None,
            }
        }
        Err(e) => ConnectResult {
            success: false,
            session_id: None,
            error: Some(e.to_string()),
        },
    }
}

/// 通过跳板机连接SSH服务器
#[tauri::command]
pub async fn ssh_connect_via_jump(params: ConnectViaJumpParams) -> ConnectResult {
    let session = SshSession::connect_via_jump(
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
    )
    .await;

    match session {
        Ok(sess) => {
            let session_id = sess.id.clone();
            let mut map = sessions().await.lock().await;
            map.insert(session_id.clone(), sess);
            ConnectResult {
                success: true,
                session_id: Some(session_id),
                error: None,
            }
        }
        Err(e) => ConnectResult {
            success: false,
            session_id: None,
            error: Some(e.to_string()),
        },
    }
}

/// 断开SSH连接
#[tauri::command]
pub async fn ssh_disconnect(session_id: String) -> ConnectResult {
    let mut map = sessions().await.lock().await;
    if let Some(sess) = map.remove(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// 执行命令
#[tauri::command]
pub async fn ssh_execute(session_id: String, command: String) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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
pub struct PortForwardParams {
    pub session_id: String,
    /// 转发类型: "local" | "remote" | "dynamic"
    pub forward_type: String,
    pub local_addr: Option<String>,
    pub local_port: Option<u16>,
    pub remote_host: Option<String>,
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&params.session_id) {
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// SFTP文件列表
#[tauri::command]
pub async fn sftp_list(session_id: String, path: String) -> SftpListResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// SFTP 创建目录
#[tauri::command]
pub async fn sftp_mkdir(session_id: String, path: String) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// SFTP 删除文件
#[tauri::command]
pub async fn sftp_remove(session_id: String, path: String) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// 向PTY写入数据
#[tauri::command]
pub async fn ssh_pty_write(session_id: String, data: String) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// 调整PTY窗口大小
#[tauri::command]
pub async fn ssh_pty_resize(session_id: String, cols: u16, rows: u16) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
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
            error: Some(format!("会话 {} 不存在", session_id)),
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

/// 诊断: Ping
#[tauri::command]
pub async fn ssh_diagnose_ping(session_id: String, host: String, count: Option<u32>) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
        let c = count.unwrap_or(4);
        let command = format!("ping -c {} {} 2>&1", c, host);
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// 诊断: 端口检测
#[tauri::command]
pub async fn ssh_diagnose_port(session_id: String, host: String, port: u16) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
        // Try nc first, fall back to bash /dev/tcp
        let command = format!(
            "(nc -z -w 5 {} {} 2>/dev/null && echo 'OPEN') || (timeout 5 bash -c '</dev/tcp/{}/{}' 2>/dev/null && echo 'OPEN') || echo 'CLOSED'",
            host, port, host, port
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
            error: Some(format!("会话 {} 不存在", session_id)),
        }
    }
}

/// 诊断: Traceroute
#[tauri::command]
pub async fn ssh_diagnose_traceroute(session_id: String, host: String) -> ExecResult {
    let map = sessions().await.lock().await;
    if let Some(sess) = map.get(&session_id) {
        let command = format!("traceroute {} 2>&1 || tracepath {} 2>&1", host, host);
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
            error: Some(format!("会话 {} 不存在", session_id)),
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

    let map = sessions().await.lock().await;
    let Some(sess) = map.get(&session_id) else {
        info.error = Some(format!("会话 {} 不存在", session_id));
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
