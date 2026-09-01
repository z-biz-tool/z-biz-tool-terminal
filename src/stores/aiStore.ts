import { create } from "zustand";
import type { AIConfig, AIProvider } from "../types/ai";

interface AIStore {
  config: AIConfig;
  setConfig: (config: AIConfig) => void;
  updateConfig: (partial: Partial<AIConfig>) => void;
  getProvider: () => AIProvider;
  getModel: () => string;
}

export const useAIStore = create<AIStore>((set, get) => ({
  config: {
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 2048,
  },
  
  setConfig: (config) => set({ config }),
  
  updateConfig: (partial) => {
    set((state) => ({
      config: { ...state.config, ...partial },
    }));
  },
  
  getProvider: () => get().config.provider,
  
  getModel: () => get().config.model,
}));

// 持久化存储
export const loadAIConfig = (): AIConfig => {
  if (typeof window === "undefined") return getDefaultConfig();
  
  try {
    const stored = window.localStorage.getItem("z-terminal:ai-config");
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to load AI config:", e);
  }
  
  return getDefaultConfig();
};

export const saveAIConfig = (config: AIConfig) => {
  if (typeof window === "undefined") return;
  
  try {
    window.localStorage.setItem("z-terminal:ai-config", JSON.stringify(config));
  } catch (e) {
    console.error("Failed to save AI config:", e);
  }
};

const getDefaultConfig = (): AIConfig => ({
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 2048,
});
