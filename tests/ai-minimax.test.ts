// 供应商预设联动与「不写死模型名」契约（2026-10-28 起预设唯一事实源在后端）
//
// 前端不再保留 PROVIDER_PRESETS / PROVIDER_PLACEHOLDERS / withProvider 第二份表：
// 预设由后端 list_llm_presets 提供（家族设计文档 05 R1），界面选中时调用
// applyPreset 做字段联动。本文件钉住联动规则（R2）与「模型名不写死」（R4 前半条）。
//
// 端点连通性（如 MiniMax 是否可达）已不在前端测试覆盖范围内 —— 传输层在 Rust
// ai.rs + cap-llm，前端断言只会测到空气。
import { applyPreset, DEFAULT_AI_CONFIG, isAIConfigured } from "../src/stores/aiStore";
import type { AIConfig, PresetView } from "../src/types/ai";

let pass = 0,
  fail = 0;

async function t(name: string, fn: () => unknown) {
  try {
    await fn();
    pass++;
    console.log("  ok  ", name);
  } catch (e) {
    fail++;
    console.log("  FAIL", name, "\n       ", (e as Error).message);
  }
}
const eq = <T,>(a: T, b: T, what = "") => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};

const base: AIConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "my-model",
  temperature: 0.7,
  maxTokens: 2048,
};

/** 后端的 PresetView 形状（与 Rust PresetView 序列化一致） */
const minimaxPreset: PresetView = {
  id: "minimax",
  label: "MiniMax",
  base_url: "https://api.minimaxi.com/v1",
  category: "international",
  category_label: "国际",
  requires_api_key: true,
  aliases: ["minimax"],
  verified_on: "2026-10-28",
};

await t("applyPreset 选中厂商 → provider 与 baseUrl 跟着走（R2）", () => {
  const next = applyPreset(base, minimaxPreset);
  eq(next.provider, "minimax", "provider");
  eq(next.baseUrl, "https://api.minimaxi.com/v1", "baseUrl");
  // 不写死模型名：预设不改写用户已填的模型（模型名由「获取模型列表」现取）
  eq(next.model, "my-model", "model 不被预设改写");
});

await t("applyPreset 选「自定义」→ 保留现有地址作为起点（R2 例外）", () => {
  const next = applyPreset(base, "custom");
  eq(next.provider, "custom", "provider");
  eq(next.baseUrl, "https://api.openai.com/v1", "baseUrl 保留");
});

await t("DEFAULT_AI_CONFIG 不写死模型名（R4：模型名半年换代）", () => {
  eq(DEFAULT_AI_CONFIG.model, "", "默认模型名应为空");
  if (!DEFAULT_AI_CONFIG.baseUrl) throw new Error("默认应有可用的地址作为起点");
});

await t("isAIConfigured 以 hasApiKey 为准（key 不回传 webview）", () => {
  eq(isAIConfigured({ ...base, apiKey: "", hasApiKey: true }), true, "hasApiKey=true");
  eq(isAIConfigured({ ...base, apiKey: "", hasApiKey: false }), false, "hasApiKey=false");
  // 未加载（hasApiKey 缺省）时退回看 apiKey 本身
  eq(isAIConfigured({ ...base, apiKey: "sk-x" }), true, "回退看 apiKey");
});

console.log(
  "  skip 真实 API 实测 —— 传输层已迁到 Rust（cap-llm），前端测试触达不到；这是「没跑」，不是「跑过了」"
);
console.log(`\n[minimax] PASS ${pass} / FAIL ${fail} / SKIP 1`);
process.exit(fail ? 1 : 0);
