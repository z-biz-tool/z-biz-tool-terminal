// AI 配置判据（2026-10-31）：前端与后端 cap-llm 的免密钥判定必须同序。
//
// ## 为什么要有这条
//
// 后端 cap-llm 的 `LlmConfig::needs_api_key()` 已经统一了免密钥判定。
// 前端也得判同一件事（AI 入口要不要放行、密钥框要不要藏），否则出现
// **判据分裂**：后端放行、前端拦下 ⇒ 用户看到「本地网关配了却用不了」，
// 而**没有任何编译错误**能暴露它。
//
// 金标：Rust `cap_llm::is_private_endpoint()` 与 `LlmConfig::needs_api_key()`。
// 前端判据是 shared 包 `needsApiKey()`，它是 Rust 侧的逐条镜像。
//
// ## 契约
//
// 1. 选了「免 Key」的预设（zbiz-local / ollama）→ 免；
// 2. 选了「要 Key」的预设 → 要，**哪怕地址被改成本机代理**
//    （用户显式选的厂商优先于地址猜测）；
// 3. 没匹配到预设 → 看地址：私网免、公网要。
//
// 第 2 条最容易被写反：只判「预设说不免」而不判「预设说要」，
// 会让「选了 DeepSeek 但地址指向本机代理」被私网规则救掉，
// 于是请求没带鉴权头发出去、拿到 401，而用户完全不知道为什么。
import { isAIConfigured } from "../src/stores/aiStore";
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

const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(what);
};

const preset = (id: string, requiresApiKey: boolean, aliases: string[] = []): PresetView => ({
  id,
  label: id,
  base_url: "http://127.0.0.1:8200/v1",
  category: "selfHosted",
  category_label: "自建 / 本地",
  requires_api_key: requiresApiKey,
  aliases,
  verified_on: "2026-10-31",
});

const cfg = (over: Partial<AIConfig> = {}): AIConfig => ({
  provider: "custom",
  apiKey: "",
  baseUrl: "http://192.168.31.249:8200/v1",
  model: "zBiz-Text-35B",
  temperature: 0.7,
  maxTokens: 2048,
  ...over,
});

const PRESETS: PresetView[] = [
  preset("zbiz-local", false, ["zbiz", "本地网关", "智工栈"]),
  preset("ollama", false, []),
  preset("deepseek", true, []),
];

await t("本地网关预设：免 Key，放行", () => {
  eq(isAIConfigured(cfg({ provider: "zbiz-local" }), PRESETS), true);
});

await t("本地网关预设：按中文别名也能认出来", () => {
  eq(isAIConfigured(cfg({ provider: "本地网关" }), PRESETS), true);
});

await t("直接粘 mini 的局域网地址（没选预设）：免 Key，放行", () => {
  eq(isAIConfigured(cfg(), PRESETS), true);
});

await t("公网地址且无 Key：不放行", () => {
  eq(isAIConfigured(cfg({ baseUrl: "https://api.openai.com/v1" }), PRESETS), false);
});

await t("选了要 Key 的云厂商：即便地址是本机代理也不放行", () => {
  // 第 2 条契约的反向约束 —— 放行的话请求会没带鉴权头发出去、拿到 401。
  eq(
    isAIConfigured(cfg({ provider: "deepseek", baseUrl: "http://127.0.0.1:8200/v1" }), PRESETS),
    false,
  );
});

await t("有 Key 时一律放行（脱敏视图的 hasApiKey）", () => {
  eq(isAIConfigured(cfg({ hasApiKey: true, baseUrl: "https://api.openai.com/v1" }), PRESETS), true);
});

await t("阴性对照：同一判据对私网与公网必须给出相反结论", () => {
  // 判据被改成永真时这条立刻红。而恒真的判据会让本地网关用户被静默放行、
  // 公网用户被静默拦下 —— 两种故障都不会有人来报。
  const priv = isAIConfigured(cfg(), PRESETS);
  const pub = isAIConfigured(cfg({ baseUrl: "https://api.openai.com/v1" }), PRESETS);
  ok(priv !== pub, "私网与公网必须给出相反结论");
  eq(priv, true);
  eq(pub, false);
});

await t("判据不吃 provider 字符串的其它写法（未知厂商退回按地址判）", () => {
  // 没登记过的 provider 名不该被当成「已知厂商」而误判。
  eq(isAIConfigured(cfg({ provider: "some-unknown-llm" }), PRESETS), true);
});

console.log(`\nAI 配置判据  PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exit(1);
