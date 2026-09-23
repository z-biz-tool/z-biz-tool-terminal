/**
 * 自动重连的"看得见"验收。
 *
 * 起因有两件：
 * 1. 等待被算了两次 —— `reconnectPane` 自己 `await sleep(backoffDelay(attempt))`，
 *    而排队的 `planRetry` 已经按同一份退避等过一遍了。于是第 2 次尝试实际要等 2×退避，
 *    封顶后一次等 60 秒，README 里写的"2s→4s→8s…封顶 30s"在真机上是 4s→8s→16s…60s。
 * 2. 这期间屏幕上只有一个红叉：自动重连在后台跑，用户分不清"还有下一次"和
 *    "已经放弃、得我自己点"，两者的外观完全相同。
 *
 * 所以断言分两半：等待时长由**唯一一处**调度决定（用假时钟数真实间隔），
 * 以及"现在处在重连的哪一步"必须有与事实一致的文案（含到上限、开关关掉、配置被删）。
 */
import { readFileSync } from "node:fs";
import { useServerStore, defaultSettings } from "../src/stores/serverStore";
import type { ServerConfig, TerminalTab } from "../src/types";
import {
  describeReconnect,
  isCountingDown,
  pickReconnectProgress,
  progressAfterFailure,
  progressOnAttempt,
  secondsUntil,
  tagReconnectState,
  type ReconnectProgress,
} from "../src/utils/reconnectProgress";

/** 关着开关时该说的那句话：只在这里出现一次，别在断言里抄一遍 */
const OFF_TEXT = "未开启自动重连，连不上也不会再自己试";
import { RECONNECT_MAX_ATTEMPTS, backoffDelay } from "../src/utils/reconnectPolicy";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}
function ok(name: string, cond: unknown) {
  eq(name, !!cond, true);
}
const src = (p: string) => readFileSync(p, "utf8");

// ---- 纯函数：文案的唯一真源 ----
{
  eq("没断过就没有话要说", describeReconnect(undefined, 1000), "");
  const run = progressOnAttempt(3);
  eq("开始一次尝试就是 running", run.running, true);
  eq("running 时不许带倒计时", run.nextAt, undefined);
  eq("running 的文案报出第几次", describeReconnect(run, 0), "正在重连 · 第 3/8 次");

  const waiting = progressAfterFailure(2, { now: 10_000, retry: true, delayMs: 4000 });
  eq("失败后排上下一次：nextAt = now + delay", waiting.nextAt, 14_000);
  eq("排上了就不算停", waiting.stopped, false);
  eq("倒数十进制取整", secondsUntil(14_000, 13_100), 1);
  eq("倒数不会因为时钟抖动变负", secondsUntil(14_000, 20_000), 0);
  eq("等待中的文案带上第几次与还剩几秒", describeReconnect(waiting, 12_000), "第 2/8 次没连上 · 还有 2 秒自动重试");
  eq("只有还在倒数才值得挂定时器", isCountingDown(waiting), true);
  eq("running 不挂定时器（它自己会变）", isCountingDown(run), false);

  const stopped = progressAfterFailure(8, { retry: false, reason: "limit" });
  eq("停在终态时没有 nextAt", stopped.nextAt, undefined);
  eq("自动重连停止要说清楚停在哪", describeReconnect(stopped, 0), "已连续 8 次连不上，自动重连已停止");
  eq("停止后不必再挂定时器", isCountingDown(stopped), false);
  const manual = progressAfterFailure(1, { retry: false, reason: "failed" });
  eq("用户手点失败不许写成「自动重连已停止」", describeReconnect(manual, 0), "重连失败（已尝试 1 次）");
  // 浏览器实测抓到的那条：设置里压根没开自动重连，屏幕却说"自动重连已停止"
  const off = progressAfterFailure(1, { retry: false, reason: "off" });
  eq("开关关着要说「没开」，不许假称有条链路停了", describeReconnect(off, 0), OFF_TEXT);
  eq(
    "三种停止原因各自一句话，不许共用",
    new Set([describeReconnect(stopped, 0), describeReconnect(manual, 0), describeReconnect(off, 0)]).size,
    3
  );
  eq("没排上下一次就不许写「立即重试」", isCountingDown(off), false);
  eq("头部短标签：正在连", tagReconnectState(run), "重连中");
  eq("头部短标签：在倒数", tagReconnectState(waiting), "重连中");
  eq("头部短标签：到了上限", tagReconnectState(stopped), "重连已停止");
  eq("头部短标签：开关关着", tagReconnectState(off), "未开自动重连");
  eq("头部短标签：手点失败", tagReconnectState(manual), "重连失败");
  eq("没有进度就没有标签", tagReconnectState(undefined), "");
}

// ---- pickReconnectProgress：一个标签页多个面板各自在重连时挑一条代表 ----
{
  const p = (over: Partial<ReconnectProgress>): ReconnectProgress => ({
    attempt: 1,
    max: 8,
    running: false,
    stopped: false,
    ...over,
  });
  eq("全空时没有进度", pickReconnectProgress([undefined, undefined]), undefined);
  eq("正在连的那条优先（它就是当下这一刻）",
    pickReconnectProgress([p({ nextAt: 100 }), p({ running: true, attempt: 4 })])?.running,
    true
  );
  eq("没在连就挑最快要重试的那条", pickReconnectProgress([p({ nextAt: 9000 }), p({ nextAt: 3000 })])?.nextAt, 3000);
  eq("全都停了报尝试次数最多的那条", pickReconnectProgress([p({ stopped: true, attempt: 3 }), p({ stopped: true, attempt: 8 })])?.attempt, 8);
}

// ---- 假时钟 + 假后端：量的是一台"永远连不上"的服务器实际隔多久重试 ----
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;
const tick = () => new Promise<void>((r) => realSetTimeout(r, 0));
/**
 * 假时钟下的 await 保护：被测代码如果又"等多遍"，那个 sleep 会挂在假时钟上永不触发，
 * 于是整条 promise 永不 settle —— 没有这层壳的话 node 直接以
 * "unsettled top-level await" 杀掉进程，一条红字都报不出来（用例要能报数）。
 */
async function settle<T>(label: string, p: Promise<T>): Promise<T | "PENDING"> {
  const guard = await Promise.race([
    p.then(() => "done" as const),
    new Promise<"PENDING">((r) => realSetTimeout(() => r("PENDING"), 400)),
  ]);
  if (guard === "PENDING") {
    fail++;
    fails.push(`${label}：await 永不 settle（等待被算了不止一遍）`);
    return "PENDING";
  }
  return undefined as unknown as T;
}


interface Timer {
  id: number;
  at: number;
  fn: () => void;
}
const realRandom = Math.random;
function makeClock() {
  let now = 1_000_000;
  let seq = 1;
  const timers: Timer[] = [];
  // 退避只往上加抖动（0~25%），不归零就没法断言"恰好等了一个退避间隔"
  Math.random = () => 0;
  (globalThis as any).setTimeout = (fn: any, ms?: number) => {
    timers.push({ id: seq++, at: now + (ms ?? 0), fn });
    return seq - 1;
  };
  (globalThis as any).clearTimeout = (id: any) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  (Date as any).now = () => now;
  return {
    now: () => now,
    pending: () => timers.map((t) => ({ at: t.at, delay: t.at - now })),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.splice(timers.indexOf(next), 1);
        next.fn();
        await tick();
        await tick();
      }
      now = target;
      await tick();
      await tick();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      (Date as any).now = realNow;
      Math.random = realRandom;
    },
  };
}

/** 挂在树上的连接结果：可脚本化"前 N 次失败、之后成功" */
/** `failOn(n)` 决定第 n 次连接是否失败；-1 那一档用来观察"正在重连"态 */
function makeBackend(opts: { failOn: (n: number) => boolean; neverResolve?: boolean }) {
  const state = { connects: 0 };
  const calls: string[] = [];
  const saved: any[] = [];
  (globalThis as any).window = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: any) => {
        try {
          cb && cb();
        } catch {}
        return 1;
      },
      invoke: async (cmd: string, args: any) => {
        calls.push(cmd);
        if (cmd === "ssh_connect" || cmd === "ssh_connect_via_jump") {
          const n = ++state.connects;
          if (opts.neverResolve) {
            // 永不返回：用来观察"正在重连"这一态
            return await new Promise(() => {});
          }
          if (opts.failOn(n)) {
            return { success: false, error: "Connection refused" };
          }
          return { success: true, session_id: `s-${n}` };
        }
        if (cmd === "save_tabs") saved.push(args);
        if (cmd === "ssh_disconnect") return null;
        return null;
      },
      event: {},
    },
  };
  return { state, calls, saved };
}

const serverA: ServerConfig = {
  id: "srv-a",
  name: "web-1",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authType: "password",
  password: "x",
} as ServerConfig;

const mkTab = (id: string, paneIds: string[]): TerminalTab => ({
  id,
  serverId: "srv-a",
  sessionId: "s-old",
  state: "error",
  error: "连接已断开",
  panes: paneIds.map((p) => ({
    id: p,
    serverId: "srv-a",
    sessionId: p === paneIds[0] ? "s-old" : undefined,
    state: "error",
    error: "连接已断开",
  })),
} as unknown as TerminalTab);

const st = () => useServerStore.getState();
const prog = (tabId: string, paneId: string) => st().reconnectProgress[`${tabId}:${paneId}`];
const seed = (tabs: TerminalTab[]) =>
  useServerStore.setState({
    servers: [serverA],
    tabs,
    settings: { ...defaultSettings, auto_reconnect: true },
    activeTabId: tabs[0]?.id ?? null,
    activePaneId: tabs[0]?.panes[0]?.id ?? null,
    reconnectProgress: {},
  });

// ---- 1. 一次失败：等下一次的时间 = 退避表给的那一个，不多等一遍 ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-w", ["p-a"])]);

  await settle("重连调用", st().reconnectPane("tab-w", "p-a"));
  eq("第一次尝试立刻发生（不吃退避）", backend.state.connects, 1);
  const started = clock.now();
  const pending = clock.pending();
  eq("只排了一个重试定时器", pending.length, 1);
  eq("排的时间就是退避表第 2 次的间隔", pending[0].delay, backoffDelay(2));
  eq("失败即落 error 态", st().tabs[0].panes[0].state, "error");
  const p1 = prog("tab-w", "p-a");
  eq("进度：第 1 次已失败", p1?.attempt, 1);
  eq("进度：不在 running", p1?.running, false);
  eq("进度：nextAt 与定时器同源", p1?.nextAt, started + backoffDelay(2));
  eq("还在重试就不是停止态", p1?.stopped, false);
  ok("文案：说得出还剩几秒", /还有 \d+ 秒自动重试/.test(describeReconnect(p1, started)));

  // 到点：必须"立刻"再连一次。旧写法在这里还要再睡一遍 backoffDelay(2)，
  // 于是 connects 仍是 1、并且又多挂了一个定时器。
  await clock.advance(pending[0].delay);
  eq("退避到点后马上发起第二次，不再等第二遍", backend.state.connects, 2);
  eq("第二次失败后又排上第三次", clock.pending()[0]?.delay, backoffDelay(3));
  eq("进度累计到第 2 次", prog("tab-w", "p-a")?.attempt, 2);

  clock.restore();
}

// ---- 2. 连上了就把进度抹掉，历史失败次数也不留着拖慢下次 ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: (n) => n === 1 || n === 2 || n === 4 });
  seed([mkTab("tab-ok", ["p-a"])]);

  await settle("重连调用", st().reconnectPane("tab-ok", "p-a"));
  await clock.advance(backoffDelay(2) * 1.3);
  await clock.advance(backoffDelay(3) * 1.3);
  eq("第三次才连上", backend.state.connects, 3);
  eq("连上之后没有排队中的重试", clock.pending().length, 0);
  eq("连上之后不留进度（已连接不该挂着「重连」字样）", prog("tab-ok", "p-a"), undefined);
  eq("会话号写回面板", st().tabs[0].panes[0].sessionId, "s-3");

  // 再断一次：从第 1 次重新开始，第一次不等
  await settle("重连调用", st().reconnectPane("tab-ok", "p-a"));
  eq("重连计数已清零：第一次仍不等", backend.state.connects, 4);
  eq("第一次失败后只排一个定时器", clock.pending().length, 1);
  eq("排的是第 2 次的间隔", clock.pending()[0]?.delay, backoffDelay(2));
  clock.restore();
}

// ---- 3. 到上限：停在终态，说"已停止"，并且不再偷偷敲门 ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-max", ["p-a"])]);

  await settle("重连调用", st().reconnectPane("tab-max", "p-a"));
  for (let i = 1; i < RECONNECT_MAX_ATTEMPTS; i++) {
    await clock.advance(backoffDelay(i + 1) * 1.25); // 抖动只会加，多给一点时间
  }
  eq("一共试了 8 次", backend.state.connects, RECONNECT_MAX_ATTEMPTS);
  eq("到上限后没有待跑的定时器", clock.pending().length, 0);
  const p = prog("tab-max", "p-a");
  eq("停在终态", p?.stopped, true);
  eq("停在终态时没有 nextAt", p?.nextAt, undefined);
  eq("停止原因：到了上限", p?.reason, "limit");
  eq(
    "文案如实：自动重连已停止",
    describeReconnect(p, clock.now()),
    `已连续 ${RECONNECT_MAX_ATTEMPTS} 次连不上，自动重连已停止`
  );
  eq("停止态不需要秒级刷新", isCountingDown(p), false);
  // 停在终态之后，标签页仍要是 error（不是"正在连接"的假象）
  eq("面板仍是 error", st().tabs[0].panes[0].state, "error");
  clock.restore();
}

// ---- 4. 关掉自动重连：失败一次就停，且要说清是"没开"而不是"停了" ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-off", ["p-a"])]);
  useServerStore.setState({ settings: { ...defaultSettings, auto_reconnect: false } });

  await settle("重连调用", st().reconnectPane("tab-off", "p-a"));
  eq("关掉了就只试一次", backend.state.connects, 1);
  eq("关掉了不排定时器", clock.pending().length, 0);
  const p = prog("tab-off", "p-a");
  eq("停在终态", p?.stopped, true);
  eq("停止原因：开关关着", p?.reason, "off");
  eq("文案不许假称有条链路停了", describeReconnect(p, clock.now()), OFF_TEXT);
  eq("没有下一次，就不该写「立即重试」", isCountingDown(p), false);
  clock.restore();
}

// ---- 4b. 开关关着时用户手点重试失败：说的是这一次失败，不是"你关了开关" ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-off-manual", ["p-a"])]);
  useServerStore.setState({ settings: { ...defaultSettings, auto_reconnect: false } });

  await settle("重连调用", st().reconnectPane("tab-off-manual", "p-a", { manual: true }));
  eq("手动也只发一发", backend.state.connects, 1);
  eq("不排队", clock.pending().length, 0);
  const p = prog("tab-off-manual", "p-a");
  eq("停止原因：这一次失败", p?.reason, "failed");
  eq("文案报出尝试次数", describeReconnect(p, clock.now()), "重连失败（已尝试 1 次）");
  clock.restore();
}

// ---- 5. 用户手点"立即重试"：插到队首、第 1 次，不排在倒计时后面 ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-manual", ["p-a"])]);

  await settle("重连调用", st().reconnectPane("tab-manual", "p-a")); // 自动：第 1 次失败
  await clock.advance(100); // 还没到 2 秒
  const beforeQueue = clock.pending()[0]?.delay;
  ok("还有一次排在后面", beforeQueue !== undefined);

  const running = st().reconnectPane("tab-manual", "p-a", { manual: true });
  await running;
  eq("手动重试不等倒计时，立刻发第 2 发", backend.state.connects, 2);
  eq("手动把排队中的那次合并掉", clock.pending().length, 1);
  eq("重新排的是第 2 次的间隔", clock.pending()[0]?.delay, backoffDelay(2));
  const p = prog("tab-manual", "p-a");
  eq("手动失败后仍会继续自动试", p?.stopped, false);
  ok("文案仍是倒计时", /还有 \d+ 秒自动重试/.test(describeReconnect(p, clock.now())), true);
  clock.restore();
}

// ---- 6. "正在重连"这一态要能上屏（连接挂住不返回时） ----
{
  const clock = makeClock();
  makeBackend({ failOn: () => true, neverResolve: true });
  seed([mkTab("tab-hang", ["p-a"])]);

  void st().reconnectPane("tab-hang", "p-a");
  await tick();
  await tick();
  const p = prog("tab-hang", "p-a");
  eq("连接进行中标成 running", p?.running, true);
  eq("进行中的文案带第几次", describeReconnect(p, clock.now()), "正在重连 · 第 1/8 次");
  eq("进行中不挂秒级定时器", isCountingDown(p), false);
  eq("面板状态同步到 connecting", st().tabs[0].panes[0].state, "connecting");
  clock.restore();
}

// ---- 7. 关掉面板/标签页：进度记录不许留下孤儿 ----
{
  const clock = makeClock();
  makeBackend({ failOn: () => true });
  seed([mkTab("tab-close", ["p-a", "p-b"])]);

  await settle("重连调用", st().reconnectPane("tab-close", "p-a"));
  ok("先有一条进度", !!prog("tab-close", "p-a"));
  await st().closePane("tab-close", "p-a", { force: true });
  eq("关掉那一格后进度被清掉", prog("tab-close", "p-a"), undefined);
  eq("关掉那一格后定时器也没了", clock.pending().length, 0);
  ok("旁边那格没被牵连（它本来也没进度）", prog("tab-close", "p-b") === undefined);

  await settle("重连调用", st().reconnectPane("tab-close", "p-b"));
  ok("另一格有了进度", !!prog("tab-close", "p-b"));
  await st().closeTab("tab-close", { force: true });
  eq("整页关掉后不留任何进度", st().reconnectProgress, {});
  eq("整页关掉后不留定时器", clock.pending().length, 0);
  clock.restore();
}

// ---- 8. 服务器配置被删：不许再谎称"正在重连" ----
{
  const clock = makeClock();
  const backend = makeBackend({ failOn: () => true });
  seed([mkTab("tab-gone", ["p-a"])]);
  useServerStore.setState({ servers: [] });

  await settle("重连调用", st().reconnectPane("tab-gone", "p-a"));
  eq("没发连接", backend.state.connects, 0);
  eq("配置没了就不留进度（否则「正在重连」是假话）", prog("tab-gone", "p-a"), undefined);
  eq("面板报的是配置不存在", st().tabs[0].panes[0].error, "服务器配置不存在");
  clock.restore();
}

// ---- 9. 静态守卫：文案与调度都只许有一处 ----
{
  const store = src("src/stores/serverStore.ts");
  eq("退避时长不再在 reconnectPane 里睡一遍", /backoffDelay\(/.test(store), false);
  eq("等待只由 nextReconnectPlan 决定（调度处唯一）", (store.match(/nextReconnectPlan\(/g) || []).length, 1);
  // 落盘载荷里不许混进重连进度：重启后一个已过期的 nextAt 会显示成假倒计时
  {
    const clock = makeClock();
    const { saved } = makeBackend({ failOn: () => true });
    seed([mkTab("tab-persist", ["p-a"])]);
    await settle("重连调用", st().reconnectPane("tab-persist", "p-a"));
    await st().persistTabs();
    const payload = JSON.stringify(saved.at(-1) ?? null);
    ok("save_tabs 真的被调到了", payload !== "null");
    eq("落盘载荷里没有 reconnectProgress", payload.includes("reconnectProgress"), false);
    eq("落盘载荷里也没有 reconnect 字段", payload.includes('"reconnect"'), false);
    clock.restore();
  }
  {
    const clock = makeClock();
    const { saved } = makeBackend({ failOn: () => true });
    seed([mkTab("tab-persist2", ["p-a"])]);
    await settle("重连调用", st().reconnectPane("tab-persist2", "p-a"));
    const p = prog("tab-persist2", "p-a");
    await st().persistTabs();
    eq("有进度时载荷照旧干净", JSON.stringify(saved.at(-1)).includes("reconnect"), false);
    ok("进度确实只活在 store 里", !!p);
    clock.restore();
  }
  const view = src("src/components/TerminalView.tsx");
  const app = src("src/App.tsx");
  ok("面板文案走 describeReconnect", view.includes("describeReconnect(reconnect, now)"));
  ok("状态条文案走同一个函数", app.includes("describeReconnect(activeReconnect, now)"));
  eq("两处都不自己拼「第 N 次」", /第 \$\{[a-zA-Z.]+\.attempt\}/.test(view + app), false);
  ok("倒计时只在真在倒数时挂表（面板）", view.includes("useNow(isCountingDown(reconnect))"));
  ok("倒计时只在真在倒数时挂表（状态条）", app.includes("useNow(isCountingDown(activeReconnect))"));
  ok("重连进度按面板自己的 key 取", view.includes("attemptKey(tabId, pane.id)"));
  // 「立即重试」只有在真排上下一次时才成立；由"有没有进度"决定会说出"停止态还能立即重试下一条"
  ok("按钮文案由 isCountingDown 决定", view.includes('retryLabel={isCountingDown(reconnect) ? "立即重试" : "重试"}'));
  ok("状态条短标签也出自同一个模块", app.includes("tagReconnectState(activeReconnect)"));
  eq("停止原因只在 store 里判一次", (store.match(/reason: !wasAuto/g) || []).length, 1);
  eq("文案那一侧不再猜原因", /\.auto\b/.test(src("src/utils/reconnectProgress.ts")), false);
  const hook = src("src/utils/useNow.ts");
  eq("秒级刷新只有一处实现", (hook.match(/setInterval/g) || []).length, 1);
  eq("进度是运行时投影，初值就是空表", /reconnectProgress: \{\}/.test(store), true);
}

function report(note = "") {
  console.log(`[ReconnectProgress] PASS ${pass} / FAIL ${fail}${note}`);
  for (const f of fails) console.error("✗ " + f);
}

// 看门狗：这一支测试 driving 的是假时钟，"等待只算一次"如果被改回两遍，
// 卡住的是被测代码里的 await —— 没有看门狗就整段崩掉、一条红字都报不出来。
const watchdog = realSetTimeout(() => {
  fail++;
  fails.push("有段落卡住未 settle（5 s 看门狗到点）—— 多半是等待被算了不止一次");
  report();
  process.exit(1);
}, 5000);

report();
realClearTimeout(watchdog);
if (fail) process.exit(1);
