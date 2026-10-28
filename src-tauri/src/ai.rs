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

use cap_llm::{Delta, ErrorKind, LlmConfig, LlmError, Message, ProviderKind};
use serde::{Deserialize, Serialize};

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
///
/// ⚠️ 必须同时认得两种写法：历史值 `claude`，以及预设 id `anthropic`
/// （`cap-llm::presets` 里 Anthropic 的稳定 id 是 `anthropic`，前端下拉
/// 直接把预设 id 写回 provider）。只认 `claude` 的话，用户从下拉里选
/// 「Anthropic」后请求会走 OpenAI 兼容协议打到 api.anthropic.com —— 全 4xx。
pub fn provider_kind(provider: &str) -> ProviderKind {
    match provider {
        "claude" | "anthropic" => ProviderKind::Anthropic,
        "gemini" => ProviderKind::Gemini,
        "ollama" => ProviderKind::Ollama,
        // openai / custom / minimax / deepseek / qwen … 都是 OpenAI 兼容协议（Bearer + /chat/completions）
        _ => ProviderKind::Custom,
    }
}

/// 前端 provider 名 → 供应商预设 id（可选）。
///
/// 命中预设时，`base_url` 留空也能自动填上该厂商的服务地址 ——
/// 用户在设置里选了「DeepSeek」就不必手抄 `https://api.deepseek.com/v1`，
/// 抄错一个字符就是 404，而报错只说「404」。
///
/// ⚠️ 绑定条件是**协议族兼容**，不是「完全相等」。
/// 本仓的 [`provider_kind`] 把 openai / minimax 都归成 `Custom`
/// （协议上确实与 OpenAI 兼容族毫无差别），而预设里 openai / minimax
/// 有各自的身份。若要求 kind 完全相等，这两个预设就永远绑不上。
/// 真正的红线是**不能跨协议族**（Anthropic / Gemini / Ollama 互不通用）。
pub fn preset_id(provider: &str) -> Option<&'static str> {
    let kind = provider_kind(provider);
    cap_llm::preset::find_by_name(provider)
        .filter(|p| same_protocol_family(p.kind, kind))
        .map(|p| p.id)
}

/// 两个 provider 身份是否走同一套报文。
///
/// `Custom` 与 `OpenAi` / `MiniMax` 同族 —— 它们都是 OpenAI 兼容协议
/// （Bearer + `/chat/completions`），只是默认地址与身份标签不同。
fn same_protocol_family(a: ProviderKind, b: ProviderKind) -> bool {
    use cap_llm::ProviderKind as K;
    let fam = |k: K| match k {
        K::OpenAi | K::MiniMax | K::Custom => 0,
        K::Anthropic => 1,
        K::Gemini => 2,
        K::Ollama => 3,
    };
    fam(a) == fam(b)
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
    // 先认预设 —— 选了「DeepSeek」这类已知厂商时，地址可以不填，
    // 由 cap-llm 用预设里的服务地址兜底（用户手抄地址容易抄错，
    // 抄错一个字符就是 404，而报错只说「404」）。
    let preset = preset_id(&ai.provider);
    let base_url = ai
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if base_url.is_none() && preset.is_none() {
        return Err("AI 未配置：请先在 AI 设置里填写 Base URL".to_string());
    }
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
        base_url: base_url.unwrap_or_default().to_string(),
        api_key: key.to_string(),
        model: model.to_string(),
        timeout: CHAT_TIMEOUT,
        temperature: Some(temperature as f32),
        max_tokens: Some(max_tokens),
        preset,
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

/// 给前端的预设视图。
///
/// **为什么不直接序列化 `ProviderPreset`**：那个结构里的 `protocol` / `kind`
/// 是 Rust 枚举，前端拿到 `"OpenAiCompat"` 这种字符串也没有用武之地；而
/// `aliases` / `verified_on` 前端确实要（搜索别名、提示「地址可能过期」）。
/// 所以这里只挑前端真正消费的字段，而不是把内部结构整体推出去 ——
/// 内部字段一改就炸前端，是最不划算的耦合。
///
/// 单一事实源：界面从 Rust 取，加一家厂商只需改 `cap-llm::presets`。
/// 前端不再保留第二份 `PROVIDER_PRESETS` 常量表（R1）。
#[derive(Debug, Serialize)]
pub struct PresetView {
    /// 稳定机器标识，作为 `provider` 字段写回配置。
    pub id: &'static str,
    /// 展示名（中文）。
    pub label: &'static str,
    /// 已填好的服务地址。
    pub base_url: &'static str,
    /// 分组键（international / domestic / aggregator / selfHosted）。
    pub category: &'static str,
    /// 分组展示名。
    pub category_label: &'static str,
    /// 是否需要 API Key。Ollama 这类本地服务不需要，界面要据此隐藏密钥框。
    pub requires_api_key: bool,
    /// 供搜索的其他写法（英文名、旧称）。用户输 "kimi" 要能搜到「Kimi（月之暗面）」。
    pub aliases: &'static [&'static str],
    /// 地址核对日期。给用户一个「这条预设是不是很老了」的判断依据。
    pub verified_on: &'static str,
}

fn category_key(c: cap_llm::preset::Category) -> &'static str {
    use cap_llm::preset::Category as C;
    match c {
        C::International => "international",
        C::Domestic => "domestic",
        C::Aggregator => "aggregator",
        C::SelfHosted => "selfHosted",
    }
}

/// 列出可选的供应商预设。
///
/// terminal 与 file 共用同一张 `cap-llm::presets` 表，保证「界面显示 DeepSeek、
/// 请求打向 DeepSeek」两者同源。详见家族设计文档 05_LLM接入层。
#[tauri::command]
pub fn list_llm_presets() -> Vec<PresetView> {
    cap_llm::preset::PRESETS
        .iter()
        .map(|p| PresetView {
            id: p.id,
            label: p.label,
            base_url: p.base_url,
            category: category_key(p.category),
            category_label: p.category.label(),
            requires_api_key: p.requires_api_key,
            aliases: p.aliases,
            verified_on: p.verified_on,
        })
        .collect()
}

/// 明显不是对话模型的模型名前缀。
///
/// 用户点「获取模型列表」是为了选一个**能聊天**的模型；而 `/models` 通常把
/// 向量、语音、绘图、重排模型全都列出来。让用户在一个 200 项的下拉里
/// 挑出那个能用的，等于把筛选工作推回给人 —— 选错之后拿到的是
/// 「model does not support chat」，一句话都看不出是选错了模型类别。
const NON_CHAT_HINTS: &[&str] = &[
    "embedding",
    "embed",
    "whisper",
    "tts",
    "audio",
    "image",
    "dall-e",
    "rerank",
    "moderation",
    "guard",
    "search-",
    "-search",
    "ocr",
];

/// 按「能不能聊天」给模型名排序：能聊的在前，其余在后。
///
/// 刻意**不删除**非对话模型：有些代理把自定义模型名起得很随意，
/// 一刀切过滤会把「唯一可用的那个」也滤掉。排序而非过滤，最坏情况
/// 只是用户需要往下滚一点。
fn rank_models(mut models: Vec<String>) -> Vec<String> {
    models.sort_by_key(|m| {
        let lower = m.to_ascii_lowercase();
        let non_chat = NON_CHAT_HINTS.iter().any(|h| lower.contains(h));
        (non_chat, lower.clone())
    });
    models.dedup();
    models
}

/// 列出该配置可用的模型。
///
/// ⚠️ terminal 与 file 的一个关键差异（家族设计文档 05 §5.4）：
/// **apiKey 不出 webview**（`get_ai_config` 回传的永远是脱敏视图），所以
/// 「获取模型列表」只能读**已保存的配置**，不能用表单草稿。这意味着用户
/// 必须先把新配置「保存」一次，再回来点这个按钮 —— 界面会如实写
/// 「基于已保存的配置」，不假装草稿可测。
#[tauri::command]
pub async fn list_llm_models() -> Result<Vec<String>, LlmFailure> {
    let cap = to_cap(&GenOverrides::default()).map_err(LlmFailure::from)?;
    let models = cap_llm::list_models(&cap)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(rank_models(models))
}

/// 测试已保存的 AI 配置是否可用。
///
/// 同样读**已保存配置**（理由同上）：ping 一个 `max_tokens=1` 的真实对话，
/// 能拿到回复 ⇒ key、地址、模型三项全对。不用 `/models` 探活 —— 很多自建
/// 代理不实现这个接口，用它测会把「服务好的，只是没这个 API」误报成「连不上」。
#[tauri::command]
pub async fn test_ai_config() -> Result<String, LlmFailure> {
    let cap = to_cap(&GenOverrides::default()).map_err(LlmFailure::from)?;
    let elapsed = cap_llm::ping(&cap)
        .await
        .map_err(LlmFailure::from_error)?;
    Ok(format!(
        "连接成功（{} · {}），耗时 {}ms",
        cap.kind.label(),
        cap.model,
        elapsed.as_millis()
    ))
}

/// 给界面的结构化失败。
///
/// ## 为什么不是 `Result<_, String>`
///
/// 字符串错误只能被「读」不能被「判断」。界面要给出的恰恰是判断：
/// 401 该聚焦密钥框、404 该提示地址、429 该说「这不是你的配置问题」。
/// 靠正则去猜 `HTTP 401 — ...` 里的数字，等于把协议塞进文案里，
/// 哪天文案改一个字（比如加个中文破折号），分流就静默失效 ——
/// 而失效的表现是「所有错误都显示同一句话」，没人会当成 bug 报上来。
#[derive(Debug, Serialize)]
pub struct LlmFailure {
    /// 机器可判的类别：notConfigured / network / timeout / http / parse / unsupported / io
    pub kind: &'static str,
    /// HTTP 状态码（仅 kind == "http" 时非空）。
    pub status: Option<u16>,
    /// 原始错误，已脱敏、已按字符截断。给「想知道细节」的用户。
    pub message: String,
    /// 一句话动机 + 一个动作。给「只想让它能用」的用户。
    pub hint: String,
}

fn kind_key(k: ErrorKind) -> &'static str {
    use ErrorKind as E;
    match k {
        E::NotConfigured => "notConfigured",
        E::Network => "network",
        E::Timeout => "timeout",
        E::Http => "http",
        E::Parse => "parse",
        E::Unsupported => "unsupported",
        E::Io => "io",
    }
}

/// 把类别 + 状态码翻译成「用户下一步该做什么」。
///
/// 每一条都必须指向**一个具体动作**，而不是复述错误。
/// 「请求失败，请重试」这种文案的价值是零 —— 用户已经知道失败了。
fn hint_for(kind: ErrorKind, status: Option<u16>) -> String {
    use ErrorKind as E;
    match (kind, status) {
        (E::NotConfigured, _) => "配置还差一项。请补齐上方标红的字段后重试。".into(),
        (E::Network, _) => {
            "连不上这个地址。国内厂商（DeepSeek / 通义 / Kimi / 智谱 / 豆包）一般直连即可，\
             如果你开了代理，先关掉再试；海外厂商（OpenAI / Gemini / Anthropic）相反，需要代理。"
                .into()
        }
        (E::Timeout, _) => {
            "等太久没等到回应。可能是网络到该地区的链路慢，也可能是模型正在排队。\
             可以先换一个更小的模型试，或把超时调大。"
                .into()
        }
        (E::Http, Some(401)) | (E::Http, Some(403)) => {
            "API Key 无效、已过期，或这个 key 没有该模型的权限。请重新粘贴密钥；\
             若刚续费过，确认用的是新 key。"
                .into()
        }
        (E::Http, Some(404)) => {
            "地址或模型名不存在。最常见的原因是 Base URL 多写／少写了一段路径 —— \
             各家都不完全一样（DeepSeek 带 /v1，智谱是 /api/paas/v4，火山是 /api/v3）。\
             点「恢复默认地址」用该厂商的标准地址最稳。"
                .into()
        }
        (E::Http, Some(429)) => {
            "额度用尽或被限流。这不是配置写错了 —— 换个时段再试，或在服务商后台充值／提额。"
                .into()
        }
        (E::Http, Some(s)) if s >= 500 => {
            "服务商那边出故障了，不是你配置的问题。稍后重试即可。".into()
        }
        (E::Http, _) => "服务端拒绝了这次请求。原始错误见下方详情。".into(),
        (E::Parse, _) => {
            "对方回了内容，但不是预期的格式。多半是这个地址其实不是该协议的服务 —— \
             例如把 Anthropic 的地址填在了 OpenAI 兼容这一档。".into()
        }
        (E::Unsupported, _) => {
            "这家服务不支持当前操作。换一个厂商，或改用手动填写模型名。".into()
        }
        (E::Io, _) => "本机读写配置出错。检查配置文件所在目录是否可写。".into(),
    }
}

impl LlmFailure {
    fn from_error(e: LlmError) -> Self {
        let hint = hint_for(e.kind, e.status);
        Self {
            kind: kind_key(e.kind),
            status: e.status,
            message: e.to_string(),
            hint,
        }
    }
}

impl From<String> for LlmFailure {
    /// `to_cap()` 之类的本地校验失败（如「AI 未配置」）：没有类别可判，但同样要能显示。
    fn from(message: String) -> Self {
        Self {
            kind: "notConfigured",
            status: None,
            hint: hint_for(ErrorKind::NotConfigured, None),
            message,
        }
    }
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
        // 预设 id 是 anthropic（前端下拉直接写回它）—— 必须与 claude 走同一协议族，
        // 否则从下拉选「Anthropic」会退化成 OpenAI 兼容请求（2026-10-28）
        assert!(matches!(provider_kind("anthropic"), ProviderKind::Anthropic));
        assert!(matches!(provider_kind("gemini"), ProviderKind::Gemini));
        assert!(matches!(provider_kind("ollama"), ProviderKind::Ollama));
        // 未知 provider 不许猜：落到 OpenAI 兼容并保留原字符串由 cap-llm 报错
        assert!(matches!(provider_kind("wat"), ProviderKind::Custom));
    }

    #[test]
    fn preset_binding_never_crosses_protocol_families() {
        // 红线：preset 的协议族必须与 provider_kind 的判定兼容。
        // 跨协议族绑定 = 静默错路由（地址是 Anthropic 的却按 Gemini 协议发）。
        assert_eq!(preset_id("claude"), Some("anthropic"));
        assert_eq!(preset_id("gemini"), Some("gemini"));
        assert_eq!(preset_id("ollama"), Some("ollama"));
        // openai / minimax 走 Custom 判定，但与预设同族，仍应绑定
        assert_eq!(preset_id("openai"), Some("openai"));
        assert_eq!(preset_id("minimax"), Some("minimax"));
        // 未知 provider 不绑定
        assert_eq!(preset_id("wat"), None);
        assert_eq!(preset_id("custom"), None);
    }

    #[test]
    fn preset_supplies_address_when_base_url_is_empty() {
        // 用户在设置里选了 DeepSeek 但没填地址 —— 自动补上
        let mut ai = AiConfig {
            provider: "deepseek".to_string(),
            api_key: Some("sk-test-1234567890".to_string()),
            base_url: None,
            model: Some("deepseek-chat".to_string()),
            temperature: None,
            max_tokens: None,
        };
        let cap = build_cap(&ai, &GenOverrides::default()).unwrap();
        assert_eq!(cap.preset, Some("deepseek"));
        assert_eq!(
            cap.endpoint(cap_llm::Action::Chat).unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // 显式填的地址优先
        ai.base_url = Some("https://my-proxy.corp/v1".to_string());
        let cap = build_cap(&ai, &GenOverrides::default()).unwrap();
        assert_eq!(
            cap.endpoint(cap_llm::Action::Chat).unwrap(),
            "https://my-proxy.corp/v1/chat/completions"
        );
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
        // 用 "custom"（无预设）来测「缺地址要报错」——
        // openai 这类有预设的 provider 缺地址时会被预设兜住，
        // 见 preset_supplies_address_when_base_url_is_empty。
        let e1 = build_cap(&ai("custom", " ", "k"), &GenOverrides::default()).unwrap_err();
        assert!(e1.contains("Base URL"));
        let e2 = build_cap(&ai("custom", "https://x.com", "k"), &GenOverrides::default())
            .map(|c| c.model)
            .err();
        assert!(e2.is_none(), "model 已填，不该报错");
        let mut no_model = ai("custom", "https://x.com", "k");
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

    // ---- 供应商预设 / 模型排序 / 错误分流（与 file 仓同一套契约）----

    #[test]
    fn presets_expose_every_field_the_ui_needs() {
        let all = list_llm_presets();
        assert!(all.len() >= 16, "预设不应少于 16 条，实际 {}", all.len());
        for p in &all {
            assert!(!p.base_url.is_empty(), "{} 缺地址", p.id);
            assert!(!p.label.is_empty(), "{} 缺展示名", p.id);
            assert!(!p.category_label.is_empty(), "{} 缺分组名", p.id);
            assert!(!p.verified_on.is_empty(), "{} 缺核对日期", p.id);
        }
        // 国内厂商必须覆盖：terminal 用户最可能买的几家
        for id in ["deepseek", "qwen", "moonshot", "zhipu", "volcengine", "minimax"] {
            assert!(all.iter().any(|p| p.id == id), "缺国内预设 {}", id);
        }
        let ollama = all.iter().find(|p| p.id == "ollama").unwrap();
        assert!(!ollama.requires_api_key);
    }

    #[test]
    fn every_preset_id_is_writable_back_as_provider() {
        for p in list_llm_presets() {
            let (_kind, preset) = cap_llm::ProviderKind::parse_with_preset(p.id)
                .unwrap_or_else(|e| panic!("预设 {} 无法写回：{}", p.id, e));
            assert_eq!(preset, Some(p.id), "预设 {} 写回后身份丢了", p.id);
        }
    }

    #[test]
    fn chat_models_are_ranked_before_embedding_and_speech() {
        let ranked = rank_models(vec![
            "text-embedding-3-small".into(),
            "gpt-4o".into(),
            "whisper-1".into(),
            "dall-e-3".into(),
            "deepseek-chat".into(),
        ]);
        assert_eq!(ranked[0], "deepseek-chat");
        assert_eq!(ranked[1], "gpt-4o");
        // 非对话模型仍在列表里，只是排到后面
        assert!(ranked.contains(&"text-embedding-3-small".to_string()));
        assert!(ranked.contains(&"whisper-1".to_string()));
    }

    #[test]
    fn every_failure_kind_carries_an_actionable_hint() {
        let cases = [
            (ErrorKind::NotConfigured, None, "补齐"),
            (ErrorKind::Network, None, "代理"),
            (ErrorKind::Timeout, None, "超时"),
            (ErrorKind::Http, Some(401), "密钥"),
            (ErrorKind::Http, Some(403), "权限"),
            (ErrorKind::Http, Some(404), "Base URL"),
            (ErrorKind::Http, Some(429), "限流"),
            (ErrorKind::Http, Some(502), "故障"),
            (ErrorKind::Parse, None, "协议"),
            (ErrorKind::Unsupported, None, "不支持"),
            (ErrorKind::Io, None, "配置"),
        ];
        for (kind, status, must_mention) in cases {
            let hint = hint_for(kind, status);
            assert!(
                hint.contains(must_mention),
                "{:?}/{:?} 的提示里没提到「{}」，实际：{}",
                kind,
                status,
                must_mention,
                hint
            );
            assert!(hint.chars().count() >= 12, "提示过短：{}", hint);
        }
    }

    #[test]
    fn hint_does_not_leak_the_api_key() {
        for (kind, status) in [
            (ErrorKind::Network, None),
            (ErrorKind::Http, Some(401)),
            (ErrorKind::Parse, None),
        ] {
            let hint = hint_for(kind, status);
            assert!(!hint.contains("sk-"), "提示里出现了疑似密钥：{}", hint);
        }
    }
}
