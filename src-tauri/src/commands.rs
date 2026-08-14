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

    let pass = passphrase.as_deref().unwrap_or("");

    let key_pair = match key_type.as_str() {
        "ed25519" => keys::KeyPair::generate_ed25519(),
        "rsa" => {
            let bits = key_size.unwrap_or(4096);
            keys::KeyPair::generate_rsa(bits, russh::keys::SignatureHash::SHA2_256)
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

    // Encode public key in OpenSSH format
    let public_key = keys::serialize_public_key(&key_pair);

    // Encode private key in PEM format (OpenSSH compatible)
    let private_key = match keys::encode_openssh(&key_pair, pass) {
        Ok(pem) => pem,
        Err(e) => {
            return KeyGenResult {
                success: false,
                public_key: None,
                private_key: None,
                error: Some(format!("编码私钥失败: {}", e)),
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
