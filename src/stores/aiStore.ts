/**
 * AI 状态管理
 *
 * 配置真源在后端 config.json 的 `ai` 段(apiKey 密文落盘),
 * 这里只缓存进程内明文副本供请求时使用。
 *
 * 2026-10-28 改造（家族设计文档 05）：
 * - 删掉前端第二份 provider 预设表（PROVIDER_PRESETS / PROVIDER_PLACEHOLDERS）。
 *   那张表与后端 `cap-llm::presets` 是「两份事实源」，一旦不同步就会出现
 *   「界面显示 DeepSeek、请求打向别处」这类最难查的故障。现在预设由
 *   `list_llm_presets` 从后端取（R1：单一事实源）。
 * - 模型名不再写死（R4）：默认留空，由「获取模型列表」现取，避免半年后
 *   用户拿到一个已关停的模型。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AIConfig, AIProvider, PresetView } from '../types/ai';

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  // 不再写死模型名：模型名半年换代，写死必过期（见设计文档 05 §3 ①）。
  // 用户通过「获取模型列表」现取，或手动填写。
  model: '',
  temperature: 0.7,
  maxTokens: 2048,
};

/**
 * 切换服务商时的字段联动（落实 R2：切换服务商 = 地址跟着走；「自定义」例外）。
 *
 * - 选某家厂商预设：provider = 预设 id，baseUrl = 预设里填好的标准地址。
 *   用户手改过的代理地址会被覆盖 —— 因为那个代理对新厂商毫无意义，
 *   留着它只会静默把请求打向一个不知道自己被用来问新厂商的代理（静默错路由比丢失输入严重得多）。
 * - 选「自定义」：保留现有 baseUrl 作为起点（让他当起点改），只换 provider。
 *
 * 模型名不在这里填：由「获取模型列表」现取，避免写死过期模型名。
 */
export function applyPreset(
  config: AIConfig,
  preset: PresetView | 'custom',
): AIConfig {
  if (preset === 'custom') {
    return { ...config, provider: 'custom' as AIProvider };
  }
  return {
    ...config,
    provider: preset.id as AIProvider,
    baseUrl: preset.base_url,
  };
}

/**
 * 是否已配置到可用。
 *
 * 2026-10-26 起 apiKey 是**脱敏视图**（恒空串），明文不再回传前端 ——
 * 判「已配置」用后端的 hasApiKey 布尔。hasApiKey 缺省（测试数据、未加载）
 * 时退回看 apiKey 本身，语义兼容。
 */
export function isAIConfigured(config: AIConfig): boolean {
  if (config.hasApiKey !== undefined) return config.hasApiKey;
  return Boolean(config.apiKey);
}

interface TerminalAIStore {
  config: AIConfig;
  /** 后端供应商预设（单一事实源，来自 `list_llm_presets`） */
  presets: PresetView[];
  /** 后端配置是否已加载完成; 未完成时不应覆盖已保存的 Key */
  loaded: boolean;
  updateConfig: (partial: Partial<AIConfig>) => void;
  loadFromStorage: () => Promise<void>;
  loadPresets: () => Promise<void>;
  save: () => Promise<boolean>;
}

export const useAIStore = create<TerminalAIStore>((set, get) => ({
  config: DEFAULT_AI_CONFIG,
  presets: [],
  loaded: false,

  updateConfig: (partial) =>
    set((state) => ({ config: { ...state.config, ...partial } })),

  /** 从后端读取配置（**脱敏视图**：apiKey 恒空串，hasApiKey 表达是否已配置） */
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

  /** 拉取供应商预设（界面下拉的唯一事实源；加一家厂商只改后端预设表） */
  loadPresets: async () => {
    try {
      const presets = await invoke<PresetView[]>('list_llm_presets');
      set({ presets });
    } catch (e) {
      console.error('读取供应商预设失败:', e);
    }
  },

  /** 写回后端；apiKey 为空串时后端继承已保存的 key（编辑其它字段不必重填） */
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
