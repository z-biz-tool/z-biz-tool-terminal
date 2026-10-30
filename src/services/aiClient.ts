import type {
  AIMessage,
  AIClient,
  AIConfig,
  AIToolChatResult,
  ChatOptions,
  CommandExplanation,
  ErrorAnalysis,
  StreamOptions,
  ToolChatOptions,
} from "../types/ai";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 命令参数：生成参数的临时覆盖（与 Rust ai::GenOverrides 对应） */
type Overrides = { temperature?: number; maxTokens?: number };

/** AI 流式 token 事件名（与 Rust ai.rs 一致） */
const STREAM_EVENT = "ai-stream://token";

/**
 * 模型被要求输出 JSON, 但实际常包一层 ```json 围栏、或前后带一句客套话。
 * 直接 JSON.parse 会让整张解释面板变成"分析失败"，所以先剥出第一个完整的 {...}。
 */
export function parseJsonReply<T>(text: string): T {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  // 对象与数组两种返回都会出现（代码建议要求输出 JSON 数组），按先出现的括号取
  const starts = [unfenced.indexOf("{"), unfenced.indexOf("[")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const closer = unfenced[start] === "[" ? "]" : "}";
  const end = unfenced.lastIndexOf(closer);
  const candidate = start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
  return JSON.parse(candidate) as T;
}

function overridesOf(options?: ChatOptions): Overrides {
  const o: Overrides = {};
  if (options?.temperature !== undefined) o.temperature = options.temperature;
  if (options?.maxTokens !== undefined) o.maxTokens = options.maxTokens;
  return o;
}

/**
 * AI 客户端 —— 请求全部走 Rust 侧命令（cap-llm）。
 *
 * ## 为什么前端不再自己 fetch（2026-10-26）
 *
 * 原实现在这里维护着四套协议的 URL/鉴权头/请求体/SSE 解析（约 350 行），
 * 且 apiKey 明文由 `get_ai_config` 回传、长期驻留 webview 内存 —— 任何一处
 * 渲染疏漏都是泄露面。现在：协议/鉴权/流式解码/错误脱敏全部收口到后端
 * `ai_chat` / `ai_chat_stream`（底层是家族能力层 cap-llm），key 只在设置
 * 表单录入时过一次 IPC，此后存 Rust 加密区、请求不出后端进程。
 *
 * 本文件保留的只有 prompt 组装与结果解析 —— 那是产品语义，不是传输细节。
 */
class BackendAIClient implements AIClient {
  // config 保留是为了兼容工厂签名与判空提示；apiKey 字段恒为空串（脱敏视图），
  // 请求不会用到它 —— 后端从加密区自取。
  constructor(private config: AIConfig) {}

  private assertConfigured(): void {
    if (this.config.hasApiKey === false) {
      throw new Error("AI 未配置：请先在 AI 设置里填写 API Key");
    }
    if (!this.config.baseUrl) throw new Error("请先在 AI 设置里填写 Base URL");
    if (!this.config.model) throw new Error("请先在 AI 设置里填写模型名");
  }

  async chat(messages: AIMessage[], options?: ChatOptions): Promise<string> {
    this.assertConfigured();
    return invoke<string>("ai_chat", {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      overrides: overridesOf(options),
    });
  }

  /**
   * 流式对话。token 经后端 `ai-stream://token` 事件推送，命令 resolve 时为
   * 完整文本。`options.signal` 的语义从「断开 fetch 连接」变为「通知后端
   * 停止生成」（ai_stream_abort）：后端停在下一个网络 chunk 边界，返回
   * 已生成的部分 —— 监听器仍会收到既有 token，只是不再有新增。
   */
  async chatStream(messages: AIMessage[], options: StreamOptions): Promise<string> {
    this.assertConfigured();

    const unlisten: Promise<UnlistenFn> = listen<string>(STREAM_EVENT, (event) => {
      options.onDelta?.(event.payload);
    });

    if (options.signal) {
      const onAbort = () => {
        invoke("ai_stream_abort").catch(() => {/* 后端已在收尾时忽略 */});
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      return await invoke<string>("ai_chat_stream", {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        overrides: overridesOf(options),
      });
    } finally {
      // 监听器跟随本次请求的生命周期；invoke 返回/抛错后不再有新事件
      unlisten
        .then((fn) => fn())
        .catch((e) => console.warn("[ai] 注销流式事件监听失败，可能泄漏一个监听器:", e));
    }
  }

  /**
   * 工具调用对话：模型可调用 terminal 的只读 SSH/SFTP 能力。
   *
   * 会话 id 由调用方从既有 store 解析后传入；没传就是「无会话上下文」，
   * 工具里需要会话的那几个（列目录/读文件/查信息/诊断）会直接报错回灌，
   * 而不是悄悄换一台机器 —— 见后端 `ai_tools::run_tool`。
   */
  async chatWithTools(messages: AIMessage[], options?: ToolChatOptions): Promise<AIToolChatResult> {
    this.assertConfigured();
    return invoke<AIToolChatResult>("ai_chat_with_tools", {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      overrides: overridesOf(options),
      context: { sessionId: options?.sessionId ?? null },
    });
  }

  async explainCommand(command: string): Promise<CommandExplanation> {
    const prompt = `Please explain the following shell command:\n\nCommand: ${command}\n\nFormat as JSON:\n{\n  "description": "brief description",\n  "parameters": [\n    {"name": "param", "description": "description"}\n  ],\n  "example": "example usage",\n  "warnings": ["any warnings"]\n}`;

    const messages: AIMessage[] = [
      { role: "system", content: "You are a shell command expert. Answer in JSON format.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.3, maxTokens: 1000 });
    const parsed = parseJsonReply<CommandExplanation>(response);
    return { ...parsed, command };
  }

  async analyzeError(error: string): Promise<ErrorAnalysis> {
    const prompt = `Please analyze this error message and provide solutions:\n\nError: ${error}\n\nFormat as JSON:\n{\n  "rootCause": "root cause",\n  "solutions": ["solution 1", "solution 2"],\n  "预防措施": ["prevention steps"]\n}`;

    const messages: AIMessage[] = [
      { role: "system", content: "You are a debugging expert. Answer in JSON format.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.3, maxTokens: 1500 });
    const parsed = parseJsonReply<ErrorAnalysis>(response);
    return { ...parsed, errorMessage: error };
  }

  async commandFromNaturalLanguage(text: string): Promise<string> {
    const prompt = `Convert the following natural language request to a shell command:\n\nRequest: ${text}\n\nOutput only the shell command, no explanation.`;

    const messages: AIMessage[] = [
      { role: "system", content: "You are a shell command expert. Output only the command, no explanation.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.2, maxTokens: 500 });
    return response.trim();
  }
}

/**
 * 工厂函数：按配置创建客户端。
 *
 * provider 的协议差异（openai/claude/gemini/ollama/minimax…）已整体收口到
 * 后端（`ai.rs::provider_kind`），前端不再需要按 provider 分发传输实现 ——
 * 保留函数与签名是为了组件层零改动。
 */
export function createAIClient(config: AIConfig): AIClient {
  return new BackendAIClient(config);
}
