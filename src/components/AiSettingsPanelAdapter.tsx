/**
 * 统一 AI 配置面板的**本仓适配层**。
 *
 * ## 这一层只做三件事
 *
 * 1. 把本仓的 Tauri IPC 包成共享面板认得的 `actions` 接口；
 * 2. 把本仓的配置字段名（`provider` / `baseUrl` / `apiKey`）翻译成
 *    共享面板的草稿结构；
 * 3. 把后端的结构化失败原样透传 —— **不重新翻译错误文案**。
 *
 * ## 为什么第③条重要
 *
 * 错误文案是后端给的（`LlmFailure.hint` 与 `focus` 必须一致）。
 * 前端再翻译一遍就会漂移，而漂移的表现是「提示说去改密钥，
 * 光标却跳到地址栏」—— 用户按提示操作但没用。
 *
 * ## 与其它仓的关系
 *
 * 这个文件是**样板**。其余仓的适配层照抄它，只改三处：
 * IPC 命令名、配置字段名、失败结构的字段名。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  AiSettingsPanel,
  type AiConfigDraft,
  type AiSettingsActions,
  type AiSettingsPanelProps,
  type LlmFailure,
  type PresetView,
} from "z-biz-tool-shared/ai/settings";

import type { AIConfig } from "../types/ai";

/**
 * 草稿 → 本仓配置形状（送 IPC 用）。
 *
 * 注意 `apiKey` 透传：面板只在用户**本次输入**时才有非空值，
 * 留空表示继承已保存的密钥 —— 这与后端 `save_ai_config` 的语义一致。
 */
function draftToConfig(draft: AiConfigDraft): AIConfig {
  return {
    provider: draft.preset || draft.baseUrl ? draft.preset : "",
    apiKey: draft.apiKey,
    baseUrl: draft.baseUrl,
    model: draft.model,
    temperature: draft.temperature ?? 0.7,
    maxTokens: draft.maxTokens ?? 2048,
  };
}

/** 后端失败 → 共享面板的失败结构。字段名一致，直接透传。 */
function toPanelFailure(raw: unknown): LlmFailure {
  const f = (raw ?? {}) as Partial<LlmFailure> & {
    error?: string;
    message?: string;
  };
  return {
    kind: f.kind ?? "unknown",
    status: f.status ?? null,
    message: f.message ?? f.error ?? "未知错误",
    hint: f.hint ?? "",
    focus: (f.focus as LlmFailure["focus"]) ?? "none",
  };
}

/**
 * 本仓的 actions 实现。
 *
 * 每个方法都**不吞异常**：异常必须冒到面板，由面板统一渲染成
 * 结构化失败。吞掉异常 = 用户看到「操作没反应」。
 */
export function createAiSettingsActions(): AiSettingsActions {
  return {
    async listPresets(): Promise<PresetView[]> {
      const list = await invoke<PresetView[]>("list_llm_presets");
      return Array.isArray(list) ? list : [];
    },

    async listModels(draft: AiConfigDraft): Promise<string[]> {
      try {
        const models = await invoke<string[]>("list_llm_models", {
          overrideConfig: draftToConfig(draft),
        });
        return Array.isArray(models) ? models : [];
      } catch (e) {
        throw toPanelFailure(e);
      }
    },

    async testConnection(draft: AiConfigDraft) {
      try {
        const detail = await invoke<string>("test_ai_config", {
          overrideConfig: draftToConfig(draft),
        });
        return { ok: true, detail };
      } catch (e) {
        return { ok: false, failure: toPanelFailure(e) };
      }
    },

    async save(draft: AiConfigDraft): Promise<boolean> {
      await invoke("save_ai_config", { config: draftToConfig(draft) });
      return true;
    },
  };
}

/**
 * 本仓的 AI 配置面板。
 *
 * props 与共享面板一致，另外接受本仓的 `config`（含 `hasApiKey`）。
 */
export function TerminalAiSettingsPanel({
  config,
  onSaved,
}: {
  config: AIConfig;
  onSaved?: () => void;
}) {
  const props: AiSettingsPanelProps = {
    value: {
      preset: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    },
    hasApiKey: config.hasApiKey === true,
    actions: createAiSettingsActions(),
    onSaved,
  };
  return <AiSettingsPanel {...props} />;
}
