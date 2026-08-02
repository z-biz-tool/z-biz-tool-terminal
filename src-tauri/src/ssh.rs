use russh::client;
use russh::keys;
use russh::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// SFTP文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub permissions: Option<String>,
}

/// SSH会话
pub struct SshSession {
    pub id: String,
    pub host: String,
    pub username: String,
    /// russh异步句柄
    handle: Arc<Mutex<Option<client::Handle<ClientHandler>>>>,
}

/// 自定义SSH客户端Handler
struct ClientHandler;

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 自动接受服务器公钥(生产环境应验证known_hosts)
        Ok(true)
    }
}

impl SshSession {
    /// 连接SSH服务器
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth_type: Option<&str>,
        password: Option<&str>,
        private_key: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let config = Arc::new(client::Config::default());
        let mut session = client::connect(config, (host, port), ClientHandler).await?;

        // 认证
        let auth_ok = match auth_type.unwrap_or("password") {
            "key" => {
                let key_content = private_key.ok_or("未提供私钥内容")?;
                let key_pair = keys::decode_secret_key(key_content, None)
                    .map_err(|e| format!("解析私钥失败: {}", e))?;
                session
                    .authenticate_publickey(username, Arc::new(key_pair))
                    .await?
            }
            _ => {
                let pwd = password.unwrap_or("");
                session.authenticate_password(username, pwd).await?
            }
        };

        if !auth_ok {
            return Err("认证失败: 用户名或密码错误".into());
        }

        Ok(SshSession {
            id: Uuid::new_v4().to_string(),
            host: host.to_string(),
            username: username.to_string(),
            handle: Arc::new(Mutex::new(Some(session))),
        })
    }

    /// 执行命令并返回输出
    pub async fn execute(&self, command: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut handle = self.handle.lock().await;
        let session = handle.as_mut().ok_or("会话已关闭")?;

        let mut channel = session.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut output = String::new();

        // 读取stdout和stderr
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    output.push_str(&String::from_utf8_lossy(data));
                }
                ChannelMsg::ExtendedData { ref data, .. } => {
                    output.push_str(&String::from_utf8_lossy(data));
                }
                ChannelMsg::ExitStatus { .. } => {
                    break;
                }
                _ => {}
            }
        }

        Ok(output)
    }

    /// SFTP文件列表 - 通过执行ls命令模拟
    pub async fn sftp_list(&self, path: &str) -> Result<Vec<SftpEntry>, Box<dyn std::error::Error + Send + Sync>> {
        // 使用ls -la命令获取文件列表并解析
        let cmd = format!("ls -la --time-style=long-iso {}", shell_escape(path));
        let output = self.execute(&cmd).await?;

        let mut entries = Vec::new();
        for line in output.lines().skip(1) {
            // 跳过总计行和空行
            if line.is_empty() || line.starts_with("total") {
                continue;
            }

            // 解析 ls -la 输出
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 {
                continue;
            }

            let permissions = parts[0].to_string();
            let is_dir = permissions.starts_with('d');
            let size: u64 = parts[4].parse().unwrap_or(0);
            let modified = format!("{} {}", parts[5], parts[6]);
            let name = parts[8..].join(" ");

            // 跳过 . 和 ..
            if name == "." || name == ".." {
                continue;
            }

            entries.push(SftpEntry {
                name,
                is_dir,
                size,
                modified: Some(modified),
                permissions: Some(permissions),
            });
        }

        Ok(entries)
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        let mut handle = self.handle.lock().await;
        if let Some(session) = handle.take() {
            let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
        }
    }
}

/// 简单的shell转义
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
