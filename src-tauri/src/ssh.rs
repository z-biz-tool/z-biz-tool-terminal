use russh::client;
use russh::keys;
use russh::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    /// SFTP 子系统会话
    sftp: Arc<Mutex<Option<SftpSession>>>,
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

        // 尝试初始化 SFTP 子系统,失败则回退到 ls -la 模拟
        let sftp = Self::open_sftp(&mut session).await.ok();

        Ok(SshSession {
            id: Uuid::new_v4().to_string(),
            host: host.to_string(),
            username: username.to_string(),
            handle: Arc::new(Mutex::new(Some(session))),
            sftp: Arc::new(Mutex::new(sftp)),
        })
    }

    /// 打开 SFTP 子系统通道
    async fn open_sftp(
        session: &mut client::Handle<ClientHandler>,
    ) -> Result<SftpSession, Box<dyn std::error::Error + Send + Sync>> {
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        Ok(sftp)
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

    /// SFTP文件列表 - 使用真实SFTP协议
    pub async fn sftp_list(
        &self,
        path: &str,
    ) -> Result<Vec<SftpEntry>, Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            // 真实 SFTP 协议
            let mut entries = Vec::new();
            let dir = sftp.read_dir(path).await?;
            for entry in dir {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let attrs = entry.metadata();
                let is_dir = attrs.is_dir();
                let size = attrs.size.unwrap_or(0);
                let modified = attrs
                    .mtime
                    .map(|t| {
                        chrono::DateTime::from_timestamp(t as i64, 0)
                            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                    })
                    .flatten();
                let permissions = attrs.permissions.map(format_permission);
                entries.push(SftpEntry {
                    name,
                    is_dir,
                    size,
                    modified,
                    permissions,
                });
            }
            Ok(entries)
        } else {
            // 回退到 ls -la(兼容不支持 sftp 的服务器)
            self.sftp_list_fallback(path).await
        }
    }

    /// SFTP文件列表 - 通过执行ls命令模拟(兜底方案)
    async fn sftp_list_fallback(
        &self,
        path: &str,
    ) -> Result<Vec<SftpEntry>, Box<dyn std::error::Error + Send + Sync>> {
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

    /// SFTP 上传文件
    pub async fn sftp_upload(
        &self,
        local_path: &str,
        remote_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            let mut local_file = tokio::fs::File::open(local_path).await?;
            let mut remote_file = sftp.create(remote_path).await?;
            let mut buf = vec![0u8; 32768];
            loop {
                let n = local_file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                remote_file.write_all(&buf[..n]).await?;
            }
            remote_file.flush().await?;
            Ok(())
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// SFTP 下载文件
    pub async fn sftp_download(
        &self,
        remote_path: &str,
        local_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            let mut remote_file = sftp.open(remote_path).await?;
            let mut local_file = tokio::fs::File::create(local_path).await?;
            let mut buf = vec![0u8; 32768];
            loop {
                let n = remote_file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                local_file.write_all(&buf[..n]).await?;
            }
            local_file.flush().await?;
            Ok(())
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// SFTP 创建目录
    pub async fn sftp_mkdir(
        &self,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            sftp.create_dir(path).await?;
            Ok(())
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// SFTP 删除文件
    pub async fn sftp_remove(
        &self,
        path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            sftp.remove_file(path).await?;
            Ok(())
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// SFTP 重命名
    pub async fn sftp_rename(
        &self,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            sftp.rename(old_path, new_path).await?;
            Ok(())
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        // 先关闭 SFTP 会话
        let mut sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.take() {
            let _ = sftp.close().await;
        }
        drop(sftp_lock);

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

/// 格式化权限位为 rwx 字符串
fn format_permission(mode: u32) -> String {
    let perms = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    let mut result = String::new();
    let type_char = if mode & 0o170000 == 0o040000 {
        'd'
    } else {
        '-'
    };
    result.push(type_char);
    for (mask, ch) in perms.iter() {
        result.push(if mode & mask != 0 { *ch } else { '-' });
    }
    result
}
