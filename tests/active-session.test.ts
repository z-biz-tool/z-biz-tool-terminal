/**
 * `pickActiveSession` 与"活跃会话查找"的守卫。
 *
 * 起因：`tabs.find((t) => t.serverId === activeTabId)` 把 tab id 拿去比 serverId，
 * 永远匹配不到 → 端口转发的每个操作都只会报"没有活动的SSH会话"。下面第 2 组用例
 * 专门构造了"某标签的 id 恰好等于另一台服务器的 serverId"这种诱饵，旧写法会返回错的会话。
 */
import { readFileSync } from "node:fs";
import { pickActiveSession } from "../src/utils/session";
import type { TerminalTab } from "../src/types";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean) {
  if (cond) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want));
}

function tab(id: string, serverId: string, sessionId: string, paneIds: string[] = []): TerminalTab {
  return {
    id,
    serverId,
    sessionId,
    state: "connected",
    panes: [
      { id: `${id}-main`, serverId, sessionId, state: "connected" },
      ...paneIds.map((pid, i) => ({
        id: pid,
        serverId,
        sessionId: `${sessionId}-p${i + 2}`,
        state: "connected" as const,
      })),
    ],
  };
}

const tabs = [tab("tab-a", "srv-1", "s-a", ["pane-a2"]), tab("tab-b", "srv-2", "s-b")];
const pick = (activeTabId: string | null, activePaneId: string | null) =>
  pickActiveSession({ tabs, activeTabId, activePaneId });

// 1. 基本形状
eq("活跃标签的主面板", pick("tab-a", "tab-a-main"), "s-a");
eq("活跃面板优先于主面板", pick("tab-a", "pane-a2"), "s-a-p2");
eq("activePaneId 过期时回落主面板", pick("tab-a", "pane-没了"), "s-a");
eq("没有活跃标签", pick(null, "pane-a2"), undefined);
eq("活跃标签已被关闭", pick("tab-没了", null), undefined);
eq("面板不能跨标签串会话", pick("tab-b", "pane-a2"), "s-b");

// 2. 诱饵：活跃标签的 id 恰好等于另一台服务器的 serverId，按 serverId 比就会认错标签
const decoy = [tab("tab-trap", "srv-2", "s-trap"), tab("srv-2", "srv-7", "s-real")];
const decoyPick = (activeTabId: string, activePaneId: string | null) =>
  pickActiveSession({ tabs: decoy, activeTabId, activePaneId });
eq("按 tab id 命中真正的活跃标签", decoyPick("srv-2", "srv-2-main"), "s-real");
eq(
  "旧写法（拿 serverId 比）会挑中另一个标签：这条钉住两种写法的差异",
  decoy.find((t) => t.serverId === "srv-2")?.sessionId,
  "s-trap"
);
eq("活跃面板对不上时回落该标签的主面板", decoyPick("srv-2", "pane-别人的"), "s-real");

// 3. 同服多开：两条 tab 引用同一台服务器，会话号互不干扰
const same = [tab("tab-x", "srv-1", "s-x"), tab("tab-y", "srv-1", "s-y")];
eq(
  "同服多开取活跃那条",
  pickActiveSession({ tabs: same, activeTabId: "tab-y", activePaneId: "tab-y-main" }),
  "s-y"
);
eq(
  "按 serverId 找会拿错（旧写法的第二个死法）",
  same.find((t) => t.serverId === "srv-1")?.sessionId,
  "s-x"
);

// 4. 漂移守卫：这份查找只许有一个实现处
const srcOf = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const pf = srcOf("src/components/PortForwardModal.tsx");
const dm = srcOf("src/components/DiagnosticModal.tsx");
ok("能读到两个面板", pf !== null && dm !== null);
if (pf && dm) {
  eq("端口转发面板走共用查找", pf.includes("pickActiveSession(useServerStore.getState())"), true);
  eq("诊断面板也走共用查找（同源，防再次分叉）", dm.includes("pickActiveSession(useServerStore.getState())"), true);
  eq("面板里不再手写这份查找", /panes\.find\(\(p\) => p\.id === (state\.)?activePaneId\)/.test(pf + dm), false);
}
const app = srcOf("src/App.tsx");
const shell = srcOf("src/components/ServerList.tsx");
const gate = srcOf("src/services/commandGate.ts");
eq(
  "全仓不再出现 t.serverId === activeTabId",
  [pf, dm, app, shell, gate]
    .filter(Boolean)
    .some((t) => /t\.serverId === (\(state\)\.)?activeTabId/.test(t || "")),
  false
);

console.log(`[ActiveSession] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
