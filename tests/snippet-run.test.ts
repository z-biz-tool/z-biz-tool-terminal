/**
 * Snippet 下发口（`executeSnippet` + 它的两个调用方）的验收。
 *
 * 起因：两个调用口都把 **tab id** 当成 **serverId** 传给 `executeSnippet`，而它内部按
 * `t.serverId === serverId` 找标签 —— 于是永远找不到，命令一条也没写进 PTY，
 * 可 `SnippetsPanel` 在那之前就已经弹了「已执行: xxx」。用户看到的是一次成功的假象。
 * 所以这里的断言重心不是"能不能发出去"，而是**结论与反馈必须一致**：
 * 没发出去的三种原因（没有会话 / 网关拒绝 / 写失败）都不许是 success 语气。
 */
import { readFileSync } from "node:fs";
import { useServerStore, defaultSettings } from "../src/stores/serverStore";
import type { ServerConfig, TerminalTab } from "../src/types";
import { describeSnippetRun } from "../src/utils/snippetRun";
import { listHistory } from "../src/utils/commandHistory";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b: string = JSON.stringify(want);
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
/**
 * describeSnippetRun 的容错壳。
 * 修复前 `executeSnippet` 返回 undefined，直接调用会在 helper 里抛异常、整个文件停在
 * 第一条断言上（拿不到 PASS/FAIL 小结）。用例要能报数，所以先把它折成一个假的结论。
 */
const safeNotice = (res: unknown, name: string) =>
  res && typeof res === "object"
    ? describeSnippetRun(res as any, name)
    : { type: `undefined(${JSON.stringify(res)})`, text: "" };

// ---- 打桩后端：记录每一次 ssh_pty_write 与 audit_event ----
const writes: { sessionId: string; data: string }[] = [];
const auditCalls: { action: string; detail: Record<string, unknown> }[] = [];
let writeShouldFail = false;

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
      if (cmd === "audit_event") {
        auditCalls.push({ action: args.action, detail: args.detail ?? {} });
        return null;
      }
      if (cmd === "ssh_pty_write") {
        if (writeShouldFail) throw new Error("Broken pipe: 会话已被远端关闭");
        writes.push({ sessionId: args.sessionId, data: args.data });
        return null;
      }
      return null;
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
  { id: "srv-2", name: "db-1", host: "10.0.0.2", port: 22, username: "root" },
] as unknown as ServerConfig[];

function pane(id: string, serverId: string, sessionId: string): TerminalTab["panes"][number] {
  return { id, serverId, sessionId, state: "connected" } as unknown as TerminalTab["panes"][number];
}

/**
 * 诱饵形状：`tab-trap` 的 id 恰好等于 `srv-2` 的名字空间里那台服务器的 serverId，
 * 旧写法（拿传入 id 去比 t.serverId）会挑中另一台机器的会话。
 */
const tabs: TerminalTab[] = [
  {
    id: "tab-1",
    serverId: "srv-1",
    sessionId: "s-main",
    state: "connected",
    panes: [pane("p-main", "srv-1", "s-main"), pane("p-right", "srv-1", "s-right")],
  },
  {
    id: "srv-2",
    serverId: "srv-9",
    sessionId: "s-decoy-target",
    state: "connected",
    panes: [pane("srv-2-main", "srv-9", "s-decoy-target")],
  },
  {
    id: "tab-trap",
    serverId: "srv-2",
    sessionId: "s-trap",
    state: "connected",
    panes: [pane("tab-trap-main", "srv-2", "s-trap")],
  },
] as unknown as TerminalTab[];

/**
 * 统一入口：修复前的 executeSnippet 返回 undefined，直接读 `.ok` 会把整个文件抛崩在
 * 第一条断言上（拿不到 PASS/FAIL 小结，也就看不出"到底哪几条打在行为上"）。
 */
type MaybeRun = { ok: boolean; reason?: string; sessionId?: string; error?: string } | undefined;
const call = async (cmd: string): Promise<MaybeRun> =>
  (await useServerStore.getState().executeSnippet(cmd)) as unknown as MaybeRun;
const isOk = (r: MaybeRun) => r?.ok === true;
const reasonOf = (r: MaybeRun) => (r ? r.reason : "returns-undefined");

const st = () => useServerStore.getState();
const seed = (activeTabId: string | null, activePaneId: string | null) =>
  useServerStore.setState({ servers, tabs, settings: defaultSettings, activeTabId, activePaneId });

// ---- 1. 有会话 + 安全命令：必须写到"活跃面板"的会话，并且报成功 ----
{
  writes.length = 0;
  seed("tab-1", "p-right");
  const res = await call("git status");
  eq("安全命令放行", res, { ok: true, sessionId: "s-right" });
  eq("只写了一次", writes.length, 1);
  eq("写进的是活跃面板的会话，不是主面板", writes[0]?.sessionId, "s-right");
  eq("按 Enter 交给远端 shell", writes[0]?.data, "git status\n");
  const notice = safeNotice(res, "查看状态");
  eq("成功才是 success 语气", notice.type, "success");
  eq("文案里带片段名", notice.text.includes("查看状态"), true);
  eq("成功结论必须带会话号", (res as any)?.sessionId, "s-right");
}

// ---- 2. 同一台服务器多开 / 多面板：切到哪个就打给哪个（P-3） ----
{
  writes.length = 0;
  seed("tab-1", "p-main");
  eq("活跃面板换成主面板", isOk(await call("ls")), true);
  eq("写到主面板会话", writes.at(-1)?.sessionId, "s-main");
  seed("tab-trap", "tab-trap-main");
  writes.length = 0;
  eq("换标签后按活跃标签取会话", isOk(await call("pwd")), true);
  eq("写到新活跃标签的会话", writes.at(-1)?.sessionId, "s-trap");
  // 旧写法的死法：把 activeTabId("tab-trap") 当 serverId 去比 t.serverId，
  // 会命中另一台机器（serverId 恰为 "srv-2" 的那条诱饵标签）。
  eq(
    "诱饵形状确实会让旧写法认错标签（钉住两种写法的差异）",
    tabs.find((t) => t.serverId === "tab-trap")?.sessionId,
    undefined
  );
}

// ---- 3. 没有会话：如实报 no-session，且一条都不写 ----
{
  writes.length = 0;
  seed(null, null);
  eq("没有活跃标签", await call("uptime"), { ok: false, reason: "no-session" });
  eq("没写过 PTY", writes.length, 0);
  eq(
    "此时反馈不能是 success",
    describeSnippetRun({ ok: false, reason: "no-session" }, "x").type,
    "warning"
  );
  seed("tab-没建过", "p-main");
  eq("活跃标签 id 已失效", isOk(await call("uptime")), false);
  eq("失效标签同样不写", writes.length, 0);
}

// ---- 4. 危险命令：网关无人确认即拒绝，不许留下写入痕迹（P-2 / P-1） ----
{
  writes.length = 0;
  auditCalls.length = 0;
  seed("tab-1", "p-right");
  const before = listHistory().length;
  const res = await call("rm -rf /var/log");
  eq("危险片段被拒", res, { ok: false, reason: "cancelled", sessionId: undefined });
  eq("拒绝后一条不写", writes.length, 0);
  const decision = auditCalls.find((a) => a.action === "dangerous_command_decision");
  ok("拒绝也进审计", decision !== undefined);
  eq("审计里的来源是 snippet", decision?.detail?.source, "snippet");
  eq("审计里记的是未放行", decision?.detail?.approved, false);
  eq(
    "受影响主机清单只有那台机，不是未知服务器占位",
    (decision?.detail?.hosts as string[] | undefined)?.join(","),
    "web-1<10.0.0.1:22>"
  );
  eq(
    "被拒的命令不进历史",
    listHistory().length,
    before
  );
  eq("取消的反馈是 info，不是 error 也不是 success", safeNotice(res, "清日志").type, "info");
}

// ---- 5. 写失败：错误要冒泡成结论，不再只 console.error ----
{
  writes.length = 0;
  writeShouldFail = true;
  seed("tab-1", "p-main");
  const res = await call("echo hi");
  writeShouldFail = false;
  eq("写失败报 failed", reasonOf(res), "failed");
  ok("带上后端的原话", String(res?.error).includes("Broken pipe"));
  eq("反馈语气是 error", safeNotice(res, "打招呼").type, "error");
}

// ---- 6. 措辞只有一处真源，且不再有"已执行"这种越权承诺 ----
{
  const helper = src("src/utils/snippetRun.ts");
  const panel = src("src/components/SnippetsPanel.tsx");
  const palette = src("src/components/CommandPalette.tsx");
  const app = src("src/App.tsx");
  ok("helper 里写明只写进 PTY 不等于已执行", /只把命令写进了 PTY/.test(helper));
  for (const [name, file] of [
    ["面板", panel],
    ["命令面板", palette],
  ] as const) {
    eq(`${name}不再自带文案（引用 helper）`, file.includes("describeSnippetRun("), true);
    eq(`${name}里没有出现"已执行"`, file.includes("已执行"), false);
  }
  eq("面板不再接收 serverId prop", /serverId/.test(panel), false);
  eq("App 里挂的是无 prop 的面板", app.includes("<SnippetsPanel />"), true);
  eq("App 里不再把 tab id 当 serverId 传", app.includes("<SnippetsPanel serverId={activeTabId}"), false);
  eq(
    "命令面板不再拿 activeTabId 当目标",
    /activeTabId \|\| tabs\[0\]\?\.serverId/.test(palette),
    false
  );
}

// ---- 7. 静态守卫：目标会话只能来自 pickActiveSession ----
{
  const store = src("src/stores/serverStore.ts");
  const body = store.slice(store.indexOf("executeSnippet: async"));
  const snippetBody = body.slice(0, body.indexOf("updateSettings:"));
  ok("签名只收命令", /executeSnippet: async \(command\) =>/.test(store), true);
  eq(
    "接口声明里没有 serverId",
    store.includes("executeSnippet: (command: string) => Promise<SnippetRun>;"),
    true
  );
  ok("结果类型导出", /export type SnippetRun =/.test(store));
  eq("走共用查找", snippetBody.includes("pickActiveSession(get())"), true);
  eq("主机清单按会话取", snippetBody.includes("sessionTargets([sessionId])"), true);
  eq("仍过同一道闸门", snippetBody.includes('decideCommand(command, sessionTargets([sessionId]), "snippet")'), true);
  eq("写入被 await（失败才能变成结论）", snippetBody.includes('await invoke("ssh_pty_write"'), true);
  for (const forbidden of [
    /t\.serverId === serverId/,
    /approveCommand/,
    /\.catch\(\(e\) => \{\s*console\.error/,
  ]) {
    eq(`Snippet 体内不再出现旧写法 ${forbidden}`, forbidden.test(snippetBody), false);
  }
  // executeCommand 是"这台服务器的任一 tab"，语义不同，那份查找必须留着
  const execBody = store.slice(store.indexOf("executeCommand: async"));
  eq(
    "executeCommand 仍按 serverId 找（两种语义不许被并进同一个 helper）",
    /t\.serverId === serverId/.test(execBody.slice(0, execBody.indexOf("executeSnippet"))),
    true
  );
}

console.log(`\n[SnippetRun] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
