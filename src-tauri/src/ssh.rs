use russh::client;
use russh::keys;
use russh::*;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::config::get_log_dir;

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
    /// PTY 数据写入通道
    pty_writer: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
    /// PTY 窗口大小调整通道
    pty_resize_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<(u32, u32)>>>>,
    /// 会话日志文件
    log_file: Arc<Mutex<Option<tokio::fs::File>>>,
    /// 活跃的端口转发任务: forward_id -> JoinHandle
    forwards: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    /// 远程转发通道接收器
    forward_rx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<ForwardedChannel>>>>,
    /// 跳板机会话句柄(ProxyJump时保持跳板机连接存活)
    _jump_handle: Option<Arc<Mutex<Option<client::Handle<ClientHandler>>>>>,
}

/// 自定义SSH客户端Handler
struct ClientHandler {
    /// 远程转发通道: 当服务器推送 forwarded-tcpip 通道时, 通过此发送器传递
    forward_tx: Option<tokio::sync::mpsc::UnboundedSender<ForwardedChannel>>,
}

/// 转发的通道信息
pub struct ForwardedChannel {
    pub channel: Channel<client::Msg>,
    pub connected_address: String,
    pub connected_port: u32,
    pub originator_address: String,
    pub originator_port: u32,
}

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

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = &self.forward_tx {
            let _ = tx.send(ForwardedChannel {
                channel,
                connected_address: connected_address.to_string(),
                connected_port,
                originator_address: originator_address.to_string(),
                originator_port,
            });
        }
        Ok(())
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
        keepalive_interval: Option<u64>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut config = client::Config::default();
        if let Some(interval) = keepalive_interval {
            config.keepalive_interval = Some(std::time::Duration::from_secs(interval));
        }
        let config = Arc::new(config);

        let (forward_tx, forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let handler = ClientHandler {
            forward_tx: Some(forward_tx),
        };
        let mut session = client::connect(config, (host, port), handler).await?;

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
            pty_writer: Arc::new(Mutex::new(None)),
            pty_resize_tx: Arc::new(Mutex::new(None)),
            log_file: Arc::new(Mutex::new(None)),
            forwards: Arc::new(Mutex::new(HashMap::new())),
            forward_rx: Arc::new(Mutex::new(Some(forward_rx))),
            _jump_handle: None,
        })
    }

    /// 通过跳板机连接SSH服务器 (ProxyJump)
    pub async fn connect_via_jump(
        jump_host: &str,
        jump_port: u16,
        jump_username: &str,
        jump_auth_type: Option<&str>,
        jump_password: Option<&str>,
        jump_private_key: Option<&str>,
        target_host: &str,
        target_port: u16,
        target_username: &str,
        target_auth_type: Option<&str>,
        target_password: Option<&str>,
        target_private_key: Option<&str>,
        keepalive_interval: Option<u64>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // 1. 先连接到跳板机
        let mut jump_config = client::Config::default();
        if let Some(interval) = keepalive_interval {
            jump_config.keepalive_interval = Some(std::time::Duration::from_secs(interval));
        }
        let jump_config = Arc::new(jump_config);

        let (jump_forward_tx, _jump_forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let jump_handler = ClientHandler {
            forward_tx: Some(jump_forward_tx),
        };
        let mut jump_session = client::connect(jump_config, (jump_host, jump_port), jump_handler).await?;

        // 认证跳板机
        let jump_auth_ok = match jump_auth_type.unwrap_or("password") {
            "key" => {
                let key_content = jump_private_key.ok_or("未提供跳板机私钥内容")?;
                let key_pair = keys::decode_secret_key(key_content, None)
                    .map_err(|e| format!("解析跳板机私钥失败: {}", e))?;
                jump_session
                    .authenticate_publickey(jump_username, Arc::new(key_pair))
                    .await?
            }
            _ => {
                let pwd = jump_password.unwrap_or("");
                jump_session.authenticate_password(jump_username, pwd).await?
            }
        };

        if !jump_auth_ok {
            return Err("跳板机认证失败: 用户名或密码错误".into());
        }

        // 2. 通过跳板机打开 direct-tcpip 通道到目标主机
        let channel = jump_session
            .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("通过跳板机打开通道失败: {}", e))?;

        // 3. 将通道转为流，在上面建立新的SSH会话
        let channel_stream = channel.into_stream();

        let mut target_config = client::Config::default();
        if let Some(interval) = keepalive_interval {
            target_config.keepalive_interval = Some(std::time::Duration::from_secs(interval));
        }
        let target_config = Arc::new(target_config);

        let (target_forward_tx, target_forward_rx) = tokio::sync::mpsc::unbounded_channel();
        let target_handler = ClientHandler {
            forward_tx: Some(target_forward_tx),
        };
        let mut target_session = client::connect_stream(target_config, channel_stream, target_handler).await?;

        // 4. 认证目标主机
        let target_auth_ok = match target_auth_type.unwrap_or("password") {
            "key" => {
                let key_content = target_private_key.ok_or("未提供目标主机私钥内容")?;
                let key_pair = keys::decode_secret_key(key_content, None)
                    .map_err(|e| format!("解析目标主机私钥失败: {}", e))?;
                target_session
                    .authenticate_publickey(target_username, Arc::new(key_pair))
                    .await?
            }
            _ => {
                let pwd = target_password.unwrap_or("");
                target_session.authenticate_password(target_username, pwd).await?
            }
        };

        if !target_auth_ok {
            return Err("目标主机认证失败: 用户名或密码错误".into());
        }

        // 5. 尝试初始化 SFTP 子系统
        let sftp = Self::open_sftp(&mut target_session).await.ok();

        // 注意: jump_session 需要保持存活，不能断开
        // 我们将 jump_session 的 handle 也存储在 SshSession 中
        // 但为了简化，我们让 jump_session 随 target session 一起存活
        // 将 jump_session 的 handle 包装到一个不会被 drop 的地方
        let jump_handle = Arc::new(Mutex::new(Some(jump_session)));

        Ok(SshSession {
            id: Uuid::new_v4().to_string(),
            host: format!("{}->{}", jump_host, target_host),
            username: target_username.to_string(),
            handle: Arc::new(Mutex::new(Some(target_session))),
            sftp: Arc::new(Mutex::new(sftp)),
            pty_writer: Arc::new(Mutex::new(None)),
            pty_resize_tx: Arc::new(Mutex::new(None)),
            log_file: Arc::new(Mutex::new(None)),
            forwards: Arc::new(Mutex::new(HashMap::new())),
            forward_rx: Arc::new(Mutex::new(Some(target_forward_rx))),
            _jump_handle: Some(jump_handle),
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

    /// 启动PTY交互式Shell
    pub async fn start_pty(
        &self,
        app: tauri::AppHandle,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut handle = self.handle.lock().await;
        let session = handle.as_mut().ok_or("会话已关闭")?;

        let mut channel = session.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;

        let session_id = self.id.clone();

        // 创建数据写入通道
        let (data_tx, mut data_rx) = tokio::sync::mpsc::channel::<String>(256);
        // 创建窗口大小调整通道
        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u32, u32)>(16);

        *self.pty_writer.lock().await = Some(data_tx);
        *self.pty_resize_tx.lock().await = Some(resize_tx);

        // 创建日志文件
        let log_dir = get_log_dir();
        let log_filename = format!(
            "{}_{}.log",
            session_id,
            chrono::Local::now().format("%Y%m%d_%H%M%S")
        );
        let log_path = log_dir.join(&log_filename);
        let log_file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .await
            .ok();
        *self.log_file.lock().await = log_file;

        // 启动PTY事件循环：读取输出、写入数据、处理resize、写日志
        let read_app = app.clone();
        let read_session_id = session_id.clone();
        let log_file_arc = self.log_file.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                let output = String::from_utf8_lossy(data).to_string();
                                let _ = read_app.emit(
                                    "pty-output",
                                    serde_json::json!({
                                        "session_id": read_session_id,
                                        "data": output,
                                    }),
                                );
                                // 写入日志
                                Self::write_log(&log_file_arc, &output).await;
                            }
                            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                let output = String::from_utf8_lossy(data).to_string();
                                let _ = read_app.emit(
                                    "pty-output",
                                    serde_json::json!({
                                        "session_id": read_session_id,
                                        "data": output,
                                    }),
                                );
                                // 写入日志
                                Self::write_log(&log_file_arc, &output).await;
                            }
                            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => {
                                let _ = read_app.emit(
                                    "pty-output",
                                    serde_json::json!({
                                        "session_id": read_session_id,
                                        "data": "\r\n[会话已关闭]\r\n",
                                    }),
                                );
                                // 发送会话关闭事件
                                let _ = read_app.emit(
                                    "pty-closed",
                                    serde_json::json!({
                                        "session_id": read_session_id,
                                    }),
                                );
                                // 关闭日志文件
                                let mut lf = log_file_arc.lock().await;
                                lf.take();
                                break;
                            }
                            _ => {}
                        }
                    }
                    input = data_rx.recv() => {
                        match input {
                            Some(data) => {
                                if channel.data(data.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            None => {
                                let _ = channel.eof().await;
                                break;
                            }
                        }
                    }
                    resize = resize_rx.recv() => {
                        if let Some((cols, rows)) = resize {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                    }
                }
            }
        });

        Ok(())
    }

    /// 写入日志(带时间戳)
    async fn write_log(
        log_file: &Arc<Mutex<Option<tokio::fs::File>>>,
        data: &str,
    ) {
        let mut lf = log_file.lock().await;
        if let Some(file) = lf.as_mut() {
            let timestamp = chrono::Local::now().format("[%Y-%m-%d %H:%M:%S] ");
            let log_line = format!("{}{}", timestamp, data);
            let _ = file.write_all(log_line.as_bytes()).await;
        }
    }

    /// 向PTY写入数据
    pub async fn pty_write(&self, data: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let writer = self.pty_writer.lock().await;
        if let Some(tx) = writer.as_ref() {
            tx.send(data.to_string())
                .await
                .map_err(|e| format!("PTY写入失败: {}", e).into())
        } else {
            Err("PTY未启动".into())
        }
    }

    /// 调整PTY窗口大小
    pub async fn pty_resize(
        &self,
        cols: u16,
        rows: u16,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let resize_tx = self.pty_resize_tx.lock().await;
        if let Some(tx) = resize_tx.as_ref() {
            tx.send((cols as u32, rows as u32))
                .await
                .map_err(|e| format!("PTY resize失败: {}", e).into())
        } else {
            Err("PTY未启动".into())
        }
    }

    /// 启动本地端口转发 (-L)
    pub async fn start_local_forward(
        &self,
        local_addr: &str,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<(String, u16), Box<dyn std::error::Error + Send + Sync>> {
        let forward_id = Uuid::new_v4().to_string();
        let listener = TcpListener::bind((local_addr, local_port)).await?;
        let actual_port = listener.local_addr()?.port();

        let handle = self.handle.clone();
        let fid = forward_id.clone();
        let fwd_map = self.forwards.clone();
        let la = local_addr.to_string();
        let rh = remote_host.to_string();

        let join = tokio::spawn(async move {
            loop {
                let (mut tcp_stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };

                let h = handle.lock().await;
                let session = match h.as_ref() {
                    Some(s) => s,
                    None => break,
                };

                let channel = match session
                    .channel_open_direct_tcpip(
                        &rh,
                        remote_port as u32,
                        &la,
                        actual_port as u32,
                    )
                    .await
                {
                    Ok(ch) => ch,
                    Err(_) => continue,
                };
                drop(h); // release lock before I/O

                let channel_stream = channel.into_stream();
                tokio::spawn(async move {
                    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
                    let (mut ssh_read, mut ssh_write) =
                        tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(forward_id.clone(), join);
        Ok((forward_id, actual_port))
    }

    /// 启动远程端口转发 (-R)
    pub async fn start_remote_forward(
        &self,
        remote_addr: &str,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<(String, u16), Box<dyn std::error::Error + Send + Sync>> {
        let forward_id = Uuid::new_v4().to_string();

        // 请求服务器监听远程端口
        let actual_port = {
            let mut h = self.handle.lock().await;
            let session = h
                .as_mut()
                .ok_or("会话已关闭")?;
            session
                .tcpip_forward(remote_addr, remote_port as u32)
                .await? as u16
        };

        let fid = forward_id.clone();
        let fwd_map = self.forwards.clone();
        let forward_rx = self.forward_rx.clone();
        let lh = local_host.to_string();
        let lp = local_port;

        let join = tokio::spawn(async move {
            // 获取 forward_rx
            let mut rx_guard = forward_rx.lock().await;
            let rx = match rx_guard.as_mut() {
                Some(r) => r,
                None => return,
            };

            loop {
                // 等待服务器推送 forwarded-tcpip 通道
                let fwd_ch = match rx.recv().await {
                    Some(ch) => ch,
                    None => break,
                };

                // 连接本地端口
                let mut tcp_stream = match TcpStream::connect((&*lh, lp)).await {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let channel_stream = fwd_ch.channel.into_stream();
                tokio::spawn(async move {
                    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
                    let (mut ssh_read, mut ssh_write) =
                        tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(forward_id.clone(), join);
        Ok((forward_id, actual_port))
    }

    /// 启动动态端口转发 / SOCKS5 代理 (-D)
    pub async fn start_dynamic_forward(
        &self,
        local_addr: &str,
        local_port: u16,
    ) -> Result<(String, u16), Box<dyn std::error::Error + Send + Sync>> {
        let forward_id = Uuid::new_v4().to_string();
        let listener = TcpListener::bind((local_addr, local_port)).await?;
        let actual_port = listener.local_addr()?.port();

        let handle = self.handle.clone();
        let fid = forward_id.clone();
        let fwd_map = self.forwards.clone();
        let la = local_addr.to_string();

        let join = tokio::spawn(async move {
            loop {
                let (mut tcp_stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };

                // SOCKS5 握手
                if let Err(_) = socks5_handshake(&mut tcp_stream).await {
                    let _ = tcp_stream.shutdown().await;
                    continue;
                }

                // 读取 SOCKS5 CONNECT 请求
                let (target_host, target_port) = match socks5_read_connect(&mut tcp_stream).await {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = tcp_stream.shutdown().await;
                        continue;
                    }
                };

                // 打开 SSH direct-tcpip 通道
                let channel = {
                    let h = handle.lock().await;
                    let session = match h.as_ref() {
                        Some(s) => s,
                        None => break,
                    };
                    match session
                        .channel_open_direct_tcpip(
                            &target_host,
                            target_port as u32,
                            &la,
                            actual_port as u32,
                        )
                        .await
                    {
                        Ok(ch) => ch,
                        Err(_) => {
                            // 回复 SOCKS5 连接失败
                            let _ = tcp_stream
                                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                                .await;
                            continue;
                        }
                    }
                };

                // 回复 SOCKS5 连接成功
                if tcp_stream
                    .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                    .await
                    .is_err()
                {
                    continue;
                }

                let channel_stream = channel.into_stream();
                tokio::spawn(async move {
                    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
                    let (mut ssh_read, mut ssh_write) =
                        tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(forward_id.clone(), join);
        Ok((forward_id, actual_port))
    }

    /// 停止端口转发
    pub async fn stop_forward(
        &self,
        forward_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut map = self.forwards.lock().await;
        if let Some(handle) = map.remove(forward_id) {
            handle.abort();
            Ok(())
        } else {
            Err(format!("转发任务 {} 不存在", forward_id).into())
        }
    }

    /// 断开连接
    pub async fn disconnect(&self) {
        // 关闭PTY通道
        {
            let mut writer = self.pty_writer.lock().await;
            writer.take();
        }
        {
            let mut resize = self.pty_resize_tx.lock().await;
            resize.take();
        }
        // 关闭日志文件
        {
            let mut lf = self.log_file.lock().await;
            lf.take();
        }

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

/// SOCKS5 握手: 读取客户端问候, 回复选择无认证方式
async fn socks5_handshake(
    stream: &mut TcpStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await?;
    if buf[0] != 0x05 {
        return Err("不是SOCKS5协议".into());
    }
    let n_methods = buf[1] as usize;
    let mut methods = vec![0u8; n_methods];
    stream.read_exact(&mut methods).await?;
    // 回复: 版本5, 无需认证(0x00)
    stream.write_all(&[0x05, 0x00]).await?;
    Ok(())
}

/// 读取 SOCKS5 CONNECT 请求, 返回目标 (host, port)
async fn socks5_read_connect(
    stream: &mut TcpStream,
) -> Result<(String, u16), Box<dyn std::error::Error + Send + Sync>> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    if header[0] != 0x05 {
        return Err("SOCKS5版本错误".into());
    }
    if header[1] != 0x01 {
        return Err("仅支持CONNECT命令".into());
    }

    let host = match header[3] {
        // IPv4
        0x01 => {
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        // 域名
        0x03 => {
            let mut len_buf = [0u8; 1];
            stream.read_exact(&mut len_buf).await?;
            let len = len_buf[0] as usize;
            let mut domain = vec![0u8; len];
            stream.read_exact(&mut domain).await?;
            String::from_utf8(domain)?
        }
        // IPv6
        0x04 => {
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => return Err("不支持的地址类型".into()),
    };

    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await?;
    let port = u16::from_be_bytes(port_buf);

    Ok((host, port))
}
