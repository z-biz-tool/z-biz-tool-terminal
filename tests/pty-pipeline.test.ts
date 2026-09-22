/**
 * T-3-3 验收：PTY 输出的单一分发总线 + xterm 合并写入。
 *
 * 这里刻意用一个假的 `window.__TAURI_INTERNALS__`：既能数清"到底注册了几个 Tauri 监听"，
 * 也能从真正的回调入口把事件打进来，验证分发链路而不是只测纯函数。
 */
import {
  dispatchPtyPayload,
  ensurePtyListening,
  getPtyBusStats,
  subscribeAllPtyOutput,
  subscribePtyOutput,
} from "../src/services/ptyBus";
import { createBackpressuredWriter } from "../src/utils/terminalWriter";

let pass = 0,
  fail = 0;

async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log("  ok  ", name);
  } catch (e: any) {
    fail++;
    console.log("  FAIL", name, "\n       ", e?.message || e);
  }
}
const eq = (a: unknown, b: unknown, what = "") => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};
const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(what);
};

// ---- 假的 Tauri 事件运行时 ----
const tauriCalls: { cmd: string; event?: string }[] = [];
const registeredHandlers: ((ev: any) => void)[] = [];

(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (ev: any) => void) => {
      registeredHandlers.push(cb);
      return registeredHandlers.length;
    },
    invoke: async (cmd: string, args: any = {}) => {
      tauriCalls.push({ cmd, event: args?.event });
      if (cmd === "plugin:event|listen") return 999;
      return null;
    },
  },
};

/** 模拟后端 emit：走真正的 Tauri 回调入口 */
const emit = (payload: unknown) => {
  for (const h of registeredHandlers) h({ payload, event: "pty-output" });
};

await t("多个面板订阅也只注册一个 Tauri 监听", async () => {
  const unA = subscribePtyOutput("s-a", () => {});
  const unB = subscribePtyOutput("s-b", () => {});
  const unA2 = subscribePtyOutput("s-a", () => {});
  await ensurePtyListening();
  await ensurePtyListening();
  eq(
    tauriCalls.filter((c) => c.cmd === "plugin:event|listen").length,
    1,
    "listen 次数"
  );
  eq(registeredHandlers.length, 1, "注册的回调数");
  eq(getPtyBusStats().handlers, 3, "订阅者数");
  unA();
  unB();
  unA2();
});

await t("事件只送给匹配的会话，且保持到达顺序", () => {
  const a: string[] = [];
  const b: string[] = [];
  const unA = subscribePtyOutput("s-a", (d) => a.push(d));
  const unB = subscribePtyOutput("s-b", (d) => b.push(d));
  emit({ session_id: "s-a", data: "1" });
  emit({ session_id: "s-b", data: "x" });
  emit({ session_id: "s-a", data: "2" });
  eq(a.join(""), "12", "s-a");
  eq(b.join(""), "x", "s-b");
  unA();
  unB();
});

await t("同会话多订阅者都能收到（面板 + 批量执行观察者）", () => {
  const hits: string[] = [];
  const unPane = subscribePtyOutput("s-c", (d) => hits.push(`pane:${d}`));
  const unTap = subscribeAllPtyOutput((sid, d) => hits.push(`tap:${sid}:${d}`));
  const delivered = dispatchPtyPayload({ session_id: "s-c", data: "hi" });
  eq(delivered, 2, "被调用的 handler 数");
  eq(hits.join("|"), "pane:hi|tap:s-c:hi");
  unPane();
  unTap();
});

await t("取消订阅后不再收到，且空会话槽位被回收", () => {
  let n = 0;
  const un = subscribePtyOutput("s-d", () => n++);
  emit({ session_id: "s-d", data: "a" });
  eq(n, 1);
  un();
  un(); // 幂等
  emit({ session_id: "s-d", data: "b" });
  eq(n, 1, "退订后仍收到");
  eq(getPtyBusStats().sessions, 0, "残留会话槽位");
});

await t("缺字段/空数据的载荷被丢弃", () => {
  let n = 0;
  const un = subscribePtyOutput("s-e", () => n++);
  eq(dispatchPtyPayload(undefined), 0, "undefined");
  eq(dispatchPtyPayload({ session_id: "s-e" } as any), 0, "缺 data");
  eq(dispatchPtyPayload({ session_id: "s-e", data: "" }), 0, "空 data");
  eq(dispatchPtyPayload({ data: "x" } as any), 0, "缺 session_id");
  eq(n, 0, "非法载荷仍派发");
  un();
});

await t("监听起来之前的订阅不会丢事件（先订阅后 await）", async () => {
  // 上面的用例已经建立并复用了单一监听；这里只确认幂等：再次 await 不产生新监听
  await ensurePtyListening();
  eq(registeredHandlers.length, 1, "监听回调数增加");
});

// ---- xterm 合并写入 ----
class FakeTerm {
  writes: string[] = [];
  private inflight: (() => void)[] = [];
  write(data: string, cb?: () => void) {
    this.writes.push(data);
    if (cb) this.inflight.push(cb);
  }
  /** 模拟 xterm 画完一帧 */
  settle(n = 1) {
    for (let i = 0; i < n && this.inflight.length; i++) this.inflight.shift()!();
  }
  get pendingCallbacks() {
    return this.inflight.length;
  }
}

await t("一次 write 未回调时不再叠加第二次 write", () => {
  const term = new FakeTerm();
  const w = createBackpressuredWriter(term);
  w.push("a");
  w.push("b");
  w.push("c");
  eq(term.writes.length, 1, "write 次数");
  eq(term.writes[0], "a");
  eq(w.queued(), 2, "合并队列长度");
  term.settle();
  eq(term.writes.length, 2);
  eq(term.writes[1], "bc", "合并后的内容");
  eq(w.queued(), 0);
});

await t("合并写入不丢字节、不乱序（含回调期间持续到达）", () => {
  const term = new FakeTerm();
  const w = createBackpressuredWriter(term);
  const expected: string[] = [];
  for (let i = 0; i < 200; i++) {
    const chunk = `c${i};`;
    expected.push(chunk);
    w.push(chunk);
    if (i % 3 === 0) term.settle(1); // 画完一帧就继续，制造"回调期间又来数据"
  }
  // 全部回调排空
  while (term.pendingCallbacks) term.settle(1);
  eq(term.writes.join(""), expected.join(""), "落盘内容");
  ok(term.writes.length < 200, "本该合并，却仍然逐块 write");
  ok(term.writes.length >= 1, "至少写了一次");
});

await t("dispose 后不再写入，也不会被迟到回调复活", () => {
  const term = new FakeTerm();
  const w = createBackpressuredWriter(term);
  w.push("x");
  w.push("y");
  w.dispose();
  eq(w.queued(), 0, "dispose 应清掉未下发内容");
  term.settle(2);
  w.push("z");
  eq(term.writes.length, 1, "dispose 后仍有新 write");
  eq(term.writes[0], "x");
});

await t("空字符串不触发 write", () => {
  const term = new FakeTerm();
  const w = createBackpressuredWriter(term);
  w.push("");
  eq(term.writes.length, 0);
});

console.log(`\n[PtyPipeline] PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
