// MiniMax provider 接入测试（2026-10-20）
//
// 分两部分：
//   A. 单测（桩 fetch，不联网）：钉「请求形态对不对」——
//      打的是不是 minimax 端点、有没有带 Bearer 头、body 字段对不对。
//   B. **真实 API 实测**（需要 MINIMAX_API_KEY）：钉「真连上去能不能跑通」——
//      桩测试恒绿也证明不了服务端认这个协议/这个 key。
//      没有 key 时**显式跳过并打印原因**，不静默通过。
//
// 跑法：
//   npm test                      # A 部分跑，B 部分显式跳过
//   MINIMAX_API_KEY=<key> npm test
import { OpenAIClient, createAIClient } from "../src/services/aiClient";
import { PROVIDER_PRESETS, withProvider, PROVIDER_PLACEHOLDERS } from "../src/stores/aiStore";

let pass = 0,
  fail = 0,
  skipped = 0;

// **真 fetch 必须在任何桩安装之前抓住。**
// 否则后面写 `globalThis.fetch = fetch` 里的裸标识符 `fetch` 解析到的
// 是**已经被桩替换掉的 globalThis.fetch** —— 等于把桩又装回去，
// live 用例于是「不报错」「耗时 0」，看起来像服务端的问题。
// 第一版就是这么写的，两条 live 用例当场红。
const REAL_FETCH = globalThis.fetch.bind(globalThis);

const cfg = {
  provider: "minimax",
  apiKey: "k",
  baseUrl: "https://api.minimaxi.com/v1",
  model: "MiniMax-M3.1-Flash",
  temperature: 0.2,
  maxTokens: 100,
};

let last = {};
function stubJson(payload, status = 200) {
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    return new Response(JSON.stringify(payload), { status });
  };
}

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  ok  ", name);
  } catch (e) {
    fail++;
    console.log("  FAIL", name, "\n       ", e.message);
  }
}
const eq = (a, b, what = "") => {
  if (a !== b)
    throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};

// ---------------------------------------------------------------- A. 单测

await t("minimax: 打 minimax 端点且带 Bearer 头", async () => {
  stubJson({ choices: [{ message: { content: "ok" } }] });
  const c = new OpenAIClient(cfg);
  eq(await c.chat([{ role: "user", content: "hi", timestamp: 0 }]), "ok", "content");
  eq(last.url, "https://api.minimaxi.com/v1/chat/completions", "url");
  eq(last.init.headers.Authorization, "Bearer k", "鉴权头");
  const body = JSON.parse(last.init.body);
  eq(body.model, "MiniMax-M3.1-Flash", "model");
  eq(body.messages[0].role, "user", "messages[0].role");
});

await t("minimax: 工厂产出的是 OpenAI 协议客户端（不是别的协议）", async () => {
  stubJson({ choices: [{ message: { content: "ok" } }] });
  const c = createAIClient(cfg);
  await c.chat([{ role: "user", content: "hi", timestamp: 0 }]);
  eq(last.url, "https://api.minimaxi.com/v1/chat/completions", "url");
});

await t("minimax: 不带鉴权头会把请求打空（回归钉：buildRequest 漏分支）", async () => {
  // 这一条是**反向钉**：把 provider 换成 minimax 但 key 为空，
  // 断言「Authorization 头仍然存在（值是 'Bearer '）」——
  // 若有人把 minimax 从 Bearer 分支里删掉，这里会红。
  stubJson({ choices: [{ message: { content: "ok" } }] });
  const c = new OpenAIClient({ ...cfg, apiKey: "" });
  await c.chat([{ role: "user", content: "hi", timestamp: 0 }]);
  if (!("Authorization" in last.init.headers))
    throw new Error("minimax 没有 Authorization 头 —— buildRequest 的分支漏了");
});

await t("PROVIDER_PRESETS 有 minimax 且 baseUrl 正确", () => {
  eq(PROVIDER_PRESETS.minimax.baseUrl, "https://api.minimaxi.com/v1", "baseUrl");
  eq(PROVIDER_PRESETS.minimax.model, "MiniMax-M3.1-Flash", "model");
});

await t("PROVIDER_PLACEHOLDERS 每个 provider 都有，且不含 Anthropic 误植", () => {
  for (const p of Object.keys(PROVIDER_PRESETS)) {
    if (!PROVIDER_PLACEHOLDERS[p]) throw new Error(`${p} 缺占位文案`);
  }
  eq(
    PROVIDER_PLACEHOLDERS.minimax.baseUrl,
    "https://api.minimaxi.com/v1",
    "minimax 占位"
  );
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

// ------------------------------------------------------- B. 真实 API 实测

const KEY = process.env.MINIMAX_API_KEY;

if (!KEY) {
  skipped = 2;
  console.log(
    "  skip 真实 API 实测（2 条）—— 未设置 MINIMAX_API_KEY；这是「没跑」，不是「跑过了」"
  );
} else {
  const live = {
    ...cfg,
    apiKey: KEY,
    baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3.1-Flash",
  };

  await t("LIVE minimax 真实端点：对话返回非空内容", async () => {
    globalThis.fetch = REAL_FETCH; // 换回真 fetch
    const c = new OpenAIClient(live);
    const started = Date.now();
    const out = await c.chat([
      { role: "user", content: "只回两个字：收到", timestamp: 0 },
    ]);
    if (typeof out !== "string" || out.length === 0)
      throw new Error(`返回为空：${JSON.stringify(out)}`);
    if (Date.now() - started <= 0) throw new Error("没有真实网络耗时");
    console.log(`         内容=${JSON.stringify(out.slice(0, 40))}`);
  });

  await t("LIVE minimax 真实端点：错误 key 被服务端拒（401）", async () => {
    globalThis.fetch = REAL_FETCH;
    const c = new OpenAIClient({ ...live, apiKey: "sk-cp-definitely-invalid-key" });
    let status = 0;
    let raw = "";
    try {
      await c.chat([{ role: "user", content: "hi", timestamp: 0 }]);
    } catch (e) {
      raw = String(e.message);
      // 本仓的错误格式是 `AI API error: <status> <body>`（不是 shared 的 `HTTP <status>`）
      status = Number(raw.match(/AI API error:\s*(\d+)/)?.[1] ?? 0);
    }
    if (status !== 401 && status !== 403)
      throw new Error(`期望 401/403，实际 ${status || "没报错"}：${raw.slice(0, 120)}`);
  });
}

console.log(`\n[minimax] PASS ${pass} / FAIL ${fail} / SKIP ${skipped}`);
process.exit(fail ? 1 : 0);
