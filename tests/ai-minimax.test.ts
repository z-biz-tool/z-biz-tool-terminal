// provider 预设与占位文案（2026-10-27 起传输层已迁到 Rust，前端不再拼请求）
//
// 本文件原来还钉「minimax 请求打哪个端点 / Bearer 头 / body 字段」——
// 那些代码在 ade92f0「AI key 不出后端」后已从前端删除，请求形态由
// Rust ai.rs + cap-llm 决定，前端断言只会测到空气。
// 真实端点连通性因此**不再有前端测试覆盖**，见 doc/优化方案 的未验项记录。
import { PROVIDER_PRESETS, withProvider, PROVIDER_PLACEHOLDERS } from "../src/stores/aiStore";

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

await t("PROVIDER_PRESETS 有 minimax 且 baseUrl 正确", () => {
  eq(PROVIDER_PRESETS.minimax.baseUrl, "https://api.minimaxi.com/v1", "baseUrl");
  eq(PROVIDER_PRESETS.minimax.model, "MiniMax-M3.1-Flash", "model");
});

await t("PROVIDER_PLACEHOLDERS 每个 provider 都有，且不含 Anthropic 误植", () => {
  for (const p of Object.keys(PROVIDER_PRESETS)) {
    if (!PROVIDER_PLACEHOLDERS[p]) throw new Error(`${p} 缺占位文案`);
  }
  eq(PROVIDER_PLACEHOLDERS.minimax.baseUrl, "https://api.minimaxi.com/v1", "minimax 占位");
  // 此前非 openai 的 provider 一律显示 Anthropic 地址 —— 那是骗人的占位符
  for (const p of ["gemini", "ollama", "custom", "minimax"]) {
    if (PROVIDER_PLACEHOLDERS[p].baseUrl.includes("anthropic.com"))
      throw new Error(`${p} 的占位符仍指向 Anthropic`);
  }
});

await t("withProvider 切到 minimax 会带上它的 baseUrl/model", () => {
  const next = withProvider(
    {
      provider: "openai",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 2048,
    },
    "minimax"
  );
  eq(next.provider, "minimax", "provider");
  eq(next.baseUrl, "https://api.minimaxi.com/v1", "baseUrl");
  eq(next.model, "MiniMax-M3.1-Flash", "model");
});

console.log(
  "  skip 真实 API 实测 —— 传输层已迁到 Rust（cap-llm），前端测试触达不到；这是「没跑」，不是「跑过了」"
);
console.log(`\n[minimax] PASS ${pass} / FAIL ${fail} / SKIP 1`);
process.exit(fail ? 1 : 0);
