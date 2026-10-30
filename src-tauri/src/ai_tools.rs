//! AI 工具调用（function calling）——让模型能调用 terminal 自己的 SSH/SFTP 能力。
//!
//! ## 边界：这一轮全是**只读**工具
//!
//! 工具集只做「看」的事：列目录、读文件、查服务器信息、探连通性。
//! 没有任何一个工具会写入远端、不会写 PTY、不会改配置。理由不是「写操作还没写完」，
//! 而是**写操作需要另一套确认机制**（`commandGate` 的 block 级逐字确认），
//! 那条链路在 AI 自主调用时拿不到「用户正在看着弹窗」这个前提 —— 详见
//! [`crate::ai_tools`] 的模块说明与 `AI_FEATURES.md`。
//!
//! ## cap-llm 的 tool role（2026-10-30 起为原生）
//!
//! `cap_llm::Message` 有 `Role::Tool` 与 `tool_call_id` / `tool_name` /
//! `tool_calls` 字段，`wire::build_body` 按四协议各自的原生形态编码
//! （OpenAI `role:"tool"`、Anthropic `tool_result` 块、Gemini
//! `functionResponse`、Ollama `role:"tool"`）。本模块把工具结果用
//! `Message::tool()` 回灌，并用 `Message::assistant_with_tools()` 把
//! assistant 那一轮的 tool_calls 原样带回（服务端按 id 校验）。
//!
//! 唯一保留的降级路径：tool_call 解析不出 id 时（畸形报文），退回到
//! 带 `[工具结果]` 标记的 user 消息 —— 那种情况下发原生 tool 消息
//! 必然 400（id 为空配不上对），降级总比整轮失败好。

use cap_llm::{Message, ToolDef};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::audit;
use crate::commands;

/// 工具执行循环的最大轮次。
///
/// 模型可能反复要求调同一个工具（工具返回的内容没满足它、或它就是想再看一眼）。
/// 没有上限就是「一个提问烧掉用户的钱」——所以卡死。
pub const MAX_ROUNDS: usize = 5;

/// 单个工具结果回灌给模型的最大字符数。
///
/// 远端 `ls -la` 或一个几百 KB 的配置文件都可能远超模型的合理输入预算。
/// 截断必须**明确告知模型**（`[已截断]`），否则模型会以为看到了全文。
pub const MAX_TOOL_OUTPUT_CHARS: usize = 8000;

/// 读取远端文件时允许的最大字节数（截断前）。
pub const MAX_REMOTE_FILE_BYTES: usize = 256 * 1024;

/// 工具调用的执行上下文。
///
/// `session_id` 由前端从既有 store 解析后传入（`pickActiveSession` /
/// `pickTabSession`），后端按**现有会话表**路由 —— 不另造连接管理。
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolContext {
    /// 当前活跃的 SSH 会话 id。工具只能打在这个会话上。
    pub session_id: Option<String>,
}

/// 一次工具调用的执行记录（回给前端展示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    /// 模型给出的工具名。
    pub name: String,
    /// 模型给出的参数（已解析成对象；解析失败时是原始串）。
    pub arguments: Value,
    /// 是否成功。
    pub ok: bool,
    /// 结果摘要（成功时是工具输出，失败时是错误原因）。
    pub output: String,
    /// 第几轮执行的（从 1 开始）。
    pub round: usize,
}

/// 工具模式的完整响应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolChatResult {
    /// 模型的最终回答。
    pub content: String,
    /// 期间发生的全部工具调用（前端据此渲染可折叠轨迹）。
    pub tool_calls: Vec<ToolCallRecord>,
    /// 是否因为达到轮次上限而被截断。
    pub hit_round_limit: bool,
    /// 实际发生的轮次。
    pub rounds: usize,
}

// ---------- 工具定义 ----------

/// 列出远端目录。
fn list_remote_dir_tool() -> ToolDef {
    ToolDef::new(
        "list_remote_dir",
        "列出远端服务器某个目录下的内容（只读）。返回文件名、是否目录、大小、修改时间、权限。",
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "远端目录的绝对路径，例如 /var/log。不填则用当前用户的家目录。"
                }
            },
            "required": []
        }),
    )
}

/// 读取远端文件。
fn read_remote_file_tool() -> ToolDef {
    ToolDef::new(
        "read_remote_file",
        "读取远端服务器上一个文件的文本内容（只读）。内容过长会被截断，此时结果里会明确标注。",
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "远端文件的绝对路径，例如 /etc/os-release"
                },
                "maxBytes": {
                    "type": "integer",
                    "description": "最多读取的字节数，默认 65536，最大 262144。",
                    "minimum": 1024,
                    "maximum": 262144
                }
            },
            "required": ["path"]
        }),
    )
}

/// 查询服务器系统信息。
fn server_info_tool() -> ToolDef {
    ToolDef::new(
        "get_server_info",
        "采集当前远端服务器的系统信息（只读）：主机名、操作系统、内核、架构、CPU、内存、磁盘、运行时长。",
        json!({
            "type": "object",
            "properties": {}
        }),
    )
}

/// 诊断连通性。
fn diagnose_tool() -> ToolDef {
    ToolDef::new(
        "diagnose_connectivity",
        "诊断到某个主机的连通性（只读）。可做 TCP 端口探测（在本机发起）或从当前服务器 ping 目标主机。",
        json!({
            "type": "object",
            "properties": {
                "host": {
                    "type": "string",
                    "description": "目标主机名或 IP，例如 10.0.0.5"
                },
                "port": {
                    "type": "integer",
                    "description": "要做 TCP 探测的端口。给了就做端口探测。",
                    "minimum": 1,
                    "maximum": 65535
                },
                "ping": {
                    "type": "boolean",
                    "description": "是否从当前服务器 ping 目标主机（而不是在本机探端口）。"
                },
                "count": {
                    "type": "integer",
                    "description": "ping 次数，默认 4。",
                    "minimum": 1,
                    "maximum": 20
                }
            },
            "required": ["host"]
        }),
    )
}

/// 本仓提供给模型的全部工具。
///
/// 全部只读 —— 见模块头部的边界说明。
pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        list_remote_dir_tool(),
        read_remote_file_tool(),
        server_info_tool(),
        diagnose_tool(),
    ]
}

// ---------- tool_calls 解析 ----------

/// 从一条 OpenAI 形状的 tool_call 里取出工具名与参数。
///
/// 容错点（模型输出不可靠是常态，不是异常）：
/// - `function.name` 缺失 → 返回错误而不是 panic；
/// - `arguments` 是 JSON 字符串 → 解析；已是对象 → 直接用；
/// - `arguments` 非法 JSON → **保留原始串**并报错，让上层把错误回灌给模型
///   而不是崩溃（模型看到错误会自己改参数重试）。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedToolCall {
    pub name: String,
    pub arguments: Value,
    /// 参数解析失败时的说明（成功时为空）。
    pub parse_error: Option<String>,
}

/// 解析一条 tool_call。
pub fn parse_tool_call(raw: &Value) -> Result<ParsedToolCall, String> {
    let func = raw
        .get("function")
        .ok_or_else(|| "tool_call 缺少 function 字段".to_string())?;
    let name = func
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "tool_call 缺少 function.name".to_string())?
        .to_string();
    if name.trim().is_empty() {
        return Err("tool_call 的 function.name 为空".to_string());
    }

    let raw_args = func.get("arguments");
    let arguments = match raw_args {
        None | Some(Value::Null) => json!({}),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                json!({})
            } else {
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        // 不 panic、不丢原始串：把错误交给模型自己修正
                        return Ok(ParsedToolCall {
                            name,
                            arguments: Value::String(s.clone()),
                            parse_error: Some(format!(
                                "arguments 不是合法 JSON（{e}），原始内容已保留，请用正确的 JSON 重新调用"
                            )),
                        });
                    }
                }
            }
        }
        Some(obj) => obj.clone(),
    };

    Ok(ParsedToolCall {
        name,
        arguments,
        parse_error: None,
    })
}

/// 工具名是否存在。
fn is_known_tool(name: &str) -> bool {
    tool_defs().iter().any(|t| t.name == name)
}

/// 从参数里取字符串字段。
fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 从参数里取整数字段（带范围钳制）。
fn arg_u64(args: &Value, key: &str, default: u64, min: u64, max: u64) -> u64 {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|v| v.clamp(min, max))
        .unwrap_or(default)
}

/// 从参数里取布尔字段。
fn arg_bool(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => {
            matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes")
        }
        _ => false,
    }
}

// ---------- 工具执行 ----------

/// 执行一次工具调用，返回结果文本（失败时也是一段明确的说明，会被回灌给模型）。
///
/// 失败**不返回 Err**：工具失败是模型的输入，不是这次请求的失败 ——
/// 模型看到「路径不存在」会自己换个路径，而直接终止整轮对话体验差得多。
async fn run_tool(name: &str, args: &Value, ctx: &ToolContext) -> (bool, String) {
    let Some(session_id) = ctx.session_id.as_deref().filter(|s| !s.is_empty()) else {
        return (
            false,
            "没有可用的 SSH 会话：请先在终端里连接一台服务器，再让 AI 使用工具。".to_string(),
        );
    };

    let Some(sess) = commands::get_session(session_id).await else {
        return (
            false,
            format!("会话 {session_id} 不存在或已断开：请重新连接后再试。"),
        );
    };

    match name {
        "list_remote_dir" => {
            let path = arg_str(args, "path").unwrap_or_else(|| ".".to_string());
            match sess.sftp_list(&path).await {
                Ok(entries) => {
                    let mut text = format!("目录 {} 共 {} 项：\n", path, entries.len());
                    for e in entries {
                        text.push_str(&format!(
                            "{}\t{}\t{} B\t{}\t{}\n",
                            if e.is_dir { "dir " } else { "file" },
                            e.name,
                            e.size,
                            e.modified.as_deref().unwrap_or("-"),
                            e.permissions.as_deref().unwrap_or("-"),
                        ));
                    }
                    (true, text)
                }
                Err(e) => (false, format!("列目录 {path} 失败：{e}")),
            }
        }
        "read_remote_file" => {
            let Some(path) = arg_str(args, "path") else {
                return (
                    false,
                    "缺少参数 path：必须给出要读取的远端文件路径。".to_string(),
                );
            };
            let max = arg_u64(
                args,
                "maxBytes",
                MAX_REMOTE_FILE_BYTES as u64,
                1024,
                MAX_REMOTE_FILE_BYTES as u64,
            ) as usize;
            match sess.sftp_read_text(&path, max).await {
                Ok((content, truncated)) => {
                    let mut text = format!("文件 {} 的内容：\n", path);
                    text.push_str(&content);
                    if truncated {
                        text.push_str(&format!(
                            "\n[内容超过 {} 字节上限，已截断 —— 这只是文件的一部分]",
                            max
                        ));
                    }
                    (true, text)
                }
                Err(e) => (false, format!("读取文件 {path} 失败：{e}")),
            }
        }
        "get_server_info" => {
            let info = commands::collect_server_info(&sess).await;
            if let Some(err) = info.error {
                return (false, format!("采集服务器信息失败：{err}"));
            }
            let text = format!(
                "主机名：{}\n操作系统：{}\n内核：{}\n架构：{}\nCPU：{}（{} 核，负载 {}，使用率 {}%）\n内存：已用 {} / 共 {} 字节\n磁盘：已用 {} / 共 {} 字节\n运行时长：{}",
                info.hostname,
                info.os,
                info.kernel,
                info.arch,
                info.cpu_model,
                info.cpu_cores,
                info.load_avg,
                info.cpu_usage,
                info.mem_used,
                info.mem_total,
                info.disk_used,
                info.disk_total,
                info.uptime,
            );
            (true, text)
        }
        "diagnose_connectivity" => {
            let Some(host) = arg_str(args, "host") else {
                return (false, "缺少参数 host：必须给出要诊断的主机。".to_string());
            };
            if let Err(e) = commands::validate_host(&host) {
                return (false, format!("主机名非法：{e}"));
            }
            if arg_bool(args, "ping") {
                let count = arg_u64(args, "count", 4, 1, 20) as u32;
                let result = commands::ping_host(&sess, &host, Some(count)).await;
                if result.success {
                    (true, result.output)
                } else {
                    (
                        false,
                        result.error.unwrap_or_else(|| "ping 失败".to_string()),
                    )
                }
            } else if let Some(port) = args.get("port").and_then(Value::as_u64) {
                let port = port.clamp(1, 65535) as u16;
                let probe = commands::probe_tcp(&host, port, None).await;
                let text = format!("{}（耗时 {} ms）", probe.message, probe.elapsed_ms);
                (probe.reachable, text)
            } else {
                // 什么都没给就默认做端口探测的缺省行为：ping 需要从远端发起，
                // 语义差别大，不该由模型默认选中。
                (
                    false,
                    "缺少动作参数：请给 port（做 TCP 端口探测）或 ping=true（从当前服务器 ping 目标）。"
                        .to_string(),
                )
            }
        }
        other => (
            false,
            format!(
                "未知工具 {other}。可用工具只有：{}。",
                tool_defs()
                    .iter()
                    .map(|t| t.name.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        ),
    }
}

/// 把工具结果包成一条回灌给模型的消息。
///
/// ## 原生 tool 消息优先，id 缺失才降级
///
/// `cap_llm::Message::tool()` 会按四协议各自的原生形态编码（见模块头）。
/// 但原生 tool 消息必须带得住配对 id：OpenAI/Anthropic 按 `tool_call_id`、
/// Gemini/Ollama 按 `tool_name`。若这条 tool_call 连 id 都没有（畸形报文，
/// `parse_tool_call` 已放过但 raw 里没 id），发原生消息必然 400 ——
/// 这时退回到带显式标记的 user 消息，模型仍能读到结果。
fn tool_result_message(
    tool_call_id: Option<&str>,
    name: &str,
    arguments: &Value,
    ok: bool,
    output: &str,
) -> Message {
    let body = truncate_tool_output(output);
    let id = tool_call_id.unwrap_or_default();
    if !id.trim().is_empty() {
        return Message::tool(id, name, body);
    }
    // 降级路径：id 缺失，退回带标记的 user 消息
    let args = if arguments.is_string() {
        arguments.as_str().unwrap_or_default().to_string()
    } else {
        arguments.to_string()
    };
    let status = if ok { "成功" } else { "失败" };
    Message::user(format!(
        "[工具结果] 工具={name} 状态={status}\n参数={args}\n结果：\n{body}\n[/工具结果]"
    ))
}

/// 截断工具输出到上限，并明确标注被截断。
fn truncate_tool_output(text: &str) -> String {
    let count = text.chars().count();
    if count <= MAX_TOOL_OUTPUT_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
    format!("{head}\n[输出过长，已截断 —— 实际共 {count} 字符]")
}

// ---------- 执行循环 ----------

/// 工具调用的抽象后端（便于单测，不碰网络）。
///
/// 生产实现是 [`real_loop`]；测试里换成脚本化的回复序列，
/// 于是「参数解析 / 非法参数降级 / 轮次上限 / 未知工具」这些分支
/// 都能**脱网**跑成真实断言。
#[async_trait::async_trait]
pub trait ToolLoopBackend {
    /// 发一轮请求，返回模型这一轮的内容与工具调用请求。
    async fn next_turn(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
    ) -> Result<(String, Vec<Value>), String>;
}

/// 真实后端：走 cap-llm。
struct CapLlmBackend {
    cfg: cap_llm::LlmConfig,
}

#[async_trait::async_trait]
impl ToolLoopBackend for CapLlmBackend {
    async fn next_turn(
        &self,
        messages: &[Message],
        tools: &[ToolDef],
    ) -> Result<(String, Vec<Value>), String> {
        let reply = cap_llm::chat_with_tools(&self.cfg, messages, tools)
            .await
            .map_err(|e| e.to_string())?;
        Ok((reply.content, reply.tool_calls))
    }
}

/// 执行工具调用循环。
///
/// 流程：请求 → 模型要求调工具 → 执行工具 → 把结果回灌 → 再请求 …… 直到
/// 模型不再要求调工具（拿到最终回答）或达到 [`MAX_ROUNDS`]。
///
/// 工具失败（未知工具名、参数非法、远端报错）都**不中断循环** ——
/// 错误作为一条结果回灌给模型，让它自己修正。这既满足「不能崩」，
/// 也更符合模型的能力：它比我们知道下一步该干什么。
pub async fn run_tool_loop<B: ToolLoopBackend + Sync, A: ToolAuditSink>(
    backend: &B,
    messages: &[Message],
    ctx: &ToolContext,
    audit: &A,
) -> Result<ToolChatResult, String> {
    let tools = tool_defs();
    let mut conversation: Vec<Message> = messages.to_vec();
    let mut records: Vec<ToolCallRecord> = Vec::new();
    let mut hit_limit = false;
    let mut rounds = 0usize;

    loop {
        rounds += 1;
        let (content, tool_calls) = backend.next_turn(&conversation, &tools).await?;

        if tool_calls.is_empty() {
            return Ok(ToolChatResult {
                content,
                tool_calls: records,
                hit_round_limit: hit_limit,
                rounds,
            });
        }

        // 到达轮次上限：不再执行工具，把已有结果如实告诉模型收尾。
        if rounds >= MAX_ROUNDS {
            hit_limit = true;
            let final_content = if content.trim().is_empty() {
                format!("已达到工具调用轮次上限（{MAX_ROUNDS} 轮），请基于已有信息直接回答。")
            } else {
                content
            };
            return Ok(ToolChatResult {
                content: final_content,
                tool_calls: records,
                hit_round_limit: hit_limit,
                rounds,
            });
        }

        // 模型这一轮说了什么 + 请求了哪些工具都要记下来：
        // 服务端按 id 校验「tool 结果前必须有一条带对应 tool_calls 的 assistant 消息」，
        // content 为空时也得带 tool_calls 原样回显，否则下一轮直接 400。
        conversation.push(Message::assistant_with_tools(&content, tool_calls.clone()));

        for raw in &tool_calls {
            let record = execute_one(raw, rounds, ctx, audit).await;
            records.push(record.clone());
            let id = raw.get("id").and_then(|v| v.as_str());
            conversation.push(tool_result_message(
                id,
                &record.name,
                &record.arguments,
                record.ok,
                &record.output,
            ));
        }
    }
}

/// 执行单条 tool_call 并生成记录。
async fn execute_one<A: ToolAuditSink>(
    raw: &Value,
    round: usize,
    ctx: &ToolContext,
    audit: &A,
) -> ToolCallRecord {
    let parsed = match parse_tool_call(raw) {
        Ok(p) => p,
        Err(e) => {
            return ToolCallRecord {
                name: "(无法解析)".to_string(),
                arguments: raw.clone(),
                ok: false,
                output: format!("无法解析 tool_call：{e}。请用正确的格式重新调用。"),
                round,
            };
        }
    };

    // 未知工具名：明确报错并回灌，模型会改用已知工具
    if !is_known_tool(&parsed.name) {
        let output = format!(
            "未知工具 {}。可用工具只有：{}。",
            parsed.name,
            tool_defs()
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join("、")
        );
        audit.record(&parsed.name, &parsed.arguments, false, &output);
        return ToolCallRecord {
            name: parsed.name,
            arguments: parsed.arguments,
            ok: false,
            output,
            round,
        };
    }

    // 参数非法：把解析错误交给模型，它会自己改
    if let Some(err) = &parsed.parse_error {
        audit.record(&parsed.name, &parsed.arguments, false, err);
        return ToolCallRecord {
            name: parsed.name,
            arguments: parsed.arguments,
            ok: false,
            output: err.clone(),
            round,
        };
    }

    let (ok, output) = run_tool(&parsed.name, &parsed.arguments, ctx).await;
    audit.record(&parsed.name, &parsed.arguments, ok, &output);
    ToolCallRecord {
        name: parsed.name,
        arguments: parsed.arguments,
        ok,
        // 前端要展示这个结果，所以同样截断 ——
        // 一个几百 KB 的文件全量塞进 IPC 响应会把界面打爆。
        output: truncate_tool_output(&output),
        round,
    }
}

/// 工具调用审计的落点。
///
/// 抽成 trait 有两个原因：
/// 1. **可测试**。审计日志是**进程级共享文件**，单测里真写会污染同一进程里
///    其它测试的记录（`audit.rs` 自己的测试就断言「最新一条是它自己写的」）。
///    所以单测用 [`NoopAudit`]，不落盘。
/// 2. **可替换**。将来若要按会话分文件审计，改这里一处即可。
pub trait ToolAuditSink: Send + Sync {
    fn record(&self, name: &str, arguments: &Value, ok: bool, output: &str);
}

/// 真实落点：写进 terminal 的统一审计日志。
pub struct FileAuditSink;

impl ToolAuditSink for FileAuditSink {
    fn record(&self, name: &str, arguments: &Value, ok: bool, output: &str) {
        audit::record(
            "ai_tool_call",
            json!({
                "tool": name,
                "arguments": arguments,
                "ok": ok,
                // 只记结果的**长度与首尾片段**，不记全文：
                // 工具结果可能是整个文件内容，写进审计日志等于把文件复制一份到日志里。
                "output_preview": {
                    "chars": output.chars().count(),
                    "head": output.chars().take(120).collect::<String>(),
                },
            }),
        );
    }
}

/// 不落盘的审计落点（单测用）。
#[cfg(test)]
pub struct NoopAudit;

#[cfg(test)]
impl ToolAuditSink for NoopAudit {
    fn record(&self, _name: &str, _arguments: &Value, _ok: bool, _output: &str) {}
}

// ---------- 生产入口 ----------

/// 用 cap-llm 驱动真实的工具循环。
pub async fn run_real_tool_loop(
    cfg: cap_llm::LlmConfig,
    messages: &[Message],
    ctx: &ToolContext,
) -> Result<ToolChatResult, String> {
    let backend = CapLlmBackend { cfg };
    run_tool_loop(&backend, messages, ctx, &FileAuditSink).await
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 脚本化的后端：按预设序列返回 (content, tool_calls)。
    /// 同时把每轮收到的 messages 记下来，供「回灌格式」类断言用。
    struct ScriptedBackend {
        turns: Mutex<Vec<(String, Vec<Value>)>>,
        seen: Mutex<usize>,
        captured: Mutex<Vec<Vec<Message>>>,
    }

    impl ScriptedBackend {
        fn new(turns: Vec<(String, Vec<Value>)>) -> Self {
            Self {
                turns: Mutex::new(turns),
                seen: Mutex::new(0),
                captured: Mutex::new(Vec::new()),
            }
        }

        /// 第 n 轡（1 起）后端收到的完整消息列表。
        fn messages_at(&self, round: usize) -> Vec<Message> {
            self.captured.lock().unwrap()[round - 1].clone()
        }
    }

    #[async_trait::async_trait]
    impl ToolLoopBackend for ScriptedBackend {
        async fn next_turn(
            &self,
            messages: &[Message],
            _tools: &[ToolDef],
        ) -> Result<(String, Vec<Value>), String> {
            self.captured.lock().unwrap().push(messages.to_vec());
            let mut seen = self.seen.lock().unwrap();
            let idx = *seen;
            *seen += 1;
            let turns = self.turns.lock().unwrap();
            Ok(turns
                .get(idx)
                .cloned()
                .unwrap_or_else(|| ("没有更多轮次".to_string(), vec![])))
        }
    }

    fn call(name: &str, args_json: &str) -> Value {
        json!({
            "id": "call_1",
            "type": "function",
            "function": { "name": name, "arguments": args_json }
        })
    }

    // ---- 参数解析 ----

    #[test]
    fn parses_openai_shaped_tool_call() {
        let parsed = parse_tool_call(&call("list_remote_dir", r#"{"path":"/var/log"}"#)).unwrap();
        assert_eq!(parsed.name, "list_remote_dir");
        assert_eq!(
            parsed.arguments.get("path").unwrap().as_str().unwrap(),
            "/var/log"
        );
        assert!(parsed.parse_error.is_none());
    }

    #[test]
    fn parses_arguments_given_as_object() {
        // 少数网关会把 arguments 直接给对象而不是字符串
        let raw = json!({
            "id": "c", "type": "function",
            "function": { "name": "read_remote_file", "arguments": { "path": "/etc/hosts" } }
        });
        let parsed = parse_tool_call(&raw).unwrap();
        assert_eq!(
            parsed.arguments.get("path").unwrap().as_str().unwrap(),
            "/etc/hosts"
        );
        assert!(parsed.parse_error.is_none());
    }

    #[test]
    fn missing_arguments_defaults_to_empty_object() {
        let raw =
            json!({ "id": "c", "type": "function", "function": { "name": "get_server_info" } });
        let parsed = parse_tool_call(&raw).unwrap();
        assert_eq!(parsed.arguments, json!({}));
    }

    // ---- 非法 arguments 的降级 ----

    #[test]
    fn invalid_arguments_degrade_without_panicking() {
        // 关键：不能崩，且必须把错误带出去让模型自己改
        let parsed = parse_tool_call(&call("list_remote_dir", "{not json")).unwrap();
        assert_eq!(parsed.name, "list_remote_dir");
        let err = parsed.parse_error.expect("应当报告参数解析失败");
        assert!(err.contains("JSON"), "错误信息应说明是 JSON 问题：{err}");
        // 原始内容被保留，模型能看到自己错在哪
        assert_eq!(parsed.arguments, Value::String("{not json".to_string()));
    }

    #[test]
    fn empty_arguments_string_is_treated_as_empty_object() {
        let parsed = parse_tool_call(&call("get_server_info", "   ")).unwrap();
        assert_eq!(parsed.arguments, json!({}));
        assert!(parsed.parse_error.is_none());
    }

    #[test]
    fn missing_function_name_is_an_error_not_a_panic() {
        let raw = json!({ "id": "c", "type": "function", "function": { "arguments": "{}" } });
        assert!(parse_tool_call(&raw).is_err());
    }

    #[test]
    fn missing_function_field_is_an_error_not_a_panic() {
        let raw = json!({ "id": "c", "type": "function" });
        assert!(parse_tool_call(&raw).is_err());
    }

    // ---- 未知工具名 ----

    #[tokio::test]
    async fn unknown_tool_is_reported_and_loop_continues() {
        // 模型调了一个不存在的工具 → 该次调用失败并回灌，循环继续拿到最终回答
        let backend = ScriptedBackend::new(vec![
            ("".into(), vec![call("rm_rf_everything", "{}")]),
            ("最终回答".into(), vec![]),
        ]);
        let result = run_tool_loop(
            &backend,
            &[Message::user("删库")],
            &ToolContext::default(),
            &NoopAudit,
        )
        .await
        .unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        assert!(!result.tool_calls[0].ok);
        assert!(result.tool_calls[0].output.contains("未知工具"));
        // 循环没有中断，拿到了最终回答
        assert_eq!(result.content, "最终回答");
    }

    #[tokio::test]
    async fn invalid_arguments_are_reported_and_loop_continues() {
        let backend = ScriptedBackend::new(vec![
            ("".into(), vec![call("list_remote_dir", "{oops")]),
            ("最终回答".into(), vec![]),
        ]);
        let result = run_tool_loop(
            &backend,
            &[Message::user("看目录")],
            &ToolContext::default(),
            &NoopAudit,
        )
        .await
        .unwrap();
        assert_eq!(result.tool_calls.len(), 1);
        assert!(!result.tool_calls[0].ok);
        assert!(result.tool_calls[0].output.contains("JSON"));
        assert_eq!(result.content, "最终回答");
    }

    // ---- 轮次上限 ----

    #[tokio::test]
    async fn round_limit_stops_an_endless_loop() {
        // 模型永远要求调工具 → 必须在 MAX_ROUNDS 处停下，不能无限烧钱
        let turns: Vec<(String, Vec<Value>)> = (0..50)
            .map(|_| ("".to_string(), vec![call("get_server_info", "{}")]))
            .collect();
        let backend = ScriptedBackend::new(turns);
        let result = run_tool_loop(
            &backend,
            &[Message::user("循环")],
            &ToolContext::default(),
            &NoopAudit,
        )
        .await
        .unwrap();
        assert!(result.hit_round_limit, "应当标记出轮次上限");
        assert!(
            result.rounds <= MAX_ROUNDS,
            "轮次超出上限：{}",
            result.rounds
        );
        // 执行的工具调用次数也有界
        assert!(result.tool_calls.len() < MAX_ROUNDS);
    }

    #[tokio::test]
    async fn loop_stops_when_model_returns_no_tool_calls() {
        let backend = ScriptedBackend::new(vec![("回答".into(), vec![])]);
        let result = run_tool_loop(
            &backend,
            &[Message::user("你好")],
            &ToolContext::default(),
            &NoopAudit,
        )
        .await
        .unwrap();
        assert_eq!(result.content, "回答");
        assert!(result.tool_calls.is_empty());
        assert!(!result.hit_round_limit);
    }

    // ---- 会话缺失时的降级 ----

    #[tokio::test]
    async fn missing_session_yields_a_clear_error_not_a_crash() {
        let backend = ScriptedBackend::new(vec![
            ("".into(), vec![call("get_server_info", "{}")]),
            ("需要连接服务器".into(), vec![]),
        ]);
        // 没有 session_id
        let result = run_tool_loop(
            &backend,
            &[Message::user("看信息")],
            &ToolContext::default(),
            &NoopAudit,
        )
        .await
        .unwrap();
        assert!(!result.tool_calls[0].ok);
        assert!(result.tool_calls[0].output.contains("SSH 会话"));
    }

    #[tokio::test]
    async fn nonexistent_session_yields_a_clear_error() {
        let backend = ScriptedBackend::new(vec![
            ("".into(), vec![call("get_server_info", "{}")]),
            ("回答".into(), vec![]),
        ]);
        let ctx = ToolContext {
            session_id: Some("不存在的会话".into()),
        };
        let result = run_tool_loop(&backend, &[Message::user("看信息")], &ctx, &NoopAudit)
            .await
            .unwrap();
        assert!(!result.tool_calls[0].ok);
        assert!(result.tool_calls[0].output.contains("不存在"));
    }

    // ---- 回灌格式 ----

    #[test]
    fn tool_result_with_id_is_a_native_tool_message() {
        let msg = tool_result_message(
            Some("call_1"),
            "read_remote_file",
            &json!({ "path": "/etc/hosts" }),
            true,
            "127.0.0.1 localhost",
        );
        // 有 id 就走原生 tool 角色（四协议各自的原生编码在 cap-llm 的 wire 层）
        assert!(matches!(msg.role, cap_llm::Role::Tool));
        assert_eq!(msg.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(msg.tool_name.as_deref(), Some("read_remote_file"));
        assert_eq!(msg.content, "127.0.0.1 localhost");
    }

    #[test]
    fn tool_result_without_id_degrades_to_marked_user_message() {
        // id 缺失（畸形报文）：发原生 tool 消息必然 400，降级为带标记的 user 消息
        let msg = tool_result_message(
            None,
            "read_remote_file",
            &json!({ "path": "/etc/hosts" }),
            true,
            "127.0.0.1 localhost",
        );
        assert!(matches!(msg.role, cap_llm::Role::User));
        assert!(msg.content.contains("[工具结果]"));
        assert!(msg.content.contains("read_remote_file"));
        assert!(msg.content.contains("/etc/hosts"));
        assert!(msg.content.contains("127.0.0.1 localhost"));
    }

    #[tokio::test]
    async fn loop_feeds_back_native_tool_messages_not_marked_user() {
        // 核心行为：工具结果必须以原生 tool 角色回灌，
        // 且 assistant 那一轮的 tool_calls 原样带回（服务端按 id 配对）。
        let backend = ScriptedBackend::new(vec![
            ("我来查".into(), vec![call("get_server_info", "{}")]),
            ("查完了".into(), vec![]),
        ]);
        let ctx = ToolContext { session_id: None };
        let result = run_tool_loop(&backend, &[Message::user("看信息")], &ctx, &NoopAudit)
            .await
            .unwrap();
        assert_eq!(result.rounds, 2);

        let round2 = backend.messages_at(2);
        // 倒数第二条：assistant 带 tool_calls 原样回显
        let assistant = &round2[round2.len() - 2];
        assert!(matches!(assistant.role, cap_llm::Role::Assistant));
        assert_eq!(assistant.tool_calls.len(), 1);
        assert_eq!(assistant.tool_calls[0]["id"], "call_1");
        // 最后一条：原生 tool 消息，id 与名字都对得上
        let tool_msg = &round2[round2.len() - 1];
        assert!(matches!(tool_msg.role, cap_llm::Role::Tool));
        assert_eq!(tool_msg.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(tool_msg.tool_name.as_deref(), Some("get_server_info"));
        // 不能残留降级路径的标记
        assert!(!tool_msg.content.contains("[工具结果]"));
    }

    #[test]
    fn tool_result_output_is_truncated_with_a_marker() {
        let long = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500);
        let msg = tool_result_message(Some("c1"), "t", &json!({}), true, &long);
        assert!(msg.content.contains("已截断"));
        assert!(msg.content.chars().count() < long.chars().count() + 200);
    }

    // ---- 工具集本身 ----

    #[test]
    fn every_tool_is_read_only_and_has_a_json_schema() {
        let defs = tool_defs();
        assert!(!defs.is_empty());
        for d in &defs {
            // parameters 必须是 JSON Schema 对象
            assert_eq!(
                d.parameters.get("type").and_then(|v| v.as_str()),
                Some("object")
            );
            assert!(!d.description.trim().is_empty(), "{} 缺描述", d.name);
        }
        // 名字唯一
        let mut names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(names.len(), count, "工具名重复");
    }

    #[test]
    fn tool_defs_expose_exactly_the_read_only_set() {
        let names: Vec<String> = tool_defs().into_iter().map(|d| d.name).collect();
        assert_eq!(
            names,
            vec![
                "list_remote_dir",
                "read_remote_file",
                "get_server_info",
                "diagnose_connectivity",
            ]
        );
        // 写操作绝不能混进来
        for name in &names {
            assert!(
                !name.contains("write")
                    && !name.contains("upload")
                    && !name.contains("download")
                    && !name.contains("remove")
                    && !name.contains("mkdir")
                    && !name.contains("rename"),
                "工具集里出现了疑似写操作：{name}"
            );
        }
    }
}
