import type {
  AIMessage,
  AIClient,
  AIConfig,
  ChatOptions,
  CommandExplanation,
  ErrorAnalysis,
  StreamOptions,
} from "../types/ai";

/** 请求参数：公开选项 + 内部流式/中止控制 */
type RequestParams = ChatOptions & { stream?: boolean; signal?: AbortSignal };

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

/**
 * AI 客户端基础类
 */
export abstract class AIClientBase implements AIClient {
  protected config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  /**
   * provider 的 endpoint / 鉴权差异都收敛在这里，返回最终 url；`custom` 走 OpenAI 兼容协议。
   */
  protected buildRequest(stream: boolean): { url: string; headers: Record<string, string> } {
    const { provider, apiKey, baseUrl, model } = this.config;
    // 四个 provider 的 url 都以 baseUrl 为基准，空值会拼出 "undefined/..." 这种请求
    if (!baseUrl) throw new Error("请先在 AI 设置里填写 Base URL");
    
    // 各 provider 的 endpoint 与鉴权方式不同, 不能都套 OpenAI 的 /chat/completions
    let url = `${baseUrl}/chat/completions`;
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // 根据提供商设置认证头
    if (provider === "openai" || provider === "custom") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider === "claude") {
      url = `${baseUrl}/messages`;
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      // 从 WebView 直连 Anthropic 必须显式声明, 否则预检被 CORS 拦掉
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else if (provider === "gemini") {
      // Key 走 header: 拼进 URL query 会落到网关/服务端访问日志里（P-4）
      url = `${baseUrl}/v1beta/models/${model}:generateContent`;
      headers["x-goog-api-key"] = apiKey;
    } else if (provider === "ollama") {
      url = `${baseUrl}/api/chat`;
    }

    if (stream) url = this.streamEndpoint(url);
    return { url, headers };
  }

  protected async requestAI(messages: AIMessage[], options?: RequestParams): Promise<Response> {
    const stream = options?.stream ?? false;
    const { url, headers } = this.buildRequest(stream);
    const body = this.buildRequestBody(messages, options);

    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
  }

  /** 流式 endpoint: 只有 gemini 需要改写, 其余 provider 同一 URL 靠 body 里的 stream 区分 */
  protected streamEndpoint(url: string): string {
    return url;
  }

  protected abstract buildRequestBody(messages: AIMessage[], options?: RequestParams): any;

  async chat(messages: AIMessage[], options?: ChatOptions): Promise<string> {
    const response = await this.requestAI(messages, { ...options, stream: false });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return this.extractContent(data);
  }

  /**
   * 流式对话。此前 chat() 只有 stream:false 一条路径, 界面上的"实时流式"与"停止"
   * 都不成立（T-2-2）；这里按行切 SSE/NDJSON 事件, 逐段回调, 并把 abort 透传给 fetch。
   */
  async chatStream(messages: AIMessage[], options: StreamOptions): Promise<string> {
    const response = await this.requestAI(messages, { ...options, stream: true });
    if (!response.ok) {
      throw new Error(`AI API error: ${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("AI 服务未返回可流式读取的响应体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let full = "";
    const emit = (line: string) => {
      const delta = this.parseStreamLine(line);
      if (!delta) return;
      full += delta;
      options.onDelta?.(delta);
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        // 半行留在 pending 里等下一个 chunk, 否则跨 chunk 的事件会被截断丢掉
        emit(pending.slice(0, nl).trim());
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
      }
    }
    emit(pending.trim());
    return full;
  }

  /** 默认按 OpenAI/Claude 风格的 SSE 解析；ollama 的 NDJSON 由子类覆盖 */
  protected parseStreamLine(line: string): string {
    if (!line.startsWith("data:")) return "";
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return "";
    try {
      return this.extractDelta(JSON.parse(payload));
    } catch {
      return "";
    }
  }

  protected abstract extractContent(data: any): string;

  /** 从单个流式事件里取出增量文本, 非文本事件返回空串 */
  protected abstract extractDelta(chunk: any): string;

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
 * OpenAI 客户端
 */
export class OpenAIClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: RequestParams): any {
    return {
      model: this.config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stream: options?.stream ?? false,
    };
  }

  protected extractContent(data: any): string {
    return data.choices[0].message.content;
  }

  protected extractDelta(chunk: any): string {
    return chunk.choices?.[0]?.delta?.content ?? "";
  }
}

/**
 * Anthropic Claude 客户端
 */
export class ClaudeClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: RequestParams): any {
    // 将 messages 转换为 Claude 格式
    const systemMessage = messages.find(m => m.role === "system");
    
    let body: any = {
      model: this.config.model,
      messages: messages.filter(m => m.role !== "system").map(m => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stream: options?.stream ?? false,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    return body;
  }

  protected extractContent(data: any): string {
    return data.content[0]?.text || "";
  }

  protected extractDelta(chunk: any): string {
    // claude 的事件类型很多(message_start/ping/…), 只有 content_block_delta 带正文
    return chunk.type === "content_block_delta" ? chunk.delta?.text ?? "" : "";
  }
}

/**
 * Google Gemini 客户端
 */
export class GeminiClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected streamEndpoint(url: string): string {
    // gemini 靠 endpoint 区分流式, 而不是 body 里的 stream 字段; alt=sse 才是 text/event-stream
    return url.replace(":generateContent", ":streamGenerateContent?alt=sse");
  }

  protected buildRequestBody(messages: AIMessage[], options?: RequestParams): any {
    const systemMessage = messages.find(m => m.role === "system");
    const contents = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let body: any = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? this.config.temperature,
        maxOutputTokens: options?.maxTokens ?? this.config.maxTokens,
      },
    };

    if (systemMessage) {
      body.systemInstructions = {
        parts: [{ text: systemMessage.content }],
      };
    }

    return body;
  }

  protected extractContent(data: any): string {
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  protected extractDelta(chunk: any): string {
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts.map((p: any) => p.text ?? "").join("");
  }
}

/**
 * Ollama 客户端
 */
export class OllamaClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: RequestParams): any {
    return {
      model: this.config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      // /api/chat 的采样参数在 options 里, 顶层同名字段会被忽略
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        num_predict: options?.maxTokens ?? this.config.maxTokens,
      },
      stream: options?.stream ?? false,
    };
  }

  /** ollama 流式是换行分隔的裸 JSON, 不是 SSE; 经网关代理时才可能带 data: 前缀 */
  protected parseStreamLine(line: string): string {
    if (!line) return "";
    if (line.startsWith("data:")) return super.parseStreamLine(line);
    try {
      return this.extractDelta(JSON.parse(line));
    } catch {
      return "";
    }
  }

  protected extractContent(data: any): string {
    return data.message?.content || "";
  }

  protected extractDelta(chunk: any): string {
    if (chunk.done) return "";
    return chunk.message?.content ?? "";
  }
}

/**
 * 工厂函数：根据配置创建客户端
 */
export function createAIClient(config: AIConfig): AIClient {
  switch (config.provider) {
    case "openai":
      return new OpenAIClient(config);
    case "claude":
      return new ClaudeClient(config);
    case "gemini":
      return new GeminiClient(config);
    case "ollama":
      return new OllamaClient(config);
    default:
      return new OpenAIClient(config);
  }
}
