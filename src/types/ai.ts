/**
 * AI 类型定义
 *
 * 这里的 AIConfig 描述的是 services/aiClient.ts 里各 provider 客户端实际读取的字段,
 * 因此由终端侧持有, 不从 z-biz-tool-shared 复用(共享包的 AIConfig 只有 modelName,
 * 且其 AIManager 仅实现了 openai 一种传输, 无法满足 claude/gemini/ollama)。
 */

/**
 * 支持的 AI 提供商标识。
 *
 * 2026-10-28 起**放宽为 string**：供应商预设（cap-llm::presets，17 条）的
 * `id` 直接回写这里（"deepseek" / "qwen" / "kimi" …），不再受一份前端
 * 枚举的约束 —— 加一家厂商只改后端预设表，前端下拉自动出现（家族设计文档 05 R1）。
 * 历史取值（openai / claude / gemini / ollama / custom / minimax）仍是合法字符串。
 * 后端 `provider_kind` 对所有未知字符串退回 OpenAI 兼容协议族，不会报「未知 provider」。
 */
export type AIProvider = string;

/** 后端 `list_llm_presets` 返回的单一事实源（前端不再存第二份表） */
export interface PresetView {
  /** 稳定机器标识，直接写回 config.provider */
  id: string;
  /** 展示名（中文） */
  label: string;
  /** 已填好的服务地址 */
  base_url: string;
  /** 分组键：international / domestic / aggregator / selfHosted */
  category: string;
  /** 分组展示名 */
  category_label: string;
  /** 是否需要 API Key（Ollama 类为 false，界面据此隐藏密钥框） */
  requires_api_key: boolean;
  /** 搜索别名（英文名、旧称） */
  aliases: string[];
  /** 地址核对日期，提示「这条预设是不是很老了」 */
  verified_on: string;
}

/** 后端 `test_ai_config` / `list_llm_models` 返回的结构化失败（家族设计文档 05 R5） */
export interface LlmFailure {
  /** 机器可判的类别：notConfigured / network / timeout / http / parse / unsupported / io */
  kind: string;
  /** HTTP 状态码（仅 kind == "http" 时非空） */
  status: number | null;
  /** 原始错误（已脱敏、已截断），给想知道细节的用户 */
  message: string;
  /** 一句话动机 + 一个动作，给只想让它能用的用户 */
  hint: string;
}

/** AI 配置 */
export interface AIConfig {
  provider: AIProvider;
  /**
   * 2026-10-26 起为**脱敏视图**：后端 `get_ai_config` / `get_config` 返回的
   * apiKey 恒为空串，明文 key 不再回传 webview（是否已配置看 `hasApiKey`）。
   * 非空值只出现在设置表单录入/修改的那一刻，随 `save_ai_config` 直达后端。
   */
  apiKey: string;
  /** 后端是否已保存 key（脱敏视图的判空依据；本地未加载时为 undefined） */
  hasApiKey?: boolean;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** AI 消息类型 */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /**
   * 本轮 AI 触发的工具调用轨迹（仅 assistant 消息可能有）。
   *
   * 单独一个字段而不是把工具输出塞进 `content` —— 工具输出是**证据**，
   * 模型的回答是**结论**。混在一起就没法折叠、也没法让用户核对
   * 「AI 到底看到了什么才这么答」。
   */
  toolCalls?: AIToolCall[];
}

/**
 * 一次工具调用（与后端 Rust `ai_tools::ToolCallRecord` 对齐）。
 *
 * 后端用 camelCase 序列化，这里字段名与之逐字对应。
 */
export interface AIToolCall {
  /** 模型请求的工具名 */
  name: string;
  /** 模型给的参数（后端已容错解析；非法时是原始字符串） */
  arguments: unknown;
  /** 是否执行成功 */
  ok: boolean;
  /** 结果摘要或错误原因 */
  output: string;
  /** 第几轮执行的（从 1 开始） */
  round: number;
}

/** 后端 `ai_chat_with_tools` 的返回 */
export interface AIToolChatResult {
  /** 模型的最终回答 */
  content: string;
  /** 期间发生的全部工具调用 */
  toolCalls: AIToolCall[];
  /** 是否因达到轮次上限而被截断 */
  hitRoundLimit: boolean;
  /** 实际发生的轮次 */
  rounds: number;
}

/** AI 聊天会话 */
export interface AISession {
  id: string;
  title: string;
  messages: AIMessage[];
  lastMessageAt: number;
}

/** 命令解释结果 */
export interface CommandExplanation {
  command: string;
  description: string;
  parameters: Array<{ name: string; description: string }>;
  example: string;
  warnings?: string[];
}

/** 错误分析结果 */
export interface ErrorAnalysis {
  errorMessage: string;
  rootCause: string;
  solutions: string[];
  预防措施?: string[];
}

/** 非流式对话参数 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/** 流式对话参数 */
export interface StreamOptions extends ChatOptions {
  /** 中止信号：取消必须真的断开连接，而不是只改前端状态 */
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/** 工具模式对话参数 */
export interface ToolChatOptions extends ChatOptions {
  /**
   * 当前活跃的 SSH 会话 id。
   *
   * 由前端从**既有** store 解析（`pickActiveSession` / `pickTabSession`）后传入，
   * 后端按现有会话表路由 —— 不在前端另造连接管理，也不把 serverId/tabId
   * 传下去让后端自己猜（后端只认 session_id）。
   */
  sessionId?: string;
}

/** AI 服务接口 */
export interface AIClient {
  chat: (messages: AIMessage[], options?: ChatOptions) => Promise<string>;

  /** 流式对话：逐段回调 delta，resolve 时为完整文本 */
  chatStream: (messages: AIMessage[], options: StreamOptions) => Promise<string>;

  /**
   * 工具调用对话：模型可调用 terminal 的只读 SSH/SFTP 能力。
   *
   * 非流式 —— cap-llm 的流式接口当前不带工具集（见 AI_FEATURES.md）。
   */
  chatWithTools: (messages: AIMessage[], options?: ToolChatOptions) => Promise<AIToolChatResult>;

  explainCommand: (command: string) => Promise<CommandExplanation>;
  
  analyzeError: (error: string) => Promise<ErrorAnalysis>;
  
  commandFromNaturalLanguage: (text: string) => Promise<string>;
}
