/**
 * AI 状态管理 - 使用统一的 AI 中台
 */

import { create } from 'zustand';
import { useAIManager } from 'z-biz-tool-shared/ai';

interface TerminalAIStore {
  // 原有配置保持兼容
  config: {
    provider: 'openai' | 'claude' | 'gemini' | 'ollama' | 'custom';
    apiKey: string;
    baseUrl?: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  
  // 设置配置
  setConfig: (config: TerminalAIStore['config']) => void;
  
  // 更新配置
  updateConfig: (partial: Partial<TerminalAIStore['config']>) => void;
  
  // 从 AI 中台同步配置
  syncFromCore: () => void;
  
  // 同步到 AI 中台
  syncToCore: () => void;
}

export const useTerminalAIStore = create<TerminalAIStore>((set, get) => ({
  config: {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2048
  },

  setConfig: (config) => {
    set({ config });
    get().syncToCore();
  },

  updateConfig: (partial) => {
    set((state) => ({
      config: { ...state.config, ...partial }
    }));
    get().syncToCore();
  },

  syncFromCore: () => {
    // 从 AI 中台读取配置
    const coreConfig = useAIManager.getState().config;
    
    if (coreConfig.provider) {
      set((state) => ({
        config: {
          ...state.config,
          provider: coreConfig.provider as any,
          model: coreConfig.modelName,
          temperature: coreConfig.temperature ?? 0.7,
          maxTokens: coreConfig.maxTokens ?? 2048
        }
      }));
    }
  },

  syncToCore: () => {
    // 同步到 AI 中台
    useAIManager.getState().updateConfig({
      provider: get().config.provider,
      modelName: get().config.model,
      temperature: get().config.temperature,
      maxTokens: get().config.maxTokens,
      baseUrl: get().config.baseUrl,
      apiKey: get().config.apiKey
    });
  }
}));

// 持久化存储
export const loadAIConfig = (): TerminalAIStore['config'] => {
  if (typeof window === 'undefined') return getDefaultConfig();
  
  try {
    const stored = window.localStorage.getItem('z-terminal:ai-config');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load AI config:', e);
  }
  
  return getDefaultConfig();
};

export const saveAIConfig = (config: TerminalAIStore['config']) => {
  if (typeof window === 'undefined') return;
  
  try {
    window.localStorage.setItem('z-terminal:ai-config', JSON.stringify(config));
    // 同步到 AI 中台
    useAIManager.getState().updateConfig({
      provider: config.provider,
      modelName: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey
    });
  } catch (e) {
    console.error('Failed to save AI config:', e);
  }
};

const getDefaultConfig = (): TerminalAIStore['config'] => ({
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048
});
