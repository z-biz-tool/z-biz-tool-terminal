/**
 * AI 状态管理
 *
 * 配置真源在后端 config.json 的 `ai` 段(apiKey 密文落盘),
 * 这里只缓存进程内明文副本供请求时使用。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AIConfig, AIProvider } from '../types/ai';

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048,
};

/** 各家 provider 的默认 endpoint 与模型；custom 不自带 baseUrl（用户必须填） */
export const PROVIDER_PRESETS: Record<AIProvider, Partial<AIConfig>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  claude: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20240620' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2' },
  custom: {},
};

/**
 * 切换 provider 时一并换掉 baseUrl/model。
 * 只改 provider 字段会让请求带着 openai 的 baseUrl/model 打到 claude 上, 必然失败；
 * 用户手填过的非默认值则保留。
 */
export function withProvider(config: AIConfig, provider: AIProvider): AIConfig {
  const preset = PROVIDER_PRESETS[provider];
  const isPreset = (value: string | undefined, field: 'baseUrl' | 'model') =>
    !value || Object.values(PROVIDER_PRESETS).some((p) => p[field] === value);
  return {
    ...config,
    provider,
    baseUrl: isPreset(config.baseUrl, 'baseUrl') ? preset.baseUrl ?? config.baseUrl : config.baseUrl,
    model: isPreset(config.model, 'model') ? preset.model ?? config.model : config.model,
  };
}

interface TerminalAIStore {
  config: AIConfig;
  /** 后端配置是否已加载完成; 未完成时不应覆盖已保存的 Key */
  loaded: boolean;
  updateConfig: (partial: Partial<AIConfig>) => void;
  loadFromStorage: () => Promise<void>;
  save: () => Promise<boolean>;
}

export const useAIStore = create<TerminalAIStore>((set, get) => ({
  config: DEFAULT_AI_CONFIG,
  loaded: false,

  updateConfig: (partial) =>
    set((state) => ({ config: { ...state.config, ...partial } })),

  /** 从后端读取配置(apiKey 由后端解密后返回明文, 只存在于内存) */
  loadFromStorage: async () => {
    try {
      const stored = await invoke<Partial<AIConfig> | null>('get_ai_config');
      if (stored) set({ config: { ...DEFAULT_AI_CONFIG, ...stored } });
    } catch (e) {
      console.error('读取 AI 配置失败:', e);
    } finally {
      set({ loaded: true });
    }
  },

  /** 写回后端; 未加载完成前拒绝写入, 避免默认值覆盖已保存的 Key */
  save: async () => {
    if (!get().loaded) {
      console.error('AI 配置尚未加载完成, 本次保存已忽略');
      return false;
    }
    try {
      await invoke('save_ai_config', { config: get().config });
      return true;
    } catch (e) {
      console.error('保存 AI 配置失败:', e);
      return false;
    }
  },
}));
