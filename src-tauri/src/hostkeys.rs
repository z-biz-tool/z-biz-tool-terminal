//! SSH 主机密钥信任管理（known_hosts）。
//!
//! 替代原先「`check_server_key` 恒返回 `Ok(true)`」的实现，提供三态判定：
//! 已信任 / 首次出现（TOFU，需用户确认）/ 密钥变更（判定为中间人风险，直接拒绝）。
//! 文件位于 `~/.z-terminal/known_hosts`，格式与 OpenSSH 的
//! `[host]:port <algo> <base64>` 行兼容。

use russh::keys::key::PublicKey;
use russh::keys::PublicKeyBase64;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

use crate::config::get_config_dir;

/// 一条主机密钥信任记录
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyEntry {
    /// 形如 `example.com` 或 `[10.0.0.1]:2222`
    pub host: String,
    /// 算法名，如 `ssh-ed25519`
    pub algo: String,
    /// 公钥 blob 的 base64（无填充）
    pub blob_b64: String,
}

/// 主机密钥校验策略，由连接入口构造后注入 russh Handler。
#[derive(Debug, Clone)]
pub struct HostKeyPolicy {
    /// known_hosts 中使用的主机标识，形如 `example.com` 或 `[10.0.0.1]:2222`
    pub host_spec: String,
    /// 严格模式：首次出现的主机密钥必须经用户确认。关闭后退化为自动接受（仍可回退）。
    pub strict: bool,
    /// 用于向界面发起确认请求；为 None 时首次出现的密钥一律拒绝
    pub app: Option<tauri::AppHandle>,
}

impl HostKeyPolicy {
    pub fn new(host: &str, port: u16, strict: bool, app: Option<tauri::AppHandle>) -> Self {
        Self {
            host_spec: host_spec(host, port),
            strict,
            app,
        }
    }
}

/// 主机密钥校验结论
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// known_hosts 中已有完全匹配的记录
    Trusted,
    /// 首次见到该主机密钥，需要用户确认后才写入
    Unknown { fingerprint: String },
    /// 与已记录密钥不一致，按中间人攻击处理
    Changed {
        expected_fingerprint: String,
        actual_fingerprint: String,
    },
}

/// known_hosts 文件路径
pub fn known_hosts_path() -> PathBuf {
    get_config_dir().join("known_hosts")
}

/// 构造用于 known_hosts 的主机标识。22 端口沿用 OpenSSH 的裸主机名写法。
pub fn host_spec(host: &str, port: u16) -> String {
    let h = host.trim();
    if port == 22 {
        h.to_string()
    } else {
        format!("[{}]:{}", h, port)
    }
}

/// SHA256 指纹，与 OpenSSH 展示一致
pub fn fingerprint(key: &PublicKey) -> String {
    format!("SHA256:{}", key.fingerprint())
}

fn entry_of(key: &PublicKey) -> HostKeyEntry {
    HostKeyEntry {
        host: String::new(),
        algo: key.name().to_string(),
        blob_b64: key.public_key_base64(),
    }
}

/// 解析单行 known_hosts。`host` 允许是逗号分隔的多个主机标识，逐个展开。
pub fn parse_line(line: &str) -> Vec<HostKeyEntry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return vec![];
    }
    let mut it = line.split_whitespace();
    let Some(hosts) = it.next() else {
        return vec![];
    };
    let Some(algo) = it.next() else {
        return vec![];
    };
    let Some(blob) = it.next() else {
        return vec![];
    };
    hosts
        .split(',')
        .filter(|h| !h.is_empty())
        .map(|h| HostKeyEntry {
            host: h.to_string(),
            algo: algo.to_string(),
            blob_b64: blob.to_string(),
        })
        .collect()
}

/// 读取全部信任记录
pub fn load() -> Vec<HostKeyEntry> {
    read_entries_at(&known_hosts_path())
}

pub fn read_entries_at(path: &PathBuf) -> Vec<HostKeyEntry> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return vec![];
    };
    content
        .lines()
        .flat_map(parse_line)
        .filter(|e| !e.host.starts_with('@'))
        .collect()
}

/// 写入 / 更新一条信任记录（同 host 的旧记录被替换）。
pub fn record(entry: &HostKeyEntry) -> Result<(), String> {
    record_at(&known_hosts_path(), entry)
}

pub fn record_at(path: &PathBuf, entry: &HostKeyEntry) -> Result<(), String> {
    let mut entries = read_entries_at(path);
    entries.retain(|e| e.host != entry.host);
    entries.push(entry.clone());

    let mut buf = String::new();
    for e in &entries {
        buf.push_str(&format!("{} {} {}\n", e.host, e.algo, e.blob_b64));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, buf).map_err(|e| e.to_string())?;
    restrict_permissions(&tmp);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除某主机的信任记录，返回删除条数
pub fn remove(host_spec: &str) -> usize {
    remove_at(&known_hosts_path(), host_spec)
}

pub fn remove_at(path: &PathBuf, host_spec: &str) -> usize {
    let entries = read_entries_at(path);
    let kept: Vec<_> = entries
        .iter()
        .filter(|e| e.host != host_spec)
        .cloned()
        .collect();
    let removed = entries.len() - kept.len();
    if removed > 0 {
        let mut buf = String::new();
        for e in &kept {
            buf.push_str(&format!("{} {} {}\n", e.host, e.algo, e.blob_b64));
        }
        let _ = std::fs::write(path, buf);
    }
    removed
}

/// 校验主机密钥。未知主机与密钥变更都用指纹区分，调用方据此决定是否放行。
pub fn verify(entries: &[HostKeyEntry], host_spec: &str, key: &PublicKey) -> Verdict {
    let current = entry_of(key);
    let matched: Vec<&HostKeyEntry> = entries.iter().filter(|e| e.host == host_spec).collect();
    if matched.is_empty() {
        return Verdict::Unknown {
            fingerprint: fingerprint(key),
        };
    }
    if matched
        .iter()
        .any(|e| e.algo == current.algo && e.blob_b64 == current.blob_b64)
    {
        return Verdict::Trusted;
    }
    // 同算法不一致是典型的密钥被替换；仅算法不同则按未知处理（服务端升级了 host key 类型）。
    if let Some(same_algo) = matched.iter().find(|e| e.algo == current.algo) {
        return Verdict::Changed {
            expected_fingerprint: format!("SHA256:{}", blob_fingerprint(&same_algo.blob_b64)),
            actual_fingerprint: fingerprint(key),
        };
    }
    Verdict::Unknown {
        fingerprint: fingerprint(key),
    }
}

/// 对已存的 base64 blob 求指纹，避免依赖反序列化实现
fn blob_fingerprint(blob_b64: &str) -> String {
    use sha2::Digest;
    let Ok(bytes) = data_encoding::BASE64_NOPAD.decode(blob_b64.as_bytes()) else {
        return "<invalid>".to_string();
    };
    let digest = sha2::Sha256::digest(&bytes);
    data_encoding::BASE64_NOPAD.encode(&digest)
}

/// 记录一条新的信任（首次确认后调用）
pub fn trust(host_spec: &str, key: &PublicKey) -> Result<(), String> {
    let mut entry = entry_of(key);
    entry.host = host_spec.to_string();
    record(&entry)
}

// ---------------------------------------------------------------------------
// 首连确认：后端 <-> 前端的请求/应答通道
// ---------------------------------------------------------------------------

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一次待确认请求，返回接收端（由 `check_server_key` 等待）
pub fn register_request(request_id: &str) -> oneshot::Receiver<bool> {
    let (tx, rx) = oneshot::channel();
    if let Ok(mut map) = pending().lock() {
        map.insert(request_id.to_string(), tx);
    }
    rx
}

/// 前端应答。返回 false 表示请求不存在或已被处理（按不放行处理）。
pub fn resolve_request(request_id: &str, trusted: bool) -> bool {
    let Ok(mut map) = pending().lock() else {
        return false;
    };
    match map.remove(request_id) {
        Some(tx) => tx.send(trusted).is_ok(),
        None => false,
    }
}

/// 应用退出 / 超时后清理，避免泄漏 sender
pub fn drop_request(request_id: &str) {
    if let Ok(mut map) = pending().lock() {
        map.remove(request_id);
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zterm-hostkeys-{}", name));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("known_hosts")
    }

    fn entry(host: &str, algo: &str, blob: &str) -> HostKeyEntry {
        HostKeyEntry {
            host: host.into(),
            algo: algo.into(),
            blob_b64: blob.into(),
        }
    }

    #[test]
    fn host_spec_omits_default_port() {
        assert_eq!(host_spec("example.com", 22), "example.com");
        assert_eq!(host_spec("example.com", 2222), "[example.com]:2222");
        assert_eq!(host_spec(" 10.0.0.1 ", 22), "10.0.0.1");
    }

    #[test]
    fn parses_multi_host_and_marker_lines() {
        let entries = parse_line("a.example.com,b.example.com ssh-ed25519 AAAAkey");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host, "a.example.com");
        assert_eq!(entries[1].algo, "ssh-ed25519");
        assert_eq!(entries[1].blob_b64, "AAAAkey");
        assert!(parse_line("# comment").is_empty());
        assert!(parse_line("").is_empty());
        assert!(parse_line("only-host").is_empty());
    }

    #[test]
    fn unknown_host_requires_confirmation() {
        let entries: Vec<HostKeyEntry> = vec![];
        let key = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let public = key.clone_public_key().unwrap();
        match verify(&entries, "example.com", &public) {
            Verdict::Unknown { fingerprint } => assert!(fingerprint.starts_with("SHA256:")),
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn recorded_host_is_trusted() {
        let key = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let public = key.clone_public_key().unwrap();
        let e = HostKeyEntry {
            host: "[example.com]:2222".into(),
            algo: public.name().to_string(),
            blob_b64: public.public_key_base64(),
        };
        assert_eq!(
            verify(&[e.clone()], "[example.com]:2222", &public),
            Verdict::Trusted
        );
        assert_eq!(
            verify(&[e], "example.com", &public),
            Verdict::Unknown {
                fingerprint: fingerprint(&public)
            },
            "端口不同即不同主机标识，不应复用信任"
        );
    }

    #[test]
    fn changed_key_is_detected() {
        let first = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let second = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let public = first.clone_public_key().unwrap();
        let recorded = vec![entry(
            "example.com",
            public.name(),
            &public.public_key_base64(),
        )];
        match verify(
            &recorded,
            "example.com",
            &second.clone_public_key().unwrap(),
        ) {
            Verdict::Changed { .. } => {}
            other => panic!("expected Changed, got {:?}", other),
        }
    }

    #[test]
    fn fingerprint_differs_when_host_key_rotates() {
        let first = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let second = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let recorded = vec![entry(
            "example.com",
            first.clone_public_key().unwrap().name(),
            &first.clone_public_key().unwrap().public_key_base64(),
        )];
        match verify(
            &recorded,
            "example.com",
            &second.clone_public_key().unwrap(),
        ) {
            Verdict::Changed {
                expected_fingerprint,
                actual_fingerprint,
            } => {
                assert_ne!(expected_fingerprint, actual_fingerprint);
                assert!(expected_fingerprint.starts_with("SHA256:"));
            }
            other => panic!("expected Changed, got {:?}", other),
        }
    }

    #[test]
    fn record_then_remove_roundtrip() {
        let path = temp_path("roundtrip");
        let key = russh::keys::key::KeyPair::generate_ed25519().unwrap();
        let public = key.clone_public_key().unwrap();
        let e = entry("h1", public.name(), &public.public_key_base64());
        record_at(&path, &e).unwrap();
        assert_eq!(read_entries_at(&path).len(), 1);

        // 同 host 再写一次应替换而非追加
        let e2 = entry("h1", public.name(), "ANOTHERBLOB");
        record_at(&path, &e2).unwrap();
        let all = read_entries_at(&path);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].blob_b64, "ANOTHERBLOB");

        assert_eq!(remove_at(&path, "h1"), 1);
        assert!(read_entries_at(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolve_request_only_works_once() {
        let mut rx = register_request("req-1");
        assert!(resolve_request("req-1", true));
        assert!(rx.try_recv().unwrap());
        assert!(!resolve_request("req-1", false), "同一请求不应被重复应答");
        register_request("req-2");
        drop_request("req-2");
        assert!(!resolve_request("req-2", true));
    }
}
