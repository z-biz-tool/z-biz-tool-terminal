/**
 * 关闭标签页 / 分屏面板前的确认闸（`utils/closeGuard` + store 的三个关闭口）。
 *
 * 起因：所有"关闭"都是立即断会话 —— ⌘W、标签页 ×、右键「关闭 / 关闭其他 / 关闭右侧」、
 * 分屏面板的 ×，一路直接走到 `ssh_disconnect`。一个正在跑迁移的会话说没就没，事前没有任何
 * 问句。补上确认之后，新的风险变成了另一种：批量关闭逐条弹 N 个框、内部级联问第二遍、
 * 以及"确认框报 1 个会话、实际断 2 个"。所以这里重点测的是：
 *   1) 清单与会话真源同源（要问的东西 == 要断的东西）
 *   2) 一次意图只问一次（批量 / 级联 / 删除服务器都不重复问）
 *   3) 取消 == 什么都没发生（会话、标签页、activeTab 全部原样）
 *   4) §5.7 的回退开关（confirm_before_close=false 立即恢复旧的直接断）
 */
import { readFileSync } from "node:fs";
import { useServerStore, defaultSettings } from "../src/stores/serverStore";
import type { ServerConfig, TerminalTab } from "../src/types";
import {
  describeClose,
  guardClose,
  planClose,
  sessionsToClose,
  type ClosePlan,
} from "../src/utils/closeGuard";
import { BOOL_FIELDS } from "../src/utils/settingsSanity";

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

// ---- 打桩后端：记录每一次 ssh_disconnect（关闭口的唯一副作用） ----
const disconnects: string[] = [];
(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: any) => {
      try {
        cb && cb();
      } catch {
        /* 回调自身与本用例无关 */
      }
      return 1;
    },
    invoke: async (cmd: string, args: any) => {
      if (cmd === "ssh_disconnect") {
        disconnects.push(args.sessionId);
        return { success: true };
      }
      return { success: true };
    },
  },
};
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const servers: ServerConfig[] = [
  { id: "srv-1", name: "web-1", host: "10.0.0.1", port: 22, username: "root" },
  { id: "srv-2", name: "db-1", host: "10.0.0.2", port: 2222, username: "root", environment: "prod" },
  { id: "srv-3", name: "dev-1", host: "10.0.0.3", port: 22, username: "root", environment: "dev" },
] as unknown as ServerConfig[];

function pane(id: string, serverId: string, sessionId?: string): TerminalTab["panes"][number] {
  return { id, serverId, sessionId, state: sessionId ? "connected" : "connecting" } as unknown as
    TerminalTab["panes"][number];
}

const tabs: TerminalTab[] = [
  {
    id: "tab-1",
    serverId: "srv-1",
    sessionId: "s-1",
    state: "connected",
    // 同服务器分屏：两个面板、一个主机 —— 清单必须去重，计数必须算两个
    panes: [pane("p-main", "srv-1", "s-1"), pane("p-right", "srv-1", "s-1r")],
  },
  {
    id: "tab-2",
    serverId: "srv-2",
    sessionId: "s-2",
    state: "connected",
    panes: [pane("p-2", "srv-2", "s-2")],
  },
  {
    id: "tab-idle",
    serverId: "srv-3",
    state: "connecting",
    panes: [pane("p-idle", "srv-3")],
  },
  {
    id: "tab-ghost",
    serverId: "srv-9",
    sessionId: "s-ghost",
    state: "connected",
    // 服务器已被删除，但会话还在：清单不能少列这一台
    panes: [pane("p-ghost", "srv-9", "s-ghost")],
  },
] as unknown as TerminalTab[];

const ctx = (enabled = true) => ({ tabs, servers, enabled });
const st = () => useServerStore.getState();
const seed = (over: Record<string, unknown> = {}) =>
  useServerStore.setState({
    servers,
    tabs: tabs.map((t) => ({ ...t, panes: [...t.panes] })),
    settings: { ...defaultSettings },
    activeTabId: "tab-1",
    activePaneId: "p-main",
    ...over,
  });

/** 注入的问询替身：记录被问到的计划，按 verdict 决定放行 */
function spyAsk(verdict: boolean | ((p: ClosePlan) => boolean)) {
  const seen: ClosePlan[] = [];
  const ask = async (p: ClosePlan) =>
    typeof verdict === "function" ? verdict(p) : verdict;
  return {
    seen,
    ask: async (p: ClosePlan) => {
      seen.push(p);
      return ask(p);
    },
  };
}

// ---- 1. 计划与会话真源同源：要问的 == 要断的 ----
{
  const plan = planClose([{ tabId: "tab-1" }], ctx());
  eq("整页关闭按面板计数", plan.liveSessions, 2);
  eq("同服务器两个面板只列一台机", plan.hosts.length, 1);
  eq("主机清单带端口", plan.hosts[0]?.host, "10.0.0.1:22");
  eq("名字取服务器名", plan.hosts[0]?.name, "web-1");
  eq("单标签页标题", describeClose(plan), "关闭标签页？");
  eq("连着会话就要问", plan.needsConfirm, true);
  eq("标签页数", plan.tabCount, 1);
  eq("不是分屏范围", plan.paneScoped, false);
  eq(
    "计数与 sessionsToClose 一致",
    plan.liveSessions,
    sessionsToClose([{ tabId: "tab-1" }], tabs).length
  );
}

// ---- 2. 生产环境与"服务器已删但会话还在" ----
{
  const prod = planClose([{ tabId: "tab-2" }], ctx());
  eq("生产机计数", prod.prodCount, 1);
  eq("环境标记透传", prod.hosts[0]?.environment, "prod");
  eq("非默认端口要出现在清单里", prod.hosts[0]?.host, "10.0.0.2:2222");

  const ghost = planClose([{ tabId: "tab-ghost" }], ctx());
  eq("服务器已删也照样列一条", ghost.hosts.length, 1);
  eq("未知服务器用 serverId 当地址", ghost.hosts[0], { name: "未知服务器", host: "srv-9" });
  eq("未知环境不算生产", ghost.prodCount, 0);
}

// ---- 3. 分屏面板：只算这一格，不牵连旁边 ----
{
  const one = planClose([{ tabId: "tab-1", paneId: "p-right" }], ctx());
  eq("只统计被关的那个面板", one.liveSessions, 1);
  eq("面板级关闭的标题", describeClose(one), "关闭分屏面板？");
  eq("面板级也算范围", one.paneScoped, true);
  eq(
    "旁边那个面板没被算进去",
    sessionsToClose([{ tabId: "tab-1", paneId: "p-right" }], tabs).map((p) => p.sessionId),
    ["s-1r"]
  );
  eq(
    "面板 id 已失效时不问（没东西可丢）",
    planClose([{ tabId: "tab-1", paneId: "p-没了" }], ctx()).needsConfirm,
    false
  );
}

// ---- 4. 不该问的三种情况 ----
{
  eq(
    "没有活跃会话就不问",
    planClose([{ tabId: "tab-idle" }], ctx()).needsConfirm,
    false
  );
  eq(
    "开关关掉就不问",
    planClose([{ tabId: "tab-1" }], ctx(false)).needsConfirm,
    false
  );
  eq(
    "标签页不存在就不问",
    planClose([{ tabId: "tab-不存在的" }], ctx()).needsConfirm,
    false
  );
  const empty = planClose([], ctx());
  eq("空范围不问", empty.needsConfirm, false);
  eq("空范围计数为 0", empty.tabCount, 0);
  eq(
    "开关关掉时清单仍然算得出来（供调用方自用）",
    planClose([{ tabId: "tab-1" }], ctx(false)).liveSessions,
    2
  );
}

// ---- 5. 批量：按 tabId 去重、标题带数量 ----
{
  const batch = planClose(
    [{ tabId: "tab-1" }, { tabId: "tab-1" }, { tabId: "tab-2" }],
    ctx()
  );
  eq("标签页数按 id 去重", batch.tabCount, 2);
  eq("会话数按面板累计", batch.liveSessions, 3);
  eq("批量标题带数量", describeClose(batch), "关闭 2 个标签页？");
  eq(
    "清单里跨标签页也去重",
    planClose([{ tabId: "tab-1" }, { tabId: "tab-1", paneId: "p-main" }], ctx()).hosts.length,
    1
  );
}

// ---- 6. guardClose：没到要问的地步就一次都不打扰 ----
{
  const a = spyAsk(true);
  eq("无会话时直接放行", await guardClose([{ tabId: "tab-idle" }], ctx(), a.ask), true);
  eq("无会话时没弹问", a.seen.length, 0);

  const b = spyAsk(true);
  eq("开关关闭时直接放行", await guardClose([{ tabId: "tab-1" }], ctx(false), b.ask), true);
  eq("开关关闭时没弹问", b.seen.length, 0);

  const c = spyAsk(false);
  eq("用户拒绝 → 不关", await guardClose([{ tabId: "tab-1" }], ctx(), c.ask), false);
  eq("问了", c.seen.length, 1);
  eq("问的是这次真要断的会话数", c.seen[0]?.liveSessions, 2);

  const d = spyAsk(true);
  eq(
    "批量只问一次",
    await guardClose(
      [{ tabId: "tab-1" }, { tabId: "tab-2" }, { tabId: "tab-ghost" }],
      ctx(),
      d.ask
    ),
    true
  );
  eq("确实只问了一次", d.seen.length, 1);
  eq("一次问清三台机", d.seen[0]?.hosts.length, 3);
}

// ---- 7. store：取消 == 什么都没发生 ----
{
  seed();
  disconnects.length = 0;
  const no = spyAsk(false);
  await st().closeTab("tab-1", { ask: no.ask });
  eq("取消后标签页还在", st().tabs.length, tabs.length);
  eq("取消后一条会话都没断", disconnects.length, 0);
  eq("取消后活跃标签没动", st().activeTabId, "tab-1");
  eq("取消后没有重连队列被误清（标签结构原样）", st().tabs[0]?.panes.length, 2);
  eq("问过一次的文案参数落在计划里", no.seen[0]?.liveSessions, 2);
}

// ---- 8. store：确认 == 该断的都断、该删的都删 ----
{
  seed();
  disconnects.length = 0;
  const yes = spyAsk(true);
  await st().closeTab("tab-1", { ask: yes.ask });
  eq("确认后标签页没了", st().tabs.some((t) => t.id === "tab-1"), false);
  eq("两个面板的会话都断了", disconnects.sort(), ["s-1", "s-1r"]);
  eq("断完把活跃标签迁到剩下的第一个", st().activeTabId, "tab-2");
  eq("只问了一次", yes.seen.length, 1);
}

// ---- 9. store：没有活跃会话的标签页直接关，不打扰 ----
{
  seed();
  disconnects.length = 0;
  const ask = spyAsk(false); // 就算回答"不关"，也不该被问到
  await st().closeTab("tab-idle", { ask: ask.ask });
  eq("无会话标签页已关闭", st().tabs.some((t) => t.id === "tab-idle"), false);
  eq("没有弹问", ask.seen.length, 0);
  eq("没有 disconnect", disconnects.length, 0);
}

// ---- 10. store：不存在的 tab 既不弹问也不报错 ----
{
  seed();
  const ask = spyAsk(true);
  await st().closeTab("tab-没有这个东西", { ask: ask.ask });
  eq("不存在的标签页不弹问", ask.seen.length, 0);
  eq("标签页列表不变", st().tabs.length, tabs.length);
}

// ---- 11. store：批量关闭只问一次，取消则一个都不关 ----
{
  seed();
  disconnects.length = 0;
  const no = spyAsk(false);
  await st().closeTabs(["tab-1", "tab-2", "tab-ghost"], no.ask);
  eq("取消后三个都还在", st().tabs.length, tabs.length);
  eq("取消后一条都没断", disconnects.length, 0);
  eq("批量只问一次", no.seen.length, 1);
  eq("问的是三个标签页", no.seen[0]?.tabCount, 3);

  disconnects.length = 0;
  const yes = spyAsk(true);
  await st().closeTabs(["tab-1", "tab-2", "tab-ghost"], yes.ask);
  eq("确认后只剩无会话那一页", st().tabs.map((t) => t.id), ["tab-idle"]);
  eq("断掉的会话共 4 个", disconnects.sort(), ["s-1", "s-1r", "s-2", "s-ghost"]);
  eq("仍然只问一次", yes.seen.length, 1);
}

// ---- 12. store：批量里混了已失效的 id ----
{
  seed();
  const ask = spyAsk(true);
  await st().closeTabs(["tab-已消失", "tab-2"], ask.ask);
  eq("只按存在的标签页问", ask.seen[0]?.tabCount, 1);
  eq("失效 id 不占数量", ask.seen[0]?.liveSessions, 1);
  eq("存在的还是关掉了", st().tabs.some((t) => t.id === "tab-2"), false);

  const none = spyAsk(true);
  const before = st().tabs.length;
  await st().closeTabs(["tab-已消失"], none.ask);
  eq("全空时一次都不问", none.seen.length, 0);
  eq("全空时不动列表", st().tabs.length, before);
}

// ---- 13. store：分屏面板取消 / 确认 / 级联不重复问 ----
{
  seed();
  disconnects.length = 0;
  const no = spyAsk(false);
  await st().closePane("tab-1", "p-main", { ask: no.ask });
  eq("取消后面板还在", st().tabs[0]?.panes.length, 2);
  eq("取消后没断会话", disconnects.length, 0);
  eq("面板级确认框只列这一格", no.seen[0]?.liveSessions, 1);

  disconnects.length = 0;
  const yes = spyAsk(true);
  await st().closePane("tab-1", "p-main", { ask: yes.ask });
  eq("确认后只剩一个面板", st().tabs[0]?.panes.map((p) => p.id), ["p-right"]);
  eq("只断了被关那一格", disconnects, ["s-1"]);
  eq("标签页还在", st().tabs.some((t) => t.id === "tab-1"), true);

  // 关掉最后一格 → 整页关闭，但不能再问第二遍
  disconnects.length = 0;
  const cascade = spyAsk(true);
  await st().closePane("tab-1", "p-right", { ask: cascade.ask });
  eq("最后一格关闭时只问一次", cascade.seen.length, 1);
  eq("整页随之关闭", st().tabs.some((t) => t.id === "tab-1"), false);
  eq("剩下的会话也断了", disconnects, ["s-1r"]);
}

// ---- 14. store：删除服务器引起的关闭不再问第二遍 ----
{
  seed();
  disconnects.length = 0;
  const ask = spyAsk(false); // 若真去问用户，"不关"会让服务器删不掉
  useServerStore.setState({ servers: servers.filter((s) => s.id !== "srv-1") });
  await st().disconnectServer("srv-1");
  eq("级联关闭没有弹问", ask.seen.length, 0);
  eq("该服务器的会话都被断了", disconnects.sort(), ["s-1", "s-1r"]);
  eq("标签页已移除", st().tabs.some((t) => t.id === "tab-1"), false);
}

// ---- 15. store：回退开关（§5.7）——关掉即恢复"直接断" ----
{
  seed();
  useServerStore.setState({
    settings: { ...defaultSettings, confirm_before_close: false },
  });
  disconnects.length = 0;
  const ask = spyAsk(false);
  await st().closeTab("tab-2", { ask: ask.ask });
  eq("开关关掉时不问", ask.seen.length, 0);
  eq("开关关掉时直接断", disconnects, ["s-2"]);
  eq("标签页关闭", st().tabs.some((t) => t.id === "tab-2"), false);

  // 缺字段（老配置）必须仍按"开"处理，否则升级即失去保护
  seed();
  const legacy = { ...defaultSettings } as Record<string, unknown>;
  delete legacy.confirm_before_close;
  useServerStore.setState({ settings: legacy as never });
  const a2 = spyAsk(false);
  await st().closeTab("tab-2", { ask: a2.ask });
  eq("老配置缺字段按开启处理", a2.seen.length, 1);
  eq("老配置下取消仍然不关", st().tabs.some((t) => t.id === "tab-2"), true);
}

// ---- 16. 静态守卫：口径不许再各写一份 ----
{
  const guard = src("src/utils/closeGuard.tsx");
  const store = src("src/stores/serverStore.ts");
  const app = src("src/App.tsx");
  const gate = src("src/services/commandGate.ts");
  const shared = src("src/utils/guardTargets.ts");
  const sanity = src("src/utils/settingsSanity.ts");
  const modal = src("src/components/SettingsModal.tsx");
  const rust = src("src-tauri/src/config.rs");

  ok("关闭闸按 pane.sessionId 计数", guard.includes("if (!pane.sessionId || seen.has(pane.sessionId)) continue;"));
  ok("关闭闸按 sessionId 去重（一个会话只断一次）", guard.includes("seen.add(pane.sessionId)"));
  ok("关闭闸只认 enabled && 有会话", guard.includes("needsConfirm: ctx.enabled && panes.length > 0"));
  ok("关闭闸的主机清单走共用映射", guard.includes("targetsByServerIds("));
  eq("关闭闸不再自己写 dedupe/映射", /function (dedupe|serverToTarget)\(/.test(guard), false);
  eq("去重只有一份实现", (shared.match(/export function dedupeTargets/g) || []).length, 1);
  eq("网关那边也改成共用实现", /function dedupe\(/.test(gate), false);
  ok("网关仍导出 serverTargets", gate.includes("export function serverTargets"));

  ok("closeTab 过闸", store.includes("guardClose([{ tabId }], closeCtx(get())"));
  ok("closePane 过闸且只问这一格", store.includes("guardClose([{ tabId, paneId }], closeCtx(get())"));
  ok("批量关闭存在", store.includes("closeTabs: async (tabIds, ask)"));
  ok("批量逐条强关", store.includes("await get().closeTab(id, { force: true })"));
  ok("关最后一格时级联强关", store.includes("await get().closeTab(tabId, { force: true });"));
  eq(
    "disconnectServer 不再触发第二次确认",
    (store.match(/closeTab\(tab\.id, \{ force: true \}\)|closePane\(tab\.id, p\.id, \{ force: true \}\)/g) || [])
      .length,
    2
  );
  ok("开关缺字段按开启处理", store.includes("state.settings.confirm_before_close !== false"));

  ok("右键「关闭其他」走批量口", app.includes("closeTabs(tabs.filter((t) => t.id !== tabId).map((t) => t.id))"));
  ok("右键「关闭右侧」走批量口", app.includes("closeTabs(tabs.slice(idx + 1).map((t) => t.id))"));
  eq("批量口不再 forEach 逐条关", /forEach\(\(t\) => closeTab/.test(app), false);
  ok("标签页 × 仍走 closeTab（自带闸）", app.includes('if (action === "remove") closeTab(key as string);'));

  ok("新开关进了布尔白名单", (BOOL_FIELDS as readonly string[]).includes("confirm_before_close"));
  ok("缺字段/脏值回默认靠 BOOL_FIELDS", sanity.includes('"confirm_before_close"'));
  ok("设置页有对应开关", modal.includes("settings.confirm_before_close !== false"));
  ok("设置页开关能写回", modal.includes("updateSettings({ confirm_before_close: v })"));

  ok("后端结构体有该字段", rust.includes("pub confirm_before_close: bool"));
  ok(
    "后端字段带 default_true（老配置读得出来）",
    /#\[serde\(default = "default_true"\)\]\s*\n\s*pub confirm_before_close: bool/.test(rust)
  );
  ok("后端默认值为 true", rust.includes("confirm_before_close: true"));
}

// ---- 17. 跨语言契约：前端设置项与后端结构体字段必须一一对应 ----
{
  const rust = src("src-tauri/src/config.rs");
  const block = /pub struct TerminalSettings \{([\s\S]*?)\n\}/.exec(rust);
  ok("后端设置结构体抓到了", block !== null);
  const rustFields = [...(block?.[1] || "").matchAll(/^\s*pub (\w+): /gm)].map((m) => m[1]).sort();
  const tsFields = Object.keys(defaultSettings).sort();
  eq("前端每个设置项后端都存得下", tsFields.filter((k) => !rustFields.includes(k)), []);
  eq("后端每个字段前端都用得上", rustFields.filter((k) => !tsFields.includes(k)), []);
  eq("两侧字段数一致", [rustFields.length, tsFields.length], [27, 27]);
}

console.log(`[CloseGuard] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
