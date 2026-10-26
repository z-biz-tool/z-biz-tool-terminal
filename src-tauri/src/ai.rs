//! terminal 的 AI 接入 —— 请求收口到 Rust，apiKey 不再回传 WebView。
//!
//! ## 为什么要改
//!
//! 原架构：`get_ai_config` 把解密后的明文 key 交给前端，前端 `fetch` 直连
//! 各家 API、在前端逐行切 SSE。key 因此**长期驻留 webview 内存**（React
//! state / 表单 formData），任何 XSS、错误面板渲染、devtools 展开都能拿到。
//!
//! 新架构：key 只在「设置表单录入」这一次经过 IPC（用户本来就在输入框里
//! 敲它，躲不掉），此后存 Rust 加密区；**AI 请求全部由 Rust 发出**，前端
//! 只拿流式 token 事件。设置回显用 `hasApiKey` 布尔，不再回传明文。
//!
//! ## provider 映射
//!
//! terminal 的 provider 是显式枚举（openai/custom/minimax/claude/gemini/
//! ollama），比按 URL 猜协议可靠 —— 直接映射到 cap-llm 的 ProviderKind：
//! openai/custom/minimax 三家都是 OpenAI 兼容协议（历史上 minimax 漏分支
//! 导致不带鉴权头，教训在前端 aiClient.ts 里），claude → Anthropic。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cap_llm::{Delta, LlmConfig, Message, ProviderKind};
use serde::Deserialize;

use crate::config::{load_config, AiConfig};

/// 聊天超时。解释命令 / 分析报错的回答可能较长，60s 不够。
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);

/// 流式取消旗标。terminal 同一时刻只有一条流（弹窗内），全局布尔足够；
/// `ai_chat_stream` 开跑时清零，`ai_stream_abort` 置位，cap-llm 在每个
/// 网络 chunk 边界检查。
static STREAM_ABORT: AtomicBool = AtomicBool::new(false);

fn aborted() -> bool {
    STREAM_ABORT.load(Ordering::Relaxed)
}

/// 前端 provider 名 → cap-llm 协议族。
pub fn provider_kind(provider: &str) -> ProviderKind {
    match provider {
        "claude" => ProviderKind::Anthropic,
        "gemini" => ProviderKind::Gemini,
        "ollama" => ProviderKind::Ollama,
        // openai / custom / minimax 都是 OpenAI 兼容协议（Bearer + /chat/completions）
        _ => ProviderKind::Custom,
    }
}

/// 生成参数的临时覆盖（单次请求的 temperature / max_tokens）。
/// 长期值存在 AiConfig，这里只覆盖本次。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenOverrides {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// 从全局配置 + 本次覆盖拼 cap-llm 配置。key 从 Rust 加密区解出，前端不经手。
pub fn to_cap(overrides: &GenOverrides) -> Result<LlmConfig, String> {
    let ai = load_config()
        .ai
        .ok_or_else(|| "AI 未配置：请先在 AI 设置里填写接口信息".to_string())?;
    build_cap(&ai, overrides)
}

fn build_cap(ai: &AiConfig, overrides: &GenOverrides) -> Result<LlmConfig, String> {
    let key = ai
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "AI 未配置：请先在 AI 设置里填写 API Key".to_string())?;
    let base_url = ai
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI 未配置：请先在 AI 设置里填写 Base URL".to_string())?;
    let model = ai
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI 未配置：请先在 AI 设置里填写模型名".to_string())?;

    // temperature/maxTokens 的默认值由前端表单兜底（AiConfig 里是 Option），
    // 覆盖优先于配置，与原前端语义一致
    let temperature = overrides.temperature.or(ai.temperature).unwrap_or(0.7);
    let max_tokens = overrides.max_tokens.or(ai.max_tokens).unwrap_or(2048);

    Ok(LlmConfig {
        kind: provider_kind(&ai.provider),
        base_url: base_url.to_string(),
        api_key: key.to_string(),
        model: model.to_string(),
        timeout: CHAT_TIMEOUT,
        temperature: Some(temperature as f32),
        max_tokens: Some(max_tokens),
    })
}

/// 前端消息 → cap-llm 消息。未知 role 不许静默当 user。
fn to_message(m: &ChatMessage) -> Result<Message, String> {
    match m.role.as_str() {
        "system" => Ok(Message::system(&m.content)),
        "user" => Ok(Message::user(&m.content)),
        "assistant" => Ok(Message::assistant(&m.content)),
        other => Err(format!("未知的消息角色: {other}")),
    }
}

/// 前端传来的消息体（role/content 两字段）
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn to_messages(messages: &[ChatMessage]) -> Result<Vec<Message>, String> {
    if messages.is_empty() {
        return Err("消息列表为空".to_string());
    }
    messages.iter().map(to_message).collect()
}

/// 非流式聊天。整条链路不出 Rust —— key 从加密区解出、请求后即弃。
pub async fn chat(messages: &[ChatMessage], overrides: &GenOverrides) -> Result<String, String> {
    let cap = to_cap(overrides)?;
    let msgs = to_messages(messages)?;
    let reply = cap_llm::chat(&cap, &msgs).await.map_err(|e| e.to_string())?;
    Ok(reply.content)
}

/// 流式聊天。每个 token 经 `app.emit("ai-stream://token", t)` 推给前端，
/// 完整结果作为命令返回值（前端 `invoke` 的 promise resolve 拿全文）。
/// 用户点「停止」：前端调 `ai_stream_abort`，流停在下一个 chunk 边界，
/// 返回已生成的部分。
pub async fn chat_stream(
    app: &tauri::AppHandle,
    messages: &[ChatMessage],
    overrides: &GenOverrides,
) -> Result<String, String> {
    let cap = to_cap(overrides)?;
    let msgs = to_messages(messages)?;
    STREAM_ABORT.store(false, Ordering::Relaxed);

    let handle = app.clone();
    let reply = cap_llm::chat_stream_if(&cap, &msgs, aborted, move |delta| {
        if let Delta::Text(t) = delta {
            let _ = tauri::Emitter::emit(&handle, "ai-stream://token", t);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(reply.content)
}

/// 用户点「停止生成」。
#[tauri::command]
pub async fn ai_stream_abort() -> Result<(), String> {
    STREAM_ABORT.store(true, Ordering::Relaxed);
    Ok(())
}

/// AI 聊天（非流式）
#[tauri::command]
pub async fn ai_chat(
    messages: Vec<ChatMessage>,
    overrides: Option<GenOverrides>,
) -> Result<String, String> {
    chat(&messages, &overrides.unwrap_or_default()).await
}

/// AI 聊天（流式，token 走 `ai-stream://token` 事件）
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    overrides: Option<GenOverrides>,
) -> Result<String, String> {
    chat_stream(&app, &messages, &overrides.unwrap_or_default()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ai(provider: &str, base: &str, key: &str) -> AiConfig {
        AiConfig {
            provider: provider.to_string(),
            api_key: Some(key.to_string()),
            base_url: Some(base.to_string()),
            model: Some("test-model".to_string()),
            temperature: Some(0.5),
            max_tokens: Some(1024),
        }
    }

    #[test]
    fn provider_mapping_is_explicit() {
        // minimax 是 OpenAI 兼容 —— 前端就漏过这个分支，这里钉死
        assert!(matches!(provider_kind("minimax"), ProviderKind::Custom));
        assert!(matches!(provider_kind("openai"), ProviderKind::Custom));
        assert!(matches!(provider_kind("custom"), ProviderKind::Custom));
        assert!(matches!(provider_kind("claude"), ProviderKind::Anthropic));
        assert!(matches!(provider_kind("gemini"), ProviderKind::Gemini));
        assert!(matches!(provider_kind("ollama"), ProviderKind::Ollama));
        // 未知 provider 不许猜：落到 OpenAI 兼容并保留原字符串由 cap-llm 报错
        assert!(matches!(provider_kind("wat"), ProviderKind::Custom));
    }

    #[test]
    fn missing_key_fails_before_any_network() {
        let err = build_cap(&ai("openai", "https://api.example.com", "  "), &GenOverrides::default())
            .unwrap_err();
        assert!(err.contains("API Key"));
        let mut no_key = ai("openai", "https://api.example.com", "k");
        no_key.api_key = None;
        assert!(build_cap(&no_key, &GenOverrides::default()).is_err());
    }

    #[test]
    fn missing_base_url_and_model_are_reported_separately() {
        let e1 = build_cap(&ai("openai", " ", "k"), &GenOverrides::default()).unwrap_err();
        assert!(e1.contains("Base URL"));
        let e2 = build_cap(&ai("openai", "https://x.com", "k"), &GenOverrides::default())
            .map(|c| c.model)
            .err();
        assert!(e2.is_none(), "model 已填，不该报错");
        let mut no_model = ai("openai", "https://x.com", "k");
        no_model.model = Some(" ".into());
        assert!(build_cap(&no_model, &GenOverrides::default())
            .unwrap_err()
            .contains("模型"));
    }

    #[test]
    fn overrides_win_over_config_defaults() {
        let cap = build_cap(
            &ai("openai", "https://x.com", "k"),
            &GenOverrides {
                temperature: Some(0.1),
                max_tokens: Some(64),
            },
        )
        .unwrap();
        assert_eq!(cap.temperature, Some(0.1));
        assert_eq!(cap.max_tokens, Some(64));
        // 无覆盖时用配置值
        let cap2 = build_cap(&ai("openai", "https://x.com", "k"), &GenOverrides::default()).unwrap();
        assert_eq!(cap2.temperature, Some(0.5));
        assert_eq!(cap2.max_tokens, Some(1024));
    }

    #[test]
    fn unknown_role_is_an_error_not_silently_user() {
        let bad = ChatMessage {
            role: "asistant".into(),
            content: "hi".into(),
        };
        assert!(to_message(&bad).is_err());
        assert!(to_messages(&[bad]).is_err());
    }

    #[test]
    fn empty_messages_rejected() {
        assert!(to_messages(&[]).is_err());
    }
}
