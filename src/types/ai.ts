/**
 * AI 类型定义
 *
 * 这里的 AIConfig 描述的是 services/aiClient.ts 里各 provider 客户端实际读取的字段,
 * 因此由终端侧持有, 不从 z-biz-tool-shared 复用(共享包的 AIConfig 只有 modelName,
 * 且其 AIManager 仅实现了 openai 一种传输, 无法满足 claude/gemini/ollama)。
 */

/**
 * 支持的 AI 提供商; custom 表示 OpenAI 兼容的自建网关
 *
 * 'minimax'：MiniMax 开放平台，**OpenAI 兼容**（与 custom 同协议），
 * 但作为**第一方 provider** 单列 —— 好给它自己的默认 baseUrl 与默认模型，
 * 用户点一下就能用，不必自己抄地址。2026-10-20 加入（实测端点连通）。
 */
export type AIProvider =
  | "openai"
  | "claude"
  | "gemini"
  | "ollama"
  | "custom"
  | "minimax";

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

/** AI 服务接口 */
export interface AIClient {
  chat: (messages: AIMessage[], options?: ChatOptions) => Promise<string>;

  /** 流式对话：逐段回调 delta，resolve 时为完整文本 */
  chatStream: (messages: AIMessage[], options: StreamOptions) => Promise<string>;

  explainCommand: (command: string) => Promise<CommandExplanation>;
  
  analyzeError: (error: string) => Promise<ErrorAnalysis>;
  
  commandFromNaturalLanguage: (text: string) => Promise<string>;
}
