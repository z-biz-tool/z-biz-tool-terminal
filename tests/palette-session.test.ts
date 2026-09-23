/**
 * 命令面板对"会话"的陈述（`src/utils/paletteSession.ts` + 它的唯一调用方 CommandPalette）。
 *
 * 起因：`item.id.startsWith("tab-")` 一命中就挂「当前」标签 —— 开着 4 个标签页时面板里
 * 有 4 条都写着"当前"，而"当前"是一个只能有一个指涉的说法；同一组的标题写「已连接会话」，
 * 底下却照样列出"连接中"和"连接失败"的标签页。所以这里的断言重心是：
 * **每个带唯一指涉的词（当前 / 已连接），屏幕上能指到的那一条必须恰好是它**。
 */
import { readFileSync } from "node:fs";
import {
  KNOWN_TAB_STATES,
  SESSION_GROUP_TITLE,
  isCurrentTab,
  sessionHint,
  stateColorOf,
  stateHint,
} from "../src/utils/paletteSession";

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

// 1. 「当前」只能有一条
{
  const tabs = ["t-1", "t-2", "t-3", "t-4"].map((id) => ({ id, tabId: id }));
  for (const active of ["t-1", "t-2", "t-3", "t-4"]) {
    const hits = tabs.filter((t) => isCurrentTab(t, active)).map((t) => t.id);
    eq(`活跃为 ${active} 时恰好一条命中`, hits, [active]);
  }
  eq("没有活跃标签页时一条都不标", tabs.filter((t) => isCurrentTab(t, null)).length, 0);
  // 空串不能当"当前"：store 清成 "" 时如果拿 falsy 判断会静默，拿 === 判断则会标中 id 为 "" 的那条
  eq("activeTabId 为空串时不许指到任何条目", tabs.filter((t) => isCurrentTab(t, "")).length, 0);
  eq(
    "没有 tabId 的条目（服务器/片段/操作）永远不算当前",
    tabs.map((t) => ({ id: t.id })).filter((t) => isCurrentTab(t, "t-1")).length,
    0,
  );
  // 语义只来自 tabId：id 长得像 tab 也不算（守卫"从字符串前缀猜类型"这条老路）
  eq(
    "id 前缀像 tab 但没有 tabId ⇒ 不算会话条目",
    isCurrentTab({ id: "tab-t-1" } as any, "t-1"),
    false,
  );
}

// 2. 说明文字必须与标签同进同退
{
  const current = sessionHint({ tabId: "t-1" }, "t-1");
  const other = sessionHint({ tabId: "t-2" }, "t-1");
  eq("当前那条不再说\"切换到此会话\"", current, "当前会话");
  eq("非当前那条仍是切换", other, "切换到此会话");
  eq("两种说法互不相同", new Set([current, other]).size, 2);
  ok("当前那条的文案里不含\"切换\"", !current.includes("切换"));
}

// 3. 会话状态：标得出来、认不出时不猜
{
  eq("connected 不占版面", stateHint("connected"), ["", false]);
  eq("连接中", stateHint("connecting"), ["连接中", true]);
  eq("连接失败", stateHint("error"), ["连接失败", true]);
  eq("已断开", stateHint("disconnected"), ["已断开", true]);
  eq("undefined 状态不标", stateHint(undefined), ["", false]);
  eq("空串状态不标", stateHint(""), ["", false]);
  // 新增/未知状态：宁可露英文原词，也不把它洗成"看起来没事"
  eq("认不出的状态原样露出来", stateHint("weird_state"), ["weird_state", true]);
  const labels = ["connecting", "error", "disconnected"].map((s) => stateHint(s)[0]);
  eq("三个状态三句不同的话", new Set(labels).size, 3);
  eq("状态词互不为子串（避免搜索/正则误命中）", labels.some((a) => labels.some((b) => a !== b && b.includes(a))), false);
}

// 4. 颜色查表：失败永远红，认不出的不许顺手涂色
{
  eq("connecting ⇒ blue", stateColorOf("connecting"), "blue");
  eq("error ⇒ red", stateColorOf("error"), "red");
  eq("disconnected ⇒ default", stateColorOf("disconnected"), "default");
  eq("connected ⇒ default（不标也就用不上色）", stateColorOf("connected"), "default");
  eq("未知状态 ⇒ default", stateColorOf("weird_state"), "default");
  eq("undefined ⇒ default", stateColorOf(undefined), "default");
}

// 5. 跨文件契约：状态词表必须盖住 types.ts 的 ConnectionState
{
  const types = src("src/types/index.ts");
  const decl = /export type ConnectionState = ([^;]+);/.exec(types);
  ok("能在 types.ts 里定位 ConnectionState", decl != null);
  const states = (decl?.[1] ?? "")
    .split("|")
    .map((s) => s.trim().replace(/["']/g, ""))
    .filter(Boolean)
    .sort();
  ok("ConnectionState 含 connected", states.includes("connected"));
  const covered = states.filter((s) => s === "connected" || stateHint(s)[1]);
  eq("除 connected 外每个状态都标得出来", covered, states);
  // 词表与 types.ts 严格对齐：多了（面板里有个永远不会出现的状态）也算漂移
  eq(
    "状态词表 = ConnectionState 去掉 connected",
    KNOWN_TAB_STATES.slice().sort(),
    states.filter((s) => s !== "connected").sort(),
  );
}

// 6. 静态守卫：组件必须问判定层，不许再自己判断
{
  const palette = src("src/components/CommandPalette.tsx");
  eq("组件不再用 id 前缀判断会话", /startsWith\("tab-"\)/.test(palette), false);
  ok("「当前」标签 gate 在 isCurrentTab 的结果上", /const current = isCurrentTab\(item, activeTabId\)/.test(palette));
  ok("标签渲染读的是 current 这个判定结果", /\{current && \(/.test(palette));
  ok("说明文字来自 sessionHint", /description: sessionHint\(\{ tabId: tab\.id \}, activeTabId\)/.test(palette));
  ok("会话条目带 tabId", /tabId: tab\.id,/.test(palette));
  ok("会话条目带 tabState", /tabState: tab\.state,/.test(palette));
  // 属性从"组件里那份写死的类别清单"挪成"分组只有一个真源"：清单本身已被 paletteOrder 收走，
  // 组件再维护一份就会重新出现"键盘一套序、屏幕一套序"
  ok("分组交给 paletteOrder 的单一真源", /paletteSequence\(scored\)/.test(palette));
  eq("组件里没有第二份分组清单", /Record<string, CommandItem\[\]>|groups\[/.test(palette), false);
  ok("组标题渲染的是判定层给出的 title", /\{group\.title\} · \{group\.items\.length\}/.test(palette));
  ok("会话组标题来自 SESSION_GROUP_TITLE（判定层，不是组件手写）", /SESSION_GROUP_TITLE/.test(src("src/utils/paletteOrder.ts")));
  eq(
    "组件里不再硬写「已连接会话」",
    /已连接会话/.test(palette.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    false,
  );
  // 状态标签必须与状态同行出现，否则"连接失败"只活在注释里
  ok("状态标签 gate 在 showState 上", /\{showState && \(/.test(palette));
  ok("状态标签文案来自 stateHint", /\{stateLabel\}/.test(palette));
  // 「当前」是单指涉词，面板里只该有一处渲染它的字面量，不能散成多处判断
  eq("「当前」标签在组件里只渲染一处", (palette.match(/>\s*当前\s*</g) || []).length, 1);
}

// 7. 组标题本身要经得起对账：它描述的是"打开过"，不是"已连接"
{
  eq("组名不含\"已连接\"", SESSION_GROUP_TITLE.includes("已连接"), false);
  ok("组名含\"会话\"", SESSION_GROUP_TITLE.includes("会话"));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
