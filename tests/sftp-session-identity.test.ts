/**
 * SFTP 面板的会话身份守卫。
 *
 * 起因（浏览器实测，见 07_实施进度.md §7.29）：`SftpPanel` 的 prop 名叫 `serverId`，
 * 但工具栏和 ⌘⇧E 传进去的是 **tab.id**，只有标签页右键菜单传的是真 serverId。
 * 面板内部一律 `tabs.find((t) => t.serverId === serverId)` —— 前两条路永远找不到标签，
 * `getSessionId()` 恒为 undefined，于是每个动作都报「会话未连接」；而 `listSftp(serverId, path)`
 * 里那份同名的错误查找被调用方的 `.catch(() => {})` 吞掉，屏幕上的表现只是"列表一直是空的"。
 *
 * 这里守的是修完之后成立的性质：
 *  1. 身份解析只有一个入口（`pickTabSession`），并且它按 tab.id 找、取不到就返回 undefined；
 *  2. 列目录的参数是 sessionId，且结果与 sessionId 成对写回（列表不能"无主"）；
 *  3. 面板不再自己抄一份查找、App 不再从外面顺手列目录（那正是两种语义的来源）；
 *  4. 编辑回传用**开编辑时**那份会话，不再跟着"当前面板"漂。
 */
import { pickActiveSession, pickTabSession } from "../src/utils/session";
import { listingCandidates } from "../src/utils/sftpListing";
import { readFileSync } from "node:fs";
import { stripComments } from "./_strip_comments";

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

const pane = (id: string, sessionId?: string, serverId = "srv-1") => ({ id, serverId, sessionId });
const tab = (id: string, sessionId: string | undefined, panes: any[], serverId = "srv-1") =>
  ({ id, serverId, sessionId, state: "connected", panes });

// ---- 1. pickTabSession：按标签页取会话 ----

{
  // 同一台服务器开两个标签页：旧写法 find(t => t.serverId === X) 只会拿到**第一个**，
  // 于是第二个标签页的 SFTP 操作发去第一个的会话。
  const state = {
    tabs: [
      tab("tab-a", "sess-a", [pane("pane-a", "sess-a")], "srv-1"),
      tab("tab-b", "sess-b", [pane("pane-b", "sess-b")], "srv-1"),
    ],
    activePaneId: "pane-b",
  };
  eq("按 tab.id 取到该标签页自己的会话（不看 serverId）", pickTabSession(state as any, "tab-b"), "sess-b");
  eq("另一个同服务器标签页不会被顶替", pickTabSession(state as any, "tab-a"), "sess-a");
}

{
  const state = {
    tabs: [
      tab("tab-a", "sess-main", [
        pane("pane-a1", "sess-1", "srv-1"),
        pane("pane-a2", "sess-2", "srv-1"),
      ], "srv-1"),
      tab("tab-b", "sess-b", [pane("pane-b", "sess-b", "srv-2")], "srv-2"),
    ],
    // 活跃面板属于 tab-a：tab-b 不能借用它
    activePaneId: "pane-a2",
  };
  eq("活跃面板属于该标签页时按面板取", pickTabSession(state as any, "tab-a"), "sess-2");
  eq("活跃面板不属于该标签页时回落该标签页主会话，绝不借用别的标签页",
    pickTabSession(state as any, "tab-b"), "sess-b");
}

{
  const state = {
    tabs: [tab("tab-a", undefined, [pane("pane-a", undefined)], "srv-1")],
    activePaneId: "pane-a",
  };
  eq("面板还没有会话就是 undefined（不猜别的会话）", pickTabSession(state as any, "tab-a"), undefined);
  eq("标签页不存在就是 undefined", pickTabSession(state as any, "nope"), undefined);
  eq("tabId 为 null 时 undefined", pickTabSession(state as any, null), undefined);
}

{
  // 分屏后主面板没会话、活跃面板有：取活跃那个
  const state = {
    tabs: [tab("tab-a", undefined, [pane("p1", undefined), pane("p2", "sess-2")], "srv-1")],
    activePaneId: "p2",
  };
  eq("tab.sessionId 缺失时仍按活跃面板取", pickTabSession(state as any, "tab-a"), "sess-2");
}

// ---- 2. pickActiveSession 与 pickTabSession 是同一份逻辑 ----

{
  const mk = (activeTabId: string | null) => ({
    tabs: [
      tab("tab-a", "sess-a", [pane("pane-a", "sess-a")], "srv-1"),
      tab("tab-b", "sess-b", [pane("pane-b", "sess-b", "srv-2")], "srv-2"),
    ],
    activePaneId: "pane-b",
    activeTabId,
  });
  for (const id of ["tab-a", "tab-b", null] as const) {
    const s = mk(id);
    eq(`pickActiveSession(activeTabId=${id}) === pickTabSession(state, activeTabId)`,
      pickActiveSession(s as any), pickTabSession(s as any, s.activeTabId));
  }
  // 活跃面板在别的标签页上时，pickActiveSession 也不得跟着走过去
  const crossed = {
    tabs: [
      tab("tab-a", "sess-a", [pane("pane-a", "sess-a")], "srv-1"),
      tab("tab-b", "sess-b", [pane("pane-b", "sess-b", "srv-2")], "srv-2"),
    ],
    activePaneId: "pane-b",
    activeTabId: "tab-a",
  };
  eq("pickActiveSession 只认自己标签页里的面板", pickActiveSession(crossed as any), "sess-a");
}

// ---- 3. 反面对照：旧的那份查找为什么永远找不到 ----

{
  const tabs = [
    tab("tab-a", "sess-a", [pane("pane-a", "sess-a")], "srv-1"),
    tab("tab-b", "sess-b", [pane("pane-b", "sess-b")], "srv-1"),
  ];
  // `_createTabForServer` 里 tab.id 由 genId() 生成，与 serverId 不是一套编号
  const oldWay = (id: string) => tabs.find((t: any) => t.serverId === id)?.sessionId;
  eq("旧查找按 tab.id 什么都找不到（这正是面板报「会话未连接」的原因）",
    [oldWay("tab-a"), oldWay("tab-b")], [undefined, undefined]);
  eq("新查找按 tab.id 每条都找得到",
    [pickTabSession({ tabs, activePaneId: null } as any, "tab-a"),
     pickTabSession({ tabs, activePaneId: null } as any, "tab-b")],
    ["sess-a", "sess-b"]);
  eq("旧查找按 serverId 只能命中第一个标签页（同机多开时串会话）",
    oldWay("srv-1"), "sess-a");
}

// ---- 3b. 列目录计划：面板打开时必须真的去列，一次都不能省 ----

{
  eq("没有任何记忆时列根（第一次打开面板正是这种时候）", listingCandidates(undefined), ["/"]);
  eq("空串也不是\"不用列\"", listingCandidates(""), ["/"]);
  eq("记忆就是根时不重复列两次", listingCandidates("/"), ["/"]);
  eq("有更深记忆时先回那一一级", listingCandidates("/var/log"), ["/var/log", "/"]);
  // 这条是被实测打出来的：写成 `if (!remembered) return` 之后，第一次打开什么都不列，
  // 屏幕一片空、没有报错，看起来跟"目录本来就是空的"一模一样。
  for (const r of [undefined, "", "/", "/a", "/a/b/c", "//", "."]) {
    const plan = listingCandidates(r);
    ok(`候选永不为空且一定含根（remembered=${JSON.stringify(r)} → ${JSON.stringify(plan)}）`,
      plan.length >= 1 && plan.includes("/"));
    eq(`候选不重复（remembered=${JSON.stringify(r)}）`, new Set(plan).size, plan.length);
  }
}

// ---- 4. 静态守卫：同一份查找不许再被复制 ----


const panel = stripComments(readFileSync("src/components/SftpPanel.tsx", "utf8"));
const app = stripComments(readFileSync("src/App.tsx", "utf8"));
const store = stripComments(readFileSync("src/stores/serverStore.ts", "utf8"));
const sessionSrc = stripComments(readFileSync("src/utils/session.ts", "utf8"));

ok("读得到源码", panel.length > 0 && app.length > 0 && store.length > 0);

// 4.1 面板这一侧的身份解析只允许一份：session.ts 里的 `pickTabSession`。
// （`t.serverId === …` 在别处仍可能是对的 —— 那里拿的确实是 serverId，例如按服务器分组标签页、
//  批量执行按服务器挑目标；所以守卫钉在"面板怎么知道自己属于哪个会话"这一点上，而不是全局禁词。）
eq("SftpPanel 里不存在 serverId 比较（那正是把 tab.id 喂给它的地方）",
  /t\.serverId ===/.test(panel), false);
eq("面板取会话只经 pickTabSession（渲染期 + 点击时两处）",
  (panel.match(/pickTabSession\(/g) || []).length, 2);
eq("身份解析只在 session.ts 一处",
  (sessionSrc.match(/tabs\.find\(/g) || []).length, 1);
ok("身份解析确实走单一真源",
  panel.includes("pickTabSession(") && sessionSrc.includes("export function pickTabSession"));
ok("pickActiveSession 复用 pickTabSession（两份逻辑不再各写一遍）",
  /return pickTabSession\(state, state\.activeTabId\);/.test(sessionSrc));

// 4.2 面板按标签页拿身份
ok("面板的 prop 是 tabId（不再叫 serverId）",
  /function SftpPanel\(\{ tabId \}/.test(panel));
eq("面板里没有残留的 serverId 形参", /\{ serverId \}/.test(panel), false);
ok("App 把 activeTabId 交给 tabId",
  /<SftpPanel tabId=\{activeTabId\} \/>/.test(app));

// 4.3 列目录的参数是 sessionId，且只有面板会发起
ok("listSftp 的声明参数叫 sessionId",
  /listSftp: \(sessionId: string, path: string\) => Promise<void>;/.test(store));
// 只截 listSftp 自己那段（截到文件尾会把别处合法的 tabs.find 也算成它的）
const listStart = store.indexOf("listSftp: async (");
const listBody = store.slice(listStart, store.indexOf("toggleSftp: (visible)", listStart));
ok("store 里列目录不再猜身份（参数为空要如实报错）",
  listBody.startsWith("listSftp: async (sessionId, path) => {") &&
    /if \(!sessionId\) throw new Error\("会话未连接"\);/.test(listBody));
eq("App 不再从外面顺手列目录（那正是传错 id 的那三处）", /listSftp/.test(app), false);
ok("面板列目录前自己解析身份",
  /const sessionId = getSessionId\(\);[\s\S]{0,200}await listSftp\(sessionId, path\)/.test(panel));
// 对齐 effect 必须"按计划逐条试"，不能出现任何一条提前 return 把第一次列目录整条跳掉
ok("面板打开时按 listingCandidates 逐条尝试列目录",
  /for \(const p of listingCandidates\(sftpPathBySession\[activeSessionId\]\)\)/.test(panel) &&
    /if \(await navigateTo\(p\)\) break;/.test(panel));
eq("对齐 effect 里没有\"没有记忆就直接返回\"的写法",
  /if \(!remembered[^\n]*return/.test(panel), false);
eq("不存在把 tabId 当 sessionId 传进去的调用", /listSftp\(tabId/.test(panel), false);
eq("不存在把 tabId 当 sessionId 传进去的调用（App）", /listSftp\(activeTabId/.test(app), false);

// 4.4 列表与会话成对：结果必须带身份回来
ok("成功列目录时把 sessionId 一起写回",
  /sftpSessionId: sessionId,/.test(listBody));
eq("列目录的 store 实现里不再有任何标签页查找", /tabs\.find\(/.test(listBody), false);
ok("面板读回该身份并据此判断列表归属",
  /sftpSessionId === activeSessionId/.test(panel));
// 全局那份必须改名取用，面板里生效的 `sftpEntries`/`sftpPath` 只能是过了归属闸的那两份
ok("全局列表以别名取用（防止漏改一处就绕过归属闸）",
  /sftpEntries: listedEntries,/.test(panel) && /sftpPath: listedPath,/.test(panel));
eq("生效的 sftpEntries 只有一处定义",
  (panel.match(/const sftpEntries = /g) || []).length, 1);
eq("生效的 sftpPath 只有一处定义",
  (panel.match(/const sftpPath = /g) || []).length, 1);
ok("归属对不上时不画旧列表（否则旧会话的文件名会配上新会话的 sessionId）",
  /listingMatches \? listedEntries : NO_ENTRIES/.test(panel) &&
    /listingMatches \? listedPath : "\/"/.test(panel));

// 4.5 编辑回传按"开编辑时那份"会话，不跟着当前面板漂
const watcher = panel.slice(panel.indexOf("let pushedModified = lastModified;"));
const watcherBody = watcher.slice(0, watcher.indexOf("}, 3000)"));
ok("watcher 里存在回传代码", watcherBody.includes("sftp_upload"));
eq("watcher 不再读当前面板的会话来上传",
  /currentSessionId/.test(watcherBody), false);
ok("watcher 用捕获的 sessionId 上传",
  /invoke\("sftp_upload", \{ sessionId,/.test(watcherBody));
ok("会话断了要停下监听并说明原因（不能静默不再回传）",
  /isSessionAlive\(sessionId\)/.test(watcherBody) &&
    /编辑监听已停止/.test(watcherBody));
// 上传成功后要刷新列表，但只能刷"人正看着的那一份"：闭包里的 navigateTo/getSessionId 属于
// 开编辑那一次的 tabId，切过标签页后再用会把旧会话列一遍、把正在看的这台顶回根目录（实测过）。
ok("刷新按 store 现值核对（会话 + 目录都对上才刷）",
  /shown\.sftpSessionId === sessionId && shown\.sftpPath === dirnameOf\(remotePath\)/.test(watcherBody));
eq("watcher 不再用闭包里的 navigateTo 刷列表", /navigateTo\(/.test(watcherBody), false);

// 4.5c 一次保存只能回传一次（基准要能推进 + 在途不得并发）—— 实测过 13 s 内 8 次上传
ok("监听器有自己的可比推进基准", /let pushedModified = lastModified;/.test(watcherBody));
ok("比较用推进基准而不是闭包常量",
  /currentStat\.modified <= pushedModified/.test(watcherBody));
eq("不再拿闭包里的 const lastModified 做判断",
  /currentStat\.modified > lastModified/.test(watcherBody), false);
ok("成功后才推进基准", (() => {
  const failAt = watcherBody.indexOf("自动上传失败");
  const advAt = watcherBody.indexOf("pushedModified = currentStat.modified");
  const okAt = watcherBody.indexOf("已自动上传更新");
  return failAt >= 0 && advAt > failAt && okAt > advAt;
})());
ok("上传在途时下一轮直接跳过（同一条内容不得并发推两遍）",
  /if \(pushing\) return;/.test(watcherBody) &&
    /pushing = true;/.test(watcherBody) &&
    /finally \{\s*pushing = false;/.test(watcherBody));

// 4.5b dirnameOf：与拼 remotePath 同一套规则，根目录不重复斜杠
{
  const src = panel;
  const at = src.indexOf("function dirnameOf(");
  ok("dirnameOf 存在", at >= 0);
  // 直接按同一份实现跑一遍（避免把面板整个搬进 node）
  const dirnameOf = new Function("remotePath", src.slice(at, src.indexOf("\n}", at) + 2).replace(
    /^function dirnameOf\(remotePath: string\): string /,
    ""
  )) as (p: string) => string;
  for (const [p, want] of [
    ["/one.txt", "/"],
    ["/var/log/sys.log", "/var/log"],
    ["/var", "/"],
    ["a.txt", "/"],
    ["/a/b/", "/a/b"],
  ] as const) {
    eq(`dirnameOf(${JSON.stringify(p)})`, dirnameOf(p), want);
  }
}

// 4.6 编辑条目的身份 = (会话, 远端路径)
ok("EditingFile 带 sessionId", /interface EditingFile \{[\s\S]{0,400}sessionId: string;/.test(panel));
eq("去重不能只按 remotePath",
  /editingFiles\.find\(\(f\) => f\.remotePath === remotePath\)/.test(panel), false);
const bothKeys = (panel.match(/f\.sessionId === sessionId && f\.remotePath === remotePath/g) || []).length;
ok("去重与推进 lastModified 都按 (会话, 路径) 两条键（>=2 处）", bothKeys >= 2);
eq("关闭编辑标签不能只按 remotePath 过滤（会留下还在跑的隐形监听器）",
  /ef\.remotePath !== f\.remotePath/.test(panel), false);
ok("关闭编辑标签按两条键过滤",
  /ef\.sessionId === f\.sessionId && ef\.remotePath === f\.remotePath/.test(panel));
ok("编辑条目的 key 含会话（两台主机同名同路径不会撞 key）",
  /const key = `\$\{f\.sessionId\}\\n\$\{f\.remotePath\}`;/.test(panel));

// 4.7 失败必须上屏：三态空态 + 记住失败原因
ok("没有会话时空态说「会话未连接」", /title="会话未连接"/.test(panel));
ok("列目录失败时空态说得出原因", /title="无法读取目录"/.test(panel) && /setListError\(reason\)/.test(panel));
ok("成功列目录后清掉失败原因", /setListError\(null\)/.test(panel));
eq("SFTP 开关路径上不再有空 catch（以前它把「永远列不出」吞了）",
  /catch\(\(\) => \{\}\)/.test(app), false);

console.log(`[SftpSessionIdentity] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
