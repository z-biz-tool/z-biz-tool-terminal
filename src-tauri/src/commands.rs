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
