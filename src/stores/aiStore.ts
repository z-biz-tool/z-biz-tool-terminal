/**
 * AI 状态管理
 *
 * 配置真源在后端 config.json 的 `ai` 段(apiKey 密文落盘),
 * 这里只缓存进程内明文副本供请求时使用。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AIConfig } from '../types/ai';

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048,
};

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
