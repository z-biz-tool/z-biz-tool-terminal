//! 凭证静态加密(at-rest)：主密钥 + AES-256-GCM。
//!
//! 威胁模型(对应 `doc/优化方案/04_数据安全与可靠性.md` 4.5 / P-4)：
//! - **防**：明文密码/私钥/API Key 出现在 config.json、其备份、导出文件、
//!   以及被这些文件二次流转(同步盘、工单附件、贴给同事)时泄漏。
//! - **不防**：已经能以当前用户身份读取 `~/.z-terminal/` 的攻击者 ——
//!   他同样能读到 `master.key`。要挡住这一层需要系统钥匙串 + 沙箱，
//!   本项目是未签名的第三方 Tauri 应用, 不引入 Keychain 权限弹窗。
//!
//! 存储格式：`enc:v1:<base64(nonce(12) || ciphertext || tag(16))>`。
//! 未带前缀的值按明文处理, 以保证旧配置仍可读取(§5.7 兼容一版)。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use std::path::PathBuf;

/// 密文标记前缀, 前端/导出逻辑会用它判断字段是否已加密
pub const ENC_PREFIX: &str = "enc:v1:";
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// 主密钥路径(与 config.json 同目录)
pub fn master_key_path() -> PathBuf {
    crate::config::get_config_dir().join("master.key")
}

fn from_key_bytes(bytes: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let key: [u8; KEY_LEN] = bytes
        .try_into()
        .map_err(|_| format!("主密钥长度应为 {} 字节, 实际 {}", KEY_LEN, bytes.len()))?;
    Ok(key)
}

/// 读取主密钥; 首次使用时随机生成并以 0600 落盘。
pub fn load_or_create_master_key() -> Result<[u8; KEY_LEN], String> {
    let path = master_key_path();
    match std::fs::read(&path) {
        Ok(bytes) => return from_key_bytes(&bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("读取主密钥失败: {}", e)),
    }

    let mut key = [0u8; KEY_LEN];
    getrandom::getrandom(&mut key).map_err(|e| format!("生成主密钥失败: {}", e))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    std::fs::write(&path, key).map_err(|e| format!("写入主密钥失败: {}", e))?;
    crate::config::restrict_private(&path);
    Ok(key)
}

pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

/// 主密钥进程内缓存: `load_config()` 会在热路径被调用, 不应每次读盘
static CACHED_KEY: std::sync::OnceLock<[u8; KEY_LEN]> = std::sync::OnceLock::new();

fn cached_master_key() -> Result<[u8; KEY_LEN], String> {
    if let Some(key) = CACHED_KEY.get() {
        return Ok(*key);
    }
    let key = load_or_create_master_key()?;
    let _ = CACHED_KEY.set(key);
    Ok(key)
}

/// 用指定密钥加密(测试可注入密钥, 避免碰真实文件)
pub fn encrypt_with(key: &[u8; KEY_LEN], plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("初始化加密器失败: {}", e))?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| format!("生成随机数失败: {}", e))?;

    let body = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .map_err(|e| format!("加密失败: {}", e))?;

    let mut packed = Vec::with_capacity(NONCE_LEN + body.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&body);
    Ok(format!(
        "{}{}",
        ENC_PREFIX,
        data_encoding::BASE64.encode(&packed)
    ))
}

/// 解密; 不带前缀的值原样返回(旧明文配置兼容读取)
pub fn decrypt_with(key: &[u8; KEY_LEN], value: &str) -> Result<String, String> {
    if !is_encrypted(value) {
        return Ok(value.to_string());
    }
    let raw = data_encoding::BASE64
        .decode(value[ENC_PREFIX.len()..].as_bytes())
        .map_err(|e| format!("密文 base64 解析失败: {}", e))?;
    if raw.len() < NONCE_LEN {
        return Err("密文长度不足, 已损坏".into());
    }
    let (nonce, body) = raw.split_at(NONCE_LEN);

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("初始化解密器失败: {}", e))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), body)
        .map_err(|_| "解密失败(主密钥可能已丢失或与密文不匹配)".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("解密结果非 UTF-8: {}", e))
}

/// 进程内缓存版主密钥, 供一次加解密整批凭证时复用
pub fn master_key() -> Result<[u8; KEY_LEN], String> {
    cached_master_key()
}

/// 是否需要封存。用"能否用本机主密钥成功解密"判定, 而不是只看前缀 ——
/// 否则用户真实密码恰好以 `enc:v1:` 开头时会被原样明文落盘。
pub fn needs_sealing_with(key: &[u8; KEY_LEN], value: &str) -> bool {
    !is_encrypted(value) || decrypt_with(key, value).is_err()
}

/// 封存可选字段: 空值/缺失/本机可解的密文原样保留, 只加密明文
pub fn seal_opt(key: &[u8; KEY_LEN], value: &Option<String>) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() && needs_sealing_with(key, v) => encrypt_with(key, v).map(Some),
        other => Ok(other.clone()),
    }
}

/// 还原可选字段; 解密失败时返回 `None`(调用方按"未配置凭证"处理并提示重填)
pub fn open_opt(key: &[u8; KEY_LEN], value: &Option<String>) -> Option<String> {
    match value {
        Some(v) if is_encrypted(v) => match decrypt_with(key, v) {
            Ok(plain) => Some(plain),
            Err(e) => {
                eprintln!("凭证解密失败, 已按未配置处理: {}。请在设置里重新输入密码/私钥", e);
                None
            }
        },
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; KEY_LEN] {
        [7u8; KEY_LEN]
    }

    #[test]
    fn roundtrip_hides_plaintext() {
        let key = test_key();
        let sealed = encrypt_with(&key, "p@ssw0rd-123").expect("加密应成功");
        assert!(is_encrypted(&sealed));
        assert!(!sealed.contains("p@ssw0rd"));
        assert_eq!(decrypt_with(&key, &sealed).unwrap(), "p@ssw0rd-123");
    }

    #[test]
    fn legacy_plaintext_passes_through() {
        let key = test_key();
        assert!(!is_encrypted("plaintext-password"));
        assert_eq!(
            decrypt_with(&key, "plaintext-password").unwrap(),
            "plaintext-password"
        );
    }

    #[test]
    fn same_input_yields_different_ciphertext() {
        let key = test_key();
        let a = encrypt_with(&key, "secret").unwrap();
        let b = encrypt_with(&key, "secret").unwrap();
        assert_ne!(a, b, "nonce 应随机, 相同明文不应产生相同密文");
        assert_eq!(decrypt_with(&key, &a).unwrap(), "secret");
        assert_eq!(decrypt_with(&key, &b).unwrap(), "secret");
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = test_key();
        let sealed = encrypt_with(&key, "secret").unwrap();
        let mut bytes = data_encoding::BASE64
            .decode(sealed[ENC_PREFIX.len()..].as_bytes())
            .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        let tampered = format!("{}{}", ENC_PREFIX, data_encoding::BASE64.encode(&bytes));
        assert!(decrypt_with(&key, &tampered).is_err(), "GCM 认证标签应拦下篡改");
    }

    #[test]
    fn wrong_key_fails_instead_of_returning_garbage() {
        let sealed = encrypt_with(&test_key(), "secret").unwrap();
        let mut other = [0u8; KEY_LEN];
        other[0] = 9;
        assert!(decrypt_with(&other, &sealed).is_err());
    }

    #[test]
    fn empty_and_missing_values_are_not_sealed() {
        let key = test_key();
        assert_eq!(seal_opt(&key, &None).unwrap(), None);
        assert_eq!(
            seal_opt(&key, &Some(String::new())).unwrap(),
            Some(String::new())
        );
    }

    #[test]
    fn already_sealed_value_is_not_double_encrypted() {
        let key = test_key();
        let sealed = encrypt_with(&key, "secret").unwrap();
        let again = seal_opt(&key, &Some(sealed.clone())).unwrap();
        assert_eq!(again.as_deref(), Some(sealed.as_str()));
    }

    #[test]
    fn password_that_looks_like_ciphertext_is_still_sealed() {
        let key = test_key();
        // 只看前缀会把这个真实密码当密文原样明文落盘
        let tricky = format!("{}my-real-password", ENC_PREFIX);
        assert!(needs_sealing_with(&key, &tricky));
        let sealed = seal_opt(&key, &Some(tricky.clone())).unwrap().unwrap();
        assert_ne!(sealed, tricky);
        assert_eq!(open_opt(&key, &Some(sealed)).unwrap(), tricky);
    }

    #[test]
    fn truncated_payload_is_rejected() {
        let key = test_key();
        let short = format!("{}{}", ENC_PREFIX, data_encoding::BASE64.encode(&[1u8; 4]));
        assert!(decrypt_with(&key, &short).is_err());
    }
}
