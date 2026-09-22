import { OpenAIClient, ClaudeClient, GeminiClient, OllamaClient, parseJsonReply } from "../src/services/aiClient";

let pass = 0, fail = 0;
const cfg = { provider: "openai", apiKey: "k", baseUrl: "https://x.test/v1", model: "m", temperature: 0.2, maxTokens: 100 };

// 记录 fetch 收到的 url/signal/body
let last = {};
function stub(chunks, { delay = 0, abortAfter = null } = {}) {
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (abortAfter !== null && i >= abortAfter) {
          controller.error(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          return;
        }
        if (i >= chunks.length) { controller.close(); return; }
        const raw = chunks[i++];
        // 按 3 字节切片入队：复现"一条 SSE 事件被拆到多个网络包"的真实情况
        const bytes = encoder.encode(raw);
        for (let off = 0; off < bytes.length; off += 3) {
          controller.enqueue(bytes.slice(off, off + 3));
        }
        if (delay) return new Promise(r => setTimeout(r, delay));
      },
    });
    return new Response(body, { status: 200 });
  };
}

async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  ", name); }
  catch (e) { fail++; console.log("  FAIL", name, "\n       ", e.message); }
}
const eq = (a, b, what = "") => { if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const msg = (s) => [{ role: "user", content: s, timestamp: 0 }];

// ---- OpenAI 风格 SSE ----
await t("openai: 跨包拆分的 SSE 事件被完整重组", async () => {
  stub([
    'data: {"choices":[{"delta":{"content":"rm "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"-rf"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" /tmp"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const deltas = [];
  const full = await new OpenAIClient(cfg).chatStream(msg("hi"), { onDelta: d => deltas.push(d) });
  eq(full, "rm -rf /tmp", "full");
  eq(deltas.join(""), full, "deltas");
  eq(deltas.length, 3, "delta count");
});

await t("openai: 非正文/坏 JSON 事件不产生增量也不中断", async () => {
  stub([
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {trunc\n',
    ': keep-alive comment\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  ]);
  eq(await new OpenAIClient(cfg).chatStream(msg("hi"), {}), "ok");
});

await t("openai: 事件无换行收尾时尾包不丢", async () => {
  stub(['data: {"choices":[{"delta":{"content":"tail"}}]}']);
  eq(await new OpenAIClient(cfg).chatStream(msg("hi"), {}), "tail");
});

await t("openai: 请求带 stream:true 且透传 AbortSignal", async () => {
  stub(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n']);
  const ac = new AbortController();
  await new OpenAIClient(cfg).chatStream(msg("hi"), { signal: ac.signal });
  eq(last.init.stream, undefined, "stream 不进 fetch init");
  eq(last.init.signal, ac.signal, "signal");
  eq(JSON.parse(last.init.body).stream, true, "body.stream");
});

await t("openai: 中途 abort 时 chatStream 以 AbortError 失败", async () => {
  stub(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"b"}}]}\n\n'], { abortAfter: 1 });
  const got = [];
  try {
    await new OpenAIClient(cfg).chatStream(msg("hi"), { onDelta: d => got.push(d) });
    throw new Error("应当抛出");
  } catch (e) {
    if (e.message === "应当抛出") throw e;
    eq(e.name, "AbortError", "error name");
  }
  eq(got.join(""), "a", "已产出的增量保留");
});

await t("openai: HTTP 非 2xx 抛出带状态码的错误", async () => {
  globalThis.fetch = async () => new Response("slow down", { status: 429 });
  try {
    await new OpenAIClient(cfg).chatStream(msg("hi"), {});
    throw new Error("应当抛出");
  } catch (e) {
    if (e.message === "应当抛出") throw e;
    if (!/429/.test(e.message)) throw new Error(e.message);
  }
});

await t("openai: 无 body 时明确报错而不是静默返回空", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    await new OpenAIClient(cfg).chatStream(msg("hi"), {});
    throw new Error("应当抛出");
  } catch (e) {
    if (e.message === "应当抛出") throw e;
    if (!/响应体/.test(e.message)) throw new Error(e.message);
  }
});

// ---- Claude ----
await t("claude: 只取 content_block_delta, 忽略其它事件类型", async () => {
  stub([
    'event: message_start\ndata: {"type":"message_start","message":{"id":"x"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  const c = new ClaudeClient({ ...cfg, provider: "claude", baseUrl: "https://claude.test/v1" });
  eq(await c.chatStream(msg("hi"), {}), "hello");
  eq(last.url, "https://claude.test/v1/messages", "claude url");
});

// ---- Gemini ----
await t("gemini: 流式改写到 streamGenerateContent?alt=sse", async () => {
  stub(['data: {"candidates":[{"content":{"parts":[{"text":"g1"}],"role":"model"}}]}\n\n']);
  const c = new GeminiClient({ ...cfg, provider: "gemini", baseUrl: "https://gen.test" });
  eq(await c.chatStream(msg("hi"), {}), "g1");
  if (!c) throw new Error("unreachable");
  eq(last.url, "https://gen.test/v1beta/models/m:streamGenerateContent?alt=sse", "url");
});

await t("gemini: 一个事件多个 part 时全部拼接", async () => {
  stub(['data: {"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}\n\n']);
  const c = new GeminiClient({ ...cfg, provider: "gemini", baseUrl: "https://gen.test" });
  eq(await c.chatStream(msg("hi"), {}), "ab");
});

// ---- Ollama NDJSON ----
await t("ollama: 裸 JSON 行按 NDJSON 解析, done 行不产出正文", async () => {
  stub([
    '{"message":{"role":"assistant","content":"o1"},"done":false}\n',
    '{"message":{"role":"assistant","content":"o2"},"done":false}\n',
    '{"message":{"role":"assistant","content":""},"done":true,"total_duration":1}\n',
  ]);
  const c = new OllamaClient({ ...cfg, provider: "ollama", baseUrl: "http://127.0.0.1:11434" });
  eq(await c.chatStream(msg("hi"), {}), "o1o2");
  eq(last.url, "http://127.0.0.1:11434/api/chat", "ollama url");
});

await t("ollama: 也接受经网关包了一层 data: 的行", async () => {
  stub(['data: {"message":{"content":"z"},"done":false}\n\n']);
  const c = new OllamaClient({ ...cfg, provider: "ollama", baseUrl: "http://127.0.0.1:11434" });
  eq(await c.chatStream(msg("hi"), {}), "z");
});

// ---- 非流式路径不能被改坏 ----
await t("chat(): 非流式仍走 JSON 且不带 stream", async () => {
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), { status: 200 });
  };
  eq(await new OpenAIClient(cfg).chat(msg("hi"), { temperature: 0.1 }), "plain");
  eq(JSON.parse(last.init.body).stream, false, "body.stream");
});

// ---- parseJsonReply ----
await t("parseJsonReply: 剥 ```json 围栏", () => {
  eq(parseJsonReply('```json\n{"a":1}\n```').a, 1);
});
await t("parseJsonReply: 忽略前后客套话", () => {
  eq(parseJsonReply('好的，结果如下：\n{"a":2}\n希望有帮助').a, 2);
});
await t("parseJsonReply: 裸 JSON 与嵌套括号", () => {
  const v = parseJsonReply('{"a":{"b":[1,2]},"c":"x{y}"}');
  eq(v.a.b[1], 2);
  eq(v.c, "x{y}");
});
await t("parseJsonReply: 完全不是 JSON 时抛错(由调用方兜底)", () => {
  let threw = false;
  try { parseJsonReply("对不起，我无法解释"); } catch { threw = true; }
  eq(threw, true, "should throw");
});

// ---- explainCommand 端到端: 围栏 JSON 也能出结构化结果 ----
await t("explainCommand: 模型输出带围栏时仍解析成功并回填 command", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '```json\n{"description":"删除","parameters":[{"name":"-r","description":"递归"}],"example":"rm -r x","warnings":["不可逆"]}\n```' } }],
  }), { status: 200 });
  const r = await new OpenAIClient(cfg).explainCommand("rm -r x");
  eq(r.command, "rm -r x", "command 回填");
  eq(r.description, "删除");
  eq(r.warnings[0], "不可逆");
});

await t("analyzeError: 回填 errorMessage 供 UI 展示", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"rootCause":"权限不足","solutions":["sudo"]}' } }],
  }), { status: 200 });
  const r = await new OpenAIClient(cfg).analyzeError("Permission denied (publickey)");
  eq(r.errorMessage, "Permission denied (publickey)");
  eq(r.rootCause, "权限不足");
});

// ---- 鉴权头不被流式改动破坏 (P-4: key 不进 URL) ----
await t("流式请求里 API key 不出现在 URL", async () => {
  stub(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
  await new OpenAIClient({ ...cfg, apiKey: "sk-supersecret" }).chatStream(msg("hi"), {});
  if (last.url.includes("sk-supersecret")) throw new Error("key 泄漏到 URL");
  eq(last.init.headers.Authorization, "Bearer sk-supersecret");
});

await t("custom provider 未填 baseUrl 时明确报错而非拼 undefined", async () => {
  let requested = "";
  globalThis.fetch = async (url) => { requested = String(url); return new Response("{}", { status: 200 }); };
  const c = new OpenAIClient({ ...cfg, provider: "custom", baseUrl: "" });
  try {
    await c.chat(msg("hi"));
    throw new Error("应当抛出");
  } catch (e) {
    if (e.message === "应当抛出") throw e;
    if (!/Base URL/.test(e.message)) throw new Error(e.message);
  }
  eq(requested, "", "不应发出请求");
});

await t("custom provider 填了 baseUrl 时走 OpenAI 兼容路径", async () => {
  globalThis.fetch = async (url, init) => {
    last = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  const c = new OpenAIClient({ ...cfg, provider: "custom", baseUrl: "https://gw.internal/v1" });
  eq(await c.chat(msg("hi")), "ok");
  eq(last.url, "https://gw.internal/v1/chat/completions", "url");
  eq(last.init.headers.Authorization, "Bearer k", "鉴权头");
});

await t("parseJsonReply: 数组返回（代码建议要求 JSON 数组）", () => {
  const v = parseJsonReply('```json\n[{"title":"a"},{"title":"b"}]\n```');
  eq(v.length, 2, "len");
  eq(v[1].title, "b");
});

console.log(`\n[stream] PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
