/**
 * AI 客户端兼容层
 * 这个文件保持旧的 API，内部调用统一的 AI 中台
 */

import { AIClientBase, OpenAIClient, ClaudeClient, GeminiClient, OllamaClient, createAIClient } from './aiClient';
import type { AIConfig, AIMessage } from './types';
import { useAIManager } from 'z-biz-tool-shared/ai';

/**
 * 封装统一 AI 中台，提供旧版 API
 */
export class UnifiedAIClient extends AIClientBase {
  constructor(config: AIConfig) {
    super(config);
  }

  // 聊天（流式）
  async chat(messages: AIMessage[], options?: { stream?: boolean; temperature?: number; maxTokens?: number }): Promise<string | ReadableStream> {
    // 转换为统一 AI 中台的格式
    const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    
    const result = await useAIManager.getState().executeAI('chat', { prompt, messages });
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    return result.content;
  }

  // 解释命令
  async explainCommand(command: string) {
    const result = await useAIManager.getState().executeAI('explain', { text: command });
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    // 解析 JSON 结果
    try {
      return JSON.parse(result.content);
    } catch {
      return {
        command,
        description: result.content,
        parameters: [],
        example: '',
        warnings: []
      };
    }
  }

  // 分析错误
  async analyzeError(error: string) {
    const result = await useAIManager.getState().executeAI('analyze', { text: error });
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    try {
      return JSON.parse(result.content);
    } catch {
      return {
        errorMessage: error,
        rootCause: result.content,
        solutions: [],
        预防措施: []
      };
    }
  }

  // 自然语言转命令
  async commandFromNaturalLanguage(text: string): Promise<string> {
    const result = await useAIManager.getState().executeAI('natural-language', { text });
    
    if (!result.success) {
      throw new Error(result.error);
    }
    
    return result.content.trim();
  }
}

// 导出兼容的工厂函数
export function createCompatibleAIClient(config: AIConfig): AIClientBase {
  // 创建统一客户端
  const unifiedClient = new UnifiedAIClient(config);
  
  // 如果需要特定提供商的优化，可以根据 provider 返回不同的实例
  switch (config.provider) {
    case 'openai':
      return new OpenAIClient(config);
    case 'claude':
      return new ClaudeClient(config);
    case 'gemini':
      return new GeminiClient(config);
    case 'ollama':
      return new OllamaClient(config);
    default:
      return unifiedClient;
  }
}
