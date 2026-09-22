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
use crate::hostkeys::{self, HostKeyPolicy};

/// `execute()` 单次命令允许累积的最大输出字节数，超出即截断，避免远端刷屏打满内存
const EXECUTE_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
/// `execute()` 的整体超时（秒）
const EXECUTE_TIMEOUT_SECS: u64 = 60;
/// 首连主机密钥确认的最长等待（秒）
const HOST_KEY_CONFIRM_TIMEOUT_SECS: u64 = 120;

/// 会话日志落盘目标。
///
/// 终端输出按任意边界分块到达，脱敏必须跨块保持状态（PEM 块 / 未完成的行），
/// 因此把 `LogRedactor` 与文件句柄绑在一起，而不是每块独立处理。
pub struct SessionLogSink {
    file: tokio::fs::File,
    redactor: crate::redact::LogRedactor,
    /// false 表示不做脱敏（仅在用户显式关闭该开关时）
    redact: bool,
}

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
    /// 会话日志（含脱敏状态）
    log_file: Arc<Mutex<Option<SessionLogSink>>>,
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
    /// 主机密钥校验策略
    host_key_policy: HostKeyPolicy,
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

    /// known_hosts 三态校验：已信任放行 / 首次出现需用户确认 / 密钥变更直接拒绝。
    ///
    /// 返回 `Ok(false)` 会让 russh 中止握手，不会降级继续通信。
    async fn check_server_key(
        &mut self,
        server_public_key: &keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let policy = self.host_key_policy.clone();
        Ok(verify_server_key(&policy, server_public_key).await)
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

/// 读取 exec 通道的 stdout/stderr，超过上限即停止累积并提前退出。
async fn collect_channel_output(
    mut channel: Channel<client::Msg>,
) -> Result<(String, bool), Box<dyn std::error::Error + Send + Sync>> {
    let mut output = String::new();
    let mut truncated = false;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                if output.len() >= EXECUTE_OUTPUT_LIMIT {
                    truncated = true;
                    break;
                }
                let remaining = EXECUTE_OUTPUT_LIMIT - output.len();
                let chunk = String::from_utf8_lossy(data);
                if chunk.len() > remaining {
                    output.push_str(&chunk[..remaining]);
                    truncated = true;
                } else {
                    output.push_str(&chunk);
                }
            }
            ChannelMsg::ExitStatus { .. } => break,
            _ => {}
        }
    }

    Ok((output, truncated))
}

/// 按 known_hosts 判定服务端主机密钥是否可信。
async fn verify_server_key(
    policy: &HostKeyPolicy,
    server_public_key: &keys::key::PublicKey,
) -> bool {
    let entries = hostkeys::load();
    match hostkeys::verify(&entries, &policy.host_spec, server_public_key) {
        hostkeys::Verdict::Trusted => true,
        hostkeys::Verdict::Changed {
            expected_fingerprint,
            actual_fingerprint,
        } => {
            // 密钥被替换：只告知，不提供任何"仍然连接"的旁路
            emit_to(
                &policy.app,
                "host-key-changed",
                serde_json::json!({
                    "host_spec": policy.host_spec,
                    "algo": server_public_key.name(),
                    "expected_fingerprint": expected_fingerprint,
                    "actual_fingerprint": actual_fingerprint,
                }),
            );
            eprintln!(
                "[ssh] 主机 {} 密钥与已记录不一致，已拒绝连接（疑似中间人攻击）",
                policy.host_spec
            );
            false
        }
        hostkeys::Verdict::Unknown { fingerprint } => {
            if !policy.strict {
                // 回退开关：沿用旧的自动接受，但仍落盘记录，便于后续收紧
                let _ = hostkeys::trust(&policy.host_spec, server_public_key);
                return true;
            }
            confirm_host_key(policy, server_public_key, &fingerprint).await
        }
    }
}

/// 向前端发起首连确认并等待应答。超时 / 前端不应答 / 明确拒绝都返回 false。
async fn confirm_host_key(
    policy: &HostKeyPolicy,
    server_public_key: &keys::key::PublicKey,
    fingerprint: &str,
) -> bool {
    let Some(app) = policy.app.clone() else {
        // 无 UI 时不放行，避免静默信任
        eprintln!(
            "[ssh] 主机 {} 首次出现，但没有可用于确认的界面，已拒绝连接",
            policy.host_spec
        );
        return false;
    };

    let request_id = Uuid::new_v4().to_string();
    let mut rx = hostkeys::register_request(&request_id);
    let _ = app.emit(
        "host-key-verify",
        serde_json::json!({
            "request_id": request_id,
            "host_spec": policy.host_spec,
            "algo": server_public_key.name(),
            "fingerprint": fingerprint,
        }),
    );

    let trusted = match tokio::time::timeout(
        std::time::Duration::from_secs(HOST_KEY_CONFIRM_TIMEOUT_SECS),
        &mut rx,
    )
    .await
    {
        Ok(Ok(trusted)) => trusted,
        Ok(Err(_)) => false,
        Err(_) => {
            hostkeys::drop_request(&request_id);
            false
        }
    };

    if trusted {
        if let Err(e) = hostkeys::trust(&policy.host_spec, server_public_key) {
            eprintln!("[ssh] 写入 known_hosts 失败: {}", e);
            return false;
        }
    }
    trusted
}

/// 没有 AppHandle 时静默跳过事件投递
fn emit_to(app: &Option<tauri::AppHandle>, event: &str, payload: serde_json::Value) {
    if let Some(app) = app {
        let _ = app.emit(event, payload);
    }
}

/// 构建 SSH 客户端配置。
///
/// 默认只使用现代算法。只有现代算法协商失败时，调用方才会传入
/// `legacy_algorithms = true`，以兼容旧版 SSH 服务端。
fn build_client_config(
    keepalive_interval: Option<u64>,
    legacy_algorithms: bool,
) -> Arc<client::Config> {
    let mut config = client::Config::default();
    if let Some(interval) = keepalive_interval {
        config.keepalive_interval = Some(std::time::Duration::from_secs(interval));
    }

    // russh 0.45 默认列表遗漏了 P-384，但它是现代安全算法。
    config.preferred.key.to_mut().push(keys::key::ECDSA_SHA2_NISTP384);

    if legacy_algorithms {
        // 兼容算法只在现代协商失败后启用，避免普通连接主动降级。
        config.preferred.key.to_mut().push(keys::key::SSH_RSA);
        config.preferred.kex.to_mut().push(kex::DH_G14_SHA1);
        config.preferred.cipher.to_mut().extend([
            cipher::AES_128_CBC,
            cipher::AES_192_CBC,
            cipher::AES_256_CBC,
        ]);
    }

    Arc::new(config)
}

fn should_retry_with_legacy(error: &russh::Error) -> bool {
    matches!(
        error,
        russh::Error::NoCommonKexAlgo
            | russh::Error::NoCommonKeyAlgo
            | russh::Error::NoCommonCipher
            | russh::Error::NoCommonMac
            | russh::Error::NoCommonCompression
    )
}

/// 连接 SSH 服务端，现代算法协商失败时自动尝试兼容算法。
async fn connect_with_fallback(
    host: &str,
    port: u16,
    keepalive_interval: Option<u64>,
    policy: &HostKeyPolicy,
) -> Result<
    (
        client::Handle<ClientHandler>,
        tokio::sync::mpsc::UnboundedReceiver<ForwardedChannel>,
    ),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let (forward_tx, forward_rx) = tokio::sync::mpsc::unbounded_channel();
    let handler = ClientHandler {
        forward_tx: Some(forward_tx),
        host_key_policy: policy.clone(),
    };

    match client::connect(
        build_client_config(keepalive_interval, false),
        (host.trim(), port),
        handler,
    )
    .await
    {
        Ok(session) => Ok((session, forward_rx)),
        Err(error) if should_retry_with_legacy(&error) => {
            eprintln!("[ssh] 现代算法协商失败，尝试兼容算法: {}", error);
            let (legacy_forward_tx, legacy_forward_rx) =
                tokio::sync::mpsc::unbounded_channel();
            let legacy_handler = ClientHandler {
                forward_tx: Some(legacy_forward_tx),
                host_key_policy: policy.clone(),
            };
            let session = client::connect(
                build_client_config(keepalive_interval, true),
                (host.trim(), port),
                legacy_handler,
            )
            .await
            .map_err(|legacy_error| {
                format!(
                    "SSH 算法协商失败（现代算法: {}; 兼容算法: {}）",
                    error, legacy_error
                )
            })?;
            Ok((session, legacy_forward_rx))
        }
        Err(error) => Err(error.into()),
    }
}

/// 通过已认证的跳板机建立目标 SSH 会话，并支持算法兼容回退。
async fn connect_stream_with_fallback(
    jump_session: &mut client::Handle<ClientHandler>,
    target_host: &str,
    target_port: u16,
    keepalive_interval: Option<u64>,
    policy: &HostKeyPolicy,
) -> Result<
    (
        client::Handle<ClientHandler>,
        tokio::sync::mpsc::UnboundedReceiver<ForwardedChannel>,
    ),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let open_channel = || async {
        jump_session
            .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("通过跳板机打开通道失败: {}", e))
    };

    let channel = open_channel().await?;
    let (forward_tx, forward_rx) = tokio::sync::mpsc::unbounded_channel();
    let handler = ClientHandler {
        forward_tx: Some(forward_tx),
        host_key_policy: policy.clone(),
    };

    match client::connect_stream(
        build_client_config(keepalive_interval, false),
        channel.into_stream(),
        handler,
    )
    .await
    {
        Ok(session) => Ok((session, forward_rx)),
        Err(error) if should_retry_with_legacy(&error) => {
            eprintln!("[ssh] 目标主机现代算法协商失败，尝试兼容算法: {}", error);
            let channel = open_channel().await?;
            let (legacy_forward_tx, legacy_forward_rx) =
                tokio::sync::mpsc::unbounded_channel();
            let legacy_handler = ClientHandler {
                forward_tx: Some(legacy_forward_tx),
                host_key_policy: policy.clone(),
            };
            let session = client::connect_stream(
                build_client_config(keepalive_interval, true),
                channel.into_stream(),
                legacy_handler,
            )
            .await
            .map_err(|legacy_error| {
                format!(
                    "目标 SSH 算法协商失败（现代算法: {}; 兼容算法: {}）",
                    error, legacy_error
                )
            })?;
            Ok((session, legacy_forward_rx))
        }
        Err(error) => Err(error.into()),
    }
}

/// 使用服务器配置完成 SSH 认证。
async fn authenticate_session(
    session: &mut client::Handle<ClientHandler>,
    username: &str,
    auth_type: Option<&str>,
    password: Option<&str>,
    private_key: Option<&str>,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    match auth_type.unwrap_or("password") {
        "key" => {
            let key_content = private_key.ok_or("未提供私钥内容")?;
            // 密码字段在密钥认证模式下作为私钥 passphrase 使用。
            let passphrase = password.filter(|value| !value.is_empty());
            let key_pair = keys::decode_secret_key(key_content, passphrase)
                .map_err(|e| format!("解析私钥失败: {}", e))?;
            Ok(session
                .authenticate_publickey(username, Arc::new(key_pair))
                .await?)
        }
        "password" => Ok(session
            .authenticate_password(username, password.unwrap_or(""))
            .await?),
        other => Err(format!("不支持的认证方式: {}", other).into()),
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
        host_key_policy: HostKeyPolicy,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let (mut session, forward_rx) =
            connect_with_fallback(host, port, keepalive_interval, &host_key_policy).await?;

        // 认证
        let auth_ok = authenticate_session(
            &mut session,
            username.trim(),
            auth_type,
            password,
            private_key,
        )
        .await?;

        if !auth_ok {
            return Err("服务器拒绝认证，请确认用户名、密码以及服务器是否允许该认证方式".into());
        }

        // SFTP 不应阻塞 SSH 连接；不可用时回退到 ls -la 模拟。
        let sftp = match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Self::open_sftp(&mut session),
        )
        .await
        {
            Ok(Ok(sftp)) => Some(sftp),
            Ok(Err(e)) => {
                eprintln!("[ssh] SFTP 子系统初始化失败，将使用 ls 回退: {}", e);
                None
            }
            Err(_) => {
                eprintln!("[ssh] SFTP 子系统初始化超时，将使用 ls 回退");
                None
            }
        };

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
        jump_host_key_policy: HostKeyPolicy,
        target_host_key_policy: HostKeyPolicy,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        // 1. 先连接到跳板机
        let (mut jump_session, _jump_forward_rx) = connect_with_fallback(
            jump_host,
            jump_port,
            keepalive_interval,
            &jump_host_key_policy,
        )
        .await?;

        // 认证跳板机
        let jump_auth_ok = authenticate_session(
            &mut jump_session,
            jump_username.trim(),
            jump_auth_type,
            jump_password,
            jump_private_key,
        )
        .await?;

        if !jump_auth_ok {
            return Err("跳板机拒绝认证，请确认用户名、密码以及服务器是否允许该认证方式".into());
        }

        // 2-3. 通过跳板机打开通道并建立目标 SSH 会话
        let (mut target_session, target_forward_rx) = connect_stream_with_fallback(
            &mut jump_session,
            target_host,
            target_port,
            keepalive_interval,
            &target_host_key_policy,
        )
        .await?;

        // 4. 认证目标主机
        let target_auth_ok = authenticate_session(
            &mut target_session,
            target_username.trim(),
            target_auth_type,
            target_password,
            target_private_key,
        )
        .await?;

        if !target_auth_ok {
            return Err("目标主机拒绝认证，请确认用户名、密码以及服务器是否允许该认证方式".into());
        }

        // 5. 尝试初始化 SFTP 子系统
        let sftp = match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            Self::open_sftp(&mut target_session),
        )
        .await
        {
            Ok(Ok(sftp)) => Some(sftp),
            Ok(Err(e)) => {
                eprintln!("[ssh] 目标主机 SFTP 子系统初始化失败，将使用 ls 回退: {}", e);
                None
            }
            Err(_) => {
                eprintln!("[ssh] 目标主机 SFTP 子系统初始化超时，将使用 ls 回退");
                None
            }
        };

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
    ///
    /// 打开通道后立即释放会话锁（读输出不再需要 handle），并对输出量与耗时设上限，
    /// 避免 `cat /dev/urandom` 这类命令把内存打满或让调用方永久挂起。
    pub async fn execute(&self, command: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let channel = {
            let mut handle = self.handle.lock().await;
            let session = handle.as_mut().ok_or("会话已关闭")?;
            let channel = session.channel_open_session().await?;
            channel.exec(true, command).await?;
            channel
        };

        let collected = tokio::time::timeout(
            std::time::Duration::from_secs(EXECUTE_TIMEOUT_SECS),
            collect_channel_output(channel),
        )
        .await
        .map_err(|_| format!("命令执行超时（{}秒）", EXECUTE_TIMEOUT_SECS))?;

        let (mut output, truncated) = collected?;
        if truncated {
            output.push_str(&format!(
                "\n[输出超过 {} 字节上限，已截断]\n",
                EXECUTE_OUTPUT_LIMIT
            ));
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

        // 创建日志文件（受 session_logging / log_redaction 开关控制）
        let settings = crate::config::load_config().settings;
        if settings.session_logging {
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
                .ok()
                .map(|file| SessionLogSink {
                    file,
                    redactor: crate::redact::LogRedactor::default(),
                    redact: settings.log_redaction,
                });
            // 日志记录的是终端原文, 即便已脱敏也只允许属主读（04 4.5）
            if log_file.is_some() {
                crate::config::restrict_private(&log_path);
            }
            *self.log_file.lock().await = log_file;
        }

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
                                // 关闭日志文件（先冲刷未换行的尾部）
                                let mut lf = log_file_arc.lock().await;
                                if let Some(mut sink) = lf.take() {
                                    if sink.redact {
                                        let tail = sink.redactor.flush();
                                        if !tail.is_empty() {
                                            let _ = sink.file.write_all(tail.as_bytes()).await;
                                        }
                                    }
                                }
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

    /// 写入日志(带时间戳, 默认经脱敏)
    async fn write_log(
        log_file: &Arc<Mutex<Option<SessionLogSink>>>,
        data: &str,
    ) {
        let mut lf = log_file.lock().await;
        let Some(sink) = lf.as_mut() else {
            return;
        };
        let text = if sink.redact {
            sink.redactor.push(data)
        } else {
            data.to_string()
        };
        if text.is_empty() {
            return;
        }
        let timestamp = chrono::Local::now().format("[%Y-%m-%d %H:%M:%S] ");
        let log_line = format!("{}{}", timestamp, text);
        let _ = sink.file.write_all(log_line.as_bytes()).await;
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
        // 先终止端口转发任务，否则 JoinHandle 要等底层 accept 出错才退出
        {
            let mut map = self.forwards.lock().await;
            for (_, join) in map.drain() {
                join.abort();
            }
        }
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
pub(crate) fn shell_escape(s: &str) -> String {
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
