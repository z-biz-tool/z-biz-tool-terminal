import type { AIMessage, AIClient, AIConfig, CommandExplanation, ErrorAnalysis } from "../types/ai";

/**
 * AI 客户端基础类
 */
export abstract class AIClientBase implements AIClient {
  protected config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  protected async requestAI(messages: AIMessage[], options?: {
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
  }): Promise<Response> {
    const { provider, apiKey, baseUrl, model } = this.config;
    
    let url = `${baseUrl}/chat/completions`;
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // 根据提供商设置认证头
    if (provider === "openai" || provider === "custom") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else if (provider === "claude") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") {
      url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;
    } else if (provider === "ollama") {
      headers["Content-Type"] = "application/json";
    }

    const body = this.buildRequestBody(messages, options);
    
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  protected abstract buildRequestBody(messages: AIMessage[], options?: any): any;

  async chat(messages: AIMessage[], options?: {
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string | ReadableStream> {
    const response = await this.requestAI(messages, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI API error: ${response.status} ${errorText}`);
    }

    if (options?.stream) {
      return response.body as ReadableStream;
    }

    const data = await response.json();
    return this.extractContent(data);
  }

  protected abstract extractContent(data: any): string;

  async explainCommand(command: string): Promise<CommandExplanation> {
    const prompt = `Please explain the following shell command:\n\nCommand: ${command}\n\nFormat as JSON:\n{\n  "description": "brief description",\n  "parameters": [\n    {"name": "param", "description": "description"}\n  ],\n  "example": "example usage",\n  "warnings": ["any warnings"]\n}`;
    
    const messages: AIMessage[] = [
      { role: "system", content: "You are a shell command expert. Answer in JSON format.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.3, maxTokens: 1000 });
    return JSON.parse(response as string);
  }

  async analyzeError(error: string): Promise<ErrorAnalysis> {
    const prompt = `Please analyze this error message and provide solutions:\n\nError: ${error}\n\nFormat as JSON:\n{\n  "rootCause": "root cause",\n  "solutions": ["solution 1", "solution 2"],\n  "预防措施": ["prevention steps"]\n}`;
    
    const messages: AIMessage[] = [
      { role: "system", content: "You are a debugging expert. Answer in JSON format.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.3, maxTokens: 1500 });
    return JSON.parse(response as string);
  }

  async commandFromNaturalLanguage(text: string): Promise<string> {
    const prompt = `Convert the following natural language request to a shell command:\n\nRequest: ${text}\n\nOutput only the shell command, no explanation.`;
    
    const messages: AIMessage[] = [
      { role: "system", content: "You are a shell command expert. Output only the command, no explanation.", timestamp: Date.now() },
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await this.chat(messages, { temperature: 0.2, maxTokens: 500 });
    return typeof response === 'string' ? response.trim() : "";
  }
}

/**
 * OpenAI 客户端
 */
export class OpenAIClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: any): any {
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
}

/**
 * Anthropic Claude 客户端
 */
export class ClaudeClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: any): any {
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
}

/**
 * Google Gemini 客户端
 */
export class GeminiClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: any): any {
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
    return data.candidates[0]?.content?.parts[0]?.text || "";
  }
}

/**
 * Ollama 客户端
 */
export class OllamaClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  protected buildRequestBody(messages: AIMessage[], options?: any): any {
    return {
      model: this.config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? this.config.temperature,
      num_predict: options?.maxTokens ?? this.config.maxTokens,
      stream: options?.stream ?? false,
    };
  }

  protected extractContent(data: any): string {
    return data.message?.content || "";
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
