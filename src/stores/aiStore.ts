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
import { needsApiKey } from 'z-biz-tool-shared/ai';
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
 *
 * ## 2026-10-31：判据与后端对齐（本地网关免密钥）
 *
 * 此前只看「有没有 key」⇒ 指向本地网关（`zbiz-local` 预设，或直接粘
 * mini 的 `http://192.168.x.x:8200/v1`）的用户，AI 入口全被挡住，
 * 提示「请先在设置中配置 API Key」—— 而设置页里后端**根本不要求**填 Key
 * （cap-llm 的 `needs_api_key()` 放行私网地址）。
 *
 * 于是出现判据分裂：后端放行、前端拦下。用户看到的是「本地网关配了却用不了」，
 * 且**没有任何编译错误**能暴露它。
 *
 * 现在判据与 Rust 侧 `LlmConfig::needs_api_key()` 严格同序：
 * ① 预设登记为免 Key → 免；② 预设登记为要 Key → 要（哪怕地址是本机）；
 * ③ 没匹配到预设 → 看地址，私网免、公网要。
 *
 * 私网判定复用 shared 包的 `needsApiKey()`，它是 Rust `is_private_endpoint()`
 * 的逐条镜像 —— 不在本仓另写一份（两处各写各的必然漂移）。
 */
export function isAIConfigured(config: AIConfig, presets: PresetView[] = []): boolean {
  const preset = presets.find(
    (p) => p.id === config.provider || p.aliases.includes(config.provider),
  );
  // 匹配到预设：按预设的登记（显式声明优先于地址猜测）
  //
  // 注意语义方向：`needsApiKey` 回答的是「**要不要** Key」，
  // 这里问的是「**是不是**配置好了」—— 两者相反，不能直接 return。
  if (preset) return !needsApiKey(preset.requires_api_key, config.baseUrl);
  // 没匹配到预设（自定义服务）：有 key 就算配置好了；
  // 没 key 时看地址 —— 私网上的自建服务没有鉴权层
  if (config.hasApiKey !== undefined) return config.hasApiKey;
  if (config.apiKey) return true;
  return !needsApiKey(undefined, config.baseUrl);
}

/**
 * 从 store 里取「AI 是否已配置到可用」的结论。
 *
 * 组件一律用这个 hook，别自己拼 `isAIConfigured(config)` ——
 * 漏传 presets 就会退回旧行为（只看 key），本地网关用户又��被挡住。
 */
export function useAIConfigured(): boolean {
  const config = useAIStore((s) => s.config);
  const presets = useAIStore((s) => s.presets);
  return isAIConfigured(config, presets);
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
