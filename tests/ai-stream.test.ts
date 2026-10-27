// 前端 AI 客户端契约（2026-10-26 起传输层收口到 Rust ai.rs / cap-llm）
//
// 旧版这里测的是四套协议的前端 SSE 解析；apiKey 不再回传 webview 后，那些代码已删除。
// 前端现在只剩 prompt 组装与结果解析，能钉的契约是：
//   1. IPC 请求体只含 messages/overrides —— 任何 apiKey 字段都不许出现
//   2. 后端 `ai-stream://token` 事件转发到 onDelta
//   3. abort 语义 = 通知后端停止生成（ai_stream_abort），不再是断 fetch
//   4. 监听器在 resolve / 抛错后都必须注销
//   5. 未配置时一个请求都不发
import { createAIClient, parseJsonReply } from "../src/services/aiClient";
import { PROVIDER_PRESETS } from "../src/stores/aiStore";

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

type Call = { cmd: string; args: any };
const calls: Call[] = [];
let tokenHandler: ((e: { payload: string }) => void) | null = null;
let unlistenCount = 0;
let stream: { resolve: (s: string) => void; reject: (e: unknown) => void } | null = null;

// 在 Node 里补齐 Tauri 运行时桥：invoke / transformCallback / 事件插件内部表都被 spy 接管
(globalThis as any).window = {};
(globalThis as any).window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {
    unlistenCount++;
  },
};
(globalThis as any).window.__TAURI_INTERNALS__ = {
  transformCallback: (cb: (e: { payload: string }) => void) => {
    tokenHandler = cb;
    return 1;
  },
  invoke: async (cmd: string, args: any) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "plugin:event|listen":
        return 7;
      case "plugin:event|unlisten":
        return null;
      case "ai_chat":
        return "ok";
      case "ai_chat_stream":
        return await new Promise<string>((resolve, reject) => {
          stream = { resolve, reject };
        });
      case "ai_stream_abort":
        return null;
      default:
        return null;
    }
  },
};

const cfg = {
  provider: "openai" as const,
  apiKey: "",
  hasApiKey: true,
  baseUrl: "https://x.test/v1",
  model: "m",
  temperature: 0.2,
  maxTokens: 100,
};
const msg = (text: string) => [{ role: "user" as const, content: text, timestamp: 1 }];
const flush = () => new Promise((r) => setTimeout(r, 0));
const lastCall = (cmd: string) => [...calls].reverse().find((c) => c.cmd === cmd);

await t("chatStream: 后端 token 事件按序转发给 onDelta", async () => {
  calls.length = 0;
  unlistenCount = 0;
  const got: string[] = [];
  const p = createAIClient(cfg).chatStream(msg("hi"), { onDelta: (d) => got.push(d) });
  await flush();
  ok(tokenHandler, "应注册 ai-stream://token 监听");
  tokenHandler!({ payload: "he" });
  tokenHandler!({ payload: "llo" });
  stream!.resolve("hello");
  eq(await p, "hello", "完整文本");
  eq(got.join(""), "hello", "onDelta 拼接");
});

await t("chatStream: IPC 参数只含 messages/overrides，apiKey 不得泄漏", async () => {
  calls.length = 0;
  const p = createAIClient({ ...cfg, apiKey: "sk-should-not-leak" }).chatStream(msg("hi"), {
    onDelta: () => {},
    temperature: 0.1,
    maxTokens: 9,
  });
  await flush();
  const call = lastCall("ai_chat_stream");
  ok(call, "应发出 ai_chat_stream");
  const raw = JSON.stringify(call!.args);
  ok(!raw.includes("sk-should-not-leak"), "apiKey 明文进了 IPC 参数");
  ok(!raw.includes("apiKey"), "payload 不应带 apiKey 字段");
  eq(call!.args.messages[0].content, "hi", "messages[0].content");
  eq(call!.args.overrides.temperature, 0.1, "overrides.temperature");
  eq(call!.args.overrides.maxTokens, 9, "overrides.maxTokens");
  stream!.resolve("x");
  await p;
});

await t("chatStream: abort 通知后端停止生成（ai_stream_abort）", async () => {
  calls.length = 0;
  const ac = new AbortController();
  const p = createAIClient(cfg).chatStream(msg("hi"), { onDelta: () => {}, signal: ac.signal });
  await flush();
  ac.abort();
  await flush();
  ok(lastCall("ai_stream_abort"), "abort 后应调用 ai_stream_abort");
  stream!.resolve("");
  await p;
});

await t("chatStream: resolve 后注销监听器", async () => {
  unlistenCount = 0;
  const p = createAIClient(cfg).chatStream(msg("hi"), { onDelta: () => {} });
  await flush();
  stream!.resolve("ok");
  await p;
  await flush();
  eq(unlistenCount, 1, "unlisten 次数");
});

await t("chatStream: 后端抛错也注销监听器并向上抛", async () => {
  unlistenCount = 0;
  const p = createAIClient(cfg).chatStream(msg("hi"), { onDelta: () => {} });
  await flush();
  stream!.reject(new Error("boom"));
  let threw = "";
  try {
    await p;
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, "boom", "错误向上传播");
  await flush();
  eq(unlistenCount, 1, "unlisten 次数");
});

await t("chat: 未配置 key 时直接报错且一个请求都不发", async () => {
  calls.length = 0;
  let threw = "";
  try {
    await createAIClient({ ...cfg, hasApiKey: false }).chat(msg("hi"));
  } catch (e) {
    threw = (e as Error).message;
  }
  if (!/未配置/.test(threw)) throw new Error(`错误应说明未配置，实际：${threw || "没报错"}`);
  eq(calls.length, 0, "发起的 IPC 次数");
});

await t("chat: 缺 baseUrl / model 时分别给出可行动提示", async () => {
  const missing: Array<[Partial<typeof cfg>, RegExp]> = [
    [{ baseUrl: "" }, /Base URL/],
    [{ model: "" }, /模型名/],
  ];
  for (const [patch, re] of missing) {
    let threw = "";
    try {
      await createAIClient({ ...cfg, ...patch }).chat(msg("hi"));
    } catch (e) {
      threw = (e as Error).message;
    }
    if (!re.test(threw)) throw new Error(`${JSON.stringify(patch)} 应提示 ${re}，实际：${threw || "没报错"}`);
  }
});

await t("createAIClient: provider 差异不再影响前端（同一工厂即可）", async () => {
  for (const provider of Object.keys(PROVIDER_PRESETS)) {
    calls.length = 0;
    const client = createAIClient({ ...cfg, provider: provider as typeof cfg.provider });
    eq(await client.chat(msg("hi")), "ok", provider);
    eq(lastCall("ai_chat")?.args.messages[0].content, "hi", `${provider} payload`);
  }
});

// ---- parseJsonReply ----

await t("parseJsonReply: 剥 ```json 围栏", () => {
  eq((parseJsonReply<{ a: number }>('```json\n{"a":1}\n```')).a, 1);
});

await t("parseJsonReply: 忽略前后客套话", () => {
  eq((parseJsonReply<{ a: number }>('好的，结果如下：\n{"a":2}\n希望有帮助')).a, 2);
});

await t("parseJsonReply: 裸 JSON 与嵌套括号", () => {
  const v = parseJsonReply<{ a: { b: number[] }; c: string }>('{"a":{"b":[1,2]},"c":"x{y}"}');
  eq(v.a.b[1], 2, "nested");
  eq(v.c, "x{y}", "花括号在字符串里");
});

await t("parseJsonReply: 完全不是 JSON 时抛错(由调用方兜底)", () => {
  let threw = false;
  try {
    parseJsonReply("对不起，我无法解释");
  } catch {
    threw = true;
  }
  ok(threw, "应抛错");
});

await t("parseJsonReply: 数组返回（代码建议要求 JSON 数组）", () => {
  const v = parseJsonReply<Array<{ title: string }>>('```json\n[{"title":"a"},{"title":"b"}]\n```');
  eq(v.length, 2, "len");
  eq(v[1].title, "b");
});

console.log(`\n[stream] PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
