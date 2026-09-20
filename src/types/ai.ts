/**
 * AI 类型定义 - 兼容旧版和新版
 */

import type { 
  AIProvider as CoreAIProvider, 
  AIFunctionType as CoreAIFunctionType,
  AIConfig as CoreAIConfig
} from 'z-biz-tool-shared/ai/types';

// 保持向后兼容的类型定义
export type AIProvider = CoreAIProvider;
export type AIFunctionType = CoreAIFunctionType;
export type AIConfig = CoreAIConfig;

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

/** AI 服务接口 */
export interface AIClient {
  chat: (messages: AIMessage[], options?: {
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<string | ReadableStream>;
  
  explainCommand: (command: string) => Promise<CommandExplanation>;
  
  analyzeError: (error: string) => Promise<ErrorAnalysis>;
  
  commandFromNaturalLanguage: (text: string) => Promise<string>;
}
