//! 统一 AI 配置的接入胶水（家族样板）。
//!
//! ## 这一层做什么
//!
//! 家族统一落点在 `cap-llm-config`：
//!
//! ```text
//! 配置（非敏感）：~/.z-biz-tool/llm/config.json
//! 密钥（敏感）：  OS 密钥库 service="z-biz-tool" / account="llm.apikey"
//! ```
//!
//! 本仓原来自己存 `~/.z-terminal/config.json` 的 `ai` 段，密钥用自建
//! AES-256-GCM 加密后落盘。现在改为读写统一落点 —— 于是：
//!
//! - 在 note 配好的 DeepSeek，terminal 直接能用；
//! - 密钥进 OS 密钥库，不再是「配置文件 + 同目录 master.key」这种
//!   只能防备份泄露的弱保护。
//!
//! ## 兼容期怎么办
//!
//! 老配置还在 `~/.z-terminal/config.json` 里。本仓在启动时调
//! [`migrate_legacy`]，把老配置（含解密后的密钥）搬进统一落点，
//! 然后**清掉**老配置里的密钥字段。搬一次即可，之后统一落点是唯一真源。
//!
//! ## 命令名对齐
//!
//! 统一为这五个名字（与 terminal 原有的一致，作为家族基准）：
//!
//! | 命令 | 作用 |
//! |---|---|
//! | `get_ai_config` | 读配置（**脱敏视图**：apiKey 恒空串，hasApiKey 表达有无） |
//! | `save_ai_config` | 写配置（apiKey 空串 = 继承已保存的密钥） |
//! | `list_llm_presets` | 供应商预设目录 |
//! | `list_llm_models` | 列模型 |
//! | `test_ai_config` | 连通性探测 |

use serde::{Deserialize, Serialize};

use cap_llm_config::{
    migrate_legacy_configs, shared_secret_store, LlmConfigFile, LlmSecret, StoreError,
};

/// 本仓对外的 AI 配置形状（脱敏视图）。
///
/// `api_key` 恒为空串 —— 明文密钥**不出 Rust**。前端设置表单显示
/// 「已保存」占位，留空表示保持不变，录入/修改时才随 `save_ai_config`
/// 过一次 IPC（用户本来就在输入框里敲它，这次传输躲不掉）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    /// 预设 id（cap-llm 的 preset id），空串表示自定义服务。
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// 恒为空串。
    pub api_key: String,
    /// 是否已保存密钥。
    pub has_api_key: bool,
}

/// 存储层错误 → 一句人话。
fn err_msg(e: StoreError) -> String {
    e.to_string()
}

/// 读统一配置（脱敏视图）。
pub fn read_shared_config() -> Result<AiConfigView, String> {
    let cfg = cap_llm_config::load_config().map_err(err_msg)?;
    let Some(cfg) = cfg else {
        return Ok(AiConfigView {
            provider: String::new(),
            base_url: String::new(),
            model: String::new(),
            temperature: None,
            max_tokens: None,
            api_key: String::new(),
            has_api_key: false,
        });
    };

    // 密钥在 OS 密钥库里，不在配置文件里 —— 「有没有」要问密钥库。
    let has_api_key = shared_secret_store()
        .get()
        .map_err(err_msg)?
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);

    Ok(AiConfigView {
        provider: if cfg.preset.is_empty() {
            cfg.provider.clone()
        } else {
            cfg.preset.clone()
        },
        base_url: cfg.base_url.clone(),
        model: cfg.model.clone(),
        temperature: cfg.temperature.map(|t| t as f64),
        max_tokens: cfg.max_tokens,
        api_key: String::new(),
        has_api_key,
    })
}

/// 读统一配置 + 明文密钥（**仅供后端发请求用**，绝不回传前端）。
pub fn read_shared_config_with_key() -> Result<(LlmConfigFile, String), String> {
    let cfg = cap_llm_config::load_config()
        .map_err(err_msg)?
        .ok_or_else(|| "尚未配置 AI 服务商".to_string())?;
    let key = shared_secret_store()
        .get()
        .map_err(err_msg)?
        .unwrap_or_default();
    Ok((cfg, key))
}

/// 写统一配置。
///
/// `api_key` 为空串 ⇒ **继承已保存的密钥**（编辑其它字段时表单里没有明文
/// key，留空是常态而不是「清除」）。
pub fn write_shared_config(
    provider: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
) -> Result<(), String> {
    let store = shared_secret_store();

    // 先落配置（不含密钥），再落密钥 —— 配置落盘失败时不会有「有配置没密钥」的半截状态。
    let file = LlmConfigFile {
        preset: provider.to_string(),
        provider: provider.to_string(),
        base_url: base_url.to_string(),
        model: model.to_string(),
        temperature: temperature.map(|t| t as f32),
        max_tokens,
        timeout_ms: None,
        updated_at_ms: now_ms(),
    };
    cap_llm_config::save_config(&file).map_err(err_msg)?;

    if !api_key.trim().is_empty() {
        store.set(api_key).map_err(err_msg)?;
    }
    Ok(())
}

/// 迁移一次历史配置。
///
/// 幂等：统一落点已有配置时直接返回，什么都不做。
///
/// ## 两段式
///
/// ① **通用迁移器**先扫明文的历史落点（file / db / kb 那几家明文写盘的）。
/// ② **本仓自有迁移**再处理 `~/.z-terminal/config.json` —— 它的密钥是
///    自建 AES-256-GCM 密文，通用迁移器解不开，得由本仓自己解密。
///
/// 两段都跑，且都幂等：先到先得，后来者不覆盖。
pub fn migrate_legacy() -> Result<Option<String>, String> {
    // ① 通用（明文历史落点）
    let mut migrated_from: Option<String> = None;
    let report = migrate_legacy_configs().map_err(err_msg)?;
    if report.migrated {
        migrated_from = report.from;
    }

    // ② 本仓自有（加密的老配置）
    if migrated_from.is_none() && cap_llm_config::load_config().map_err(err_msg)?.is_none() {
        if let Some(from) = migrate_own_config()? {
            migrated_from = Some(from);
        }
    }

    Ok(migrated_from)
}

/// 把本仓 `~/.z-terminal/config.json` 的 `ai` 段搬进统一落点。
///
/// 本仓老配置的密钥是自建 AES-256-GCM 密文（`enc:v1:` 前缀），
/// 通用迁移器解不开 —— 必须由本仓自己用既有的解密路径解开再搬。
///
/// 返回 `Some(来源说明)` 表示确实搬了。
fn migrate_own_config() -> Result<Option<String>, String> {
    let app = crate::config::load_config();
    let Some(ai) = app.ai.clone() else {
        return Ok(None);
    };
    // 什么都没配的老配置不必搬。
    let has_something = !ai.model.as_deref().map(str::trim).unwrap_or("").is_empty()
        || !ai
            .base_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        || !ai
            .api_key
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty();
    if !has_something {
        return Ok(None);
    }

    write_shared_config(
        &ai.provider,
        ai.base_url.as_deref().unwrap_or(""),
        ai.model.as_deref().unwrap_or(""),
        ai.api_key.as_deref().unwrap_or(""),
        ai.temperature,
        ai.max_tokens,
    )?;

    // 搬完了，把老配置里的密钥抹掉 —— 老文件里不该再留一份能直接用的明文/密文。
    let mut app = app;
    if let Some(a) = app.ai.as_mut() {
        a.api_key = None;
    }
    // 老配置段落整体移除：统一落点才是唯一真源，留着两份会让人以为改哪份都算。
    app.ai = None;
    let _ = crate::config::save_config(&app);

    Ok(Some("terminal".to_string()))
}

/// 当前时刻（毫秒时间戳）。写失败不影响主流程 —— 时间戳只是诊断辅助。
fn now_ms() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}
