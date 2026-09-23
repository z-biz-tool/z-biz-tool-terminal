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
/// PTY 输出批处理的单批上限（字节）：达到即刷出，兼顾吞吐与内存占用
const PTY_BATCH_MAX_BYTES: usize = 64 * 1024;
/// 会话日志通道深度：磁盘暂时落后时先缓冲，不阻塞终端读循环
const LOG_CHANNEL_CAPACITY: usize = 256;
/// SFTP 传输进度上报的最小间隔（毫秒）。32 KB 一块，快链路上一秒能跑上百块，
/// 逐块 emit 会把事件通道和前端渲染打满；250 ms 在人眼看起来已经是连续的。
const SFTP_PROGRESS_INTERVAL_MS: u64 = 250;

/// 进度是否该上报：首块必报、传完必报，中间按间隔节流。
///
/// `total == 0` 有两种含义（空文件、远端不给大小），两种都不许被当成"已经传完"，
/// 所以末尾判定要求 `total > 0`；大小未知时前端只会显示"大小未知"而不是猜一个百分比。
fn should_emit_progress(
    now_ms: u64,
    last_emit_ms: Option<u64>,
    transferred: u64,
    total: u64,
) -> bool {
    let Some(last) = last_emit_ms else {
        return true;
    };
    if total > 0 && transferred >= total {
        return true;
    }
    now_ms.saturating_sub(last) >= SFTP_PROGRESS_INTERVAL_MS
}

/// 取路径最后一段：只用于上屏显示（Windows 的反斜杠也要认）
fn base_name(path: &str) -> String {
    match path.rsplit(['/', '\\']).next() {
        Some("") | None => path.to_string(),
        Some(name) => name.to_string(),
    }
}

/// 用户请求中断的传输 id 集合。复制循环每读一块前查一次；命令结束时清掉，
/// 免得标记一直挂着。锁只保护这个集合本身、跨 `.await` 时绝不持有，所以用 `std::sync::Mutex`
/// 就够；中毒也不 panic —— 传输路径上炸一次会把整个会话带走。
static CANCELLATIONS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<u64>>> =
    std::sync::OnceLock::new();

fn cancellations() -> &'static std::sync::Mutex<std::collections::HashSet<u64>> {
    CANCELLATIONS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

pub fn request_transfer_cancel(transfer_id: u64) {
    if let Ok(mut set) = cancellations().lock() {
        set.insert(transfer_id);
    }
}

pub fn transfer_cancel_requested(transfer_id: u64) -> bool {
    match cancellations().lock() {
        Ok(set) => set.contains(&transfer_id),
        Err(_) => false,
    }
}

pub fn clear_transfer_cancel(transfer_id: u64) {
    if let Ok(mut set) = cancellations().lock() {
        set.remove(&transfer_id);
    }
}

/// 下载的临时落点：与目标同目录、加 `.part` 后缀。
///
/// 有了它，"取消"和"传一半失败"才不会留下一个看起来像完整文件的半截文件 —— 否则用户下一次
/// 重试会被 §7.30 那道"已存在即拒写"的闸挡住，而屏幕上什么都没有。
pub fn part_path_for(target: &std::path::Path, transfer_id: u64) -> std::path::PathBuf {
    let stem = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let name = format!("{}.{}.part", stem, transfer_id);
    target.with_file_name(name)
}

/// 远端分片路径：与目标同一个"目录"、加 `.part` 后缀。
///
/// 只按 `/` 拆 —— SFTP 的路径是远端服务器的路径，本机是 Windows 也不能拿 `\` 去切它。
pub fn remote_part_path(remote: &str, transfer_id: u64) -> String {
    let at = remote.rfind('/');
    let (dir, name) = match at {
        Some(0) => ("/".to_string(), remote[1..].to_string()),
        Some(i) => (remote[..i].to_string(), remote[i + 1..].to_string()),
        None => (String::new(), remote.to_string()),
    };
    let name = if name.is_empty() {
        "file".to_string()
    } else {
        name
    };
    let joined = format!("{}.{}.part", name, transfer_id);
    if dir.is_empty() {
        joined
    } else if dir.ends_with('/') {
        format!("{}{}", dir, joined)
    } else {
        format!("{}/{}", dir, joined)
    }
}

/// 把临时分片提升到正式路径：同目录 `rename`，POSIX 上是原子的 —— 用户要么看到完整的
/// 文件，要么什么都看不到，不会看到半截。
pub async fn commit_part(part: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    tokio::fs::rename(part, target).await
}

/// 丢掉半截分片。本来就没建出来（例如刚取消）也算成功，不因此报错。
pub async fn discard_part(part: &std::path::Path) {
    let _ = tokio::fs::remove_file(part).await;
}

/// 把一次 SFTP 传输进度推给前端。事件名与载荷键是跨语言契约，
/// `tests/sftp-progress.test.ts` 会拿这里与前端读取处逐键对账。
///
/// `transfer_id` 由前端发起传输时生成、原样回带：认领一条进度靠这个身份，不靠文件名 ——
/// 批量上传两个同名文件时文件名会撞，靠名字匹配会把上一条的字节数画到下一条头上。
fn emit_sftp_progress(
    app: &tauri::AppHandle,
    session_id: &str,
    kind: &str,
    filename: &str,
    transfer_id: u64,
    transferred: u64,
    total: u64,
) {
    let _ = app.emit(
        "sftp-progress",
        serde_json::json!({
            "session_id": session_id,
            "kind": kind,
            "filename": filename,
            "transfer_id": transfer_id,
            "transferred": transferred,
            "total": total,
        }),
    );
}

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

/// 交给日志 task 的消息。通道 FIFO，因此 `Close` 之前的块一定先被写入。
enum LogCommand {
    Chunk(String),
    Close,
}

impl SessionLogSink {
    /// 写入一块终端输出(带时间戳, 默认经脱敏)
    async fn append(&mut self, data: &str) {
        let text = if self.redact {
            self.redactor.push(data)
        } else {
            data.to_string()
        };
        if text.is_empty() {
            return;
        }
        let timestamp = chrono::Local::now().format("[%Y-%m-%d %H:%M:%S] ");
        let log_line = format!("{}{}", timestamp, text);
        let _ = self.file.write_all(log_line.as_bytes()).await;
    }

    /// 收尾：把脱敏器里攒着的未完成行冲刷出来，然后丢掉句柄关闭文件
    async fn finish(mut self) {
        if self.redact {
            let tail = self.redactor.flush();
            if !tail.is_empty() {
                let _ = self.file.write_all(tail.as_bytes()).await;
            }
        }
    }
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
    /// 会话日志写入通道：真正的磁盘写由独立 task 承担（T-3-2）
    log_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<LogCommand>>>>,
    /// 活跃的端口转发任务: forward_id -> (JoinHandle, 描述)
    forwards: Arc<Mutex<HashMap<String, ForwardTask>>>,
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

/// 一条端口转发的静态描述。
///
/// 存在后端而不是只留在前端：转发生命周期跟着 SSH 会话，面板关掉之后仍然在跑；
/// 前端重新打开时必须能从会话本身读回真实列表（否则"看起来没有转发"而端口其实还开着）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    /// "local" | "remote" | "dynamic"
    pub kind: String,
    /// 监听侧：local/dynamic 是本机，remote 是远端
    pub listen_addr: String,
    pub listen_port: u16,
    /// 目标侧：local 是远端服务，remote 是本地服务，dynamic（SOCKS5）没有固定目标
    pub target_addr: Option<String>,
    pub target_port: Option<u16>,
}

/// 转发任务 = 后台 accept 循环 + 它的静态描述，两者同生同死，避免两份登记表漂移
pub struct ForwardTask {
    join: tokio::task::JoinHandle<()>,
    pub spec: ForwardSpec,
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

/// 把一段输出追加进缓冲，触到 `limit` 就截断并返回 true。
///
/// 截断点必须落在字符边界上：远程日志常见中文（3 字节），
/// 直接按字节切 `&chunk[..remaining]` 会 panic 在"byte index is not a char boundary"。
fn append_capped(output: &mut String, chunk: &str, limit: usize) -> bool {
    if output.len() >= limit {
        return true;
    }
    let remaining = limit - output.len();
    if chunk.len() <= remaining {
        output.push_str(chunk);
        return false;
    }
    let mut end = remaining;
    while end > 0 && !chunk.is_char_boundary(end) {
        end -= 1;
    }
    output.push_str(&chunk[..end]);
    true
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
                let chunk = String::from_utf8_lossy(data);
                if append_capped(&mut output, &chunk, EXECUTE_OUTPUT_LIMIT) {
                    truncated = true;
                    break;
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
            audit_host_key(
                policy,
                server_public_key,
                serde_json::json!({
                    "decision": "rejected_changed",
                    "expected_fingerprint": expected_fingerprint,
                    "fingerprint": actual_fingerprint,
                }),
            );
            false
        }
        hostkeys::Verdict::Unknown { fingerprint } => {
            if !policy.strict {
                // 回退开关：沿用旧的自动接受，但仍落盘记录，便于后续收紧
                let _ = hostkeys::trust(&policy.host_spec, server_public_key);
                audit_host_key(
                    policy,
                    server_public_key,
                    serde_json::json!({
                        "decision": "auto_accepted",
                        "reason": "strict_host_key 已关闭",
                        "fingerprint": fingerprint,
                    }),
                );
                return true;
            }
            confirm_host_key(policy, server_public_key, &fingerprint).await
        }
    }
}

/// 主机密钥决策进审计（T-4-7）。指纹本身不是凭证，可放心留档用于事后比对。
fn audit_host_key(
    policy: &HostKeyPolicy,
    server_public_key: &keys::key::PublicKey,
    detail: serde_json::Value,
) {
    let mut obj = match detail {
        serde_json::Value::Object(obj) => obj,
        _ => serde_json::Map::new(),
    };
    obj.insert(
        "host_spec".into(),
        serde_json::Value::String(policy.host_spec.clone()),
    );
    obj.insert(
        "algo".into(),
        serde_json::Value::String(server_public_key.name().to_string()),
    );
    crate::audit::record("host_key", serde_json::Value::Object(obj));
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
        audit_host_key(
            policy,
            server_public_key,
            serde_json::json!({
                "decision": "rejected_no_ui",
                "fingerprint": fingerprint,
            }),
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

    let (trusted, decision) = match tokio::time::timeout(
        std::time::Duration::from_secs(HOST_KEY_CONFIRM_TIMEOUT_SECS),
        &mut rx,
    )
    .await
    {
        Ok(Ok(true)) => (true, "user_trusted"),
        Ok(Ok(false)) => (false, "user_rejected"),
        Ok(Err(_)) => (false, "confirm_channel_closed"),
        Err(_) => {
            hostkeys::drop_request(&request_id);
            (false, "confirm_timeout")
        }
    };
    audit_host_key(
        policy,
        server_public_key,
        serde_json::json!({
            "decision": decision,
            "fingerprint": fingerprint,
        }),
    );

    if trusted {
        if let Err(e) = hostkeys::trust(&policy.host_spec, server_public_key) {
            eprintln!("[ssh] 写入 known_hosts 失败: {}", e);
            audit_host_key(
                policy,
                server_public_key,
                serde_json::json!({
                    "decision": "known_hosts_write_failed",
                    "error": e.to_string(),
                    "fingerprint": fingerprint,
                }),
            );
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
    config
        .preferred
        .key
        .to_mut()
        .push(keys::key::ECDSA_SHA2_NISTP384);

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
            let (legacy_forward_tx, legacy_forward_rx) = tokio::sync::mpsc::unbounded_channel();
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
            let (legacy_forward_tx, legacy_forward_rx) = tokio::sync::mpsc::unbounded_channel();
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
            log_tx: Arc::new(Mutex::new(None)),
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
                eprintln!(
                    "[ssh] 目标主机 SFTP 子系统初始化失败，将使用 ls 回退: {}",
                    e
                );
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
            log_tx: Arc::new(Mutex::new(None)),
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
    pub async fn execute(
        &self,
        command: &str,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
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

    /// 32 KB 一块地搬运，并按 `SFTP_PROGRESS_INTERVAL_MS` 节流上报进度。
    /// 读/写两端谁本地谁远端都行，进度判定只有一份（两条路径各写一遍必然分家）。
    async fn pump_with_progress<R, W>(
        &self,
        app: &tauri::AppHandle,
        kind: &str,
        filename: &str,
        transfer_id: u64,
        mut reader: R,
        mut writer: W,
        total: u64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
    where
        R: AsyncReadExt + Unpin,
        W: AsyncWriteExt + Unpin,
    {
        let mut buf = vec![0u8; 32768];
        let mut transferred: u64 = 0;
        let started = std::time::Instant::now();
        let mut last_emit: Option<u64> = None;
        // 用 async 块包住整个搬运，"取消/出错也要清标记"就只有一条出口
        let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
            loop {
                if transfer_cancel_requested(transfer_id) {
                    return Err("已取消".into());
                }
                let n = reader.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                writer.write_all(&buf[..n]).await?;
                transferred += n as u64;
                let now_ms = started.elapsed().as_millis() as u64;
                if should_emit_progress(now_ms, last_emit, transferred, total) {
                    last_emit = Some(now_ms);
                    emit_sftp_progress(
                        app,
                        &self.id,
                        kind,
                        filename,
                        transfer_id,
                        transferred,
                        total,
                    );
                }
            }
            writer.flush().await?;
            Ok(())
        }
        .await;
        clear_transfer_cancel(transfer_id);
        result
    }

    /// SFTP 上传文件
    pub async fn sftp_upload(
        &self,
        local_path: &str,
        remote_path: &str,
        transfer_id: u64,
        app: &tauri::AppHandle,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            let local_file = tokio::fs::File::open(local_path).await?;
            // 大小读不到就报 0：前端只会显示"大小未知"，不会猜一个百分比
            let total = local_file.metadata().await.map(|m| m.len()).unwrap_or(0);
            // 先写远端分片，全部写完再 rename 到位：中断或失败都不会把远端原文件截断
            let part = remote_part_path(remote_path, transfer_id);
            let remote_file = sftp.create(&part).await?;
            match self
                .pump_with_progress(
                    app,
                    "upload",
                    &base_name(local_path),
                    transfer_id,
                    local_file,
                    remote_file,
                    total,
                )
                .await
            {
                Ok(()) => {
                    sftp.rename(&part, remote_path).await?;
                    Ok(())
                }
                Err(e) => {
                    // 清不掉也只报告原始错误：分片留在远端比谎报"已取消"更诚实，但别吞掉真因
                    if let Err(ce) = sftp.remove_file(&part).await {
                        eprintln!("清理远端分片 {} 失败: {}", part, ce);
                    }
                    Err(e)
                }
            }
        } else {
            Err("SFTP 子系统未初始化".into())
        }
    }

    /// SFTP 下载文件
    pub async fn sftp_download(
        &self,
        remote_path: &str,
        local_path: &str,
        transfer_id: u64,
        app: &tauri::AppHandle,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let sftp_lock = self.sftp.lock().await;
        if let Some(sftp) = sftp_lock.as_ref() {
            // 远端 stat 失败不影响下载本身，只是没有百分比可算
            let total = sftp
                .metadata(remote_path)
                .await
                .map(|m| m.size.unwrap_or(0))
                .unwrap_or(0);
            let remote_file = sftp.open(remote_path).await?;
            // 先写 .part，成功才 rename：半截文件不会冒充已完成的一次下载
            let part = part_path_for(std::path::Path::new(local_path), transfer_id);
            let local_file = tokio::fs::File::create(&part).await?;
            match self
                .pump_with_progress(
                    app,
                    "download",
                    &base_name(remote_path),
                    transfer_id,
                    remote_file,
                    local_file,
                    total,
                )
                .await
            {
                Ok(()) => {
                    commit_part(&part, std::path::Path::new(local_path)).await?;
                    Ok(())
                }
                Err(e) => {
                    discard_part(&part).await;
                    Err(e)
                }
            }
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
            let sink = tokio::fs::OpenOptions::new()
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
            if sink.is_some() {
                crate::config::restrict_private(&log_path);
            }
            if let Some(sink) = sink {
                // 磁盘写交给独立 task：读循环只 send，慢盘不再拖住终端输出（T-3-2）。
                // 关掉 session_log_async 时通道深度压到 1，退化为"写完上一块才收下一块"，
                // 而不是另养一份同步实现。
                let capacity = if settings.session_log_async {
                    LOG_CHANNEL_CAPACITY
                } else {
                    1
                };
                let (log_tx, log_rx) = tokio::sync::mpsc::channel::<LogCommand>(capacity);
                tokio::spawn(Self::run_log_writer(sink, log_rx));
                *self.log_tx.lock().await = Some(log_tx);
            }
        }

        // 启动PTY事件循环：读取输出、写入数据、处理resize、转交日志
        let read_app = app.clone();
        let read_session_id = session_id.clone();
        // 取一份 Sender 副本，之后热路径里不再碰 Mutex
        let log_tx = self.log_tx.lock().await.clone();
        // 批处理窗口：窗口内的小块合并成一次 emit（T-3-1）；0 毫秒回退为逐块下发（§5.7）
        let batch_window = std::time::Duration::from_millis(settings.pty_batch_window_ms);
        let batching = !batch_window.is_zero();
        let mut ticker = batching.then(|| {
            let mut it = tokio::time::interval(batch_window);
            // 卡顿时不补发积压的 tick，否则会一次性刷出多批、放大延迟
            it.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            it
        });
        tokio::spawn(async move {
            let mut pending = String::new();
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data })
                            | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                                pending.push_str(&String::from_utf8_lossy(data));
                                // 攒满一批立即刷出，不等窗口
                                if Self::pty_batch_should_flush(batching, pending.len()) {
                                    Self::flush_pty_batch(
                                        &read_app,
                                        &read_session_id,
                                        &log_tx,
                                        &mut pending,
                                    )
                                    .await;
                                }
                            }
                            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | None => {
                                // 先刷出窗口里的输出，保证"会话已关闭"永远排在最后
                                Self::flush_pty_batch(&read_app, &read_session_id, &log_tx, &mut pending)
                                    .await;
                                let _ = read_app.emit(
                                    "pty-output",
                                    serde_json::json!({
                                        "session_id": &read_session_id,
                                        "data": "\r\n[会话已关闭]\r\n",
                                    }),
                                );
                                // 发送会话关闭事件
                                let _ = read_app.emit(
                                    "pty-closed",
                                    serde_json::json!({
                                        "session_id": &read_session_id,
                                    }),
                                );
                                break;
                            }
                            _ => {}
                        }
                    }
                    // 窗口到期：把攒下的输出一并下发；批处理关闭时这条分支永不就绪
                    _ = Self::tick_or_sleep(&mut ticker) => {
                        Self::flush_pty_batch(&read_app, &read_session_id, &log_tx, &mut pending)
                            .await;
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
            // 从任意分支退出都要刷掉尾巴并收掉日志通道，不吞未下发的输出
            Self::flush_pty_batch(&read_app, &read_session_id, &log_tx, &mut pending).await;
            if let Some(tx) = &log_tx {
                let _ = tx.send(LogCommand::Close).await;
            }
        });

        Ok(())
    }

    /// 该批是否要立即刷出：关闭批处理时必须逐块下发，攒到上限则不必等窗口
    fn pty_batch_should_flush(batching: bool, len: usize) -> bool {
        !batching || len >= PTY_BATCH_MAX_BYTES
    }

    /// 读循环的 tick 分支：批处理关闭时返回一个永不完成的 future，让 select 忽略该分支
    async fn tick_or_sleep(ticker: &mut Option<tokio::time::Interval>) {
        match ticker {
            Some(it) => {
                it.tick().await;
            }
            None => std::future::pending::<()>().await,
        }
    }

    /// 刷出批处理窗口：一次 emit 推给前端，一次 send 转交日志 task
    async fn flush_pty_batch(
        app: &tauri::AppHandle,
        session_id: &str,
        log_tx: &Option<tokio::sync::mpsc::Sender<LogCommand>>,
        pending: &mut String,
    ) {
        if pending.is_empty() {
            return;
        }
        let data = std::mem::take(pending);
        let _ = app.emit(
            "pty-output",
            serde_json::json!({
                "session_id": session_id,
                "data": &data,
            }),
        );
        if let Some(tx) = log_tx {
            // 通道满时在此等待日志 task 追上：宁可背压，也不静默丢掉审计行
            let _ = tx.send(LogCommand::Chunk(data)).await;
        }
    }

    /// 会话日志写入 task：按到达顺序脱敏落盘，退出前冲刷未换行的尾部
    async fn run_log_writer(
        mut sink: SessionLogSink,
        mut rx: tokio::sync::mpsc::Receiver<LogCommand>,
    ) {
        while let Some(cmd) = rx.recv().await {
            match cmd {
                LogCommand::Chunk(data) => sink.append(&data).await,
                LogCommand::Close => break,
            }
        }
        sink.finish().await;
    }

    /// 向PTY写入数据
    pub async fn pty_write(
        &self,
        data: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
                    .channel_open_direct_tcpip(&rh, remote_port as u32, &la, actual_port as u32)
                    .await
                {
                    Ok(ch) => ch,
                    Err(_) => continue,
                };
                drop(h); // release lock before I/O

                let channel_stream = channel.into_stream();
                tokio::spawn(async move {
                    let (mut tcp_read, mut tcp_write) = tcp_stream.split();
                    let (mut ssh_read, mut ssh_write) = tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(
            forward_id.clone(),
            ForwardTask {
                join,
                spec: ForwardSpec {
                    kind: "local".into(),
                    listen_addr: local_addr.to_string(),
                    listen_port: actual_port,
                    target_addr: Some(remote_host.to_string()),
                    target_port: Some(remote_port),
                },
            },
        );
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
            let session = h.as_mut().ok_or("会话已关闭")?;
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
                    let (mut ssh_read, mut ssh_write) = tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(
            forward_id.clone(),
            ForwardTask {
                join,
                spec: ForwardSpec {
                    // remote 的监听侧在远端，目标侧才是本地服务
                    kind: "remote".into(),
                    listen_addr: remote_addr.to_string(),
                    listen_port: actual_port,
                    target_addr: Some(local_host.to_string()),
                    target_port: Some(local_port),
                },
            },
        );
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
                    let (mut ssh_read, mut ssh_write) = tokio::io::split(channel_stream);
                    let c2s = tokio::io::copy(&mut tcp_read, &mut ssh_write);
                    let s2c = tokio::io::copy(&mut ssh_read, &mut tcp_write);
                    let _ = tokio::try_join!(c2s, s2c);
                });
            }
            // 清理
            fwd_map.lock().await.remove(&fid);
        });

        self.forwards.lock().await.insert(
            forward_id.clone(),
            ForwardTask {
                join,
                spec: ForwardSpec {
                    // SOCKS5 的目标由每个连接在握手时决定，没有固定目标
                    kind: "dynamic".into(),
                    listen_addr: local_addr.to_string(),
                    listen_port: actual_port,
                    target_addr: None,
                    target_port: None,
                },
            },
        );
        Ok((forward_id, actual_port))
    }

    /// 列出本会话当前仍在跑的端口转发（`false` 表示后台任务已退出但还没来自我清理）
    pub async fn list_forwards(&self) -> Vec<(String, ForwardSpec, bool)> {
        let map = self.forwards.lock().await;
        let mut out: Vec<(String, ForwardSpec, bool)> = map
            .iter()
            .map(|(id, t)| (id.clone(), t.spec.clone(), !t.join.is_finished()))
            .collect();
        out.sort_by(|a, b| {
            (a.1.kind.as_str(), a.1.listen_port)
                .cmp(&(b.1.kind.as_str(), b.1.listen_port))
                .then_with(|| a.0.cmp(&b.0))
        });
        out
    }

    /// 停止端口转发
    pub async fn stop_forward(
        &self,
        forward_id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut map = self.forwards.lock().await;
        if let Some(task) = map.remove(forward_id) {
            task.join.abort();
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
            for (_, task) in map.drain() {
                task.join.abort();
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
        // 关闭日志通道：读循环退出时还会补一个 Close，这里只需放掉本会话持有的发送端
        {
            let mut lf = self.log_tx.lock().await;
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
            let _ = session
                .disconnect(Disconnect::ByApplication, "", "en")
                .await;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 进度闸门：首块必报、传完必报、中间按间隔节流；大小未知时不许冒充"传完"
    #[test]
    fn sftp_progress_gate_emits_first_last_and_periodically() {
        // 首块：没有上一次上报就一定报
        assert!(should_emit_progress(0, None, 32768, 100_000));
        // 间隔未到
        assert!(!should_emit_progress(100, Some(0), 65536, 100_000));
        // 间隔到了
        assert!(should_emit_progress(
            SFTP_PROGRESS_INTERVAL_MS,
            Some(0),
            65536,
            100_000
        ));
        // 传完即报，哪怕间隔未到
        assert!(should_emit_progress(10, Some(0), 100_000, 100_000));
        assert!(should_emit_progress(10, Some(0), 120_000, 100_000));
        // 大小未知（total = 0）：既不是"传完"，也只是普通的一帧 —— 已经报过首块，所以按间隔走
        assert!(!should_emit_progress(10, Some(0), 32768, 0));
        assert!(should_emit_progress(
            SFTP_PROGRESS_INTERVAL_MS,
            Some(0),
            32768,
            0
        ));
        // 时钟倒退（saturating）也不该 panic 或永久沉默
        assert!(!should_emit_progress(5, Some(900), 32768, 100_000));
    }

    /// 文件名是两端认领进度事件的凭据之一，反斜杠路径（Windows）也要截对
    #[test]
    fn sftp_base_name_handles_both_separators() {
        assert_eq!(base_name("/var/log/app.log"), "app.log");
        assert_eq!(base_name("C:\\temp\\app.log"), "app.log");
        assert_eq!(base_name("app.log"), "app.log");
        // 截不出来就退回整条路径，别报一个空文件名（前端会因此认不到自己的传输）
        assert_eq!(base_name("/var/log/"), "/var/log/");
    }

    #[test]
    fn shell_escape_keeps_payload_inside_quotes() {
        assert_eq!(shell_escape("plain"), "'plain'");
        assert_eq!(shell_escape(""), "''");
        assert_eq!(shell_escape("a b/c"), "'a b/c'");
        // 单引号必须展开成 '"'"'，否则会把外层引号闭合掉
        assert_eq!(shell_escape("a'b"), "'a'\"'\"'b'");
    }

    /// P0-2 验收：转义后不得存在"裸露"的单引号，即无法从字符串里逃出来
    #[test]
    fn shell_escape_cannot_be_broken_out_of() {
        for payload in [
            "'; rm -rf / #",
            "'\"'\"'; id; \"\"'",
            "$(id)",
            "`id`",
            "a\nb",
            "a|b",
            "a && b",
        ] {
            let escaped = shell_escape(payload);
            assert!(escaped.starts_with('\'') && escaped.ends_with('\''));
            let inner = &escaped[1..escaped.len() - 1];
            let without_wrapping = inner.replace("'\"'\"'", "");
            assert!(
                !without_wrapping.contains('\''),
                "转义结果仍含未包裹的单引号: {:?}",
                escaped
            );
        }
    }

    /// T-3-4 验收：达到上限后停止累积；超限的那一段既不能丢字符也不能越界
    #[test]
    fn append_capped_stops_at_limit_without_splitting_utf8() {
        let mut ascii = String::new();
        assert!(!append_capped(&mut ascii, "abcdef", 10));
        assert!(!append_capped(&mut ascii, "ghij", 10), "刚好填满不算截断");
        assert_eq!(ascii, "abcdefghij");
        assert!(append_capped(&mut ascii, "k", 10), "已满要继续报截断");
        assert_eq!(ascii, "abcdefghij", "已满之后不得再吞字节");

        let mut half = String::from("abc");
        assert!(append_capped(&mut half, "defghij", 6), "越过上限要报截断");
        assert_eq!(half, "abcdef", "只收到上限为止");

        // 剩余空间正好容纳一个汉字：按整字符对齐收下，不留半个字符
        let mut partial = String::from("ab");
        assert!(append_capped(&mut partial, "汉字测试", 5));
        assert_eq!(partial, "ab汉");

        // 剩余空间落在汉字中间：只能一个都不收，绝不能按字节切片 panic
        let mut tight = String::from("ab");
        assert!(append_capped(&mut tight, "汉字测试", 4));
        assert_eq!(tight, "ab");
        assert!(tight.is_char_boundary(tight.len()));
    }

    /// T-3-1 验收：批处理不能只看窗口——关闭时必须逐块下发，攒满上限要立刻刷出
    #[test]
    fn pty_batch_flushes_on_cap_or_when_disabled() {
        assert!(!SshSession::pty_batch_should_flush(true, 0));
        assert!(!SshSession::pty_batch_should_flush(
            true,
            PTY_BATCH_MAX_BYTES - 1
        ));
        assert!(SshSession::pty_batch_should_flush(
            true,
            PTY_BATCH_MAX_BYTES
        ));
        // 超长单块（一次到达 1MB）也要被判定为"该刷出"
        assert!(SshSession::pty_batch_should_flush(
            true,
            PTY_BATCH_MAX_BYTES * 4
        ));
        // 回退开关：窗口=0 时每块都刷，行为与旧实现一致
        for len in [0usize, 1, PTY_BATCH_MAX_BYTES * 10] {
            assert!(SshSession::pty_batch_should_flush(false, len));
        }
    }

    /// T-3-2 验收：日志改由独立 task 落盘后，顺序、脱敏状态、未换行尾部都不能丢
    #[test]
    fn cancellations_are_isolated_per_transfer_id() {
        // 全局登记表在测试进程里是共享的：用进程号 + 计数造出唯一 id，避免互相干扰
        fn unique() -> u64 {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            (std::process::id() as u64) << 24 | SEQ.fetch_add(1, Ordering::Relaxed)
        }
        let a = unique();
        let b = unique();
        assert!(!transfer_cancel_requested(a), "没请求过就不该是取消");
        request_transfer_cancel(a);
        assert!(transfer_cancel_requested(a), "按 id 取消应当生效");
        assert!(
            !transfer_cancel_requested(b),
            "不得牵连别的传输（同一次批量里其它文件还在传）"
        );
        clear_transfer_cancel(a);
        assert!(!transfer_cancel_requested(a), "取消标记用完要清掉");
        clear_transfer_cancel(b);
    }

    #[test]
    fn part_path_stays_beside_its_target() {
        let target = std::path::Path::new("/tmp/zterm-dl/app.jar");
        let part = part_path_for(target, 7);
        assert_eq!(
            part.parent(),
            target.parent(),
            "分片必须留在同一个目录（白名单是按目录判的）"
        );
        assert_eq!(
            part.file_name().unwrap().to_string_lossy(),
            "app.jar.7.part",
            "带上 transfer_id，两个并发同名下载不能抢同一个分片"
        );
        assert_ne!(part, target);
        let root = part_path_for(std::path::Path::new("/"), 1);
        assert!(
            root.to_string_lossy().ends_with(".part"),
            "拿不到文件名时也要给出可用路径"
        );
    }

    #[test]
    fn remote_part_path_keeps_the_remote_directory() {
        // 带目录：分片必须落在同一个远端目录里，否则 rename 跨目录就不是原子的了
        assert_eq!(
            remote_part_path("/etc/nginx/nginx.conf", 4),
            "/etc/nginx/nginx.conf.4.part"
        );
        // 根目录下、隐藏文件、以及没有目录的相对路径都要给出可用名字
        assert_eq!(remote_part_path("/hosts", 1), "/hosts.1.part");
        assert_eq!(remote_part_path(".bashrc", 2), ".bashrc.2.part");
        // 以 / 结尾的"文件路径"其实是目录，给个可用的兜底名字而不是造出 `.3.part` 这种隐藏文件
        assert_eq!(remote_part_path("/tmp/", 3), "/tmp/file.3.part");
        // 关键不变量：分片与目标同名不同路径、且以目标所在目录为前缀
        for p in ["/etc/nginx/nginx.conf", "/hosts", ".bashrc", "/a/b/c/d.txt"] {
            let part = remote_part_path(p, 9);
            assert!(part.ends_with(".part"), "{} -> {}", p, part);
            let dir_of = |s: &str| {
                s.rsplit_once('/')
                    .map(|(d, _)| d.to_string())
                    .unwrap_or_default()
            };
            assert_eq!(dir_of(&part), dir_of(p), "分片必须与目标同目录: {}", part);
            assert_ne!(part, p);
        }
    }

    #[tokio::test]
    async fn commit_and_discard_keep_download_atomic() {
        let dir = std::env::temp_dir().join(format!("zterm-part-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let target = dir.join("big.bin");
        let part = part_path_for(&target, 3);

        // 取消/失败：分片丢掉，正式路径根本不该出现
        tokio::fs::write(&part, b"half").await.unwrap();
        discard_part(&part).await;
        assert!(!part.exists(), "分片要被丢掉");
        assert!(!target.exists(), "绝不能留下冒充已完成的半截文件");

        // 成功：分片提升为正式文件，内容一字不差
        tokio::fs::write(&part, b"whole-content").await.unwrap();
        commit_part(&part, &target).await.unwrap();
        assert!(!part.exists(), "提升后不该再有分片残留");
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"whole-content");

        // 再次丢弃不存在的路径不应报错
        discard_part(&part).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn log_writer_redacts_across_chunks_and_flushes_tail() {
        let dir = std::env::temp_dir().join(format!("zterm-log-writer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时日志目录失败");
        let path = dir.join("session.log");
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .expect("打开临时日志失败");
        let sink = SessionLogSink {
            file,
            redactor: crate::redact::LogRedactor::default(),
            redact: true,
        };

        let (tx, rx) = tokio::sync::mpsc::channel::<LogCommand>(LOG_CHANNEL_CAPACITY);
        let writer = tokio::spawn(SshSession::run_log_writer(sink, rx));
        // 私钥块刻意跨两条消息切开：脱敏状态必须跟着 sink 走，而不是每块独立判定
        for chunk in [
            "first-line\n",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nbG9yZWQtaXAtc2VjcmV0\n",
            "bW9yZS1zZWNyZXQtYnl0ZXM-----END OPENSSH PRIVATE KEY-----\nlast-line\n",
            // 没有换行的尾巴：只有 Close 时冲刷才会落盘
            "tail-without-newline",
        ] {
            tx.send(LogCommand::Chunk(chunk.to_string()))
                .await
                .expect("日志通道应可写入");
        }
        tx.send(LogCommand::Close).await.expect("关闭日志通道失败");
        drop(tx);
        writer.await.expect("日志 task 应正常退出");

        let content = std::fs::read_to_string(&path).expect("读取日志失败");
        assert!(
            !content.contains("bG9yZWQtaXAtc2VjcmV0")
                && !content.contains("bW9yZS1zZWNyZXQtYnl0ZXM"),
            "私钥正文不得落盘: {:?}",
            content
        );
        let before = content.find("first-line").expect("首块未落盘");
        let after = content.find("last-line").expect("尾块未落盘");
        let tail = content
            .find("tail-without-newline")
            .expect("未换行的尾部未被冲刷");
        assert!(
            before < after && after < tail,
            "日志顺序被打乱: {:?}",
            content
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
